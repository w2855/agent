'use strict';

const fs = require('node:fs');
const path = require('node:path');
const policy = require('./policy');
const { listManifests } = require('./tool-registry');
const budgetFile = require('../lib/budget-file');

/* Phase 5 委派约束：深度、环、并发、总量、预算、权限与工具收窄。
   子任务通过 StateStore.createTask({parentTaskId}) 进入同一队列。 */
/* 预算分两层，正交：
   第一层（本文件接入的持久总额层，lib/budget-file.js）：跨任务持久总额，
     budget.json 三窗口滚动（日/周/月），create() 入口先过这道门（硬停/降级），
     委派创建成功后按子任务预算预扣记账。
   第二层（既有，computeChildBudget/parentRemaining）：单次父子预算，内存态，
     决定"这一条委派最多能花多少"，由 executor 在子 Run 运行中逐步校验。
   入口顺序 = 先第一层总额门，再第二层父子预算，成功后回写第一层记账。 */

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

/* 尚未收尾的子任务实时用量：已收尾的子任务用量在 finish 时并入父 Run usage，
   这里只补充未并入部分，使父任务剩余预算覆盖父子总消耗（预算预留）。 */
function pendingChildUsage(state, parentRun) {
  const out = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
  if (!state || !parentRun?.taskId) return out;
  const delegations = state.listDelegations({ parentTaskId: parentRun.taskId, limit: 200 }).delegations;
  for (const d of delegations) {
    if (TERMINAL.has(d.status)) continue;
    const usage = d.childRunId ? state.getRun(d.childRunId)?.usage : null;
    if (!usage) continue;
    out.modelCalls += Number(usage.modelCalls) || 0;
    out.inputTokens += Number(usage.inputTokens) || 0;
    out.outputTokens += Number(usage.outputTokens) || 0;
  }
  return out;
}

function parentRemaining(parentRun, now, state) {
  const budget = parentRun?.budget && typeof parentRun.budget === 'object' ? parentRun.budget : {};
  const usage = parentRun?.usage || {};
  const child = pendingChildUsage(state, parentRun);
  const out = {};
  if (budget.maxWallClockMs) out.maxWallClockMs = Math.max(0, Number(budget.maxWallClockMs) - Math.max(0, now - (parentRun.startedAt || now)));
  if (budget.maxModelCalls) out.maxModelCalls = Math.max(0, Number(budget.maxModelCalls) - ((Number(usage.modelCalls) || 0) + child.modelCalls));
  if (budget.maxTokens) out.maxTokens = Math.max(0, Number(budget.maxTokens) - ((Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0) + child.inputTokens + child.outputTokens));
  return out;
}

