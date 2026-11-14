'use strict';

/* 项目主体自检：工作区项目、主控 Agent 权限、架构合并/替换、实时状态、事件与审计。
   运行：node tools/runtime-project-check.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtimeModule = require('../runtime');
const localTools = require('../lib/tools');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`));
}

function makeWorkspace(root, name, pkg = {}) {
  const ws = path.join(root, name);
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({
    name: pkg.name || 'star-fortress',
    description: pkg.description || '像素风塔防游戏',
    dependencies: { phaser: '^3.80.0', react: '^19.0.0' },
    devDependencies: { typescript: '^5.6.0' },
  }, null, 2));
  fs.writeFileSync(path.join(ws, 'README.md'), `# ${pkg.readme || 'Star Fortress'}\n一个可联机的像素风塔防游戏。\n`);
  fs.writeFileSync(path.join(ws, 'index.html'), '<div id="app"></div>');
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

function newTask(rt, workspace, title, agentId) {
  const r = rt.createTask({
    title,
    input: title,
    workspace,
    agentId,
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

(async () => {
  const root = tempDir('project');
  const workspace = makeWorkspace(root, 'ws');
  const rt = makeRuntime(path.join(root, 'store'), workspace);
  rt.setSettings({ maxConcurrentRuns: 16 });
  const defaultAgentId = rt.listAgents().data.defaultAgentId;

  /* 1. 项目创建与工作区发现 */
  const ensured = rt.ensureProject({ workspace });
  const project = ensured.data?.project;
  add('可为工作区创建项目', ensured.ok && /^prj_/.test(project?.id || ''), project?.id || ensured.error?.message);
  add('项目绑定默认主控 Agent', project?.mainAgentId === defaultAgentId, project?.mainAgentId);
  add('项目名来自 package.json', project?.name === 'star-fortress', project?.name);
  add('识别技术栈', ['Node.js', 'Phaser', 'React', 'TypeScript'].every((s) => project?.techStack?.includes(s)), (project?.techStack || []).join(','));
  add('发现顶层目录与文件', (project?.discovery?.entries || []).some((e) => e.name === 'src' && e.kind === 'dir')
    && (project.discovery.entries || []).some((e) => e.name === 'package.json'), (project?.discovery?.entries || []).map((e) => e.name).join(','));
  const ensuredAgain = rt.ensureProject({ workspace });
  add('同一工作区复用一个项目', ensuredAgain.data?.project?.id === project.id && rt.listProjects().data.projects.length === 1, ensuredAgain.data?.project?.id);

  /* 2. 目标与主控 Agent 更新 */
  const goalMarker = '机密目标DEADBEEF-不要进入审计';
  const rev0 = project.revision;
  const updated = rt.updateProject({ projectId: project.id, goal: goalMarker, name: '星级要塞' });
  add('可更新项目目标与名称', updated.ok && updated.data.project.goal === goalMarker && updated.data.project.name === '星级要塞', `rev ${updated.data?.project?.revision}`);
  add('项目更新有事件与版本', updated.data.project.revision > rev0
    && rt.read({ limit: 5000 }).events.some((e) => e.type === 'project.updated' && e.payload.projectId === project.id), updated.data.project.revision);

  /* 3. 主控 Agent 提交架构 */
  const t1 = newTask(rt, workspace, '游戏架构');
  const first = await runArch(rt, t1.run.id, {
    goal: goalMarker,
    nodes: [
      { label: '游戏主循环', layer: 'domain', kind: 'module', path: 'src/game', description: '驱动每帧更新与状态机' },
      { label: '渲染层', layer: 'experience', kind: 'component', path: 'src/render', description: '绘制地图与单位' },
      { label: '存档数据', layer: 'data', kind: 'data', path: 'src/save', description: '本地进度与配置' },
      { label: '塔防规则', layer: 'domain', kind: 'service', path: 'src/rules', description: '寻路、伤害与波次' },
    ],
    edges: [
      { from: '游戏主循环', to: '渲染层', kind: 'calls' },
      { from: '游戏主循环', to: '塔防规则', kind: 'calls' },
      { from: '塔防规则', to: '存档数据', kind: 'writes', label: '战果' },
    ],
    milestones: [
      { label: '完成单机核心循环' },
      { label: '完成联机同步' },
    ],
  }, 'full');
  add('主控 Agent 可提交架构', first.proposal.data?.status === 'ready' && first.exec?.ok === true && first.exec.data.ok === true, first.proposal.data?.status || first.proposal.error?.message);
  add('架构工具返回分层摘要', first.exec?.data?.content?.includes('游戏主循环') && first.exec.data.content.includes('revision'), first.exec?.data?.content?.slice(0, 60));
  const p1 = rt.getProject(project.id).data.project;
  add('模块与依赖已持久化', p1.nodes.length === 4 && p1.edges.length === 3, `${p1.nodes.length}/${p1.edges.length}`);
  add('按名称解析依赖端点', p1.edges.some((e) => e.label === '战果') && p1.edges.every((e) => p1.nodes.some((n) => n.id === e.from) && p1.nodes.some((n) => n.id === e.to)), 'ok');
  add('里程碑已写入', p1.milestones.length === 2 && p1.milestones[0].status === 'planned', p1.milestones.map((m) => m.label).join(','));
  add('工具元数据包含项目版本', first.exec?.data?.meta?.projectId === project.id && first.exec.data.meta.nodeCount === 4, JSON.stringify(first.exec?.data?.meta || {}));

  /* 4. 实时状态：关联任务运行中 → 完成 */
  const loopNodeId = p1.nodes.find((n) => n.label === '游戏主循环').id;
  const link = await runArch(rt, t1.run.id, { nodes: [{ id: loopNodeId, label: '游戏主循环', layer: 'domain', kind: 'module', taskId: t1.task.id }] }, 'full');
  add('可把模块关联到任务', link.exec?.ok && rt.getProject(project.id).data.project.nodes.find((n) => n.id === loopNodeId)?.taskId === t1.task.id, link.exec?.data?.status);
  const liveRunning = rt.getProject(project.id).data.live;
  add('运行中任务叠加到模块状态', liveRunning.nodes.find((n) => n.id === loopNodeId)?.effectiveStatus === 'in_progress'
    && liveRunning.nodes.find((n) => n.id === loopNodeId)?.live === true, liveRunning.nodes.find((n) => n.id === loopNodeId)?.effectiveStatus);
  add('实时统计包含活动任务', liveRunning.stats.activeTasks >= 1 && liveRunning.stats.nodes === 4, JSON.stringify(liveRunning.stats));
  rt.finishRun({ runId: t1.run.id, outcome: 'succeeded', summary: '架构完成' });
  const liveDone = rt.getProject(project.id).data.live;
  add('任务成功后模块变已完成', liveDone.nodes.find((n) => n.id === loopNodeId)?.effectiveStatus === 'done', liveDone.nodes.find((n) => n.id === loopNodeId)?.effectiveStatus);

  /* 5. merge：更新已有模块并新增，保留未提及节点 */
  const t2 = newTask(rt, workspace, '继续架构');
  const merged = await runArch(rt, t2.run.id, {
    mode: 'merge',
    nodes: [
      { label: '游戏主循环', layer: 'domain', kind: 'module', description: '已拆分为固定步长循环', status: 'in_progress' },
      { label: '联机同步', layer: 'application', kind: 'service', path: 'src/net', description: '房间与状态同步' },
    ],
    edges: [{ from: '联机同步', to: '游戏主循环', kind: 'emits', label: '帧输入' }],
  }, 'full');
  const p2 = rt.getProject(project.id).data.project;
  const loop2 = p2.nodes.find((n) => n.label === '游戏主循环');
  add('merge 保留原有模块', merged.exec?.ok && p2.nodes.length === 5 && !!p2.nodes.find((n) => n.label === '渲染层'), p2.nodes.length);
  add('merge 更新同名模块并保留未提交字段', loop2?.id === loopNodeId && loop2?.description.includes('固定步长')
    && loop2?.status === 'in_progress' && loop2?.taskId === t1.task.id && loop2?.layer === 'domain' && loop2?.path === 'src/game',
  JSON.stringify({ desc: loop2?.description, status: loop2?.status, task: loop2?.taskId, layer: loop2?.layer, path: loop2?.path }));
  add('merge 保留原依赖并新增', p2.edges.length === 4 && p2.edges.some((e) => e.label === '帧输入'), p2.edges.length);

  /* 6. replace：整体替换 */
  const replaced = await runArch(rt, t2.run.id, {
    mode: 'replace',
    nodes: [
      { label: '游戏主循环', layer: 'domain', kind: 'module', status: 'done' },
      { label: '资源管线', layer: 'platform', kind: 'asset', path: 'assets' },
    ],
    edges: [{ from: '游戏主循环', to: '资源管线', kind: 'reads' }],
  }, 'full');
  const p3 = rt.getProject(project.id).data.project;
  add('replace 移除未提交模块', replaced.exec?.ok && p3.nodes.length === 2 && !p3.nodes.find((n) => n.label === '渲染层'), p3.nodes.map((n) => n.label).join(','));
  add('replace 保留同名模块关联', p3.nodes.find((n) => n.label === '游戏主循环')?.taskId === t1.task.id, p3.nodes.find((n) => n.label === '游戏主循环')?.taskId);
  add('replace 重写依赖', p3.edges.length === 1 && p3.edges[0].kind === 'reads', p3.edges.length);
  const replaceNoEdges = await runArch(rt, t2.run.id, {
    mode: 'replace',
    nodes: [
      { label: '游戏主循环', layer: 'domain', kind: 'module' },
      { label: '资源管线', layer: 'platform', kind: 'asset' },
    ],
  }, 'full');
  const p3b = rt.getProject(project.id).data.project;
  add('replace 未提交依赖被清空', replaceNoEdges.exec?.ok && p3b.edges.length === 0 && p3b.nodes.length === 2, `${p3b.nodes.length}/${p3b.edges.length}`);

  /* 7. 无法解析的依赖边被忽略 */
  const dropped = await runArch(rt, t2.run.id, {
    nodes: [{ label: '战斗系统', layer: 'domain', kind: 'module' }],
    edges: [
      { from: '战斗系统', to: '不存在的模块', kind: 'calls' },
      { from: '战斗系统', to: '游戏主循环', kind: 'depends' },
    ],
  }, 'full');
  add('无法解析的依赖被忽略', dropped.exec?.ok && dropped.exec.data.content.includes('忽略无法解析的依赖边：1'), dropped.exec?.data?.content?.slice(-120));

  /* 8. 上限与参数校验 */
  const tooMany = Array.from({ length: 61 }, (_, i) => ({ label: `模块${i}` }));
  const cap = await runArch(rt, t2.run.id, { nodes: tooMany }, 'full');
  add('超过模块上限被拒绝', cap.exec?.ok === true && cap.exec.data.ok === false && cap.exec.data.status === 'failed' && /上限/.test(cap.exec.data.message), cap.exec?.data?.message);
  const badLayer = await runArch(rt, t2.run.id, { nodes: [{ label: '坏层', layer: 'nope' }] }, 'full');
  add('非法层级被参数校验拒绝', badLayer.proposal.ok && badLayer.proposal.data.status === 'denied' && badLayer.proposal.data.policy.ruleIds.includes('invalid-args'), badLayer.proposal.data?.status);
  const emptyUpdate = await runArch(rt, t2.run.id, {}, 'full');
  add('空架构更新被拒绝', emptyUpdate.exec?.data?.ok === false && /至少需要/.test(emptyUpdate.exec?.data?.message || ''), emptyUpdate.exec?.data?.message);
  const readonlyDenied = await runArch(rt, t2.run.id, { goal: '只读不能改架构' }, 'readonly');
  add('只读档不能修改项目架构', readonlyDenied.proposal.ok && readonlyDenied.proposal.data.status === 'denied'
    && readonlyDenied.proposal.data.policy.ruleIds.includes('readonly-project'), readonlyDenied.proposal.data?.policy?.ruleIds?.join(','));

  /* 9. 非主控 Agent 与子 Agent 被拒绝 */
  const other = rt.createAgent({ name: '旁路 Agent', permissionProfileId: 'full' });
  const t3 = newTask(rt, workspace, '旁路更新', other.data.agent.id);
  const deniedOther = await runArch(rt, t3.run.id, { nodes: [{ label: '越权模块' }] }, 'full');
  add('非主控 Agent 不能改架构', deniedOther.proposal.ok && deniedOther.proposal.data.status === 'denied'
    && deniedOther.proposal.data.policy.ruleIds.includes('project-main-agent-only'), deniedOther.proposal.data?.policy?.ruleIds?.join(','));

  const t4 = newTask(rt, workspace, '子 Agent 越权');
  rt.stateStore.applyDelegationScope(t4.run.id, { delegationId: 'del_test', toolAllow: ['project_architecture'] });
  const deniedChild = await runArch(rt, t4.run.id, { nodes: [{ label: '子代理模块' }] }, 'full');
  add('子 Agent 不能改整体架构', deniedChild.proposal.ok && deniedChild.proposal.data.status === 'denied'
    && deniedChild.proposal.data.policy.ruleIds.includes('project-main-agent-only'), deniedChild.proposal.data?.policy?.ruleIds?.join(','));

  /* 10. 事件与审计不包含架构正文 */
  const events = rt.read({ limit: 5000 }).events;
  const projectEvents = events.filter((e) => e.type === 'project.updated');
  add('架构更新有事件', projectEvents.length >= 4, projectEvents.length);
  add('事件只保留计数，不含模块正文', projectEvents.every((e) => !('nodes' in (e.payload || {})) && !('edges' in (e.payload || {})) && !JSON.stringify(e.payload).includes('DEADBEEF')), 'ok');
  const auditRead = rt.auditRead({ limit: 1000 });
  add('审计记录项目更新', auditRead.ok && auditRead.data.records.some((r) => r.action === 'project.updated' && r.detail.projectId === project.id), auditRead.data?.records?.filter((r) => r.action === 'project.updated').length);
  add('审计不泄漏目标正文', auditRead.ok && !JSON.stringify(auditRead.data.records).includes('DEADBEEF'), 'ok');
  add('审计哈希链校验通过', rt.auditVerify().data.ok === true, JSON.stringify(rt.auditVerify().data.issues || []));
  const health = rt.health().data;
  add('事件链无缺口', health.store.eventLogOk === true, JSON.stringify(health.store));

  /* 11. 第二个工作区是独立项目 */
  const workspace2 = makeWorkspace(root, 'ws2', { name: 'second-app', readme: 'Second' });
  const second = rt.ensureProject({ workspace: workspace2 });
  add('不同工作区有独立项目', second.ok && second.data.project.id !== project.id && rt.listProjects().data.projects.length === 2, second.data?.project?.id);

  /* 12. 主控 Agent 归档后回退默认 Agent */
  const mainSet = rt.updateProject({ projectId: second.data.project.id, mainAgentId: other.data.agent.id });
  add('可指定自定义主控 Agent', mainSet.ok && mainSet.data.project.mainAgentId === other.data.agent.id, mainSet.data?.project?.mainAgentId);
  rt.archiveAgent(other.data.agent.id);
  const fallback = rt.ensureProject({ workspace: workspace2 });
  add('主控归档后自动回退默认 Agent', fallback.ok && fallback.data.project.mainAgentId === defaultAgentId, fallback.data?.project?.mainAgentId);

  /* 13. 持久化 */
  rt.close();
  const rt2 = makeRuntime(path.join(root, 'store'), workspace);
  const reopened = rt2.ensureProject({ workspace });
  add('重启后项目与架构保留', reopened.ok && reopened.data.project.id === project.id && reopened.data.project.nodes.length === 3, `${reopened.data?.project?.nodes?.length} 节点`);
  add('重启后审计链仍通过', rt2.auditVerify().data.ok === true, JSON.stringify(rt2.auditVerify().data.issues || []));
  rt2.close();
  fs.rmSync(root, { recursive: true, force: true });

  const passed = checks.filter((c) => c.pass).length;
  console.log(JSON.stringify({ checks, total: checks.length, passed, failed: checks.length - passed }, null, 2));
  if (passed !== checks.length) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
