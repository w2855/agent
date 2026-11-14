'use strict';

/* 「工具调用中途不说话」实时渲染探针：
 * 场景 = [[narrslow]]（mock）：第一步立即播报+工具 → 落定后 3 秒真间隙 → 第二步播报+工具 → 收尾。
 * 逐帧采样 数据侧(draft.body) 与 DOM侧(节点 .prose 文本 + 叙述行)，断言：
 *   ① 间隙期叙述行显示「模型正在思考下一步…」（旧规则此处空白）
 *   ② 第二步文字到达后 ≤600ms 出现在 DOM（实时性——若断联则要重开才见）
 *   ③ 收尾文字实时出现在 DOM
 * 运行：npx electron . --user-data-dir=<隔离目录> --shot --script=tools/narrate-live-probe.js
 *       （前置：mock 网关 127.0.0.1:57321 已运行新代码） */
(async () => {
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  state.probeBusy = true;
  state.connection = { source: 'model', api: { baseUrl: 'http://127.0.0.1:57321/v1', key: 'test-key', model: 'mock-tool-model' }, verified: false };
  state.sessions = [{ id: 'nlp-' + Date.now(), title: 'nlp', group: '今天', state: 'idle', messages: [] }];
  state.activeId = state.sessions[0].id;
  saveSessions();
  renderSessions();
  renderChat();

  newChat();
  const ta = q('#input');
  ta.value = '[[narrslow]] 请逐步检查';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  q('#sendBtn').click();

  const timeline = [];
  const t0 = Date.now();
  let step2At = -1;   // 数据侧第二步文字首次出现的时刻
  let step2DomAt = -1; // DOM 侧第二步文字首次出现的时刻
  let gapShownAt = -1; // 间隙叙述行出现的时刻
  let tailAt = -1;     // 收尾文字数据侧出现
  let tailDomAt = -1;  // 收尾文字 DOM 侧出现

  while (Date.now() - t0 < 25000) {
    const s = active();
    const draft = s && [...(s.messages || [])].reverse().find((m) => m.role === 'assistant');
    if (draft) {
      const body = String(draft.body || '');
      const node = document.querySelector(`[data-msg-id="${CSS.escape(String(draft.id || ''))}"]`);
      const proseEls = node ? $$('.prose', node) : [];
      const domText = proseEls.map((el) => el.textContent).join('');
      const narrEl = node ? $('.tool-narrate:not(.is-leaving)', node) : null;
      const narr = narrEl ? narrEl.textContent : '';
      if (step2At < 0 && (body.includes('第二步') || body.includes('再读一下文件内容'))) step2At = Date.now() - t0;
      if (step2At >= 0 && step2DomAt < 0 && (domText.includes('第二步') || domText.includes('再读一下文件内容'))) step2DomAt = Date.now() - t0;
      if (gapShownAt < 0 && narr.includes('模型正在思考下一步')) gapShownAt = Date.now() - t0;
      if (tailAt < 0 && body.includes('收尾：')) tailAt = Date.now() - t0;
      if (tailAt >= 0 && tailDomAt < 0 && domText.includes('收尾：')) tailDomAt = Date.now() - t0;
      timeline.push({ t: Date.now() - t0, bodyLen: body.length, domLen: domText.length, narr: narr.slice(0, 14), busy: sessionBusy(state.activeId) });
    }
    if (!sessionBusy(state.activeId) && Date.now() - t0 > 2000) break;
    await sleep(200);
  }

  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 130) });
  check('gapNarrateShown', gapShownAt >= 0, `间隙叙述行出现于 +${gapShownAt}ms（旧规则此处空白）`);
  check('step2ReachedModel', step2At >= 0, `第二步文字数据侧 +${step2At}ms`);
  check('step2LiveInDom', step2At >= 0 && step2DomAt >= 0 && step2DomAt - step2At <= 600,
    `DOM +${step2DomAt}ms（滞后 ${step2DomAt - step2At}ms，断联则要重开才见）`);
  check('tailLiveInDom', tailAt >= 0 && tailDomAt >= 0 && tailDomAt - tailAt <= 600,
    `收尾 DOM +${tailDomAt}ms（滞后 ${tailDomAt - tailAt}ms）`);

  return { task: 'narrate-live-probe', passed: results.filter((r) => r.ok).length, total: results.length, results, timeline: timeline.filter((_, i) => i % 3 === 0) };
})();
