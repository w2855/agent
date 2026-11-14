'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { EventStore } = require('./events');
const { StateStore } = require('./state');
const { ToolExecutor } = require('./executor');
const { AuditStore, projectEvent } = require('./audit');
const { projectGraph } = require('./graph');
const { DelegationService } = require('./delegation');
const { runAgentTask } = require('./agent-runner');
const { ProjectService } = require('./project');
const policy = require('./policy');
const registry = require('./tool-registry');
const model = require('./model');
const ids = require('./ids');
const { isMaskedKey } = require('../lib/secret-mask');

const API_VERSION = '0.1';
const RUNTIME_VERSION = '0.2.0';

function ok(data) {
  return { ok: true, data };
}

function fail(code, err) {
  return { ok: false, error: { code, message: err?.message || String(err || code) } };
}

class Runtime {
  constructor({ dir, workspacePath, workspaceId, executeTool, modelRequest, resolveSecretKey } = {}) {
    this.dir = dir;
    this.workspacePath = workspacePath || process.cwd();
    this.store = new EventStore({ dir, workspaceId });
    this.stateStore = new StateStore({ dir, events: this.store });
    this.audit = new AuditStore({ dir: path.join(dir, 'audit') });
    this.executor = null;
    this.executeToolImpl = executeTool || null;
    this.modelRequest = typeof modelRequest === 'function' ? modelRequest : null;
    // F2 修复：主进程注入的密钥解析器（profileId → { baseUrl, key } | null）。
    // 未注入（单测 / 旧调用方）时视为 no-op：解析步骤直接跳过，保持旧行为。
    this.resolveSecretKey = typeof resolveSecretKey === 'function' ? resolveSecretKey : null;
    this.providerConfigs = new Map();
    this.delegations = null;
    this.projects = null;
  }

  init() {
    this.store.init();
    this.audit.init();
    // 先订阅再加载状态，确保恢复与默认 Agent 事件也进入审计链
    this.store.subscribe((event) => {
      try {
        const record = projectEvent(event);
        if (record) this.audit.append(record);
      } catch { /* 审计失败不能影响运行 */ }
    });
    this.stateStore.init();
    if (typeof this.executeToolImpl === 'function') {
      this.executor = new ToolExecutor({
        state: this.stateStore,
        events: this.store,
        executeTool: this.executeToolImpl,
        workspacePath: this.workspacePath,
        workspaceId: this.workspaceId,
      });
    }
    this.delegations = new DelegationService({
      state: this.stateStore,
      events: this.store,
      workspacePath: this.workspacePath,
    });
    this.projects = new ProjectService({
      state: this.stateStore,
      events: this.store,
      workspacePath: this.workspacePath,
    });
    return this;
  }

  get workspaceId() {
    return this.store.workspaceId;
  }

  health() {
    let verify = { ok: false, gaps: [], duplicates: [], malformed: 0 };
    try { verify = this.store.verify(); } catch { /* 读取失败按 degraded 处理 */ }
    let auditVerify = { ok: false, issues: [], malformed: 0, lastSeq: 0 };
    try { auditVerify = this.audit.verify(); } catch { /* 审计读取失败同样降级 */ }
    const stats = this.store.stats();
    return {
      ok: true,
      data: {
        status: this.store.ready && verify.ok ? 'ok' : 'degraded',
        runtimeVersion: RUNTIME_VERSION,
        apiVersion: API_VERSION,
        store: {
          eventLogOk: verify.ok,
          lastSeq: this.store.lastSeq,
          malformedLines: verify.malformed,
          files: stats.files,
          bytes: stats.bytes,
        },
        audit: {
          ok: auditVerify.ok,
          lastSeq: auditVerify.lastSeq,
          issues: auditVerify.issues.length,
          malformedLines: auditVerify.malformed,
        },
        state: this.stateStore.stats(),
        queue: this.stateStore.queueStats(),
        providers: this.stateStore.listProviders().map((p) => ({ id: p.id, name: p.name })),
      },
    };
  }

  append(input) {
    return this.store.append(input);
  }

  read(query) {
    return this.store.read(query);
  }

  subscribe(fn) {
    return this.store.subscribe(fn);
  }

  evaluateTool(input) {
    return policy.evaluatePolicy({
      profile: input.profile,
      tool: input.tool,
      args: input.args,
      agentId: input.agentId,
      runId: input.runId,
      context: input.context,
      workspace: this.workspacePath,
      workspaceId: this.workspaceId,
    });
  }

  listTools() {
    return registry.listManifests();
  }

  /* ---------------- Task / Run ---------------- */

