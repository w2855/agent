'use strict';

/* 思考强度端到端探针：连接配 effort=high → 发一轮聊天 → mock 网关应收到 reasoning_effort=high
 * （mock-gateway 日志打 effort=high；本探针断言请求侧闭环 + UI select 回填）。
 * 运行：npx electron . --user-data-dir=<隔离目录> --shot --script=tools/effort-probe.js
 *       （前置：mock 网关已在 127.0.0.1:57321） */
(async () => {
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 120) }); };

  state.probeBusy = true;
  const MOCK = 'http://127.0.0.1:57321/v1';
  state.connection = {
    source: 'model',
    api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model', effort: 'high' },
    verified: false,
  };
  state.sessions = [{ id: 'eff-' + Date.now(), title: 'effort', group: '今天', state: 'idle', messages: [] }];
  state.activeId = state.sessions[0].id;
  saveSessions();
  renderSessions();
  renderChat();

  check('conn.effortSet', state.connection.api.effort === 'high', state.connection.api.effort);

  newChat();
  const ta = q('#input');
  ta.value = '你好';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  q('#sendBtn').click();

  // 等回合结束（mock 快速回复）
  const t0 = Date.now();
  while (sessionBusy(state.activeId) && Date.now() - t0 < 15000) await sleep(150);
  const s = active();
  const last = [...(s.messages || [])].reverse().find((m) => m.role === 'assistant');
  check('turnFinished', !sessionBusy(state.activeId), `busy=${sessionBusy(state.activeId)}`);
  check('assistantResponded', !!last && String(last.body || '').length > 0, (last?.body || '').slice(0, 40));

  return { task: 'effort-probe', results, passed: results.filter((r) => r.ok).length, total: results.length };
})();
