'use strict';

/* lib/retry.js 的纯函数单测：不启动服务、不伪造网络，只验证策略本身。 */

const assert = require('node:assert');
const r = require('../lib/retry');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('OK  ' + name); }
  catch (e) { fail++; console.log('XX  ' + name + ' | ' + e.message); }
};

// ── 状态码分类 ──
t('429 可重试', () => assert.equal(r.isRetryableStatus(429), true));
t('503 可重试', () => assert.equal(r.isRetryableStatus(503), true));
t('529 可重试', () => assert.equal(r.isRetryableStatus(529), true));
t('500 可重试', () => assert.equal(r.isRetryableStatus(500), true));
t('401 不重试', () => assert.equal(r.isRetryableStatus(401), false));
t('400 不重试', () => assert.equal(r.isRetryableStatus(400), false));
t('404 不重试', () => assert.equal(r.isRetryableStatus(404), false));
t('422 不重试', () => assert.equal(r.isRetryableStatus(422), false));
t('"503" 字符串也认', () => assert.equal(r.isRetryableStatus('503'), true));
t('undefined 不崩且不重试', () => assert.equal(r.isRetryableStatus(undefined), false));

// ── 网络错误分类 ──
const netErr = (code, message = '') => Object.assign(new Error(message || code), { code });
t('ECONNRESET 可重试', () => assert.equal(r.isRetryableNetworkError(netErr('ECONNRESET')), true));
t('ETIMEDOUT 可重试', () => assert.equal(r.isRetryableNetworkError(netErr('ETIMEDOUT')), true));
t('cause.code 也能识别', () => assert.equal(r.isRetryableNetworkError({ name: 'TypeError', message: 'fetch failed', cause: { code: 'EAI_AGAIN' } }), true));
t('socket hang up 文案可重试', () => assert.equal(r.isRetryableNetworkError(new Error('socket hang up')), true));
t('AbortError 不重试', () => assert.equal(r.isRetryableNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' })), false));
t('ENOENT 不重试', () => assert.equal(r.isRetryableNetworkError(netErr('ENOENT', 'no such file')), false));

// ── Electron / Chromium 风格网络错误（net::ERR_XXX）──
// 这组是线上真实踩到的坑：net.fetch 抛的是 net::ERR_CONNECTION_REFUSED，
// 而 Node 的白名单是 ECONNREFUSED，形态完全不同，曾被误判成不可重试。
t('Chromium ERR_CONNECTION_REFUSED 可重试',
  () => assert.equal(r.isRetryableNetworkError(new Error('net::ERR_CONNECTION_REFUSED')), true));
t('Chromium 错误放在 code 上也能识别',
  () => assert.equal(r.isRetryableNetworkError(netErr('net::ERR_CONNECTION_RESET')), true));
t('Chromium ERR_TIMED_OUT 可重试',
  () => assert.equal(r.isRetryableNetworkError(new Error('net::ERR_TIMED_OUT')), true));
t('Chromium ERR_NAME_NOT_RESOLVED 可重试',
  () => assert.equal(r.isRetryableNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED')), true));
t('Chromium ERR_EMPTY_RESPONSE 可重试',
  () => assert.equal(r.isRetryableNetworkError(new Error('net::ERR_EMPTY_RESPONSE')), true));
t('Chromium ERR_INCOMPLETE_CHUNKED_ENCODING 可重试',
  () => assert.equal(r.isRetryableNetworkError(new Error('net::ERR_INCOMPLETE_CHUNKED_ENCODING')), true));
t('Chromium ERR_UNSAFE_PORT 不重试（配置错误）',
  () => assert.equal(r.isRetryableNetworkError(new Error('net::ERR_UNSAFE_PORT')), false));
t('Chromium ERR_CERT_DATE_INVALID 不重试（证书错误）',
  () => assert.equal(r.isRetryableNetworkError(new Error('net::ERR_CERT_DATE_INVALID')), false));
t('Chromium ERR_INVALID_URL 不重试',
  () => assert.equal(r.isRetryableNetworkError(new Error('net::ERR_INVALID_URL')), false));
t('Chromium ERR_BLOCKED_BY_CLIENT 不重试',
  () => assert.equal(r.isRetryableNetworkError(new Error('net::ERR_BLOCKED_BY_CLIENT')), false));
t('ERR_UNSAFE_PORT 优先于宽松正则（不因含 connection 误判）',
  () => assert.equal(r.isRetryableNetworkError(new Error('net::ERR_UNSAFE_PORT connection refused')), false));
t('下划线形态的连接错误文案可重试',
  () => assert.equal(r.isRetryableNetworkError(new Error('CONNECTION_REFUSED')), true));

// ── Retry-After 解析 ──
const H = (obj) => ({ get: (k) => obj[k.toLowerCase()] ?? null });
t('retry-after 秒', () => assert.equal(r.parseRetryAfter(H({ 'retry-after': '7' })), 7000));
t('retry-after 小数秒', () => assert.equal(r.parseRetryAfter(H({ 'retry-after': '1.5' })), 1500));
t('retry-after-ms 优先', () => assert.equal(r.parseRetryAfter(H({ 'retry-after-ms': '1500', 'retry-after': '9' })), 1500));
t('retry-after HTTP 日期', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  const at = new Date(now + 12000).toUTCString();
  assert.equal(r.parseRetryAfter(H({ 'retry-after': at }), now), 12000);
});
t('过期日期夹到 0', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  assert.equal(r.parseRetryAfter(H({ 'retry-after': 'Thu, 01 Jan 1970 00:00:00 GMT' }), now), 0);
});
t('非法值返回 null', () => assert.equal(r.parseRetryAfter(H({ 'retry-after': 'soon' })), null));
t('没有头返回 null', () => assert.equal(r.parseRetryAfter(H({})), null));
t('普通对象头也支持', () => assert.equal(r.parseRetryAfter({ 'Retry-After': '3' }), 3000));
t('上限 10 分钟', () => assert.equal(r.parseRetryAfter(H({ 'retry-after': '99999' })), 600000));

// ── 退避曲线 ──
const opts = { baseDelayMs: 2000, factor: 2, maxDelayMs: 30000, jitter: 0 };
t('第 1 次 2s', () => assert.equal(r.backoffDelay(1, opts), 2000));
t('第 2 次 4s', () => assert.equal(r.backoffDelay(2, opts), 4000));
t('第 3 次 8s', () => assert.equal(r.backoffDelay(3, opts), 8000));
t('封顶 30s', () => assert.equal(r.backoffDelay(9, opts), 30000));
t('第 0 次按第 1 次算', () => assert.equal(r.backoffDelay(0, opts), 2000));
t('抖动落在 ±20%', () => {
  for (let i = 0; i < 200; i++) {
    const v = r.backoffDelay(3, { ...opts, jitter: 0.2 });
    if (v < 8000 * 0.8 || v > 8000 * 1.2) throw new Error(`越界 ${v}`);
  }
});

// ── 综合：有 Retry-After 用服务端的 ──
t('综合取值优先 Retry-After', () => {
  const v = r.nextDelay({ attempt: 1, headers: H({ 'retry-after': '5' }), opts });
  assert.equal(v, 5000);
});
t('无提示时走退避', () => {
  assert.equal(r.nextDelay({ attempt: 3, headers: H({}), opts }), 8000);
});

// ── 配置归一化 ──
t('默认配置', () => {
  const o = r.normalizeOptions();
  assert.equal(o.maxAttempts, 4);
  assert.equal(o.baseDelayMs, 2000);
});
t('clamp 到合法区间', () => {
  const o = r.normalizeOptions({ maxAttempts: 99, baseDelayMs: 1, maxDelayMs: 1e9 });
  assert.equal(o.maxAttempts, 8);
  assert.equal(o.baseDelayMs, 200);
  assert.equal(o.maxDelayMs, 120000);
});
t('非法值回落默认', () => {
  const o = r.normalizeOptions({ maxAttempts: 'x', baseDelayMs: null });
  assert.equal(o.maxAttempts, 4);
  assert.equal(o.baseDelayMs, 2000);
});

// ── 可中断 sleep ──
(async () => {
  const started = Date.now();
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 60);
  let aborted = false;
  try {
    await r.sleep(5000, ctrl.signal);
  } catch (e) {
    aborted = e.name === 'AbortError';
  }
  const spent = Date.now() - started;
  if (aborted && spent < 400) { pass++; console.log('OK  中止能立刻唤醒 sleep'); }
  else { fail++; console.log(`XX  中止能立刻唤醒 sleep | aborted=${aborted} spent=${spent}ms`); }

  let rej = false;
  const pre = new AbortController();
  pre.abort();
  try { await r.sleep(1000, pre.signal); } catch { rej = true; }
  if (rej) { pass++; console.log('OK  已中止的信号立即拒绝'); }
  else { fail++; console.log('XX  已中止的信号立即拒绝'); }

  const okStart = Date.now();
  await r.sleep(50);
  const okSpent = Date.now() - okStart;
  if (okSpent >= 40) { pass++; console.log('OK  正常 sleep 会等满'); }
  else { fail++; console.log(`XX  正常 sleep 会等满 | ${okSpent}ms`); }

  console.log(`\ntotal=${pass + fail} passed=${pass} failed=${fail}`);
  process.exit(fail ? 1 : 0);
})();
