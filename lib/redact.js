'use strict';

/**
 * lib/redact.js — PII/敏感信息脱敏管线核心（ruflo AIDefence 四档模式）
 *
 * 四档动作：
 *   BLOCK  — 命中即抛 RedactBlockedError（整条文本中止，绝不半替换）
 *   REDACT — 替换为 [REDACTED:<type>]
 *   HASH   — 替换为 [HASH:<sha256 前 12 位>]（同值同哈希，可做关联分析）
 *   PASS   — 原样保留
 *
 * 设计要点：
 *   - 零第三方依赖（sha256 用 Node 内置 crypto）
 *   - 所有正则均为「字面量前缀 + 有界量词」或定长结构，无灾难性回溯（逐条见注释）
 *   - private_key 整块优先匹配（PATTERNS 首位），块内子串不会被其他规则拆散泄漏
 *   - 重叠命中按 PATTERNS 优先级去重，先到先得
 *   - 本模块只做文本级脱敏；调用方负责在日志/导出/崩溃上报等出口接入
 */

const crypto = require('crypto');

/** redactValue 对象递归深度上限（第 MAX_DEPTH 层对象原样返回，不再下钻） */
const MAX_DEPTH = 6;
/** findings.sample 最大保留字符数（超长截断加省略号，防止 findings 本身泄漏大块敏感数据） */
const SAMPLE_MAX = 64;
/** 全部合法动作 */
const ACTIONS = ['BLOCK', 'REDACT', 'HASH', 'PASS'];

// ---------------------------------------------------------------------------
// 敏感类型正则表。数组顺序即优先级：越靠前优先级越高，重叠时保留靠前的命中。
// 逐条自查：无嵌套无限定量词，回溯均有界，无灾难性回溯。
// ---------------------------------------------------------------------------
const PATTERNS = [
  {
    type: 'private_key',
    // PEM 私钥整块（RSA/EC/DSA/OPENSSH 等大写变体）。[\s\S]*? 惰性跨行，
    // 两端为字面量锚定，最坏单起点 O(n) 线性，安全。放首位：整块优先。
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    type: 'api_key',
    // sk-/pk- 前缀密钥（OpenAI/Stripe 风格），主体至少 16 位。单个有界量词 + \b 边界。
    re: /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    type: 'api_key',
    // Bearer 令牌：捕获组只取 token 本体，替换后保留 "Bearer " 前缀。
    // 组位于匹配末尾，start 可用「匹配尾-组长度」精确推算（组内字符集不含空白，
    // 不可能在 "Bearer " 前缀中提前出现）。
    re: /\bBearer\s+([A-Za-z0-9._-]{16,})/g,
    group: 1,
  },
  {
    type: 'jwt',
    // JWT 三段式。eyJ 是 base64url("{\"") 的固定前缀；三段均 {10,}/{5,} 有界，
    // 段间以字面量 '.' 分隔，回溯被段长天然截断。
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  {
    type: 'email',
    // 邮箱：local 1-64、domain 1-255、TLD 2-24 全部有界；左右 lookaround 防「从长串中间截出假邮箱」。
    // 单量词 + 有界回溯，最坏每起点 O(320)，安全。
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z0-9]{2,24}(?![A-Za-z0-9])/g,
  },
  {
    type: 'phone_cn',
    // 中国大陆手机号：1 开头、第二位 3-9、共 11 位；前后 lookaround 排除更长数字串。
    re: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  },
  {
    type: 'id_card_cn',
    // 18 位身份证（宽松版：末位可为 X/x，不校验 checksum）；前后不能是数字。
    re: /(?<!\d)\d{17}[\dXx](?!\d)/g,
  },
  {
    type: 'cred_kv',
    // 键值对凭据：password/passwd/pwd/secret/token/api[_-]key 后接 = 或 :，值取到首个空白为止。
    // 用 lookbehind 代替 \b：允许 my_token/access-token（下划线、连字符前缀），
    // 禁止字母数字前缀（避免 keywords、APIToken 之类中途误配）。
    re: /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi,
  },
];

