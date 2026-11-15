'use strict';

/* 「边做边同步」探针：验证进展同步由模型正文负责、连续静默才补提醒。
 *
 * 用户需求：执行任务时在关键节点说明「在做什么 / 刚完成什么 / 下一步做什么 / 有无阻塞」，
 * 由 agent 自主判断说不说、说多少，不机械绑定每次工具调用，也不长时间不发言，
 * 步骤之间自动连续、不等确认。
 *
 * 断言：
 *   ① 系统提示含工程化改写后的同步规范（关键节点 / 自主判断 / 不机械绑定 / 精炼不重复 / 自动连续）
 *   ② [[silent6]] 连续 6 步零正文：提醒轨迹 = 0,0,0,1,0,0,1
 *      —— 前 3 步不催、第 4 步才补 1 条、注入后重新计数、每步最多 1 条（不累积）
 *   ③ [[speak3]] 第 4 步模型开口：开口之后不再催，轨迹 = 0,0,0,1,0,0,0
 *   ④ 提醒只进 API 消息流：不落会话历史、不出现在正文里
 *   ⑤ 回合自动连跑、正常收尾，中途没有等用户确认
 *
 * 运行：node tools/with-mock.js --shot --user-data-dir=<隔离目录> --script=tools/sync-narration-probe.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 180) });

  state.probeBusy = true;
  state.connection = { source: 'model', api: { baseUrl: 'http://127.0.0.1:57321/v1', key: 'test-key', model: 'mock-tool-model' }, verified: false };
  state.sessions = [{ id: 'sync-' + Date.now(), title: 'sync', group: '今天', state: 'idle', messages: [] }];
  state.activeId = state.sessions[0].id;
  saveSessions();
  renderSessions();
  renderChat();
  try { await loadTools(); } catch { /* 工具清单读不到时运行断言会直接暴露 */ }

  /* ① 提示词层 */
  const sysText = buildApiMessages(active(), '处理一下这个任务', { body: '', tools: [] })
    .filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
  check('prompt.hasSyncRule', /边做边同步/.test(sysText) && /关键节点/.test(sysText));
  check('prompt.keyMoments', /当前在做什么/.test(sysText) && /刚完成什么/.test(sysText)
    && /下一步准备做什么/.test(sysText) && /阻塞或需确认/.test(sysText));
  check('prompt.agentDecides', /什么时候开口由你自己判断/.test(sysText) && /说多少也由你判断/.test(sysText));
  check('prompt.notMechanical', /不机械绑定每次工具调用/.test(sysText)
    && !/每一步都播报|每次工具调用完成后.*先.*说明/.test(sysText));
  check('prompt.noLongSilence', /不要长时间连续操作都不发言/.test(sysText));
  check('prompt.concise', /精炼、不重复、不闲聊/.test(sysText) && /始终围绕当前任务进展/.test(sysText));
  check('prompt.inBody', /把话放在正文里/.test(sysText) && /不要复述工具输出/.test(sysText));
  check('prompt.autoContinue', /不要中途停下来等用户确认/.test(sysText) && /步骤之间自动连续执行/.test(sysText));
  check('prompt.allowsSilence', /可以不出声/.test(sysText));

  const runTurn = async (text) => {
    newChat();
    const ta = document.querySelector('#input');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#sendBtn').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      if (!sessionBusy(state.activeId) && Date.now() - t0 > 1500) break;
      await sleep(120);
    }
    await sleep(350);
    const s = active();
    const m = [...(s?.messages || [])].reverse().find((x) => x.role === 'assistant');
    return {
      body: String(m?.body || ''),
      tools: m?.tools || [],
      error: m?.error || '',
      messages: s?.messages || [],
      busy: sessionBusy(state.activeId),
    };
  };

  /* ② 连续静默：阈值才补、不累积、重新计数 */
  const silent = await runTurn('[[silent6]] 连续跑几步');
  const silentTrace = (silent.body.match(/trace=([0-9,]+)/) || [])[1] || '';
  check('silent.trace', silentTrace === '0,0,0,1,0,0,1', `trace=${silentTrace}`);
  check('silent.prefixNoNudge', /^0,0,0,/.test(silentTrace), silentTrace);
  check('silent.neverStacks', silentTrace.split(',').every((n) => Number(n) <= 1), silentTrace);
  check('silent.ranAllSteps', /toolmsgs=6\b/.test(silent.body) && silent.tools.length >= 6,
    `body=${silent.body.slice(0, 40)} tools=${silent.tools.length}`);
  check('silent.autoFinished', !silent.busy && !silent.error, `busy=${silent.busy} error=${silent.error}`);

  /* ③ 开口之后：清零并撤提醒，不再继续催 */
  const speak = await runTurn('[[speak3]] 中途说一句');
  const speakTrace = (speak.body.match(/trace=([0-9,]+)/) || [])[1] || '';
  check('speak.trace', speakTrace === '0,0,0,1,0,0,0', `trace=${speakTrace}`);
  check('speak.modelSpoke', /已看到关键结果/.test(speak.body), speak.body.slice(0, 100));
  check('speak.noNudgeAfterSpoken', speakTrace.split(',').slice(4).every((n) => n === '0'), speakTrace);
  check('speak.singleNudge', (speakTrace.match(/1/g) || []).length === 1, speakTrace);

  /* ④ 提醒只进 API 消息流，不落会话历史、不进正文 */
  const all = [...silent.messages, ...speak.messages];
  check('nudge.notInHistory', !all.some((m) => /进展同步提醒/.test(String(m.body || m.content || ''))),
    `msgs=${all.length}`);
  check('nudge.notInBody', !/进展同步提醒/.test(silent.body + speak.body));
  check('nudge.noSystemInSession', !all.some((m) => m.role === 'system'),
    all.map((m) => m.role).join(','));

  /* ⑤ 收尾：正文来自模型，占位不冒充发言 */
  check('body.fromModel', /trace=/.test(silent.body) && /trace=/.test(speak.body));
  check('noFallbackNoise', !/本轮没有取得模型正文/.test(silent.body + speak.body));

  return { task: 'sync-narration-probe', passed: results.filter((r) => r.ok).length, total: results.length, results };
})();
