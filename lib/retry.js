'use strict';

/* ─────────────────────────────────────────────
   自动重试策略（不依赖 Electron，可单独跑 node 测试）

   参考 opencode / pi-ai 的做法，只做三件事：
   1) 判断「这次失败值不值得重试」——可重试的 HTTP 状态与网络错误码白名单，
      参数错误 / 鉴权失败这类重试一百次也不会好的，一律不重试。
   2) 算等待多久——优先用服务端给的 Retry-After（秒或 HTTP 日期）与
      retry-after-ms，没有就指数退避 + 抖动，并封顶。
   3) 可中断的 sleep——用户点停止时必须立刻断掉，不能等退避结束。
   ───────────────────────────────────────────── */

const DEFAULTS = Object.freeze({
  maxAttempts: 4,      // 含首次请求
  baseDelayMs: 2000,   // 首次退避
  factor: 2,           // 2s → 4s → 8s
  maxDelayMs: 30000,   // 退避上限
  jitter: 0.2,         // ±20%，避免多客户端同时重试
});

/** 这些状态码代表「过一会儿可能就好了」。 */
const RETRYABLE_STATUS = new Set([
  408, // 请求超时
  409, // 冲突（部分网关用它在并发时让你重试）
  425, // Too Early
  429, // 限流 / 额度
  500, 502, 503, 504, 522, 524, 529, // 服务端 / 网关 / Cloudflare / 过载
]);

/** Node undici 与系统层的瞬时网络错误码。 */
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
]);

/* Electron 的 net.fetch 走 Chromium 网络栈，抛的是 net::ERR_XXX（下划线命名），
   与 Node 的 ECONNREFUSED 完全不同形，必须单独列一份，否则「连接被拒/被重置」
   这类最典型的瞬时故障会被误判成不可重试。 */
const RETRYABLE_CHROMIUM_CODES = new Set([
  'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_ABORTED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_CONNECTION_FAILED',
  'ERR_TIMED_OUT', 'ERR_EMPTY_RESPONSE', 'ERR_INCOMPLETE_CHUNKED_ENCODING',
  'ERR_CONTENT_LENGTH_MISMATCH', 'ERR_NAME_NOT_RESOLVED', 'ERR_NAME_RESOLUTION_FAILED',
  'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_ADDRESS_UNREACHABLE',
  'ERR_ADDRESS_INVALID', 'ERR_NETWORK_IO_SUSPENDED', 'ERR_SOCKET_NOT_CONNECTED',
  'ERR_SSL_CLIENT_AUTH_CERT_NEEDED', 'ERR_HTTP2_PING_FAILED',
  'ERR_QUIC_PROTOCOL_ERROR', 'ERR_HTTP2_PROTOCOL_ERROR', 'ERR_RESPONSE_HEADERS_TRUNCATED',
]);

/* 明确「重试也没用」的：配置写错、证书信任、策略拦截。列出来是为了不被下面
   的宽松正则误伤——宁可少重试，也不要把一个确定的配置错误重试 5 次。 */
const FATAL_CHROMIUM_CODES = new Set([
  'ERR_UNSAFE_PORT', 'ERR_INVALID_URL', 'ERR_INVALID_ARGUMENT', 'ERR_DISALLOWED_URL_SCHEME',
  'ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_REVOKED', 'ERR_SSL_PROTOCOL_ERROR', 'ERR_BLOCKED_BY_CLIENT',
  'ERR_TOO_MANY_REDIRECTS', 'ERR_UNKNOWN_URL_SCHEME', 'ERR_ACCESS_DENIED',
]);

const RETRYABLE_MESSAGE = /socket hang up|other side closed|fetch failed|network|connection[_ ](?:reset|refused|closed|aborted|timed[_ ]?out)|terminated|premature close|aborted by the server/i;

/** 从 'net::ERR_CONNECTION_REFUSED' / Error('net::ERR_X') 里抽出 ERR_XXX。 */
function chromiumCode(...candidates) {
  for (const raw of candidates) {
    if (raw == null) continue;
    const s = String(raw);
    const m = /(?:net::)?(ERR_[A-Z0-9_]+)/.exec(s);
    if (m) return m[1];
  }
  return null;
}

function isRetryableStatus(status) {
  const n = Number(status);
  return Number.isInteger(n) && RETRYABLE_STATUS.has(n);
}

