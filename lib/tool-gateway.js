'use strict';

/* 主进程工具治理内核（Tool Gateway）
 *
 * 存在理由：R13 之前有两条互不相干的执行通道
 *   A) Runtime：propose → policy → approval → executor → event/audit
 *   B) 旧通道：renderer → `tool:exec` → localTools.executeTool（渲染层传 approved:true 就算批准）
 * 以及一条 MCP 旁路：renderer → `mcp:tool:call` → mcpManager.callTool（完全不过策略）
 *
 * 本模块把 B 与 MCP 旁路统一到 A 的同一套判定上：
 *   · 策略：直接调用 Runtime 的 policy（同一份规则、同一 workspaceId），Runtime 不可用时
 *     退化为同一 policy 模块的独立调用，规则不复制；
 *   · 审批：由主进程自己弹确认框（原生 dialog），**不再接受渲染层传的 approved 布尔值**；
 *     审批绑定 actionHash（工具 + 版本 + 归一化参数 + 资源键），一次有效；
 *   · 审计：每次判定与结果都写入 runtime 事件链（type=tool.gateway）→ 进同一份审计链。
 *
 * 边界：旧通道没有 Task/Run 生命周期（不建 run、不占并发预算），这是它与 A 的
 * 唯一差异，已在 docs 中标注为「无会话执行」。高权限工具仍受策略与审批约束。
 */

const { evaluatePolicy, actionHash } = require('../runtime/policy');

const MAX_CONCURRENT = 4;
const MCP_RISK = 'high';

