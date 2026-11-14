'use strict';

/* 本地审计链自检：投影、哈希链、篡改检测、重启续链、恢复事件。
   运行：node tools/runtime-audit-check.js */

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

function makeRuntime(dir, workspace) {
  const rt = runtimeModule.createRuntime({
    dir,
    workspacePath: workspace,
    executeTool: (name, args, opts) => localTools.executeTool(name, args, opts),
  });
  rt.init();
  return rt;
}

function auditFiles(dir) {
  const auditDir = path.join(dir, 'audit');
  return fs.readdirSync(auditDir).filter((n) => n.endsWith('.jsonl')).sort().map((n) => path.join(auditDir, n));
}

(async () => {
  const root = tempDir('audit');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'sample.txt'), '审计样例内容\n', 'utf8');

  let rt = makeRuntime(path.join(root, 'store'), workspace);

  const task = rt.createTask({ title: '审计测试', input: '读取文件', idempotencyKey: 'audit-1' }).data;
  const step = rt.beginStep({ runId: task.run.id, kind: 'tool_call' }).data.step;
  const read = rt.proposeTool({ runId: task.run.id, stepId: step.id, name: 'read_file', args: { path: 'sample.txt' }, profile: 'full' });
  const exec = await rt.executeTool({ toolCallId: read.data.toolCallId, profile: 'full', workspace });
  rt.finishStep({ stepId: step.id, status: 'succeeded' });

  const step2 = rt.beginStep({ runId: task.run.id, kind: 'tool_call' }).data.step;
  const write = rt.proposeTool({ runId: task.run.id, stepId: step2.id, name: 'write_file', args: { path: 'a.txt', content: '敏感内容不应进入审计' }, profile: 'ask' });
  rt.decideApproval({ approvalId: write.data.approval.id, decision: 'approved', scope: 'once', reason: '测试' });
  await rt.executeTool({ toolCallId: write.data.toolCallId, approvalId: write.data.approval.id, profile: 'ask', workspace });
  rt.finishStep({ stepId: step2.id, status: 'succeeded' });

  const hard = rt.proposeTool({ runId: task.run.id, stepId: step2.id, name: 'run_command', args: { command: 'format C:' }, profile: 'full' });
  add('硬拒绝仍产生策略事件', hard.data?.status === 'denied', hard.data?.status);

  /* 1. 记录与链 */
  const records = rt.auditRead({ limit: 1000 }).data.records;
  add('审计记录已生成', records.length >= 6, `records=${records.length}`);
  add('包含任务创建与策略判定', records.some((r) => r.action === 'task.created') && records.some((r) => r.action === 'policy.decided'), records.map((r) => r.action).join(','));
  add('包含审批决定与工具结果', records.some((r) => r.action === 'approval.decided' && r.outcome === 'approved') && records.some((r) => r.action === 'tool.result' && r.outcome === 'completed'), 'ok');
  const verify1 = rt.auditVerify();
  add('哈希链校验通过', verify1.ok && verify1.data.ok && verify1.data.issues.length === 0, JSON.stringify(verify1.data));

  const chained = records.every((r, i) => i === 0 || r.prevHash === records[i - 1].hash);
  add('prevHash 逐条相连', chained, 'ok');
  const seqOk = records.every((r, i) => r.seq === i + 1);
  add('审计序号从 1 连续', seqOk, records.map((r) => r.seq).join(','));

  /* 2. 不泄漏内容 */
  const rawAudit = auditFiles(path.join(root, 'store')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  add('审计不含文件内容', !rawAudit.includes('敏感内容不应进入审计') && !rawAudit.includes('审计样例内容'), 'ok');
  add('审计不含完整参数', !rawAudit.includes('sample.txt"') && !rawAudit.includes('"args"'), 'ok');

  /* 3. 分页 */
  const page1 = rt.auditRead({ afterSeq: 0, limit: 2 }).data;
  const page2 = rt.auditRead({ afterSeq: page1.nextSeq, limit: 2 }).data;
  add('审计可分页读取', page1.records.length === 2 && page2.records.length === 2 && page2.records[0].seq === 3, `${page1.records.length}/${page2.records.length}`);

  /* 4. 篡改检测 */
  const files = auditFiles(path.join(root, 'store'));
  const file = files[0];
  const backup = fs.readFileSync(file, 'utf8');
  const lines = backup.split(/\r?\n/).filter(Boolean);
  const tampered = JSON.parse(lines[1]);
  tampered.outcome = 'approved';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const verifyBad = rt.auditVerify();
  add('篡改后校验失败', verifyBad.ok && verifyBad.data.ok === false && verifyBad.data.issues.length > 0, verifyBad.data?.issues?.[0]);
  fs.writeFileSync(file, backup);
  add('恢复原文后校验再次通过', rt.auditVerify().data.ok === true, 'ok');

  /* 5. 运行健康包含审计状态 */
  const health = rt.health().data;
  add('health 暴露审计链状态', health.audit?.ok === true && health.audit.lastSeq >= records.length, JSON.stringify(health.audit));

  /* 6. 重启续链与恢复审计 */
  const crashTask = rt.createTask({ title: '崩溃审计', idempotencyKey: 'audit-crash' }).data;
  rt.beginStep({ runId: crashTask.run.id, kind: 'model' });
  const beforeSeq = rt.auditRead({ limit: 1000 }).data.records.at(-1).seq;
  rt.close();

  rt = makeRuntime(path.join(root, 'store'), workspace);
  const after = rt.auditRead({ limit: 2000 }).data.records;
  add('重启后审计序号继续递增', after[0].seq === 1 && after.at(-1).seq > beforeSeq, `${beforeSeq} -> ${after.at(-1).seq}`);
  add('重启后哈希链仍完整', rt.auditVerify().data.ok === true, JSON.stringify(rt.auditVerify().data));
  add('恢复流程写入 runtime.recovered', after.some((r) => r.action === 'runtime.recovered' && r.outcome === 'interrupted'), after.filter((r) => r.action === 'runtime.recovered').length);
  add('恢复后任务仍可读取', rt.getTask(crashTask.task.id).data.task.status === 'failed', rt.getTask(crashTask.task.id).data.task.status);

  rt.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }

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