/** 全部已支持类型（去重，按优先级顺序） */
const KNOWN_TYPES = [...new Set(PATTERNS.map((p) => p.type))];

// ---------------------------------------------------------------------------
// 三套内置 profile
// ---------------------------------------------------------------------------
const profiles = {
  // strict：高危类型直接 BLOCK（宁可拒发不可外泄），个人信息类 REDACT
  strict: {
    private_key: 'BLOCK',
    api_key: 'BLOCK',
    jwt: 'BLOCK',
    email: 'REDACT',
    phone_cn: 'REDACT',
    id_card_cn: 'REDACT',
    cred_kv: 'REDACT',
  },
  // standard：全部替换（默认档）
  standard: {
    private_key: 'REDACT',
    api_key: 'REDACT',
    jwt: 'REDACT',
    email: 'REDACT',
    phone_cn: 'REDACT',
    id_card_cn: 'REDACT',
    cred_kv: 'REDACT',
  },
  // off：全放行（仅用于明确无敏感数据的出口）
  off: {
    private_key: 'PASS',
    api_key: 'PASS',
    jwt: 'PASS',
    email: 'PASS',
    phone_cn: 'PASS',
    id_card_cn: 'PASS',
    cred_kv: 'PASS',
  },
};

/** BLOCK 中止错误：type=首个阻断类型，types=去重类型清单，count=命中总数，hits=分类型计数 */
class RedactBlockedError extends Error {
  constructor(blockedTypes) {
    const hits = {};
    for (const t of blockedTypes) hits[t] = (hits[t] || 0) + 1;
    const summary = Object.keys(hits).map((t) => t + '×' + hits[t]).join(', ');
    super('[redact] 命中 BLOCK 规则，文本整体中止: ' + summary);
    this.name = 'RedactBlockedError';
    this.type = blockedTypes[0];
    this.types = [...new Set(blockedTypes)];
    this.count = blockedTypes.length;
    this.hits = hits;
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function describeType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function truncateSample(s) {
  if (s.length <= SAMPLE_MAX) return s;
  return s.slice(0, SAMPLE_MAX) + '…';
}

/** 与 [HASH:...] 占位符同源的 sha256 前 12 位 */
function sha256Prefix(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);
}

/**
 * 重叠去重：raw 已按 PATTERNS 优先级顺序收集，与已保留命中重叠的一律丢弃（先到先得）。
 * 例：private_key 块内的 cred_kv 子命中被整块命中吞掉；token=sk-… 只保留 api_key。
 * 输出按 start 升序（同起点长者在前）。
 */
function dedupFindings(raw) {
  const kept = [];
  for (const f of raw) {
    let overlapped = false;
    for (const k of kept) {
      if (f.start < k.end && k.start < f.end) { overlapped = true; break; }
    }
    if (!overlapped) kept.push(f);
  }
  kept.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  return kept;
}

// ---------------------------------------------------------------------------
// 核心 API
// ---------------------------------------------------------------------------

/**
 * 扫描文本中的敏感信息。
 * @param {string} text
 * @returns {Array<{type: string, start: number, end: number, sample: string}>}
 *          按 start 升序、互不重叠；sample 为命中原文（超过 SAMPLE_MAX 截断加省略号）。
 */
function scanForPII(text) {
  if (typeof text !== 'string') {
    throw new TypeError('[redact] scanForPII 需要字符串输入，实际收到: ' + describeType(text));
  }
  const raw = [];
  for (const p of PATTERNS) {
    // 带 g 标志的正则含 lastIndex 状态，每次扫描克隆一份，避免复用/并发污染
    const re = new RegExp(p.re.source, p.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      let start = m.index;
      let end = start + m[0].length;
      if (p.group) {
        // 捕获组位于整个匹配末尾（如 Bearer 只脱敏 token 本体）
        end = start + m[0].length;
        start = end - m[p.group].length;
      }
      if (end > start) {
        raw.push({ type: p.type, start, end, sample: truncateSample(text.slice(start, end)) });
      }
      if (m[0].length === 0) re.lastIndex++; // 防御零宽匹配死循环（当前各正则不会出现，双保险）
    }
  }
  return dedupFindings(raw);
}

/**
 * rules 归一化：接受 [{type, action}] 数组、profile 名字符串、或空（默认 standard）。
 * 返回 Map<type, action>；rules 未覆盖的类型一律 PASS（显式传入的 rules 是白名单语义）。
 */
function resolveActions(rules) {
  const map = new Map();
  if (rules === undefined || rules === null) {
    for (const t of KNOWN_TYPES) map.set(t, profiles.standard[t]);
    return map;
  }
  if (typeof rules === 'string') {
    const p = profiles[rules];
    if (!p) {
      throw new Error('[redact] 未知 profile: ' + rules + '（可选: ' + Object.keys(profiles).join('/') + '）');
    }
    for (const t of KNOWN_TYPES) map.set(t, p[t]);
    return map;
  }
  if (!Array.isArray(rules)) {
    throw new TypeError('[redact] rules 需为 [{type, action}] 数组、profile 名或空，实际收到: ' + describeType(rules));
  }
  for (const r of rules) {
    if (!r || typeof r.type !== 'string') {
      throw new TypeError('[redact] rules 项缺少 type 字段: ' + JSON.stringify(r));
    }
    if (ACTIONS.indexOf(r.action) === -1) {
      throw new Error('[redact] 未知 action: ' + describeType(r.action) + '（可选: ' + ACTIONS.join('/') + '）');
    }
    map.set(r.type, r.action);
  }
  return map;
}

/**
 * 对已扫描 findings 应用动作表（内部）。BLOCK 前置统一检查，绝不半替换。
 * 输出按位置升序切片拼装，O(n + k) 一次成型。
 */
function applyFindings(text, findings, actionMap) {
  const blockedTypes = [];
  for (const f of findings) {
    if ((actionMap.get(f.type) || 'PASS') === 'BLOCK') blockedTypes.push(f.type);
  }
  if (blockedTypes.length > 0) throw new RedactBlockedError(blockedTypes);

  const parts = [];
  let pos = 0;
  for (const f of findings) {
    const action = actionMap.get(f.type) || 'PASS';
    if (action === 'PASS') continue;
    parts.push(text.slice(pos, f.start));
    parts.push(
      action === 'REDACT'
        ? '[REDACTED:' + f.type + ']'
        : '[HASH:' + sha256Prefix(text.slice(f.start, f.end)) + ']'
    );
    pos = f.end;
  }
  parts.push(text.slice(pos));
  return parts.join('');
}

/**
 * 文本脱敏。
 * @param {string} text
 * @param {Array<{type:string, action:string}>|string} [rules] 动作规则数组或 profile 名；缺省 standard
 * @returns {string} BLOCK 档命中时抛 RedactBlockedError
 */
function redactText(text, rules) {
  if (typeof text !== 'string') {
    throw new TypeError('[redact] redactText 需要字符串输入，实际收到: ' + describeType(text));
  }
  const findings = scanForPII(text);
  return applyFindings(text, findings, resolveActions(rules));
}

/** 校验并归一 profile 名（缺省 standard） */
function profileName(name) {
  const key = name === undefined || name === null ? 'standard' : name;
  if (!profiles[key]) {
    throw new Error('[redact] 未知 profile: ' + String(key) + '（可选: ' + Object.keys(profiles).join('/') + '）');
  }
  return key;
}

/**
 * 管线入口：扫描 + 应用 profile/rules。
 * @param {string} text
 * @param {{profile?: string, rules?: Array<{type:string,action:string}>}} [opts]
 *        显式 rules 优先于 profile。
 * @returns {{text: string, findings: Array, blocked: boolean, error?: RedactBlockedError}}
 *          blocked=true 时 text 为原文、error 携带明细；findings 始终基于原始文本位置。
 */
function pipeline(text, opts) {
  if (typeof text !== 'string') {
    throw new TypeError('[redact] pipeline 需要字符串输入，实际收到: ' + describeType(text));
  }
  const o = opts || {};
  const findings = scanForPII(text);
  const actionMap = (o.rules !== undefined && o.rules !== null)
    ? resolveActions(o.rules)
    : resolveActions(profileName(o.profile));
  try {
    return { text: applyFindings(text, findings, actionMap), findings, blocked: false };
  } catch (e) {
    if (e instanceof RedactBlockedError) {
      // BLOCK 档：原文返回，blocked=true，error 携带明细
      return { text, findings, blocked: true, error: e };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// redactValue — 结构化数据递归脱敏
// ---------------------------------------------------------------------------

/** 不展开的特殊对象（展开会破坏语义） */
function isOpaqueObject(v) {
  return v instanceof Date
    || v instanceof RegExp
    || v instanceof Map
    || v instanceof Set
    || v instanceof Error
    || ArrayBuffer.isView(v) // TypedArray / DataView
    || (typeof Buffer !== 'undefined' && Buffer.isBuffer(v));
}

/**
 * 递归脱敏对象/数组中的字符串字段，返回全新结构（不改原值）。
 * @param {*} value 任意值
 * @param {Array<{type:string,action:string}>|string} [rules] 同 redactText；BLOCK 命中会向上抛出
 * @param {number} [depth=0] 内部递归深度
 * @returns {*} 新值；循环引用处替换为 '[Circular]'（WeakSet 按当前递归路径判定，
 *          非环共享引用会各自生成独立副本）
 * 深度语义：第 0..MAX_DEPTH-1 层正常下钻脱敏；到达 MAX_DEPTH 层的对象原样返回
 *（其中的字符串不再脱敏——调用方应从源头限制嵌套深度）。
 */
function redactValue(value, rules, depth = 0, seen = null) {
  // 字符串：任何深度都走 redactText（深度上限只限制对象下钻，不影响字符串脱敏）
  if (typeof value === 'string') return redactText(value, rules);
  // 原始值（number/boolean/null/undefined/bigint/symbol/function）：原样返回
  if (value === null || typeof value !== 'object') return value;
  // 深度上限：不再下钻，原样返回
  if (depth >= MAX_DEPTH) return value;
  // 特殊对象不展开
  if (isOpaqueObject(value)) return value;
  // 循环引用：WeakSet 记录当前递归路径上的对象，重入即判定为环
  const visited = seen || new WeakSet();
  if (visited.has(value)) return '[Circular]';
  visited.add(value);

  let out;
  if (Array.isArray(value)) {
    out = value.map((v) => redactValue(v, rules, depth + 1, visited));
  } else {
    out = {};
    for (const key of Object.keys(value)) {
      out[key] = redactValue(value[key], rules, depth + 1, visited);
    }
  }
  // 回溯：移出当前路径——兄弟分支引用同一对象不算环（各自产生独立副本）
  visited.delete(value);
  return out;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

module.exports = {
  // 核心 API
  scanForPII,   // (text) => [{type, start, end, sample}]
  redactText,   // (text, rules?) => string
  pipeline,     // (text, {profile?, rules?}?) => {text, findings, blocked, error?}
  redactValue,  // (value, rules?, depth=0) => 新结构（字符串字段已脱敏）
  // 配套
  profiles,           // {strict, standard, off}
  RedactBlockedError,
  // 辅助/内部（供自检与上层复用）
  PATTERNS,     // 内部正则表（含 type/group），勿在热路径外改动
  KNOWN_TYPES,  // ['private_key','api_key','jwt','email','phone_cn','id_card_cn','cred_kv']
  ACTIONS,      // ['BLOCK','REDACT','HASH','PASS']
  MAX_DEPTH,
  SAMPLE_MAX,
  sha256Prefix, // 与 [HASH:...] 同源的 sha256 前 12 位
};
