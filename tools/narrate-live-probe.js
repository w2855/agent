'use strict';

/* 「工具调用中途不说话」实时渲染探针：
 * 场景 = [[narrslow]]（mock）：第一步立即播报+工具 → 落定后 3 秒真间隙 → 第二步播报+工具 → 收尾。
 * 逐帧采样 数据侧(draft.body) 与 DOM侧(节点 .prose 文本 + 叙述行)，断言：
 *   ① 间隙期叙述行显示「模型正在思考下一步…」（旧规则此处空白）
 *   ② 第二步文字到达后 ≤600ms 出现在 DOM（实时性——若断联则要重开才见）
 *   ③ 收尾文字实时出现在 DOM
 *   ④ 工具执行中叙述行显示「正在 …」（模型沉默时也有可见进展）
 *   ⑤ 叙述行只活在 UI：不写进正文
 *   ⑥ 回合结束叙述行清除干净
 *   ⑦ 分段渲染：说明段与工具卡交替，每步说明在卡片之前
 *   ⑧ 分段不串段：每段文本与数据侧完全一致（旧实现第一段会变成全文并重复显示）
 * 运行：npx electron . --user-data-dir=<隔离目录> --shot --script=tools/narrate-live-probe.js
 *       （前置：mock 网关 127.0.0.1:57321 已运行新代码；或 node tools/with-mock.js …自动起停） */
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
  let runningAt = -1;  // 工具执行中「正在 …」出现的时刻
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
      if (runningAt < 0 && /^正在\s*\S/.test(narr.trim())) runningAt = Date.now() - t0;
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

  /* ④-⑦ 收尾态复核：叙述行不该进正文、不该留残影；正文应按工具卡切成多段 */
  const sEnd = active();
  const msgEnd = sEnd ? [...(sEnd.messages || [])].reverse().find((m) => m.role === 'assistant') : null;
  const nodeEnd = msgEnd ? document.querySelector(`[data-msg-id="${CSS.escape(String(msgEnd.id || ''))}"]`) : null;
  const bodyEnd = String(msgEnd?.body || '');
  const segs = nodeEnd ? [...nodeEnd.querySelectorAll('.tools .seg')] : [];
  const segTools = segs.map((x) => x.querySelectorAll('.tool-wrap .tool').length);
  const segText = segs.map((x) => (x.querySelector('.prose')?.textContent || '').replace(/\s+/g, ''));
  await sleep(420); // 300ms 淡出 + 移除
  const residue = document.querySelectorAll('.tool-narrate').length;

  check('runningNarrateShown', runningAt >= 0, `工具执行中「正在 …」出现于 +${runningAt}ms`);
  check('narrateNotInBody', bodyEnd.trim().length > 0 && !/模型正在思考下一步/.test(bodyEnd) && !/^正在\s*\S+…$/m.test(bodyEnd),
    `bodyLen=${bodyEnd.length}`);
  check('narrateCleared', residue === 0, `残留 ${residue} 条`);
  check('segmentsAlternate', segs.length >= 3 && segTools.filter((n) => n > 0).length >= 2,
    `segs=${segs.length} toolsPerSeg=${JSON.stringify(segTools)}`);
  check('segTextBeforeCards', /先看一下/.test(segText[0] || '') && /第二步/.test(segText[1] || ''),
    JSON.stringify(segText.map((t) => t.slice(0, 12))));
  /* 串段回归：旧实现收尾时把整段正文写进「第一个 .prose」，第一段就变成全文，
     与后面几段重复显示；而签名判定又会认为「已最新」不再纠正。
     这里逐段与数据侧分段做全等比对，只查关键词是查不出来的。 */
  const dataSeg = bodySegments(msgEnd).map((sg) => String(sg.text).replace(/\s+/g, ''));
  const sameSeg = dataSeg.length === segText.length && dataSeg.every((t, i) => t === (segText[i] || ''));
  check('segTextMatchesData', sameSeg,
    `data=${JSON.stringify(dataSeg.map((t) => t.length))} dom=${JSON.stringify(segText.map((t) => t.length))}`);
  check('segNoSpill', !/第二步|收尾/.test(segText[0] || '') && !/先看一下|收尾/.test(segText[1] || ''),
    `seg0=${(segText[0] || '').slice(0, 16)} / seg1=${(segText[1] || '').slice(0, 16)}`);

  return { task: 'narrate-live-probe', passed: results.filter((r) => r.ok).length, total: results.length, results, timeline: timeline.filter((_, i) => i % 3 === 0) };
})();
