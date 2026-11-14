'use strict';

/* ─────────────────────────────────────────────
   MCP（Model Context Protocol）stdio 客户端管理器

   零依赖实现：只用 node:child_process，按 MCP 规范走 stdio transport——
   每行一个 JSON-RPC 2.0 消息（UTF-8，\n 分隔），不是 LSP 的 Content-Length
   头帧。

   生命周期：startServer → initialize（请求/响应）→ notifications/initialized
   （通知）→ tools/list（缓存工具清单）→ tools/call（按需，带超时）→ stopServer。

   健壮性：
   - 请求 id 自增 + pending 表超时清理，单个请求卡死不影响整条通道；
   - 进程意外退出/崩溃 → 状态置 error、记录最后错误与 stderr 末尾，
     所有在途请求立即失败；被手动停止时不误报 error；
   - Windows 用 taskkill /T /F 杀整棵进程树，其他平台 SIGKILL；
   - 配置持久化不在这层（main.js 从渲染层 localStorage 同步下来）。
   ───────────────────────────────────────────── */

const { spawn } = require('node:child_process');
const { buildChildEnv } = require('./safety');

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'DSH-Desktop', version: '0.1.0' };
const HANDSHAKE_TIMEOUT_MS = 15000;        // initialize → tools/list 的总时限
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;  // 普通请求（tools/list 等）默认超时
const DEFAULT_CALL_TIMEOUT_MS = 60000;     // tools/call 默认超时
const MAX_CALL_TIMEOUT_MS = 600000;        // tools/call 超时上限
const MAX_LINE_BYTES = 4 * 1024 * 1024;    // 单条消息上限，防异常输出撑爆内存
const MAX_RESULT_CHARS = 200000;           // 工具结果文本上限（与主进程输出上限对齐）
const MAX_TOOLS = 100;                     // 单个 server 的工具数上限
const STDERR_TAIL_BYTES = 8000;            // 保留 stderr 末尾，崩溃时用于诊断
const MAX_SERVERS = 12;                    // 同时配置的 server 上限（每个都是独立子进程）
const MAX_INFLIGHT_PER_SERVER = 4;         // 单 server 并发调用上限，防一条链路打满子进程
const MAX_ARGS_BYTES = 256 * 1024;         // 单次调用参数上限

function mcpError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function clampCallTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_CALL_TIMEOUT_MS;
  return Math.max(1000, Math.min(Math.floor(n), MAX_CALL_TIMEOUT_MS));
}

function validateCfg(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'MCP 配置为空';
  const id = String(cfg.id || '').trim();
  if (!id) return '缺少 id';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) return 'id 只允许字母/数字/下划线/中划线（≤64 字符）';
  if (!String(cfg.command || '').trim()) return '缺少 command';
  if (cfg.args != null && !Array.isArray(cfg.args)) return 'args 必须是数组';
  if (cfg.env != null && (typeof cfg.env !== 'object' || Array.isArray(cfg.env))) return 'env 必须是对象';
  return null;
}

/* ─────────── 工具命名（纯函数，供 main.js 合流用） ─────────── */

/** 工具名各部分只保留 OpenAI function name 允许的字符，其余折叠成下划线。 */
function sanitizePart(value, max) {
  const s = String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
  return s || 'x';
}

/** 统一命名：mcp_<server名>_<工具名>，总长 ≤ 64，满足主流网关的函数名校验。 */
function makeToolName(serverName, toolName) {
  return `mcp_${sanitizePart(serverName, 20)}_${sanitizePart(toolName, 36)}`;
}

/* server 名清洗后失去区分度（比如纯中文名）时退回用 id 命名。
   buildToolSpecs / findTool 共用这一个推导，保证两边结果一致。 */
function fullNameFor(srv, toolName) {
  const byName = sanitizePart(srv && srv.name, 20);
  const serverKey = byName !== 'x' ? srv.name : srv.id;
  return makeToolName(serverKey, toolName);
}

