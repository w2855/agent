'use strict';

/* ─────────────────────────────────────────────
   x1 接线自检：PII 脱敏出口（notify:show / export:session / appendCrashLog）
   + Doctor 经验库 IPC（lessons:summary / lessons:tail）。

   node tools/x1-check.js 直跑。main.js 的 IPC 层无法脱离 Electron，
   这里用 Module._load 拦截 require('electron') 注入 mock（ipcMain.handle
   只登记不执行），然后 require('../main.js') 驱动真实处理函数：
   - mock 通知类记录 new Notification(...) 与 show() 调用，可断言「BLOCK 不发送」
   - mock dialog 记录 showSaveDialog，导出断言走显式 targetPath（跳过对话框）
   - mock app.getPath('userData') 指向临时目录，经验库/crash-log 隔离落盘

   真实通道往返（含 BLOCK 场景不崩溃）见 tools/x1-probe.js 的 Electron 探针。
   ───────────────────────────────────────────── */

const Module = require('node:module');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ── 1. electron mock ─────────────────────────────────────────── */

const mockPaths = { userData: fs.mkdtempSync(path.join(os.tmpdir(), 'x1-ud-')), appData: os.tmpdir() };
const shownNotifications = [];   // 每个真实发出去的通知（new Notification + show()）
const dialogCalls = [];          // showSaveDialog 调用记录

const electronMock = {
  app: {
    isPackaged: false,
    getPath: (name) => (name === 'userData' ? mockPaths.userData : (mockPaths[name] || os.tmpdir())),
    setPath: (name, dir) => { mockPaths[name] = dir; },
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), // 永不 ready：不启动窗口/运行时，只登记 IPC
    on: () => {},
    quit: () => {},
    setAppUserModelId: () => {},
    disableHardwareAcceleration: () => {},
  },
  nativeTheme: { themeSource: 'system' },
  ipcMain: {
    _handlers: new Map(),
    _listeners: new Map(),
    handle: (ch, fn) => electronMock.ipcMain._handlers.set(ch, fn),
    on: (ch, fn) => electronMock.ipcMain._listeners.set(ch, fn),
  },
  Notification: class {
    constructor(opts) { this.opts = opts || {}; }
    show() { shownNotifications.push(this.opts); }
    on() {}
  },
  Notification_isSupported_true: true,
  BrowserWindow: class {},
  dialog: {
    showSaveDialog: async (_win, opts) => { dialogCalls.push(opts); return { canceled: true }; },
  },
  shell: { openExternal: () => {} },
  Menu: { buildFromTemplate: () => ({}) },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} destroy() {} },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  net: {},
  safeStorage: { isEncryptionAvailable: () => false },
};
// static 方法挂到 class 上（Notification.isSupported()）
electronMock.Notification.isSupported = () => true;

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronMock;
  return origLoad.apply(this, arguments);
};

/* ── 2. 载入真实 main.js（顶层只登记 IPC，不会启动运行时） ───────── */
const main = require('../main.js');

/** 调 mock 登记的 invoke 处理函数 */
const invoke = (channel, payload) => electronMock.ipcMain._handlers.get(channel)(null, payload);

/* ── 3. 断言小工具（沿用 tools/ 其他自检的 t() 风格） ─────────── */
let pass = 0;
let failCount = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('OK  ' + name); }
  catch (e) { failCount++; console.log('XX  ' + name + ' | ' + (e?.message || e)); }
};
const tAsync = async (name, fn) => {
  try { await fn(); pass++; console.log('OK  ' + name); }
  catch (e) { failCount++; console.log('XX  ' + name + ' | ' + (e?.message || e)); }
};
const tmpFile = (n) => path.join(os.tmpdir(), 'x1-export-' + n + '-' + Date.now() + '.md');
const SK = 'sk-abcdef12345678901234'; // 21 位主体的 OpenAI 风格假密钥（strict 档必 BLOCK）