  createTask(input = {}) {
    try {
      const rawProvider = typeof input.providerId === 'string' ? input.providerId : '';
      const providerId = /^https?:\/\//i.test(rawProvider) ? 'prov_' + policy.sha256(rawProvider).slice(0, 16) : rawProvider;
      if (providerId && /^https?:\/\//i.test(rawProvider)) {
        this.stateStore.registerProvider(rawProvider, providerId);
      }
      const { task, run, deduped } = this.stateStore.createTask({
        title: input.title,
        input: input.input,
        agentId: typeof input.agentId === 'string' ? input.agentId : undefined,
        workspace: typeof input.workspace === 'string' ? input.workspace : undefined,
        providerId,
        model: input.model,
        parentTaskId: input.parentTaskId,
        idempotencyKey: input.idempotencyKey,
        budget: input.budget,
        priority: input.priority,
      });
      return ok({ task, run, deduped });
    } catch (err) { return fail('TASK_CREATE_FAILED', err); }
  }

  /* ---------------- Agent / Provider ---------------- */

  listAgents() {
    try {
      return ok({ agents: this.stateStore.listAgents(), defaultAgentId: this.stateStore.defaultAgentId || null });
    } catch (err) { return fail('INTERNAL', err); }
  }

  getAgent(agentId) {
    try {
      const data = this.stateStore.getAgent(String(agentId || ''));
      if (!data) return fail('AGENT_NOT_FOUND', 'Agent 不存在');
      return ok(data);
    } catch (err) { return fail('INTERNAL', err); }
  }

  createAgentVersion(input = {}) {
    try {
      const version = this.stateStore.createAgentVersion({
        agentId: String(input.agentId || ''),
        patch: input.patch && typeof input.patch === 'object' ? input.patch : {},
      });
      return ok({ version });
    } catch (err) { return fail('AGENT_VERSION_FAILED', err); }
  }

  createAgent(input = {}) {
    try {
      // 表单可能以 baseUrl 作为 providerId：统一派生 prov_ 标识并注册，保证委派可解析
      if (input.model && typeof input.model === 'object' && /^https?:\/\//i.test(String(input.model.providerId || ''))) {
        const baseUrl = String(input.model.providerId).trim();
        const providerId = 'prov_' + policy.sha256(baseUrl).slice(0, 16);
        this.stateStore.registerProvider(baseUrl, providerId);
        input.model.providerId = providerId;
        if (input.provider && typeof input.provider === 'object' && !this.providerConfigs.get(providerId)) {
          const cfg = this._normalizeProviderConfig({ ...input.provider, baseUrl });
          if (cfg) this.providerConfigs.set(providerId, cfg);
        }
      }
      const result = this.stateStore.createAgent(input);
      return ok(result);
    } catch (err) { return fail('AGENT_CREATE_FAILED', err); }
  }

  updateAgent(input = {}) {
    try {
      const result = this.stateStore.updateAgent(input);
      return ok(result);
    } catch (err) { return fail('AGENT_UPDATE_FAILED', err); }
  }

  archiveAgent(agentId) {
    try {
      const agent = this.stateStore.archiveAgent(String(agentId || ''));
      return ok({ agent });
    } catch (err) { return fail('AGENT_ARCHIVE_FAILED', err); }
  }

  listProviders() {
    try {
      return ok({ providers: this.stateStore.listProviders() });
    } catch (err) { return fail('INTERNAL', err); }
  }

  listTasks(query = {}) {
    try {
      return ok(this.stateStore.listTasks({
        limit: Number(query.limit) || 50,
        status: typeof query.status === 'string' ? query.status : undefined,
        agentId: typeof query.agentId === 'string' ? query.agentId : undefined,
      }));
    } catch (err) { return fail('INTERNAL', err); }
  }

  getTask(taskId) {
    try {
      const task = this.stateStore.getTask(String(taskId || ''));
      if (!task) return fail('TASK_NOT_FOUND', '任务不存在');
      const runs = this.stateStore.listRuns({ taskId: task.id, limit: 20 }).runs;
      const runDetails = runs.map((r) => this.stateStore.getRunDetail(r.id));
      const delegations = this.stateStore.listDelegations({ parentTaskId: task.id, limit: 50 }).delegations;
      const children = Object.values(this.stateStore.state.tasks).filter((t) => t.parentTaskId === task.id);
      return ok({ task, runs, details: runDetails, delegations, children });
    } catch (err) { return fail('INTERNAL', err); }
  }

  listDelegations(query = {}) {
    try {
      return ok(this.stateStore.listDelegations({
        parentRunId: typeof query.parentRunId === 'string' ? query.parentRunId : undefined,
        parentTaskId: typeof query.parentTaskId === 'string' ? query.parentTaskId : undefined,
        childTaskId: typeof query.childTaskId === 'string' ? query.childTaskId : undefined,
        status: typeof query.status === 'string' ? query.status : undefined,
        limit: Number(query.limit) || 50,
      }));
    } catch (err) { return fail('INTERNAL', err); }
  }

