'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TOOL_SPECS } = require('../lib/tools');
const { estimateTokens, estimateMessagesTokens } = require('../lib/token-estimate');
const { sleep: abortableSleep } = require('../lib/retry');

/* 子 Agent 执行器：主进程内的非流式模型循环。
   子 Run 复用 Runtime 的 Step/ModelCall/ToolCall/Approval 与事件，不绕过 Policy。 */

const MAX_CONTEXT_REF_CHARS = 20000;
const MAX_CONTEXT_TOTAL_CHARS = 40000;
const MAX_TOOL_RESULT_CHARS = 12000;
/* 子代理历史总量上限（R15/A6）：以前只有「轮数」与「token」两道闸，
   而 token 依赖上游返回 usage（兼容网关普遍不返回 → 预算等于不存在）。
   12 轮 × 每轮 24 工具 × 12000 字符理论上能到 345 万字符，必撞上游窗口。
   120000 字符 ≈ 12 万 token 中文，给系统提示与输出留出余量。 */
const MAX_CHILD_CONTEXT_CHARS = 120000;
const CHECKPOINT_KEEP_MESSAGES = 40;
const APPROVAL_POLL_MS = 300;
const MODEL_RETRY_DELAY_MS = 1200;

const SYSTEM_PROMPT = [
  '你是 DSH Desktop 中被父 Agent 委派的子 Agent。',
  '你只能看到本次委派的 objective、expectedOutput 与显式共享的 contextRefs，看不到父级完整对话。',
  '用简体中文工作。完成后给出简洁、可核验的总结，不要虚构工具结果或文件产出。',
].join('\n');

function toolSpecForChild(name) {
  return TOOL_SPECS.find((s) => s.function?.name === name) || null;
}

function buildChildTools(delegation) {
  const allow = Array.isArray(delegation.toolAllow) ? new Set(delegation.toolAllow) : null;
  const out = [];
  for (const spec of TOOL_SPECS) {
    const name = spec.function?.name;
    if (!name || (allow && !allow.has(name))) continue;
    if (name === 'project_architecture') continue;
    if (name === 'delegate_task' && delegation.depth >= 2) continue;
    out.push(spec);
  }
  return out;
}

function readContextRefs(delegation) {
  const refs = Array.isArray(delegation.contextRefPaths) ? delegation.contextRefPaths : [];
  const sections = [];
  let total = 0;
  for (const abs of refs) {
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      let text = fs.readFileSync(abs, 'utf8');
      if (text.length > MAX_CONTEXT_REF_CHARS) text = text.slice(0, MAX_CONTEXT_REF_CHARS) + '\n…（共享内容已截断）';
      total += text.length;
      if (total > MAX_CONTEXT_TOTAL_CHARS) break;
      sections.push(`--- 共享文件：${path.basename(abs)} ---\n${text}`);
    } catch { /* 委派创建时已校验，运行中被删除则跳过 */ }
  }
  return sections.join('\n\n');
}

function buildMessages(delegation, targetVersion, workspacePath, permission) {
  const messages = [];
  messages.push({ role: 'system', content: targetVersion?.systemPrompt?.trim() || SYSTEM_PROMPT });
  messages.push({
    role: 'system',
    content: [
      `你正在执行父 Agent 委派的子任务。`,
      `权限档位：${permission}。工作目录：${workspacePath}。`,
      `期望输出：${delegation.expectedOutput || '简洁总结完成情况与产物'}`,
      '工具调用会经过与主 Agent 相同的策略与审批流程；需要审批时等待用户决定。',
      '当任务完成或无法继续时，停止调用工具并给出最终总结。',
    ].join('\n'),
  });
  const shared = readContextRefs(delegation);
  if (shared) messages.push({ role: 'system', content: `父 Agent 显式共享的上下文：\n\n${shared}` });
  messages.push({ role: 'user', content: delegation.objective });
  return messages;
}

