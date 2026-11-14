'use strict';

/* Runtime 编排自检：Task/Run/Step/ModelCall 持久化、Policy 审批流、Tool Executor、崩溃恢复。
   运行：node tools/runtime-orchestrator-check.js */

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

function readAll(rt) {
  return rt.read({ afterSeq: 0, limit: 5000 }).events;
}

(async () => {
  const root = tempDir('orch');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.env'), 'TOKEN=secret-value\n', 'utf8');

  let rt = makeRuntime(path.join(root, 'store'), workspace);

  /* 0. 默认 Agent 与 Provider */
  const agents = rt.listAgents();
  add('初始化默认 Agent', agents.ok && agents.data.agents.length === 1 && /^agt_/.test(agents.data.defaultAgentId), agents.data?.defaultAgentId);
  const defaultAgentId = agents.data.defaultAgentId;
  const agentDetail = rt.getAgent(defaultAgentId);
  add('默认 Agent 有版本配置', agentDetail.ok && agentDetail.data.currentVersion?.version === 1 && agentDetail.data.currentVersion.permissionProfileId === 'full', JSON.stringify(agentDetail.data?.currentVersion?.permissionProfileId));
  const newVersion = rt.createAgentVersion({ agentId: defaultAgentId, patch: { permissionProfileId: 'ask', systemPrompt: '测试' } });
  add('修改 Agent 生成新版本', newVersion.ok && newVersion.data.version.version === 2 && rt.getAgent(defaultAgentId).data.agent.currentVersion === 2, newVersion.data?.version?.version);

  /* 1. 任务与运行 */
  const created = rt.createTask({
    title: '测试任务',
    input: '把结果写进文件',
    providerId: 'http://127.0.0.1:9999/v1',
    model: 'test-model',
    idempotencyKey: 'turn-1',
  });
  add('createTask 返回 Result 包装', created.ok === true, created.ok ? '' : created.error?.message);
  const { task, run } = created.data;
  add('任务进入 running', task.status === 'running', task.status);
  add('运行进入 running', run.status === 'running', run.status);
  add('任务绑定默认 Agent 与版本 2', task.agentId === defaultAgentId && task.agentVersion === 2, `${task.agentId}@${task.agentVersion}`);
  add('providerId 被哈希而非保存 URL', /^prov_[0-9a-f]{16}$/.test(run.providerId || ''), run.providerId);
  add('Provider 元数据已登记', rt.listProviders().ok && rt.listProviders().data.providers.some((p) => p.id === run.providerId), JSON.stringify(rt.listProviders().data?.providers));

  let events = readAll(rt);
  add('记录 task.created/queued/started', ['task.created', 'task.queued', 'task.started'].every((t) => events.some((e) => e.type === t)), events.map((e) => e.type).join(','));
  add('记录 run.started 且携带 runId', events.some((e) => e.type === 'run.started' && e.runId === run.id), 'ok');

  const dup = rt.createTask({ title: '重复', idempotencyKey: 'turn-1' });
  add('相同幂等键复用任务', dup.ok && dup.data.task.id === task.id && dup.data.deduped, dup.data?.task?.id);

  /* 2. 步骤与模型调用 */
  const stepR = rt.beginStep({ runId: run.id, kind: 'model' });
  const step = stepR.data.step;
  add('beginStep 返回 running 步骤', stepR.ok && step.status === 'running', step.status);
  const mcR = rt.modelStart({
    runId: run.id, stepId: step.id, providerId: run.providerId, model: 'test-model',
    messageCount: 3, approxInputTokens: 120, meta: [{ role: 'user', chars: 10 }],
  });
  add('modelStart 创建 ModelCall', mcR.ok && /^mcall_/.test(mcR.data.modelCallId), mcR.data?.modelCallId);
  const mcId = mcR.data.modelCallId;
  const mfR = rt.modelFinish({ modelCallId: mcId, status: 'completed', usage: { prompt_tokens: 100, completion_tokens: 30 }, finishReason: 'stop' });
  add('modelFinish 记录 usage', mfR.ok && mfR.data.modelCall.usage.completion_tokens === 30, JSON.stringify(mfR.data?.modelCall?.usage));
  const fsR = rt.finishStep({ stepId: step.id, status: 'succeeded', modelCallId: mcId });
  add('finishStep 进入终态', fsR.ok && fsR.data.step.status === 'succeeded', fsR.data?.step?.status);
  add('运行 usage 累加 token', rt.getRun(run.id).data.run.usage.inputTokens === 100 && rt.getRun(run.id).data.run.usage.outputTokens === 30, JSON.stringify(rt.getRun(run.id).data.run.usage));

  /* 3. full 模式读工具直接放行 */
  let toolStep = rt.beginStep({ runId: run.id, kind: 'tool_call' }).data.step;
  const readProposal = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'list_dir', args: { path: '.' }, profile: 'full' });
  add('full 模式读工具 ready', readProposal.ok && readProposal.data.status === 'ready', readProposal.data?.status || readProposal.error?.message);
  const readExec = await rt.executeTool({ toolCallId: readProposal.data.toolCallId, profile: 'full', workspace });
  add('executeTool 读到工作区内容', readExec.ok && readExec.data.ok && readExec.data.content.includes('.env'), readExec.data?.content?.slice(0, 60));
  rt.finishStep({ stepId: toolStep.id, status: 'succeeded' });
  const cached = await rt.executeTool({ toolCallId: readProposal.data.toolCallId, profile: 'full', workspace });
  add('重复执行返回缓存结果', cached.ok && cached.data.cached === true, cached.data?.cached);

  /* 4. ask 模式写工具审批一次 */
  toolStep = rt.beginStep({ runId: run.id, kind: 'tool_call' }).data.step;
  const writeProposal = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'write_file', args: { path: 'out.txt', content: 'hello runtime' }, profile: 'ask' });
  add('ask 模式写工具进入待审批', writeProposal.ok && writeProposal.data.status === 'waiting_approval', writeProposal.data?.status);
  const approval = writeProposal.data.approval;
  add('审批单绑定 actionHash', /^sha256:[0-9a-f]{64}$/.test(approval.actionHash), approval.actionHash);
  add('等待审批时运行状态为 waiting_approval', rt.getRun(run.id).data.run.status === 'waiting_approval', rt.getRun(run.id).data.run.status);
  const deniedBefore = await rt.executeTool({ toolCallId: writeProposal.data.toolCallId, profile: 'ask', workspace });
  add('未审批不能执行', deniedBefore.ok && deniedBefore.data.ok === false && deniedBefore.data.code === 'APPROVAL_REQUIRED', deniedBefore.data?.code);

  const decideR = rt.decideApproval({ approvalId: approval.id, decision: 'approved', scope: 'once', reason: '测试批准' });
  add('批准后审批单为 approved', decideR.ok && decideR.data.approval.status === 'approved', decideR.data?.approval?.status);
  add('批准后运行恢复 running', rt.getRun(run.id).data.run.status === 'running', rt.getRun(run.id).data.run.status);
  const writeExec = await rt.executeTool({ toolCallId: writeProposal.data.toolCallId, approvalId: approval.id, profile: 'ask', workspace });
  add('批准后写文件成功', writeExec.ok && writeExec.data.ok && fs.readFileSync(path.join(workspace, 'out.txt'), 'utf8') === 'hello runtime', writeExec.data?.error || 'ok');
  rt.finishStep({ stepId: toolStep.id, status: 'succeeded' });
  events = readAll(rt);
  add('写入产出 artifact.created', events.some((e) => e.type === 'artifact.created' && e.runId === run.id), 'ok');
  const seqApproval = events.find((e) => e.type === 'approval.decided')?.seq || 0;
  const seqStarted = events.find((e) => e.type === 'tool.started' && e.payload?.toolCallId === writeProposal.data.toolCallId)?.seq || 0;
  add('EVT-3：tool.started 在 approval.decided 之后', seqStarted > seqApproval, `${seqApproval} -> ${seqStarted}`);

  /* 5. run 作用域授权：相同动作自动放行 */
  toolStep = rt.beginStep({ runId: run.id, kind: 'tool_call' }).data.step;
  const grantProposal = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'write_file', args: { path: 'out2.txt', content: 'granted' }, profile: 'ask' });
  add('新动作同样需要审批', grantProposal.data?.status === 'waiting_approval', grantProposal.data?.status);
  rt.decideApproval({ approvalId: grantProposal.data.approval.id, decision: 'approved', scope: 'run', reason: '本 Run 允许' });
  const grantExec = await rt.executeTool({ toolCallId: grantProposal.data.toolCallId, approvalId: grantProposal.data.approval.id, profile: 'ask', workspace });
  add('run 作用域批准后可执行', grantExec.data?.ok === true, grantExec.data?.error || 'ok');
  rt.finishStep({ stepId: toolStep.id, status: 'succeeded' });

  toolStep = rt.beginStep({ runId: run.id, kind: 'tool_call' }).data.step;
  const again = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'write_file', args: { path: 'out2.txt', content: 'granted' }, profile: 'ask' });
  add('run 作用域授权后相同动作直接放行', again.ok && again.data.status === 'ready' && again.data.policy.ruleIds.includes('approval-grant'), again.data?.status);
  rt.finishStep({ stepId: toolStep.id, status: 'skipped' });

  /* 6. 拒绝与硬拒绝 */
  toolStep = rt.beginStep({ runId: run.id, kind: 'tool_call' }).data.step;
  const denyProposal = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'run_command', args: { command: 'echo hi' }, profile: 'ask' });
  add('ask 模式命令进入待审批', denyProposal.data?.status === 'waiting_approval', denyProposal.data?.status);
  rt.decideApproval({ approvalId: denyProposal.data.approval.id, decision: 'denied', reason: '测试拒绝' });
  const deniedExec = await rt.executeTool({ toolCallId: denyProposal.data.toolCallId, profile: 'ask', workspace });
  add('拒绝后不会执行', deniedExec.ok && deniedExec.data.ok === false && deniedExec.data.code === 'DENIED', deniedExec.data?.code);
  rt.finishStep({ stepId: toolStep.id, status: 'canceled' });

  toolStep = rt.beginStep({ runId: run.id, kind: 'tool_call' }).data.step;
  const hard = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'run_command', args: { command: 'format C:' }, profile: 'full' });
  add('硬拒绝命令在 full 下也拒绝', hard.ok && hard.data.status === 'denied' && hard.data.policy.ruleIds.includes('hard-deny-command'), hard.data?.policy?.ruleIds?.join(','));
  rt.finishStep({ stepId: toolStep.id, status: 'canceled' });

  toolStep = rt.beginStep({ runId: run.id, kind: 'tool_call' }).data.step;
  const outside = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'write_file', args: { path: 'C:\\dsh-outside.txt', content: 'x' }, profile: 'full' });
  add('工作区外写入被拒绝', outside.data?.status === 'denied' && outside.data.policy.ruleIds.includes('workspace-boundary'), outside.data?.policy?.ruleIds?.join(','));
  rt.finishStep({ stepId: toolStep.id, status: 'canceled' });

  toolStep = rt.beginStep({ runId: run.id, kind: 'tool_call' }).data.step;
  const ro = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'write_file', args: { path: 'ro.txt', content: 'x' }, profile: 'readonly' });
  add('只读模式写入被拒绝', ro.data?.status === 'denied' && ro.data.policy.ruleIds.includes('readonly-deny'), ro.data?.policy?.ruleIds?.join(','));
  rt.finishStep({ stepId: toolStep.id, status: 'canceled' });

  toolStep = rt.beginStep({ runId: run.id, kind: 'tool_call' }).data.step;
  const badArgs = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'write_file', args: { path: 'a.txt' }, profile: 'full' });
  add('缺少必填参数被拒绝', badArgs.data?.status === 'denied' && badArgs.data.policy.ruleIds.includes('invalid-args'), badArgs.data?.policy?.ruleIds?.join(','));
  rt.finishStep({ stepId: toolStep.id, status: 'canceled' });

  toolStep = rt.beginStep({ runId: run.id, kind: 'tool_call' }).data.step;
  const unknownTool = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'rm_rf', args: {}, profile: 'full' });
  add('未注册工具被拒绝', unknownTool.data?.status === 'denied' && unknownTool.data.policy.ruleIds.includes('unknown-tool'), unknownTool.data?.policy?.ruleIds?.join(','));
  rt.finishStep({ stepId: toolStep.id, status: 'canceled' });

  /* 7. 敏感读取后的联网组合 */
  toolStep = rt.beginStep({ runId: run.id, kind: 'tool_call' }).data.step;
  const secretRead = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'read_file', args: { path: '.env' }, profile: 'full' });
  const secretExec = await rt.executeTool({ toolCallId: secretRead.data.toolCallId, profile: 'full', workspace });
  add('读取 .env 成功并标记敏感', secretExec.data?.ok === true && rt.getRun(run.id).data.run.sensitiveRead === true, String(rt.getRun(run.id).data.run.sensitiveRead));
  const exfil = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'fetch_url', args: { url: 'https://example.com/collect' }, profile: 'readonly' });
  add('敏感读取后只读模式禁止联网', exfil.data?.status === 'denied' && exfil.data.policy.ruleIds.includes('exfil-combination'), exfil.data?.policy?.ruleIds?.join(','));
  const exfilAsk = rt.proposeTool({ runId: run.id, stepId: toolStep.id, name: 'fetch_url', args: { url: 'https://example.com/collect' }, profile: 'ask' });
  add('敏感读取后 ask 模式要求审批', exfilAsk.data?.status === 'waiting_approval' && exfilAsk.data.policy.ruleIds.includes('exfil-combination'), exfilAsk.data?.status);
  rt.finishStep({ stepId: toolStep.id, status: 'canceled' });
  // 取消仍挂着的审批
  for (const a of rt.listApprovals({ runId: run.id, status: 'pending' }).data.approvals) {
    rt.decideApproval({ approvalId: a.id, decision: 'denied', reason: '测试清理' });
  }

  /* 7.5 Agent 权限分层：Agent 只能收紧用户权限 */
  const allToolNames = localTools.TOOL_SPECS.map((s) => s.function.name);
  rt.createAgentVersion({ agentId: defaultAgentId, patch: { permissionProfileId: 'readonly' } });
  const roAgentTask = rt.createTask({ title: '只读 Agent', idempotencyKey: 'turn-agent-ro' }).data;
  const roAgentStep = rt.beginStep({ runId: roAgentTask.run.id, kind: 'tool_call' }).data.step;
  const roAgentProposal = rt.proposeTool({ runId: roAgentTask.run.id, stepId: roAgentStep.id, name: 'write_file', args: { path: 'agent.txt', content: 'x' }, profile: 'full' });
  add('Agent 只读配置收紧用户 full 权限', roAgentProposal.data?.status === 'denied' && roAgentProposal.data.policy.ruleIds.includes('readonly-deny'), roAgentProposal.data?.policy?.ruleIds?.join(','));
  rt.finishStep({ stepId: roAgentStep.id, status: 'canceled' });
  rt.cancelTask({ taskId: roAgentTask.task.id, reason: '测试结束' });

  rt.createAgentVersion({ agentId: defaultAgentId, patch: { permissionProfileId: 'full', toolPolicy: { allow: allToolNames, deny: ['write_file'] } } });
  const denyToolTask = rt.createTask({ title: '工具黑名单', idempotencyKey: 'turn-agent-deny' }).data;
  const denyToolStep = rt.beginStep({ runId: denyToolTask.run.id, kind: 'tool_call' }).data.step;
  const denyToolProposal = rt.proposeTool({ runId: denyToolTask.run.id, stepId: denyToolStep.id, name: 'write_file', args: { path: 'agent.txt', content: 'x' }, profile: 'full' });
  add('Agent 工具黑名单阻止执行', denyToolProposal.data?.status === 'denied' && denyToolProposal.data.policy.ruleIds.includes('agent-tool-policy'), denyToolProposal.data?.status);
  rt.finishStep({ stepId: denyToolStep.id, status: 'canceled' });
  rt.cancelTask({ taskId: denyToolTask.task.id, reason: '测试结束' });
  rt.createAgentVersion({ agentId: defaultAgentId, patch: { permissionProfileId: 'full', toolPolicy: { allow: allToolNames, deny: [] } } });

  /* 8. 正常收尾 */
  const finishR = rt.finishRun({ runId: run.id, outcome: 'succeeded', summary: '完成', validated: true });
  add('finishRun 收尾 Run/Task', finishR.ok && finishR.data.run.status === 'succeeded' && finishR.data.task.status === 'succeeded', JSON.stringify({ run: finishR.data?.run?.status, task: finishR.data?.task?.status }));
  events = readAll(rt);
  add('收尾写入 validation/run.finished/task.finished', ['validation.completed', 'run.finished', 'task.finished'].every((t) => events.some((e) => e.type === t)), 'ok');
  const detail = rt.getTask(task.id);
  add('getTask 返回运行与步骤详情', detail.ok && detail.data.runs.length === 1 && detail.data.details[0].toolCalls.length >= 9, detail.data?.details?.[0]?.toolCalls?.length);
  const list = rt.listTasks({ limit: 10 });
  add('listTasks 返回任务', list.ok && list.data.tasks.some((t) => t.id === task.id), list.data?.tasks?.length);
  add('事件链无缺口', rt.store.verify().ok, JSON.stringify(rt.store.verify()));

  /* 9. 取消任务（新建第二个任务） */
  const cancelTask = rt.createTask({ title: '取消测试', idempotencyKey: 'turn-2' }).data;
  const cStep = rt.beginStep({ runId: cancelTask.run.id, kind: 'tool_call' }).data.step;
  const cProposal = rt.proposeTool({ runId: cancelTask.run.id, stepId: cStep.id, name: 'write_file', args: { path: 'c.txt', content: 'x' }, profile: 'ask' });
  add('第二个任务进入待审批', cProposal.data?.status === 'waiting_approval', cProposal.data?.status);
  const canceled = rt.cancelTask({ taskId: cancelTask.task.id, reason: '用户取消' });
  add('cancelTask 标记任务取消', canceled.ok && canceled.data.task.status === 'canceled', canceled.data?.task?.status);
  const canceledApproval = rt.listApprovals({ runId: cancelTask.run.id }).data.approvals[0];
  add('取消任务同时取消待审批', canceledApproval.subject?.status === 'canceled' || canceledApproval.status === 'canceled', canceledApproval.status);
  add('取消后运行进入 canceled', rt.getRun(cancelTask.run.id).data.run.status === 'canceled', rt.getRun(cancelTask.run.id).data.run.status);

  /* 10. 崩溃恢复 */
  const crashTask = rt.createTask({ title: '崩溃恢复', idempotencyKey: 'turn-3' }).data;
  rt.beginStep({ runId: crashTask.run.id, kind: 'model' });
  const beforeSeq = rt.read({ afterSeq: 0, limit: 1 }).events[0]?.seq || 1;
  rt.close();

  const rt2 = makeRuntime(path.join(root, 'store'), workspace);
  const recovered = rt2.getRun(crashTask.run.id).data.run;
  add('重启后未完成运行标记 interrupted', recovered.status === 'interrupted', recovered.status);
  const recoveredTask = rt2.getTask(crashTask.task.id).data.task;
  add('重启后任务标记 failed(RUNTIME_RESTART)', recoveredTask.status === 'failed', recoveredTask.status);
  const tail = rt2.read({ afterSeq: beforeSeq, limit: 5000 }).events;
  add('恢复写入 run.interrupted 与 task.finished', tail.some((e) => e.type === 'run.interrupted') && tail.some((e) => e.type === 'task.finished' && e.payload?.errorCode === 'RUNTIME_RESTART'), tail.map((e) => e.type).join(','));
  add('旧任务仍在历史中', rt2.listTasks({ limit: 10 }).data.tasks.some((t) => t.id === task.id), 'ok');
  add('重启后事件链仍无缺口', rt2.store.verify().ok, JSON.stringify(rt2.store.verify()));

  rt2.close();
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