/** 网络层异常是否属于「重试可能成功」。AbortError 永远不算。 */
function isRetryableNetworkError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;

  // Chromium 网络栈：先看是否命中「重试无用」名单，再判可重试
  const cc = chromiumCode(err.code, err.errno, err.message, err.cause?.code, err.cause?.message);
  if (cc) {
    if (FATAL_CHROMIUM_CODES.has(cc)) return false;
    if (RETRYABLE_CHROMIUM_CODES.has(cc)) return true;
  }

  const codes = [err.code, err.cause && err.cause.code, err.errno]
    .filter((x) => x != null)
    .map((x) => String(x).toUpperCase());
  if (codes.some((c) => RETRYABLE_NET_CODES.has(c))) return true;
  const msg = String(err.message || err.cause?.message || '');
  return RETRYABLE_MESSAGE.test(msg);
}

function headerReader(headers) {
  if (!headers) return () => null;
  if (typeof headers.get === 'function') return (k) => headers.get(k);
  const lower = Object.create(null);
  for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = v;
  return (k) => lower[String(k).toLowerCase()] ?? null;
}

/**
 * 解析服务端建议的等待时间，返回毫秒；没有/非法则 null。
 * 支持 `retry-after-ms`、`retry-after: 12`（秒）、`retry-after: <HTTP-date>`。
 */
function parseRetryAfter(headers, now = Date.now()) {
  const get = headerReader(headers);
  const cap = 600000; // 最多等 10 分钟，超过就按上限算

  const msRaw = get('retry-after-ms');
  if (msRaw != null && String(msRaw).trim() !== '') {
    const n = Number(msRaw);
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.round(n), cap);
  }

  const raw = get('retry-after');
  if (raw != null && String(raw).trim() !== '') {
    const s = String(raw).trim();
    if (/^\d+(?:\.\d+)?$/.test(s)) return Math.min(Math.round(Number(s) * 1000), cap);
    const at = Date.parse(s);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - now, cap));
  }
  return null;
}

/** 第 attempt 次失败后的退避时长（attempt 从 1 开始计）。 */
function backoffDelay(attempt, opts = {}) {
  const { baseDelayMs, factor, maxDelayMs, jitter } = { ...DEFAULTS, ...opts };
  const step = Math.max(0, Math.floor(Number(attempt) || 1) - 1);
  const raw = baseDelayMs * Math.pow(factor, step);
  const capped = Math.min(raw, maxDelayMs);
  const j = Math.max(0, Math.min(1, Number(jitter) || 0));
  if (!j) return Math.round(capped);
  const spread = capped * j;
  return Math.max(0, Math.round(capped - spread + Math.random() * spread * 2));
}

/**
 * 综合服务端建议与退避，给出最终等待时长。
 * 有 Retry-After 就信它（它是端点自己的节奏），但封顶 60 秒或 maxDelayMs（取大者），
 * 免得服务端给一个 10 分钟把人挂在那里。
 */
function nextDelay({ attempt, headers, opts = {} } = {}) {
  const { maxDelayMs } = { ...DEFAULTS, ...opts };
  const hinted = parseRetryAfter(headers);
  if (hinted != null) return Math.min(hinted, Math.max(maxDelayMs, 60000));
  return backoffDelay(attempt, opts);
}

/** 归一化用户配置，非法值回落默认，并把上限夹紧。 */
function normalizeOptions(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const missing = (v) => v === undefined || v === null || v === '';
  const num = (v, fallback) => {
    if (missing(v)) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const int = (v, min, max, fallback) => Math.max(min, Math.min(max, Math.floor(num(v, fallback))));
  const frac = (v, min, max, fallback) => Math.max(min, Math.min(max, num(v, fallback)));
  return {
    maxAttempts: int(src.maxAttempts, 1, 8, DEFAULTS.maxAttempts),
    baseDelayMs: int(src.baseDelayMs, 200, 10000, DEFAULTS.baseDelayMs),
    factor: frac(src.factor, 1, 4, DEFAULTS.factor),
    maxDelayMs: int(src.maxDelayMs, 1000, 120000, DEFAULTS.maxDelayMs),
    jitter: frac(src.jitter, 0, 1, DEFAULTS.jitter),
  };
}

/** 可中断 sleep：signal 中止时立刻 reject（AbortError），不残留定时器。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener?.('abort', onAbort);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

module.exports = {
  DEFAULTS,
  RETRYABLE_STATUS,
  isRetryableStatus,
  isRetryableNetworkError,
  parseRetryAfter,
  backoffDelay,
  nextDelay,
  normalizeOptions,
  sleep,
};
