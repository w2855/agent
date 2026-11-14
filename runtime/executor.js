'use strict';

const { getManifest, validateToolArgs } = require('./tool-registry');
const policy = require('./policy');
const { newId } = require('./ids');

/* Tool Executor：每次工具调用都经过 Registry 校验、Policy 判定、审批与事件记录。
   实际执行仍复用 lib/tools.js，不重写工具实现。 */

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const RESULT_PREVIEW_CHARS = 2000;

function argsSummary(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const cut = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').slice(0, 160);
  if (name === 'write_file') return `path=${cut(a.path)} · ${String(a.content || '').length} 字符`;
  if (name === 'read_file' || name === 'list_dir' || name === 'search_files') {
    return `path=${cut(a.path || '.')}${a.query ? ` · query=${cut(a.query)}` : ''}`;
  }
  if (name === 'run_command') return `command=${cut(a.command)}`;
  if (name === 'fetch_url') return `url=${cut(a.url)}`;
  if (name === 'todo_write') return `tasks=${Array.isArray(a.tasks) ? a.tasks.length : 0}`;
  if (name === 'delegate_task') return `agent=${cut(a.agentId)} · ${cut(a.objective)}`;
  if (name === 'project_architecture') {
    return `${a.mode === 'replace' ? 'replace' : 'merge'} · ${Array.isArray(a.nodes) ? a.nodes.length : 0} 模块 · ${Array.isArray(a.edges) ? a.edges.length : 0} 依赖`;
  }
  return cut(JSON.stringify(a));
}

function preview(text) {
  const s = String(text == null ? '' : text);
  return s.length > RESULT_PREVIEW_CHARS ? s.slice(0, RESULT_PREVIEW_CHARS) + '…' : s;
}

class ToolExecutor {
  constructor({ state, events, executeTool, workspacePath, workspaceId, agentId = 'agent_local', now = Date.now, signalFor = null } = {}) {
    if (!state) throw new Error('ToolExecutor 需要 state');
    if (typeof executeTool !== 'function') throw new Error('ToolExecutor 需要 executeTool');
    this.state = state;
    this.events = events;
    this.executeTool = executeTool;
    this.workspacePath = workspacePath;
    this.workspaceId = workspaceId;
    this.agentId = agentId;
    this.now = now;
    // 取消链路：Runtime 按 runId 持有 AbortController，执行器只取信号，不自己造生命周期
    this.signalFor = typeof signalFor === 'function' ? signalFor : null;
  }

  _denyEvent(call, decision, code, message) {
    this.state.setToolCallStatus(call.id, 'denied', { deniedReason: code });
    this.events.append({
      type: 'tool.denied',
      taskId: call.taskId,
      runId: call.runId,
      stepId: call.stepId,
      payload: { toolCallId: call.id, name: call.name, code, reason: message, decision },
    });
  }

