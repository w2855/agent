'use strict';

/* ─────────────────────────────────────────────
   persist-store：文件型键值存储（userData/dsh-storage.json）
   存在理由：localStorage 按 origin 键控 —— 开发版（file:///E:/dsh-desktop/renderer/index.html）
   与打包版（asar 内路径）是两个 origin，两套 localStorage，换构建方式聊天记录必丢。
   把关键数据搬到主进程文件后与 origin 无关，开发/打包共用同一份历史。

   约束：
   1) 同步读（getAll 供 preload sendSync 一次带走），同步写盘（原子 tmp+rename）；
   2) 写盘去抖（默认 200ms），退出前 flushSync 兜底，绝不因去抖丢数据；
   3) 文件损坏 → 原文件改名 .corrupt-<ts> 保留证据后重建空库，不让应用起不来；
   4) 纯 Node（不含 electron 依赖），可被 tools/ 下的自检直接 require 单测。
   ───────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE_MS = 200;
const MAX_VALUE_BYTES = 32 * 1024 * 1024; // 单键上限 32MB：防跑飞的写入把磁盘写爆
const KEY_RE = /^[A-Za-z0-9._:-]{1,160}$/;

function createPersistStore(opts = {}) {
  const filePath = opts.filePath;
  if (!filePath || typeof filePath !== 'string') throw new Error('persist-store: 缺少 filePath');
  const debounceMs = Number.isFinite(opts.debounceMs) ? Math.max(0, opts.debounceMs) : DEFAULT_DEBOUNCE_MS;
  const fsImpl = opts.fs || fs;
  const now = opts.now || (() => Date.now());

  let data = null;
  let timer = null;
  let dirty = false;
  let lastError = '';
  let writes = 0;
  let loads = 0;

  function ensureDir() {
    try { fsImpl.mkdirSync(path.dirname(filePath), { recursive: true }); } catch { /* 目录已存在或无权限，写盘时会暴露 */ }
  }

  function load() {
    if (data) return data;
    loads += 1;
    let raw = null;
    try {
      raw = fsImpl.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') { data = {}; return data; }
      lastError = String(err && err.message ? err.message : err);
      data = {};
      return data;
    }
    if (!raw || !raw.trim()) { data = {}; return data; }
    try {
      const parsed = JSON.parse(raw);
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      // 损坏：留证 + 重建，宁可丢一次也要能启动（下次写盘会把空库覆盖回去）
      lastError = 'JSON 解析失败：' + String(err && err.message ? err.message : err);
      try { fsImpl.renameSync(filePath, `${filePath}.corrupt-${now()}`); } catch { /* 留证失败不阻塞 */ }
      data = {};
    }
    return data;
  }

  function writeNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return { ok: true, skipped: true };
    ensureDir();
    const tmp = `${filePath}.tmp`;
    const payload = JSON.stringify(data);
    try {
      fsImpl.writeFileSync(tmp, payload, 'utf8');
      fsImpl.renameSync(tmp, filePath); // 原子替换：断电最多丢一次去抖窗口，不会留半截文件
      dirty = false;
      writes += 1;
      lastError = '';
      return { ok: true, bytes: Buffer.byteLength(payload) };
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      return { ok: false, error: lastError };
    }
  }

  function schedule() {
    if (debounceMs === 0) return writeNow();
    if (timer) return;
    timer = setTimeout(() => { timer = null; writeNow(); }, debounceMs);
    if (timer.unref) timer.unref(); // 不因待写定时器拖住进程退出
  }

  function getAll() {
    return { ...load() };
  }

  function get(key) {
    const d = load();
    return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : null;
  }

  function set(key, value) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return { ok: false, error: 'KEY_INVALID' };
    if (typeof value !== 'string') return { ok: false, error: 'VALUE_NOT_STRING' };
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) return { ok: false, error: 'VALUE_TOO_LARGE' };
    const d = load();
    if (d[key] === value) return { ok: true, unchanged: true };
    d[key] = value;
    dirty = true;
    schedule();
    return { ok: true };
  }

  function setMany(obj) {
    if (!obj || typeof obj !== 'object') return { ok: false, error: 'PAYLOAD_INVALID' };
    const d = load();
    let changed = 0;
    const rejected = [];
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k !== 'string' || !KEY_RE.test(k) || typeof v !== 'string') { rejected.push(k); continue; }
      if (Buffer.byteLength(v) > MAX_VALUE_BYTES) { rejected.push(k); continue; }
      if (d[k] !== v) { d[k] = v; changed += 1; }
    }
    if (changed) { dirty = true; schedule(); }
    return { ok: true, changed, rejected };
  }

  function remove(key) {
    const d = load();
    if (!Object.prototype.hasOwnProperty.call(d, key)) return { ok: true, missing: true };
    delete d[key];
    dirty = true;
    schedule();
    return { ok: true };
  }

  function stats() {
    const d = load();
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(d)); } catch { bytes = 0; }
    return {
      path: filePath,
      keys: Object.keys(d).length,
      bytes,
      dirty,
      pending: !!timer,
      writes,
      loads,
      lastError,
    };
  }

  return { load, getAll, get, set, setMany, remove, flushSync: writeNow, stats, filePath };
}

module.exports = { createPersistStore, MAX_VALUE_BYTES, DEFAULT_DEBOUNCE_MS };
