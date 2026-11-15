'use strict';

/* 「是否开口由 agent 自主判断」探针。
 *
 * 需求变更点：早先实现是「每步工具结果回传后注入一条 system 提醒，强制先说明再调用」，
 * 用户明确要求改成由 agent 自己判断（不是每次工具调用完都要说话）。
 * 本探针验证四件事：
 *   ① 系统提示给的是判断标准（什么时候该说、什么时候可以不说），不再是硬性逐句播报；
 *   ② 工具循环里不再注入「流程提醒」system 消息（nudge=0，顺带省 token）；
 *   ③ 步骤之间不插入等待：同一回合连续跑完两次工具，中途没有用户输入；
 *   ④ 收尾只给一次结果，工具卡片全部落定、回合正常结束。
 *
 * 运行：node tools/with-mock.js --shot --user-data-dir=<隔离目录> --script=tools/autonomy-probe.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 180) });

  state.probeBusy = true;
  state.connection = { source: 'model', api: { baseUrl: 'http://127.0.0.1:57321/v1', key: 'test-key', model: 'mock-tool-model' }, verified: false };
  state.sessions = [{ id: 'auto-' + Date.now(), title: 'auto', group: '今天', state: 'idle', messages: [] }];
  state.activeId = state.sessions[0].id;
  saveSessions();
  renderSessions();
  renderChat();
  try { await loadTools(); } catch { /* 工具清单读不到也不影响提示词断言 */ }

  /* ①② 提示词层：判断标准在、硬性播报要求已撤 */
  const sysText = buildApiMessages(active(), '随便看看', { body: '', tools: [] })
    .filter((m) => m.role === 'system')
    .map((m) => String(m.content || ''))
    .join('\n');
  check('promptHasJudgement', /什么时候开口由你自己判断/.test(sysText),
    sysText.includes('说话节奏') ? '含「说话节奏」段' : '缺少判断标准');
  check('promptAllowsSilence', /可以不出声/.test(sysText));
  check('promptAllowsAutoContinue', /不要中途停下来等用户确认/.test(sysText));
  check('promptNoForcedNarration', !/每次调用工具前先用一句短句说明/.test(sysText) && !/多步工具循环中每一步都先说明/.test(sysText));

  /* ③④ 运行层：两步工具自动连跑 */
  newChat();
  const ta = document.querySelector('#input');
  ta.value = '[[nudgecount]] 连续跑两步看看';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#sendBtn').click();

  const t0 = Date.now();
  let sawTools = 0;
  while (Date.now() - t0 < 30000) {
    const s = active();
    const draft = s && [...(s.messages || [])].reverse().find((m) => m.role === 'assistant');
    if (draft) {
      sawTools = Math.max(sawTools, (draft.tools || []).length);
      const done = (draft.tools || []).length >= 2 && draft.tools.every((t) => t.status === 'ok' || t.status === 'error');
      if (done && !sessionBusy(state.activeId)) break;
    }
    await sleep(150);
  }
  await sleep(400);

  const s = active();
  const msg = s ? [...(s.messages || [])].reverse().find((m) => m.role === 'assistant') : null;
  const body = String(msg?.body || '');
  const tools = msg?.tools || [];

  check('noStepNudge', /nudge=0\b/.test(body), body.slice(0, 120));
  /* 只发起工具调用的步骤不产出正文是正常的；这些中间步曾经各被塞一段
     「本轮没有取得模型正文」兜底，多步下来同一句重复叠加、把结论挤到最下面。 */
  check('noFallbackNoise', !/本轮没有取得模型正文/.test(body), body.slice(0, 120));
  check('bodyIsAnswerOnly', body.trim() === 'nudge=0; toolmsgs=2', JSON.stringify(body.trim()));
  check('autoRanTwoSteps', /toolmsgs=2\b/.test(body) && tools.length >= 2,
    `body="${body.slice(0, 40)}" tools=${tools.length}`);
  check('noMidwayQuestion', !/请确认|是否继续|等你|需要你/.test(body), body.slice(0, 80));
  check('turnEndedWithoutInput', !sessionBusy(state.activeId) && !msg?.error,
    `busy=${sessionBusy(state.activeId)} error=${msg?.error || '-'}`);
  check('singleAssistantMessage', (s?.messages || []).filter((m) => m.role === 'assistant').length === 1,
    `messages=${(s?.messages || []).map((m) => m.role).join(',')}`);
  check('toolsAllSettled', tools.length >= 2 && tools.every((t) => t.status === 'ok'),
    JSON.stringify(tools.map((t) => `${t.verb}:${t.status}`)));

  return { task: 'autonomy-probe', passed: results.filter((r) => r.ok).length, total: results.length, results };
})();
