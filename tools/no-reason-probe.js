/* 思考链兼容性回归：不支持 / 未开启 / 未返回 / 空 / 异常形态。
   断言：请求与响应处理正常完成、回合不挂起、不生成虚构思考链、
        无思考链时不谎称「只返回了思考过程」，且已支持思考链的网关行为不变。
   经 main.js 的 --script 通道在渲染进程执行，返回值以 [script] JSON 输出。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [] };
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
  const MOCK = 'http://127.0.0.1:57321/v1';
  const vis = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
      && r.width > 0 && r.height > 0 && cs.maxHeight !== '0px';
  };
  const setConn = (model, effort) => {
    state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model, effort }, verified: false };
    for (const sel of ['#apiEffort', '#composerEffort']) {
      const el = $(sel);
      if (el) el.value = ['off', 'low', 'medium', 'high'].includes(effort) ? effort : 'off';
    }
  };
  if (sourceOf() !== 'model') switchSource('model');
  newChat();
  await sleep(200);
  try { await loadTools(); } catch { /* 本探针不依赖工具执行结果 */ }
  setConn('mock-tool-model', 'off');

  const lastAssistant = () => active().messages.filter((m) => m.role === 'assistant').at(-1);
  const waitIdle = async (ms = 30000) => {
    const t = Date.now();
    while (state.busy && Date.now() - t < ms) await sleep(120);
    await sleep(260);
  };
  const snap = () => {
    const m = lastAssistant() || {};
    const node = document.querySelector('.msg.assistant:last-child');
    const proses = node ? [...node.querySelectorAll('.prose')] : [];
    return {
      body: String(m.body || ''),
      reasoning: String(m.reasoning || ''),
      hasThink: !!(node && node.querySelector('.think-block')),
      thinkBody: node?.querySelector('.think-body')?.textContent || '',
      prose: proses.map((p) => p.textContent).join(' | '),
      proseVisible: proses.some(vis),
      summary: node?.querySelector('.summary')?.textContent || '',
    };
  };
  const run = async (text) => { runTurn(text); await waitIdle(); return snap(); };
  const noError = (s) => !/调用失败|请求参数有误|API 调用失败/.test(s.summary + s.body);

  /* ① 网关完全不返回思考字段 */
  let a = await run('[[nothink]] 普通问题');
  add('① 无思考字段：正文正常返回', a.body.includes('这是没有思考链的正常回答。') && a.proseVisible,
    a.body.slice(0, 90).replace(/\n/g, ' | '));
  add('① 无思考字段：不生成思考区/虚构思考链', !a.hasThink && a.reasoning === '' && a.thinkBody === '',
    `think=${a.hasThink} reasoning=${a.reasoning.length}`);
  add('① 无思考字段：不报错且回合终止', noError(a) && !state.busy && !state.activeTurnId,
    `busy=${state.busy} summary=${a.summary}`);

  /* ② 思考字段为空 / null / 异常对象 / content 数组里的畸形 thinking */
  a = await run('[[emptythink]] 空思考');
  add('② 空/异常思考字段：正文仍完整', a.body.includes('这是空思考链下的正常回答。') && a.body.includes('追加正文'),
    a.body.slice(0, 120).replace(/\n/g, ' | '));
  add('② 空/异常思考字段：不把对象当思考链', !a.body.includes('[object Object]') && !a.hasThink && a.reasoning === '',
    `think=${a.hasThink} reasoning=${a.reasoning.length} bodyHasObj=${a.body.includes('[object Object]')}`);
  add('② 空/异常思考字段：不报错且回合终止', noError(a) && !state.busy, `busy=${state.busy}`);

  /* ③ 完全无正文、也无思考链：兜底文案必须中性，不能虚构「只返回了思考过程」 */
  a = await run('[[noanswer]] 空响应');
  add('③ 无正文无思考：仍有可见最终文字', a.body.trim().length > 0 && a.proseVisible, a.body.slice(0, 110).replace(/\n/g, ' | '));
  add('③ 无正文无思考：不谎称只返回思考过程', !a.body.includes('只返回了思考过程') && !a.body.includes('根据思考过程整理的答复'),
    a.body.slice(0, 140).replace(/\n/g, ' | '));
  add('③ 无正文无思考：不引导调思考强度、不虚构思考区',
    !a.body.includes('思考强度') && !a.hasThink && a.reasoning === '', `think=${a.hasThink}`);
  add('③ 无正文无思考：流程正常收尾', !state.busy && !state.activeTurnId, `busy=${state.busy}`);

  /* ④ 未开启 / 配置脏值：请求里不该出现 reasoning_effort */
  a = await run('[[effortok]] 未开启');
  add('④ 思考强度 off：不带参数、正常回答', a.body.includes('未收到思考强度参数') && !state.busy,
    a.body.slice(0, 80).replace(/\n/g, ' | '));
  setConn('mock-tool-model', 'ultra');
  a = await run('[[effortok]] 脏值');
  add('④ 思考强度为缺失/非法值：不带参数、不报错', a.body.includes('未收到思考强度参数') && noError(a) && !state.busy,
    a.body.slice(0, 80).replace(/\n/g, ' | '));

  /* ⑤ 网关不支持 reasoning_effort：400 后自动去掉参数重试，流程不阻塞 */
  setConn('effort-reject-model', 'high');
  a = await run('[[effort400]] 不支持思考强度');
  add('⑤ 参数 400：自动降级后正常回答', a.body.includes('已去掉思考强度参数，正常回答。'),
    a.body.slice(0, 110).replace(/\n/g, ' | '));
  add('⑤ 参数 400：不把 400 报给用户、回合终止', noError(a) && !state.busy && !state.activeTurnId,
    `busy=${state.busy} summary=${a.summary}`);
  add('⑤ 参数 400：不虚构思考链', !a.hasThink && a.reasoning === '', `think=${a.hasThink}`);

  /* ⑥ 降级按「接入点 + 模型」隔离：换一个模型仍应正常下发思考强度 */
  setConn('effort-ok-model', 'high');
  a = await run('[[effortok]] 另一个模型');
  add('⑥ 降级不污染其它模型（已支持网关行为不变）', a.body.includes('收到思考强度参数') && noError(a) && !state.busy,
    a.body.slice(0, 80).replace(/\n/g, ' | '));

  /* ⑦ 已支持思考链的网关：思考区与正文行为完全不变 */
  setConn('mock-tool-model', 'off');
  a = await run('[[think]] 解释一下');
  add('⑦ 有思考链：思考内容与思考区仍可见', a.hasThink && a.reasoning.length > 0 && a.thinkBody.length > 0,
    `reasoning=${a.reasoning.length} thinkBody=${a.thinkBody.length}`);
  add('⑦ 有思考链：正文仍正常给出', a.body.includes('这是正文回答') && !state.busy,
    a.body.slice(0, 90).replace(/\n/g, ' | '));

  return out;
})();