  propose(input = {}) {
    const runId = String(input.runId || '');
    const run = this.state.getRun(runId);
    if (!run) return { ok: false, code: 'RUN_NOT_FOUND', message: `运行不存在：${runId}` };
    const name = String(input.name || '');
    const stepId = input.stepId || null;
    const manifest = getManifest(name);
    const userProfile = ['full', 'ask', 'readonly'].includes(input.profile) ? input.profile : 'ask';
    const agentVersion = this.state.getAgentVersion(run.agentId, run.agentVersion);
    const profile = policy.stricterProfile(userProfile, agentVersion?.permissionProfileId);
    this.state.setRunEffectiveProfile(runId, profile);
    const toolPolicy = agentVersion?.toolPolicy || null;
    const rawArgs = input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args : {};
    const runWorkspace = run.workspace || this.workspacePath;

    const create = (fields) => {
      const call = this.state.createToolCall({
        runId,
        stepId,
        name,
        workspace: runWorkspace,
        modelToolCallId: input.modelToolCallId,
        version: manifest?.version || '0',
        args: rawArgs,
        ...fields,
      });
      this.state.setToolCallStatus(call.id, 'policy_check');
      return call;
    };

    if (!manifest) {
      const decision = {
        decision: 'deny', ruleIds: ['unknown-tool'], riskLevel: 'high',
        reason: `未注册的工具：${name}`,
        actionHash: policy.actionHash({ workspaceId: this.workspaceId, agentId: this.agentId, tool: name, version: '0', args: rawArgs, resourceKey: 'unknown' }),
        resourceKey: 'unknown',
        sideEffect: 'external', toolVersion: '0',
      };
      const call = create({ sideEffect: 'external', risk: 'high', argsDigest: policy.sha256(policy.canonicalJson(rawArgs)) });
      this.events.append({
        type: 'tool.proposed', taskId: call.taskId, runId, stepId,
        payload: { toolCallId: call.id, name, version: '0', argsDigest: call.argsDigest, argsSummary: '', sideEffect: 'external', risk: 'high' },
      });
      this._appendPolicy(call, 'pol_unknown', decision);
      this._denyEvent(call, decision, 'UNKNOWN_TOOL', decision.reason);
      return { ok: true, status: 'denied', toolCallId: call.id, policy: decision, message: decision.reason };
    }

    let validationError = '';
    try {
      validateToolArgs(name, rawArgs);
    } catch (err) {
      validationError = err.message;
    }
    if (validationError) {
      const decision = {
        decision: 'deny', ruleIds: ['invalid-args'], riskLevel: 'high',
        reason: `工具参数不合法：${validationError}`,
        actionHash: policy.actionHash({ workspaceId: this.workspaceId, agentId: this.agentId, tool: name, version: manifest.version, args: rawArgs, resourceKey: 'invalid' }),
        resourceKey: 'invalid',
        sideEffect: manifest.sideEffect, toolVersion: manifest.version,
      };
      const call = create({ sideEffect: manifest.sideEffect, risk: manifest.risk, argsDigest: policy.sha256(policy.canonicalJson(rawArgs)) });
      this.events.append({
        type: 'tool.proposed', taskId: call.taskId, runId, stepId,
        payload: { toolCallId: call.id, name, version: manifest.version, argsDigest: call.argsDigest, argsSummary: argsSummary(name, rawArgs), sideEffect: manifest.sideEffect, risk: manifest.risk },
      });
      this._appendPolicy(call, newId('pol'), decision);
      this._denyEvent(call, decision, 'INVALID_ARGS', decision.reason);
      return { ok: true, status: 'denied', toolCallId: call.id, policy: decision, message: decision.reason };
    }

    const allowList = Array.isArray(toolPolicy?.allow) ? toolPolicy.allow : null;
    const denyList = Array.isArray(toolPolicy?.deny) ? toolPolicy.deny : [];
    const agentDenied = !!toolPolicy && (denyList.includes(name) || (allowList && !allowList.includes(name)));
    if (agentDenied) {
      const decision = {
        decision: 'deny', ruleIds: ['agent-tool-policy'], riskLevel: 'high',
        reason: `Agent 配置未允许工具：${name}`,
        actionHash: policy.actionHash({ workspaceId: this.workspaceId, agentId: run.agentId, tool: name, version: manifest.version, args: rawArgs, resourceKey: `agent:${run.agentId}` }),
        resourceKey: `agent:${run.agentId}`,
        sideEffect: manifest.sideEffect, toolVersion: manifest.version,
      };
      const call = create({ sideEffect: manifest.sideEffect, risk: 'high', argsDigest: policy.sha256(policy.canonicalJson(rawArgs)) });
      this.events.append({
        type: 'tool.proposed', taskId: call.taskId, runId, stepId,
        payload: { toolCallId: call.id, name, version: manifest.version, argsDigest: call.argsDigest, argsSummary: argsSummary(name, rawArgs), sideEffect: manifest.sideEffect, risk: 'high' },
      });
      this._appendPolicy(call, newId('pol'), decision);
      this._denyEvent(call, decision, 'AGENT_TOOL_DENIED', decision.reason);
      return { ok: true, status: 'denied', toolCallId: call.id, policy: decision, message: decision.reason };
    }

    const delegationScope = Array.isArray(run.delegationToolAllow) ? run.delegationToolAllow : null;
    if (delegationScope && !delegationScope.includes(name)) {
      const decision = {
        decision: 'deny', ruleIds: ['delegation-tool-scope'], riskLevel: 'high',
        reason: `父级委派范围未允许工具：${name}`,
        actionHash: policy.actionHash({ workspaceId: this.workspaceId, agentId: run.agentId, tool: name, version: manifest.version, args: rawArgs, resourceKey: `delegation:${run.delegationId || 'unknown'}` }),
        resourceKey: `delegation:${run.delegationId || 'unknown'}`,
        sideEffect: manifest.sideEffect, toolVersion: manifest.version,
      };
      const call = create({ sideEffect: manifest.sideEffect, risk: 'high', argsDigest: policy.sha256(policy.canonicalJson(rawArgs)) });
      this.events.append({
        type: 'tool.proposed', taskId: call.taskId, runId, stepId,
        payload: { toolCallId: call.id, name, version: manifest.version, argsDigest: call.argsDigest, argsSummary: argsSummary(name, rawArgs), sideEffect: manifest.sideEffect, risk: 'high' },
      });
      this._appendPolicy(call, newId('pol'), decision);
      this._denyEvent(call, decision, 'DELEGATION_TOOL_DENIED', decision.reason);
      return { ok: true, status: 'denied', toolCallId: call.id, policy: decision, message: decision.reason };
    }

    if (name === 'project_architecture') {
      const project = this.state.findProjectByWorkspace(runWorkspace);
      const mainAgentId = project?.mainAgentId || this.state.defaultAgentId;
      if (run.delegationId || run.agentId !== mainAgentId) {
        const decision = {
          decision: 'deny', ruleIds: ['project-main-agent-only'], riskLevel: 'medium',
          reason: run.delegationId
            ? '子 Agent 不能修改项目整体架构，请通过父级主控 Agent 更新'
            : `只有项目主控 Agent（${mainAgentId}）可以更新整体架构`,
          actionHash: policy.actionHash({ workspaceId: this.workspaceId, agentId: run.agentId, tool: name, version: manifest.version, args: rawArgs, resourceKey: `project:${runWorkspace}` }),
          resourceKey: `project:${runWorkspace}`,
          sideEffect: manifest.sideEffect, toolVersion: manifest.version,
        };
        const call = create({ sideEffect: manifest.sideEffect, risk: 'medium', argsDigest: policy.sha256(policy.canonicalJson(rawArgs)) });
        this.events.append({
          type: 'tool.proposed', taskId: call.taskId, runId, stepId,
          payload: { toolCallId: call.id, name, version: manifest.version, argsDigest: call.argsDigest, argsSummary: argsSummary(name, rawArgs), sideEffect: manifest.sideEffect, risk: 'medium' },
        });
        this._appendPolicy(call, newId('pol'), decision);
        this._denyEvent(call, decision, 'PROJECT_MAIN_AGENT_ONLY', decision.reason);
        return { ok: true, status: 'denied', toolCallId: call.id, policy: decision, message: decision.reason };
      }
    }

    const decision = policy.evaluatePolicy({
      profile,
      tool: name,
      args: rawArgs,
      workspace: runWorkspace,
      workspaceId: this.workspaceId,
      agentId: run.agentId,
      runId,
      context: { priorSensitiveRead: run.sensitiveRead === true },
    });

    const argsDigest = policy.sha256(policy.canonicalJson(rawArgs));
    const call = create({
      sideEffect: decision.sideEffect,
      risk: decision.riskLevel,
      argsDigest,
      policyDecisionId: newId('pol'),
    });

    this.events.append({
      type: 'tool.proposed',
      taskId: call.taskId,
      runId,
      stepId,
      payload: {
        toolCallId: call.id,
        name,
        version: manifest.version,
        argsDigest,
        argsSummary: argsSummary(name, rawArgs),
        sideEffect: decision.sideEffect,
        risk: decision.riskLevel,
      },
    });

    if (decision.decision === 'deny') {
      this._appendPolicy(call, call.policyDecisionId, decision);
      this._denyEvent(call, decision, 'POLICY_DENIED', decision.reason);
      return { ok: true, status: 'denied', toolCallId: call.id, policy: decision, message: decision.reason };
    }

    if (decision.decision === 'require_approval') {
      const grant = this.state.findRunGrant(runId, decision.actionHash);
      if (grant) {
        const granted = {
          ...decision,
          decision: 'allow',
          ruleIds: [...decision.ruleIds, 'approval-grant'],
          reason: `${decision.reason}（已按本 Run 授权放行）`,
        };
        this._appendPolicy(call, call.policyDecisionId, granted);
        this.state.setToolCallStatus(call.id, 'ready');
        return { ok: true, status: 'ready', toolCallId: call.id, policy: granted, toolCall: call };
      }
      this._appendPolicy(call, call.policyDecisionId, decision);
      const approval = this.state.createApproval({
        runId,
        taskId: run.taskId,
        toolCallId: call.id,
        actionHash: decision.actionHash,
        scope: 'once',
        reason: decision.reason,
        resourceKey: decision.resourceKey,
        riskLevel: decision.riskLevel,
        toolName: name,
        paramsSummary: argsSummary(name, rawArgs),
        expiresAt: this.now() + APPROVAL_TTL_MS,
      });
      this.state.setToolCallStatus(call.id, 'waiting_approval', { approvalId: approval.id });
      this.state.setRunWaitingApproval(runId, true);
      return { ok: true, status: 'waiting_approval', toolCallId: call.id, policy: decision, approval, toolCall: call };
    }

    this._appendPolicy(call, call.policyDecisionId, decision);
    this.state.setToolCallStatus(call.id, 'ready');
    return { ok: true, status: 'ready', toolCallId: call.id, policy: decision, toolCall: call };
  }

