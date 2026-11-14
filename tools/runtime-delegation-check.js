'use strict';

/* Phase 5 委派自检：约束、权限收窄、预算、去重、级联取消、Trace 与结果验证。
   运行：node tools/runtime-delegation-check.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtimeModule = require('../runtime');
const localTools = require('../lib/tools');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`));
}

const PROVIDER = { baseUrl: 'http://mock.local/v1', key: 'test-key', model: 'mock-model' };

function makeRuntime(dir, workspace, modelHandler) {
  const rt = runtimeModule.createRuntime({
    dir,
    workspacePath: workspace,
    executeTool: (name, args, opts) => localTools.executeTool(name, args, opts),
    modelRequest: (ctx) => modelHandler(ctx),
  });
  rt.init();
  return rt;
}

function textReply(content, usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }) {
  return { content, toolCalls: [], usage, finishReason: 'stop' };
}

function toolReply(name, args, usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }) {
  return {
    content: '',
    toolCalls: [{
      id: 'call_child_' + Math.random().toString(36).slice(2, 8),
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
    usage,
    finishReason: 'tool_calls',
  };
}

function proposeDelegation(rt, runId, args, profile = 'full') {
  const step = rt.beginStep({ runId, kind: 'tool_call' }).data.step;
  const proposal = rt.proposeTool({ runId, stepId: step.id, name: 'delegate_task', args, profile });
  return { step, proposal };
}

function approveIfNeeded(rt, proposal) {
  if (proposal?.data?.status !== 'waiting_approval') return false;
  rt.decideApproval({
    approvalId: proposal.data.approval.id,
    decision: 'approved',
    scope: 'once',
    reason: '测试批准',
  });
  return true;
}

(async () => {
  const root = tempDir('delegation');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace, { recursive: true });

  let modelHandler = async () => textReply('默认回复');
  const rt = makeRuntime(path.join(root, 'store'), workspace, (ctx) => modelHandler(ctx));
  const defaultAgentId = rt.listAgents().data.defaultAgentId;

  /* 1. Agent 管理 */
  const target = rt.createAgent({
    name: '研究助手',
    systemPrompt: '你是研究助手，擅长阅读与整理。',
    permissionProfileId: 'full',
  });
  add('可创建子 Agent', target.ok && /^agt_/.test(target.data.agent.id) && target.data.version.permissionProfileId === 'full', target.data?.agent?.id || target.error?.message);
  const allAgents = rt.listAgents();
  add('Agent 列表包含可委派目标', allAgents.ok && allAgents.data.agents.length === 2, allAgents.data?.agents?.length);
  const dupName = rt.createAgent({ name: '研究助手' });
  add('Agent 重名被拒绝', dupName.ok === false, dupName.error?.message);
  const cannotArchiveDefault = rt.archiveAgent(defaultAgentId);
  add('默认 Agent 不能归档', cannotArchiveDefault.ok === false, cannotArchiveDefault.error?.message);

  const reader = rt.createAgent({ name: '只读审阅', permissionProfileId: 'readonly' });
  add('可创建只读 Agent', reader.ok && reader.data.version.permissionProfileId === 'readonly', reader.data?.version?.permissionProfileId);

  /* 2. 成功委派：父 full → 子 full，子写文件并回传摘要 */
  let parent = rt.createTask({
    title: '父任务',
    input: '委派研究',
    providerId: PROVIDER.baseUrl,
    model: PROVIDER.model,
    idempotencyKey: 'dele-parent-1',
  }).data;
  const parentStep = rt.beginStep({ runId: parent.run.id, kind: 'model' }).data.step;
  rt.finishStep({ stepId: parentStep.id, status: 'succeeded' });

  let childTurn = 0;
  modelHandler = async () => {
    childTurn++;
    if (childTurn === 1) return toolReply('write_file', { path: 'child.txt', content: 'from child agent' });
    return textReply('子任务完成：已写入 child.txt。');
  };

  const d1 = proposeDelegation(rt, parent.run.id, {
    agentId: target.data.agent.id,
    objective: '在工作区写入 child.txt，内容为 from child agent。',
    expectedOutput: '文件存在且内容正确，返回写入结果。',
  });
  add('委派工具在 full 档仍需审批', d1.proposal.data?.status === 'waiting_approval' && d1.proposal.data.policy.ruleIds.includes('delegation-approval'), d1.proposal.data?.status);
  approveIfNeeded(rt, d1.proposal);
  const exec1 = await rt.executeTool({ toolCallId: d1.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('委派执行返回成功', exec1.ok && exec1.data.ok === true, JSON.stringify(exec1.data?.code || exec1.data?.status));
  add('父工具结果包含子任务摘要', exec1.ok && /子任务完成/.test(exec1.data.content), exec1.data?.content?.slice(0, 80));
  add('子任务真实产出文件', fs.existsSync(path.join(workspace, 'child.txt')), fs.existsSync(path.join(workspace, 'child.txt')) ? 'ok' : 'missing');

  const del1 = rt.listDelegations({ parentRunId: parent.run.id }).data.delegations[0];
  add('委派记录关联父子任务', !!del1 && del1.parentRunId === parent.run.id && !!del1.childTaskId && del1.status === 'succeeded', del1?.status);
  const childDetail = rt.getTask(del1.childTaskId).data;
  add('子任务建立 parent/root/depth', childDetail.task.parentTaskId === parent.task.id
    && childDetail.task.rootTaskId === parent.task.id && childDetail.task.delegationDepth === 1, JSON.stringify({ p: childDetail.task.parentTaskId, r: childDetail.task.rootTaskId, d: childDetail.task.delegationDepth }));
  add('子 Run 使用目标 Agent 与收窄范围', childDetail.runs[0].agentId === target.data.agent.id
    && Array.isArray(childDetail.runs[0].delegationToolAllow) && childDetail.runs[0].delegationToolAllow.includes('write_file'), JSON.stringify({ agent: childDetail.runs[0].agentId, allow: childDetail.runs[0].delegationToolAllow?.length }));
  add('子运行事件链完整', ['delegation.requested', 'delegation.started', 'delegation.finished', 'validation.completed', 'run.finished'].every((t) => rt.read({ afterSeq: 0, limit: 5000 }).events.some((e) => e.type === t)), 'ok');

  /* 3. 去重：同 objective + 同 Agent 10 分钟内复用（父 Run 仍运行） */
  const beforeTasks = rt.listTasks({ limit: 100 }).data.tasks.length;
  const d2 = proposeDelegation(rt, parent.run.id, {
    agentId: target.data.agent.id,
    objective: '在工作区写入 child.txt，内容为 from child agent。',
    expectedOutput: '文件存在且内容正确，返回写入结果。',
  });
  approveIfNeeded(rt, d2.proposal);
  const exec2 = await rt.executeTool({ toolCallId: d2.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  const afterTasks = rt.listTasks({ limit: 100 }).data.tasks.length;
  add('重复委派复用已有子任务', exec2.ok && afterTasks === beforeTasks, `tasks ${beforeTasks} -> ${afterTasks}`);
  add('重复委派返回原摘要', /子任务完成/.test(exec2.data?.content || ''), exec2.data?.content?.slice(0, 60));

  const parentFinish = rt.finishRun({ runId: parent.run.id, outcome: 'succeeded', summary: '父任务完成' });
  add('父 Run 完成后置校验包含委派项', parentFinish.ok && parentFinish.data.validation.checks.some((c) => c.name.startsWith('delegation:') && c.status === 'passed'), JSON.stringify(parentFinish.data?.validation));
  add('父任务成功', parentFinish.data.task.status === 'succeeded', parentFinish.data?.task?.status);

  const graph = rt.runGraph({ runId: parent.run.id });
  add('父 Run Graph 含委派节点', graph.ok && graph.data.graph.nodes.some((n) => n.kind === 'delegation' && n.status === 'succeeded'), graph.data?.graph?.nodes?.map((n) => n.kind).join(','));
  const childGraph = rt.runGraph({ runId: childDetail.runs[0].id });
  add('子 Run Graph 可下钻', childGraph.ok && childGraph.data.graph.nodes.some((n) => n.kind === 'tool'), childGraph.data?.graph?.nodes?.length);
  const audit = rt.auditRead({ limit: 500 });
  add('审计链含委派记录', audit.ok && audit.data.records.some((r) => r.action === 'delegation.requested') && audit.data.records.some((r) => r.action === 'delegation.finished'), 'ok');

  /* 3b. 子 Agent 自选模型与凭据继承：创建带 model.model/provider 的 Agent，委派后子模型调用应使用自选模型 */
  const chosenAgent = rt.createAgent({
    name: '自选模型助手',
    permissionProfileId: 'full',
    model: { providerId: PROVIDER.baseUrl, model: 'chosen-model' },
    provider: { baseUrl: PROVIDER.baseUrl, key: 'profile-key' },
  });
  add('Agent 创建可将 baseUrl 派生为 providerId', chosenAgent.ok && /^prov_/.test(chosenAgent.data.version.model.providerId), chosenAgent.data?.version?.model?.providerId);
  add('Agent 创建注册 provider 配置', rt.listProviders().data.providers.some((p) => p.id === chosenAgent.data.version.model.providerId), 'ok');

  parent = rt.createTask({ title: '父任务自选模型', input: '委派自选', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-model' }).data;
  childTurn = 0;
  modelHandler = async (ctx) => {
    childTurn++;
    if (ctx?.cfg?.model === 'chosen-model') return textReply('子任务完成：使用了自选模型。');
    return textReply('子任务完成：错误，使用了父模型。');
  };
  const dModel = proposeDelegation(rt, parent.run.id, {
    agentId: chosenAgent.data.agent.id,
    objective: '验证子 Agent 使用自选模型。',
    expectedOutput: '返回自选模型确认。',
  });
  approveIfNeeded(rt, dModel.proposal);
  const execModel = await rt.executeTool({ toolCallId: dModel.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('子模型调用使用 Agent 自选模型', /自选模型/.test(execModel.data?.content || ''), execModel.data?.content?.slice(0, 60));
  const delModel = rt.listDelegations({ parentRunId: parent.run.id }).data.delegations.find((d) => d.targetAgentId === chosenAgent.data.agent.id);
  add('子任务记录自选模型名', delModel?.model === 'chosen-model', delModel?.model);

  /* 3c. 无自选模型的 Agent 回退父模型 */
  const plainAgent = rt.createAgent({ name: '默认模型助手', permissionProfileId: 'full' });
  parent = rt.createTask({ title: '父任务默认模型', input: '委派默认', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-plain' }).data;
  childTurn = 0;
  modelHandler = async (ctx) => {
    childTurn++;
    if (ctx?.cfg?.model === PROVIDER.model) return textReply('子任务完成：继承了父模型。');
    return textReply('子任务完成：错误，模型为 ' + String(ctx?.cfg?.model));
  };
  const dPlain = proposeDelegation(rt, parent.run.id, {
    agentId: plainAgent.data.agent.id,
    objective: '验证子 Agent 回退父模型。',
    expectedOutput: '返回父模型确认。',
  });
  approveIfNeeded(rt, dPlain.proposal);
  const execPlain = await rt.executeTool({ toolCallId: dPlain.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('无自选模型的子 Agent 回退父模型', /父模型/.test(execPlain.data?.content || ''), execPlain.data?.content?.slice(0, 60));

  /* 4. 权限收窄：只读目标不能写 */
  parent = rt.createTask({ title: '父任务只读子', input: '审阅', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-2' }).data;
  childTurn = 0;
  modelHandler = async () => {
    childTurn++;
    if (childTurn === 1) return toolReply('write_file', { path: 'should-not-exist.txt', content: 'x' });
    return textReply('无法写入：子 Agent 为只读权限。');
  };
  const d3 = proposeDelegation(rt, parent.run.id, {
    agentId: reader.data.agent.id,
    objective: '尝试写入 should-not-exist.txt。',
    expectedOutput: '报告是否写入成功。',
  });
  approveIfNeeded(rt, d3.proposal);
  const exec3 = await rt.executeTool({ toolCallId: d3.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('只读子 Agent 委派完成', exec3.ok && exec3.data.ok === true, exec3.data?.code || exec3.data?.status);
  add('只读子 Agent 无法写入文件', !fs.existsSync(path.join(workspace, 'should-not-exist.txt')), 'file absent');
  const del3 = rt.listDelegations({ parentRunId: parent.run.id }).data.delegations[0];
  add('子委派记录权限被收窄为 readonly', del3?.effectiveProfile === 'readonly', del3?.effectiveProfile);
  const child3 = rt.getTask(del3.childTaskId).data;
  const writeCall = child3.details.flatMap((d) => d.toolCalls).find((c) => c.name === 'write_file');
  add('子工具调用被策略拒绝', writeCall?.status === 'denied', writeCall?.status);
  rt.finishRun({ runId: parent.run.id, outcome: 'succeeded' });

  /* 5. 环与深度 */
  parent = rt.createTask({ title: '环测试', input: 'loop', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-3' }).data;
  const loopProposal = proposeDelegation(rt, parent.run.id, {
    agentId: defaultAgentId,
    objective: '委派回父 Agent。',
    expectedOutput: '不应被允许。',
  });
  approveIfNeeded(rt, loopProposal.proposal);
  const loopExec = await rt.executeTool({ toolCallId: loopProposal.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('禁止委派给祖先 Agent（环）', loopExec.ok && loopExec.data.ok === false && loopExec.data.code === 'AGENT_LOOP', loopExec.data?.code);
  rt.finishRun({ runId: parent.run.id, outcome: 'failed', errorCode: 'TEST' });

  const deep = rt.stateStore.createTask({
    title: '深层父任务',
    input: 'deep',
    agentId: defaultAgentId,
    providerId: PROVIDER.baseUrl,
    model: PROVIDER.model,
    delegationDepth: 2,
    idempotencyKey: 'dele-parent-deep',
  });
  const deepStep = rt.beginStep({ runId: deep.run.id, kind: 'tool_call' }).data.step;
  const deepProposal = rt.proposeTool({
    runId: deep.run.id, stepId: deepStep.id, name: 'delegate_task', profile: 'full',
    args: { agentId: target.data.agent.id, objective: '再委派一层。', expectedOutput: '不应被允许。' },
  });
  approveIfNeeded(rt, deepProposal);
  const deepExec = await rt.executeTool({ toolCallId: deepProposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('禁止超过最大委派深度 2', deepExec.ok && deepExec.data.ok === false && deepExec.data.code === 'DEPTH_EXCEEDED', deepExec.data?.code);
  rt.finishRun({ runId: deep.run.id, outcome: 'failed', errorCode: 'TEST' });

  /* 6. 预算耗尽与父级校验失败 */
  parent = rt.createTask({
    title: '预算测试', input: 'budget', providerId: PROVIDER.baseUrl, model: PROVIDER.model,
    idempotencyKey: 'dele-parent-4', budget: { maxModelCalls: 10, maxTokens: 100000, maxWallClockMs: 60000 },
  }).data;
  modelHandler = async () => textReply('预算测试回复', { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
  const dBudget = proposeDelegation(rt, parent.run.id, {
    agentId: target.data.agent.id,
    objective: '消耗预算。',
    expectedOutput: '返回摘要。',
    budget: { maxTokens: 1 },
  });
  approveIfNeeded(rt, dBudget.proposal);
  const budgetExec = await rt.executeTool({ toolCallId: dBudget.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('子预算耗尽时委派失败', budgetExec.ok && budgetExec.data.ok === false && budgetExec.data.code === 'BUDGET_EXCEEDED', budgetExec.data?.code);
  const budgetFinish = rt.finishRun({ runId: parent.run.id, outcome: 'succeeded', summary: '父任务仍尝试成功' });
  add('子委派失败使父级后置校验失败', budgetFinish.ok && budgetFinish.data.validation.status === 'failed' && budgetFinish.data.errorCode === 'VALIDATION_FAILED', budgetFinish.data?.validation?.status);
  add('子委派失败使父任务失败', budgetFinish.data.task.status === 'failed', budgetFinish.data?.task?.status);

  /* 7. 级联取消 */
  parent = rt.createTask({ title: '取消测试', input: 'cancel', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-5' }).data;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  modelHandler = async () => { await gate; return textReply('迟到的子任务结果'); };
  const dCancel = proposeDelegation(rt, parent.run.id, {
    agentId: target.data.agent.id,
    objective: '一直等待直到被取消。',
    expectedOutput: '不应完成。',
  });
  approveIfNeeded(rt, dCancel.proposal);
  const pendingExec = rt.executeTool({ toolCallId: dCancel.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  for (let i = 0; i < 50; i++) {
    const ds = rt.listDelegations({ parentRunId: parent.run.id }).data.delegations;
    if (ds[0]?.status === 'running') break;
    await sleep(20);
  }
  rt.cancelTask({ taskId: parent.task.id, reason: '用户取消父任务' });
  release();
  const cancelExec = await pendingExec;
  const canceledDel = rt.listDelegations({ parentRunId: parent.run.id }).data.delegations[0];
  const canceledChild = rt.getTask(canceledDel.childTaskId).data;
  add('父任务取消级联取消子任务', canceledChild.task.status === 'canceled', canceledChild.task.status);
  add('父任务取消级联取消委派记录', canceledDel.status === 'canceled' && canceledDel.errorCode, `${canceledDel.status}/${canceledDel.errorCode}`);
  add('取消时执行中的委派工具收尾为取消', cancelExec.ok && cancelExec.data.ok === false && cancelExec.data.status === 'canceled', cancelExec.data?.status);

  /* 8. 并发/总量/容量约束（注入记录） */
  parent = rt.createTask({ title: '限制测试', input: 'limits', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-6' }).data;
  for (let i = 0; i < 5; i++) {
    const seeded = rt.stateStore.createDelegationRecord({
      parentTaskId: parent.task.id, parentRunId: parent.run.id, parentAgentId: parent.run.agentId,
      targetAgentId: target.data.agent.id, targetAgentVersion: 1,
      childTaskId: 'task_fake_' + i, childRunId: 'run_fake_' + i,
      objective: '占位 ' + i, expectedOutput: 'x',
    });
    rt.stateStore.updateDelegation(seeded.id, { status: 'succeeded' });
  }
  const limitProposal = proposeDelegation(rt, parent.run.id, { agentId: target.data.agent.id, objective: '第 6 次委派。', expectedOutput: '不应被允许。' });
  approveIfNeeded(rt, limitProposal.proposal);
  const limitExec = await rt.executeTool({ toolCallId: limitProposal.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('单个 Run 委派总数上限 5', limitExec.ok && limitExec.data.ok === false && limitExec.data.code === 'DELEGATION_LIMIT', limitExec.data?.code);
  rt.finishRun({ runId: parent.run.id, outcome: 'failed', errorCode: 'TEST' });

  parent = rt.createTask({ title: '容量测试', input: 'capacity', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-7' }).data;
  rt.setSettings({ maxConcurrentRuns: 1 });
  const capProposal = proposeDelegation(rt, parent.run.id, { agentId: target.data.agent.id, objective: '并发已满时的委派。', expectedOutput: '不应被允许。' });
  approveIfNeeded(rt, capProposal.proposal);
  const capExec = await rt.executeTool({ toolCallId: capProposal.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('并发已满时拒绝启动子任务', capExec.ok && capExec.data.ok === false && capExec.data.code === 'DELEGATION_CAPACITY', capExec.data?.code);
  rt.setSettings({ maxConcurrentRuns: 4 });
  rt.finishRun({ runId: parent.run.id, outcome: 'failed', errorCode: 'TEST' });

  /* 8.1 上下文白名单：仅共享显式 contextRefs */
  fs.writeFileSync(path.join(workspace, 'shared.txt'), 'SHARED-CONTEXT-9f3', 'utf8');
  parent = rt.createTask({ title: '上下文测试', input: 'context', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-ctx' }).data;
  let seenMessages = null;
  let seenTools = null;
  modelHandler = async ({ messages, tools }) => {
    seenMessages = messages;
    seenTools = tools;
    return textReply('已读取共享上下文');
  };
  const ctxProposal = proposeDelegation(rt, parent.run.id, {
    agentId: target.data.agent.id,
    objective: '阅读共享文件并总结。',
    expectedOutput: '一句话总结。',
    contextRefs: ['shared.txt'],
  });
  approveIfNeeded(rt, ctxProposal.proposal);
  const ctxExec = await rt.executeTool({ toolCallId: ctxProposal.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('显式 contextRefs 委派成功', ctxExec.ok && ctxExec.data.ok === true, ctxExec.data?.code || ctxExec.data?.status);
  add('子 Agent 收到共享文件内容', Array.isArray(seenMessages) && seenMessages.some((m) => String(m.content || '').includes('SHARED-CONTEXT-9f3')), JSON.stringify(seenMessages?.map((m) => m.role)));
  add('子 Agent 收到工具定义', Array.isArray(seenTools) && seenTools.length >= 2, `tools=${seenTools?.length}`);
  const delCtx = rt.listDelegations({ parentRunId: parent.run.id }).data.delegations.find((d) => d.status === 'succeeded');
  add('委派记录保存共享文件与工作区', delCtx?.contextRefs?.includes('shared.txt') && delCtx?.workspace === workspace, JSON.stringify({ refs: delCtx?.contextRefs, ws: delCtx?.workspace === workspace }));
  const ctxChild = rt.getTask(delCtx.childTaskId).data;
  add('子 Run 继承工作区', ctxChild.runs[0].workspace === workspace, ctxChild.runs[0].workspace === workspace ? 'ok' : ctxChild.runs[0].workspace);

  const outsideProposal = proposeDelegation(rt, parent.run.id, {
    agentId: target.data.agent.id,
    objective: '读取工作区外文件。',
    expectedOutput: '不应被允许。',
    contextRefs: ['../outside.txt'],
  });
  approveIfNeeded(rt, outsideProposal.proposal);
  const outsideExec = await rt.executeTool({ toolCallId: outsideProposal.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('工作区外共享文件被拒绝', outsideExec.ok && outsideExec.data.ok === false && outsideExec.data.code === 'CONTEXT_REF_OUTSIDE', outsideExec.data?.code);

  const missingProposal = proposeDelegation(rt, parent.run.id, {
    agentId: target.data.agent.id,
    objective: '读取不存在的共享文件。',
    expectedOutput: '不应被允许。',
    contextRefs: ['missing.txt'],
  });
  approveIfNeeded(rt, missingProposal.proposal);
  const missingExec = await rt.executeTool({ toolCallId: missingProposal.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('不存在的共享文件被拒绝', missingExec.ok && missingExec.data.ok === false && missingExec.data.code === 'CONTEXT_REF_MISSING', missingExec.data?.code);
  rt.finishRun({ runId: parent.run.id, outcome: 'succeeded' });

  /* 8.2 单 Agent 同时子任务上限 2 */
  parent = rt.createTask({ title: '并发子任务限制', input: 'children', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-8-2' }).data;
  const seededActive = [];
  for (let i = 0; i < 2; i++) {
    const rec = rt.stateStore.createDelegationRecord({
      parentTaskId: 'task_other_active_' + i,
      parentRunId: 'run_other_active_' + i,
      parentAgentId: parent.run.agentId,
      targetAgentId: target.data.agent.id,
      targetAgentVersion: 1,
      childTaskId: 'task_other_child_' + i,
      childRunId: 'run_other_child_' + i,
      objective: '活动子任务 ' + i,
      expectedOutput: 'x',
    });
    rt.stateStore.updateDelegation(rec.id, { status: 'running' });
    seededActive.push(rec.id);
  }
  const busyProposal = proposeDelegation(rt, parent.run.id, {
    agentId: target.data.agent.id,
    objective: '第三个子任务。',
    expectedOutput: '不应被允许。',
  });
  approveIfNeeded(rt, busyProposal.proposal);
  const busyExec = await rt.executeTool({ toolCallId: busyProposal.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('同一 Agent 同时子任务上限 2', busyExec.ok && busyExec.data.ok === false && busyExec.data.code === 'DELEGATION_BUSY', busyExec.data?.code);
  rt.finishRun({ runId: parent.run.id, outcome: 'failed', errorCode: 'TEST' });
  for (const id of seededActive) rt.stateStore.updateDelegation(id, { status: 'succeeded' });

  /* 8.3 工具范围取父子交集 */
  const scopedAgent = rt.createAgent({
    name: '只读工具 Agent',
    permissionProfileId: 'full',
    toolPolicy: { allow: ['list_dir', 'read_file'], deny: [] },
  });
  parent = rt.createTask({ title: '工具范围', input: 'scope', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-scope' }).data;
  seenTools = null;
  modelHandler = async ({ tools }) => { seenTools = tools; return textReply('工具范围测试完成'); };
  const scopeProposal = proposeDelegation(rt, parent.run.id, {
    agentId: scopedAgent.data.agent.id,
    objective: '只使用只读工具。',
    expectedOutput: '总结完成。',
  });
  approveIfNeeded(rt, scopeProposal.proposal);
  const scopeExec = await rt.executeTool({ toolCallId: scopeProposal.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('工具交集的子任务执行成功', scopeExec.ok && scopeExec.data.ok === true, scopeExec.data?.code || scopeExec.data?.status);
  const scopeDel = rt.listDelegations({ parentRunId: parent.run.id }).data.delegations[0];
  add('委派工具范围只含父子交集', scopeDel?.toolAllow?.length === 2 && scopeDel.toolAllow.includes('read_file') && !scopeDel.toolAllow.includes('write_file'), JSON.stringify(scopeDel?.toolAllow));
  add('下发模型的定义不含越权工具', Array.isArray(seenTools) && seenTools.length === 2 && seenTools.every((t) => ['list_dir', 'read_file'].includes(t.function?.name)), JSON.stringify(seenTools?.map((t) => t.function?.name)));
  rt.finishRun({ runId: parent.run.id, outcome: 'succeeded' });

  /* 8.4 目标不存在 / 缺少 Provider 配置 */
  parent = rt.createTask({ title: '目标不存在', input: 'target', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-8-4' }).data;
  const noTarget = proposeDelegation(rt, parent.run.id, { agentId: 'agt_missing_target', objective: '不存在目标。', expectedOutput: '不应被允许。' });
  approveIfNeeded(rt, noTarget.proposal);
  const noTargetExec = await rt.executeTool({ toolCallId: noTarget.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('不存在的目标 Agent 被拒绝', noTargetExec.ok && noTargetExec.data.ok === false && noTargetExec.data.code === 'TARGET_NOT_FOUND', noTargetExec.data?.code);
  rt.finishRun({ runId: parent.run.id, outcome: 'failed', errorCode: 'TEST' });

  parent = rt.createTask({ title: '缺少配置', input: 'config', providerId: 'http://no-config.local/v1', model: 'm', idempotencyKey: 'dele-parent-8-5' }).data;
  const noConfig = proposeDelegation(rt, parent.run.id, { agentId: target.data.agent.id, objective: '没有连接配置。', expectedOutput: '不应被允许。' });
  approveIfNeeded(rt, noConfig.proposal);
  const noConfigExec = await rt.executeTool({ toolCallId: noConfig.proposal.data.toolCallId, profile: 'full' });
  console.error('[debug-noconfig]', JSON.stringify(noConfigExec));
  add('缺少 Provider 配置时委派失败', noConfigExec.ok && noConfigExec.data.ok === false && noConfigExec.data.code === 'PROVIDER_CONFIG_MISSING', noConfigExec.data?.code);
  rt.finishRun({ runId: parent.run.id, outcome: 'failed', errorCode: 'TEST' });

  /* 9. 归档目标不可委派 */
  const tempAgent = rt.createAgent({ name: '临时 Agent', permissionProfileId: 'full' });
  rt.archiveAgent(tempAgent.data.agent.id);
  const archived = rt.listAgents().data.agents.find((a) => a.id === tempAgent.data.agent.id);
  add('Agent 可归档', archived?.status === 'archived', archived?.status);
  parent = rt.createTask({ title: '归档测试', input: 'archived', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-8' }).data;
  const arcProposal = proposeDelegation(rt, parent.run.id, { agentId: tempAgent.data.agent.id, objective: '委派给已归档 Agent。', expectedOutput: '不应被允许。' });
  approveIfNeeded(rt, arcProposal.proposal);
  const arcExec = await rt.executeTool({ toolCallId: arcProposal.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('已归档 Agent 不可委派', arcExec.ok && arcExec.data.ok === false && arcExec.data.code === 'TARGET_ARCHIVED', arcExec.data?.code);
  rt.finishRun({ runId: parent.run.id, outcome: 'failed', errorCode: 'TEST' });

  /* 10. 自动创建子 Agent：省略 agentId，主 Agent 指定 model，权限继承父档位 */
  parent = rt.createTask({ title: '自动创建测试', input: 'auto', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-auto' }).data;
  childTurn = 0;
  modelHandler = async (ctx) => {
    childTurn++;
    if (ctx?.cfg?.model === 'auto-picked-model') return textReply('子任务完成：自动创建并使用指定模型。');
    return textReply('子任务完成：错误，模型为 ' + String(ctx?.cfg?.model));
  };
  const dAuto = proposeDelegation(rt, parent.run.id, {
    objective: '自动创建一个子 Agent 并总结工作区。',
    expectedOutput: '返回自动创建确认。',
    model: 'auto-picked-model',
  });
  add('自动创建委派仍需审批', dAuto.proposal.data?.status === 'waiting_approval' && dAuto.proposal.data.policy.ruleIds.includes('delegation-approval'), dAuto.proposal.data?.status);
  approveIfNeeded(rt, dAuto.proposal);
  const autoExec = await rt.executeTool({ toolCallId: dAuto.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('省略 agentId 的委派自动创建子 Agent 并使用指定模型', autoExec.ok && autoExec.data.ok === true && /自动创建并使用指定模型/.test(autoExec.data?.content || ''), JSON.stringify({ code: autoExec.data?.code, content: (autoExec.data?.content || '').slice(0, 80) }));
  const delAuto = rt.listDelegations({ parentRunId: parent.run.id }).data.delegations[0];
  add('自动创建委派记录含模型与标记', delAuto?.model === 'auto-picked-model' && delAuto?.autoCreated === true, JSON.stringify({ model: delAuto?.model, auto: delAuto?.autoCreated }));
  add('自动创建的子 Agent 出现在 Agent 列表且继承父档位', (() => {
    const a = rt.listAgents().data.agents.find((x) => x.id === delAuto?.targetAgentId);
    return !!a && a.status === 'active' && a.version?.permissionProfileId === 'full' && a.version?.model?.model === 'auto-picked-model';
  })(), JSON.stringify(rt.listAgents().data.agents.find((x) => x.id === delAuto?.targetAgentId)?.version?.permissionProfileId));
  add('自动创建委派事件含 autoCreated 标记', rt.read({ afterSeq: 0, limit: 5000 }).events.some((e) => e.type === 'delegation.requested' && e.payload?.autoCreated === true), 'ok');
  rt.finishRun({ runId: parent.run.id, outcome: 'succeeded' });

  /* 11. 一轮多个委派并行排队：两个 delegate_task 同时执行，委派记录同时为 running */
  rt.setSettings({ maxConcurrentRuns: 16 }); // 早期用例遗留的 running 任务会占用并发名额，这里放开以便并行验证
  parent = rt.createTask({ title: '并行委派测试', input: 'parallel', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'dele-parent-parallel' }).data;
  let parallelTurn = 0;
  const gateA = new Promise((resolve) => { global.__parallelReleaseA = resolve; });
  const gateB = new Promise((resolve) => { global.__parallelReleaseB = resolve; });
  modelHandler = async () => {
    parallelTurn++;
    await (parallelTurn === 1 ? gateA : gateB);
    return textReply(`并行子任务 ${parallelTurn} 完成。`);
  };
  const dP1 = proposeDelegation(rt, parent.run.id, { objective: '并行子任务一。', expectedOutput: '完成。' });
  approveIfNeeded(rt, dP1.proposal);
  const dP2 = proposeDelegation(rt, parent.run.id, { objective: '并行子任务二。', expectedOutput: '完成。' });
  approveIfNeeded(rt, dP2.proposal);
  const p1 = rt.executeTool({ toolCallId: dP1.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  const p2 = rt.executeTool({ toolCallId: dP2.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  for (let i = 0; i < 100; i++) {
    const ds = rt.listDelegations({ parentRunId: parent.run.id }).data.delegations;
    if (ds.filter((d) => d.status === 'running').length >= 2) break;
    await sleep(20);
  }
  const parallelRunning = rt.listDelegations({ parentRunId: parent.run.id }).data.delegations.filter((d) => d.status === 'running').length;
  add('两个并行委派同时处于 running', parallelRunning === 2, `running=${parallelRunning}`);
  global.__parallelReleaseA();
  global.__parallelReleaseB();
  const [p1r, p2r] = await Promise.all([p1, p2]);
  add('并行委派均成功返回', p1r.ok && p1r.data.ok === true && p2r.ok && p2r.data.ok === true, JSON.stringify([p1r.data?.code, p2r.data?.code]));
  rt.finishRun({ runId: parent.run.id, outcome: 'succeeded' });

  add('事件链无缺口', rt.store.verify().ok, JSON.stringify(rt.store.verify()));
  add('审计哈希链校验通过', rt.audit.verify().ok, JSON.stringify(rt.audit.verify().issues));

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
