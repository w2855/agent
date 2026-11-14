'use strict';

/* 统一安全网络层：URL 语法检查 → DNS 解析结果检查 → 手动逐跳重定向校验。
 *
 * 为什么不能只查 hostname：
 *   1) 域名可以解析到内网地址（evil.com → 10.0.0.5）；
 *   2) 公网地址可以 302 跳到 127.0.0.1（fetch 自动跟随就绕过了首跳检查）；
 *   3) IPv4/IPv6 存在大量特殊网段（NAT64、IPv4-mapped、链路本地、保留段）。
 *
 * 因此每一跳都重新做「解析 + 全量地址校验」，并且 redirect 一律 manual：
 * 读不出 Location 的 opaqueredirect 直接拒绝（安全默认），绝不盲目跟随。
 *
 * 已知残余风险（不在本模块能力范围内）：DNS rebinding —— 校验与连接之间存在
 * 时间窗，fetch 无法把连接绑定到已校验 IP。缓解方式是把解析结果缓存 60s 并
 * 对全部 A/AAAA 记录取交集校验，同时本应用的工具调用都发生在用户可见的
 * 单次动作里，风险窗口与影响面都可控。
 */

const dns = require('node:dns');
const net = require('node:net');

const MAX_REDIRECTS = 5;
const DNS_TTL_MS = 60000;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const BLOCKED_SUFFIX = ['.local', '.localhost', '.internal', '.lan', '.home.arpa', '.corp'];

/** host -> { at, addresses } */
const dnsCache = new Map();

/** 把点分十进制转成 32 位整数（非法返回 null） */
function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out * 256) + n;
  }
  return out >>> 0;
}

/* 拒绝的 IPv4 网段：本机/内网/链路本地/CGNAT/保留/组播/文档段/基准测试段 */
const PRIVATE_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0) }));

function isPrivateIPv4(ip) {
  const v = ipv4ToInt(ip);
  if (v === null) return true; // 解析不了按私有处理（安全默认）
  return PRIVATE_V4.some(({ base, mask }) => (v & mask) === (base & mask));
}

/** 展开 IPv6 为 16 字节数组；支持 :: 压缩与内嵌 IPv4（::ffff:1.2.3.4） */
function ipv6ToBytes(ip) {
  let text = String(ip).toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const v4mapped = text.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4mapped) {
    const v4 = ipv4ToInt(v4mapped[2]);
    if (v4 === null) return null;
    text = v4mapped[1] + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function bytesHavePrefix(bytes, prefix, bits) {
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) if (bytes[i] !== prefix[i]) return false;
  const rest = bits % 8;
  if (!rest) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (bytes[full] & mask) === (prefix[full] & mask);
}

