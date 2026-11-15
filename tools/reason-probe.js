/* 推理模型回归：思考内容必须可见、空正文必须可解释、收尾最后一帧不能丢。
   ① [[think]]     先 reasoning_content 后正文 → 思考区随流更新、正文出现、思考区自动收起
   ② [[thinkonly]] 只有 reasoning + finish_reason=length → 不再误判为调用失败，气泡有解释
   经 main.js 的 --script 通道在渲染进程执行，返回值以 [script] JSON 输出。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [] };
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
  const MOCK = 'http://127.0.0.1:57321/v1';

  state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model' }, verified: false };
  if (sourceOf() !== 'model') switchSource('model');
  fillFormFromConn();
  newChat();
  await sleep(200);

  const lastAssistant = () => active().messages.filter((m) => m.role === 'assistant').at(-1);
  const dom = (m) => {
    const node = document.querySelector(`.msg.assistant[data-msg-id="${m.id}"]`);
    if (!node) return null;
    const block = node.querySelector('.think-block');
    return {
      prose: [...node.querySelectorAll('.prose')].map((p) => p.textContent).join('|'),
      thinkLen: node.querySelector('.think-len')?.textContent || '',
      thinkOpen: block ? block.open : null,
      thinkBody: node.querySelector('.think-body')?.textContent || '',
      summary: node.querySelector('.summary')?.textContent || '',
    };
  };
  const waitIdle = async (ms = 30000) => {
    const t = Date.now();
    while (state.busy && Date.now() - t < ms) await sleep(120);
  };

  /* ① 推理后正常出正文 */
  runTurn('[[think]] 解释一下');
  await sleep(1100);                       // mock 在 1.5 秒后才给正文，这里落在「只有思考」的窗口
  const midDraft = lastAssistant();
  const midDom = midDraft ? dom(midDraft) : null;
  await waitIdle();
  const a = lastAssistant();
  const na = dom(a);
  add('[[think]] 思考区在正文之前就出现', !!midDom && /字/.test(midDom.thinkLen || ''), `mid=${JSON.stringify(midDom && midDom.thinkLen)}`);
  add('[[think]] 思考期间默认展开（能看见在动）', midDom?.thinkOpen === true, `mid.open=${midDom?.thinkOpen}`);
  add('[[think]] 思考内容被保留', String(a.reasoning || '').length > 0, `reasoning=${String(a.reasoning || '').length}`);
  add('[[think]] 思考区字数随流更新', /38 字/.test(na?.thinkLen || ''), na?.thinkLen);
  add('[[think]] 正文出现', String(a.body || '').includes('这是正文回答'), String(a.body || '').slice(0, 20));
  add('[[think]] 正文开始后思考区自动收起', na?.thinkOpen === false, `final.open=${na?.thinkOpen}`);
  add('[[think]] 收尾 DOM 与数据一致', (na?.prose || '').includes('这是正文回答'), na?.prose);

  /* 缓存命中率：mock 给 prompt=4000 / cached=3000 → 75% */
  add('单条消息显示缓存命中率', /缓存 75%/.test(a.metrics || ''), a.metrics);
  await sleep(260);              // 状态条 150ms 去抖：等它按收尾后的统计数据重画
  updateStatusline();
  const statusText = $('#statusline')?.textContent || '';
  add('状态条显示平均值', /均值 75%/.test(statusText), statusText);
  add('状态条显示上下文用量', /上下文 \d+%（\d+k\/\d+k）/.test(statusText), statusText);

  /* ② 只有推理、正文为空 → 必须自动补答出正文 */
  runTurn('[[thinkonly]] 难题目');
  await waitIdle();
  const b = lastAssistant();
  const nb = dom(b);
  add('[[thinkonly]] 自动补答后真的说话了', String(b.body || '').includes('这是补答的正文回答'), String(b.body || '').slice(0, 26));
  add('[[thinkonly]] 不是空气泡也不是报错', String(b.body || '').trim().length > 0 && !/调用失败|未返回任何正文/.test(nb?.summary || b.body || ''), nb?.summary);
  add('[[thinkonly]] 思考区仍可回看', /字/.test(nb?.thinkLen || '') && String(nb?.thinkBody || '').length > 0,
    `${nb?.thinkLen} · body=${String(nb?.thinkBody || '').length}`);

  return out;
})();
