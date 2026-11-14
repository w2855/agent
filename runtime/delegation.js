'use strict';

const fs = require('node:fs');
const path = require('node:path');
const policy = require('./policy');
const { listManifests } = require('./tool-registry');

/* Phase 5 委派约束：深度、环、并发、总量、预算、权限与工具收窄。
   子任务通过 StateStore.createTask({parentTaskId}) 进入同一队列。 */

const MAX_DEPTH = 2;
const MAX_ACTIVE_CHILDREN_PER_AGENT = 2;
const MAX_DELEGATIONS_PER_RUN = 5;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_CHILD_BUDGET = { maxWallClockMs: 300000, maxModelCalls: 12, maxTokens: 60000 };
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'rejected']);

function allToolNames() {
  return listManifests().map((m) => m.name);
}

function normalizeBudgetInput(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('budget 必须是对象');
  const out = {};
  for (const key of ['maxWallClockMs', 'maxModelCalls', 'maxTokens']) {
    if (value[key] == null) continue;
    const n = Number(value[key]);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`budget.${key} 必须是正整数`);
    out[key] = n;
  }
  return out;
}

function parentRemaining(parentRun, now) {
  const budget = parentRun?.budget && typeof parentRun.budget === 'object' ? parentRun.budget : {};
  const usage = parentRun?.usage || {};
  const out = {};
  if (budget.maxWallClockMs) out.maxWallClockMs = Math.max(0, Number(budget.maxWallClockMs) - Math.max(0, now - (parentRun.startedAt || now)));
  if (budget.maxModelCalls) out.maxModelCalls = Math.max(0, Number(budget.maxModelCalls) - (Number(usage.modelCalls) || 0));
  if (budget.maxTokens) out.maxTokens = Math.max(0, Number(budget.maxTokens) - ((Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0)));
  return out;
}

function computeChildBudget(parentRun, declared, now) {
  const remaining = parentRemaining(parentRun, now);
  const child = {};
  for (const key of ['maxWallClockMs', 'maxModelCalls', 'maxTokens']) {
    const fallback = DEFAULT_CHILD_BUDGET[key];
    const parentCap = Number.isFinite(remaining[key]) ? remaining[key] : null;
    const half = parentCap != null ? Math.floor(parentCap / 2) : fallback;
    if (parentCap != null && half <= 0) {
      return { ok: false, code: 'BUDGET_EXHAUSTED', message: `父任务预算不足，无法再委派（${key}）` };
    }
    child[key] = declared[key] != null ? Math.min(declared[key], half) : half;
    if (child[key] <= 0) return { ok: false, code: 'BUDGET_EXHAUSTED', message: `子任务预算必须大于 0（${key}）` };
  }
  return { ok: true, budget: child };
}

function ancestorAgentIds(state, task) {
  const ids = new Set();
  let cur = task;
  let guard = 0;
  while (cur && guard < 32) {
    if (cur.agentId) ids.add(cur.agentId);
    cur = cur.parentTaskId ? state.getTask(cur.parentTaskId) : null;
    guard++;
  }
  return ids;
}

class DelegationService {
  constructor({ state, events, workspacePath, now = Date.now } = {}) {
    this.state = state;
    this.events = events;
    this.workspacePath = workspacePath || process.cwd();
    this.now = now;
  }