(async () => {
  /* ═══════ A. notify:show（profile='strict'）═══════ */

  t('notify.blockSkipsNotification', () => {
    const before = shownNotifications.length;
    const r = main.showOsNotification({ title: '任务完成', body: '密钥 ' + SK + ' 泄露在日志里' });
    assert.strictEqual(r.blocked, true, '返回需含 blocked:true，实际 ' + JSON.stringify(r));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(shownNotifications.length, before, 'BLOCK 时不得 new/show 系统通知');
  });

  t('notify.blockTypesReported', () => {
    const r = main.showOsNotification({ body: 'Bearer ' + 'x'.repeat(24) });
    assert.strictEqual(r.blocked, true);
    assert.ok(Array.isArray(r.types) && r.types.includes('api_key'), 'types 需含 api_key: ' + JSON.stringify(r.types));
  });

  t('notify.blockViaIpcHandler', () => {
    const r = invoke('notify:show', { title: 'sk-' + SK });
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(r.ok, false);
  });

  t('notify.redactEmailThenSend', () => {
    const r = main.showOsNotification({ body: '联系 alice@example.com 查收结果' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.blocked, undefined, 'REDACT 档不得标记 blocked');
    const last = shownNotifications[shownNotifications.length - 1];
    assert.ok(last, 'REDACT 后应照发系统通知');
    assert.ok(last.body.includes('[REDACTED:email]'), '正文需含 [REDACTED:email]: ' + last.body);
    assert.ok(!last.body.includes('alice@example.com'), '原文邮箱不得残留');
  });

  t('notify.cleanTextUntouched', () => {
    const r = main.showOsNotification({ title: 'DSH', body: '后台任务已完成，无敏感信息' });
    assert.strictEqual(r.ok, true);
    const last = shownNotifications[shownNotifications.length - 1];
    assert.strictEqual(last.title, 'DSH');
    assert.strictEqual(last.body, '后台任务已完成，无敏感信息');
  });

  t('notify.titleBlockedAlsoBlocks', () => {
    const before = shownNotifications.length;
    const r = main.showOsNotification({ title: 'key ' + SK, body: '正常正文' });
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(shownNotifications.length, before, '标题命中 BLOCK 也不发');
  });

  t('notify.blockDoesNotConsumeDedupeWindow', () => {
    const tag = 'x1-dedupe-' + Date.now();
    const r1 = main.showOsNotification({ body: '密钥 ' + SK, tag });           // BLOCK：不应消费窗口
    const r2 = main.showOsNotification({ body: '正常通知正文', tag });          // 同 tag：应照发
    assert.strictEqual(r1.blocked, true);
    assert.ok(!(r2 && r2.deduped), 'BLOCK 不应消耗 30s 去重窗口，正常通知应照发');
  });

  t('notify.dedupeStillWorksAfterRedact', () => {
    const tag = 'x1-dedupe2-' + Date.now();
    main.showOsNotification({ body: '邮箱 alice@example.com', tag });
    const r2 = main.showOsNotification({ body: '邮箱 bob@example.com', tag });
    assert.ok(r2 && r2.deduped === true, '同 tag 第二条应被去重');
  });

  /* ═══════ B. export:session（profile='standard'）═══════ */

  await tAsync('export.standardRedactsAndSaves', async () => {
    const p = tmpFile('api');
    const r = await invoke('export:session', {
      format: 'md',
      content: '联系 alice@example.com，密钥 ' + SK + '，password=hunter2secret',
      targetPath: p,
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.redacted, 3, 'email+api_key+cred_kv 共 3 处，实际 ' + r.redacted);
    assert.ok(fs.existsSync(p), '导出文件须真实存在: ' + p);
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(!text.includes('alice@example.com'), '导出内容不得残留邮箱');
    assert.ok(!text.includes('sk-abcdef'), '导出内容不得残留 sk- 密钥');
    assert.ok(!text.includes('hunter2secret'), '导出内容不得残留 cred_kv 值');
    assert.ok(text.includes('[REDACTED:api_key]'), '需含 [REDACTED:api_key] 占位');
    fs.unlinkSync(p);
  });

  await tAsync('export.objectContentViaRedactValue', async () => {
    const p = tmpFile('obj');
    const r = await invoke('export:session', {
      format: 'json',
      content: { user: 'alice@example.com', note: '密钥 ' + SK },
      targetPath: p,
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.redacted, 2, '结构化对象两处命中，实际 ' + r.redacted);
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(!text.includes('alice@example.com') && !text.includes('sk-abcdef'), '对象路径不得残留原文');
    assert.ok(text.includes('[REDACTED:email]'), '对象字符串字段需被替换');
    fs.unlinkSync(p);
  });

  await tAsync('export.cleanContentCountZero', async () => {
    const p = tmpFile('clean');
    const r = await invoke('export:session', { format: 'md', content: '# 纯净会话\n普通文本', targetPath: p });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.redacted, 0);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), '# 纯净会话\n普通文本', '无命中时内容原样');
    fs.unlinkSync(p);
  });

  await tAsync('export.dialogBranchStillWorks', async () => {
    dialogCalls.length = 0;
    const r = await invoke('export:session', { format: 'md', content: '普通内容' });
    assert.strictEqual(r.canceled, true, '无 targetPath 应走对话框分支（mock 返回取消）');
    assert.strictEqual(dialogCalls.length, 1, 'showSaveDialog 应被调用一次');
  });

  await tAsync('export.emptyContentRejected', async () => {
    const r = await invoke('export:session', { format: 'md', content: '   ' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /导出内容为空/);
  });

  /* ═══════ C. crash-log（profile='standard'）═══════ */

  t('crash.redactCrashEntryMessageStack', () => {
    const out = main.redactCrashEntry({
      type: 'render-crash',
      message: 'fetch failed: token=abcdef123456 secret-value',
      stack: 'Error: key ' + SK + '\n    at foo.js:1:1',
      exitCode: 1,
    });
    assert.ok(!out.message.includes('abcdef123456'), 'message 中 cred_kv 值需替换');
    assert.ok(out.message.includes('[REDACTED:cred_kv]'));
    assert.ok(!out.stack.includes('sk-abcdef'), 'stack 中密钥需替换');
    assert.ok(out.stack.includes('[REDACTED:api_key]'));
    assert.strictEqual(out.type, 'render-crash', '非字符串字段原样保留');
    assert.strictEqual(out.exitCode, 1);
  });

  t('crash.appendCrashLogWritesRedacted', () => {
    main.appendCrashLog({ type: 'render-crash', reason: 'test-x1', message: 'key ' + SK, at: 1 });
    const file = path.join(mockPaths.userData, 'crash-log.jsonl');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('sk-abcdef'), '落盘 jsonl 不得残留密钥');
    assert.ok(raw.includes('[REDACTED:api_key]'), '落盘 jsonl 需含占位符');
  });

  /* ═══════ D. lessons:summary / lessons:tail ═══════ */

  t('lessons.emptyStoreReturnsEmpty', () => {
    mockPaths.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'x1-empty-')); // 切到全新空目录
    const r = invoke('lessons:summary');
    assert.deepStrictEqual(r, { ok: false, reason: 'empty' }, '空库须返回 {ok:false,reason:empty}，实际 ' + JSON.stringify(r));
  });

  t('lessons.tailEmptyStoreReturnsEmpty', () => {
    const r = invoke('lessons:tail');
    assert.deepStrictEqual(r, { ok: false, reason: 'empty' });
  });

  t('lessons.summaryStatsOnRealFile', () => {
    mockPaths.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'x1-ls-'));
    fs.mkdirSync(path.join(mockPaths.userData, 'runtime'), { recursive: true });
    const lines = [
      JSON.stringify({ kind: 'outcome', taskId: 't1', outcome: 'success', verified: true, ts: 1000, tags: ['build'] }),
      JSON.stringify({ kind: 'outcome', taskId: 't2', outcome: 'failed', verified: true, ts: 2000, tags: ['build'] }),
      JSON.stringify({ kind: 'lesson', taskId: 't3', summary: '经验', ts: 3000, tags: ['retry'] }),
      'corrupted-line-not-json',
    ].join('\n');
    fs.writeFileSync(path.join(mockPaths.userData, 'runtime', 'lessons.jsonl'), lines, 'utf8');
    const r = invoke('lessons:summary');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.corrupted, 1);
    assert.strictEqual(r.byOutcome.success, 1);
    assert.strictEqual(r.byOutcome.failed, 1);
    assert.strictEqual(r.firstTs, 1000);
    assert.strictEqual(r.lastTs, 3000);
  });

  t('lessons.tailReturnsNewestFiveDesc', () => {
    // 追加 8 条，tail 应返回 ts 最大的 5 条且降序
    const dir = path.join(mockPaths.userData, 'runtime');
    const lines = [];
    for (let i = 1; i <= 8; i++) {
      lines.push(JSON.stringify({ kind: 'lesson', taskId: 'k' + i, summary: 's' + i, ts: i * 100, tags: [] }));
    }
    fs.writeFileSync(path.join(dir, 'lessons.jsonl'), lines.join('\n'), 'utf8');
    const r = invoke('lessons:tail');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.entries.length, 5, 'tail 固定最近 5 条');
    const tss = r.entries.map((e) => Number(e.ts));
    assert.deepStrictEqual(tss, [800, 700, 600, 500, 400], '按 ts 降序取最新');
  });

  t('lessons.handlersRegistered', () => {
    assert.ok(electronMock.ipcMain._handlers.has('lessons:summary'), 'lessons:summary 已注册');
    assert.ok(electronMock.ipcMain._handlers.has('lessons:tail'), 'lessons:tail 已注册');
    assert.ok(electronMock.ipcMain._handlers.has('notify:show'));
    assert.ok(electronMock.ipcMain._handlers.has('export:session'));
  });

  console.log('\n结果: ' + pass + ' 通过 / ' + failCount + ' 失败');
  process.exit(failCount > 0 ? 1 : 0);
})().catch((e) => { console.error('[x1-check] 运行中断:', e); process.exit(1); });
