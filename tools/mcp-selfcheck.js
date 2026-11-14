'use strict';

/* ─────────────────────────────────────────────
   lib/mcp.js 自检：node tools/mcp-selfcheck.js 直跑，不经 Electron。

   用 tools/mock-mcp-server.js 起真实子进程，覆盖：
   握手 / 工具发现 / 调用（含参数）/ 超时 / 崩溃后 error / 停止与重启 / 非法配置
   以及 makeToolName / buildToolSpecs / findTool 纯函数。
   ───────────────────────────────────────────── */

const assert = require('node:assert');
const path = require('node:path');
const mcp = require('../lib/mcp');
const localTools = require('../lib/tools');

const MOCK = path.join(__dirname, 'mock-mcp-server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let failCount = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('OK  ' + name);
  } catch (e) {
    failCount++;
    console.log('XX  ' + name + ' | ' + (e?.message || e));
  }
}

const byId = (mgr, id) => mgr.status().find((s) => s.id === id);

(async () => {
  const mgr = mcp.createMcpManager();

  /* ── 1. 配置校验 ── */
  await t('空配置被拒绝', async () => {
    const r = await mgr.startServer(null);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_CONFIG');
  });
  await t('缺 command 被拒绝', async () => {
    const r = await mgr.startServer({ id: 'bad', command: '   ' });
    assert.equal(r.ok, false);
  });
  await t('id 非法被拒绝', async () => {
    const r = await mgr.startServer({ id: 'not ok!', command: 'node' });
    assert.equal(r.ok, false);
  });
  await t('args 不是数组被拒绝', async () => {
    const r = await mgr.startServer({ id: 'bad-args', command: 'node', args: 'x' });
    assert.equal(r.ok, false);
  });

  /* ── 2. 启动即崩 → error ── */
  await t('启动即退出的 server 状态置 error', async () => {
    const r = await mgr.startServer({
      id: 'boom', name: 'Boom', command: process.execPath, args: [MOCK, '--exit-immediately'],
    });
    assert.equal(r.ok, false, `应握手失败：${r.error || ''}`);
    const s = byId(mgr, 'boom');
    assert.equal(s.status, 'error');
    assert.ok(s.lastError, '应有 lastError');
  });

  /* ── 3. 正常握手 + 工具发现 ── */
  await t('握手成功且发现 3 个工具', async () => {
    const r = await mgr.startServer({ id: 'mock', name: 'Mock Echo', command: process.execPath, args: [MOCK] });
    assert.equal(r.ok, true, r.error || '');
    const s = byId(mgr, 'mock');
    assert.equal(s.status, 'connected');
    assert.equal(s.tools.length, 3);
    assert.equal(s.toolCount, 3);
    assert.notEqual(s.capabilities?.tools, undefined);
    assert.equal(s.serverInfo?.name, 'mock-mcp');
    assert.ok(s.pid > 0);
  });

  await t('listTools 拉到 echo/add/fail 且 schema 完整', async () => {
    const r = await mgr.listTools('mock');
    assert.equal(r.ok, true, r.error || '');
    const names = r.tools.map((x) => x.name).sort().join(',');
    assert.equal(names, 'add,echo,fail');
    const echo = r.tools.find((x) => x.name === 'echo');
    assert.deepEqual(echo.inputSchema.required, ['message']);
    assert.equal(echo.description, '原样返回 message');
  });

  /* ── 4. 工具调用 ── */
  await t('callTool echo 文本规范化', async () => {
    const r = await mgr.callTool('mock', 'echo', { message: '你好 DSH' });
    assert.equal(r.ok, true, r.error || '');
    assert.equal(r.isError, false);
    assert.equal(r.content, 'echo: 你好 DSH');
  });
  await t('callTool add 带参数计算', async () => {
    const r = await mgr.callTool('mock', 'add', { a: 2, b: 40 });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'sum = 42');
  });
  await t('callTool isError 结果规范化', async () => {
    const r = await mgr.callTool('mock', 'fail', {});
    assert.equal(r.ok, false);
    assert.equal(r.isError, true);
    assert.match(r.content, /故意失败/);
  });
  await t('callTool 未注册工具名被本地拦截', async () => {
    const r = await mgr.callTool('mock', 'ghost_tool', {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UNKNOWN_TOOL');
  });
  await t('未知 server 调用被拒绝', async () => {
    const r = await mgr.callTool('no-such-server', 'echo', {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_FOUND');
  });

  /* ── 5. 超时 ── */
  await t('callTool 超时被切断', async () => {
    const r = await mgr.startServer({
      id: 'slow', name: 'Slow', command: process.execPath, args: [MOCK, '--delay-ms=3000'],
    });
    assert.equal(r.ok, true, r.error || '');
    const started = Date.now();
    const call = await mgr.callTool('slow', 'echo', { message: 'x' }, 800);
    const elapsed = Date.now() - started;
    assert.equal(call.ok, false);
    assert.equal(call.code, 'TIMEOUT');
    assert.ok(elapsed < 2500, `超时应≈800ms，实际 ${elapsed}ms`);
  });
  await t('超时后同 server 仍可用（慢响应不再挡路）', async () => {
    const r = await mgr.callTool('slow', 'add', { a: 1, b: 1 }, 8000);
    assert.equal(r.ok, true, r.error || '');
    assert.equal(r.content, 'sum = 2');
  });

  /* ── 6. 崩溃 ── */
  await t('server 崩溃后在途请求失败且状态置 error', async () => {
    const r = await mgr.startServer({
      id: 'crash', name: 'Crash', command: process.execPath, args: [MOCK, '--crash-on-tool=echo'],
    });
    assert.equal(r.ok, true, r.error || '');
    const call = await mgr.callTool('crash', 'echo', { message: 'x' }, 8000);
    assert.equal(call.ok, false);
    assert.equal(call.code, 'SERVER_EXITED');
    await sleep(150);  // 等 exit 事件落地
    const s = byId(mgr, 'crash');
    assert.equal(s.status, 'error');
    assert.match(s.lastError, /进程退出/);
    assert.equal(s.pid, null);
  });

  /* ── 7. 停止 / 重启 / 重复启动 ── */
  await t('重复启动运行中的 server 被拒绝', async () => {
    const r = await mgr.startServer({ id: 'mock', name: 'Mock Echo', command: process.execPath, args: [MOCK] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ALREADY_RUNNING');
  });
  await t('stopServer 停止后工具不可用', async () => {
    const pid = byId(mgr, 'mock').pid;
    const r = mgr.stopServer('mock');
    assert.equal(r.ok, true);
    assert.equal(byId(mgr, 'mock').status, 'stopped');
    const call = await mgr.callTool('mock', 'echo', { message: 'x' });
    assert.equal(call.ok, false);
    assert.equal(call.code, 'NOT_CONNECTED');
    const list = await mgr.listTools('mock');
    assert.equal(list.ok, false);
    // 进程树确实被杀掉（taskkill /T /F）：对 pid 探活应最终报错
    // （kill 是异步的，轮询最多 3 秒，别把清理延迟误判成没杀掉）
    let alive = true;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      try { process.kill(pid, 0); } catch { alive = false; break; }
    }
    assert.equal(alive, false, `pid ${pid} 3 秒后仍存活，进程树没有被杀掉`);
  });
  await t('停止后再启动可恢复（工具重新发现）', async () => {
    const r = await mgr.startServer({ id: 'mock', name: 'Mock Echo', command: process.execPath, args: [MOCK] });
    assert.equal(r.ok, true, r.error || '');
    assert.equal(byId(mgr, 'mock').status, 'connected');
    const call = await mgr.callTool('mock', 'echo', { message: 'restarted' });
    assert.equal(call.ok, true);
    assert.equal(call.content, 'echo: restarted');
  });
  await t('停止不存在的 server 返回 NOT_FOUND', () => {
    const r = mgr.stopServer('no-such');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_FOUND');
  });

  /* ── 7.5 桥接链路端到端：模拟 main.js 的接线方式（bridge → manager → 真实子进程） ── */
  await t('端到端：executeTool 按 mcp_ 前缀路由到真实 mock server', async () => {
    localTools.setMcpBridge({
      resolve: (fullName) => mcp.findTool(mgr.status(), fullName),
      call: (serverId, toolName, args) => mgr.callTool(serverId, toolName, args),
    });
    const entry = mcp.buildToolSpecs(mgr.status()).find((e) => e.serverId === 'mock');
    assert.ok(entry, '应能从 status 编译出 mock 的工具');
    // ask 模式未审批：在审批层就被拦，不触达 server
    const denied = await localTools.executeTool(entry.fullName, { message: 'x' }, { permission: 'ask' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'DENIED');
    const r = await localTools.executeTool(entry.fullName, { message: '端到端' }, { permission: 'full' });
    assert.equal(r.ok, true, r.error || '');
    assert.match(r.content, /echo: 端到端/);
    assert.match(r.meta.label, /Mock Echo/);
    localTools.setMcpBridge(null);  // 还原，避免影响后续用例
  });

  /* ── 8. 纯函数：命名 / spec 编译 / 名字解析 ── */
  await t('makeToolName 清洗非法字符', () => {
    assert.equal(mcp.makeToolName('Filesystem', 'read_file'), 'mcp_filesystem_read_file');
    assert.equal(mcp.makeToolName('My Server!', 'do thing'), 'mcp_my_server_do_thing');
    assert.ok(mcp.makeToolName('a'.repeat(80), 'b'.repeat(80)).length <= 64);
    assert.equal(mcp.makeToolName('', ''), 'mcp_x_x');
  });
  await t('buildToolSpecs 只编已连接的 server 且 spec 合规', () => {
    const servers = [
      { id: 'fs', name: 'Filesystem', status: 'connected', tools: [
        { name: 'read_file', description: '读文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      ] },
      { id: 'x', name: 'Stopped', status: 'stopped', tools: [{ name: 'ghost', description: '不应出现' }] },
      { id: 'y', name: 'No Schema', status: 'connected', tools: [{ name: 'bare' }] },
    ];
    const entries = mcp.buildToolSpecs(servers);
    assert.equal(entries.length, 2);
    const fs = entries.find((e) => e.toolName === 'read_file');
    assert.equal(fs.fullName, 'mcp_filesystem_read_file');
    assert.equal(fs.spec.type, 'function');
    assert.equal(fs.spec.function.name, 'mcp_filesystem_read_file');
    assert.match(fs.spec.function.description, /^\[MCP:Filesystem\]/);
    assert.deepEqual(fs.spec.function.parameters.required, ['path']);
    const bare = entries.find((e) => e.toolName === 'bare');
    assert.equal(bare.spec.function.parameters.type, 'object');
  });
  await t('buildToolSpecs 对重名工具去重', () => {
    const servers = [
      { id: 'a', name: 'dup', status: 'connected', tools: [{ name: 'run', description: 'first' }] },
      { id: 'b', name: 'dup', status: 'connected', tools: [{ name: 'run', description: 'second' }] },
    ];
    const entries = mcp.buildToolSpecs(servers);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].description, 'first');
  });
  await t('中文名 server 退回用 id 命名', () => {
    const servers = [{ id: 'cn_server', name: '代码审查', status: 'connected', tools: [{ name: 'lint' }] }];
    const entries = mcp.buildToolSpecs(servers);
    assert.equal(entries[0].fullName, 'mcp_cn_server_lint');
    assert.equal(mcp.findTool(servers, 'mcp_cn_server_lint')?.serverId, 'cn_server');
  });
  await t('findTool 命中与未命中', () => {
    const servers = [{ id: 'fs', name: 'Filesystem', status: 'connected', tools: [{ name: 'read_file' }] }];
    assert.equal(mcp.findTool(servers, 'mcp_filesystem_read_file').toolName, 'read_file');
    assert.equal(mcp.findTool(servers, 'mcp_filesystem_othter'), null);
    assert.equal(mcp.findTool(servers, 'read_file'), null);
  });

  /* ── 9. stopAll ── */
  await t('stopAll 停掉所有运行中的 server', async () => {
    mgr.stopAll();
    await sleep(100);
    assert.ok(mgr.status().every((s) => s.status === 'stopped'), mgr.status().map((s) => `${s.id}:${s.status}`).join(','));
  });

  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  process.exit(failCount ? 1 : 0);
})().catch((err) => {
  console.error('[selfcheck] 意外失败：', err);
  process.exit(1);
});