  /* 自动创建子 Agent：名称取 objective 前缀 + 时间戳后缀，权限继承父 Run 生效档位，模型由主 Agent 指定 */
  _autoCreateAgent(parentRun, { objective, model }) {
    const base = String(objective || '').replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 12) || '子任务';
    const parentAgent = this.state.getAgent(parentRun.agentId);
    const parentName = parentAgent?.agent?.name || '';
    const name = `${parentName ? parentName.slice(0, 10) + '-' : ''}${base}-${Math.floor(this.now() / 1000) % 100000}`;
    const parentProfile = ['full', 'ask', 'readonly'].includes(parentRun.effectiveProfile) ? parentRun.effectiveProfile : 'ask';
    const created = this.state.createAgent({
      name,
      description: `由主 Agent 委派时自动创建（父任务 ${parentRun.taskId}）`,
      permissionProfileId: parentProfile,
      model: { providerId: parentRun.providerId || '', model: String(model || '').slice(0, 128) },
    });
    return created; // { agent, version } 或抛错（重名等极端情况由调用方捕获）
  }

  _reject(parentRun, targetAgentId, code, message, extra = {}) {
    this.events.append({
      type: 'delegation.rejected',
      taskId: parentRun?.taskId,
      runId: parentRun?.id,
      payload: {
        parentRunId: parentRun?.id,
        targetAgentId: targetAgentId || '',
        code,
        reason: String(message || code).slice(0, 300),
        ...extra,
      },
    });
    return { ok: false, code, message };
  }

  create({ parentRunId, toolCallId, args = {} } = {}) {
    const parentRun = this.state.getRun(String(parentRunId || ''));
    if (!parentRun) return { ok: false, code: 'RUN_NOT_FOUND', message: `父运行不存在：${parentRunId}` };
    // interrupted 的父 run 仅在续跑场景放行：入口先做续跑候选检查（见下方 resume 查找）
    const parentInactive = parentRun.status !== 'running' && parentRun.status !== 'waiting_approval';
    const parentTask = this.state.getTask(parentRun.taskId);
    if (!parentTask) return { ok: false, code: 'TASK_NOT_FOUND', message: '父任务不存在' };
    const toolCall = toolCallId ? this.state.getToolCall(String(toolCallId)) : null;
    if (!toolCall || toolCall.name !== 'delegate_task' || toolCall.runId !== parentRun.id) {
      return { ok: false, code: 'TOOL_CALL_INVALID', message: '委派必须由当前 Run 的 delegate_task 工具调用发起' };
    }

    const workspace = parentRun.workspace || parentTask.workspace || this.workspacePath;
    const objective = String(args.objective || '').trim();
    const expectedOutput = String(args.expectedOutput || '').trim();
    const rawAgentId = String(args.agentId || '').trim();
    const autoCreate = !rawAgentId || rawAgentId === 'new' || rawAgentId === 'auto';
    let targetAgentId = autoCreate ? '' : rawAgentId;
    if (!objective) return this._reject(parentRun, targetAgentId, 'OBJECTIVE_REQUIRED', '缺少 objective');
    if (objective.length > 4000) return this._reject(parentRun, targetAgentId, 'OBJECTIVE_TOO_LONG', 'objective 超过 4000 字符');
    if (!expectedOutput) return this._reject(parentRun, targetAgentId, 'EXPECTED_OUTPUT_REQUIRED', '缺少 expectedOutput');

    let autoCreated = null;
    if (autoCreate) {
      const requestedModel = String(args.model || '').trim().slice(0, 128);
      try {
        autoCreated = this._autoCreateAgent(parentRun, { objective, model: requestedModel });
      } catch (err) {
        return this._reject(parentRun, '', 'AUTO_CREATE_AGENT_FAILED', err?.message || '自动创建子 Agent 失败');
      }
      targetAgentId = autoCreated.agent.id;
    }

    const target = this.state.getAgent(targetAgentId);
    if (!target) return this._reject(parentRun, targetAgentId, 'TARGET_NOT_FOUND', '目标 Agent 不存在');
    if (target.agent.status !== 'active') {
      return this._reject(parentRun, targetAgentId, 'TARGET_ARCHIVED', '目标 Agent 已归档，不能接收委派');
    }
    const targetVersion = target.currentVersion;
    if (!targetVersion || targetVersion.version !== target.agent.currentVersion) {
      return this._reject(parentRun, targetAgentId, 'TARGET_VERSION_MISSING', '目标 Agent 没有可用的当前版本');
    }

    const ancestors = ancestorAgentIds(this.state, parentTask);
    if (ancestors.has(targetAgentId)) {
      return this._reject(parentRun, targetAgentId, 'AGENT_LOOP', '目标 Agent 已出现在祖先链中，禁止环状委派');
    }

    const depth = Number.isInteger(parentTask.delegationDepth) ? parentTask.delegationDepth : 0;
    const childDepth = depth + 1;
    if (childDepth > MAX_DEPTH) {
      return this._reject(parentRun, targetAgentId, 'DEPTH_EXCEEDED', `委派深度最多 ${MAX_DEPTH} 层`);
    }

    // 续跑候选：优先同任务内匹配；找不到时跨任务按目标+目标内容匹配（重启后父任务通常已中断换新）
    const resumableFilter = (d) => d.status === 'queued'
      && d.childRunId
      && d.checkpoint
      && Array.isArray(d.checkpoint.messages)
      && d.checkpoint.messages.length > 0
      && d.targetAgentId === targetAgentId
      && d.objective === objective
      && this.now() - d.createdAt <= DEDUPE_WINDOW_MS
      && this.state.getRun(d.childRunId)?.status === 'interrupted';
    const allRecent = this.state.listDelegations({ limit: 200 }).delegations;
    const dedupeScope = allRecent.find((d) => d.parentTaskId === parentTask.id && d.targetAgentId === targetAgentId && d.objective === objective && this.now() - d.createdAt <= DEDUPE_WINDOW_MS)
      || allRecent.find(resumableFilter);
    if (dedupeScope) {
      // 中断后带检查点的委派：同目标重新委派时改为续跑该记录，而不是拒绝。
      // 续跑不要求原父 run 复活——委派改挂到当前父 run / 工具调用下。
      const resumable = resumableFilter(dedupeScope);
      if (resumable) {
        const record = dedupeScope;
        record.parentRunId = parentRun.id;
        record.parentTaskId = parentTask.id;
        this.state.applyDelegationScope(record.childRunId, {
          toolAllow: record.toolAllow,
          delegationId: record.id,
          effectiveProfile: record.effectiveProfile,
        });
        this.state.resumeRunForDelegation(record.childRunId);
        this.state._persist();
        this.state._append('delegation.resumed', {
          taskId: parentTask.id,
          runId: parentRun.id,
          payload: { delegationId: record.id, childRunId: record.childRunId, parentRunId: parentRun.id },
        });
        return { ok: true, deduped: false, resumed: true, delegation: record, childTask: this.state.getTask(record.childTaskId), childRun: this.state.getRun(record.childRunId), targetAgent: target.agent, targetVersion };
      }
      const childTask = this.state.getTask(dedupeScope.childTaskId);
      const childRun = dedupeScope.childRunId ? this.state.getRun(dedupeScope.childRunId) : null;
      return { ok: true, deduped: true, delegation: dedupeScope, childTask, childRun, targetAgent: target.agent, targetVersion };
    }

    // 续跑候选检查完毕：非续跑场景下父 run 必须活跃
    if (parentInactive) {
      return { ok: false, code: 'RUN_NOT_ACTIVE', message: `父运行已结束：${parentRun.status}` };
    }

    // 配额只计入真实尝试（非 rejected/failed-before-start 的记录），被拒的委派不消耗名额
    const attempted = this.state.listDelegations({ parentRunId: parentRun.id, limit: 200 }).delegations
      .filter((d) => d.status !== 'rejected').length;
    if (attempted >= MAX_DELEGATIONS_PER_RUN) {
      return this._reject(parentRun, targetAgentId, 'DELEGATION_LIMIT', `单个 Run 最多委派 ${MAX_DELEGATIONS_PER_RUN} 次`);
    }
    const activeChildren = this.state.listDelegations({ limit: 200 }).delegations.filter((d) => (
      d.parentAgentId === parentRun.agentId && (d.status === 'queued' || d.status === 'running')
    )).length;
    if (activeChildren >= MAX_ACTIVE_CHILDREN_PER_AGENT) {
      return this._reject(parentRun, targetAgentId, 'DELEGATION_BUSY', `同一 Agent 同时最多 ${MAX_ACTIVE_CHILDREN_PER_AGENT} 个子任务`);
    }

    let declared;
    try { declared = normalizeBudgetInput(args.budget); }
    catch (err) { return this._reject(parentRun, targetAgentId, 'BUDGET_INVALID', err.message); }
    const budgetResult = computeChildBudget(parentRun, declared, this.now());
    if (!budgetResult.ok) return this._reject(parentRun, targetAgentId, budgetResult.code, budgetResult.message);

    const queue = this.state.queueStats();
    if (queue.activeRuns >= queue.maxConcurrentRuns) {
      return this._reject(parentRun, targetAgentId, 'DELEGATION_CAPACITY', '当前并发已满，暂时无法启动子任务');
    }

    let refs = [];
    if (args.contextRefs != null) {
      if (!Array.isArray(args.contextRefs)) return this._reject(parentRun, targetAgentId, 'CONTEXT_REFS_INVALID', 'contextRefs 必须是数组');
      if (args.contextRefs.length > 10) return this._reject(parentRun, targetAgentId, 'CONTEXT_REFS_TOO_MANY', 'contextRefs 最多 10 个');
      for (const raw of args.contextRefs) {
        const value = String(raw || '').trim();
        if (!value) continue;
        let abs;
        try { abs = policy.resolvePath(value, workspace); }
        catch (err) { return this._reject(parentRun, targetAgentId, 'CONTEXT_REF_INVALID', err.message); }
        if (!policy.isWithinWorkspace(workspace, abs)) {
          return this._reject(parentRun, targetAgentId, 'CONTEXT_REF_OUTSIDE', `共享文件必须位于工作区内：${value}`);
        }
        let stat;
        try { stat = fs.statSync(abs); } catch { stat = null; }
        if (!stat || !stat.isFile()) {
          return this._reject(parentRun, targetAgentId, 'CONTEXT_REF_MISSING', `共享文件不存在或不是普通文件：${value}`);
        }
        refs.push({ path: abs, display: path.relative(workspace, abs).split(path.sep).join('/'), size: stat.size });
      }
    }

    const parentAgent = this.state.getAgent(parentRun.agentId);
    const parentVersion = this.state.getAgentVersion(parentRun.agentId, parentRun.agentVersion);
    const all = allToolNames();
    const parentAllow = Array.isArray(parentVersion?.toolPolicy?.allow) ? parentVersion.toolPolicy.allow : all;
    const targetAllow = Array.isArray(targetVersion.toolPolicy?.allow) ? targetVersion.toolPolicy.allow : all;
    const deny = new Set([
      ...(Array.isArray(parentVersion?.toolPolicy?.deny) ? parentVersion.toolPolicy.deny : []),
      ...(Array.isArray(targetVersion.toolPolicy?.deny) ? targetVersion.toolPolicy.deny : []),
    ]);
    const toolAllow = all.filter((name) => parentAllow.includes(name) && targetAllow.includes(name) && !deny.has(name));
    if (!toolAllow.length) return this._reject(parentRun, targetAgentId, 'TOOL_SCOPE_EMPTY', '父子权限交集为空，无法委派');

    const parentProfile = ['full', 'ask', 'readonly'].includes(parentRun.effectiveProfile) ? parentRun.effectiveProfile : 'ask';
    const effectiveProfile = policy.stricterProfile(parentProfile, targetVersion.permissionProfileId);

    const rootTaskId = parentTask.rootTaskId || parentTask.id;
    let created;
    try {
      created = this.state.createTask({
        title: `委派 · ${objective.replace(/\s+/g, ' ').slice(0, 24)}`,
        input: objective,
        agentId: targetAgentId,
        agentVersion: targetVersion.version,
        providerId: parentRun.providerId,
        model: targetVersion.model?.model || parentRun.model,
        budget: budgetResult.budget,
        workspace,
        parentTaskId: parentTask.id,
        rootTaskId,
        delegationDepth: childDepth,
        expectedOutput,
        idempotencyKey: `delegation:${parentRun.id}:${policy.sha256(`${targetAgentId}\n${objective}`).slice(0, 24)}:${Math.floor(this.now() / DEDUPE_WINDOW_MS)}`,
      });
    } catch (err) {
      return this._reject(parentRun, targetAgentId, 'CHILD_TASK_FAILED', err.message);
    }
    if (created.deduped || !created.run) {
      if (!created.deduped) {
        try { this.state.cancelTask({ taskId: created.task.id, reason: 'delegation_capacity' }); } catch { /* 刚创建 */ }
      }
      return this._reject(parentRun, targetAgentId, 'DELEGATION_CAPACITY', created.deduped ? '重复的子任务请求' : '子任务未能获得运行槽位');
    }

    const record = this.state.createDelegationRecord({
      parentTaskId: parentTask.id,
      parentRunId: parentRun.id,
      parentAgentId: parentRun.agentId,
      targetAgentId,
      targetAgentVersion: targetVersion.version,
      childTaskId: created.task.id,
      childRunId: created.run.id,
      objective,
      expectedOutput,
      contextRefs: refs.map((r) => r.display),
      budget: budgetResult.budget,
      effectiveProfile,
      toolAllow,
      depth: childDepth,
      rootTaskId,
      workspace,
    });
    created.task.delegationId = record.id;
    created.task.expectedOutput = expectedOutput;
    this.state.applyDelegationScope(created.run.id, {
      toolAllow,
      delegationId: record.id,
      effectiveProfile,
    });
    this.state.updateDelegation(record.id, {
      requestedByToolCallId: toolCall.id,
      providerId: parentRun.providerId,
      model: targetVersion.model?.model || parentRun.model,
      contextRefPaths: refs.map((r) => r.path),
      autoCreated: Boolean(autoCreated),
    });

    this.events.append({
      type: 'delegation.requested',
      taskId: parentTask.id,
      runId: parentRun.id,
      stepId: toolCall.stepId,
      payload: {
        delegationId: record.id,
        parentRunId: parentRun.id,
        childTaskId: created.task.id,
        childRunId: created.run.id,
        targetAgentId,
        targetAgentVersion: targetVersion.version,
        budget: budgetResult.budget,
        depth: childDepth,
        effectiveProfile,
        contextRefCount: refs.length,
        autoCreated: Boolean(autoCreated),
      },
    });
    return {
      ok: true,
      deduped: false,
      delegation: record,
      childTask: created.task,
      childRun: created.run,
      targetAgent: target.agent,
      targetVersion,
      parentAgent: parentAgent?.agent || null,
      autoCreated: Boolean(autoCreated),
    };
  }

  start(record) {
    if (!record || TERMINAL.has(record.status)) return record;
    record.status = 'running';
    record.startedAt = record.startedAt || this.now();
    this.state.updateDelegation(record.id, record);
    this.events.append({
      type: 'delegation.started',
      taskId: record.parentTaskId,
      runId: record.parentRunId,
      payload: {
        delegationId: record.id,
        childTaskId: record.childTaskId,
        childRunId: record.childRunId,
        targetAgentId: record.targetAgentId,
        depth: record.depth,
      },
    });
    return record;
  }

  finish(record, { status, summary = '', errorCode, artifacts = [] } = {}) {
    if (!record || TERMINAL.has(record.status)) return record;
    const finalStatus = ['succeeded', 'failed', 'canceled', 'rejected'].includes(status) ? status : 'failed';
    record.status = finalStatus;
    record.finishedAt = this.now();
    record.summary = String(summary || '').slice(0, 2000);
    record.errorCode = errorCode || undefined;
    record.artifacts = Array.isArray(artifacts) ? artifacts.slice(0, 20) : [];
    this.state.updateDelegation(record.id, record);
    this.events.append({
      type: 'delegation.finished',
      taskId: record.parentTaskId,
      runId: record.parentRunId,
      payload: {
        delegationId: record.id,
        childTaskId: record.childTaskId,
        childRunId: record.childRunId,
        targetAgentId: record.targetAgentId,
        status: finalStatus,
        summary: record.summary.slice(0, 500),
        errorCode: record.errorCode,
        artifactCount: record.artifacts.length,
      },
    });
    return record;
  }

  list(query = {}) {
    return this.state.listDelegations(query);
  }
}

module.exports = {
  DelegationService,
  MAX_DEPTH,
  MAX_ACTIVE_CHILDREN_PER_AGENT,
  MAX_DELEGATIONS_PER_RUN,
  DEFAULT_CHILD_BUDGET,
  computeChildBudget,
  ancestorAgentIds,
};