  getDelegation(delegationId) {
    try {
      const delegation = this.stateStore.getDelegation(String(delegationId || ''));
      if (!delegation) return fail('DELEGATION_NOT_FOUND', '委派不存在');
      return ok({
        delegation,
        childTask: this.stateStore.getTask(delegation.childTaskId) || null,
        childRun: delegation.childRunId ? this.stateStore.getRun(delegation.childRunId) : null,
      });
    } catch (err) { return fail('INTERNAL', err); }
  }

  /* ---------------- Project / 主控 Agent ---------------- */

  ensureProject(input = {}) {
    try {
      const workspace = typeof input.workspace === 'string' && input.workspace ? input.workspace : this.workspacePath;
      const project = this.projects.ensure(workspace, {
        mainAgentId: typeof input.mainAgentId === 'string' ? input.mainAgentId : undefined,
        // 会话隔离：渲染层可带 sessionId 让每个会话独享架构；省略时保持共享行为
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
      });
      return ok(this.projects.get(project.id));
    } catch (err) { return fail('PROJECT_ENSURE_FAILED', err); }
  }

  listProjects() {
    try { return ok({ projects: this.projects.list() }); }
    catch (err) { return fail('INTERNAL', err); }
  }

  getProject(projectId) {
    try {
      const data = this.projects.get(String(projectId || ''));
      if (!data) return fail('PROJECT_NOT_FOUND', '项目不存在');
      return ok(data);
    } catch (err) { return fail('INTERNAL', err); }
  }

  updateProject(input = {}) {
    try {
      const project = this.projects.update(String(input.projectId || ''), input);
      return ok(project);
    } catch (err) { return fail('PROJECT_UPDATE_FAILED', err); }
  }

  cancelTask(input = {}) {
    try {
      const task = this.stateStore.cancelTask({
        taskId: String(input.taskId || ''),
        reason: typeof input.reason === 'string' ? input.reason : 'user_canceled',
      });
      return ok({ task });
    } catch (err) { return fail('TASK_CANCEL_FAILED', err); }
  }

  pauseTask(input = {}) {
    try {
      const task = this.stateStore.pauseTask({
        taskId: String(input.taskId || ''),
        reason: typeof input.reason === 'string' ? input.reason : 'user_paused',
      });
      return ok({ task });
    } catch (err) { return fail('TASK_PAUSE_FAILED', err); }
  }

  resumeTask(input = {}) {
    try {
      const result = this.stateStore.resumeTask({
        taskId: String(input.taskId || ''),
        reason: typeof input.reason === 'string' ? input.reason : 'user_resumed',
      });
      return ok(result);
    } catch (err) { return fail('TASK_RESUME_FAILED', err); }
  }

  getSettings() {
    try { return ok(this.stateStore.getSettings()); } catch (err) { return fail('INTERNAL', err); }
  }

  setSettings(input = {}) {
    try { return ok(this.stateStore.setSettings({ maxConcurrentRuns: input.maxConcurrentRuns })); }
    catch (err) { return fail('SETTINGS_FAILED', err); }
  }

  reconcileTool(input = {}) {
    try {
      const call = this.stateStore.reconcileToolCall({
        toolCallId: String(input.toolCallId || ''),
        outcome: String(input.outcome || ''),
        reason: input.reason,
      });
      return ok({ toolCall: call });
    } catch (err) { return fail('TOOL_RECONCILE_FAILED', err); }
  }

  getRun(runId) {
    try {
      const detail = this.stateStore.getRunDetail(String(runId || ''));
      if (!detail) return fail('RUN_NOT_FOUND', '运行不存在');
      return ok(detail);
    } catch (err) { return fail('INTERNAL', err); }
  }

  runGraph(input = {}) {
    try {
      const runId = String(input.runId || '');
      const detail = this.stateStore.getRunDetail(runId);
      if (!detail) return fail('RUN_NOT_FOUND', '运行不存在');
      const all = this.store.read({ runId, limit: 5000 }).events;
      const lastSeq = all.length ? all[all.length - 1].seq : 0;
      const beforeSeq = Number.isInteger(input.beforeSeq) ? Math.min(input.beforeSeq, lastSeq) : lastSeq;
      const visible = all.filter((e) => e.seq <= beforeSeq);
      const graph = projectGraph(visible, {
        runId,
        title: detail.task?.title,
        model: detail.run?.model,
        startedAt: detail.run?.startedAt,
      });
      return ok({
        graph,
        beforeSeq,
        lastSeq,
        totalEvents: all.length,
        hasMore: beforeSeq < lastSeq,
      });
    } catch (err) { return fail('GRAPH_PROJECTION_FAILED', err); }
  }