  _appendPolicy(call, decisionId, decision) {
    this.events.append({
      type: 'policy.decided',
      taskId: call.taskId,
      runId: call.runId,
      stepId: call.stepId,
      payload: {
        toolCallId: call.id,
        decisionId,
        decision: decision.decision,
        ruleIds: decision.ruleIds,
        riskLevel: decision.riskLevel,
        actionHash: decision.actionHash,
        reason: decision.reason,
      },
    });
  }

  decide(input = {}) {
    const approvalId = String(input.approvalId || '');
    const approval = this.state.getApproval(approvalId);
    if (!approval) return { ok: false, code: 'APPROVAL_NOT_FOUND', message: `审批不存在：${approvalId}` };
    const result = this.state.decideApproval({
      approvalId,
      decision: input.decision,
      scope: input.scope,
      reason: input.reason,
      decidedBy: input.decidedBy || 'user',
    });
    this.state.setRunWaitingApproval(approval.runId, false);
    // 同 run 还有别的 pending 审批时，维持 waiting_approval（上面 setRunWaitingApproval 只解除无 pending 的情况）
    const stillPending = Object.values(this.state.listApprovals({ runId: approval.runId }).approvals)
      .some((a) => a.status === 'pending');
    if (stillPending) this.state.setRunWaitingApproval(approval.runId, true);
    const call = this.state.getToolCall(approval.toolCallId);
    return {
      ok: true,
      approval: result.approval,
      expired: result.expired === true,
      toolCall: call,
      actionHash: result.approval.actionHash,
    };
  }

