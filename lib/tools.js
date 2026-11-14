'use strict';

/* ─────────────────────────────────────────────
   本地工具（OpenAI tools / function calling）

   主进程只负责「定义」与「执行」，是否调用、是否批准由渲染层决定；
   但这里仍会按 permission 做第二道闸：只读模式拒绝一切写入与命令，
   ask 模式没有 approved 标记同样拒绝。工具结果统一回给模型，
   由模型决定下一步，形成多轮工具调用。

   所有路径都相对 workspace 解析；workspace 由用户选择，默认文档目录。

   MCP 工具通过 setMcpBridge 注入桥接对象（main.js 接线），按 mcp_ 前缀路由
   到 MCP 管理器；与内置工具共用同一条 executeTool / policy / 审批路径，
   默认按 run_command 同档：ask 模式需要审批，只读模式直接拒绝。
   ───────────────────────────────────────────── */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  isWithinWorkspace,
  isSystemPath,
  hardDenyCommand,
  realish,
} = require('./safety');

const MAX_READ_CHARS = 60000;
const MAX_READ_FILE_BYTES = 4 * 1024 * 1024;
const MAX_WRITE_CHARS = 500000;
const MAX_COMMAND_CHARS = 4000;
const MAX_COMMAND_OUTPUT = 30000;
const COMMAND_TIMEOUT_DEFAULT = 60000;
const COMMAND_TIMEOUT_MAX = 180000;
const FETCH_TIMEOUT_MS = 20000;
const FETCH_MAX_CHARS = 40000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const MAX_DIR_ENTRIES = 300;
const MAX_SCAN_FILES = 1500;
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_FILE_BYTES = 512 * 1024;
const MAX_MATCHES = 200;
const MAX_SEARCH_CHARS = 40000;
/* 正则匹配执行预算：防止灾难性回溯卡死主进程 */
const SEARCH_REGEX_BUDGET_MS = 2000;

const READ_ONLY = new Set(['list_dir', 'read_file', 'search_files', 'fetch_url', 'todo_write']);
const NEEDS_APPROVAL = new Set(['write_file', 'run_command', 'delegate_task']);

