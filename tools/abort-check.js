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
    ta.value = '[[slow]] 请写一篇 1500 字的长文章，分多段逐步输出，不要省略';  // [[slow]] 触发 mock 慢流（60×130ms≈7.8s），否则秒回完成，中断/排队断言全踩竞态
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q('#sendBtn').click();
  };

  /* 环境自备（适配 G5 后探针规范，仿 g5-probe）：隔离 userData 无连接配置，
     不配 mock 连接所有请求都会 ERR_CONNECTION_REFUSED；probeBusy 挡住启动期静默探活。 */
  state.probeBusy = true;
  const MOCK = 'http://127.0.0.1:57321/v1';
  state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model' }, verified: false };

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
  add('插话不卡死：pendingTurn 已被消费', !state.pendingTurns.get(state.activeId), `pendingTurn=${state.pendingTurns.get(state.activeId) || 'null'}`);
  add('插话后旧回合标记为已中断', summaries().some((s) => s.includes('已中断')), summaries().slice(-2).join(' | '));
  // 新回合发起是异步链且 mock 快速回复完成极快；工具回合步骤间 activeTurnId 会被清空，
  // 故用细步长捕捉 busy 出现过 + 等收尾后以 summaries 判定新回合已完成（本会话旧回合已标「已中断」，
  // 唯一的「已完成」必然来自插话新回合）
  const tNew = Date.now();
  let sawBusy = false;
  while (Date.now() - tNew < 4000) { if (state.busy) { sawBusy = true; break; } await sleep(40); }
  const tEnd = Date.now();
  while (state.busy && Date.now() - tEnd < 6000) await sleep(100);
  const newDone = summaries().some((x) => x.includes('已完成'));
  add('插话后新回合已发起', sawBusy && newDone, `sawBusy=${sawBusy} busy=${state.busy} newDone=${newDone}`);

  /* 3. 新回合可再次中断，不残留状态 */
  q('#sendBtn').click();
  await sleep(350);
  add('新回合可二次中断', state.busy === false && state.activeTurnId === null && !state.pendingTurns.get(state.activeId),
    `busy=${state.busy} turn=${state.activeTurnId} pendingTurn=${state.pendingTurns.get(state.activeId) || 'null'}`);
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
  add('排队模式只入队不打断当前回合', state.busy === true && !!state.pendingQueue.get(state.activeId) && !q('#queue').hidden,
    `busy=${state.busy} queue=${state.pendingQueue.get(state.activeId) || 'null'}`);
  q('#queueCancel').click();
  q('#sendBtn').click();
  await sleep(350);
  add('排队取消后仍可正常中断', state.busy === false, `busy=${state.busy}`);

  out.total = out.checks.length;
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.total - out.passed;
  return out;
})();
