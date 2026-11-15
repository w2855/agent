'use strict';

/* 工具参数健壮性探针（对应「找文件也有问题」）：
 * 真实网关会给出畸形 arguments，以前一律变成「找文件（无参数）」或「参数错误」，模型拿不到怎么改。
 * 场景（mock 触发词）：
 *   ① [[argsfence]]  arguments 包了 ```json 围栏
 *   ② [[argsdup]]    同一份完整 JSON 被推了两遍（{...}{...}）
 *   ③ [[argsobj]]    arguments 直接给对象而不是字符串
 *   ④ [[argsnone]]   参数能 parse 但缺必填（find_files 缺 pattern）
 *   ⑤ [[argsjunk]]   根本不是 JSON
 * 断言：前三种必须照常执行成功；④⑤ 必须给出「缺哪个字段 / 怎么重发」的可操作报错。
 * 运行：node tools/with-mock.js --shot --user-data-dir=<隔离目录> --script=tools/tool-args-probe.js
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 160) });

  state.probeBusy = true;
  state.connection = { source: 'model', api: { baseUrl: 'http://127.0.0.1:57321/v1', key: 'test-key', model: 'mock-tool-model' }, verified: false };
  state.sessions = [{ id: 'ta-' + Date.now(), title: 'ta', group: '今天', state: 'idle', messages: [] }];
  state.activeId = state.sessions[0].id;
  saveSessions();
  renderSessions();
  renderChat();
  try { await loadTools(); } catch { /* 工具清单读不到时下面断言会直接暴露 */ }

  const runTurn = async (text) => {
    newChat();
    const ta = document.querySelector('#input');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#sendBtn').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (!sessionBusy(state.activeId) && Date.now() - t0 > 1200) break;
      await sleep(120);
    }
    await sleep(300);
    const m = active().messages.filter((x) => x.role === 'assistant').at(-1);
    return { msg: m, tool: (m?.tools || [])[0] || null, body: String(m?.body || '') };
  };

  for (const [trigger, label] of [
    ['[[argsfence]]', 'fence'], ['[[argsdup]]', 'dup'], ['[[argsobj]]', 'obj'],
  ]) {
    const r = await runTurn(`${trigger} 列一下当前目录`);
    const t = r.tool;
    check(`${label}.executed`, !!t && t.status === 'ok' && t.meta !== '参数错误',
      `status=${t?.status} meta=${t?.meta} target=${t?.target}`);
    check(`${label}.hasOutput`, !!t && String(t.result || '').length > 0, `result=${String(t?.result || '').slice(0, 60)}`);
    check(`${label}.noParseErrorBlock`, !/工具参数解析失败/.test(r.body), r.body.slice(0, 80));
  }

  const missing = await runTurn('[[argsnone]] 找一下 uproject 文件');
  check('missing.meta', missing.tool?.meta === '缺少参数', `meta=${missing.tool?.meta}`);
  check('missing.namesField', /pattern/.test(String(missing.tool?.result || '')),
    String(missing.tool?.result || '').slice(0, 100));
  check('missing.asksRetry', /重新调用 find_files/.test(String(missing.tool?.result || '')),
    String(missing.tool?.result || '').slice(0, 100));

  const junk = await runTurn('[[argsjunk]] 列一下当前目录');
  check('junk.meta', junk.tool?.meta === '参数错误', `meta=${junk.tool?.meta}`);
  check('junk.actionable', /必须是合法的 JSON 对象/.test(String(junk.tool?.result || '')),
    String(junk.tool?.result || '').slice(0, 100));

  /* bash 命令搬到 Windows：失败结果里必须带替代做法（否则模型会原样重试） */
  state.permission = 'full';
  const win = await runTurn('[[winbash]] 找一下 uproject 文件');
  check('winbash.failedAsExpected', win.tool?.status === 'error', `status=${win.tool?.status}`);
  check('winbash.hasHint', /\[提示\][\s\S]*find_files/.test(String(win.tool?.result || '')),
    String(win.tool?.result || '').slice(0, 160));

  return { task: 'tool-args-probe', passed: results.filter((r) => r.ok).length, total: results.length, results };
})();
