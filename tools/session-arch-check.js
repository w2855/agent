'use strict';

/* 会话隔离自检：project_architecture 的「工作区+会话」键控（参考 ruflo missions 按实例键控）。
   覆盖：①同工作区两个 sessionId 各自独立 ②不带 sessionId 兼容旧行为（共享）
   ③listBySession/getProjectBySession 正确 ④旧数据（无 sessionId 字段）仍可被无 sessionId 调用命中。
   运行：node tools/session-arch-check.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtimeModule = require('../runtime');
const localTools = require('../lib/tools');
const { validateToolArgs } = require('../runtime/tool-registry');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`));
}

function makeWorkspace(root, name) {
  const ws = path.join(root, name);
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({
    name: name,
    description: '会话隔离自检工作区',
  }, null, 2));
  return ws;
}

function makeRuntime(dir, workspace) {
  const rt = runtimeModule.createRuntime({
    dir,
    workspacePath: workspace,
    executeTool: (name, args, opts) => localTools.executeTool(name, args, opts),
  });
  rt.init();
  return rt;
}

function newTask(rt, workspace, title) {
  const r = rt.createTask({
    title,
    input: title,
    workspace,
    agentId: rt.listAgents().data.defaultAgentId,
    providerId: '',
    model: 'mock-model',
  });
  if (!r.ok) throw new Error(r.error?.message || '任务创建失败');
  return r.data;
}

async function runArch(rt, runId, args, profile = 'full') {
  const step = rt.beginStep({ runId, kind: 'tool_call' }).data.step;
  const proposal = rt.proposeTool({ runId, stepId: step.id, name: 'project_architecture', args, profile });
  let exec = null;
  if (proposal.ok && proposal.data.status === 'ready') {
    exec = await rt.executeTool({ toolCallId: proposal.data.toolCallId, profile });
  }
  return { step, proposal, exec };
}

const SID_A = 'sess-a1b2c3d4e5'; // 短码 sess-a
const SID_B = 'sess-b2c3d4e5f6'; // 短码 sess-b

(async () => {
  const root = tempDir('session-arch');
  const ws1 = makeWorkspace(root, 'ws1'); // 会话隔离用
  const ws2 = makeWorkspace(root, 'ws2'); // 共享 / 旧数据用
  const rt = makeRuntime(path.join(root, 'store'), ws1);
  rt.setSettings({ maxConcurrentRuns: 16 });
  const mainAgentId = rt.listAgents().data.defaultAgentId;

  /* 1. 带 sessionId 的 ensure：按 workspace+sessionId 创建独立项目 */
  const ensA = rt.ensureProject({ workspace: ws1, sessionId: SID_A });
  const projA = ensA.data?.project;
  add('带 sessionId 创建会话项目', ensA.ok && projA?.sessionId === SID_A, projA?.id || ensA.error?.message);
  add('项目 id 追加会话短码', /^prj_.+_sess-a$/.test(projA?.id || ''), projA?.id);
  add('默认名带「·<sessionId 前 6 位>」后缀', projA?.name === 'ws1 · sess-a', projA?.name);

  /* 2. 同工作区第二个会话：独立项目，互不影响 */
  const ensB = rt.ensureProject({ workspace: ws1, sessionId: SID_B });
  const projB = ensB.data?.project;
  add('同工作区不同会话得到独立项目', ensB.ok && projB?.id !== projA.id && projB?.sessionId === SID_B, projB?.id);
  add('会话短码可区分', projA.id.endsWith('_sess-a') && projB.id.endsWith('_sess-b'), `${projA.id} vs ${projB.id}`);
  const ensAAgain = rt.ensureProject({ workspace: ws1, sessionId: SID_A });
  add('同会话重复 ensure 复用同一项目', ensAAgain.data?.project?.id === projA.id, ensAAgain.data?.project?.id);

  /* 3. 架构互不串：各自加节点 */
  const updA = rt.projects.applyArchitecture({
    workspace: ws1, agentId: mainAgentId,
    args: { sessionId: SID_A, nodes: [{ label: 'A模块', layer: 'domain' }] },
  });
  add('会话 A 可写入自己的架构', updA.project?.nodes?.length === 1 && updA.project.id === projA.id, `${updA.project?.nodes?.length} 节点`);
  const projBAfterA = rt.stateStore.getProject(projB.id);
  add('会话 B 不受 A 写入影响', projBAfterA?.nodes?.length === 0, `${projBAfterA?.nodes?.length} 节点`);
  const updB = rt.projects.applyArchitecture({
    workspace: ws1, agentId: mainAgentId,
    args: { sessionId: SID_B, nodes: [{ label: 'B模块', layer: 'application' }] },
  });
  add('会话 B 写入自己的架构', updB.project?.nodes?.length === 1 && updB.project.id === projB.id, `${updB.project?.nodes?.length} 节点`);
  add('会话 A 架构未被 B 串改', rt.stateStore.getProject(projA.id).nodes.length === 1, `${rt.stateStore.getProject(projA.id).nodes.length} 节点`);

  /* 4. listBySession / getProjectBySession */
  const byA = rt.projects.listBySession(SID_A);
  add('listBySession 只返回该会话项目且带实时视图', byA.length === 1 && byA[0].project.id === projA.id && !!byA[0].live, JSON.stringify(byA.map((x) => x.project.id)));
  const byStateB = rt.stateStore.listProjectsBySession(SID_B);
  add('state.listProjectsBySession 过滤正确', byStateB.length === 1 && byStateB[0].id === projB.id, JSON.stringify(byStateB.map((p) => p.id)));
  const loadB = rt.stateStore.getProjectBySession(SID_B);
  add('getProjectBySession 返回该会话项目数组（/load 用）', Array.isArray(loadB) && loadB.length === 1 && loadB[0].sessionId === SID_B, JSON.stringify(loadB.map((p) => p.id)));
  add('未知会话返回空数组', rt.stateStore.getProjectBySession('sess-none').length === 0 && rt.stateStore.listProjectsBySession('').length === 0, 'ok');

  /* 5. 不带 sessionId：兼容旧行为（共享） */
  const beforeCount = rt.stateStore.listProjects().length;
  const legacyOnWs1 = rt.ensureProject({ workspace: ws1 });
  add('老调用（无 sessionId）查到就返回、不新建', legacyOnWs1.ok && [projA.id, projB.id].includes(legacyOnWs1.data.project.id)
    && rt.stateStore.listProjects().length === beforeCount, legacyOnWs1.data?.project?.id);
  const shared = rt.ensureProject({ workspace: ws2 });
  const sharedProj = shared.data?.project;
  add('无 sessionId 的新工作区创建共享项目（sessionId=null）', shared.ok && sharedProj.sessionId === null, sharedProj?.id);
  const sharedAgain = rt.ensureProject({ workspace: ws2 });
  add('无 sessionId 重复 ensure 复用共享项目', sharedAgain.data?.project?.id === sharedProj.id, sharedAgain.data?.project?.id);
  const updShared = rt.projects.applyArchitecture({
    workspace: ws2, agentId: mainAgentId,
    args: { nodes: [{ label: '共享模块', layer: 'platform' }] }, // 无 sessionId → 共享项目
  });
  add('无 sessionId 的架构更新落共享项目', updShared.project?.id === sharedProj.id && updShared.project.nodes.length === 1, updShared.project?.id);
  add('共享项目与会话项目互不影响', rt.stateStore.getProject(projA.id).nodes.length === 1 && sharedProj.id !== projA.id, 'ok');
  add('listProjects 仍全量返回（UI 过滤）', rt.stateStore.listProjects().length === 3 && rt.listProjects().data.projects.length === 3, `${rt.stateStore.listProjects().length} 个`);

  /* 6. 旧数据兼容：手工删除 sessionId 字段模拟历史数据 */
  delete rt.stateStore.state.projects[sharedProj.id].sessionId;
  const oldData = rt.stateStore.state.projects[sharedProj.id];
  add('旧数据模拟成功（无 sessionId 字段）', !('sessionId' in oldData), sharedProj.id);
  add('旧数据不会被会话键查询命中', rt.stateStore.findProjectBySession(ws2, SID_A) === null, 'ok');
  const legacyHit = rt.ensureProject({ workspace: ws2 });
  add('旧数据仍可被无 sessionId 调用命中', legacyHit.data?.project?.id === sharedProj.id, legacyHit.data?.project?.id);

  /* 7. schema：sessionId 可选字段不破坏校验，未知字段仍被拒 */
  let schemaOk = false;
  let unknownRejected = false;
  try { validateToolArgs('project_architecture', { sessionId: SID_A, nodes: [{ label: 'x' }] }); schemaOk = true; } catch (err) { schemaOk = String(err.message); }
  try { validateToolArgs('project_architecture', { evilField: 1 }); } catch { unknownRejected = true; }
  add('schema 接受可选 sessionId', schemaOk === true, String(schemaOk));
  add('schema 仍拒绝未知字段', unknownRejected, 'ok');

  /* 8. 端到端：project_architecture 工具调用带 sessionId 透传到会话项目 */
  const t1 = newTask(rt, ws1, '会话 B 架构回填');
  const run1 = await runArch(rt, t1.run.id, {
    sessionId: SID_B,
    nodes: [{ label: 'B端到端模块', layer: 'domain' }],
  }, 'full');
  const bAfterRun = rt.stateStore.getProject(projB.id);
  add('工具调用带 sessionId 端到端成功', run1.proposal.data?.status === 'ready' && run1.exec?.data?.ok === true, run1.exec?.data?.status || run1.proposal.error?.message);
  add('端到端更新落在会话 B 项目上', bAfterRun.nodes.length === 2 && bAfterRun.nodes.some((n) => n.label === 'B端到端模块'), `${bAfterRun.nodes.length} 节点`);
  add('端到端不影响会话 A', rt.stateStore.getProject(projA.id).nodes.length === 1, `${rt.stateStore.getProject(projA.id).nodes.length} 节点`);

  /* 9. 持久化：sessionId 字段随状态写盘并可在重启后按会话取回 */
  rt.close();
  const rt2 = makeRuntime(path.join(root, 'store'), ws1);
  const reloadedA = rt2.stateStore.getProjectBySession(SID_A);
  add('重启后按会话取回项目', reloadedA.length === 1 && reloadedA[0].id === projA.id && reloadedA[0].sessionId === SID_A, JSON.stringify(reloadedA.map((p) => p.id)));
  rt2.close();
  fs.rmSync(root, { recursive: true, force: true });

  const passed = checks.filter((c) => c.pass).length;
  console.log(JSON.stringify({ checks, total: checks.length, passed, failed: checks.length - passed }, null, 2));
  if (passed !== checks.length) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
