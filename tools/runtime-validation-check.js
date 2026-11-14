'use strict';

/* 业务后置条件校验自检：运行收尾时校验产物存在性与哈希。
   运行：node tools/runtime-validation-check.js */

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

(async () => {
  const root = tempDir('validation');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace, { recursive: true });

  const rt = runtimeModule.createRuntime({
    dir: path.join(root, 'store'),
    workspacePath: workspace,
    executeTool: (name, args, opts) => localTools.executeTool(name, args, opts),
  });
  rt.init();

  const writeThrough = async (taskId, runId, rel, content) => {
    const step = rt.beginStep({ runId, kind: 'tool_call' }).data.step;
    const proposal = rt.proposeTool({ runId, stepId: step.id, name: 'write_file', args: { path: rel, content }, profile: 'full' });
    if (!proposal.ok || proposal.data.status !== 'ready') throw new Error('写工具未就绪：' + JSON.stringify(proposal));
    const exec = await rt.executeTool({ toolCallId: proposal.data.toolCallId, profile: 'full', workspace });
    if (!exec.ok || !exec.data.ok) throw new Error('写工具执行失败：' + JSON.stringify(exec));
    rt.finishStep({ stepId: step.id, status: 'succeeded' });
  };

  /* 1. 产物完好 → passed */
  const t1 = rt.createTask({ title: '产物完好', idempotencyKey: 'val-1' }).data;
  await writeThrough(t1.task.id, t1.run.id, 'ok.txt', 'hello validation');
  const f1 = rt.finishRun({ runId: t1.run.id, outcome: 'succeeded', summary: '完成' });
  add('产物完好时 validation 为 passed', f1.ok && f1.data.validation.status === 'passed', JSON.stringify(f1.data?.validation));
  add('产物完好时 Run 成功且 validated=true', f1.data.run.status === 'succeeded' && f1.data.run.validated === true, `${f1.data?.run?.status}/${f1.data?.run?.validated}`);
  add('校验检查项引用产物文件名', f1.data.validation.checks.some((c) => c.name === 'artifact:ok.txt' && c.status === 'passed'), JSON.stringify(f1.data?.validation?.checks));

  /* 2. 产物被篡改 → failed，Run/Task 标记失败 */
  const t2 = rt.createTask({ title: '产物篡改', idempotencyKey: 'val-2' }).data;
  await writeThrough(t2.task.id, t2.run.id, 'tampered.txt', 'original content');
  fs.writeFileSync(path.join(workspace, 'tampered.txt'), 'tampered content!', 'utf8');
  const f2 = rt.finishRun({ runId: t2.run.id, outcome: 'succeeded', summary: '完成' });
  add('产物哈希不一致时 validation 为 failed', f2.ok && f2.data.validation.status === 'failed', JSON.stringify(f2.data?.validation));
  add('校验失败把 Run 标记 failed', f2.data.run.status === 'failed' && f2.data.run.validated === false, `${f2.data?.run?.status}/${f2.data?.run?.validated}`);
  add('校验失败把 Task 标记 failed', f2.data.task.status === 'failed', f2.data?.task?.status);
  add('校验失败返回 VALIDATION_FAILED', f2.data.errorCode === 'VALIDATION_FAILED', f2.data?.errorCode);
  const ev2 = rt.read({ afterSeq: 0, runId: t2.run.id, limit: 5000 }).events;
  add('validation.completed 记录 failed 与检查明细', ev2.some((e) => e.type === 'validation.completed' && e.payload?.status === 'failed' && e.payload?.checks?.some((c) => c.status === 'failed')), 'ok');
  add('run.finished 携带 VALIDATION_FAILED', ev2.some((e) => e.type === 'run.finished' && e.payload?.errorCode === 'VALIDATION_FAILED'), 'ok');
  add('task.finished 携带 VALIDATION_FAILED', ev2.some((e) => e.type === 'task.finished' && e.payload?.errorCode === 'VALIDATION_FAILED'), 'ok');

  /* 3. 产物被删除 → failed */
  const t3 = rt.createTask({ title: '产物删除', idempotencyKey: 'val-3' }).data;
  await writeThrough(t3.task.id, t3.run.id, 'gone.txt', 'temporary');
  fs.rmSync(path.join(workspace, 'gone.txt'));
  const f3 = rt.finishRun({ runId: t3.run.id, outcome: 'succeeded', summary: '完成' });
  add('产物不存在时校验失败', f3.ok && f3.data.validation.status === 'failed' && f3.data.validation.checks.some((c) => c.detail.includes('不存在')), JSON.stringify(f3.data?.validation));
  add('产物不存在时 Run 标记 failed', f3.data.run.status === 'failed', f3.data?.run?.status);

  /* 4. 无产物 → skipped，不影响成功 */
  const t4 = rt.createTask({ title: '无产物', idempotencyKey: 'val-4' }).data;
  const f4 = rt.finishRun({ runId: t4.run.id, outcome: 'succeeded', summary: '纯对话' });
  add('无产物时 validation 为 skipped', f4.ok && f4.data.validation.status === 'skipped' && f4.data.validation.checks.length === 0, JSON.stringify(f4.data?.validation));
  add('无产物时 Run 保持 succeeded', f4.data.run.status === 'succeeded' && f4.data.task.status === 'succeeded', `${f4.data?.run?.status}/${f4.data?.task?.status}`);

  /* 5. 失败收尾不触发校验覆盖 */
  const t5 = rt.createTask({ title: '模型失败', idempotencyKey: 'val-5' }).data;
  const f5 = rt.finishRun({ runId: t5.run.id, outcome: 'failed', errorCode: 'MODEL_ERROR', summary: '失败' });
  add('失败收尾不执行产物校验', f5.ok && f5.data.validation.status === 'skipped' && f5.data.errorCode === 'MODEL_ERROR', JSON.stringify({ v: f5.data?.validation?.status, code: f5.data?.errorCode }));
  add('失败收尾保留错误码', f5.data.run.status === 'failed' && f5.data.task.status === 'failed', `${f5.data?.run?.status}/${f5.data?.task?.status}`);

  /* 6. 命令退出码纳入校验，非零退出按已知失败处理 */
  const t6 = rt.createTask({ title: '命令成功', idempotencyKey: 'val-6' }).data;
  const step6 = rt.beginStep({ runId: t6.run.id, kind: 'tool_call' }).data.step;
  const p6 = rt.proposeTool({ runId: t6.run.id, stepId: step6.id, name: 'run_command', args: { command: 'echo ok' }, profile: 'full' });
  const e6 = await rt.executeTool({ toolCallId: p6.data.toolCallId, profile: 'full', workspace });
  add('退出码 0 的命令执行成功', e6.ok && e6.data.ok === true, JSON.stringify(e6.data));
  rt.finishStep({ stepId: step6.id, status: 'succeeded' });
  const f6 = rt.finishRun({ runId: t6.run.id, outcome: 'succeeded' });
  add('成功命令产生 command 校验项', f6.ok && f6.data.validation.checks.some((c) => /^command:/.test(c.name) && c.status === 'passed'), JSON.stringify(f6.data?.validation));

  const t7 = rt.createTask({ title: '命令失败', idempotencyKey: 'val-7' }).data;
  const step7 = rt.beginStep({ runId: t7.run.id, kind: 'tool_call' }).data.step;
  const p7 = rt.proposeTool({ runId: t7.run.id, stepId: step7.id, name: 'run_command', args: { command: 'exit /b 7' }, profile: 'full' });
  const e7 = await rt.executeTool({ toolCallId: p7.data.toolCallId, profile: 'full', workspace });
  add('非零退出码标记 COMMAND_FAILED', e7.ok && e7.data.ok === false && e7.data.code === 'COMMAND_FAILED' && e7.data.status === 'failed', JSON.stringify(e7.data));
  add('非零退出码不进入 unknown 对账', rt.getTask(t7.task.id).data.details[0].toolCalls.find((c) => c.id === p7.data.toolCallId)?.status === 'failed', rt.getTask(t7.task.id).data.details[0].toolCalls.find((c) => c.id === p7.data.toolCallId)?.status);
  rt.finishStep({ stepId: step7.id, status: 'canceled' });
  const f7 = rt.finishRun({ runId: t7.run.id, outcome: 'succeeded' });
  add('已知失败命令不阻断运行校验', f7.ok && f7.data.validation.status === 'skipped', JSON.stringify(f7.data?.validation));

  /* 7. 重复收尾幂等 */
  const again = rt.finishRun({ runId: t1.run.id, outcome: 'succeeded' });
  add('重复收尾返回 deduped 且状态不变', again.ok && again.data.deduped === true && again.data.run.status === 'succeeded', JSON.stringify({ deduped: again.data?.deduped, status: again.data?.run?.status }));

  add('事件链仍无缺口', rt.store.verify().ok, JSON.stringify(rt.store.verify()));
  rt.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 文件占用时忽略 */ }

  const result = {
    checks,
    total: checks.length,
    passed: checks.filter((c) => c.pass).length,
    failed: checks.filter((c) => !c.pass).length,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.failed ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
