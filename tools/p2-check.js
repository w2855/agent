'use strict';

/* 自检：稳定性守护纯逻辑（lib/instance-guard.js）。
   运行：node tools/p2-check.js */

const guard = require('../lib/instance-guard');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

(async () => {
  /* ───────── 1. 单实例锁判定 getLockResult ───────── */
  add('常量导出：窗口 60s / 阈值 3 / 日志上限 50',
    guard.CRASH_WINDOW_MS === 60 * 1000 && guard.CRASH_THRESHOLD === 3 && guard.CRASH_LOG_MAX_LINES === 50,
    `${guard.CRASH_WINDOW_MS}/${guard.CRASH_THRESHOLD}/${guard.CRASH_LOG_MAX_LINES}`);
  add('getLockResult：拿到锁 → isPrimary 且不退出', (() => {
    const r = guard.getLockResult(true);
    return r.isPrimary === true && r.shouldQuit === false;
  })(), 'ok');
  add('getLockResult：没拿到锁 → 退出', (() => {
    const r = guard.getLockResult(false);
    return r.isPrimary === false && r.shouldQuit === true;
  })(), 'ok');
  add('getLockResult：非布尔输入一律按没拿到锁处理（fail-closed，宁可误退不双开）', (() => {
    for (const v of [undefined, null, 0, 1, '', 'yes', {}]) {
      const r = guard.getLockResult(v);
      if (r.isPrimary !== false || r.shouldQuit !== true) return false;
    }
    return true;
  })(), 'ok');

  /* ───────── 2. CrashTracker：60s 窗口计数 + 软渲染标记 ───────── */
  add('CrashTracker：60s 内第 3 次崩溃触发软渲染标记，且只触发一次', (() => {
    const t = new guard.CrashTracker();
    const r1 = t.record(0);
    const r2 = t.record(10000);
    const r3 = t.record(20000);
    return r1.shouldMarkSoftRender === false && r2.shouldMarkSoftRender === false
      && r3.shouldMarkSoftRender === true && r3.count === 3
      && t.record(30000).shouldMarkSoftRender === false
      && t.isSoftRenderMarked() === true;
  })(), 'ok');
  add('CrashTracker：崩溃间隔 ≥ 60s 各自成窗，不累计不触发', (() => {
    const t = new guard.CrashTracker();
    return t.record(0).count === 1 && t.record(60000).count === 1
      && t.record(120000).count === 1 && t.isSoftRenderMarked() === false;
  })(), 'ok');
  add('CrashTracker：窗口边界——间隔恰好 60s 的旧样本被淘汰（与 notify-dedupe 边界一致）', (() => {
    const t = new guard.CrashTracker();
    t.record(0);
    return t.record(60000).count === 1 && t.record(120000).count === 1;
  })(), 'ok');
  add('CrashTracker：窗口内 2 次崩溃不触发', (() => {
    const t = new guard.CrashTracker();
    t.record(0);
    const r = t.record(1000);
    return r.count === 2 && r.shouldMarkSoftRender === false && t.isSoftRenderMarked() === false;
  })(), 'ok');
  add('CrashTracker：自定义窗口与阈值生效', (() => {
    const t = new guard.CrashTracker({ windowMs: 5000, threshold: 2 });
    const a = t.record(0);
    const b = t.record(4999);
    const c = new guard.CrashTracker({ windowMs: 5000, threshold: 2 }).record(5000);
    return a.shouldMarkSoftRender === false && b.shouldMarkSoftRender === true && c.count === 1;
  })(), 'ok');
  add('CrashTracker：非法时间戳不抛错，按当前时间计一次', (() => {
    const t = new guard.CrashTracker();
    return t.record('not-a-number').count === 1 && t.record(NaN).count === 2;
  })(), 'ok');
  add('CrashTracker：record 返回值带窗口/阈值上下文', (() => {
    const r = new guard.CrashTracker().record(0);
    return r.windowMs === 60000 && r.threshold === 3 && r.softRenderMarked === false;
  })(), 'ok');

  /* ───────── 3. crash-log.jsonl 环形裁剪 ───────── */
  add('parseJsonlLines：按行拆分、去首尾空白、丢空行（兼容 CRLF）', (() => {
    const lines = guard.parseJsonlLines('  {"a":1}\r\n\r\n{"b":2}\n\n');
    return lines.length === 2 && lines[0] === '{"a":1}' && lines[1] === '{"b":2}';
  })(), 'ok');
  add('parseJsonlLines：空 / 非字符串输入返回空数组',
    guard.parseJsonlLines('').length === 0 && guard.parseJsonlLines(null).length === 0
    && guard.parseJsonlLines(undefined).length === 0 && guard.parseJsonlLines(42).length === 0, 'ok');
  add('appendJsonlEntry：追加一条并以换行结尾，原记录保留', (() => {
    const out = guard.appendJsonlEntry('{"type":"boot","bootMs":1}\n', { type: 'render-crash', reason: 'crashed' });
    const lines = guard.parseJsonlLines(out);
    return lines.length === 2 && JSON.parse(lines[0]).bootMs === 1
      && JSON.parse(lines[1]).type === 'render-crash' && out.endsWith('\n');
  })(), 'ok');
  add('appendJsonlEntry：环形裁剪只保留最后 50 行且新记录在内', (() => {
    let raw = '';
    for (let i = 1; i <= 55; i++) raw = guard.appendJsonlEntry(raw, { type: 'boot', seq: i });
    const lines = guard.parseJsonlLines(raw);
    return lines.length === 50 && JSON.parse(lines[0]).seq === 6 && JSON.parse(lines[49]).seq === 55;
  })(), 'ok');
  add('appendJsonlEntry：已有内容正好 50 行时，追加后新记录不被挤掉', (() => {
    let raw = '';
    for (let i = 1; i <= 50; i++) raw = guard.appendJsonlEntry(raw, { seq: i });
    raw = guard.appendJsonlEntry(raw, { seq: 51 });
    const lines = guard.parseJsonlLines(raw);
    return lines.length === 50 && JSON.parse(lines[0]).seq === 2 && JSON.parse(lines[49]).seq === 51;
  })(), 'ok');
  add('appendJsonlEntry：entry 为 null 兜底空对象；坏行原样保留且照常参与裁剪计数', (() => {
    const out = guard.appendJsonlEntry('not-json\n{"type":"boot"}\n', null);
    const lines = guard.parseJsonlLines(out);
    return lines.length === 3 && lines[0] === 'not-json'
      && typeof JSON.parse(lines[2]) === 'object' && Object.keys(JSON.parse(lines[2])).length === 0;
  })(), 'ok');
  add('keepLastLines：maxLines 非法时回退默认 50', (() => {
    const lines = Array.from({ length: 60 }, (_, i) => String(i));
    return guard.keepLastLines(lines, 0).length === 50 && guard.keepLastLines(lines, NaN).length === 50
      && guard.keepLastLines(null).length === 0;
  })(), 'ok');
  add('summarizeCrashLog：行数与最后一条记录的 type', (() => {
    const s = guard.summarizeCrashLog('{"type":"boot"}\n{"type":"render-crash"}\n');
    return s.lines === 2 && s.lastType === 'render-crash';
  })(), 'ok');
  add('summarizeCrashLog：末行坏 JSON 回退到上一条可解析记录', (() => {
    const s = guard.summarizeCrashLog('{"type":"boot"}\n{oops\n');
    return s.lines === 2 && s.lastType === 'boot';
  })(), 'ok');
  add('summarizeCrashLog：空文件 lines=0 lastType=null', (() => {
    const s = guard.summarizeCrashLog('');
    return s.lines === 0 && s.lastType === null;
  })(), 'ok');

  const result = { checks, total: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.failed ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
