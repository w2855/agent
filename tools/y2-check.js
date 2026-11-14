'use strict';

/* Y2 启动提速自检（node 直跑，不依赖 electron）：lib/boot-timer.js 的纯逻辑断言。
 * 运行：node tools/y2-check.js —— 全过退出码 0，任一失败退出码 1。
 */

const assert = require('node:assert');
const { BootTimer, BOOT_STAGE_NAMES } = require('../lib/boot-timer');

/** 假时钟：逐步推进的确定性时间源 */
function fakeClock() {
  let t = 0;
  return { now: () => t, at: (v) => { t = v; } };
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

/** 断言 fn() 抛出且消息含片段 */
function assertThrows(fn, fragment) {
  let threw = null;
  try { fn(); } catch (err) { threw = err; }
  assert.ok(threw, `应抛出含「${fragment}」的错误，实际未抛`);
  assert.ok(String(threw.message).includes(fragment), `错误消息应含「${fragment}」，实际：${threw.message}`);
}

console.log('BootTimer 阶段打点纯逻辑自检：');

/* ── 1. 完整生命周期：stages 数值精确 ── */
check('begin/mark/end 的 stages 耗时逐段精确', () => {
  const c = fakeClock();
  const t = new BootTimer(c.now);
  t.begin('spawn', 0);
  c.at(10); t.mark('whenReady');      // spawn = 10
  c.at(25); t.mark('createWindow');   // whenReady = 15
  c.at(30); t.mark('did-finish-load'); // createWindow = 5
  t.end(40);                          // did-finish-load = 10
  assert.deepStrictEqual(t.stages(), { spawn: 10, whenReady: 15, createWindow: 5, 'did-finish-load': 10 });
});

check('snapshot().total = 首点到 end 的总耗时', () => {
  const c = fakeClock();
  const t = new BootTimer(c.now);
  t.begin('spawn', 0);
  c.at(100); t.mark('whenReady'); t.end(140);
  assert.strictEqual(t.snapshot().total, 140);
});

check('end 后 open=null、ended=true', () => {
  const t = new BootTimer(() => 0);
  t.begin('spawn'); t.mark('whenReady'); t.end();
  assert.strictEqual(t.snapshot().open, null);
  assert.strictEqual(t.ended, true);
});

/* ── 2. 部分快照（renderer-ready 未上报时的中间态） ── */
check('end 前：最后一阶段值为 null、open 指向它、total=null', () => {
  const c = fakeClock();
  const t = new BootTimer(c.now);
  t.begin('spawn', 0);
  c.at(10); t.mark('whenReady');
  c.at(20); t.mark('did-finish-load');
  const snap = t.snapshot();
  assert.deepStrictEqual(snap.stages, { spawn: 10, whenReady: 10, 'did-finish-load': null });
  assert.strictEqual(snap.open, 'did-finish-load');
  assert.strictEqual(snap.total, null);
  assert.strictEqual(t.ended, false);
});

check('只有 begin 时 stages 只含 null 的首阶段', () => {
  const t = new BootTimer(() => 5);
  t.begin('spawn');
  assert.deepStrictEqual(t.stages(), { spawn: null });
});

/* ── 3. 时间戳回填与钳制 ── */
check('显式时间戳可用（begin 回填进程拉起时刻）', () => {
  const t = new BootTimer(() => 500);
  t.begin('spawn', 120); // backdate：Date.now() - uptime
  t.mark('whenReady', 500);
  t.end(500);
  assert.strictEqual(t.stages().spawn, 380);
});

check('时间戳倒退时耗时钳到 0（不为负）', () => {
  const t = new BootTimer(() => 0);
  t.begin('spawn', 100);
  t.mark('whenReady', 50);
  t.end(50);
  assert.strictEqual(t.stages().spawn, 0);
  assert.strictEqual(t.stages().whenReady, 0);
});

/* ── 4. has() 守卫（activate 重建窗口的重复路径） ── */
check('has() 对已打/未打的阶段名返回正确', () => {
  const t = new BootTimer(() => 0);
  t.begin('spawn');
  t.mark('createWindow');
  assert.strictEqual(t.has('createWindow'), true);
  assert.strictEqual(t.has('spawn'), true);
  assert.strictEqual(t.has('whenReady'), false);
});

/* ── 5. 误用防护：全部抛错 ── */
check('begin 两次抛错', () => {
  const t = new BootTimer(() => 0);
  t.begin('spawn');
  assertThrows(() => t.begin('whenReady'), 'begin 只能调用一次');
});

check('mark 前未 begin 抛错', () => {
  const t = new BootTimer(() => 0);
  assertThrows(() => t.mark('whenReady'), '先 begin');
});

check('end 后 mark 抛错', () => {
  const t = new BootTimer(() => 0);
  t.begin('spawn'); t.end();
  assertThrows(() => t.mark('whenReady'), 'end 之后不能再 mark');
});

check('end 两次抛错', () => {
  const t = new BootTimer(() => 0);
  t.begin('spawn'); t.end();
  assertThrows(() => t.end(), 'end 只能调用一次');
});

check('同名阶段重复 mark 抛错', () => {
  const t = new BootTimer(() => 0);
  t.begin('spawn'); t.mark('whenReady');
  assertThrows(() => t.mark('whenReady'), '阶段名重复');
});

check('空/非字符串阶段名抛错', () => {
  const t = new BootTimer(() => 0);
  assertThrows(() => t.begin(''), '非空字符串');
  assertThrows(() => t.begin(42), '非空字符串');
  t.begin('spawn');
  assertThrows(() => t.mark(null), '非空字符串');
});

check('非有限时间戳抛错', () => {
  const t = new BootTimer(() => 0);
  assertThrows(() => t.begin('spawn', Number.NaN), '有限数字');
  t.begin('spawn');
  assertThrows(() => t.mark('whenReady', Infinity), '有限数字');
});

check('非函数时间源抛错', () => {
  assertThrows(() => new BootTimer('now'), '时间源必须是函数');
});

/* ── 6. 默认时间源冒烟 + 约定阶段名表 ── */
check('默认 Date.now 时间源可完整走通一遍', () => {
  const t = new BootTimer();
  t.begin('spawn'); t.mark('whenReady'); t.end();
  const s = t.stages();
  assert.strictEqual(typeof s.spawn, 'number');
  assert.strictEqual(typeof s.whenReady, 'number');
});

check('BOOT_STAGE_NAMES 与主进程打点顺序一致', () => {
  assert.deepStrictEqual(BOOT_STAGE_NAMES,
    ['spawn', 'whenReady', 'createWindow', 'did-finish-load', 'renderer-ready']);
});

console.log(`\n共 ${passed} 项断言通过${process.exitCode ? '（存在失败）' : ''}`);