function approvalWait(runtime, approvalId, deadline, runId) {
  return new Promise((resolve) => {
    const tick = () => {
      const approval = runtime.stateStore.getApproval(approvalId);
      const run = runtime.stateStore.getRun(runId);
      if (!approval || approval.status !== 'pending' || !run || ['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.status)) {
        resolve(approval);
        return;
      }
      if (Date.now() > approval.expiresAt) {
        runtime.stateStore.sweepExpiredApprovals();
        runtime.stateStore.setRunWaitingApproval(runId, false);
        resolve(runtime.stateStore.getApproval(approvalId));
        return;
      }
      if (Date.now() > deadline) {
        resolve(approval);
        return;
      }
      setTimeout(tick, APPROVAL_POLL_MS);
    };
    tick();
  });
}

async function requestModel(runtime, { providerConfig, delegation, messages, tools, deadline }) {
  const remaining = Math.max(1000, deadline - Date.now());
  // 取消传播：父任务/本 Run 被取消时，子代理的在途模型请求也要断（否则要等满超时）
  const signal = runtime.signalForRun(delegation.childRunId) || undefined;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await runtime.modelRequest({
        cfg: { ...providerConfig, model: delegation.model || providerConfig.model },
        messages,
        tools,
        timeoutMs: Math.min(remaining, 120000),
        signal,
      });
    } catch (err) {
      lastErr = err;
      if (attempt >= 3 || !err?.retryable || Date.now() + MODEL_RETRY_DELAY_MS >= deadline) throw err;
      /* R15/A12：退避必须可中断——取消子任务时不该还等满 1.2/2.4 秒再退出。
         取消时 abortableSleep 抛 AbortError，这里把原始错误抛出去让上层按 CANCELED 收尾。 */
      try { await abortableSleep(MODEL_RETRY_DELAY_MS * attempt, signal); }
      catch { throw err; }
    }
  }
  throw lastErr;
}

function artifactList(runtime, childRunId) {
  // 全量（游标分页）：长委派超过 5000 事件时以前会漏掉早先的产物
  const events = runtime.store.readAll({ runId: childRunId });
  const latest = new Map();
  for (const ev of events) {
    if (ev.type !== 'artifact.created') continue;
    const p = ev.payload || {};
    if (!p.path) continue;
    latest.set(p.path, { artifactId: p.artifactId, path: p.path, size: p.size, sha256: p.sha256 });
  }
  return [...latest.values()];
}

async function executeToolCall(runtime, { call, delegation, stepId, providerConfig, deadline }) {
  const finishStep = (status) => {
    if (!stepId) return;
    try { runtime.finishStep({ stepId, status }); } catch { /* 运行可能已取消 */ }
  };
  const name = String(call.function?.name || '');
  let args;
  try { args = JSON.parse(call.function?.arguments || '{}'); }
  catch { finishStep('failed'); return { ok: false, content: `工具参数不是合法 JSON：${name}`, code: 'INVALID_ARGS' }; }

  const proposal = runtime.proposeTool({
    runId: delegation.childRunId,
    stepId,
    name,
    args,
    profile: delegation.effectiveProfile,
    modelToolCallId: call.id,
  });
  if (!proposal.ok) {
    finishStep('failed');
    return { ok: false, content: `工具调用失败（${name}）：${proposal.error?.message || '运行时拒绝'}`, code: proposal.error?.code };
  }
  const p = proposal.data;
  if (p.status === 'denied') {
    finishStep('canceled');
    return { ok: false, content: `策略拒绝执行该工具（${name}）：${p.message || ''}`, code: 'DENIED' };
  }

  let approvalId = p.approval?.id || '';
  if (p.status === 'waiting_approval') {
    const approval = await approvalWait(runtime, approvalId, deadline, delegation.childRunId);
    if (!approval || approval.status !== 'approved') {
      if (approval?.status === 'pending') {
        try { runtime.decideApproval({ approvalId, decision: 'denied', reason: '子任务等待审批超时' }); } catch { /* 已结束 */ }
      }
      finishStep('canceled');
      return { ok: false, content: `工具 ${name} 未获批准（${approval?.status || 'expired'}）。`, code: 'APPROVAL_DENIED' };
    }
  }

  if (name === 'delegate_task') {
    const result = await runtime.runDelegationTool({
      toolCallId: p.toolCallId,
      providerConfig,
      profile: delegation.effectiveProfile,
      workspace: delegation.workspace || runtime.workspacePath,
    });
    finishStep(result.ok ? 'succeeded' : 'failed');
    return {
      ok: result.ok === true,
      content: String(result.content || result.message || ''),
      code: result.code,
      meta: result.meta,
    };
  }

  const executed = await runtime.executor.execute({
    toolCallId: p.toolCallId,
    approvalId,
    profile: delegation.effectiveProfile,
    workspace: delegation.workspace || runtime.workspacePath,
  });
  if (executed.ok === false) {
    finishStep('failed');
    /* 失败时也要把 executor 产出的 content 带上：里面有 stderr 原文与
       「Windows 没有 head/grep，改用 find_files」这类替代做法提示。
       以前只回一句「命令退出码 255」，模型看不到原因，只会原样重试。 */
    const detail = String(executed.content || '').trim();
    return {
      ok: false,
      content: `工具 ${name} 失败：${executed.message || executed.error || executed.code || '未知错误'}`
        + (detail ? `\n${detail}` : ''),
      code: executed.code,
    };
  }
  if (executed.ok) {
    finishStep('succeeded');
    return {
      ok: true,
      content: String(executed.content || ''),
      meta: executed.meta,
      status: executed.status,
    };
  }
  finishStep('failed');
  return {
    ok: false,
    content: `工具 ${name} 失败：${executed.error || executed.code || '未知错误'}`,
    code: executed.code,
    status: executed.status,
  };
}