  beginStep(input = {}) {
    try {
      const step = this.stateStore.beginStep({
        runId: String(input.runId || ''),
        kind: String(input.kind || 'model'),
        index: Number.isInteger(input.index) ? input.index : undefined,
      });
      return ok({ step });
    } catch (err) { return fail('STEP_BEGIN_FAILED', err); }
  }

  finishStep(input = {}) {
    try {
      const step = this.stateStore.finishStep({
        stepId: String(input.stepId || ''),
        status: String(input.status || 'succeeded'),
        modelCallId: input.modelCallId,
        toolCallIds: Array.isArray(input.toolCallIds) ? input.toolCallIds : undefined,
      });
      return ok({ step });
    } catch (err) { return fail('STEP_FINISH_FAILED', err); }
  }

  modelStart(input = {}) {
    try {
      const meta = input.meta && typeof input.meta === 'object' ? input.meta : {};
      const digest = policy.sha256(JSON.stringify(meta));
      const call = this.stateStore.beginModelCall({
        runId: String(input.runId || ''),
        stepId: String(input.stepId || ''),
        providerId: input.providerId,
        model: input.model,
        messageCount: input.messageCount,
        approxInputTokens: input.approxInputTokens,
        requestDigest: digest,
      });
      return ok({ modelCallId: call.id });
    } catch (err) { return fail('MODEL_CALL_BEGIN_FAILED', err); }
  }

  modelFinish(input = {}) {
    try {
      const call = this.stateStore.finishModelCall({
        modelCallId: String(input.modelCallId || ''),
        status: String(input.status || 'completed'),
        usage: input.usage,
        finishReason: input.finishReason,
        error: input.error,
        attempts: input.attempts,
      });
      return ok({ modelCall: call });
    } catch (err) { return fail('MODEL_CALL_FINISH_FAILED', err); }
  }

  _validationChecks(runId) {
    const events = this.store.read({ runId, limit: 5000 }).events;
    const checks = [];

    const detail = this.stateStore.getRunDetail(runId);
    let commandIndex = 0;
    let httpIndex = 0;
    for (const call of detail?.toolCalls || []) {
      if (call.status !== 'succeeded') continue;
      const meta = call.resultMeta || {};
      if (call.name === 'run_command' && Number.isInteger(meta.exitCode)) {
        commandIndex += 1;
        checks.push({
          name: `command:${commandIndex}`,
          status: meta.exitCode === 0 ? 'passed' : 'failed',
          detail: `退出码 ${meta.exitCode}`,
        });
      }
      if (call.name === 'fetch_url' && Number.isFinite(meta.httpStatus)) {
        httpIndex += 1;
        checks.push({
          name: `http:${httpIndex}`,
          status: meta.httpStatus < 400 ? 'passed' : 'failed',
          detail: `HTTP ${meta.httpStatus}`,
        });
      }
    }

    const delegations = this.stateStore.listDelegations({ parentRunId: runId, limit: 100 }).delegations;
    let delegationIndex = 0;
    for (const d of delegations) {
      delegationIndex += 1;
      checks.push({
        name: `delegation:${delegationIndex}`,
        status: d.status === 'succeeded' ? 'passed' : 'failed',
        detail: d.status === 'succeeded'
          ? `子 Agent ${d.targetAgentId} 已完成`
          : `子 Agent ${d.targetAgentId} 状态：${d.status}${d.errorCode ? ' · ' + d.errorCode : ''}`,
      });
    }

    // 同一路径可能被多次写入，只校验最后一次产出的哈希
    const latestByPath = new Map();
    for (const ev of events) {
      if (ev.type !== 'artifact.created') continue;
      const p = ev.payload || {};
      if (!p.path) continue;
      latestByPath.set(p.path, p);
    }
    for (const p of latestByPath.values()) {
      const name = `artifact:${path.basename(p.path)}`;
      try {
        const st = fs.statSync(p.path);
        if (!st.isFile()) { checks.push({ name, status: 'failed', detail: '产物不是普通文件' }); continue; }
        if (Number.isFinite(p.size) && st.size !== p.size) {
          checks.push({ name, status: 'failed', detail: `文件大小不一致（记录 ${p.size}，实际 ${st.size}）` });
          continue;
        }
        const actual = policy.sha256(fs.readFileSync(p.path));
        const expected = String(p.sha256 || '');
        if (!expected || actual === expected) {
          checks.push({ name, status: 'passed', detail: expected ? '文件存在且哈希一致' : '文件存在（无哈希记录）' });
        } else {
          checks.push({ name, status: 'failed', detail: '文件哈希与写入记录不一致' });
        }
      } catch {
        checks.push({ name, status: 'failed', detail: '产物不存在或无法读取' });
      }
    }
    return checks;
  }

