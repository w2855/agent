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

/* ── 验证门 / 污点判定 / 置信门（对应 ruflo verified-guards.ts 与 verified-lessons.ts） ──
   1) detectTaint：任务工具链里写入了测试文件或验证器配置 → outcome 打 tainted（防"改考卷"自欺）；
   2) detectVerification：工具链里跑过 test/build/typecheck 类命令且退出码 0 → verified=true；
   3) confidenceFor：某 tag 的可信经验是否可用（verified 成功 + 连续失败 → caution）。
   verified=false 的 outcome 在 stats/query 默认排除（可显式含入）；tainted 记录不参与统计可信度。 */
/** verifiedBy 命令列表的上限（条数 / 单条长度） */
const MAX_VERIFIED_BY = 10;
const VERIFIED_BY_MAX = 80;
/** taintReason 文本上限 */
const TAINT_REASON_MAX = 120;
/** 置信门：verified 失败达到该值且存在 verified 成功 → caution（ruflo CAUTION_MIN_FAILURES） */
const CAUTION_MIN_FAILURES = 2;
/** 验证类命令关键词（test/build/tsc/npm run/pnpm 等；词边界匹配，避免 checkout 误命中 check） */
const VERIFY_COMMAND_RE = /\b(?:tests?|spec|build|tsc|typecheck|type-check|lint|vitest|jest|mocha|pytest|npm run|pnpm run|yarn run|go test|cargo (?:test|build)|make)\b/i;
/** 测试文件识别（ruflo verified-lessons TEST_FILE：*.test.* / *.spec.* / test_*.py / *_test.go|rs） */
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[^./]+$|^test_[^/]*\.py$|_test\.(?:go|rs|py)$)/i;
/** 测试目录（命中即视为测试文件） */
const TEST_DIRS = new Set(['__tests__', 'tests', 'test']);
/** 验证器配置识别（ruflo VERIFIER_CONFIG：改这些文件等于改了"考卷"） */
const VERIFIER_CONFIG_RE = /^(?:package\.json|package-lock\.json|vitest\.config\.[^/]+|jest\.config\.[^/]+|karma\.conf\.[^/]+|pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|Cargo\.toml|go\.mod|tsconfig[^/]*\.json|eslint\.config\.[^/]+|\.eslintrc[^/]*|Makefile)$/i;

/** 归一化路径分隔符（Windows 反斜杠 → 正斜杠），供污点判定匹配 */
function normPath(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : '';
}

/** 是否测试文件：文件名命中 TEST_FILE_RE，或位于测试目录下 */
function isTestFile(p) {
  const pathStr = normPath(p);
  if (!pathStr) return false;
  const segs = pathStr.split('/');
  if (TEST_FILE_RE.test(segs[segs.length - 1])) return true;
  return segs.slice(0, -1).some((d) => TEST_DIRS.has(d.toLowerCase()));
}

/** 是否验证器配置文件：按文件名（basename）匹配 */
function isVerifierConfig(p) {
  const pathStr = normPath(p);
  if (!pathStr) return false;
  const segs = pathStr.split('/');
  return VERIFIER_CONFIG_RE.test(segs[segs.length - 1]);
}

/** 清洗 verifiedBy 命令列表：去空、去重、限量限长 */
function normalizeVerifiedBy(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const cmd = cleanText(item, VERIFIED_BY_MAX);
    if (cmd && !out.includes(cmd)) out.push(cmd);
    if (out.length >= MAX_VERIFIED_BY) break;
  }
  return out;
}

/**
 * 污点判定（ruflo verified-guards §2.1/§2.2 的纯函数版，防 agent 自欺）。
 * 输入任务收尾前的工具执行链 [{ name, args, ok }]（ok=true 表示工具成功执行），
 * 输出 { tainted, reason }：
 *   - 成功 write_file 到测试文件（*.test.* / *.spec.* / 测试目录 / test_*.py / *_test.go|rs）→ 'edited-tests'
 *   - 成功 write_file 到验证器配置（package.json / vitest|jest.config / tsconfig / pytest.ini 等）→ 'edited-verifier-config'
 *   - 两类同时命中 → reason 用 '+' 连接（顺序固定）
 * 失败（ok !== true）或非 write_file 的调用不产生污点；非法输入一律视为未污染。
 */