/**
 * 把 manager.status() 里各 server 的工具清单编译成 OpenAI function spec。
 * MCP 的 inputSchema 本身就是 JSON Schema，基本直传（补默认值、去掉 $schema）。
 * 重名冲突时保留先出现的、后出现的跳过（findTool 用同一份顺序，行为一致）。
 * 返回 [{ serverId, serverName, toolName, fullName, description, inputSchema, spec }]
 */
function buildToolSpecs(servers) {
  const out = [];
  const seen = new Set();
  for (const srv of Array.isArray(servers) ? servers : []) {
    if (!srv || srv.status !== 'connected' || !Array.isArray(srv.tools)) continue;
    for (const tool of srv.tools) {
      if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
      const fullName = fullNameFor(srv, tool.name);
      if (seen.has(fullName)) continue;
      seen.add(fullName);
      const serverName = String(srv.name || srv.id || '');
      out.push({
        serverId: srv.id,
        serverName,
        toolName: tool.name,
        fullName,
        description: tool.description || tool.name,
        inputSchema: tool.inputSchema,
        spec: {
          type: 'function',
          function: {
            name: fullName,
            description: `[MCP:${serverName}] ${tool.description || tool.name}`.slice(0, 2000),
            parameters: toOpenAIParameters(tool.inputSchema),
          },
        },
      });
    }
  }
  return out;
}

/** 按名字找 MCP 工具（只认已连接的 server），返回与 buildToolSpecs 同形的条目。 */
function findTool(servers, fullName) {
  const target = String(fullName || '');
  for (const srv of Array.isArray(servers) ? servers : []) {
    if (!srv || srv.status !== 'connected' || !Array.isArray(srv.tools)) continue;
    for (const tool of srv.tools) {
      if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
      if (fullNameFor(srv, tool.name) === target) {
        return {
          serverId: srv.id,
          serverName: String(srv.name || srv.id || ''),
          toolName: tool.name,
          fullName: target,
          description: tool.description || tool.name,
          inputSchema: tool.inputSchema,
        };
      }
    }
  }
  return null;
}

function toOpenAIParameters(schema) {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const out = { ...schema };
    delete out.$schema;  // 网关一般不认 JSON Schema 的元字段，去掉更稳
    if (!out.type) out.type = 'object';
    if (!out.properties || typeof out.properties !== 'object' || Array.isArray(out.properties)) {
      out.properties = {};
    }
    return out;
  }
  // 没声明 inputSchema 的工具：按「无固定参数」处理，但保留扩展余地
  return { type: 'object', properties: {}, additionalProperties: true };
}

/* ─────────── 管理器 ─────────── */

