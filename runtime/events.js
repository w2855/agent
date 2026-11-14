'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { newId } = require('./ids');

/* 追加式事件存储：JSONL + runtime.json 水位。单进程写入，终态事件 fsync。 */

const TERMINAL_EVENTS = new Set([
  'task.finished', 'task.canceled', 'task.expired',
  'run.finished', 'run.interrupted',
  'step.finished',
  'model.completed', 'model.failed', 'model.aborted',
  'tool.completed', 'tool.failed', 'tool.unknown', 'tool.denied', 'tool.canceled', 'tool.reconciled',
  'approval.decided', 'approval.expired', 'approval.canceled',
  'delegation.finished', 'delegation.canceled', 'delegation.rejected',
  'validation.completed',
  'runtime.migrated',
]);

const EVENT_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

class EventStore {
  constructor({ dir, workspaceId, now = Date.now } = {}) {
    if (!dir) throw new Error('EventStore 需要 dir');
    this.dir = path.resolve(dir);
    this.eventsDir = path.join(this.dir, 'events');
    this.metaPath = path.join(this.dir, 'runtime.json');
    this.now = now;
    this.workspaceId = workspaceId || null;
    this.lastSeq = 0;
    this.lastTs = 0;
    this.malformed = 0;
    this.subscribers = new Set();
    this.ready = false;
  }

