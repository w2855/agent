/* 真实 API 中断回归：覆盖空输入停止、带文字插话、二次中断、旧事件不污染新回合 */
(async () => {
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [] };
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '').slice(0, 200) });
  const summaries = () => [...document.querySelectorAll('.summary')].map((n) => n.textContent.replace(/\s+/g, ' ').trim());
  const waitIdle = async (limit = 20000) => {
    const t0 = Date.now();
    while (state.busy && Date.now() - t0 < limit) await sleep(100);
    return !state.busy;
  };
  const startLong = async () => {
    await waitIdle();
    newChat();
    const ta = q('#input');
    ta.value = '请写一篇 1500 字的长文章，分多段逐步输出，不要省略';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q('#sendBtn').click();
  };

  await sleep(900); // 等静默探活结束

  /* 1. 空输入点停止：必须立即恢复 */
  await startLong();
  await sleep(1200);
  add('长请求已进入生成态', state.busy === true && !!state.activeTurnId, `busy=${state.busy} turn=${state.activeTurnId}`);
  q('#sendBtn').click();
  await sleep(350);
  add('点停止后 350ms 内解除 busy', state.busy === false && state.activeTurnId === null, `busy=${state.busy} turn=${state.activeTurnId}`);
  add('停止后显示「已中断」', summaries().at(-1)?.includes('已中断'), summaries().at(-1));
  add('停止后按钮恢复发送态', !q('#sendBtn').classList.contains('streaming'), q('#sendBtn').className);

  /* 2. 带文字插话：旧回合立即结束，新回合能发起 */
  await startLong();
  await sleep(1200);
  const ta = q('#input');
  ta.value = '改成只写三段';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  q('#sendBtn').click();
  await sleep(400);
  add('插话不卡死：pendingTurn 已被消费', state.pendingTurn === null, `pendingTurn=${state.pendingTurn}`);
  add('插话后旧回合标记为已中断', summaries().some((s) => s.includes('已中断')), summaries().slice(-2).join(' | '));
  add('插话后新回合已发起', state.busy === true && !!state.activeTurnId, `busy=${state.busy} turn=${state.activeTurnId}`);

  /* 3. 新回合可再次中断，不残留状态 */
  q('#sendBtn').click();
  await sleep(350);
  add('新回合可二次中断', state.busy === false && state.activeTurnId === null && state.pendingTurn === null,
    `busy=${state.busy} turn=${state.activeTurnId} pendingTurn=${state.pendingTurn}`);
  await sleep(1800);
  add('迟到的旧流事件未污染状态', state.busy === false && !state.activeTurnId, `busy=${state.busy} turn=${state.activeTurnId}`);

  /* 4. 排队模式不会被误当成中断 */
  await startLong();
  await sleep(1000);
  q('#modeBtn').click();
  q('#modeMenu [data-mode="queue"]')?.click();
  ta.value = '排队的一条';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  q('#sendBtn').click();
  await sleep(250);
  add('排队模式只入队不打断当前回合', state.busy === true && state.pending !== null && !q('#queue').hidden,
    `busy=${state.busy} pending=${state.pending}`);
  q('#queueCancel').click();
  q('#sendBtn').click();
  await sleep(350);
  add('排队取消后仍可正常中断', state.busy === false, `busy=${state.busy}`);

  out.total = out.checks.length;
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.total - out.passed;
  return out;
})();