function detectTaint(toolCalls) {
  const classes = [];
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls.slice(0, 200)) {
      if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
      if (call.ok !== true || call.name !== 'write_file') continue;
      const p = normPath(call.args && call.args.path);
      if (!p) continue;
      if (isTestFile(p) && !classes.includes('edited-tests')) classes.push('edited-tests');
      if (isVerifierConfig(p) && !classes.includes('edited-verifier-config')) classes.push('edited-verifier-config');
    }
  }
  // reason 顺序固定为规范序（edited-tests 在前），与工具链内的出现顺序无关
  classes.sort((a, b) => a.localeCompare(b));
  return { tainted: classes.length > 0, reason: classes.join('+') };
}

/**
 * 验证门（纯函数版）：输入工具执行链 [{ name, args, ok, exitCode }]，
 * 输出 { verified, verifiedBy }：
 *   - 出现 run_command 且命令文本命中验证类关键词（test/build/tsc/npm run/pnpm 等）
 *     且退出码 === 0 → verified=true，verifiedBy 收集命中的命令文本（去重限量）；
 *   - 命中关键词但退出码非 0（验证失败）或工具链里没有验证类命令 → verified=false。
 */
function detectVerification(toolCalls) {
  const verifiedBy = [];
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls.slice(0, 200)) {
      if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
      if (call.name !== 'run_command') continue;
      const cmd = call.args && typeof call.args.command === 'string' ? call.args.command : '';
      if (!cmd || !VERIFY_COMMAND_RE.test(cmd)) continue;
      if (Number(call.exitCode) === 0 && verifiedBy.length < MAX_VERIFIED_BY) {
        const text = cleanText(cmd, VERIFIED_BY_MAX);
        if (text && !verifiedBy.includes(text)) verifiedBy.push(text);
      }
    }
  }
  return { verified: verifiedBy.length > 0, verifiedBy };
}

/**
 * 置信门（ruflo verified-lessons 的 CAUTION_MIN_FAILURES 模式）。
 * counts 为某 tag 下「可信」outcome 计数 { successes, failures }
 * （只统计 verified=true 且未污染的记录）：
 *   - verified-success ≥1 且 failed ≥2 → 'caution'（该 tag 的经验需谨慎对待）
 *   - 全部为 verified-success（≥1 条且 0 失败）→ 'trusted'
 *   - 其余（无成功 / 失败不足 / 数据缺失）→ 'insufficient'
 */
