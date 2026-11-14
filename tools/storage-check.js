'use strict';

/* persist-store 自检（不依赖 Electron）：node tools/storage-check.js
   覆盖：持久化跨实例、原子落盘、去抖合并、删除、键/值校验、损坏文件自愈、退出 flush。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { createPersistStore } = require('../lib/persist-store');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-store-'));
const filePath = path.join(tmpDir, 'nested', 'dsh-storage.json');
let pass = 0;

function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name); }
  catch (err) { console.log('  ✗', name, '→', err.message); process.exitCode = 1; }
}

console.log('[storage-check]', filePath);

ok('首次启动无文件 → 空库', () => {
  const s = createPersistStore({ filePath, debounceMs: 0 });
  assert.equal(s.stats().keys, 0);
  assert.equal(s.get('dsh.conn'), null);
});

ok('写入后 flushSync 落盘，新实例读到同一份数据（模拟重启/换构建方式）', () => {
  const s = createPersistStore({ filePath, debounceMs: 0 });
  s.set('dsh.sessions.model', '{"sessions":[{"id":"m-1"}]}');
  s.set('dsh.theme2', 'dark');
  s.flushSync();
  const s2 = createPersistStore({ filePath, debounceMs: 0 });
  assert.equal(s2.get('dsh.theme2'), 'dark');
  assert.ok(s2.get('dsh.sessions.model').includes('m-1'));
});

ok('去抖：未到窗口不写盘，flushSync 补写', () => {
  const f2 = path.join(tmpDir, 'debounce.json');
  const s = createPersistStore({ filePath: f2, debounceMs: 5000 });
  s.set('dsh.x', '1');
  assert.equal(fs.existsSync(f2), false, '去抖窗口内不应写盘');
  s.flushSync();
  assert.equal(fs.existsSync(f2), true, 'flushSync 必须立即落盘');
});

ok('setMany 批量迁移 + 去重（同值不重复写）', () => {
  const f3 = path.join(tmpDir, 'many.json');
  const s = createPersistStore({ filePath: f3, debounceMs: 0 });
  const r = s.setMany({ 'dsh.a': '1', 'dsh.b': '2' });
  assert.equal(r.changed, 2);
  const r2 = s.setMany({ 'dsh.a': '1', 'dsh.b': '3' });
  assert.equal(r2.changed, 1);
  s.flushSync();
  const s2 = createPersistStore({ filePath: f3, debounceMs: 0 });
  assert.equal(s2.get('dsh.b'), '3');
});

ok('remove 删除并落盘', () => {
  const f4 = path.join(tmpDir, 'rm.json');
  const s = createPersistStore({ filePath: f4, debounceMs: 0 });
  s.set('dsh.gone', 'x');
  s.flushSync();
  s.remove('dsh.gone');
  s.flushSync();
  assert.equal(createPersistStore({ filePath: f4, debounceMs: 0 }).get('dsh.gone'), null);
});

ok('非法键 / 非字符串值被拒，不污染库', () => {
  const s = createPersistStore({ filePath, debounceMs: 0 });
  assert.equal(s.set('bad key!', 'x').ok, false);
  assert.equal(s.set('dsh.ok', 123).ok, false);
  assert.equal(s.set('', 'x').ok, false);
});

ok('损坏文件自愈：改名留证 + 重建空库，不抛异常', () => {
  const f5 = path.join(tmpDir, 'corrupt.json');
  fs.mkdirSync(path.dirname(f5), { recursive: true });
  fs.writeFileSync(f5, '{ this is not json ');
  const s = createPersistStore({ filePath: f5, debounceMs: 0 });
  assert.equal(s.stats().keys, 0);
  assert.ok(s.stats().lastError.includes('JSON'));
  const backed = fs.readdirSync(tmpDir).some((n) => n.startsWith('corrupt.json.corrupt-'));
  assert.ok(backed, '损坏文件应改名留证');
});

ok('原子写：不残留 .tmp 文件', () => {
  const list = fs.readdirSync(path.dirname(filePath));
  assert.equal(list.some((n) => n.endsWith('.tmp')), false);
});

console.log(`[storage-check] ${pass} 项通过`);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