const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出目录内容。相对路径以工作目录为根；不传 path 时列出工作目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径，可为绝对路径或相对工作目录的路径' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取本地文本文件。默认从第 1 行开始，可指定 offset/limit；二进制文件会被拒绝。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，可为绝对路径或相对工作目录的路径' },
          offset: { type: 'integer', description: '起始行号，从 1 开始，默认 1' },
          limit: { type: 'integer', description: '最多读取的行数，默认 2000' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把文本写入本地文件（会覆盖已有文件，自动创建父目录）。修改前通常应先 read_file。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，可为绝对路径或相对工作目录的路径' },
          content: { type: 'string', description: '要写入的完整文本内容' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在工作目录内按正则表达式搜索文本文件内容，返回“文件:行号: 内容”。会跳过 node_modules、.git 等目录。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript 正则表达式，例如 "function\\\\s+main" 或 "TODO"' },
          path: { type: 'string', description: '搜索的起始目录，默认工作目录' },
          max_results: { type: 'integer', description: '最多返回多少条匹配，默认 100，上限 200' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '执行一条系统命令并返回 stdout/stderr 与退出码。Windows 下通过 cmd.exe 执行，其他平台通过 /bin/sh 执行。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录，默认当前工作目录' },
          timeout_ms: { type: 'integer', description: '超时毫秒数，默认 60000，最大 180000' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '用 GET 获取一个 http/https 网页或接口，返回可读文本（HTML 会去掉标签）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整的 http 或 https URL' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: '创建或更新当前会话的任务清单（每次传入完整列表）。多步骤任务应先建清单，并在推进时更新状态。',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: '完整任务列表，按执行顺序排列；传空数组表示清空',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '任务描述，一句话' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '任务状态，默认 pending' },
              },
              required: ['content'],
              additionalProperties: false,
            },
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_architecture',
      description: '创建或更新当前项目的整体架构（仅主控 Agent 可用）。提交分层模块、依赖边、里程碑与项目目标，用于项目级规划与架构图。默认 merge 合并；mode=replace 整体替换。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['merge', 'replace'], description: '默认 merge：按 id 或名称合并；replace：用本次 nodes 替换全部模块' },
          sessionId: { type: 'string', description: '会话 ID（可选）：提供时按「工作区+会话」隔离项目架构，与其他会话互不影响；省略时沿用共享项目' },
          name: { type: 'string', description: '项目名称' },
          description: { type: 'string', description: '项目一句话简介' },
          goal: { type: 'string', description: '项目目标与验收方向' },
          techStack: { type: 'array', description: '技术栈，例如 ["Electron", "React"]', items: { type: 'string' } },
          nodes: {
            type: 'array',
            description: '分层模块列表（最多 60 个）',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '稳定 ID（可选）；省略时按名称生成' },
                label: { type: 'string', description: '模块名称' },
                kind: { type: 'string', enum: ['module', 'service', 'component', 'data', 'interface', 'agent', 'asset', 'external', 'custom'] },
                layer: { type: 'string', enum: ['experience', 'application', 'domain', 'platform', 'data', 'external'], description: '体验层/应用层/领域层/平台层/数据层/外部系统' },
                description: { type: 'string', description: '模块职责' },
                path: { type: 'string', description: '对应工作区路径（可选）' },
                ownerAgentId: { type: 'string', description: '负责该模块的子 Agent ID（可选）' },
                taskId: { type: 'string', description: '关联的任务 ID（可选）' },
                status: { type: 'string', enum: ['planned', 'in_progress', 'done', 'blocked'] },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
          edges: {
            type: 'array',
            description: '模块依赖边（最多 120 条）；from/to 可写模块 id 或名称',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                kind: { type: 'string', enum: ['depends', 'calls', 'reads', 'writes', 'emits', 'exposes'] },
                label: { type: 'string' },
              },
              required: ['from', 'to'],
              additionalProperties: false,
            },
          },
          milestones: {
            type: 'array',
            description: '项目里程碑（可选，最多 20 个）',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                status: { type: 'string', enum: ['planned', 'in_progress', 'done', 'blocked'] },
                taskId: { type: 'string' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delegate_task',
      description: '把一个自包含的子任务委派给另一个 Agent，等待其完成并返回结果摘要。省略 agentId（或传 "new"/"auto"）时自动创建一个新子 Agent 执行；可并行发起多个委派，多个子任务会同时排队运行。',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '目标 Agent ID（使用系统提示「可委派 Agent」中的 ID）；省略或传 "new"/"auto" 表示自动创建新子 Agent' },
          profileId: { type: 'string', description: '可选：子 Agent 使用的 API 连接 ID（来自系统提示「可用连接」清单）；省略时沿用当前会话连接' },
          model: { type: 'string', description: '子 Agent 使用的模型名（须来自所选连接的可用模型列表；跨连接委派时尤其要传）' },
          objective: { type: 'string', description: '自包含的子任务目标，必须写清背景、输入与要做什么' },
          expectedOutput: { type: 'string', description: '期望的输出形式或验收标准' },
          contextRefs: {
            type: 'array',
            description: '显式共享给子 Agent 的工作区文件路径（可选，最多 10 个）',
            items: { type: 'string' },
          },
          budget: {
            type: 'object',
            description: '子任务预算（可选）；默认使用父任务预算的一半并受安全上限约束',
            properties: {
              maxWallClockMs: { type: 'integer', description: '最长运行毫秒数' },
              maxModelCalls: { type: 'integer', description: '最多模型调用次数' },
              maxTokens: { type: 'integer', description: '最多输入+输出 token 数' },
            },
            additionalProperties: false,
          },
        },
        required: ['objective', 'expectedOutput'],
        additionalProperties: false,
      },
    },
  },
];