function createToolGateway({
  localTools,
  getRuntime = () => null,
  getMcp = () => null,
  confirm = null,
  now = Date.now,
  auditSink = null,
} = {}) {
  if (!localTools || typeof localTools.executeTool !== 'function') {
    throw new Error('tool-gateway 需要 localTools.executeTool');
  }

  let inflight = 0;
  const stats = { calls: 0, denied: 0, approved: 0, errors: 0, mcpCalls: 0 };

  function runtimeRef() {
    try { return getRuntime(); } catch { return null; }
  }

  function audit(record) {
    const rt = runtimeRef();
    const payload = { at: new Date(now()).toISOString(), ...record };
    if (rt && typeof rt.append === 'function') {
      try {
        rt.append({
          type: 'tool.gateway',
          actor: { kind: 'user', id: 'local-user' },
          payload,
        });
        return;
      } catch { /* Runtime 未就绪时退回落盘 sink */ }
    }
    if (typeof auditSink === 'function') {
      try { auditSink(payload); } catch { /* 审计失败不影响执行 */ }
    }
  }

  /** 与 Runtime 完全同一份策略判定（Runtime 可用时复用其 workspaceId）。 */
  function decide({ name, args, workspace, permission, agentId }) {
    const rt = runtimeRef();
    const ws = (typeof workspace === 'string' && workspace) ? workspace : (rt?.workspacePath || process.cwd());
    if (rt && typeof rt.evaluateTool === 'function') {
      return rt.evaluateTool({ tool: name, args, profile: permission, workspace: ws, agentId });
    }
    return evaluatePolicy({
      profile: permission,
      tool: name,
      args,
      workspace: ws,
      workspaceId: 'ws_main',
      agentId: agentId || 'agent_local',
    });
  }

  function publicDecision(d) {
    return {
      decision: d.decision,
      ruleIds: Array.isArray(d.ruleIds) ? d.ruleIds.slice(0, 10) : [],
      riskLevel: d.riskLevel,
      reason: d.reason,
      actionHash: d.actionHash,
    };
  }

  async function askUser({ toolName, decision, summary }) {
    if (typeof confirm !== 'function') return { ok: false, reason: '没有可用的确认界面' };
    try {
      const ok = await confirm({
        toolName,
        actionHash: decision.actionHash,
        riskLevel: decision.riskLevel,
        ruleIds: decision.ruleIds,
        reason: decision.reason,
        summary,
      });
      return { ok: ok === true };
    } catch (err) {
      return { ok: false, reason: err?.message || String(err) };
    }
  }

  function policyDenied(name, decision, channel) {
    stats.denied += 1;
    audit({ channel, phase: 'deny', tool: name, actionHash: decision.actionHash, ruleIds: decision.ruleIds, reason: decision.reason });
    return {
      ok: false,
      code: 'POLICY_DENIED',
      error: decision.reason || '策略拒绝执行该工具',
      policy: publicDecision(decision),
    };
  }

  /**
   * 旧通道本地工具执行（tool:exec）。
   * payload: { name, args, opts: { workspace, permission } }
   */
  async function execLocal(payload = {}) {
    const name = String(payload.name || '');
    const args = payload.args;
    const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : {};
    const permission = ['full', 'ask', 'readonly'].includes(opts.permission) ? opts.permission : 'ask';
    const workspace = typeof opts.workspace === 'string' ? opts.workspace : '';

    if (!name) return { ok: false, code: 'BAD_ARGS', error: '工具名称为空' };
    if (inflight >= MAX_CONCURRENT) {
      return { ok: false, code: 'BUSY', error: `并发工具调用已达上限（${MAX_CONCURRENT}），请稍后重试` };
    }
    inflight += 1;
    stats.calls += 1;
    try {
      const decision = decide({ name, args, workspace, permission });
      if (decision.decision === 'deny') return policyDenied(name, decision, 'local');

      let approvalSource = 'policy-allow';
      if (decision.decision === 'require_approval') {
        const asked = await askUser({
          toolName: name,
          decision,
          summary: typeof opts.summary === 'string' ? opts.summary : '',
        });
        audit({
          channel: 'local', phase: 'approval', tool: name, actionHash: decision.actionHash,
          granted: asked.ok, ruleIds: decision.ruleIds, reason: asked.reason || decision.reason,
        });
        if (!asked.ok) {
          stats.denied += 1;
          return {
            ok: false,
            code: 'APPROVAL_DENIED',
            error: asked.reason ? `未获批准：${asked.reason}` : '用户拒绝执行该工具',
            policy: publicDecision(decision),
          };
        }
        stats.approved += 1;
        approvalSource = 'main-dialog';
      }

      const startedAt = now();
      let result;
      try {
        result = await localTools.executeTool(name, args, {
          workspace,
          permission,
          // 策略与审批都由本模块完成，工具层只做最终校验（它仍会拒绝 readonly/未批准）
          approved: true,
        });
      } catch (err) {
        stats.errors += 1;
        audit({ channel: 'local', phase: 'error', tool: name, actionHash: decision.actionHash, error: String(err?.message || err).slice(0, 200) });
        return { ok: false, code: 'TOOL_ERROR', error: String(err?.message || err) };
      }
      audit({
        channel: 'local',
        phase: 'result',
        tool: name,
        actionHash: decision.actionHash,
        approvalSource,
        ok: result?.ok === true,
        code: result?.code,
        durationMs: Math.max(0, now() - startedAt),
      });
      return result;
    } finally {
      inflight -= 1;
    }
  }

  /**
   * MCP 工具调用（mcp:tool:call）。MCP 工具一律按高风险处理：
   * readonly 拒绝、ask 需主进程审批、full 放行；调用与结果都进审计链。
   * payload: { serverId, name, args, timeoutMs, permission }
   */
  async function callMcp(payload = {}) {
    const serverId = String(payload.serverId || '');
    const name = String(payload.name || '');
    const args = payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : {};
    const permission = ['full', 'ask', 'readonly'].includes(payload.permission) ? payload.permission : 'ask';
    if (!serverId || !name) return { ok: false, code: 'BAD_ARGS', error: '缺少 serverId 或 name' };

    const mcp = getMcp ? getMcp() : null;
    if (!mcp || typeof mcp.callTool !== 'function') {
      return { ok: false, code: 'MCP_UNAVAILABLE', error: 'MCP 管理器未初始化' };
    }

    const decision = {
      decision: permission === 'readonly' ? 'deny' : permission === 'full' ? 'allow' : 'require_approval',
      ruleIds: [permission === 'readonly' ? 'mcp-readonly' : permission === 'full' ? 'mcp-full' : 'mcp-approval'],
      riskLevel: MCP_RISK,
      reason: permission === 'readonly'
        ? '只读模式不允许调用 MCP 工具'
        : permission === 'full'
          ? '完全权限：允许调用 MCP 工具'
          : 'MCP 工具属于外部副作用，需要确认后执行',
      actionHash: actionHash({
        workspaceId: runtimeRef()?.workspaceId || 'ws_main',
        agentId: 'mcp',
        tool: `mcp:${serverId}/${name}`,
        version: '1',
        args,
        resourceKey: `mcp:${serverId}`,
      }),
    };

    if (decision.decision === 'deny') return policyDenied(`mcp:${serverId}/${name}`, decision, 'mcp');

    if (decision.decision === 'require_approval') {
      const asked = await askUser({ toolName: `MCP · ${name}`, decision, summary: `${serverId} / ${name}` });
      audit({ channel: 'mcp', phase: 'approval', tool: name, serverId, actionHash: decision.actionHash, granted: asked.ok });
      if (!asked.ok) return { ok: false, code: 'APPROVAL_DENIED', error: '用户拒绝执行该 MCP 工具', policy: publicDecision(decision) };
      stats.approved += 1;
    }

    if (inflight >= MAX_CONCURRENT) {
      return { ok: false, code: 'BUSY', error: `并发工具调用已达上限（${MAX_CONCURRENT}），请稍后重试` };
    }
    inflight += 1;
    stats.mcpCalls += 1;
    const startedAt = now();
    try {
      const res = await mcp.callTool(serverId, name, args, payload.timeoutMs);
      audit({
        channel: 'mcp', phase: 'result', tool: name, serverId,
        actionHash: decision.actionHash, ok: res?.ok === true, code: res?.code,
        durationMs: Math.max(0, now() - startedAt),
      });
      return res;
    } finally {
      inflight -= 1;
    }
  }

  function state() {
    return { inflight, maxConcurrent: MAX_CONCURRENT, ...stats };
  }

  return { execLocal, callMcp, decide, state };
}

module.exports = { createToolGateway, MAX_CONCURRENT };
