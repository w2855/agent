/* 极端回归：上游补答两轮后仍然「只思考、零正文」。
   验证主进程 finish() 的兜底 chunk 真的变成一屏可见的最终答复，
   而不是空气泡 / 停在思考中 / 报错收场。需要 mock-gateway（57321）。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [] };
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
  const MOCK = 'http://127.0.0.1:57321/v1';

  state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model' }, verified: false };
  if (sourceOf() !== 'model') switchSource('model');
  fillFormFromConn();
  newChat();
  await sleep(250);

  runTurn('[[noreply]] 请给出结论');
  const t0 = Date.now();
  while (state.busy && Date.now() - t0 < 45000) await sleep(120);
  await sleep(350);

  const a = active().messages.filter((m) => m.role === 'assistant').at(-1);
  const body = String(a?.body || '');
  const node = document.querySelector(`.msg.assistant[data-msg-id="${a?.id || ''}"]`);
  const proses = node ? [...node.querySelectorAll('.prose')] : [];
  const prose = proses[proses.length - 1];
  const cs = prose ? getComputedStyle(prose) : null;
  const rect = prose ? prose.getBoundingClientRect() : null;
  const visible = !!(cs && Number(cs.opacity) > 0 && rect.height > 0 && cs.maxHeight !== '0px');
  const summary = node?.querySelector('.summary')?.textContent || '';

  add('零正文回合仍有最终答复', /根据思考过程整理的答复/.test(body), body.slice(0, 80));
  add('兜底答复从思考里提炼出结论', /缓存命中率等于命中 token/.test(body), body.slice(0, 140));
  add('最终答复肉眼可见（非空气泡）', visible && (prose?.textContent || '').includes('根据思考过程'),
    JSON.stringify({ opacity: cs?.opacity, maxHeight: cs?.maxHeight, h: rect ? Math.round(rect.height) : 0, text: (prose?.textContent || '').slice(0, 40) }));
  add('不是调用失败收场', !/调用失败|API 调用失败/.test(summary), summary);
  add('回合已结束（不再停在思考中）', !state.busy && !/思考中/.test(summary), `busy=${state.busy} summary=${summary}`);
  add('输入框仍可继续提问', !!$('#input') && !$('#input').disabled && $('.composer-area')?.getBoundingClientRect().height > 0, 'ok');

  out.total = out.checks.length;
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.total - out.passed;
  return out;
})();
