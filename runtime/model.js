'use strict';

const { newId } = require('./ids');

/* Runtime 实体状态机与工厂。状态名以 docs/architecture/runtime-data-model.md 为准。 */

const TASK_TRANSITIONS = {
  created: ['queued', 'canceled'],
  queued: ['running', 'paused', 'canceled', 'expired'],
  running: ['waiting_approval', 'paused', 'succeeded', 'failed', 'canceled'],
  waiting_approval: ['running', 'paused', 'canceled', 'failed'],
  paused: ['queued', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
  expired: [],
};

const RUN_TRANSITIONS = {
  pending: ['running', 'canceled'],
  running: ['waiting_approval', 'succeeded', 'failed', 'canceled', 'interrupted'],
  waiting_approval: ['running', 'failed', 'canceled', 'interrupted'],
  succeeded: [],
  failed: [],
  canceled: [],
  /* interrupted -> running 仅用于带检查点的子 Agent 断点续跑（delegation resume） */
  interrupted: ['running'],
};

const STEP_TRANSITIONS = {
  pending: ['running', 'canceled', 'skipped'],
  running: ['waiting_approval', 'succeeded', 'failed', 'canceled'],
  waiting_approval: ['running', 'failed', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
  skipped: [],
};

const MODEL_CALL_TRANSITIONS = {
  started: ['streaming', 'completed', 'failed', 'aborted'],
  streaming: ['completed', 'failed', 'aborted'],
  completed: [],
  failed: [],
  aborted: [],
};

const TOOL_CALL_TRANSITIONS = {
  proposed: ['policy_check', 'denied', 'canceled'],
  policy_check: ['waiting_approval', 'ready', 'denied', 'canceled'],
  waiting_approval: ['ready', 'denied', 'canceled'],
  ready: ['executing', 'denied', 'canceled'],
  executing: ['succeeded', 'failed', 'unknown', 'canceled'],
  succeeded: [],
  failed: [],
  denied: [],
  canceled: [],
  unknown: ['succeeded', 'failed', 'canceled'],
};

const APPROVAL_TRANSITIONS = {
  pending: ['approved', 'denied', 'expired', 'canceled'],
  approved: [],
  denied: [],
  expired: [],
  canceled: [],
};

const MACHINES = {
  task: TASK_TRANSITIONS,
  run: RUN_TRANSITIONS,
  step: STEP_TRANSITIONS,
  modelCall: MODEL_CALL_TRANSITIONS,
  toolCall: TOOL_CALL_TRANSITIONS,
  approval: APPROVAL_TRANSITIONS,
};

function canTransition(kind, from, to) {
  const map = MACHINES[kind];
  if (!map) throw new Error(`未知状态机：${kind}`);
  return Array.isArray(map[from]) && map[from].includes(to);
}

function assertTransition(kind, from, to) {
  if (!canTransition(kind, from, to)) {
    throw new Error(`非法状态转换（${kind}）：${from} -> ${to}`);
  }
  return true;
}

function isTerminal(kind, state) {
  const map = MACHINES[kind];
  if (!map) throw new Error(`未知状态机：${kind}`);
  return Array.isArray(map[state]) && map[state].length === 0;
}

function baseTask(input) {
  const now = Date.now();
  return {
    id: newId('task', now),
    workspaceId: input.workspaceId,
    workspace: input.workspace,
    agentId: input.agentId,
    agentVersion: input.agentVersion || 1,
    title: input.title || '新任务',
    input: input.input || '',
    status: 'created',
    priority: input.priority ?? 1,
    parentTaskId: input.parentTaskId,
    rootTaskId: input.rootTaskId || undefined,
    idempotencyKey: input.idempotencyKey,
    attemptCount: 0,
    createdAt: now,
    schemaVersion: 1,
  };
}

function baseRun(input) {
  const now = Date.now();
  return {
    id: newId('run', now),
    taskId: input.taskId,
    attempt: input.attempt || 1,
    resumeOfRunId: input.resumeOfRunId,
    status: 'pending',
    workspace: input.workspace,
    agentId: input.agentId,
    agentVersion: input.agentVersion || 1,
    providerId: input.providerId,
    model: input.model,
    budget: input.budget || {},
    usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    startedAt: now,
    schemaVersion: 1,
  };
}

function baseStep(input) {
  const now = Date.now();
  return {
    id: newId('step', now),
    runId: input.runId,
    index: input.index || 0,
    kind: input.kind || 'plan',
    status: 'pending',
    startedAt: now,
    toolCallIds: [],
    schemaVersion: 1,
  };
}

function baseToolCall(input) {
  const now = Date.now();
  return {
    id: newId('tcall', now),
    runId: input.runId,
    stepId: input.stepId,
    name: input.name,
    version: input.version || '1.0.0',
    args: input.args || {},
    argsDigest: input.argsDigest || '',
    status: 'proposed',
    sideEffect: input.sideEffect || 'none',
    risk: input.risk || 'low',
    policyDecisionId: input.policyDecisionId,
    approvalId: input.approvalId,
    idempotencyKey: newId('tcall', now),
    schemaVersion: 1,
  };
}

function baseApproval(input) {
  const now = Date.now();
  return {
    id: newId('apr', now),
    runId: input.runId,
    taskId: input.taskId,
    toolCallId: input.toolCallId,
    actionHash: input.actionHash,
    status: 'pending',
    scope: input.scope || 'once',
    reason: input.reason || '',
    requestedAt: now,
    expiresAt: input.expiresAt || now + 10 * 60 * 1000,
    decidedAt: undefined,
    decidedBy: undefined,
    decisionReason: undefined,
    schemaVersion: 1,
  };
}

module.exports = {
  MACHINES,
  TASK_TRANSITIONS,
  RUN_TRANSITIONS,
  STEP_TRANSITIONS,
  MODEL_CALL_TRANSITIONS,
  TOOL_CALL_TRANSITIONS,
  APPROVAL_TRANSITIONS,
  canTransition,
  assertTransition,
  isTerminal,
  baseTask,
  baseRun,
  baseStep,
  baseToolCall,
  baseApproval,
};