const TOOL_META = {
  list_dir: { verb: '列目录', icon: 'i-folder', tone: 'read' },
  read_file: { verb: '读取', icon: 'i-read', tone: 'read' },
  write_file: { verb: '写入', icon: 'i-code', tone: 'edit' },
  search_files: { verb: '搜索', icon: 'i-search', tone: 'search' },
  run_command: { verb: '运行', icon: 'i-terminal', tone: 'terminal' },
  fetch_url: { verb: '联网', icon: 'i-globe', tone: 'web' },
  todo_write: { verb: '任务', icon: 'i-checklist', tone: 'read' },
  project_architecture: { verb: '架构', icon: 'i-package', tone: 'agent' },
  delegate_task: { verb: '委派', icon: 'i-users', tone: 'neutral' },
};

/* MCP 工具桥：由 main.js 注入，让 MCP 工具与内置工具走同一条执行与审批路径。
   桥接对象约定：
     resolve(fullName) -> { serverId, toolName, serverName } | null
     call(serverId, toolName, args) -> Promise<{ ok, content, isError?, code?, error? }> */
let mcpBridge = null;

function setMcpBridge(bridge) {
  mcpBridge = bridge || null;
}

/* 文件级撤销（Cline checkpoints 语义）快照注入点：main.js 启动时把
   lib/file-snapshots 的 store（userData/file-snapshots）传进来；未注入时
   下列钩子全部 no-op，write_file 行为与旧版完全一致（向后兼容）。 */
let snapshotStore = null;

function setSnapshotStore(store) {
  snapshotStore = store || null;
}

