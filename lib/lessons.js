'use strict';

/* ─────────────────────────────────────────────
   验证经验库（verified-lessons）——借鉴 ruflo 的「验证后入库」模式：
   1) 追加式 JSONL（userData/lessons.jsonl），一行一条，只在任务/委派收尾时写入；
   2) 入库前逐字段校验与清洗（控制字符 → 空格，保证单行 JSON）；
   3) 幂等：按 (taskId, kind) 去重，重复收尾不重复入库；
   4) 容错：读文件时损坏行跳过并计数，绝不抛错中断调用方；
   5) 有界：环形上限（超过 MAX_LESSONS 裁最旧），文件不会无限增长。

   纯函数与文件 IO 分离：文件 IO 只收敛在 createLessonStore(path) 工厂里，
   recordLesson / queryLessons / stats 只通过 store 的 readAll/appendLine 读写，
   便于自检脚本直接构造内存 store 或临时文件 store。
   ───────────────────────────────────────────── */

const fs = require('node:fs');
const path = require('node:path');

/** 记录类型：outcome = 任务/委派收尾结果；lesson = 提炼出的经验教训 */
const KINDS = new Set(['outcome', 'lesson']);
/** 收尾结果枚举（ruflo：只记录被验证过的终态） */
const OUTCOMES = new Set(['success', 'failed', 'canceled']);
/** 环形上限：文件超过这么多条时裁掉最旧的 */
const MAX_LESSONS = 500;
/** 各字符串字段的截断上限（ruflo text()：先清洗再截断） */
const TASK_ID_MAX = 80;
const AGENT_MAX = 60;
const SUMMARY_MAX = 300;
const TAG_MAX_LEN = 40;
const MAX_TAGS = 8;
/** evidence 只保留这两个白名单字段（ruflo：未知字段不存活） */
const EVIDENCE_KEYS = ['runId', 'errorCode'];
const EVIDENCE_VALUE_MAX = 80;

/** 清洗一段文本：控制字符（含换行）替换为空格 → trim → 截断，保证 JSONL 单行 */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** 清洗标签数组：字符串化、去空、去重、限量限长 */
function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const tag = cleanText(item, TAG_MAX_LEN);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 清洗 evidence：只保留白名单字段，逐值清洗截断 */
function normalizeEvidence(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of EVIDENCE_KEYS) {
    const value = cleanText(raw[key], EVIDENCE_VALUE_MAX);
    if (value) out[key] = value;
  }
  return out;
}

/** 校验并归一化一条记录；非法输入返回 { error }（不抛错，由调用方决定如何计数） */
function normalizeEntry(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'entry 必须是对象' };
  }
  const taskId = cleanText(input.taskId, TASK_ID_MAX);
  if (!taskId) return { error: 'taskId 必填' };
  const kind = input.kind === 'lesson' ? 'lesson' : input.kind === 'outcome' ? 'outcome' : '';
  if (!kind) return { error: 'kind 必须是 outcome / lesson' };
  let outcome;
  if (kind === 'outcome') {
    // outcome 记录必须携带合法的收尾结果（ruflo：未验证的结果不入库）
    if (!OUTCOMES.has(input.outcome)) return { error: 'outcome 记录的 outcome 必须是 success / failed / canceled' };
    outcome = input.outcome;
  } else if (OUTCOMES.has(input.outcome)) {
    outcome = input.outcome; // lesson 记录可选携带结果标注
  }
  const summary = cleanText(input.summary, SUMMARY_MAX);
  const ts = Number.isFinite(input.ts) && input.ts > 0 ? Math.floor(input.ts) : Math.floor(now);
  const agentId = cleanText(input.agentId, AGENT_MAX);
  return {
    entry: {
      taskId,
      kind,
      ...(agentId ? { agentId } : {}),
      ...(outcome ? { outcome } : {}),
      summary,
      tags: normalizeTags(input.tags),
      evidence: normalizeEvidence(input.evidence),
      ts,
    },
  };
}

/** 幂等键：(taskId, kind)。taskId 已过 cleanText，控制字符不会出现，分隔符安全 */
function dedupeKey(taskId, kind) {
  return `${taskId}\u0001${kind}`;
}

/**
 * 文件 IO 工厂：返回 { path, readAll, appendLine }。
 * 创建时不做任何 IO（懒加载），第一次读写才触盘。
 */