  execute(input = {}) {
    const toolCallId = String(input.toolCallId || '');
    const call = this.state.getToolCall(toolCallId);
    if (!call) return { ok: false, code: 'TOOL_CALL_NOT_FOUND', message: `工具调用不存在：${toolCallId}` };
    if (call.status === 'succeeded') {
      return { ok: true, cached: true, toolCallId: call.id, content: call.resultPreview || '', meta: call.resultMeta || {}, tasks: call.resultTasks, status: 'succeeded' };
    }
    if (call.status === 'denied' || call.status === 'canceled') {
      return {
        ok: false,
        code: call.status === 'denied' ? 'DENIED' : 'CANCELED',
        message: call.deniedReason === 'approval_expired' ? '审批已过期，未执行该工具' : call.deniedReason === 'user_denied' ? '用户拒绝执行该工具' : '该工具调用已被拒绝或取消',
        toolCallId: call.id,
      };
    }
    if (call.status === 'failed' || call.status === 'unknown') {
      return { ok: false, code: call.failureCode || 'TOOL_FAILED', message: call.failureMessage || '工具执行失败', toolCallId: call.id };
    }
    let fresh = null;
    if (call.status === 'executing' || call.status === 'ready' || call.status === 'waiting_approval') {
      if (call.status === 'executing') return { ok: false, code: 'ALREADY_EXECUTING', message: '该工具调用正在执行' };
      const run = this.state.getRun(call.runId);
      const agentVersion = run ? this.state.getAgentVersion(run.agentId, run.agentVersion) : null;
      const userProfile = ['full', 'ask', 'readonly'].includes(input.profile) ? input.profile : 'ask';
      const profile = policy.stricterProfile(userProfile, agentVersion?.permissionProfileId);
      const workspace = input.workspace || call.workspace || run?.workspace || this.workspacePath;
      fresh = policy.evaluatePolicy({
        profile,
        tool: call.name,
        args: call.args,
        workspace,
        workspaceId: this.workspaceId,
        agentId: run.agentId,
        runId: call.runId,
        context: { priorSensitiveRead: run?.sensitiveRead === true },
      });
      if (fresh.decision === 'deny') {
        this._appendPolicy(call, newId('pol'), fresh);
        this._denyEvent(call, fresh, 'POLICY_DENIED', fresh.reason);
        this.state.setRunWaitingApproval(call.runId, false);
        return { ok: false, code: 'POLICY_DENIED', message: fresh.reason, toolCallId: call.id, policy: fresh };
      }
      if (fresh.decision === 'require_approval') {
        const approvalId = String(input.approvalId || call.approvalId || '');
        const approval = approvalId ? this.state.getApproval(approvalId) : null;
        /* 审批凭证绑定：除 actionHash 外还必须指向同一个 toolCall（同 run、同工具、同参数），
           否则「批准了 A 调用」可以被拿来放行 B 调用。 */
        const approvalOk = approval
          && approval.status === 'approved'
          && approval.actionHash === fresh.actionHash
          && approval.toolCallId === call.id
          && approval.runId === call.runId
          && this.now() <= approval.expiresAt;
        const grant = this.state.findRunGrant(call.runId, fresh.actionHash);
        if (!approvalOk && !grant) {
          return { ok: false, code: 'APPROVAL_REQUIRED', message: '需要一次有效的人工审批才能执行', toolCallId: call.id, actionHash: fresh.actionHash };
        }
        if (approvalOk) {
          this._appendPolicy(call, newId('pol'), {
            ...fresh,
            decision: 'allow',
            ruleIds: [...fresh.ruleIds, 'pre-exec-recheck'],
            reason: '审批后执行前复检通过',
          });
        }
      }
    } else {
      return { ok: false, code: 'INVALID_STATE', message: `工具调用状态不可执行：${call.status}` };
    }

    if (call.status === 'waiting_approval') {
      // 审批通过后由 decide 把状态推进到 ready；此处只处理已被直接放行的场景
      return { ok: false, code: 'APPROVAL_REQUIRED', message: '仍在等待审批', toolCallId: call.id };
    }

    this.state.setToolCallStatus(call.id, 'executing', { executedAt: this.now() });
    this.events.append({
      type: 'tool.started',
      taskId: call.taskId,
      runId: call.runId,
      stepId: call.stepId,
      payload: { toolCallId: call.id, name: call.name, idempotencyKey: call.idempotencyKey },
    });

    return this._run(call, input);
  }

