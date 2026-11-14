'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { newId } = require('./ids');
const { canonicalJson, sha256 } = require('./policy');

/* 本地审计：安全相关事件写成哈希链 JSONL。只保存元数据与摘要，不保存参数、prompt 或文件内容。 */

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

class AuditStore {
  constructor({ dir, now = Date.now } = {}) {
    if (!dir) throw new Error('AuditStore 需要 dir');
    this.dir = path.resolve(dir);
    this.headPath = path.join(this.dir, 'head.json');
    this.now = now;
    this.lastSeq = 0;
    this.lastHash = 'genesis';
    this.lastTs = 0;
    this.subscribers = new Set();
    this.ready = false;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    let head = null;
    try { head = JSON.parse(fs.readFileSync(this.headPath, 'utf8')); } catch { /* 首次启动 */ }

    // 以磁盘上的最后一行重建链头，head.json 只是缓存
    let last = null;
    for (const name of this._files()) {
      const file = path.join(this.dir, name);
      let raw = '';
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (Number.isInteger(rec.seq) && rec.seq >= this.lastSeq) last = rec;
        } catch { /* 损坏行由 verify 报告 */ }
      }
    }
    if (last) {
      this.lastSeq = last.seq;
      this.lastHash = last.hash || this.lastHash;
      this.lastTs = last.ts || 0;
    } else if (head) {
      this.lastSeq = Number(head.seq) || 0;
      this.lastHash = head.hash || 'genesis';
    }
    this._writeHead();
    this.ready = true;
    return this;
  }

  _files() {
    try {
      return fs.readdirSync(this.dir).filter((n) => DAY_FILE_RE.test(n)).sort();
    } catch { return []; }
  }

  _writeHead() {
    const tmp = this.headPath + '.tmp';
    const raw = JSON.stringify({ seq: this.lastSeq, hash: this.lastHash, updatedAt: this.now() }, null, 2);
    try {
      fs.writeFileSync(tmp, raw);
      fs.renameSync(tmp, this.headPath);
    } catch {
      try { fs.writeFileSync(this.headPath, raw); } catch { /* 忽略 */ }
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    }
  }

  append(input = {}) {
    if (!this.ready) return null;
    const ts = Math.max(Number(input.ts) || this.now(), this.lastTs);
    const record = {
      seq: this.lastSeq + 1,
      id: newId('aud', ts),
      ts,
      actor: input.actor && typeof input.actor === 'object' ? input.actor : { kind: 'runtime', id: 'runtime' },
      action: String(input.action || 'unknown'),
      outcome: String(input.outcome || 'unknown'),
      taskId: input.taskId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      approvalId: input.approvalId,
      eventSeq: Number.isInteger(input.eventSeq) ? input.eventSeq : undefined,
      detail: input.detail && typeof input.detail === 'object' ? input.detail : {},
      prevHash: this.lastHash,
    };
    record.hash = 'sha256:' + sha256(canonicalJson(record));

    const file = path.join(this.dir, `${dayKey(ts)}.jsonl`);
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.lastSeq = record.seq;
    this.lastHash = record.hash;
    this.lastTs = ts;
    this._writeHead();
    for (const fn of this.subscribers) {
      try { fn(record); } catch { /* 订阅者异常不影响审计写入 */ }
    }
    return record;
  }

  read({ afterSeq = 0, limit = 100 } = {}) {
    const max = Math.max(1, Math.min(1000, Number(limit) || 100));
    const out = [];
    let nextSeq = afterSeq;
    let hasMore = false;
    for (const name of this._files()) {
      if (out.length >= max) break;
      let raw = '';
      try { raw = fs.readFileSync(path.join(this.dir, name), 'utf8'); } catch { continue; }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!Number.isInteger(rec.seq) || rec.seq <= afterSeq) continue;
        if (out.length >= max) { hasMore = true; break; }
        out.push(rec);
        nextSeq = rec.seq;
      }
    }
    return { records: out, nextSeq, hasMore };
  }

  verify() {
    let prev = 'genesis';
    let expected = 1;
    let malformed = 0;
    const issues = [];
    for (const name of this._files()) {
      let raw = '';
      try { raw = fs.readFileSync(path.join(this.dir, name), 'utf8'); } catch { continue; }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { malformed++; continue; }
        if (rec.seq !== expected) issues.push(`seq ${rec.seq} != ${expected}`);
        if (rec.prevHash !== prev) issues.push(`seq ${rec.seq} prevHash 不连续`);
        const copy = { ...rec };
        delete copy.hash;
        const hash = 'sha256:' + sha256(canonicalJson(copy));
        if (hash !== rec.hash) issues.push(`seq ${rec.seq} hash 不匹配`);
        prev = rec.hash;
        expected = rec.seq + 1;
      }
    }
    return { ok: issues.length === 0 && malformed === 0, issues: issues.slice(0, 20), malformed, lastSeq: expected - 1 };
  }

  stats() {
    let files = 0;
    let bytes = 0;
    for (const name of this._files()) {
      files++;
      try { bytes += fs.statSync(path.join(this.dir, name)).size; } catch { /* 忽略 */ }
    }
    return { records: this.lastSeq, files, bytes };
  }

  close() {
    if (!this.ready) return;
    this._writeHead();
    this.subscribers.clear();
    this.ready = false;
  }
}

