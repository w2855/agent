'use strict';

const crypto = require('node:crypto');

/* ULID：48 位时间 + 80 位随机，Crockford Base32。同毫秒内单调递增，便于事件排序。 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const PREFIXES = new Set([
  'ws', 'agt', 'aver', 'prov', 'task', 'run', 'step', 'mcall', 'tcall',
  'pol', 'apr', 'del', 'prj', 'evt', 'mem', 'art', 'aud',
]);

let lastTime = 0;
let lastRand = 0n;

function encodeTime(ms, len = 10) {
  let t = BigInt(ms);
  let out = '';
  for (let i = 0; i < len; i++) {
    out = ALPHABET[Number(t & 31n)] + out;
    t >>= 5n;
  }
  return out;
}

function encodeRand(value, len = 16) {
  let r = value;
  let out = '';
  for (let i = 0; i < len; i++) {
    out = ALPHABET[Number(r & 31n)] + out;
    r >>= 5n;
  }
  return out;
}

function ulid(now = Date.now()) {
  if (now <= lastTime) {
    lastTime = lastTime || now;
    lastRand = (lastRand + 1n) & ((1n << 80n) - 1n);
  } else {
    lastTime = now;
    lastRand = BigInt('0x' + crypto.randomBytes(10).toString('hex'));
  }
  return encodeTime(lastTime) + encodeRand(lastRand);
}

function newId(prefix, now) {
  if (!PREFIXES.has(prefix)) throw new Error(`未知 ID 前缀：${prefix}`);
  return `${prefix}_${ulid(now)}`;
}

function isId(value, prefix) {
  const re = prefix ? new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`) : /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/;
  return typeof value === 'string' && re.test(value);
}

module.exports = { newId, isId, ulid, PREFIXES };
