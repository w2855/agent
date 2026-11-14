'use strict';

/* Run Graph 投影自检：节点/边、状态合并、确定性、按 seq 截断回放、无副作用。
   运行：node tools/runtime-graph-check.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtimeModule = require('../runtime');
const { projectGraph } = require('../runtime/graph');
const localTools = require('../lib/tools');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`));
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

(async () => {
  const root = tempDir('graph');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'graph sample\n', 'utf8');

  const rt = makeRuntime(path.join(root, 'store'), workspace);
  const task = rt.createTask({ title: '图形测试', input: '生成运行图', model: 'graph-model', idempotencyKey: 'graph-1' }).data;
  const runId = task.run.id;

  /* 模型步骤 */
  const s1 = rt.beginStep({ runId, kind: 'model' }).data.step;
  const mc = rt.modelStart({ runId, stepId: s1.id, model: 'graph-model', messageCount: 2, approxInputTokens: 20, meta: [] }).data.modelCallId;
  rt.modelFinish({ modelCallId: mc, status: 'completed', usage: { prompt_tokens: 12, completion_tokens: 4 }, finishReason: 'stop' });
  rt.finishStep({ stepId: s1.id, status: 'succeeded', modelCallId: mc });

  /* 直接放行的工具 */
  const s2 = rt.beginStep({ runId, kind: 'tool_call' }).data.step;
  const read = rt.proposeTool({ runId, stepId: s2.id, name: 'read_file', args: { path: 'a.txt' }, profile: 'full' }).data;
  await rt.executeTool({ toolCallId: read.toolCallId, profile: 'full', workspace });
  rt.finishStep({ stepId: s2.id, status: 'succeeded' });

  /* 审批允许的工具 */
  const s3 = rt.beginStep({ runId, kind: 'tool_call' }).data.step;
  const write = rt.proposeTool({ runId, stepId: s3.id, name: 'write_file', args: { path: 'b.txt', content: 'graph write' }, profile: 'ask' }).data;
  rt.decideApproval({ approvalId: write.approval.id, decision: 'approved', scope: 'once', reason: '图形测试' });
  await rt.executeTool({ toolCallId: write.toolCallId, approvalId: write.approval.id, profile: 'ask', workspace });
  rt.finishStep({ stepId: s3.id, status: 'succeeded' });

  /* 审批拒绝的工具 */
  const s4 = rt.beginStep({ runId, kind: 'tool_call' }).data.step;
  const denied = rt.proposeTool({ runId, stepId: s4.id, name: 'write_file', args: { path: 'c.txt', content: 'nope' }, profile: 'ask' }).data;
  rt.decideApproval({ approvalId: denied.approval.id, decision: 'denied', reason: '不批准' });
  rt.finishStep({ stepId: s4.id, status: 'canceled' });

  rt.finishRun({ runId, outcome: 'succeeded', summary: '图形完成', validated: true });

  /* 1. 结构 */
  const g1 = rt.runGraph({ runId });
  add('runGraph 返回 Result', g1.ok === true && g1.data.graph.runId === runId, g1.ok ? '' : g1.error?.message);
  const graph = g1.data.graph;
  const kinds = new Set(graph.nodes.map((n) => n.kind));
  add('图包含 run/step/model/tool/approval/validation/end 节点', ['run', 'step', 'model', 'tool', 'approval', 'validation', 'end'].every((k) => kinds.has(k)), [...kinds].join(','));
  add('统计与节点一致', graph.stats.steps === 4 && graph.stats.toolCalls === 3 && graph.stats.approvals === 2 && graph.stats.modelCalls === 1, JSON.stringify(graph.stats));
  add('存在 run→step 起始边', graph.edges.some((e) => e.from === `run:${runId}` && e.kind === 'start'), 'ok');
  add('step 之间有顺序边', graph.edges.filter((e) => e.kind === 'next').length >= 3, graph.edges.filter((e) => e.kind === 'next').length);
  add('审批节点挂在工具节点下', graph.edges.some((e) => e.kind === 'approval' && e.from.startsWith('tool:')), 'ok');
  add('结尾节点状态 succeeded', graph.nodes.find((n) => n.kind === 'end')?.status === 'succeeded', graph.nodes.find((n) => n.kind === 'end')?.status);

  const modelNode = graph.nodes.find((n) => n.kind === 'model');
  add('模型节点记录 usage', modelNode?.status === 'succeeded' && modelNode.usage?.completion_tokens === 4, JSON.stringify(modelNode?.usage));
  const readNode = graph.nodes.find((n) => n.toolCallId === read.toolCallId);
  add('工具节点带策略与结果', readNode?.status === 'succeeded' && readNode.policy?.decision === 'allow' && !!readNode.resultCode, JSON.stringify({ status: readNode?.status, policy: readNode?.policy?.decision }));
  const writeNode = graph.nodes.find((n) => n.toolCallId === write.toolCallId);
  const writeApr = graph.nodes.find((n) => n.approvalId === write.approval.id);
  add('审批允许后工具节点 succeeded', writeNode?.status === 'succeeded' && writeApr?.status === 'approved', `${writeNode?.status}/${writeApr?.status}`);
  const deniedNode = graph.nodes.find((n) => n.toolCallId === denied.toolCallId);
  const deniedApr = graph.nodes.find((n) => n.approvalId === denied.approval.id);
  add('审批拒绝后工具节点 denied', deniedNode?.status === 'denied' && deniedApr?.status === 'denied', `${deniedNode?.status}/${deniedApr?.status}`);
  add('产物节点数据挂到工具', Array.isArray(writeNode?.artifacts) && writeNode.artifacts.length === 1, JSON.stringify(writeNode?.artifacts));

  /* 2. 截断回放 */
  const deniedSeq = rt.read({ runId, limit: 5000 }).events.find((e) => e.type === 'approval.decided' && e.payload?.approvalId === denied.approval.id)?.seq;
  const cut = rt.runGraph({ runId, beforeSeq: deniedSeq });
  const cutGraph = cut.data.graph;
  add('按 seq 截断时不包含结尾节点', !cutGraph.nodes.some((n) => n.kind === 'end') && !cutGraph.nodes.some((n) => n.id === 'validation'), cut.data.beforeSeq);
  add('截断回放报告 hasMore', cut.data.hasMore === true && cut.data.lastSeq > cut.data.beforeSeq, `${cut.data.beforeSeq}/${cut.data.lastSeq}`);
  const deniedToolAtCut = cutGraph.nodes.find((n) => n.toolCallId === denied.toolCallId);
  add('截断点工具尚未执行', deniedToolAtCut && deniedToolAtCut.status === 'denied' && !deniedToolAtCut.endedAt, deniedToolAtCut?.status);
  const firstStepSeq = rt.read({ runId, limit: 5000 }).events.find((e) => e.type === 'step.started')?.seq;
  const emptyGraph = rt.runGraph({ runId, beforeSeq: firstStepSeq - 1 }).data.graph;
  add('起始点之前只有 run 节点', emptyGraph.nodes.length === 1 && emptyGraph.nodes[0].kind === 'run', emptyGraph.nodes.length);

  /* 3. 确定性与无副作用 */
  const events1 = rt.read({ runId, limit: 5000 }).events;
  const a = projectGraph(events1, { runId, title: '图形测试', model: 'graph-model' });
  const b = projectGraph(events1, { runId, title: '图形测试', model: 'graph-model' });
  add('同一事件序列投影完全一致', JSON.stringify(a) === JSON.stringify(b), 'ok');
  const beforeJson = JSON.stringify(events1);
  projectGraph(events1, { runId });
  add('投影不修改输入事件', JSON.stringify(events1) === beforeJson, 'ok');
  const seqBefore = rt.read({ limit: 1 }).events[0]?.seq;
  const countBefore = rt.read({ runId, limit: 5000 }).events.length;
  rt.runGraph({ runId, beforeSeq: deniedSeq });
  const countAfter = rt.read({ runId, limit: 5000 }).events.length;
  add('回放不写入新事件', countAfter === countBefore && rt.read({ limit: 1 }).events[0]?.seq === seqBefore, `${countBefore}->${countAfter}`);

  /* 4. 取消运行的图 */
  const task2 = rt.createTask({ title: '取消图', idempotencyKey: 'graph-cancel' }).data;
  rt.cancelTask({ taskId: task2.task.id, reason: '测试取消' });
  const g2 = rt.runGraph({ runId: task2.run.id }).data.graph;
  add('取消运行图以 canceled 结束', g2.status === 'canceled' && g2.nodes.find((n) => n.kind === 'end')?.status === 'canceled', g2.status);

  /* 5. end 后事件抑制与断点续跑重开（P2） */
  rt.append({ type: 'tool.proposed', runId, payload: { toolCallId: 'call_stray', name: 'read_file', argsSummary: '迟到的事件', sideEffect: 'read', risk: 'low', version: '1.0.0' } });
  const g3 = rt.runGraph({ runId }).data.graph;
  add('end 后事件不计入投影', g3.stats.toolCalls === 3 && g3.nodes.every((n) => n.toolCallId !== 'call_stray'), JSON.stringify({ tools: g3.stats.toolCalls, stray: g3.nodes.some((n) => n.toolCallId === 'call_stray') }));
  add('end 后事件显式计数标记', g3.postEndEvents === 1, g3.postEndEvents);
  const resumeEvents = [
    { seq: 1, ts: 1, type: 'run.started', payload: {} },
    { seq: 2, ts: 2, type: 'run.interrupted', payload: { reason: 'runtime_restart' } },
    { seq: 3, ts: 3, type: 'run.status_changed', payload: { from: 'interrupted', to: 'running', reason: 'delegation_checkpoint_resume' } },
    { seq: 4, ts: 4, type: 'step.started', stepId: 'step_resume', payload: { index: 1, kind: 'model' } },
    { seq: 5, ts: 5, type: 'run.finished', payload: { outcome: 'succeeded' } },
  ];
  const g4 = projectGraph(resumeEvents, { runId: 'run_resume' });
  add('断点续跑后投影重新打开', g4.nodes.some((n) => n.stepId === 'step_resume') && g4.nodes.filter((n) => n.id === 'end').length === 1 && g4.status === 'succeeded', JSON.stringify(g4.nodes.map((n) => n.id)));
  add('断点续跑标记不计入 end 后事件', g4.postEndEvents === 0, g4.postEndEvents);

  rt.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }

  const result = { checks, total: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.failed ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