function confidenceFor(tag, counts) {
  const c = counts && typeof counts === 'object' && !Array.isArray(counts) ? counts : {};
  const successes = Math.max(0, Math.floor(Number(c.successes)) || 0);
  const failures = Math.max(0, Math.floor(Number(c.failures)) || 0);
  if (successes >= 1 && failures >= CAUTION_MIN_FAILURES) return 'caution';
  if (successes >= 1 && failures === 0) return 'trusted';
  return 'insufficient';
}

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
  // 验证门 / 污点判定字段（ruflo verified-guards）：只在 outcome 记录上生效；
  // outcome 记录始终携带 verified 布尔（缺省 false = 未验证），tainted 只在为真时落盘
  const gated = kind === 'outcome';
  const verified = gated ? input.verified === true : undefined;
  const tainted = gated ? input.tainted === true : false;
  const verifiedBy = gated ? normalizeVerifiedBy(input.verifiedBy) : [];
  const taintReason = gated ? cleanText(input.taintReason, TAINT_REASON_MAX) : '';
  return {
    entry: {
      taskId,
      kind,
      ...(agentId ? { agentId } : {}),
      ...(outcome ? { outcome } : {}),
      summary,
      tags: normalizeTags(input.tags),
      evidence: normalizeEvidence(input.evidence),
      ...(gated ? { verified } : {}),
      ...(gated && verifiedBy.length ? { verifiedBy } : {}),
      ...(tainted ? { tainted: true, ...(taintReason ? { taintReason } : {}) } : {}),
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
 * 验证门（防自欺）：outcome 记录默认只返回 verified=true 且未污染的；
 * includeUnverified / includeTainted 可显式含入。lesson 记录不受门槛影响。
 */
function queryLessons(store, { tags, outcome, limit, sinceTs, includeUnverified = false, includeTainted = false } = {}) {
  const { entries, corrupted } = store.readAll();
  const wantedTags = normalizeTags(tags);
  let filtered = entries.filter((e) => {
    if (e.kind === 'outcome') {
      // 污染记录不参与可信结果；未验证（含门槛上线前的旧记录）默认排除
      if (e.tainted === true) { if (!includeTainted) return false; }
      else if (e.verified !== true && !includeUnverified) return false;
    }
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

/**
 * 聚合统计：byOutcome/byTag 默认只统计「可信」条目（outcome 须 verified=true 且未污染，
 * lesson 记录不受限）；includeUnverified / includeTainted 可显式含入（仅影响可见性，
 * 置信统计永远排除污染记录）。total/corrupted/时间范围永远是全量文件事实。
 * 附 per-tag 置信门 confidence（confidenceFor）与 byTagOutcome 明细。
 */
function stats(store, { includeUnverified = false, includeTainted = false } = {}) {
  const { entries, corrupted } = store.readAll();
  const byOutcome = {};
  for (const key of OUTCOMES) byOutcome[key] = 0;
  const byTag = {};
  const byTagOutcome = {};
  let unverified = 0;
  let tainted = 0;
  let firstTs = 0;
  let lastTs = 0;
  for (const e of entries) {
    const ts = Number(e.ts) || 0;
    if (ts && (!firstTs || ts < firstTs)) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
    const isTainted = e.kind === 'outcome' && e.tainted === true;
    const isUnverified = e.kind === 'outcome' && e.verified !== true;
    if (isTainted) tainted++;
    if (isUnverified) unverified++;
    // 污染记录永不参与可信统计；未验证记录默认排除（显式含入只影响可见性）
    if (isTainted ? !includeTainted : (isUnverified && !includeUnverified)) continue;
    if (e.outcome) byOutcome[e.outcome] = (byOutcome[e.outcome] || 0) + 1;
    for (const tag of Array.isArray(e.tags) ? e.tags : []) {
      byTag[tag] = (byTag[tag] || 0) + 1;
      // 置信统计只用 verified=true 且未污染的成功/失败 outcome
      if (e.kind === 'outcome' && e.verified === true && (e.outcome === 'success' || e.outcome === 'failed')) {
        const c = byTagOutcome[tag] || (byTagOutcome[tag] = { successes: 0, failures: 0 });
        if (e.outcome === 'success') c.successes++;
        else c.failures++;
      }
    }
  }
  const confidence = {};
  for (const tag of Object.keys(byTagOutcome)) confidence[tag] = confidenceFor(tag, byTagOutcome[tag]);
  for (const tag of Object.keys(byTag)) if (!(tag in confidence)) confidence[tag] = 'insufficient';
  return { total: entries.length, corrupted, unverified, tainted, byOutcome, byTag, byTagOutcome, confidence, firstTs, lastTs };
}

module.exports = {
  KINDS,
  OUTCOMES,
  MAX_LESSONS,
  CAUTION_MIN_FAILURES,
  cleanText,
  normalizeEntry,
  normalizeTags,
  normalizeEvidence,
  normalizeVerifiedBy,
  dedupeKey,
  isTestFile,
  isVerifierConfig,
  detectTaint,
  detectVerification,
  confidenceFor,
  createLessonStore,
  recordLesson,
  queryLessons,
  stats,
};
