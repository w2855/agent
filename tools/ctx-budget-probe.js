'use strict';

/* 「消息条数过多（82 > 80）」回归探针 + 上下文窗口上限验证。
 *
 * 背景：主进程 validateChatArgs 里有一条 `msgs.length > 80` 的硬限制。
 * 多步工具回合里一条工具结果就是一条消息，长会话很容易越过 80，
 * 于是整轮直接失败、界面只显示「本轮请求未完成 / 消息条数过多」。
 * 现在该限制只作为异常输入保护（2000 条），真正的上下文控制交给字符预算。
 *
 * 断言：
 *   ① 82 条以上消息的请求不再被拒，回合正常拿到正文；
 *   ② 上下文窗口可设 1 万（小窗口省钱）与 100 万（1M 窗口模型），超上限回落默认；
 *   ③ 1 万窗口下 buildApiMessages 真的把历史裁到预算内；
 *   ④ 压缩摘要按窗口收紧，不会自己撑爆预算。
 * 运行：node tools/with-mock.js --shot --user-data-dir=<隔离目录> --script=tools/ctx-budget-probe.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 160) });

  state.probeBusy = true;
  state.connection = { source: 'model', api: { baseUrl: 'http://127.0.0.1:57321/v1', key: 'test-key', model: 'mock-tool-model' }, verified: false };
  state.sessions = [{ id: 'cb-' + Date.now(), title: 'cb', group: '今天', state: 'idle', messages: [] }];
  state.activeId = state.sessions[0].id;
  saveSessions();
  renderSessions();
  renderChat();
  try { await loadTools(); } catch { /* ignore */ }

  /* ② 窗口范围 */
  writeStorage('dsh.ctxLimit', '10000');
  check('ctx10k', readCtxLimit() === 10000, `readCtxLimit=${readCtxLimit()}`);
  writeStorage('dsh.ctxLimit', '1000000');
  check('ctx1m', readCtxLimit() === 1000000, `readCtxLimit=${readCtxLimit()}`);
  writeStorage('dsh.ctxLimit', '2000000'); // 超上限 → 回落默认，而不是硬 clamp 到上限
  check('ctxOverMaxFallsBack', readCtxLimit() === CTX_LIMIT_DEFAULT, `readCtxLimit=${readCtxLimit()}`);

  /* ③ 1 万窗口裁剪 */
  writeStorage('dsh.ctxLimit', '10000');
  LIMITS.maxContextChars = 10000;
  const tmp = active();
  tmp.messages = [];
  for (let i = 0; i < 30; i++) {
    tmp.messages.push({ role: 'user', id: 'u' + i, text: '问题' + i + '：' + 'x'.repeat(600) });
    tmp.messages.push({ role: 'assistant', id: 'a' + i, body: '回答' + i + '：' + 'y'.repeat(600) });
  }
  const trimmed = buildApiMessages(tmp, '继续', null, null);
  const hist = trimmed.filter((m) => m.role !== 'system');
  hist.pop(); // 最后一条是本次输入，不占历史预算
  const used = hist.reduce((n, m) => n + String(m.content || '').length, 0);
  check('budgetTrimsHistory', used <= 10000 && hist.length < 60,
    `historyChars=${used} historyMsgs=${hist.length}（全量 60 条）`);

  /* ④ 摘要按窗口收紧 */
  state.compacted.set(tmp.id, 'z'.repeat(50000));
  const sum = buildApiMessages(tmp, '继续', null, null).find((m) => /压缩摘要/.test(String(m.content || '')));
  check('summaryClampedToBudget', !!sum && String(sum.content).length <= 10000 * 0.5 + 80,
    `summaryLen=${String(sum?.content || '').length}`);
  state.compacted.delete(tmp.id);

  /* ① 82+ 条消息的正常回合 */
  LIMITS.maxContextChars = 120000;
  writeStorage('dsh.ctxLimit', '120000');
  newChat();
  const s = active();
  s.messages = [];
  for (let i = 0; i < 45; i++) {
    s.messages.push({ role: 'user', id: 'hu' + i, text: '历史问题 ' + i });
    s.messages.push({
      role: 'assistant', id: 'ha' + i, body: '历史回答 ' + i, tools: [], tasks: [], files: [],
      summary: { label: '已完成', tools: 0, messages: 1 },
      startedAt: Date.now() - 60000, finishedAt: Date.now() - 59000,
    });
  }
  renderChat();
  const built = buildApiMessages(active(), '[[think]] 继续', null, null);
  check('requestOver82Messages', built.length >= 82, `apiMessages=${built.length}`);

  runTurn('[[think]] 继续');
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    if (!sessionBusy(state.activeId) && Date.now() - t0 > 1500) break;
    await sleep(150);
  }
  await sleep(300);
  const m = active().messages.filter((x) => x.role === 'assistant').at(-1);
  const body = String(m?.body || '');
  check('noMessageCapError', !/消息条数过多/.test(body), body.slice(0, 100));
  check('turnSucceeded', !m?.error && /这是正文回答/.test(body), `error=${m?.error || '-'} body=${body.slice(0, 60)}`);

  return { task: 'ctx-budget-probe', passed: results.filter((r) => r.ok).length, total: results.length, results };
})();