  async _run(call, input) {
    const signal = this.signalFor ? this.signalFor(call.runId) : null;
    let result;
    try {
      result = await this.executeTool(call.name, call.args, {
        workspace: (typeof input.workspace === 'string' && input.workspace)
          || call.workspace
          || this.state.getRun(call.runId)?.workspace
          || this.workspacePath,
        permission: input.profile,
        approved: true,
        signal: signal || undefined,
      });
    } catch (err) {
      result = { ok: false, code: 'TOOL_EXCEPTION', error: err?.message || String(err) };
    }

    if (signal && signal.aborted) return this._settleAborted(call, result);

    if (result?.ok) {
      const content = String(result.content || '');
      const digest = policy.sha256(content);
      const tasks = Array.isArray(result.tasks) ? result.tasks : undefined;
      this.state.setToolCallStatus(call.id, 'succeeded', {
        resultPreview: preview(content),
        resultMeta: result.meta || {},
        resultDigest: digest,
        resultTasks: tasks,
      });
      this.events.append({
        type: 'tool.completed',
        taskId: call.taskId,
        runId: call.runId,
        stepId: call.stepId,
        payload: {
          toolCallId: call.id,
          resultCode: 'OK',
          summary: String(result.meta?.label || '').slice(0, 200),
          digest,
          artifactIds: [],
        },
      });
      this._maybeRecordArtifact(call);
      this._markSensitive(call);
      return { ok: true, toolCallId: call.id, content, meta: result.meta || {}, tasks, status: 'succeeded' };
    }

    const code = String(result?.code || 'TOOL_FAILED');
    const message = String(result?.error || result?.content || '工具执行失败').slice(0, 500);
    const unknown = call.name === 'run_command' && ['TIMEOUT', 'TOOL_EXCEPTION'].includes(String(result?.code || ''));
    if (unknown) {
      this.state.setToolCallStatus(call.id, 'unknown', { failureCode: code, failureMessage: message });
      this.events.append({
        type: 'tool.unknown',
        taskId: call.taskId,
        runId: call.runId,
        stepId: call.stepId,
        payload: { toolCallId: call.id, code, message, reconciliation: '需人工核对命令是否已产生副作用' },
      });
      return { ok: false, code, toolCallId: call.id, content: String(result?.content || ''), error: message, status: 'unknown' };
    }
    this.state.setToolCallStatus(call.id, 'failed', { failureCode: code, failureMessage: message });
    this.events.append({
      type: 'tool.failed',
      taskId: call.taskId,
      runId: call.runId,
      stepId: call.stepId,
      payload: { toolCallId: call.id, code, message, retryable: false },
    });
    return { ok: false, code, toolCallId: call.id, content: String(result?.content || ''), error: message, status: 'failed' };
  }