const PRIVATE_V6 = [
  // ::/128 未指定
  { prefix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bits: 128 },
  // ::1/128 回环
  { prefix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], bits: 128 },
  // fc00::/7 唯一本地
  { prefix: [0xfc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bits: 7 },
  // fe80::/10 链路本地
  { prefix: [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bits: 10 },
  // ff00::/8 组播
  { prefix: [0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bits: 8 },
  // 2001:db8::/32 文档段
  { prefix: [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bits: 32 },
  // 64:ff9b::/96 NAT64：内嵌 IPv4 在最后 4 字节，单独判断
  { prefix: [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bits: 96 },
];

function isPrivateIPv6(ip) {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return true;
  // IPv4-mapped ::ffff:a.b.c.d —— 按内层 IPv4 判定
  const v4mapped = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff].every((b, i) => bytes[i] === b);
  if (v4mapped) return isPrivateIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  // NAT64 64:ff9b::/96 —— 若内层是私有地址，同样拒绝
  const nat64 = bytesHavePrefix(bytes, PRIVATE_V6[PRIVATE_V6.length - 1].prefix, 96);
  if (nat64 && isPrivateIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`)) return true;
  return PRIVATE_V6.some(({ prefix, bits }) => bytesHavePrefix(bytes, prefix, bits));
}

function isPrivateAddress(ip) {
  const family = net.isIP(String(ip || ''));
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

/** hostname 层的静态拦截（不需要 DNS）：localhost / 内网后缀 / 诡异写法 */
function isPrivateHostname(hostname) {
  const raw = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!raw) return true;
  if (raw === 'localhost' || raw === 'localhost.localdomain') return true;
  if (BLOCKED_SUFFIX.some((suffix) => raw.endsWith(suffix))) return true;
  if (net.isIP(raw)) return isPrivateAddress(raw);
  // 单标签主机名（如 http://intranet/）在 Windows 内网里很常见，按内网处理
  if (!raw.includes('.')) return true;
  // Windows 会把 0x7f.1 / 2130706433 之类的写法解析成 127.0.0.1，这类一律拒绝
  if (/^(0x[0-9a-f]+|\d+)$/.test(raw)) return true;
  return false;
}

async function resolveHost(host) {
  const now = Date.now();
  const cached = dnsCache.get(host);
  if (cached && now - cached.at < DNS_TTL_MS) return cached.addresses;
  const records = await dns.promises.lookup(host, { all: true, verbatim: true });
  const addresses = records.map((r) => String(r.address || '')).filter(Boolean);
  dnsCache.set(host, { at: now, addresses });
  return addresses;
}

/**
 * 校验一个 URL 是否可以安全访问（每一跳都要调用）。
 * @returns {Promise<{url: URL, href: string, host: string, addresses: string[]}>}
 */
async function assertPublicUrl(input) {
  let url;
  try { url = new URL(String(input || '')); } catch { throw new Error('URL 不合法'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https URL');
  if (url.username || url.password) throw new Error('URL 不允许携带凭据');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHostname(host)) throw new Error(`禁止访问本机与内网地址（SSRF 防护）：${host}`);
  const addresses = net.isIP(host) ? [host] : await resolveHost(host);
  if (!addresses.length) throw new Error(`域名无法解析：${host}`);
  for (const ip of addresses) {
    if (isPrivateAddress(ip)) throw new Error(`目标解析到内网/保留地址（SSRF 防护）：${host} → ${ip}`);
  }
  return { url, href: url.href, host, addresses };
}

function abortError() {
  const err = new Error('请求已取消');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

/**
 * 安全 fetch：手动处理重定向，每一跳都做 assertPublicUrl。
 * @param {string} href
 * @param {{signal?: AbortSignal, headers?: object, method?: string, timeoutMs?: number, maxRedirects?: number, doFetch?: Function}} opts
 */
async function safeFetch(href, opts = {}) {
  const doFetch = typeof opts.doFetch === 'function' ? opts.doFetch : fetch;
  const maxRedirects = Number.isInteger(opts.maxRedirects) ? Math.max(0, opts.maxRedirects) : MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : null;
  const onOuterAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) { if (timer) clearTimeout(timer); throw abortError(); }
    opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    let current = String(href);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const checked = await assertPublicUrl(current);
      const res = await doFetch(checked.href, {
        method: opts.method || 'GET',
        headers: opts.headers || undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res && REDIRECT_STATUS.has(res.status)) {
        const location = res.headers?.get ? res.headers.get('location') : null;
        if (!location) throw new Error('响应为跳转但缺少 Location 头，已拒绝');
        try { await res.body?.cancel?.(); } catch { /* 忽略 */ }
        current = new URL(location, checked.href).href;
        continue;
      }
      if (!res || res.status === 0 || res.type === 'opaqueredirect') {
        throw new Error('跳转目标不可验证（opaqueredirect），已拒绝访问');
      }
      return { response: res, finalUrl: checked.href };
    }
    throw new Error(`重定向次数超过上限（${maxRedirects}）`);
  } catch (err) {
    if (controller.signal.aborted && !(opts.signal && opts.signal.aborted)) {
      const e = new Error(`请求超过 ${opts.timeoutMs} 毫秒，已终止`);
      e.code = 'TIMEOUT';
      throw e;
    }
    if (opts.signal && opts.signal.aborted) throw abortError();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
  }
}

function clearDnsCache() {
  dnsCache.clear();
}

module.exports = {
  MAX_REDIRECTS,
  DNS_TTL_MS,
  REDIRECT_STATUS,
  assertPublicUrl,
  safeFetch,
  isPrivateAddress,
  isPrivateHostname,
  isPrivateIPv4,
  isPrivateIPv6,
  ipv4ToInt,
  ipv6ToBytes,
  clearDnsCache,
  abortError,
};