function createLessonStore(filePath) {
  if (!filePath || typeof filePath !== 'string') throw new Error('createLessonStore 需要 path');
  return {
    path: path.resolve(filePath),

    /** 读全量：损坏行 / 非法行跳过并计数；文件不存在返回 missing。绝不抛错 */
    readAll() {
      let raw;
      try {
        raw = fs.readFileSync(this.path, 'utf8');
      } catch {
        return { entries: [], corrupted: 0, missing: true };
      }
      const entries = [];
      let corrupted = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)
            && typeof obj.taskId === 'string' && obj.taskId && KINDS.has(obj.kind)) {
            entries.push(obj);
          } else {
            corrupted++;
          }
        } catch {
          corrupted++;
        }
      }
      return { entries, corrupted, missing: false };
    },

    /** 追加一行；目录/文件不存在自动创建。 */
    appendLine(line) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.appendFileSync(this.path, line + '\n', 'utf8');
    },
  };
}

/**
 * 追加一条记录。
 * 返回 { ok:true, entry }（新写入）/ { ok:true, deduped:true, entry:已有记录 }（幂等命中）
 * 或 { ok:false, reason, detail }（校验失败）。除 store 非法外不抛错。
 */
function recordLesson(store, input, { now = Date.now() } = {}) {
  if (!store || typeof store.path !== 'string' || typeof store.readAll !== 'function' || typeof store.appendLine !== 'function') {
    throw new Error('recordLesson 需要 createLessonStore 创建的 store');
  }
  const norm = normalizeEntry(input, now);
  if (norm.error) return { ok: false, reason: 'INVALID_ENTRY', detail: norm.error };

  const { entries } = store.readAll();
  const key = dedupeKey(norm.entry.taskId, norm.entry.kind);
  const existing = entries.find((e) => dedupeKey(e.taskId, e.kind) === key);
  if (existing) return { ok: true, deduped: true, entry: existing };

  store.appendLine(JSON.stringify(norm.entry));

  // 环形上限：超过 MAX_LESSONS 时原子重写，只保留最新的 MAX_LESSONS 条
  const total = entries.length + 1;
  if (total > MAX_LESSONS) {
    const keep = entries.slice(total - MAX_LESSONS); // entries 不含刚追加的一条：保留最新 MAX-1 条旧记录
    keep.push(norm.entry);
    const tmp = `${store.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    try {
      fs.renameSync(tmp, store.path);
    } catch {
      // rename 失败（跨卷/占用）退化为覆盖写，尽力而为
      try { fs.writeFileSync(store.path, keep.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'); } catch { /* 保留旧文件 */ }
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    }
  }
  return { ok: true, entry: norm.entry };
}

/**
 * 过滤查询：tags（AND 语义，须全部命中）/ outcome（精确）/ sinceTs（ts >= ）
 * / limit（返回最新的 N 条）。返回按 ts 降序排列。
 */
function queryLessons(store, { tags, outcome, limit, sinceTs } = {}) {
  const { entries, corrupted } = store.readAll();
  const wantedTags = normalizeTags(tags);
  let filtered = entries.filter((e) => {
    if (outcome && e.outcome !== outcome) return false;
    if (Number.isFinite(sinceTs) && !(Number(e.ts) >= sinceTs)) return false;
    if (wantedTags.length) {
      const own = Array.isArray(e.tags) ? e.tags : [];
      if (!wantedTags.every((t) => own.includes(t))) return false;
    }
    return true;
  });
  filtered = filtered.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : filtered.length;
  return { entries: filtered.slice(0, max), total: filtered.length, corrupted };
}

/** 聚合统计：按 outcome 与 tag 计数，附总数、损坏行与时间范围 */
function stats(store) {
  const { entries, corrupted } = store.readAll();
  const byOutcome = {};
  for (const key of OUTCOMES) byOutcome[key] = 0;
  const byTag = {};
  let firstTs = 0;
  let lastTs = 0;
  for (const e of entries) {
    if (e.outcome) byOutcome[e.outcome] = (byOutcome[e.outcome] || 0) + 1;
    for (const tag of Array.isArray(e.tags) ? e.tags : []) {
      byTag[tag] = (byTag[tag] || 0) + 1;
    }
    const ts = Number(e.ts) || 0;
    if (ts && (!firstTs || ts < firstTs)) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
  }
  return { total: entries.length, corrupted, byOutcome, byTag, firstTs, lastTs };
}

module.exports = {
  KINDS,
  OUTCOMES,
  MAX_LESSONS,
  cleanText,
  normalizeEntry,
  normalizeTags,
  normalizeEvidence,
  dedupeKey,
  createLessonStore,
  recordLesson,
  queryLessons,
  stats,
};
