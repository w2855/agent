'use strict';

/* ─────────────────────────────────────────────
   MCP / Skills 接线的纯函数自检：node tools/ipc-mcp-check.js 直跑。

   main.js 的 IPC 层无法脱离 Electron 单测，这里尽量覆盖纯函数部分：
   - buildToolSpecs / findTool（tool:specs 与 mcp:tools:list 的合流基础）
   - lib/tools.js 的 MCP 桥注入、executeTool 按 mcp_ 前缀路由与审批策略
   - 合流后的 specs / needsApproval 形状（模拟 main.js 的拼装方式）
   - lib/skills.js 的扫描与边界判定（完整覆盖见 skills-selfcheck.js）

   只能在 Electron 里手测的部分见文件末尾打印的清单。
   ───────────────────────────────────────────── */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const mcp = require('../lib/mcp');
const localTools = require('../lib/tools');
const skills = require('../lib/skills');

let pass = 0;
let failCount = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('OK  ' + name);
  } catch (e) {
    failCount++;
    console.log('XX  ' + name + ' | ' + (e?.message || e));
  }
};
const tAsync = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log('OK  ' + name);
  } catch (e) {
    failCount++;
    console.log('XX  ' + name + ' | ' + (e?.message || e));
  }
};

/* main.js 中 chat 校验用的同一份工具名模式：MCP 生成的名字必须能过它 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/;

/** 模拟 main.js tool:specs 的合流拼装（同一份逻辑） */
function mergedSpecs(mcpEntries) {
  return {
    specs: [...localTools.TOOL_SPECS, ...mcpEntries.map((e) => e.spec)],
    needsApproval: [...localTools.NEEDS_APPROVAL, ...mcpEntries.map((e) => e.fullName)],
    readOnly: [...localTools.READ_ONLY],
  };
}

