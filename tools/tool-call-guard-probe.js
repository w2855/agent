/* 工具调用异常回归：
   ① [[textcall]] 上游把调用写成正文并反复重写 → 必须改成工具卡片、正文不含调用草稿、本轮终止
   ② [[loop]]     上游每轮重复同一批 tool_calls      → 循环熔断、回合终止、卡片数有界
   ③ [[read]]     正常工具调用                        → 原有卡片与对话流程不受影响
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

  state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model' }, verified: false };
  if (sourceOf() !== 'model') switchSource('model');
  fillFormFromConn();
  newChat();
  await sleep(200);
  try { await loadTools(); } catch { /* 下面按实际数量断言 */ }
  add('工具定义已下发（守卫仅在工具回合生效）', state.toolSpecs.length > 0, `specs=${state.toolSpecs.length}`);

  const lastAssistant = () => active().messages.filter((m) => m.role === 'assistant').at(-1);
  const lastNode = () => document.querySelector('.msg.assistant:last-child');
  const waitIdle = async (ms = 30000) => {
    const t = Date.now();
    while (state.busy && Date.now() - t < ms) await sleep(120);
    await sleep(260); // 等收尾帧与状态条重画
  };
  const snapshot = () => {
    const m = lastAssistant() || {};
    const node = lastNode();
    const cards = node ? [...node.querySelectorAll('.tool-wrap .tool')] : [];
    const proses = node ? [...node.querySelectorAll('.prose')] : [];
    return {
      body: String(m.body || ''),
      tools: m.tools || [],
      summary: node?.querySelector('.summary')?.textContent || '',
      cardTexts: cards.map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
      cardVisible: cards.length > 0 && cards.every(vis),
      prose: proses.map((p) => p.textContent).join(' | '),
      proseVisible: proses.some(vis),
    };
  };

  /* ① 工具调用被写成纯文本 + 反复重写调用计划 */
  runTurn('[[textcall]] 继续审计源码');
  await waitIdle();
  const a = snapshot();
  add('① 正文不再直出 functions.read_file 调用', !/functions\.read_file|<tool_call|"tool_calls"\s*:/i.test(a.body),
    a.body.slice(0, 180).replace(/\n/g, ' | '));
  add('① 调用改成工具卡片（已拦截）', a.tools.some((t) => String(t.id || '').startsWith('textcall-') && t.status === 'error'),
    JSON.stringify(a.tools.map((t) => ({ id: t.id, name: t.name, status: t.status, meta: t.meta }))));
  add('① 卡片在界面上真实渲染且可见', a.cardVisible && a.cardTexts.some((t) => /已拦截|文本形式调用|重复输出/.test(t)),
    JSON.stringify({ vis: a.cardVisible, cards: a.cardTexts.slice(0, 2) }));
  add('① 给出可见的自动停止说明', a.body.includes('已自动停止本轮') && a.proseVisible,
    a.body.slice(0, 120).replace(/\n/g, ' | '));
  add('① 不再重复输出同一句', (a.body.match(/继续审计源码配置与日志/g) || []).length <= 1,
    `count=${(a.body.match(/继续审计源码配置与日志/g) || []).length}`);
  add('① 回合正常终止（未挂起）', !state.busy && !state.activeTurnId,
    `busy=${state.busy} active=${state.activeTurnId}`);
  add('① 不是调用失败', !/调用失败|未返回任何正文/.test(a.summary + a.body), a.summary);

  /* ② 上游每轮重复同一批 tool_calls：必须熔断，不能无限打转 */
  runTurn('[[loop]] 重复调用');
  await waitIdle(40000);
  const b = snapshot();
  add('② 重复工具调用回合正常终止（无死循环）', !state.busy && !state.activeTurnId,
    `busy=${state.busy} active=${state.activeTurnId}`);
  add('② 触发循环熔断并给出可见说明', b.body.includes('工具循环已自动终止'), b.body.slice(-160).replace(/\n/g, ' | '));
  add('② 工具卡片数有界', b.tools.length > 0 && b.tools.length <= 6, `tools=${b.tools.length}`);
  add('② 正文可见', b.proseVisible && b.body.length > 0, `len=${b.body.length}`);

  /* ③ 正常工具调用路径不受影响 */
  runTurn('[[read]] 读文件');
  await waitIdle();
  const c = snapshot();
  add('③ 正常工具调用仍生成卡片', c.tools.length > 0 && !c.tools.some((t) => String(t.id || '').startsWith('textcall-')),
    JSON.stringify(c.tools.map((t) => t.name)));
  add('③ 正常回合未被误拦截', !c.body.includes('已自动停止本轮') && !c.body.includes('工具循环已自动终止'),
    c.body.slice(0, 140).replace(/\n/g, ' | '));
  add('③ 正常回合终止且有正文', !state.busy && c.body.length > 0 && c.proseVisible, `len=${c.body.length}`);

  return out;
})();
