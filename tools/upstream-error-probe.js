/* 上游错误可读性回归：网关「自己没配好」时，提示必须指对方向。
   ① 400 + no_accounts  → 明确「与 key 无关，去网关登录账号」，不误导用户反复改 key
   ② 401               → 提示核对「地址与 key 是否同一网关」
   ③ 无关状态码（500）  → 不得硬塞 401/账号提示（避免误诊）
   ④ 正常回合           → 不出现任何错误块（回归）
   经 main.js 的 --script 通道在渲染进程执行，结果以 [script] JSON 输出；需 mock-gateway（57321）。 */
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

  state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model', effort: 'off' }, verified: false };
  if (sourceOf() !== 'model') switchSource('model');
  newChat();
  await sleep(200);
  try { await loadTools(); } catch { /* 本探针不依赖工具结果 */ }

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
      error: String(m.error || ''),
      prose: proses.map((p) => p.textContent || '').join(' | '),
      proseVisible: proses.some(vis),
      summary: node?.querySelector('.summary')?.textContent || '',
    };
  };
  const run = async (text) => { runTurn(text); await waitIdle(); return snap(); };

  try {
    /* ① 网关自身没账号：HTTP 400，报文 no_accounts */
    let a = await run('[[noaccounts]] 试试');
    add('① 账号缺失：仍有可见最终文字', a.proseVisible && a.body.trim().length > 0,
      a.body.slice(0, 100).replace(/\n/g, ' | '));
    add('① 账号缺失：指明与 key 无关', /这不是 API Key 的问题/.test(a.body), a.body.slice(0, 160).replace(/\n/g, ' | '));
    add('① 账号缺失：给出下一步（登录账号/换接入点）', /登录账号/.test(a.body) || /切换到其他接入点/.test(a.body),
      a.body.slice(0, 200).replace(/\n/g, ' | '));
    add('① 账号缺失：保留上游原始报文', /No accounts configured/.test(a.body), a.body.slice(0, 200).replace(/\n/g, ' | '));
    add('① 账号缺失：原因在最前且不重复状态码', /^\*\*本轮请求未完成\*\*/.test(a.body.trim()) && !/本轮请求未完成（400）/.test(a.body),
      a.body.slice(0, 120).replace(/\n/g, ' | '));
    add('① 账号缺失：回合正常终止', !state.busy && !state.activeTurnId, `busy=${state.busy}`);

    /* ② 真 401：提示核对地址与 key 是否同一网关 */
    a = await run('[[badkey]] 试试');
    add('② 401：正文可见且标记失败', a.proseVisible && !!a.error, `err=${a.error.slice(0, 60)}`);
    add('② 401：保留状态码', /401/.test(a.body), a.body.slice(0, 100).replace(/\n/g, ' | '));
    add('② 401：提示地址与 key 同源', /同一个网关/.test(a.body), a.body.slice(0, 200).replace(/\n/g, ' | '));
    add('② 401：不误报为账号缺失', !/这不是 API Key 的问题/.test(a.body), a.body.slice(0, 160).replace(/\n/g, ' | '));
    add('② 401：回合正常终止', !state.busy && !state.activeTurnId, `busy=${state.busy}`);

    /* ③ 无关状态码不应被贴上 401 / 账号提示 */
    a = await run('[[http403]] 被策略拒绝');
    add('③ 403：不带 401 提示', !/同一个网关/.test(a.body) && !/这不是 API Key 的问题/.test(a.body),
      a.body.slice(0, 180).replace(/\n/g, ' | '));
    add('③ 403：仍报出原始状态码', /403/.test(a.body), a.body.slice(0, 120).replace(/\n/g, ' | '));

    /* ④ 回归：正常回答不出现错误块 */
    a = await run('[[nothink]] 正常问题');
    add('④ 正常回合：无错误块、正文可见', a.proseVisible && !/本轮请求未完成/.test(a.body) && !a.error,
      a.body.slice(0, 90).replace(/\n/g, ' | '));
  } catch (e) {
    add('探针执行', false, String((e && e.stack) || e).slice(0, 300));
  }
  return out;
})();