/* 事件 → 审计投影：只挑安全相关事件，且只保留元数据。 */
function projectEvent(event) {
  if (!event || typeof event.type !== 'string') return null;
  const p = event.payload || {};
  const base = {
    ts: event.ts,
    eventSeq: event.seq,
    actor: event.actor,
    taskId: event.taskId,
    runId: event.runId,
  };
  switch (event.type) {
    case 'policy.decided':
      return {
        ...base,
        action: 'policy.decided',
        outcome: String(p.decision || 'unknown'),
        toolCallId: p.toolCallId,
        detail: {
          decisionId: p.decisionId,
          ruleIds: Array.isArray(p.ruleIds) ? p.ruleIds.slice(0, 20) : [],
          riskLevel: p.riskLevel,
          actionHash: p.actionHash,
          reason: String(p.reason || '').slice(0, 200),
        },
      };
    case 'approval.requested':
      return {
        ...base,
        action: 'approval.requested',
        outcome: 'pending',
        toolCallId: p.toolCallId,
        approvalId: p.approvalId,
        detail: {
          actionHash: p.actionHash,
          scope: p.scope,
          expiresAt: p.expiresAt,
          toolName: p.toolName,
          riskLevel: p.riskLevel,
        },
      };
    case 'approval.decided':
      return {
        ...base,
        action: 'approval.decided',
        outcome: String(p.decision || 'unknown'),
        approvalId: p.approvalId,
        detail: { scope: p.scope, decidedBy: p.decidedBy, reason: String(p.reason || '').slice(0, 200) },
      };
    case 'approval.expired':
    case 'approval.canceled':
      return {
        ...base,
        action: event.type,
        outcome: event.type === 'approval.expired' ? 'expired' : 'canceled',
        approvalId: p.approvalId,
        detail: { reason: String(p.reason || '').slice(0, 200) },
      };
    case 'tool.reconciled':
      return {
        ...base,
        action: 'tool.reconciled',
        outcome: String(p.outcome || 'unknown'),
        toolCallId: p.toolCallId,
        detail: { name: p.name, reason: String(p.reason || '').slice(0, 200) },
      };
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.denied':
    case 'tool.unknown':
    case 'tool.canceled':
      return {
        ...base,
        action: 'tool.result',
        outcome: event.type.slice('tool.'.length),
        toolCallId: p.toolCallId,
        detail: {
          name: p.name,
          code: p.code || p.resultCode,
          summary: String(p.summary || p.message || p.reason || '').slice(0, 200),
          digest: p.digest,
        },
      };
    case 'tool.gateway':
      return {
        ...base,
        action: 'tool.gateway',
        outcome: p.phase === 'result' ? (p.ok ? 'succeeded' : 'failed')
          : p.phase === 'deny' ? 'denied'
            : p.phase === 'approval' ? (p.granted ? 'approved' : 'denied')
              : 'unknown',
        detail: {
          channel: p.channel,
          phase: p.phase,
          tool: String(p.tool || '').slice(0, 80),
          serverId: p.serverId,
          actionHash: p.actionHash,
          ruleIds: Array.isArray(p.ruleIds) ? p.ruleIds.slice(0, 10) : undefined,
          approvalSource: p.approvalSource,
          code: p.code,
          durationMs: p.durationMs,
          reason: String(p.reason || p.error || '').slice(0, 200),
        },
      };
    case 'runtime.reconciled':
      return {
        ...base,
        action: 'runtime.reconciled',
        outcome: 'reconciled',
        detail: { repaired: p.repaired, entities: p.entities, reason: String(p.reason || '').slice(0, 80) },
      };
    case 'task.created':
      return {
        ...base,
        action: 'task.created',
        outcome: 'created',
        detail: { title: String(p.title || '').slice(0, 100), agentId: p.agentId },
      };
    case 'task.canceled':
      return {
        ...base,
        action: 'task.canceled',
        outcome: 'canceled',
        detail: { reason: String(p.reason || '').slice(0, 200) },
      };
    case 'run.interrupted':
      return {
        ...base,
        action: String(p.reason || '') === 'runtime_restart' ? 'runtime.recovered' : 'run.interrupted',
        outcome: 'interrupted',
        detail: { lastStepIndex: p.lastStepIndex, reason: String(p.reason || '').slice(0, 120) },
      };
    case 'delegation.requested':
      return {
        ...base,
        action: 'delegation.requested',
        outcome: 'requested',
        delegationId: p.delegationId,
        detail: {
          childTaskId: p.childTaskId,
          childRunId: p.childRunId,
          targetAgentId: p.targetAgentId,
          targetAgentVersion: p.targetAgentVersion,
          budget: p.budget,
          depth: p.depth,
          effectiveProfile: p.effectiveProfile,
          contextRefCount: p.contextRefCount,
        },
      };
    case 'delegation.started':
      return {
        ...base,
        action: 'delegation.started',
        outcome: 'running',
        delegationId: p.delegationId,
        detail: { childTaskId: p.childTaskId, childRunId: p.childRunId, targetAgentId: p.targetAgentId, depth: p.depth },
      };
    case 'delegation.finished':
      return {
        ...base,
        action: 'delegation.finished',
        outcome: String(p.status || 'unknown'),
        delegationId: p.delegationId,
        detail: {
          childTaskId: p.childTaskId,
          childRunId: p.childRunId,
          targetAgentId: p.targetAgentId,
          errorCode: p.errorCode,
          summary: String(p.summary || '').slice(0, 200),
          artifactCount: p.artifactCount,
        },
      };
    case 'delegation.canceled':
      return {
        ...base,
        action: 'delegation.canceled',
        outcome: 'canceled',
        delegationId: p.delegationId,
        detail: { childTaskId: p.childTaskId, cascade: p.cascade === true, reason: String(p.reason || '').slice(0, 200) },
      };
    case 'budget.exceeded':
      return {
        ...base,
        action: 'budget.exceeded',
        outcome: 'exceeded',
        detail: { scope: p.scope, limit: p.limit, used: p.used },
      };
    case 'delegation.rejected':
      return {
        ...base,
        action: 'delegation.rejected',
        outcome: 'rejected',
        detail: { targetAgentId: p.targetAgentId, code: p.code, reason: String(p.reason || '').slice(0, 200) },
      };
    case 'project.updated':
      return {
        ...base,
        action: 'project.updated',
        outcome: 'updated',
        detail: {
          projectId: p.projectId,
          revision: p.revision,
          source: p.source,
          mainAgentId: p.mainAgentId,
          nodeCount: p.nodeCount,
          edgeCount: p.edgeCount,
          mode: p.mode,
          added: p.added,
          removed: p.removed,
        },
      };
    case 'agent.updated':
      return {
        ...base,
        action: 'agent.updated',
        outcome: 'updated',
        detail: { agentId: p.agentId, fromVersion: p.fromVersion, toVersion: p.toVersion },
      };
    case 'provider.updated':
      return {
        ...base,
        action: 'provider.updated',
        outcome: 'updated',
        detail: { providerId: p.providerId, changed: Array.isArray(p.changed) ? p.changed : [] },
      };
    default:
      return null;
  }
}

module.exports = { AuditStore, projectEvent };