(async () => {
  /* ── 1. buildToolSpecs / findTool（纯函数） ── */
  const fakeServers = [
    { id: 'fs', name: 'Filesystem', status: 'connected', tools: [
      { name: 'read_file', description: '读文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    ] },
    { id: 'stopped', name: 'Stopped', status: 'error', tools: [{ name: 'ghost' }] },
  ];
  const entries = mcp.buildToolSpecs(fakeServers);

  t('buildToolSpecs：error 状态 server 的工具不进 specs', () => {
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fullName, 'mcp_filesystem_read_file');
  });
  t('MCP 生成的函数名能过 MODEL_PATTERN（chat 校验不会拒）', () => {
    for (const e of entries) assert.match(e.spec.function.name, MODEL_PATTERN);
    assert.match(mcp.makeToolName('中文server', '工具1'), MODEL_PATTERN);
    assert.match(mcp.makeToolName('a'.repeat(90), 'b'.repeat(90)), MODEL_PATTERN);
  });
  t('findTool 与 buildToolSpecs 命名一致（resolve/call 对得上）', () => {
    const hit = mcp.findTool(fakeServers, entries[0].fullName);
    assert.equal(hit.serverId, 'fs');
    assert.equal(hit.toolName, 'read_file');
    assert.equal(hit.serverName, 'Filesystem');
    assert.equal(mcp.findTool(fakeServers, 'mcp_stopped_ghost'), null);
  });

  /* ── 2. 合流后的 specs / needsApproval 形状 ── */
  t('合流 specs：内置工具一个不少，MCP 追加在后', () => {
    const merged = mergedSpecs(entries);
    const builtinNames = localTools.TOOL_SPECS.map((s) => s.function.name);
    assert.deepEqual(merged.specs.slice(0, builtinNames.length).map((s) => s.function.name), builtinNames);
    assert.equal(merged.specs.length, builtinNames.length + entries.length);
    assert.deepEqual(merged.needsApproval.slice(0, localTools.NEEDS_APPROVAL.size),
      [...localTools.NEEDS_APPROVAL]);
    assert.ok(merged.needsApproval.includes('mcp_filesystem_read_file'));
    assert.ok(!merged.readOnly.includes('mcp_filesystem_read_file'), 'MCP 工具不进只读白名单');
  });

  /* ── 3. executeTool 的 MCP 路由与审批策略（注入假桥） ── */
  let calls = [];
  localTools.setMcpBridge({
    resolve: (fullName) => fullName === 'mcp_demo_echo'
      ? { serverId: 'demo', toolName: 'echo', serverName: 'Demo' }
      : null,
    call: async (serverId, toolName, args) => {
      calls.push({ serverId, toolName, args });
      return { ok: true, content: `called ${toolName} ${JSON.stringify(args)}` };
    },
  });

  await tAsync('ask 模式未审批 → DENIED，不触达 MCP', async () => {
    calls = [];
    const r = await localTools.executeTool('mcp_demo_echo', { message: 'hi' }, { permission: 'ask' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DENIED');
    assert.equal(calls.length, 0);
  });
  await tAsync('审批通过 → 路由到桥接对象（serverId/toolName/args 正确）', async () => {
    calls = [];
    const r = await localTools.executeTool('mcp_demo_echo', { message: 'hi' }, { permission: 'ask', approved: true });
    assert.equal(r.ok, true, r.error || '');
    assert.match(r.content, /called echo/);
    assert.match(r.meta.label, /Demo/);
    assert.deepEqual(calls, [{ serverId: 'demo', toolName: 'echo', args: { message: 'hi' } }]);
  });
  await tAsync('full 权限免审批', async () => {
    calls = [];
    const r = await localTools.executeTool('mcp_demo_echo', { message: 'x' }, { permission: 'full' });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
  });
  await tAsync('只读模式拒绝一切 MCP 工具', async () => {
    const r = await localTools.executeTool('mcp_demo_echo', { message: 'x' }, { permission: 'readonly' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DENIED');
  });
  await tAsync('未注册的 mcp_ 名字 → UNKNOWN_TOOL', async () => {
    const r = await localTools.executeTool('mcp_who_dis', {}, { permission: 'full' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UNKNOWN_TOOL');
  });
  await tAsync('桥返回 ok:false（超时/退出）时透传 code 与正文', async () => {
    localTools.setMcpBridge({
      resolve: () => ({ serverId: 'demo', toolName: 'echo', serverName: 'Demo' }),
      call: async () => ({ ok: false, code: 'TIMEOUT', error: 'tools/call 请求超时', content: '' }),
    });
    const r = await localTools.executeTool('mcp_demo_echo', {}, { permission: 'full' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TIMEOUT');
    assert.match(r.error, /超时/);
  });
  await tAsync('桥抛异常 → TOOL_ERROR', async () => {
    localTools.setMcpBridge({
      resolve: () => ({ serverId: 'demo', toolName: 'echo', serverName: 'Demo' }),
      call: async () => { throw new Error('bridge boom'); },
    });
    const r = await localTools.executeTool('mcp_demo_echo', {}, { permission: 'full' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TOOL_ERROR');
  });
  await tAsync('参数不是合法 JSON → BAD_ARGS', async () => {
    localTools.setMcpBridge({
      resolve: () => ({ serverId: 'demo', toolName: 'echo', serverName: 'Demo' }),
      call: async () => ({ ok: true, content: 'x' }),
    });
    const r = await localTools.executeTool('mcp_demo_echo', '{oops', { permission: 'full' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_ARGS');
  });
  await tAsync('数组参数 → BAD_ARGS', async () => {
    const r = await localTools.executeTool('mcp_demo_echo', [1, 2], { permission: 'full' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_ARGS');
  });

  await tAsync('内置工具不受桥影响（只读白名单照常放行）', async () => {
    const r = await localTools.executeTool('todo_write', { tasks: [{ content: 'x' }] }, { permission: 'readonly' });
    assert.equal(r.ok, true, r.error || '');
  });
  await tAsync('内置工具审批策略照旧（run_command 未审批仍拒）', async () => {
    const r = await localTools.executeTool('run_command', { command: 'echo hi' }, { permission: 'ask' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DENIED');
  });

  /* ── 4. 无桥时 mcp_ 前缀按未知工具处理 ── */
  await tAsync('setMcpBridge(null) 后 mcp_ 名字 → UNKNOWN_TOOL', async () => {
    localTools.setMcpBridge(null);
    const r = await localTools.executeTool('mcp_demo_echo', {}, { permission: 'full' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UNKNOWN_TOOL');
  });

  /* ── 5. skills 边界判定（简要；完整覆盖见 skills-selfcheck.js） ── */
  const tmpParent = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(tmpParent, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpParent, 'ipc-check-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.md'), '---\nname: alpha\ndescription: d\n---\nbody');
    const scanned = skills.scanSkills([{ source: 'user', dir: tmp }]);
    t('skills.scanSkills 能被 main.js 直接使用', () => {
      assert.equal(scanned.length, 1);
      assert.equal(scanned[0].name, 'alpha');
    });
    const inside = await skills.readSkillFile([{ source: 'user', dir: tmp }], path.join(tmp, 'a.md'));
    const outside = await skills.readSkillFile([{ source: 'user', dir: tmp }], path.join(tmp, '..', 'outside.md'));
    t('skills.readSkillFile 界内可读、界外拒绝', () => {
      assert.equal(inside.ok, true);
      assert.equal(outside.ok, false);
      assert.equal(outside.code, 'OUT_OF_SCOPE');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    localTools.setMcpBridge(null);
  }

  console.log(`
──────────────────────────────────────────────
纯函数部分：${pass} 通过 / ${failCount} 失败

以下只能在 Electron 里手测（启动方式：npm start -- --user-data-dir=<临时目录>）：
1. 渲染层 localStorage 保存的 MCP 配置经 dsh.mcp.setServers() 同步到主进程，
   dsh.mcp.getServers() 能读回 configs + 各 server 运行状态；
2. dsh.mcp.startServer(id) 启动真实 MCP server（如 npx.cmd @modelcontextprotocol/server-filesystem <目录>），
   dsh.mcp.listTools() 汇总出 mcp_filesystem_* 工具；
3. dsh.tools.specs() 返回的 specs 里含 MCP 工具，needsApproval 含对应 mcp_ 名字；
   对话回合里模型调用 MCP 工具时走既有审批流程（弹确认卡片）；
4. dsh.skills.scan(workspace) 能扫到 userData/skills 与 workspace/.dsh/skills 里的技能；
5. app 退出后 MCP server 子进程被 taskkill 收干净（任务管理器确认无残留 node）。
──────────────────────────────────────────────`);
  process.exit(failCount ? 1 : 0);
})().catch((err) => {
  console.error('[selfcheck] 意外失败：', err);
  process.exit(1);
});
