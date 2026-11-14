'use strict';

/* 队列/并发/暂停恢复/未知副作用核对接自检。
   运行：node tools/runtime-queue-check.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtimeModule = require('../runtime');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`));
}

(async () => {
  const root = tempDir('queue');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace, { recursive: true });

  const rt = runtimeModule.createRuntime({
    dir: path.join(root, 'store'),
    workspacePath: workspace,
    executeTool: async (name) => {
      if (name === 'run_command') return { ok: false, code: 'TIMEOUT', error: '命令执行超时', content: '$ demo\n超时（已终止）', meta: { label: '超时' } };
      return { ok: true, content: 'stub result', meta: { label: '完成' } };
    },
  });
  rt.init();

  /* 1. 并发上限与排队 */
  const settings0 = rt.getSettings();
  add('默认并发上限可读取', settings0.ok && settings0.data.maxConcurrentRuns >= 1, JSON.stringify(settings0.data));
  const set1 = rt.setSettings({ maxConcurrentRuns: 1 });
  add('并发上限可设置为 1', set1.ok && set1.data.maxConcurrentRuns === 1, JSON.stringify(set1.data));

  const t1 = rt.createTask({ title: '队列-1', idempotencyKey: 'q-1' }).data;
  const t2 = rt.createTask({ title: '队列-2', idempotencyKey: 'q-2' }).data;
  const t3 = rt.createTask({ title: '队列-3', idempotencyKey: 'q-3' }).data;
  add('第一个任务立即获得运行', t1.task.status === 'running' && !!t1.run, t1.task.status);
  add('后两个任务进入队列', t2.task.status === 'queued' && t2.run === null && t3.task.status === 'queued', `${t2.task.status}/${t3.task.status}`);
  add('队列位置按提交顺序', rt.getTask(t2.task.id).data.task.queuePosition === 1 && rt.getTask(t3.task.id).data.task.queuePosition === 2, `${rt.getTask(t2.task.id).data.task.queuePosition}/${rt.getTask(t3.task.id).data.task.queuePosition}`);
  const qHealth = rt.health().data.queue;
  add('health 暴露并发与队列', qHealth.activeRuns === 1 && qHealth.queued === 2 && qHealth.maxConcurrentRuns === 1, JSON.stringify(qHealth));
  const queuedEvents = rt.read({ limit: 5000 }).events.filter((e) => e.type === 'task.queued' && [t2.task.id, t3.task.id].includes(e.taskId));
  add('排队产生 task.queued 事件', queuedEvents.length === 2 && queuedEvents.every((e) => e.payload?.queuePosition >= 1), queuedEvents.map((e) => e.payload?.queuePosition).join(','));

  /* 2. 完成后自动出队 */
  rt.finishRun({ runId: t1.run.id, outcome: 'succeeded', summary: '完成' });
  const t2After = rt.getTask(t2.task.id).data.task;
  add('完成后队列自动提升', t2After.status === 'running' && !!t2After.id, t2After.status);
  add('提升后队列位置前移', rt.getTask(t3.task.id).data.task.queuePosition === 1, rt.getTask(t3.task.id).data.task.queuePosition);
  add('提升后创建运行记录', rt.getTask(t2.task.id).data.runs.length === 1, rt.getTask(t2.task.id).data.runs.length);

  /* 3. 暂停 / 恢复 */
  const paused = rt.pauseTask({ taskId: t3.task.id, reason: '测试暂停' });
  add('排队任务可暂停', paused.ok && paused.data.task.status === 'paused', paused.data?.task?.status);
  const resume = rt.resumeTask({ taskId: t3.task.id });
  add('恢复后重新排队等待容量', resume.ok && resume.data.task.status === 'queued' && resume.data.run === null, `${resume.data?.task?.status}/${resume.data?.run}`);
  const pauseRunning = rt.pauseTask({ taskId: t2.task.id });
  add('运行中任务暂停被明确拒绝', pauseRunning.ok === false && pauseRunning.error.code === 'TASK_PAUSE_FAILED', pauseRunning.error?.message);

  rt.finishRun({ runId: rt.getTask(t2.task.id).data.runs[0].id, outcome: 'succeeded' });
  add('容量释放后暂停恢复的任务出队', rt.getTask(t3.task.id).data.task.status === 'running', rt.getTask(t3.task.id).data.task.status);

  const t3Run = rt.getTask(t3.task.id).data.runs[0];
  rt.cancelTask({ taskId: t3.task.id, reason: '测试取消' });
  add('取消运行中任务同时取消运行', rt.getRun(t3Run.id).data.run.status === 'canceled', rt.getRun(t3Run.id).data.run.status);
  add('取消后队列为空', rt.health().data.queue.queued === 0 && rt.health().data.queue.activeRuns === 0, JSON.stringify(rt.health().data.queue));

  /* 4. 设置边界 */
  const clampLow = rt.setSettings({ maxConcurrentRuns: 0 });
  add('并发下限被限制为 1', clampLow.data.maxConcurrentRuns === 1, JSON.stringify(clampLow.data));
  const clampHigh = rt.setSettings({ maxConcurrentRuns: 999 });
  add('并发上限被限制为 16', clampHigh.data.maxConcurrentRuns === 16, JSON.stringify(clampHigh.data));
  rt.setSettings({ maxConcurrentRuns: 4 });

  /* 5. 未知副作用核对 */
  const t4 = rt.createTask({ title: '未知结果', idempotencyKey: 'q-unknown' }).data;
  const step = rt.beginStep({ runId: t4.run.id, kind: 'tool_call' }).data.step;
  const proposal = rt.proposeTool({ runId: t4.run.id, stepId: step.id, name: 'run_command', args: { command: 'echo demo' }, profile: 'full' }).data;
  const exec = await rt.executeTool({ toolCallId: proposal.toolCallId, profile: 'full', workspace });
  add('命令超时标记 unknown', exec.ok && exec.data.ok === false && exec.data.status === 'unknown', exec.data?.status || exec.error?.message);
  const callUnknown = rt.getRun(t4.run.id).data.toolCalls.find((c) => c.id === proposal.toolCallId);
  add('ToolCall 状态为 unknown', callUnknown?.status === 'unknown', callUnknown?.status);
  add('写入 tool.unknown 事件', rt.read({ runId: t4.run.id, limit: 500 }).events.some((e) => e.type === 'tool.unknown'), 'ok');
  const graphUnknown = rt.runGraph({ runId: t4.run.id }).data.graph;
  add('图中工具节点为 unknown', graphUnknown.nodes.find((n) => n.toolCallId === proposal.toolCallId)?.status === 'unknown', graphUnknown.nodes.find((n) => n.toolCallId === proposal.toolCallId)?.status);

  const recon = rt.reconcileTool({ toolCallId: proposal.toolCallId, outcome: 'succeeded', reason: '人工确认命令已生效' });
  add('人工核对可结束 unknown', recon.ok && recon.data.toolCall.status === 'succeeded' && !!recon.data.toolCall.reconciledAt, recon.data?.toolCall?.status || recon.error?.message);
  add('写入 tool.reconciled 事件', rt.read({ runId: t4.run.id, limit: 500 }).events.some((e) => e.type === 'tool.reconciled'), 'ok');
  const reconAudit = rt.auditRead({ limit: 2000 }).data.records.filter((r) => r.action === 'tool.reconciled');
  add('审计记录人工核对', reconAudit.length === 1 && reconAudit[0].outcome === 'succeeded' && reconAudit[0].toolCallId === proposal.toolCallId, JSON.stringify(reconAudit[0] || {}));
  const graphRecon = rt.runGraph({ runId: t4.run.id }).data.graph.nodes.find((n) => n.toolCallId === proposal.toolCallId);
  add('图中工具节点更新为 succeeded', graphRecon?.status === 'succeeded' && graphRecon.reconciled === true, `${graphRecon?.status}/${graphRecon?.reconciled}`);
  const reconAgain = rt.reconcileTool({ toolCallId: proposal.toolCallId, outcome: 'failed', reason: '重复核对' });
  add('重复核对幂等返回', reconAgain.ok && reconAgain.data.toolCall.status === 'succeeded', reconAgain.data?.toolCall?.status || reconAgain.error?.message);
  const badReconcile = rt.reconcileTool({ toolCallId: proposal.toolCallId, outcome: 'whatever' });
  add('非法核对结果被拒绝', badReconcile.ok === false, badReconcile.error?.code);

  const step2 = rt.beginStep({ runId: t4.run.id, kind: 'tool_call' }).data.step;
  const ready = rt.proposeTool({ runId: t4.run.id, stepId: step2.id, name: 'list_dir', args: { path: '.' }, profile: 'full' }).data;
  const badState = rt.reconcileTool({ toolCallId: ready.toolCallId, outcome: 'failed' });
  add('非 unknown 调用不允许核对', badState.ok === false && badState.error.code === 'TOOL_RECONCILE_FAILED', badState.error?.message);
  rt.finishStep({ stepId: step2.id, status: 'skipped' });
  rt.finishRun({ runId: t4.run.id, outcome: 'succeeded' });

  rt.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }

  const result = { checks, total: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.failed ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