function computeChildBudget(parentRun, declared, now, state) {
  const remaining = parentRemaining(parentRun, now, state);
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
  constructor({ state, events, workspacePath, budgetPath, now = Date.now } = {}) {
    this.state = state;
    this.events = events;
    this.workspacePath = workspacePath || process.cwd();
    this.now = now;
    /* 第一层持久预算的 budget.json 路径：调用方可显式覆盖；默认与 state.json
       同目录（运行时目录内），拿不到（无 state）时为 null → 预算层整体跳过。 */
    this.budgetPath = budgetPath
      || (state && state.dir ? path.join(state.dir, 'budget.json') : null);
  }

  /* 第一层持久预算门：读 budget.json → 滚动过期窗口 → 硬停阶梯判定。
     返回 { action: 'allow'|'hard-stop'|'fallback', exceededWindows, fallbackModel }。
     只读文件不写入；任何异常向上抛，由 create() 里的 try/catch 吞掉，
     保证预算层故障不影响既有事件链与审批逻辑。 */
  _checkPersistentBudget() {
    if (!this.budgetPath) return { action: 'allow', exceededWindows: [], fallbackModel: '' };
    const budget = budgetFile.loadBudget(this.budgetPath);
    const gate = budgetFile.checkBudget(budget, this.now());
    return { action: gate.action, exceededWindows: gate.exceededWindows, fallbackModel: budget.fallbackModel || '' };
  }

  /* 第一层持久预算记账：按本次委派的子任务预算上限预扣 tokens（宁多勿少）。
     取舍：实际消耗仍以现有 usage 统计为准（finish → mergeChildUsage 并入父 Run
     usage），持久层不做二次扣减，避免双记账；这里的预扣只用于跨任务总额的
     硬停/降级判定。去重命中 / 续跑路径不重复记账（首次创建时已按全额预扣）。
     写失败向上抛，由 create() 里的 try/catch 吞掉。 */
  _spendPersistentBudget(childBudget) {
    if (!this.budgetPath) return;
    const tokens = Math.max(0, Number(childBudget && childBudget.maxTokens) || 0);
    if (tokens > 0) budgetFile.spend(this.budgetPath, { tokens }, this.now());
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

    /* ── 第一层：持久成本预算总额门（跨任务，budget.json 日/周/月三窗口滚动）──
       在任何状态变更（含自动创建子 Agent）之前判定；超限 + hardStop → 走现有
       拒绝返回风格直接拒绝；超限 + 配置 fallbackModel → 记录降级意图，在模型
       可替换处生效（自动创建 = 模型本可自由指定；既有目标 = 委派记录的 model
       字段就是子运行实际使用的模型，agent-runner 读取它）。预算层任何异常都在
       这里吞掉，不影响主链路。 */
    let budgetFallback = '';      /* 非空 = 本次委派模型应降级为该值（已通过合法性校验） */
    let budgetExceededDesc = '';  /* 超限窗口描述，拒绝 reason / warning 文案复用 */
    try {
      const gate = this._checkPersistentBudget();
      if (gate.action === 'hard-stop') {
        return this._reject(parentRun, targetAgentId, 'BUDGET_HARD_STOP',
          `持久成本预算超限（${gate.exceededWindows.join('、') || '未知'} 窗口），已拒绝新建委派`);
      }
      if (gate.action === 'fallback') {
        budgetExceededDesc = gate.exceededWindows.join('、') || '未知';
        /* 模型名合法 → 可替换；非法 → 保持原模型，仅在结果/事件附 warning（不可替换分支） */
        if (budgetFile.MODEL_RE.test(gate.fallbackModel)) budgetFallback = gate.fallbackModel;
      }
    } catch { /* 预算层故障：放行，不影响委派主链路 */ }

    let autoCreated = null;
    if (autoCreate) {
      /* 持久预算降级时直接用 fallbackModel：新建子 Agent 的模型本来就由本次委派指定 → 可替换 */
      const requestedModel = budgetFallback || String(args.model || '').trim().slice(0, 128);
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
    const budgetResult = computeChildBudget(parentRun, declared, this.now(), this.state);
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

    /* 持久预算降级（在第二层父子预算通过后仍生效）：委派记录的 model 字段就是
       子运行实际使用的模型（agent-runner 读取 delegation.model），在此替换即可，
       不改动目标 Agent 版本本身；fallback 名非法（不可替换）时保持原模型。
       F2：args.model 是「该连接下的模型名」，跨接入点委派（args.profileId 指定
       其他连接）时必须优先于目标 Agent 旧版本里记录的模型（那是旧连接下的名字）。 */
    const childModel = budgetFallback
      || (String(args.model || '').trim() || targetVersion.model?.model || parentRun.model);
    const budgetWarning = budgetFallback
      ? `持久成本预算超限（${budgetExceededDesc} 窗口），委派模型已降级为 ${budgetFallback}`
      : (budgetExceededDesc ? `持久成本预算超限（${budgetExceededDesc} 窗口），fallback 模型名非法，保持原模型` : '');

    const rootTaskId = parentTask.rootTaskId || parentTask.id;
    let created;
    try {
      created = this.state.createTask({
        title: `委派 · ${objective.replace(/\s+/g, ' ').slice(0, 24)}`,
        input: objective,
        agentId: targetAgentId,
        agentVersion: targetVersion.version,
        providerId: parentRun.providerId,
        model: childModel,
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
      model: childModel,
      // F2 跨接入点委派：记录子 Agent 实际使用的连接（profileId）。
      // key/baseUrl 不落盘（安全）：每次请求时由 runtime 经主进程解析器现取现用。
      profileId: String(args.profileId || '').trim() || undefined,
      contextRefPaths: refs.map((r) => r.path),
      autoCreated: Boolean(autoCreated),
      ...(budgetWarning ? { budgetWarning } : {}),
    });

    /* ── 第一层记账：两层预算都通过、委派已实际创建 → 按子任务预算预扣 tokens
       （宁多勿少；实际消耗以现有 usage 统计为准，持久层不二次扣减）。
       去重命中 / 续跑路径在上面已提前返回，不会走到这里，不重复记账。
       记账失败只吞掉，不影响已创建的委派。 */
    try { this._spendPersistentBudget(budgetResult.budget); } catch { /* 记账失败不影响委派创建 */ }

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
        ...(budgetWarning ? { budgetWarning } : {}),
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
      ...(budgetWarning ? { budgetWarning } : {}),
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
    // 子任务收尾：把子 Run 用量增量并入父 Run usage（幂等），父任务与 UI 才能看到真实消耗
    this.state.mergeChildUsage(record);
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