/* 快照钩子：尽力而为——快照任何失败都不阻断写入本身 */
async function snapshotForUndo(full) {
  if (!snapshotStore) return;
  try { await snapshotStore.snapshot(full); } catch { /* 快照失败不影响写入 */ }
}

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((s) => [s.function.name, s]));

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1048576).toFixed(1)} MB`;
}

function truncate(text, max, note = '（内容已截断）') {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + `\n…${note}`, truncated: true };
}

function truncateMiddle(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return s.slice(0, head) + '\n…（中间已截断）…\n' + s.slice(-tail);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function cleanWorkspace(workspace) {
  const raw = String(workspace || '').trim();
  return raw ? path.resolve(raw) : process.cwd();
}

function resolveToolPath(input, workspace) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new Error('缺少路径参数');
  if (raw.includes('\0')) throw new Error('路径包含非法字符');
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workspace, raw);
  return realish(abs);
}

function guardWritePath(workspace, full) {
  if (!isWithinWorkspace(workspace, full)) {
    throw new Error(`写操作超出工作区边界：${displayPath(workspace, full)}`);
  }
  if (isSystemPath(full)) {
    throw new Error(`禁止写入系统目录：${displayPath(workspace, full)}`);
  }
}

function displayPath(workspace, full) {
  const rel = path.relative(workspace, full);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : full;
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  }
  throw new Error('工具参数必须是对象');
}

function isProbablyText(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

function fail(code, error) {
  return { ok: false, code, error: String(error || code) };
}

async function listDir(args, workspace) {
  const full = args.path ? resolveToolPath(args.path, workspace) : workspace;
  const st = await fsp.stat(full).catch(() => null);
  if (!st) throw new Error(`目录不存在：${displayPath(workspace, full)}`);
  if (!st.isDirectory()) throw new Error(`不是目录：${displayPath(workspace, full)}`);

  const entries = await fsp.readdir(full, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  const lines = [];
  for (const ent of entries.slice(0, MAX_DIR_ENTRIES)) {
    const abs = path.join(full, ent.name);
    if (ent.isDirectory()) {
      lines.push(`d  ${ent.name}/`);
    } else {
      let size = '';
      try { size = formatBytes((await fsp.stat(abs)).size); } catch { /* 读不到大小就不显示 */ }
      lines.push(`f  ${ent.name}${size ? `  ${size}` : ''}`);
    }
  }
  const more = entries.length > MAX_DIR_ENTRIES ? `\n…另有 ${entries.length - MAX_DIR_ENTRIES} 项未显示` : '';
  return {
    ok: true,
    content: `目录：${displayPath(workspace, full)}\n${lines.join('\n')}${more}`,
    meta: { label: `${entries.length} 项` },
  };
}

async function readFile(args, workspace) {
  const full = resolveToolPath(args.path, workspace);
  const st = await fsp.stat(full).catch(() => null);
  if (!st) throw new Error(`文件不存在：${displayPath(workspace, full)}`);
  if (!st.isFile()) throw new Error(`不是普通文件：${displayPath(workspace, full)}`);
  if (st.size > MAX_READ_FILE_BYTES) {
    throw new Error(`文件过大（${formatBytes(st.size)}），超过 ${formatBytes(MAX_READ_FILE_BYTES)} 上限`);
  }

  const buf = await fsp.readFile(full);
  if (!isProbablyText(buf)) throw new Error('这是二进制文件，无法按文本读取');

  const all = buf.toString('utf8');
  const lines = all.split(/\r?\n/);
  const offset = clampInt(args.offset, 1, lines.length + 1, 1);
  const limit = clampInt(args.limit, 1, 2000, 2000);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const cut = truncate(slice.join('\n'), MAX_READ_CHARS);
  const lastLine = Math.min(lines.length, offset - 1 + slice.length);
  const rangeNote = slice.length ? `（第 ${offset}-${lastLine} 行，共 ${lines.length} 行）` : '（空文件）';

  return {
    ok: true,
    content: `${displayPath(workspace, full)} ${rangeNote}\n${cut.text}`,
    meta: { label: `${lines.length} 行 · ${formatBytes(st.size)}` },
  };
}

async function writeFile(args, workspace) {
  const full = resolveToolPath(args.path, workspace);
  guardWritePath(workspace, full);
  if (typeof args.content !== 'string') throw new Error('content 必须是字符串');
  if (args.content.length > MAX_WRITE_CHARS) {
    throw new Error(`内容过长（${args.content.length} 字符），上限 ${MAX_WRITE_CHARS}`);
  }
  const st = await fsp.stat(full).catch(() => null);
  if (st && st.isDirectory()) throw new Error(`目标是目录，不能写入：${displayPath(workspace, full)}`);

  /* 写前快照（撤销点）：先拿到「改前」状态，快照失败不阻断写入 */
  await snapshotForUndo(full);

  await fsp.mkdir(path.dirname(full), { recursive: true });
  const buf = Buffer.from(args.content, 'utf8');
  await fsp.writeFile(full, buf);
  /* 写后补拍：把「改后」状态记为最新检查点，restore 的安全预检
     （当前 sha vs 最后一次快照的 sha）才能在文件未被外部改动时放行撤销 */
  await snapshotForUndo(full);

  const lines = args.content ? args.content.split(/\r?\n/).length : 0;

  return {
    ok: true,
    content: `已写入 ${displayPath(workspace, full)}（${formatBytes(buf.length)}，${lines} 行）`,
    meta: { label: `${formatBytes(buf.length)} · ${lines} 行` },
  };
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.cache', '__pycache__', '.next', '.nuxt', 'coverage', '.idea', '.vscode',
]);

async function searchFiles(args, workspace) {
  const pattern = String(args.pattern == null ? '' : args.pattern);
  if (!pattern) throw new Error('缺少 pattern 参数');
  let re;
  try { re = new RegExp(pattern, 'i'); } catch (err) { throw new Error(`正则表达式不合法：${err.message}`); }

  const root = args.path ? resolveToolPath(args.path, workspace) : workspace;
  const st = await fsp.stat(root).catch(() => null);
  if (!st) throw new Error(`路径不存在：${displayPath(workspace, root)}`);
  if (!st.isDirectory()) throw new Error(`不是目录：${displayPath(workspace, root)}`);

  const maxResults = clampInt(args.max_results, 1, MAX_MATCHES, 100);
  const budgetEnd = Date.now() + SEARCH_REGEX_BUDGET_MS;
  const reBudget = () => {
    if (Date.now() > budgetEnd) throw new Error(`正则匹配超时（${SEARCH_REGEX_BUDGET_MS / 1000} 秒预算用尽），请简化 pattern 或缩小搜索范围`);
  };
  const matches = [];
  let scanned = 0;
  let truncatedByBytes = false;
  let totalChars = 0;

  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && matches.length < maxResults && scanned < MAX_SCAN_FILES) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const ent of entries) {
      if (matches.length >= maxResults || scanned >= MAX_SCAN_FILES) break;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH && !SKIP_DIRS.has(ent.name)) stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;

      let info;
      try { info = await fsp.stat(abs); } catch { continue; }
      if (!info.isFile() || info.size === 0 || info.size > MAX_SCAN_FILE_BYTES) continue;

      scanned++;
      let buf;
      try { buf = await fsp.readFile(abs); } catch { continue; }
      if (!isProbablyText(buf)) continue;

      const rel = displayPath(workspace, abs);
      const lines = buf.toString('utf8').split(/\r?\n/);
      reBudget();
      for (let i = 0; i < lines.length; i++) {
        reBudget();
        if (!re.test(lines[i])) continue;
        const line = `${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`;
        matches.push(line);
        totalChars += line.length + 1;
        if (matches.length >= maxResults) break;
        if (totalChars >= MAX_SEARCH_CHARS) { truncatedByBytes = true; break; }
      }
      if (truncatedByBytes) break;
    }
  }

  const more = matches.length >= maxResults ? `\n…已达到 ${maxResults} 条匹配上限` : '';
  return {
    ok: true,
    content: matches.length
      ? `在 ${displayPath(workspace, root)} 中找到 ${matches.length} 处匹配：\n${matches.join('\n')}${more}`
      : `在 ${displayPath(workspace, root)} 中没有找到匹配「${pattern}」的内容（扫描 ${scanned} 个文本文件）`,
    meta: { label: `${matches.length} 处 · 扫描 ${scanned} 文件` },
  };
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 进程可能已退出 */ }
}

async function runCommand(args, workspace) {
  const command = String(args.command == null ? '' : args.command);
  if (!command.trim()) throw new Error('缺少 command 参数');
  if (command.length > MAX_COMMAND_CHARS) throw new Error(`命令过长（${command.length} 字符）`);
  if (hardDenyCommand(command)) throw new Error('该命令属于灾难性操作，已被安全策略拒绝');

  const cwd = args.cwd ? resolveToolPath(args.cwd, workspace) : workspace;
  guardWritePath(workspace, cwd);
  const cwdStat = await fsp.stat(cwd).catch(() => null);
  if (!cwdStat || !cwdStat.isDirectory()) throw new Error(`工作目录不存在：${displayPath(workspace, cwd)}`);

  const timeoutMs = clampInt(args.timeout_ms, 1000, COMMAND_TIMEOUT_MAX, COMMAND_TIMEOUT_DEFAULT);
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env },
      });
    } catch (err) {
      resolve(fail('SPAWN_FAILED', err.message || err));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer = null;

    const append = (current, chunk) => {
      if (current.length >= MAX_COMMAND_OUTPUT * 2) return current;
      return current + chunk.toString('utf8');
    };

    child.stdout?.on('data', (c) => { stdout = append(stdout, c); });
    child.stderr?.on('data', (c) => { stderr = append(stderr, c); });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      killTimer = setTimeout(() => { if (!settled) done(null, null); }, 4000);
    }, timeoutMs);

    const done = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const out = truncateMiddle(stdout.trim(), MAX_COMMAND_OUTPUT);
      const err = truncateMiddle(stderr.trim(), MAX_COMMAND_OUTPUT);
      const parts = [];
      parts.push(`$ ${command}`);
      parts.push(`退出码：${timedOut ? '超时（已终止）' : code == null ? signal || '未知' : code} · 用时 ${seconds} 秒`);
      if (out) parts.push(`--- stdout ---\n${out}`);
      if (err) parts.push(`--- stderr ---\n${err}`);
      if (!out && !err) parts.push('（没有输出）');

      const exitCode = timedOut ? null : code;
      const failed = timedOut || exitCode !== 0;
      resolve({
        ok: !failed,
        code: timedOut ? 'TIMEOUT' : failed ? 'COMMAND_FAILED' : undefined,
        error: timedOut ? `命令超过 ${timeoutMs} 毫秒，已终止`
          : failed ? `命令退出码 ${exitCode == null ? signal || '未知' : exitCode}` : undefined,
        content: parts.join('\n'),
        meta: {
          label: timedOut ? '超时' : `退出码 ${exitCode == null ? signal || '?' : exitCode} · ${seconds}s`,
          exitCode,
          timedOut,
        },
      });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(fail('SPAWN_FAILED', err.message || err));
    });
    child.on('close', (code, signal) => done(code, signal));
  });
}

function stripHtml(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return '';
      // 增补平面码点要编码成 UTF-16 代理对，直接 fromCharCode 会产出孤立代理项
      if (code > 0xffff) {
        const hi = Math.floor((code - 0x10000) / 0x400) + 0xd800;
        const lo = ((code - 0x10000) % 0x400) + 0xdc00;
        return String.fromCharCode(hi, lo);
      }
      return String.fromCharCode(code);
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 127 || a === 10 || a === 0 || a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6 回环、链路本地、唯一本地（fc00::/7）
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  return false;
}

async function fetchUrl(args) {
  let url;
  try { url = new URL(String(args.url || '')); } catch { throw new Error('URL 不合法'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https URL');
  if (isPrivateHost(url.hostname)) {
    throw new Error('禁止访问本机与内网地址（SSRF 防护）');
  }

  let net = null;
  try { ({ net } = require('electron')); } catch { /* 非 Electron 环境用全局 fetch */ }
  const doFetch = net?.fetch ? net.fetch.bind(net) : fetch;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url.href, {
      method: 'GET',
      headers: {
        accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
        'user-agent': 'DSH-Desktop/0.1',
      },
      signal: ctrl.signal,
    });
    // 限制读入内存的字节数，防止超大响应撑爆进程
    const maxBytes = FETCH_MAX_BYTES;
    let raw = '';
    let received = 0;
    let overLimit = false;
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) { overLimit = true; try { await reader.cancel(); } catch { /* 忽略 */ } break; }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } else {
      raw = await res.text();
      received = raw.length;
    }
    if (overLimit) raw += `\n…（响应超过 ${formatBytes(maxBytes)}，已截断）`;
    const ctype = String(res.headers.get('content-type') || '').toLowerCase();
    const isHtml = ctype.includes('html') || /^\s*<(!doctype|html)/i.test(raw);
    const text = isHtml ? stripHtml(raw) : raw;
    const cut = truncate(text, FETCH_MAX_CHARS);
    const header = `GET ${url.href}\nHTTP ${res.status} ${res.statusText || ''} · ${ctype || '未知类型'}`;
    return {
      ok: res.ok,
      code: res.ok ? undefined : String(res.status),
      error: res.ok ? undefined : `HTTP ${res.status}`,
      content: `${header}\n\n${cut.text || '（响应正文为空）'}`,
      meta: { label: `HTTP ${res.status} · ${formatBytes(raw.length)}`, httpStatus: res.status },
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`请求超时（${FETCH_TIMEOUT_MS / 1000} 秒）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const TASK_STATUS = new Set(['pending', 'in_progress', 'completed']);

async function todoWrite(args) {
  const raw = Array.isArray(args.tasks) ? args.tasks : null;
  if (!raw) throw new Error('tasks 必须是数组');
  if (raw.length > 30) throw new Error('任务数量超过上限（30 项）');

  const tasks = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${i + 1} 个任务不是对象`);
    const content = String(item.content || '').trim();
    if (!content) throw new Error(`第 ${i + 1} 个任务缺少 content`);
    const status = TASK_STATUS.has(item.status) ? item.status : 'pending';
    tasks.push({ content: content.slice(0, 200), status });
  }

  const done = tasks.filter((t) => t.status === 'completed').length;
  const lines = tasks.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`);
  return {
    ok: true,
    content: tasks.length
      ? `任务清单已更新：共 ${tasks.length} 项，已完成 ${done} 项。\n${lines.join('\n')}`
      : '任务清单已清空。',
    meta: { label: `${done}/${tasks.length} 项` },
    tasks,
  };
}