  init() {
    fs.mkdirSync(this.eventsDir, { recursive: true });
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8')); } catch { /* 首次启动 */ }

    this.workspaceId = this.workspaceId || meta?.workspaceId || newId('ws');
    this.lastSeq = Number(meta?.lastSeq) || 0;
    const createdAt = Number(meta?.createdAt) || this.now();

    let maxSeq = 0;
    for (const name of this._files()) {
      const file = path.join(this.eventsDir, name);
      let raw = '';
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (Number.isInteger(ev.seq) && ev.seq > maxSeq) maxSeq = ev.seq;
        } catch { this.malformed++; }
      }
    }
    this.lastSeq = Math.max(this.lastSeq, maxSeq);
    this.lastTs = this.lastSeq ? this._lastTs() : 0;
    this.meta = { schemaVersion: 1, workspaceId: this.workspaceId, createdAt, lastSeq: this.lastSeq, updatedAt: this.now() };
    this._writeMeta();
    this.ready = true;
    return this;
  }

  _files() {
    try {
      return fs.readdirSync(this.eventsDir).filter((n) => EVENT_FILE_RE.test(n)).sort();
    } catch { return []; }
  }

  _lastTs() {
    const files = this._files();
    for (let i = files.length - 1; i >= 0; i--) {
      let raw = '';
      try { raw = fs.readFileSync(path.join(this.eventsDir, files[i]), 'utf8'); } catch { continue; }
      const lines = raw.split(/\r?\n/).filter(Boolean);
      for (let j = lines.length - 1; j >= 0; j--) {
        try {
          const ev = JSON.parse(lines[j]);
          if (Number.isInteger(ev.ts)) return ev.ts;
        } catch { /* 跳过损坏行 */ }
      }
    }
    return 0;
  }

  _writeMeta() {
    const raw = JSON.stringify({ ...this.meta, lastSeq: this.lastSeq, updatedAt: this.now() }, null, 2);
    const tmp = this.metaPath + '.tmp';
    try {
      fs.writeFileSync(tmp, raw);
      fs.renameSync(tmp, this.metaPath);
    } catch {
      fs.writeFileSync(this.metaPath, raw);
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    }
  }

  append(input = {}) {
    if (!this.ready) throw new Error('EventStore 尚未初始化');
    if (!input.type || typeof input.type !== 'string') throw new Error('事件缺少 type');
    const ts = Math.max(Number(input.ts) || this.now(), this.lastTs);
    const seq = ++this.lastSeq;
    this.lastTs = ts;
    const event = {
      seq,
      id: newId('evt', ts),
      ts,
      workspaceId: this.workspaceId,
      type: input.type,
      actor: input.actor || { kind: 'runtime', id: 'runtime' },
      taskId: input.taskId,
      runId: input.runId,
      stepId: input.stepId,
      payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
      redaction: input.redaction || 'summary',
      schemaVersion: 1,
    };

    const file = path.join(this.eventsDir, `${dayKey(ts)}.jsonl`);
    const line = JSON.stringify(event) + '\n';
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, line);
      if (TERMINAL_EVENTS.has(event.type) || input.fsync === true) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    if (TERMINAL_EVENTS.has(event.type) || seq % 50 === 0) this._writeMeta();
    this._emit(event);
    return event;
  }

  _emit(event) {
    for (const fn of this.subscribers) {
      try { fn(event); } catch { /* 订阅者异常不影响写入 */ }
    }
  }

  subscribe(fn) {
    if (typeof fn !== 'function') throw new Error('订阅必须传入函数');
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  read({ afterSeq = 0, limit = 500, runId } = {}) {
    const max = Math.max(1, Math.min(5000, Number(limit) || 500));
    const out = [];
    // 游标必须跟着「扫描到的最后一条」前进，而不是「取到的最后一条」：
    // 否则 runId 过滤掉整页时 afterSeq 不前进，分页会原地打转
    let scanned = afterSeq;
    let hasMore = false;

    for (const name of this._files()) {
      if (out.length >= max) { hasMore = true; break; }
      let raw = '';
      try { raw = fs.readFileSync(path.join(this.eventsDir, name), 'utf8'); } catch { continue; }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!Number.isInteger(ev.seq) || ev.seq <= afterSeq) continue;
        if (runId && ev.runId !== runId) continue;
        // 先判断“这一页满了”再推进游标：否则游标会跨过未取到的那条，翻页时丢事件
        if (out.length >= max) { hasMore = true; break; }
        if (ev.seq > scanned) scanned = ev.seq;
        out.push(ev);
      }
    }
    return { events: out, nextSeq: scanned, hasMore };
  }

  /**
   * 读全量事件（游标分页，直到没有更多）。
   * 用于图投影 / 收尾校验这类「必须看到完整历史」的场景。
   */
  readAll({ runId, batch = 5000, max = 200000 } = {}) {
    const cap = Number.isInteger(max) && max > 0 ? max : 200000;
    const pageSize = Math.max(1, Math.min(5000, Number(batch) || 5000));
    const out = [];
    let afterSeq = 0;
    for (let guard = 0; guard < 10000; guard++) {
      const page = this.read({ afterSeq, limit: pageSize, runId });
      if (page.events.length) out.push(...page.events);
      // 没有新扫描位置说明到底了（空页）
      if (page.nextSeq <= afterSeq && !page.events.length) break;
      afterSeq = page.nextSeq;
      if (!page.hasMore) break;
      if (out.length >= cap) break;
    }
    return out;
  }

  stats() {
    let files = 0;
    let bytes = 0;
    for (const name of this._files()) {
      files++;
      try { bytes += fs.statSync(path.join(this.eventsDir, name)).size; } catch { /* 忽略 */ }
    }
    return {
      workspaceId: this.workspaceId,
      lastSeq: this.lastSeq,
      eventLogOk: this.malformed === 0,
      malformedLines: this.malformed,
      files,
      bytes,
      dir: this.eventsDir,
    };
  }

  verify() {
    const seqs = [];
    let malformed = 0;
    for (const name of this._files()) {
      let raw = '';
      try { raw = fs.readFileSync(path.join(this.eventsDir, name), 'utf8'); } catch { continue; }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (Number.isInteger(ev.seq)) seqs.push(ev.seq);
        } catch { malformed++; }
      }
    }
    seqs.sort((a, b) => a - b);
    const gaps = [];
    const duplicates = [];
    for (let i = 1; i < seqs.length; i++) {
      if (seqs[i] === seqs[i - 1]) duplicates.push(seqs[i]);
      else if (seqs[i] > seqs[i - 1] + 1) gaps.push([seqs[i - 1], seqs[i]]);
    }
    return { ok: gaps.length === 0 && duplicates.length === 0 && malformed === 0, gaps, duplicates, malformed };
  }

  close() {
    this._writeMeta();
    this.subscribers.clear();
    this.ready = false;
  }
}

module.exports = { EventStore, TERMINAL_EVENTS };