  /** 取消后的结算：绝不假设「没跑」。
   *  - 状态已被 cancelTask 落成 unknown/canceled：只在拿到确定结果时把 unknown 校正为 succeeded；
   *  - 还没落终态（取消竞态）：按是否有副作用分别落 unknown / canceled。 */
  _settleAborted(call, result) {
    const current = this.state.getToolCall(call.id);
    const status = current?.status || call.status;
    if (status === 'unknown') {
      if (result?.ok) {
        try {
          this.state.reconcileToolCall({
            toolCallId: call.id,
            outcome: 'succeeded',
            reason: '取消信号到达前工具已成功完成（自动核对）',
            decidedBy: 'runtime',
          });
        } catch { /* 已核对过或状态不可转换，保持 unknown */ }
      }
      return { ok: false, code: 'ABORTED', toolCallId: call.id, content: String(result?.content || ''), error: '任务取消时该工具仍在执行，副作用须核对', status: 'unknown' };
    }
    if (['succeeded', 'failed', 'canceled', 'denied'].includes(status)) {
      return { ok: false, code: 'ABORTED', toolCallId: call.id, content: String(result?.content || ''), error: '任务已取消', status };
    }
    const sideEffect = ['write_file', 'run_command', 'delegate_task', 'project_architecture'].includes(call.name);
    const to = sideEffect ? 'unknown' : 'canceled';
    try {
      this.state.setToolCallStatus(call.id, to, {
        failureCode: 'ABORTED',
        failureMessage: sideEffect ? '取消时工具仍在执行，副作用未知' : '已取消',
      });
      this.events.append({
        type: sideEffect ? 'tool.unknown' : 'tool.canceled',
        taskId: call.taskId,
        runId: call.runId,
        stepId: call.stepId,
        payload: sideEffect
          ? { toolCallId: call.id, code: 'ABORTED', message: '取消时工具仍在执行，副作用未知', reconciliation: '核对实际结果后再标记 succeeded/failed' }
          : { toolCallId: call.id, reason: 'aborted' },
      });
    } catch { /* 状态已不可写 */ }
    return { ok: false, code: 'ABORTED', toolCallId: call.id, content: String(result?.content || ''), error: '已取消', status: to };
  }

  _maybeRecordArtifact(call) {
    if (call.name !== 'write_file') return;
    let abs = '';
    const workspace = call.workspace || this.workspacePath;
    try { abs = policy.resolvePath(call.args.path, workspace); } catch { abs = String(call.args.path || ''); }
    const content = String(call.args.content || '');
    this.events.append({
      type: 'artifact.created',
      taskId: call.taskId,
      runId: call.runId,
      stepId: call.stepId,
      payload: {
        artifactId: newId('art'),
        toolCallId: call.id,
        kind: 'file',
        path: abs,
        size: Buffer.byteLength(content, 'utf8'),
        sha256: policy.sha256(content),
      },
    });
  }

  _markSensitive(call) {
    if (call.name !== 'read_file') return;
    let abs = '';
    try { abs = policy.resolvePath(call.args.path, call.workspace || this.workspacePath); } catch { return; }
    if (policy.isSecretPath(abs)) this.state.markSensitiveRead(call.runId);
  }
}

module.exports = { ToolExecutor, APPROVAL_TTL_MS, argsSummary };