/**
 * 执行一个工具。
 * @param {string} name
 * @param {object|string} rawArgs
 * @param {{workspace?: string, permission?: string, approved?: boolean}} opts
 */
async function executeTool(name, rawArgs, opts = {}) {
  const toolName = String(name || '');
  /* MCP 工具按前缀路由：命名统一 mcp_<server名>_<工具名>，由桥接对象解析 */
  if (toolName.startsWith('mcp_')) return executeMcpTool(toolName, rawArgs, opts);

  const spec = SPEC_BY_NAME.get(toolName);
  if (!spec) return fail('UNKNOWN_TOOL', `未知工具：${name}`);

  const permission = ['full', 'ask', 'readonly'].includes(opts.permission) ? opts.permission : 'ask';
  if (permission === 'readonly' && !READ_ONLY.has(name)) {
    return fail('DENIED', `只读模式不允许执行 ${name}`);
  }
  if (permission === 'ask' && NEEDS_APPROVAL.has(name) && opts.approved !== true) {
    return fail('DENIED', `该工具需要用户确认后才能执行：${name}`);
  }

  let args;
  try { args = parseArgs(rawArgs); } catch (err) {
    return fail('BAD_ARGS', `工具参数不是合法 JSON：${err.message}`);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('BAD_ARGS', '工具参数必须是对象');

  const workspace = cleanWorkspace(opts.workspace);
  try {
    switch (name) {
      case 'list_dir': return await listDir(args, workspace);
      case 'read_file': return await readFile(args, workspace);
      case 'write_file': return await writeFile(args, workspace);
      case 'search_files': return await searchFiles(args, workspace);
      case 'run_command': return await runCommand(args, workspace);
      case 'fetch_url': return await fetchUrl(args);
      case 'todo_write': return await todoWrite(args);
      case 'delegate_task': return fail('DELEGATION_UNSUPPORTED', '委派必须由 Runtime 执行');
      case 'project_architecture': return fail('PROJECT_UNSUPPORTED', '项目架构必须由 Runtime 执行');
      default: return fail('UNKNOWN_TOOL', `未知工具：${name}`);
    }
  } catch (err) {
    return fail('TOOL_ERROR', err?.message || String(err));
  }
}

/** MCP 工具的执行与审批：不特殊放行，与 run_command 同档（ask 需审批、readonly 拒绝）。 */
async function executeMcpTool(toolName, rawArgs, opts = {}) {
  if (!mcpBridge) return fail('UNKNOWN_TOOL', `未知工具：${toolName}（MCP 未接入）`);
  const hit = mcpBridge.resolve(toolName);
  if (!hit) return fail('UNKNOWN_TOOL', `未知工具：${toolName}（没有对应的已连接 MCP 工具）`);

  const permission = ['full', 'ask', 'readonly'].includes(opts.permission) ? opts.permission : 'ask';
  if (permission === 'readonly') {
    return fail('DENIED', `只读模式不允许执行 MCP 工具：${toolName}`);
  }
  if (permission === 'ask' && opts.approved !== true) {
    return fail('DENIED', `该工具需要用户确认后才能执行：${toolName}`);
  }

  let args;
  try { args = parseArgs(rawArgs); } catch (err) {
    return fail('BAD_ARGS', `工具参数不是合法 JSON：${err.message}`);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('BAD_ARGS', '工具参数必须是对象');

  try {
    const res = await mcpBridge.call(hit.serverId, hit.toolName, args);
    if (!res || res.ok !== true) {
      // 调用失败/ isError 时也带上 server 返回的正文，方便模型与用户看原因
      return {
        ok: false,
        code: res?.code || 'MCP_ERROR',
        error: res?.error || 'MCP 工具调用失败',
        content: typeof res?.content === 'string' ? res.content : '',
      };
    }
    return {
      ok: true,
      content: typeof res.content === 'string' ? res.content : '',
      meta: { label: `MCP · ${hit.serverName}` },
    };
  } catch (err) {
    return fail('TOOL_ERROR', err?.message || String(err));
  }
}

module.exports = {
  TOOL_SPECS,
  TOOL_META,
  READ_ONLY,
  NEEDS_APPROVAL,
  executeTool,
  setMcpBridge,
  setSnapshotStore,
  cleanWorkspace,
};