function createMcpManager() {
  /** @type {Map<string, object>} id -> server record */
  const servers = new Map();

  function get(id) {
    return servers.get(String(id || '')) || null;
  }

  function snapshot(rec) {
    return {
      id: rec.id,
      name: rec.name,
      command: rec.command,
      args: rec.args,
      status: rec.status,
      lastError: rec.lastError,
      pid: rec.pid,
      startedAt: rec.startedAt,
      capabilities: rec.capabilities,
      serverInfo: rec.serverInfo,
      toolCount: rec.tools.length,
      tools: rec.tools,
    };
  }

  function markError(rec, message) {
    rec.status = 'error';
    rec.lastError = String(message || '').slice(0, 500) || '未知错误';
  }

  /** 在途请求统一失败（超时 / 退出 / 停止时调用）。 */
  function failAllPending(rec, code, message) {
    for (const p of rec.pending.values()) {
      clearTimeout(p.timer);
      p.reject(mcpError(code, message));
    }
    rec.pending.clear();
  }

  function killTree(proc) {
    if (!proc || !proc.pid) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
      } else {
        proc.kill('SIGKILL');
      }
    } catch { /* 进程可能已退出 */ }
  }

  function writeMsg(rec, obj) {
    const proc = rec.proc;
    if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) return false;
    try {
      proc.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  function handleMessage(rec, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }  // 有些 server 会把日志打到 stdout，畸形行直接丢
    if (!msg || typeof msg !== 'object') return;

    // 服务端发来的请求：目前不支持任何 server→client 能力。
    // ping 按协议回空结果，其余回 Method not found，避免对方干等。
    if (msg.method != null && msg.id != null) {
      if (msg.method === 'ping') writeMsg(rec, { jsonrpc: '2.0', id: msg.id, result: {} });
      else writeMsg(rec, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      return;
    }
    if (msg.method != null) return;              // 服务端通知：忽略
    if (msg.id == null) return;

    const pending = rec.pending.get(msg.id);
    if (!pending) return;                        // 超时后迟到的响应，丢弃
    clearTimeout(pending.timer);
    rec.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(mcpError('RPC_ERROR', msg.error.message || `JSON-RPC 错误 ${msg.error.code ?? ''}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  function request(rec, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!rec.proc) {
        reject(mcpError('NOT_CONNECTED', `MCP server 未连接：${rec.name || rec.id}`));
        return;
      }
      const id = rec.nextId++;
      const timer = setTimeout(() => {
        rec.pending.delete(id);
        reject(mcpError('TIMEOUT', `${method} 请求超时（${timeoutMs}ms）`));
      }, timeoutMs);
      rec.pending.set(id, { resolve, reject, timer });
      // 写管道失败（进程已死但 exit 事件还没到）立即失败，不等超时
      if (!writeMsg(rec, { jsonrpc: '2.0', id, method, params: params || {} })) {
        clearTimeout(timer);
        rec.pending.delete(id);
        reject(mcpError('NOT_CONNECTED', 'MCP 进程管道不可写（可能已退出）'));
      }
    });
  }

  function attach(rec, proc) {
    let buf = '';

    // 管道错误（EPIPE 等）不能变成未捕获异常
    proc.stdin.on('error', () => {});
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) {
        // 超长行：多半不是 MCP 程序（把日志/二进制写到 stdout）
        buf = '';
        failAllPending(rec, 'PROTOCOL_ERROR', 'stdout 出现超长行，疑似非 MCP 程序');
        markError(rec, 'stdout 超长（超过 4MB 无换行），疑似非 MCP 程序');
        rec.stopping = true;  // 随后的 exit 事件不再覆盖为「进程退出」
        killTree(proc);
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '').trim();
        buf = buf.slice(idx + 1);
        if (line) handleMessage(rec, line);
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      rec.stderrTail = (rec.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    proc.on('error', (err) => {
      if (rec.stopping) return;
      failAllPending(rec, 'SPAWN_FAILED', `无法启动 MCP 进程：${err?.message || err}`);
      markError(rec, `启动失败：${err?.message || err}`);
      rec.proc = null;
      rec.pid = null;
    });

    proc.on('exit', (code, signal) => {
      rec.proc = null;
      rec.pid = null;
      if (rec.stopping) return;  // 手动停止已置 stopped，不误报 error
      const tail = rec.stderrTail.trim().split('\n').slice(-3).join(' | ').slice(0, 200);
      const why = `进程退出（code=${code == null ? signal : code}）${tail ? '：' + tail : ''}`;
      failAllPending(rec, 'SERVER_EXITED', why);
      markError(rec, why);
    });
  }

  function spawnProc(rec) {
    const args = (rec.args || []).map(String);
    // 白名单继承 + 配置里显式声明的变量：第三方 server 不该看到主进程的密钥
    const env = buildChildEnv(rec.env);
    const cmd = String(rec.command);
    // Windows 上 .cmd/.bat/.ps1 不能被无 shell 的 spawn 直接执行（会 EINVAL/ENOENT），
    // 这类命令（如 npx.cmd）走 cmd.exe；MCP 配置由用户自己填写，这里只做最小引号保护。
    const needsShell = process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(cmd);
    if (needsShell) {
      const quoted = args.map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`));
      return spawn(cmd, quoted, { shell: true, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    return spawn(cmd, args, { shell: false, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  function normalizeTools(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const t of raw.slice(0, MAX_TOOLS)) {
      if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.name) continue;
      out.push({
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
          ? t.inputSchema
          : null,
      });
    }
    return out;
  }

  async function handshake(rec) {
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    const left = () => Math.max(1000, deadline - Date.now());

    const init = await request(rec, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, left());
    rec.capabilities = init && typeof init.capabilities === 'object' ? init.capabilities : {};
    rec.serverInfo = init && typeof init.serverInfo === 'object' ? init.serverInfo : null;
    // 版本协商：服务端回什么就记什么，不因为版本号不同而拒绝（MCP 允许双方各退一步）

    writeMsg(rec, { jsonrpc: '2.0', method: 'notifications/initialized' });

    const listed = await request(rec, 'tools/list', {}, left());
    rec.tools = normalizeTools(listed?.tools);
  }

  async function startServer(cfg) {
    const bad = validateCfg(cfg);
    if (bad) return { ok: false, code: 'BAD_CONFIG', error: bad };
    if (!servers.has(String(cfg.id)) && servers.size >= MAX_SERVERS) {
      return { ok: false, code: 'TOO_MANY_SERVERS', error: `MCP server 数量已达上限（${MAX_SERVERS}），请先停止不用的 server` };
    }

    const id = String(cfg.id);
    const existing = servers.get(id);
    if (existing && (existing.status === 'starting' || existing.status === 'connected')) {
      return { ok: false, code: 'ALREADY_RUNNING', error: `MCP server 已在运行：${id}` };
    }

    const rec = existing || {
      id,
      pending: new Map(),
      stderrTail: '',
      proc: null,
      pid: null,
    };
    failAllPending(rec, 'RESTARTED', 'MCP server 正在重新启动');  // 理论上不会有残留，兜底
    Object.assign(rec, {
      name: String(cfg.name || id).trim() || id,
      command: String(cfg.command).trim(),
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)
        ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [String(k), String(v)]))
        : {},
      status: 'starting',
      lastError: null,
      capabilities: null,
      serverInfo: null,
      tools: [],
      nextId: 1,
      stopping: false,
      stderrTail: '',
      startedAt: Date.now(),
      proc: null,
      pid: null,
    });
    servers.set(id, rec);

    let proc;
    try {
      proc = spawnProc(rec);
    } catch (err) {
      markError(rec, `启动失败：${err?.message || err}`);
      return { ok: false, code: 'SPAWN_FAILED', error: rec.lastError };
    }
    rec.proc = proc;
    rec.pid = proc.pid;
    attach(rec, proc);

    try {
      await handshake(rec);
    } catch (err) {
      // exit/error 事件可能已经把状态置为 error（进程启动即崩），保留那个更真实的原因
      if (rec.status !== 'error') {
        markError(rec, `握手失败：${err?.message || err}`);
      }
      rec.stopping = true;
      failAllPending(rec, 'HANDSHAKE_FAILED', rec.lastError);
      killTree(proc);
      rec.proc = null;
      rec.pid = null;
      return { ok: false, code: 'HANDSHAKE_FAILED', error: rec.lastError };
    }

    rec.status = 'connected';
    return { ok: true, server: snapshot(rec) };
  }

  function stopServer(id) {
    const rec = get(id);
    if (!rec) return { ok: false, code: 'NOT_FOUND', error: `没有这个 MCP server：${id}` };
    if (rec.proc) {
      rec.stopping = true;
      failAllPending(rec, 'SERVER_STOPPED', 'MCP server 已被手动停止');
      // 先关 stdin（按惯例 server 会在 stdin EOF 时自行退出），再用 taskkill 兜底
      try { rec.proc.stdin.end(); } catch { /* 管道已关 */ }
      killTree(rec.proc);
      rec.proc = null;
      rec.pid = null;
    }
    rec.status = 'stopped';
    rec.tools = [];
    rec.capabilities = null;
    rec.lastError = null;
    return { ok: true, server: snapshot(rec) };
  }

  function stopAll() {
    for (const rec of servers.values()) {
      try { stopServer(rec.id); } catch { /* 逐个停，别让一个失败影响其余 */ }
    }
  }

  async function listTools(serverId) {
    const rec = get(serverId);
    if (!rec) return { ok: false, code: 'NOT_FOUND', error: `没有这个 MCP server：${serverId}` };
    if (rec.status !== 'connected' || !rec.proc) {
      return { ok: false, code: 'NOT_CONNECTED', error: `MCP server 未连接（状态 ${rec.status}）：${rec.name || rec.id}` };
    }
    try {
      const res = await request(rec, 'tools/list', {}, DEFAULT_REQUEST_TIMEOUT_MS);
      rec.tools = normalizeTools(res?.tools);
      return { ok: true, tools: rec.tools, server: snapshot(rec) };
    } catch (err) {
      return { ok: false, code: err.code || 'LIST_FAILED', error: err?.message || String(err) };
    }
  }

  async function callTool(serverId, name, args, timeoutMs) {
    const rec = get(serverId);
    if (!rec) return { ok: false, isError: true, code: 'NOT_FOUND', error: `没有这个 MCP server：${serverId}`, content: '' };
    if (rec.status !== 'connected' || !rec.proc) {
      return {
        ok: false, isError: true, code: 'NOT_CONNECTED',
        error: `MCP server 未连接（状态 ${rec.status}）：${rec.name || rec.id}`, content: '',
      };
    }
    const tool = rec.tools.find((t) => t.name === name);
    if (!tool) return { ok: false, isError: true, code: 'UNKNOWN_TOOL', error: `工具不存在：${name}`, content: '' };

    // 参数体积上限：MCP 子进程是我们唯一的对外连接点，别让一次调用把内存/管道打满
    let argBytes = 0;
    try { argBytes = Buffer.byteLength(JSON.stringify(args || {}), 'utf8'); } catch { argBytes = Infinity; }
    if (!Number.isFinite(argBytes) || argBytes > MAX_ARGS_BYTES) {
      return { ok: false, isError: true, code: 'ARGS_TOO_LARGE', error: `调用参数超过上限（${MAX_ARGS_BYTES} 字节）`, content: '' };
    }

    const inflight = Number(rec.inflight) || 0;
    if (inflight >= MAX_INFLIGHT_PER_SERVER) {
      return { ok: false, isError: true, code: 'BUSY', error: `MCP server 并发调用已达上限（${MAX_INFLIGHT_PER_SERVER}）`, content: '' };
    }
    rec.inflight = inflight + 1;

    const timeout = clampCallTimeout(timeoutMs);
    let result;
    try {
      result = await request(rec, 'tools/call', { name, arguments: args || {} }, timeout);
    } catch (err) {
      return { ok: false, isError: true, code: err.code || 'CALL_FAILED', error: err?.message || String(err), content: '' };
    } finally {
      rec.inflight = Math.max(0, (Number(rec.inflight) || 1) - 1);
    }
    return normalizeCallResult(result);
  }

  function normalizeCallResult(result) {
    const items = Array.isArray(result?.content) ? result.content : [];
    const parts = [];
    for (const item of items) {
      if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else {
        parts.push(`[非文本内容: ${item && item.type ? item.type : 'unknown'}]`);
      }
    }
    let text = parts.join('\n');
    if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + '\n…（结果过长已截断）';
    const isError = result?.isError === true;
    return {
      ok: !isError,
      isError,
      code: isError ? 'TOOL_IS_ERROR' : undefined,
      error: isError ? 'MCP 工具返回 isError=true' : undefined,
      content: text,
    };
  }

  function status() {
    return [...servers.values()].map(snapshot);
  }

  return {
    startServer,
    stopServer,
    stopAll,
    listTools,
    callTool,
    status,
  };
}

module.exports = {
  createMcpManager,
  makeToolName,
  buildToolSpecs,
  findTool,
  PROTOCOL_VERSION,
};
