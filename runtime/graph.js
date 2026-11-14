'use strict';

/* Run Graph 投影：纯函数 events → graph。
   同一事件序列必须得到同一张图；回放只读取事件，不触发任何副作用。 */

function summarizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const parts = [];
  if (usage.prompt_tokens != null) parts.push(`输入 ${usage.prompt_tokens}`);
  if (usage.completion_tokens != null) parts.push(`输出 ${usage.completion_tokens}`);
  return parts.join(' · ');
}

function projectGraph(events, meta = {}) {
  if (!Array.isArray(events)) throw new Error('events 必须是数组');
  const runId = String(meta.runId || events.find((e) => e && e.runId)?.runId || '');
  const nodes = [];
  const edges = [];
  const stepNodes = new Map();
  const modelNodes = new Map();
  const toolNodes = new Map();
  const approvalNodes = new Map();
  const delegationNodes = new Map();
  let lastStepId = null;
  let ended = false;

  const push = (node, parentId, kind = 'next') => {
    nodes.push(node);
    if (parentId) edges.push({ from: parentId, to: node.id, kind });
    return node;
  };

  const runNode = push({
    id: `run:${runId}`,
    kind: 'run',
    label: meta.title || '本地运行',
    status: 'running',
    startedAt: meta.startedAt || events[0]?.ts,
    summary: meta.model || '',
    runId,
  });

  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue;
    const p = ev.payload || {};
    switch (ev.type) {
      case 'run.started':
        runNode.startedAt = ev.ts;
        runNode.summary = p.model || runNode.summary;
        runNode.status = 'running';
        break;

      case 'step.started': {
        const node = push({
          id: `step:${ev.stepId || nodes.length}`,
          kind: 'step',
          label: `步骤 ${p.index ?? '?'} · ${p.kind || ''}`,
          status: 'running',
          startedAt: ev.ts,
          stepId: ev.stepId,
          index: p.index,
          stepKind: p.kind,
          eventSeq: ev.seq,
        }, lastStepId || runNode.id, lastStepId ? 'next' : 'start');
        stepNodes.set(ev.stepId, node);
        lastStepId = node.id;
        break;
      }

      case 'step.finished': {
        const node = stepNodes.get(ev.stepId);
        if (node) {
          node.status = p.status || node.status;
          node.endedAt = ev.ts;
          if (Array.isArray(p.toolCallIds) && p.toolCallIds.length) node.toolCount = p.toolCallIds.length;
        }
        break;
      }

      case 'model.request_started': {
        const parent = stepNodes.get(ev.stepId)?.id || lastStepId || runNode.id;
        const node = push({
          id: `mcall:${p.modelCallId}`,
          kind: 'model',
          label: `模型 · ${p.model || '未知'}`,
          status: 'running',
          startedAt: ev.ts,
          summary: `${p.messageCount ?? '?'} 条消息 · ~${p.approxInputTokens ?? '?'} tokens`,
          modelCallId: p.modelCallId,
          model: p.model,
          stepId: ev.stepId,
          eventSeq: ev.seq,
        }, parent, 'model');
        modelNodes.set(p.modelCallId, node);
        break;
      }

      case 'model.completed': {
        const node = modelNodes.get(p.modelCallId);
        if (node) {
          node.status = 'succeeded';
          node.endedAt = ev.ts;
          node.finishReason = p.finishReason || '';
          node.usage = p.usage || null;
          const usage = summarizeUsage(p.usage);
          node.summary = `${p.finishReason || 'stop'}${usage ? ' · ' + usage : ''}`;
        }
        break;
      }

      case 'model.failed': {
        const node = modelNodes.get(p.modelCallId);
        if (node) {
          node.status = 'failed';
          node.endedAt = ev.ts;
          node.summary = `${p.code || 'MODEL_ERROR'}${p.message ? ' · ' + String(p.message).slice(0, 120) : ''}`;
        }
        break;
      }

      case 'model.aborted': {
        const node = modelNodes.get(p.modelCallId);
        if (node) {
          node.status = 'canceled';
          node.endedAt = ev.ts;
          node.summary = '已中断';
        }
        break;
      }

      case 'tool.proposed': {
        const parent = stepNodes.get(ev.stepId)?.id || lastStepId || runNode.id;
        const node = push({
          id: `tool:${p.toolCallId}`,
          kind: 'tool',
          label: `工具 · ${p.name || ''}`,
          status: 'proposed',
          startedAt: ev.ts,
          summary: p.argsSummary || '',
          toolCallId: p.toolCallId,
          name: p.name,
          risk: p.risk,
          sideEffect: p.sideEffect,
          version: p.version,
          eventSeq: ev.seq,
        }, parent, 'tool');
        toolNodes.set(p.toolCallId, node);
        break;
      }

      case 'policy.decided': {
        const node = toolNodes.get(p.toolCallId);
        if (!node) break;
        node.policy = {
          decision: p.decision,
          ruleIds: Array.isArray(p.ruleIds) ? p.ruleIds : [],
          riskLevel: p.riskLevel,
          actionHash: p.actionHash,
          reason: p.reason,
        };
        if (node.status === 'proposed') {
          node.status = p.decision === 'deny' ? 'denied'
            : p.decision === 'require_approval' ? 'waiting_approval' : 'ready';
        }
        break;
      }

      case 'approval.requested': {
        const tool = toolNodes.get(p.toolCallId);
        const node = push({
          id: `apr:${p.approvalId}`,
          kind: 'approval',
          label: '人工审批',
          status: 'pending',
          startedAt: ev.ts,
          summary: `${p.scope || 'once'} · ${p.riskLevel || ''}`.trim(),
          approvalId: p.approvalId,
          toolCallId: p.toolCallId,
          scope: p.scope,
          riskLevel: p.riskLevel,
          actionHash: p.actionHash,
          eventSeq: ev.seq,
        }, tool?.id || lastStepId || runNode.id, 'approval');
        approvalNodes.set(p.approvalId, node);
        if (tool) tool.status = 'waiting_approval';
        break;
      }

      case 'approval.decided': {
        const node = approvalNodes.get(p.approvalId);
        if (node) {
          node.status = p.decision === 'approved' ? 'approved' : 'denied';
          node.endedAt = ev.ts;
          node.summary = `${p.decision === 'approved' ? '已批准' : '已拒绝'} · ${p.scope || 'once'}${p.reason ? ' · ' + String(p.reason).slice(0, 80) : ''}`;
          node.decidedBy = p.decidedBy;
        }
        const tool = toolNodes.get(node?.toolCallId);
        if (tool) tool.status = p.decision === 'approved' ? 'ready' : 'denied';
        break;
      }

      case 'approval.expired':
      case 'approval.canceled': {
        const node = approvalNodes.get(p.approvalId);
        if (node) {
          node.status = ev.type === 'approval.expired' ? 'expired' : 'canceled';
          node.endedAt = ev.ts;
          node.summary = ev.type === 'approval.expired' ? '已过期' : '已取消';
        }
        const tool = toolNodes.get(node?.toolCallId);
        if (tool && tool.status === 'waiting_approval') tool.status = 'canceled';
        break;
      }

      case 'tool.started': {
        const node = toolNodes.get(p.toolCallId);
        if (node) {
          node.status = 'executing';
          node.startedAt = ev.ts;
          node.idempotencyKey = p.idempotencyKey;
        }
        break;
      }

      case 'tool.completed': {
        const node = toolNodes.get(p.toolCallId);
        if (node) {
          node.status = 'succeeded';
          node.endedAt = ev.ts;
          node.resultCode = p.resultCode;
          node.summary = [p.summary, p.digest ? `sha256:${String(p.digest).slice(0, 8)}…` : ''].filter(Boolean).join(' · ') || node.summary;
          if (Array.isArray(p.artifactIds) && p.artifactIds.length) node.artifactIds = p.artifactIds;
        }
        break;
      }

      case 'tool.failed':
      case 'tool.unknown':
      case 'tool.denied':
      case 'tool.canceled': {
        const node = toolNodes.get(p.toolCallId);
        if (!node) break;
        node.status = ev.type === 'tool.failed' ? 'failed'
          : ev.type === 'tool.unknown' ? 'unknown'
            : ev.type === 'tool.denied' ? 'denied' : 'canceled';
        node.endedAt = ev.ts;
        node.summary = `${p.code || ''}${p.message || p.reason ? ' · ' + String(p.message || p.reason).slice(0, 120) : ''}`.trim() || node.summary;
        break;
      }

      case 'tool.reconciled': {
        const node = toolNodes.get(p.toolCallId);
        if (node) {
          node.status = p.outcome || node.status;
          node.endedAt = ev.ts;
          node.reconciled = true;
          node.summary = `人工核对：${p.outcome || ''}${p.reason ? ' · ' + String(p.reason).slice(0, 100) : ''}`;
        }
        break;
      }

      case 'artifact.created': {
        const node = toolNodes.get(p.toolCallId);
        if (node) {
          node.artifacts = node.artifacts || [];
          node.artifacts.push({ artifactId: p.artifactId, path: p.path, size: p.size, sha256: p.sha256 });
        }
        break;
      }

      case 'delegation.requested': {
        const node = push({
          id: `del:${p.delegationId}`,
          kind: 'delegation',
          label: `委派 · ${String(p.targetAgentId || '').slice(-6)}`,
          status: 'queued',
          startedAt: ev.ts,
          summary: `深度 ${p.depth ?? 1} · ${p.budget?.maxModelCalls ?? '?'} 次模型调用预算`,
          delegationId: p.delegationId,
          childTaskId: p.childTaskId,
          childRunId: p.childRunId,
          targetAgentId: p.targetAgentId,
          targetAgentVersion: p.targetAgentVersion,
          depth: p.depth,
          budget: p.budget,
          effectiveProfile: p.effectiveProfile,
          contextRefCount: p.contextRefCount,
          eventSeq: ev.seq,
        }, lastStepId || runNode.id, 'delegation');
        delegationNodes.set(p.delegationId, node);
        break;
      }

      case 'delegation.started': {
        const node = delegationNodes.get(p.delegationId);
        if (node) {
          node.status = 'running';
          node.startedAt = ev.ts;
          node.summary = `子任务运行中 · ${p.childTaskId || ''}`;
        }
        break;
      }

      case 'delegation.finished': {
        const node = delegationNodes.get(p.delegationId);
        if (node) {
          node.status = p.status || 'finished';
          node.endedAt = ev.ts;
          node.summary = [p.status, p.errorCode, p.summary].filter(Boolean).join(' · ');
          node.artifactCount = p.artifactCount;
        }
        break;
      }

      case 'delegation.canceled': {
        const node = delegationNodes.get(p.delegationId);
        if (node) {
          node.status = 'canceled';
          node.endedAt = ev.ts;
          node.summary = `已取消${p.reason ? ' · ' + String(p.reason).slice(0, 80) : ''}`;
        }
        break;
      }

      case 'delegation.rejected': {
        push({
          id: `del-rejected:${ev.seq}`,
          kind: 'delegation',
          label: `委派被拒绝 · ${String(p.targetAgentId || '').slice(-6)}`,
          status: 'rejected',
          startedAt: ev.ts,
          summary: `${p.code || ''}${p.reason ? ' · ' + String(p.reason).slice(0, 100) : ''}`,
          targetAgentId: p.targetAgentId,
          eventSeq: ev.seq,
        }, lastStepId || runNode.id, 'delegation');
        break;
      }

      case 'validation.completed': {
        push({
          id: 'validation',
          kind: 'validation',
          label: '结果校验',
          status: p.status || 'skipped',
          startedAt: ev.ts,
          summary: Array.isArray(p.checks) && p.checks.length ? `${p.checks.length} 项检查` : '本轮无业务后置条件',
          eventSeq: ev.seq,
        }, lastStepId || runNode.id, 'validation');
        break;
      }

      case 'run.finished':
      case 'run.interrupted': {
        if (ended) break;
        ended = true;
        runNode.status = ev.type === 'run.interrupted' ? 'interrupted' : (p.outcome || 'finished');
        runNode.endedAt = ev.ts;
        push({
          id: 'end',
          kind: 'end',
          label: runNode.status === 'succeeded' ? '完成' : runNode.status === 'canceled' ? '已取消' : '结束',
          status: runNode.status,
          startedAt: ev.ts,
          summary: ev.type === 'run.interrupted' ? (p.reason || '运行中断') : (p.outcome || ''),
          eventSeq: ev.seq,
        }, lastStepId || runNode.id, 'end');
        break;
      }

      default:
        break;
    }
  }

  return {
    runId,
    status: runNode.status,
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      steps: stepNodes.size,
      modelCalls: modelNodes.size,
      toolCalls: toolNodes.size,
      approvals: approvalNodes.size,
      delegations: delegationNodes.size,
    },
    lastSeq: events.length ? events[events.length - 1].seq : 0,
  };
}

module.exports = { projectGraph };
