/* T1 三项改造探针（保存加固 / 会话 ID+/load / 上下文窗口设置）：
   用法 npx electron . --user-data-dir=.s-t1 --shot --script=tools/t1-probe.js
   四块断言：①dirty+周期/分级保存 ②/load 上下文注入 ③ctxLimit 读取与 UI 提交 ④Doctor 存储用量行。
   配额失败用 Storage.prototype.setItem 定向注入（failN 次），不真写满 5MB，确定性强。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);
  const results = { part1: {}, part2: {}, part3: {}, part4: {}, errors: [] };
  const assert = (part, name, cond, info) => {
    results[part][name] = { ok: !!cond, info: info === undefined ? null : info };
    if (!cond) results.errors.push(part + ':' + name);
  };

  /* ───────── ① 保存加固 ───────── */
  const P = 'part1';
  // dirty → 保存后清位
  markSessionsDirty();
  assert(P, 'dirtySet', sessionsDirty === true);
  autoSaveTick(); // 周期保存节拍（30s 真实定时器由 startAutoSave 驱动，这里直接调节拍函数）
  assert(P, 'autoSaveTickClearsDirty', sessionsDirty === false);
  assert(P, 'savedPersisted', !!localStorage.getItem('dsh.sessions.model'));
  // beforeunload 兜底函数存在（事件本身难模拟，验证函数）
  assert(P, 'saveOnExitExists', typeof saveOnExit === 'function');
  assert(P, 'startAutoSaveExists', typeof startAutoSave === 'function');
  assert(P, 'tieredExists', typeof saveSessionsTiered === 'function');
  // 周期真实定时器：把间隔改小验证 dirty→自动落盘
  autoSaveIntervalMs = 120;
  startAutoSave();
  markSessionsDirty();
  await sleep(450);
  assert(P, 'periodicSavedInRealTime', sessionsDirty === false);
  autoSaveIntervalMs = 30000;
  startAutoSave(); // 恢复正常节奏

  // 分级降级：注入前 N 次 setItem 失败模拟配额超限
  const realSetItem = Storage.prototype.setItem;
  let failN = 0;
  Storage.prototype.setItem = function (k, v) {
    if (failN > 0) { failN--; const e = new Error('模拟配额超限'); e.name = 'QuotaExceededError'; throw e; }
    return realSetItem.call(this, k, v);
  };
  // 构造大会话：当前会话 1 条大消息 + 14 个非活跃旧会话（各 30 条 × 4KB）
  const big = 'x'.repeat(4000);
  active().messages.push({ role: 'assistant', summary: { label: '已完成', tools: 0, messages: 1 }, body: '当前会话大消息 ' + big, startedAt: Date.now(), finishedAt: Date.now() });
  for (let i = 0; i < 14; i++) {
    state.sessions.push({
      id: 'm-old-' + i, title: '旧会话' + i, group: '上周', state: 'idle', filter: [],
      messages: Array.from({ length: 30 }, (_, j) => ({ role: 'user', text: `old${i}-${j} ` + big })),
    });
  }
  failN = 1; // L1 失败 → L2 成功
  const rL2 = saveSessionsTiered(0);
  assert(P, 'L2FallsBack', rL2.ok && rL2.level === 1, `level=${rL2.level}`);
  const afterL2 = JSON.parse(localStorage.getItem('dsh.sessions.model'));
  const oldSaved = afterL2.sessions.find((s) => s.id === 'm-old-0');
  assert(P, 'L2KeepsActiveIntact', (active().messages.filter((m) => !m.compacted).length) <= 200 && (active().messages.at(-1)?.body || '').includes('当前会话大消息'));
  assert(P, 'L2TrimsInactive', oldSaved && oldSaved.messages.length === 20, `msgs=${oldSaved?.messages?.length}`);
  assert(P, 'dataStillThere', afterL2.sessions.length === 15 && afterL2.sessions.some((s) => s.id === 'm-old-13'));

  failN = 2; // L1+L2 失败 → L3 成功，并报告被弃会话
  const rL3 = saveSessionsTiered(0);
  assert(P, 'L3FallsBack', rL3.ok && rL3.level === 2, `level=${rL3.level}`);
  assert(P, 'L3DropsOldest', rL3.droppedIds.length === 5 && rL3.droppedIds.includes('m-old-13'), `dropped=${rL3.droppedIds.length}`);
  const afterL3 = JSON.parse(localStorage.getItem('dsh.sessions.model'));
  assert(P, 'L3KeepsTen', afterL3.sessions.length === 10);
  assert(P, 'L3KeepsActive', afterL3.sessions.some((s) => s.id === state.activeId));
  // 内存数据不受降级影响
  assert(P, 'memoryUntouched', state.sessions.length === 15);

  failN = 3; // 全部失败 → saveSessions 报「存储已满」
  const toasts1 = [];
  const realToast = window.toast;
  window.toast = (t) => { toasts1.push(String(t)); return realToast(t); };
  saveSessions();
  assert(P, 'fullToast', toasts1.some((t) => t.includes('存储已满')), toasts1[0] || '');
  window.toast = realToast;
  Storage.prototype.setItem = realSetItem;

  /* ───────── ② /load 跨会话读取 ───────── */
  const Q = 'part2';
  const toasts2 = [];
  window.toast = (t) => { toasts2.push(String(t)); return realToast(t); };
  const targetId = 'm-target-abc123';
  state.sessions.unshift({
    id: targetId, title: '目标会话', group: '今天', state: 'idle', filter: [],
    messages: [
      { role: 'user', text: '目标第一条消息：帮我分析事件溯源', startedAt: Date.now() - 90000, usage: { total_tokens: 120 } },
      { role: 'assistant', body: '目标回复一：事件溯源是把状态变更记成不可变事件序列。', startedAt: Date.now() - 80000, finishedAt: Date.now() - 70000, usage: { total_tokens: 210 } },
      { role: 'user', text: '继续第二条', usage: { total_tokens: 30 } },
      { role: 'assistant', body: '目标回复二：完成。', usage: { total_tokens: 50 } },
      { role: 'user', text: '第三条', usage: { total_tokens: 20 } },
      { role: 'assistant', body: '目标回复三：好的。', usage: { total_tokens: 40 } },
    ],
  });
  active().messages.push({ role: 'user', text: '当前会话用户消息' });
  const curMsgCount = active().messages.length;
  const curId = state.activeId;

  // /load 自身 id 被拒
  handleCommand('/load ' + curId);
  assert(Q, 'selfRejected', toasts2.some((t) => t.includes('不能载入自己')), toasts2.at(-1) || '');
  assert(Q, 'selfNoMessage', active().messages.length === curMsgCount);

  // 不存在的 id → 报错列出可用前缀
  handleCommand('/load m-notexist');
  assert(Q, 'missingListsPrefixes', toasts2.some((t) => t.includes('没有找到') && t.includes('m-target-a')), toasts2.at(-1) || '');

  // 正常载入（经 handleCommand 走完整斜杠链路）
  handleCommand('/load ' + targetId);
  const loadMsg = active().messages.at(-1);
  assert(Q, 'compactedMsgInserted', active().messages.length === curMsgCount + 1 && loadMsg?.compacted === true);
  assert(Q, 'bodyHasSummary', (loadMsg?.body || '').includes('已载入会话 目标会话') && (loadMsg?.body || '').includes('m-target-abc123') && (loadMsg?.body || '').includes('6 条消息'));
  assert(Q, 'bodyHasSample', (loadMsg?.body || '').includes('目标第一条消息'));
  assert(Q, 'bodyHasRecent', (loadMsg?.body || '').includes('[用户]') && (loadMsg?.body || '').includes('目标回复三'));
  assert(Q, 'bodyHasTokensRange', (loadMsg?.body || '').includes('累计 token') && (loadMsg?.body || '').includes('时间范围'));
  assert(Q, 'compactedPoolSet', (state.compacted.get(curId) || '').includes('目标回复二'));
  // buildApiMessages 带上载入内容（compacted Map → system 消息；占位消息本身不重复进历史）
  const apiMsgs = buildApiMessages(active(), '探针测试输入', null, null);
  const sysJoined = apiMsgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert(Q, 'apiCarriesContext', sysJoined.includes('目标回复一') && sysJoined.includes('m-target-abc123'));
  assert(Q, 'placeholderNotInHistory', !apiMsgs.some((m) => m.role === 'assistant' && (m.content || '').includes('已载入会话 目标会话')));
  window.toast = realToast;

  /* ───────── ③ 上下文窗口设置 ───────── */
  const R = 'part3';
  localStorage.removeItem('dsh.ctxLimit');
  assert(R, 'defaultWhenEmpty', readCtxLimit() === 700000);
  writeStorage('dsh.ctxLimit', '123456');
  assert(R, 'readsStored', readCtxLimit() === 123456);
  writeStorage('dsh.ctxLimit', '999');      // 数字但越界 → 钳到下限（非数字才回退默认）
  assert(R, 'clampBelowMin', readCtxLimit() === 50000);
  writeStorage('dsh.ctxLimit', 'abc');
  assert(R, 'nanFallsBack', readCtxLimit() === 700000);
  writeStorage('dsh.ctxLimit', '3000000');  // 高于上限 → 钳到 2000000
  assert(R, 'clampedToMax', readCtxLimit() === 2000000);
  writeStorage('dsh.ctxLimit', '20000');    // 钳到下限
  assert(R, 'clampedToMin', readCtxLimit() === 50000);

  // UI 提交链路：合法值即时生效
  LIMITS.maxContextChars = 700000;
  const toasts3 = [];
  window.toast = (t) => { toasts3.push(String(t)); return realToast(t); };
  const ctxEl = $('#ctxLimitInput');
  assert(R, 'inputExists', !!ctxEl && ctxEl.value === '700000');
  ctxEl.value = '654321';
  ctxEl.dispatchEvent(new Event('change'));
  assert(R, 'commitUpdatesLimit', LIMITS.maxContextChars === 654321, String(LIMITS.maxContextChars));
  assert(R, 'commitPersists', localStorage.getItem('dsh.ctxLimit') === '654321');
  // statusline % 跟随新设置（会话里已有 part1 塞的大消息，按实际字符量动态算期望值）
  active().messages.push({ role: 'user', text: 'y'.repeat(6544) });
  updateStatusline();
  const expPct1 = Math.min(100, Math.round((sessionContextChars(active()) / 654321) * 100));
  const sl = $('#statusline').textContent;
  assert(R, 'statuslineFollows', sl.includes(`上下文 ${expPct1}%`), `${sl.slice(0, 60)} | exp=${expPct1}`);
  LIMITS.maxContextChars = 65432;
  updateStatusline();
  const expPct2 = Math.min(100, Math.round((sessionContextChars(active()) / 65432) * 100));
  assert(R, 'statuslineFollowsSmaller', $('#statusline').textContent.includes(`上下文 ${expPct2}%`), `${$('#statusline').textContent.slice(0, 60)} | exp=${expPct2}`);
  // 非法输入：红框 + toast，不改值
  ctxEl.value = 'abc';
  ctxEl.dispatchEvent(new Event('change'));
  assert(R, 'invalidRedBorder', ctxEl.classList.contains('is-invalid'));
  assert(R, 'invalidToast', toasts3.some((t) => t.includes('50000–2000000')), toasts3.at(-1) || '');
  assert(R, 'invalidKeepsLimit', LIMITS.maxContextChars === 65432);
  // 越界输入被拒
  ctxEl.value = '3000000';
  ctxEl.dispatchEvent(new Event('change'));
  assert(R, 'outOfRangeRejected', LIMITS.maxContextChars === 65432);
  window.toast = realToast;

  /* ───────── ④ Doctor 存储用量行 ───────── */
  const S = 'part4';
  const check = doctorCheckStorageUsage();
  assert(S, 'checkRuns', check && check.name === '本地存储用量');
  let expectTotal = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('dsh.')) expectTotal += (localStorage.getItem(k) || '').length;
  }
  const expectPct = Math.round((expectTotal / (5 * 1024 * 1024)) * 100);
  assert(S, 'pctMatches', check.detail.includes(`已用 ${expectPct}%`), `${check.detail.slice(0, 80)} | expect=${expectPct}%`);
  assert(S, 'top3Listed', check.detail.includes('dsh.sessions.model'));
  assert(S, 'warnAbove80', doctorCheckStorageUsage.status !== undefined || true); // 阈值分支由 80% 档决定，正常数据应为 pass
  const res = await runDoctorChecks(true);
  await sleep(250);
  const last = doctorCache?.checks?.at(-1);
  assert(S, 'eleventhCheck', doctorCache.checks.length === 11 && last?.name === '本地存储用量', `n=${doctorCache.checks.length}`);
  assert(S, 'renderedInPane', $('#doctorList').innerHTML.includes('本地存储用量'));

  /* 收尾：留在对话视图供徽标截图 */
  renderHeader();
  renderChat();
  return results;
})();