  finishRun(input = {}) {
    try {
      const runId = String(input.runId || '');
      const run = this.stateStore.getRun(runId);
      const wantsSucceeded = String(input.outcome || 'succeeded') === 'succeeded';
      const checks = run && wantsSucceeded && !['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.status)
        ? this._validationChecks(runId)
        : [];
      const result = this.stateStore.finishRun({
        runId,
        outcome: String(input.outcome || 'succeeded'),
        usage: input.usage,
        validated: input.validated === true,
        summary: input.summary,
        errorCode: input.errorCode,
        checks,
      });
      return ok(result);
    } catch (err) { return fail('RUN_FINISH_FAILED', err); }
  }

  /* ---------------- Tools / Approvals ---------------- */

  _normalizeProviderConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    const baseUrl = String(cfg.baseUrl || '').trim();
    const key = String(cfg.key || '').trim();
    const model = String(cfg.model || '').trim();
    // profileId 透传：F2 修复依赖它把掩码/空 key 换回明文（不参与齐全校验）
    const profileId = typeof cfg.profileId === 'string' ? cfg.profileId.trim() : '';
    if (!/^https?:\/\//i.test(baseUrl) || !model) return null;
    // key 为空仅在带 profileId 时放行（交给主进程解析器换真钥）；
    // 无 profileId 时维持「key 必填」的旧校验，现有失败行为不变。
    if (!key && !profileId) return null;
    const out = { baseUrl, key, model, retry: cfg.retry };
    if (profileId) out.profileId = profileId;
    return out;
  }

  /**
   * F2 修复：按 profileId 向主进程解析真实连接配置。
   * 返回 { baseUrl, key } | null；解析器未注入或调用失败一律按 null 处理（保留原值 + warn）。
   */
  async _resolveProfileSecret(profileId) {
    if (!profileId || typeof this.resolveSecretKey !== 'function') return null;
    try {
      const resolved = await this.resolveSecretKey(profileId);
      if (resolved && typeof resolved === 'object' && typeof resolved.key === 'string' && resolved.key) {
        return { baseUrl: String(resolved.baseUrl || '').trim(), key: resolved.key };
      }
      return null;
    } catch (err) {
      console.warn('[runtime] 按 profileId 解析 API Key 失败：', err?.message || err);
      return null;
    }
  }

  async _providerConfigForRun(run, supplied) {
    const normalized = this._normalizeProviderConfig(supplied)
      || (run?.providerId ? this.providerConfigs.get(run.providerId) : null)
      || null;
    if (!normalized) return null;
    // F2 修复：掩码/空 key 换真钥。R7-secrets 迁移后渲染层 profiles 只剩掩码，
    // 委派链把掩码直接发上游必然 401；cfg 带 profileId 且 key 是掩码（或为空）时，
    // 用主进程注入的解析器换回明文。解析失败保留原值并警告，不中断委派创建。
    let cfg = normalized;
    if (cfg.profileId && (!cfg.key || isMaskedKey(cfg.key))) {
      const resolved = await this._resolveProfileSecret(cfg.profileId);
      if (resolved) {
        cfg = {
          ...cfg,
          key: resolved.key,
          // 解析器给出 baseUrl 时以 profile 为准（跨接入点委派场景）
          baseUrl: resolved.baseUrl || cfg.baseUrl,
        };
      } else {
        console.warn(`[runtime] profile ${cfg.profileId} 的 API Key 解析失败，保留原值（可能是掩码）`);
      }
    }
    if (run?.providerId) this.providerConfigs.set(run.providerId, cfg);
    return cfg;
  }

  _toolPreview(text) {
    const s = String(text == null ? '' : text);
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  }

  _formatDelegationContent(record, childTask, agentName) {
    const lines = [];
    lines.push(`子任务${record.status === 'succeeded' ? '完成' : '未成功'}：${childTask?.title || record.objective.slice(0, 60)}`);
    lines.push(`目标 Agent：${agentName || record.targetAgentId}（${record.targetAgentId}）${record.autoCreated ? ' · 本次自动创建' : ''}`);
    if (record.model && record.model !== childTask?.model) lines.push(`模型：${record.model}`);
    lines.push(`状态：${record.status}${record.errorCode ? ' · ' + record.errorCode : ''}`);
    lines.push(`摘要：${record.summary || '（无）'}`);
    const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
    if (artifacts.length) lines.push(`产物：${artifacts.map((a) => a.path).filter(Boolean).join('、')}`);
    lines.push(`子任务 ID：${record.childTaskId} · Run：${record.childRunId}`);
    return lines.join('\n');
  }

  async runProjectTool(input = {}) {
    const call = this.stateStore.getToolCall(String(input.toolCallId || ''));
    if (!call) return { ok: false, code: 'TOOL_CALL_NOT_FOUND', message: `工具调用不存在：${input.toolCallId}` };
    if (call.name !== 'project_architecture') return { ok: false, code: 'INVALID_TOOL', message: '该工具调用不是 project_architecture' };
    if (call.status === 'succeeded') {
      return { ok: true, toolCallId: call.id, cached: true, content: call.resultPreview || '', meta: call.resultMeta || {}, status: 'succeeded' };
    }
    if (['failed', 'denied', 'canceled'].includes(call.status)) {
      return {
        ok: false,
        toolCallId: call.id,
        code: call.failureCode || (call.status === 'canceled' ? 'CANCELED' : 'DENIED'),
        message: call.failureMessage || '架构工具调用已结束',
        content: call.resultPreview || '',
        status: call.status,
      };
    }
    if (call.status === 'waiting_approval') {
      return { ok: false, code: 'APPROVAL_REQUIRED', message: '架构更新正在等待人工审批', toolCallId: call.id };
    }
    if (call.status !== 'ready') {
      return { ok: false, code: 'INVALID_STATE', message: `架构工具状态不可执行：${call.status}`, toolCallId: call.id };
    }

    const run = this.stateStore.getRun(call.runId);
    if (!run) return { ok: false, code: 'RUN_NOT_FOUND', message: '运行不存在' };
    const workspace = run.workspace || this.workspacePath;

    this.stateStore.setToolCallStatus(call.id, 'executing', { executedAt: this.stateStore.now() });
    this.store.append({
      type: 'tool.started', taskId: call.taskId, runId: call.runId, stepId: call.stepId,
      payload: { toolCallId: call.id, name: call.name, idempotencyKey: call.idempotencyKey },
    });

    let result;
    try {
      if (run.delegationId) throw new Error('子 Agent 不能修改项目整体架构');
      // 会话隔离：工具 args 里带 sessionId 时按「工作区+会话」定位项目；省略时保持共享行为
      const argsSessionId = typeof call.args?.sessionId === 'string' ? call.args.sessionId : undefined;
      const project = this.projects.ensure(workspace, { mainAgentId: run.agentId, sessionId: argsSessionId });
      if (project.mainAgentId !== run.agentId) {
        throw new Error(`只有主控 Agent（${project.mainAgentId}）可以更新项目架构`);
      }
      result = this.projects.applyArchitecture({ workspace, agentId: run.agentId, args: call.args });
    } catch (err) {
      const code = 'PROJECT_ARCHITECTURE_FAILED';
      const message = String(err?.message || err).slice(0, 500);
      this.stateStore.setToolCallStatus(call.id, 'failed', { failureCode: code, failureMessage: message });
      this.store.append({
        type: 'tool.failed', taskId: call.taskId, runId: call.runId, stepId: call.stepId,
        payload: { toolCallId: call.id, code, message, retryable: false },
      });
      return { ok: false, toolCallId: call.id, code, message, content: `项目架构更新失败：${message}`, status: 'failed' };
    }

    const project = result.project;
    const content = result.summary;
    const meta = {
      label: `${project.nodes.length} 个模块 · ${project.edges.length} 条依赖`,
      projectId: project.id,
      revision: project.revision,
      nodeCount: project.nodes.length,
      edgeCount: project.edges.length,
    };
    this.stateStore.setToolCallStatus(call.id, 'succeeded', {
      resultPreview: this._toolPreview(content),
      resultMeta: meta,
      resultDigest: policy.sha256(content),
    });
    this.store.append({
      type: 'tool.completed', taskId: call.taskId, runId: call.runId, stepId: call.stepId,
      payload: {
        toolCallId: call.id,
        resultCode: 'OK',
        summary: `项目架构更新至 revision ${project.revision}`,
        digest: policy.sha256(content),
        artifactIds: [],
      },
    });
    return { ok: true, toolCallId: call.id, content, meta, status: 'succeeded', project };
  }

  async runDelegationTool(input = {}) {
    const call = this.stateStore.getToolCall(String(input.toolCallId || ''));
    if (!call) return { ok: false, code: 'TOOL_CALL_NOT_FOUND', message: `工具调用不存在：${input.toolCallId}` };
    if (call.name !== 'delegate_task') return { ok: false, code: 'INVALID_TOOL', message: '该工具调用不是 delegate_task' };
    const existingDelegation = Object.values(this.stateStore.state.delegations)
      .find((d) => d.requestedByToolCallId === call.id);
    if (call.status === 'succeeded') {
      return { ok: true, toolCallId: call.id, cached: true, content: call.resultPreview || '', meta: call.resultMeta || {}, status: 'succeeded', delegation: existingDelegation };
    }
    if (['failed', 'denied', 'canceled'].includes(call.status)) {
      return {
        ok: false,
        toolCallId: call.id,
        code: call.failureCode || (call.status === 'canceled' ? 'CANCELED' : 'DENIED'),
        message: call.failureMessage || '委派工具调用已结束',
        content: call.resultPreview || '',
        status: call.status,
        delegation: existingDelegation,
      };
    }
    if (call.status === 'waiting_approval') {
      return { ok: false, code: 'APPROVAL_REQUIRED', message: '委派正在等待人工审批', toolCallId: call.id };
    }
    if (call.status !== 'ready') {
      return { ok: false, code: 'INVALID_STATE', message: `委派工具状态不可执行：${call.status}`, toolCallId: call.id };
    }

    const run = this.stateStore.getRun(call.runId);
    if (!run) return { ok: false, code: 'RUN_NOT_FOUND', message: '父运行不存在' };

    this.stateStore.setToolCallStatus(call.id, 'executing', { executedAt: this.stateStore.now() });
    this.store.append({
      type: 'tool.started', taskId: call.taskId, runId: call.runId, stepId: call.stepId,
      payload: { toolCallId: call.id, name: call.name, idempotencyKey: call.idempotencyKey },
    });

    let cfg = await this._providerConfigForRun(run, input.providerConfig);
    // 跨接入点委派：delegate_task args.profileId 指定目标连接时，
    // baseUrl + key 都从主进程按该 profile 解析（key 明文，不落盘、不回传渲染层）；
    // 模型名取 delegation.model（delegation.js 已按 args.model 记录）。
    // 解析失败直接拒绝本次委派——把父会话的 key 发到错误端点比失败更糟。
    const argProfileId = typeof call.args?.profileId === 'string' ? call.args.profileId.trim() : '';
    if (argProfileId) {
      const resolved = await this._resolveProfileSecret(argProfileId);
      if (!resolved || !resolved.baseUrl) {
        const message = `指定的连接不可用（profileId=${argProfileId}），无法启动子 Agent`;
        this.stateStore.setToolCallStatus(call.id, 'failed', { failureCode: 'PROFILE_UNRESOLVED', failureMessage: message });
        this.store.append({
          type: 'tool.failed', taskId: call.taskId, runId: call.runId, stepId: call.stepId,
          payload: { toolCallId: call.id, code: 'PROFILE_UNRESOLVED', message, retryable: false },
        });
        return { ok: false, code: 'PROFILE_UNRESOLVED', message };
      }
      cfg = {
        ...(cfg || {}),
        baseUrl: resolved.baseUrl,
        key: resolved.key,
        // 模型优先沿用已有 cfg，其次 delegate_task 的 args.model（该连接下的模型名）
        model: cfg?.model || String(call.args?.model || '').trim(),
      };
    }
    if (!cfg) {
      this.stateStore.setToolCallStatus(call.id, 'failed', { failureCode: 'PROVIDER_CONFIG_MISSING', failureMessage: '缺少模型连接配置' });
      this.store.append({
        type: 'tool.failed', taskId: call.taskId, runId: call.runId, stepId: call.stepId,
        payload: { toolCallId: call.id, code: 'PROVIDER_CONFIG_MISSING', message: '缺少模型连接配置，无法启动子 Agent', retryable: false },
      });
      return { ok: false, code: 'PROVIDER_CONFIG_MISSING', message: '缺少模型连接配置，无法启动子 Agent' };
    }

    const created = this.delegations.create({
      parentRunId: call.runId,
      toolCallId: call.id,
      args: call.args,
    });
    if (!created.ok) {
      this.stateStore.setToolCallStatus(call.id, 'failed', { failureCode: created.code, failureMessage: created.message });
      this.store.append({
        type: 'tool.failed', taskId: call.taskId, runId: call.runId, stepId: call.stepId,
        payload: { toolCallId: call.id, code: created.code, message: created.message, retryable: false },
      });
      return { ok: false, code: created.code, message: created.message, content: `委派失败：${created.message}`, status: 'failed' };
    }

    let result;
    if (created.deduped) {
      result = created.delegation;
    } else {
      result = await runAgentTask({
        runtime: this,
        delegation: created.delegation,
        providerConfig: cfg,
      });
    }

    const agentName = this.stateStore.getAgent(result.targetAgentId)?.agent?.name || result.targetAgentId;
    const childTask = this.stateStore.getTask(result.childTaskId);
    const content = this._formatDelegationContent(result, childTask, agentName);
    const current = this.stateStore.getToolCall(call.id);
    if (!current || ['canceled', 'failed', 'denied'].includes(current.status)) {
      return {
        ok: false,
        toolCallId: call.id,
        code: current?.failureCode || (current?.status === 'canceled' ? 'CANCELED' : 'DELEGATION_FAILED'),
        message: current?.failureMessage || result.errorCode || '委派已取消',
        content,
        status: current?.status || 'canceled',
        delegation: result,
      };
    }
    if (result.status === 'succeeded') {
      const meta = { label: `${agentName} · 已完成` };
      this.stateStore.setToolCallStatus(call.id, 'succeeded', {
        resultPreview: this._toolPreview(content),
        resultMeta: meta,
        resultDigest: policy.sha256(content),
      });
      this.store.append({
        type: 'tool.completed', taskId: call.taskId, runId: call.runId, stepId: call.stepId,
        payload: {
          toolCallId: call.id,
          resultCode: 'OK',
          summary: `委派给 ${agentName} 完成`.slice(0, 200),
          digest: policy.sha256(content),
          artifactIds: (result.artifacts || []).map((a) => a.artifactId).filter(Boolean),
        },
      });
      return { ok: true, toolCallId: call.id, content, meta, status: 'succeeded', delegation: result };
    }

    const to = result.status === 'canceled' ? 'canceled' : 'failed';
    const code = result.errorCode || 'DELEGATION_FAILED';
    const message = result.summary || `委派给 ${agentName} 未成功`;
    this.stateStore.setToolCallStatus(call.id, to, { failureCode: code, failureMessage: message });
    this.store.append({
      type: to === 'canceled' ? 'tool.canceled' : 'tool.failed',
      taskId: call.taskId, runId: call.runId, stepId: call.stepId,
      payload: to === 'canceled'
        ? { toolCallId: call.id, reason: code }
        : { toolCallId: call.id, code, message, retryable: false },
    });
    return { ok: false, toolCallId: call.id, code, message, content, status: to, delegation: result };
  }

  proposeTool(input = {}) {
    try {
      if (!this.executor) return fail('EXECUTOR_UNAVAILABLE', '工具执行器未初始化');
      const result = this.executor.propose({
        runId: input.runId,
        stepId: input.stepId,
        name: input.name,
        args: input.args,
        profile: input.profile,
        modelToolCallId: input.modelToolCallId,
      });
      return result.ok ? ok(result) : { ok: false, error: { code: result.code, message: result.message } };
    } catch (err) { return fail('TOOL_PROPOSE_FAILED', err); }
  }

  async executeTool(input = {}) {
    try {
      if (!this.executor) return fail('EXECUTOR_UNAVAILABLE', '工具执行器未初始化');
      const call = this.stateStore.getToolCall(String(input.toolCallId || ''));
      if (call?.name === 'project_architecture') {
        const result = await this.runProjectTool({ toolCallId: call.id });
        return ok(result);
      }
      if (call?.name === 'delegate_task') {
        const result = await this.runDelegationTool({
          toolCallId: call.id,
          providerConfig: input.providerConfig,
        });
        return ok(result);
      }
      const result = await this.executor.execute({
        toolCallId: input.toolCallId,
        approvalId: input.approvalId,
        profile: input.profile,
        workspace: input.workspace,
      });
      return ok(result);
    } catch (err) { return fail('TOOL_EXECUTE_FAILED', err); }
  }

  decideApproval(input = {}) {
    try {
      if (!this.executor) return fail('EXECUTOR_UNAVAILABLE', '工具执行器未初始化');
      const result = this.executor.decide({
        approvalId: input.approvalId,
        decision: input.decision,
        scope: input.scope,
        reason: input.reason,
        decidedBy: input.decidedBy,
      });
      return result.ok ? ok(result) : { ok: false, error: { code: result.code, message: result.message } };
    } catch (err) { return fail('APPROVAL_DECIDE_FAILED', err); }
  }

  listApprovals(query = {}) {
    try {
      return ok(this.stateStore.listApprovals({
        runId: query.runId,
        taskId: query.taskId,
        status: query.status,
      }));
    } catch (err) { return fail('INTERNAL', err); }
  }

  auditRead(query = {}) {
    try {
      const data = this.audit.read({
        afterSeq: Number.isInteger(query.afterSeq) ? query.afterSeq : 0,
        limit: Number.isInteger(query.limit) ? query.limit : 100,
      });
      return ok(data);
    } catch (err) { return fail('STORAGE_ERROR', err); }
  }

  auditVerify() {
    try {
      return ok(this.audit.verify());
    } catch (err) { return fail('STORAGE_ERROR', err); }
  }

  close() {
    this.providerConfigs.clear();
    this.stateStore.close();
    this.audit.close();
    this.store.close();
  }
}

function createRuntime(options) {
  return new Runtime(options);
}

module.exports = {
  createRuntime,
  Runtime,
  API_VERSION,
  RUNTIME_VERSION,
  ids,
  model,
  policy,
  registry,
};