function clipToolResult(text) {
  const s = String(text == null ? '' : text);
  return s.length > MAX_TOOL_RESULT_CHARS ? s.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…（工具结果已截断）' : s;
}

function messagesChars(messages) {
  return (Array.isArray(messages) ? messages : [])
    .reduce((n, m) => n + String(m?.content || '').length, 0);
}

/**
 * 修复 tool_calls / tool 配对（R15/A6）。
 * 裁剪只能整段掐，断点很容易落在「assistant 带 tool_calls」与「对应 tool 结果」之间；
 * 上游对配对是强校验（缺结果 / 多余结果都会 400），所以裁完必须补一遍：
 *   · 孤儿 tool 消息（找不到声明的 tool_call_id）→ 丢弃；
 *   · assistant 的 tool_calls 里没有对应结果的 → 去掉该条声明；
 *   · 去掉声明后既无正文又无工具的 assistant → 丢弃（空消息上游也可能拒）。
 */
function repairToolPairs(messages) {
  const declared = new Set();
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) if (c?.id) declared.add(c.id);
    }
  }
  const kept = messages.filter((m) => !(m?.role === 'tool' && !declared.has(m.tool_call_id)));
  const answered = new Set(kept.filter((m) => m?.role === 'tool').map((m) => m.tool_call_id));
  const out = [];
  for (const m of kept) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const stillValid = m.tool_calls.filter((c) => answered.has(c?.id));
      if (stillValid.length !== m.tool_calls.length) {
        const content = String(m.content || '');
        if (!stillValid.length && !content) continue;
        out.push(stillValid.length ? { ...m, tool_calls: stillValid } : { ...m, tool_calls: undefined });
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * 子代理历史裁剪（R15/A6）：按字符预算从尾部保留，超出部分用一行占位说明。
 * 保留首条 system（角色与协议），裁掉的是最早的工具往返——那部分信息密度最低，
 * 且模型可以重新读取文件。裁剪后统一做配对修复，避免上游 400。
 */
function trimChildMessages(messages) {
  if (messagesChars(messages) <= MAX_CHILD_CONTEXT_CHARS) return messages;
  const head = messages[0]?.role === 'system' ? [messages[0]] : [];
  const body = head.length ? messages.slice(1) : messages.slice();
  const keep = [];
  let used = head.reduce((n, m) => n + String(m?.content || '').length, 0);
  for (let i = body.length - 1; i >= 0; i--) {
    const size = String(body[i]?.content || '').length;
    if (used + size > MAX_CHILD_CONTEXT_CHARS && keep.length) break;
    keep.push(body[i]);
    used += size;
  }
  keep.reverse();
  const dropped = body.length - keep.length;
  if (dropped <= 0) return messages;
  const note = {
    role: 'system',
    content: `（已省略更早的 ${dropped} 条子任务对话，其中包含工具调用记录；需要该信息时请重新读取相关文件。）`,
  };
  return repairToolPairs([...head, note, ...keep]);
}

/** 检查点只存最近若干条（R15/A6）：整段 messages 每步全量写 state.json 是 O(n²) 写放大。 */
function checkpointMessages(messages) {
  if (messages.length <= CHECKPOINT_KEEP_MESSAGES) return messages;
  const head = messages[0]?.role === 'system' ? [messages[0]] : [];
  const tail = messages.slice(-CHECKPOINT_KEEP_MESSAGES);
  return repairToolPairs([
    ...head,
    { role: 'system', content: `（检查点只保留最近 ${CHECKPOINT_KEEP_MESSAGES} 条消息）` },
    ...tail,
  ]);
}

async function runAgentTask({ runtime, delegation, providerConfig }) {
  const state = runtime.stateStore;
  const task = state.getTask(delegation.childTaskId);
  const run = state.getRun(delegation.childRunId);
  if (!task || !run) {
    runtime.delegations.finish(delegation, { status: 'failed', errorCode: 'CHILD_NOT_FOUND', summary: '子任务或运行不存在' });
    return delegation;
  }
  if (!providerConfig?.baseUrl || !providerConfig?.key || !providerConfig?.model) {
    state.finishRun({ runId: run.id, outcome: 'failed', errorCode: 'PROVIDER_CONFIG_MISSING', summary: '缺少模型连接配置，无法执行子任务' });
    runtime.delegations.finish(delegation, { status: 'failed', errorCode: 'PROVIDER_CONFIG_MISSING', summary: '缺少模型连接配置，无法执行子任务' });
    return delegation;
  }

  runtime.delegations.start(delegation);
  const deadline = Date.now() + Math.max(1000, Number(delegation.budget?.maxWallClockMs) || 300000);
  const maxModelCalls = Math.max(1, Number(delegation.budget?.maxModelCalls) || 12);
  const maxTokens = Math.max(1, Number(delegation.budget?.maxTokens) || 60000);
  const targetVersion = state.getAgentVersion(delegation.targetAgentId, delegation.targetAgentVersion);
  const workspacePath = delegation.workspace || runtime.workspacePath;
  const messages = buildMessages(delegation, targetVersion, workspacePath, delegation.effectiveProfile);
  const tools = buildChildTools(delegation);
  let modelCalls = 0;
  let tokens = 0;
  let finalText = '';
  let failure = null;
  let budgetExceeded = null;

  /* 断点续跑：委派记录上有检查点（上次中断时保存的对话）就从那里继续，
     预算按已消耗量折算，不重头执行。 */
  const ck = delegation.checkpoint;
  if (ck && Array.isArray(ck.messages) && ck.messages.length) {
    messages.length = 0;
    messages.push(...ck.messages);
    modelCalls = Number(ck.modelCalls) || 0;
    tokens = Number(ck.tokens) || 0;
    finalText = String(ck.finalText || '');
    messages.push({
      role: 'system',
      content: '上次执行因应用重启而中断；以上是中断前的完整对话，请从中断处继续完成任务，不要重复已完成的工作。',
    });
    runtime.store.append({
      type: 'delegation.resumed',
      taskId: delegation.childTaskId,
      runId: run.id,
      payload: { delegationId: delegation.id, checkpointAt: ck.savedAt, modelCalls, tokens },
    });
  }

  try {
    for (;;) {
      const currentRun = state.getRun(run.id);
      if (!currentRun || ['succeeded', 'failed', 'canceled', 'interrupted'].includes(currentRun.status)) {
        failure = failure || { code: 'CANCELED', message: '子任务运行已结束' };
        break;
      }
      if (Date.now() > deadline) { budgetExceeded = { scope: 'wallClockMs', limit: delegation.budget?.maxWallClockMs }; break; }
      if (modelCalls >= maxModelCalls) { budgetExceeded = { scope: 'modelCalls', limit: maxModelCalls }; break; }

      const stepR = runtime.beginStep({ runId: run.id, kind: 'model' });
      const stepId = stepR.ok ? stepR.data.step.id : '';
      let modelCallId = '';
      if (stepId) {
        const mc = runtime.modelStart({
          runId: run.id,
          stepId,
          providerId: run.providerId,
          model: delegation.model || providerConfig.model,
          messageCount: messages.length,
          approxInputTokens: estimateMessagesTokens(messages),
          meta: messages.map((m) => ({ role: m.role, chars: String(m.content || '').length })),
        });
        modelCallId = mc.ok ? mc.data.modelCallId : '';
      }

      modelCalls++;
      /* R15/A6：请求前按字符预算裁剪历史（就地替换，保持 messages 引用），
         只保留最近一段工具往返；裁剪后 pairing 已修复，不会因缺 tool 结果被上游拒。 */
      const trimmed = trimChildMessages(messages);
      if (trimmed !== messages) {
        messages.length = 0;
        messages.push(...trimmed);
      }
      let reply;
      try {
        reply = await requestModel(runtime, { providerConfig, delegation, messages, tools, deadline });
      } catch (err) {
        if (modelCallId) runtime.modelFinish({
          modelCallId,
          status: 'failed',
          error: { code: String(err?.code || 'MODEL_ERROR'), message: String(err?.message || err).slice(0, 300) },
        });
        if (stepId) runtime.finishStep({ stepId, status: 'failed', modelCallId });
        failure = { code: String(err?.code || 'MODEL_ERROR'), message: String(err?.message || err) };
        break;
      }
      if (modelCallId) runtime.modelFinish({ modelCallId, status: 'completed', usage: reply.usage, finishReason: reply.finishReason });
      if (stepId) runtime.finishStep({ stepId, status: 'succeeded', modelCallId });
      if (reply.usage && typeof reply.usage === 'object') {
        tokens += (Number(reply.usage.prompt_tokens) || 0) + (Number(reply.usage.completion_tokens) || 0);
      } else {
        /* 兼容网关常不返回 usage：用估算兜底。输入按本轮实际发送的全量 messages 计，
           输出按本次正文计——与真实计费口径一致（每轮都重发上下文）。 */
        tokens += estimateMessagesTokens(messages) + estimateTokens(text);
      }
      if (tokens > maxTokens) { budgetExceeded = { scope: 'tokens', limit: maxTokens, used: tokens }; break; }

      const toolCalls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
      const text = String(reply.content || '');
      if (text) finalText = text;
      messages.push({ role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      // 每个模型回合后落检查点：中断后可从此处续跑
      state.saveDelegationCheckpoint(delegation.id, {
        messages: checkpointMessages(messages), modelCalls, tokens, finalText,
      });
      if (!toolCalls.length) break;

      let canceled = false;
      for (const call of toolCalls) {
        const curr = state.getRun(run.id);
        if (!curr || curr.status === 'canceled') { canceled = true; break; }
        const toolStepR = runtime.beginStep({ runId: run.id, kind: 'tool_call' });
        const toolStepId = toolStepR.ok ? toolStepR.data.step.id : null;
        const r = await executeToolCall(runtime, { call, delegation, stepId: toolStepId, providerConfig, deadline });
        messages.push({ role: 'tool', tool_call_id: call.id, content: clipToolResult(r.content) });
        state.saveDelegationCheckpoint(delegation.id, {
          messages: checkpointMessages(messages), modelCalls, tokens, finalText,
        });
        if (state.getRun(run.id)?.status === 'canceled') { canceled = true; break; }
      }
      if (canceled) { failure = { code: 'CANCELED', message: '父任务已取消子任务' }; break; }
    }
  } catch (err) {
    failure = { code: String(err?.code || 'RUNNER_ERROR'), message: String(err?.message || err) };
  }

  if (budgetExceeded) {
    runtime.store.append({
      type: 'budget.exceeded',
      taskId: delegation.childTaskId,
      runId: run.id,
      payload: { scope: budgetExceeded.scope, limit: budgetExceeded.limit, used: budgetExceeded.used },
    });
    failure = { code: 'BUDGET_EXCEEDED', message: `子任务预算耗尽：${budgetExceeded.scope}` };
  }

  const artifacts = artifactList(runtime, run.id);
  const summaryBase = finalText || (failure ? '' : '子任务完成（模型未返回文本）');
  let finalRun = state.getRun(run.id);
  if (finalRun && !['succeeded', 'failed', 'canceled', 'interrupted'].includes(finalRun.status)) {
    const finished = runtime.finishRun({
      runId: run.id,
      outcome: failure ? 'failed' : 'succeeded',
      summary: String(summaryBase).slice(0, 500),
      errorCode: failure?.code,
    });
    if (finished.ok && finished.data?.errorCode && !failure) {
      failure = { code: finished.data.errorCode, message: `子任务收尾校验未通过（${finished.data.errorCode}）` };
    }
    finalRun = state.getRun(run.id);
  }
  const childTask = state.getTask(delegation.childTaskId);
  const status = childTask?.status === 'succeeded' ? 'succeeded'
    : childTask?.status === 'canceled' || finalRun?.status === 'canceled' ? 'canceled'
      : 'failed';
  // 终态后检查点失去意义：成功即清除；失败/取消保留以便人工恢复续跑
  if (status === 'succeeded') state.saveDelegationCheckpoint(delegation.id, null);
  const errorCode = status === 'succeeded' ? undefined : (failure?.code || (status === 'canceled' ? 'CANCELED' : 'DELEGATION_FAILED'));
  const summary = status === 'succeeded' ? summaryBase : (failure?.message || '子任务失败');
  runtime.delegations.finish(delegation, {
    status,
    summary,
    errorCode,
    artifacts,
  });

  // 父任务取消时子 Run 可能已被级联取消，这里只补委派终态
  if (finalRun?.status === 'canceled' && delegation.status !== 'canceled') {
    runtime.delegations.finish(delegation, { status: 'canceled', summary: '父任务已取消', errorCode: 'PARENT_CANCELED', artifacts });
  }
  return runtime.delegations.state.getDelegation(delegation.id) || delegation;
}

module.exports = {
  runAgentTask,
  buildChildTools,
  buildMessages,
  requestModel,
  trimChildMessages,
  repairToolPairs,
  checkpointMessages,
  MAX_CHILD_CONTEXT_CHARS,
  APPROVAL_POLL_MS,
};
