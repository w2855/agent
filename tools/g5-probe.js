/* G5 渲染检查：会话级并行——A 会话跑任务时，新建/切换 B 会话照常聊天，互不干扰。
   核心断言：busy 守卫改为会话级、后台 draft.body 持续增长、切回后流式节点 reattach、
   派生 state.busy 跟随活跃会话、switchSource 仍被拒、同一会话双发被拒。
   经 main.js 的 --script 通道在渲染进程执行，返回值以 [script] JSON 输出。
   另含 --shot 截图分镜（dsh.g5stage=shot1/shot2）：第 2/3 次运行分别截
   「A 运行中切到 B 聊天」与「运行中会话列表展开」画面。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitUntil = async (fn, ms = 12000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try { if (fn()) return true; } catch { /* 轮询期可能尚未就绪 */ }
      await sleep(80);
    }
    return false;
  };
  // 直接发起回合并等到 busy（不等待结束）；target 可指明非活跃会话
  const waitTurn = async (text, target = null) => {
    runTurn(text, target);
    await waitUntil(() => sessionBusy((target || active()).id), 4000);
  };
  // 发起回合并等到该会话空闲
  const waitIdle = async (text, target = null, ms = 40000) => {
    await waitTurn(text, target);
    return waitUntil(() => !sessionBusy((target || active()).id), ms);
  };
  const stage = readStorage('dsh.g5stage', 'assert');

  /* ───────── 截图分镜模式：只造画面不跑断言（A 慢流期间快速返回，截图定格运行中） ───────── */
  if (stage === 'shot1' || stage === 'shot2') {
    state.probeBusy = true;
    const MOCK = 'http://127.0.0.1:57321/v1';
    state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model' }, verified: false };
    setPermission('full');
    // 全新会话面，避免上一轮遗留的 running 状态污染画面
    state.sessions = [{ id: 'g5a-' + Date.now(), title: '重排版任务', group: '今天', state: 'idle', messages: [] }];
    state.activeId = state.sessions[0].id;
    saveSessions();
    renderSessions();
    renderChat();
    const sA = active();
    await waitTurn('[[slow]] 请后台慢慢重排版这份文档', sA); // ≈7.8s 慢流，截图窗口内不会结束
    newChat();
    const sB = active();
    await waitIdle('[[write]] 顺手把摘要写进文件', sB, 15000); // B 快速完成一轮，画面里有正常对话
    if (stage === 'shot2') {
      renderRunningMenu();
      openMenu('runningMenu', $('#runningPill'));
      await sleep(150);
    }
    writeStorage('dsh.g5stage', stage === 'shot1' ? 'shot2' : 'assert');
    return {
      stage,
      running: runningSessions().map((s) => s.title),
      pillHidden: $('#runningPill').hidden,
      menuOpen: stage === 'shot2' ? !$('#runningMenu').hidden : undefined,
      bAnswered: String(sB.messages.at(-1)?.body || '').includes('已收到工具结果'),
    };
  }

  /* ───────── 断言主模式 ───────── */
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 140) }); return ok; };

  state.probeBusy = true; // 挡住启动期静默探活
  const MOCK = 'http://127.0.0.1:57321/v1';
  try {
    /* ── 0. 环境就绪：工具定义 + mock 网关 ── */
    await waitUntil(() => state.toolsReady, 6000);
    check('env.toolsReady', state.toolsReady, `specs=${state.toolSpecs.length}`);
    state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model' }, verified: false };
    check('env.mockConn', state.connection.api.baseUrl === MOCK, state.connection.api.baseUrl);
    setPermission('full');
    // 全新会话面（隔离 user-data 里可能有上轮遗留的 running 状态）
    state.sessions = [{ id: 'g5a-' + Date.now(), title: 'G5 主会话', group: '今天', state: 'idle', messages: [] }];
    state.activeId = state.sessions[0].id;
    saveSessions();
    renderSessions();
    renderChat();

    /* ── 1. A 会话发起慢流长回合 ── */
    const sA = active();
    await waitTurn('[[slow]] 请后台慢慢重排版这份文档', sA);
    check('a.turnStarted', sessionBusy(sA.id) && sA.state === 'running', `state=${sA.state}`);
    check('a.derivedBusyTrue', state.busy === true, `busy=${state.busy}`);

    /* ── 2. A 忙时新建 B：放行（旧行为是拒绝） ── */
    newChat();
    const sB = active();
    check('parallel.newChatAllowed', !!sB && sB.id !== sA.id, `A=${sA.id} B=${sB?.id}`);
    // 派生语义核心证据：A 在后台跑，活跃会话 B 空闲 → state.busy 必须为 false
    check('parallel.busyDerivedFromActive', state.busy === false && sessionBusy(sA.id) === true,
      `busy=${state.busy} aBusy=${sessionBusy(sA.id)}`);

    /* ── 3. B 正常聊天（A 继续后台跑） ── */
    await waitTurn('[[write]] B 会话写入一份摘要', sB);
    check('b.turnStarted', sessionBusy(sB.id) && sB.id === state.activeId, `bBusy=${sessionBusy(sB.id)}`);
    check('b.derivedBusyTrue', state.busy === true, `busy=${state.busy}`);
    const bDone = await waitUntil(() => !sessionBusy(sB.id), 15000);
    const bMsg = sB.messages.at(-1);
    check('b.answered', bDone && String(bMsg?.body || '').includes('已收到工具结果'),
      `body=${String(bMsg?.body || '').slice(0, 60)}`);
    check('b.summaryDone', bMsg?.summary?.label === '已完成', `label=${bMsg?.summary?.label}`);

    /* ── 4. A 的 draft.body 在后台持续增长（B 活跃期间轮询） ── */
    const aDraft = sA.messages.at(-1);
    const len1 = (aDraft?.body || '').length;
    await sleep(650);
    const len2 = (aDraft?.body || '').length;
    await sleep(650);
    const len3 = (aDraft?.body || '').length;
    check('a.backgroundBodyGrows', len1 < len2 && len2 < len3 && len3 > 0, `${len1}→${len2}→${len3}`);
    // 节点不在当前 DOM（B 活跃）时，A 的流式更新只写数据不碰主区
    const aNodeWhileAway = document.querySelector(`[data-msg-id="${aDraft?.id}"]`);
    check('a.noDomWhileAway', !aNodeWhileAway || !aNodeWhileAway.isConnected, aNodeWhileAway ? 'in-dom' : 'detached');

    /* ── 5. B 忙时切回 A：放行（只读旁观 A 的流式画面） ── */
    await waitTurn('[[slow]] B 会话的第二轮慢流', sB);
    selectSession(sA.id);
    check('parallel.selectBackAllowed', state.activeId === sA.id && sessionBusy(sB.id) === true,
      `active=${state.activeId} bBusy=${sessionBusy(sB.id)}`);
    check('parallel.busyFollowsActiveAgain', state.busy === true, `busy=${state.busy}`);

    /* ── 6. reattach：切回后 A 的流式节点恢复更新（paint 与 draft 同步增长） ── */
    await sleep(600);
    const aNode = document.querySelector(`[data-msg-id="${aDraft?.id}"]`);
    const proseLen = () => ($('.prose', aNode)?.textContent || '').length;
    const p1 = aNode && aNode.isConnected ? proseLen() : -1;
    await sleep(700);
    const p2 = aNode && aNode.isConnected ? proseLen() : -1;
    const bodyLen = (aDraft?.body || '').length;
    check('reattach.nodeLive', !!aNode && aNode.isConnected, aNode ? 'ok' : 'node missing');
    check('reattach.streamResumes', p1 >= 0 && p2 > p1, `prose ${p1}→${p2} body=${bodyLen}`);
    check('reattach.paintMatchesDraft', p2 >= 0 && Math.abs(p2 - bodyLen) <= 14, `prose=${p2} body=${bodyLen}`);

    /* ── 7. 运行中轻提示：pill 可见、菜单列出运行中会话 ── */
    check('pill.visible', !$('#runningPill').hidden && /个会话运行中/.test($('#runningPillText').textContent || ''),
      $('#runningPillText')?.textContent);
    renderRunningMenu();
    openMenu('runningMenu', $('#runningPill'));
    await sleep(120);
    const menuItems = $$('#runningMenu [data-goto-session]');
    check('pill.menuListsRunning', menuItems.length === 2, `items=${menuItems.length}`);
    check('pill.menuHasBoth', menuItems.some((el) => el.dataset.gotoSession === sA.id)
      && menuItems.some((el) => el.dataset.gotoSession === sB.id), 'A+B 都在列表里');
    hideMenus();

    /* ── 8. 同一会话双发被拒（保持现状） ── */
    const aCountBefore = sA.messages.length;
    runTurn('同一会话的第二发应被拒', sA);
    await sleep(450);
    check('sameSession.doubleSendRejected', sA.messages.length === aCountBefore && sessionBusy(sA.id),
      `msgs ${aCountBefore}→${sA.messages.length}`);

    /* ── 9. switchSource 仍拒绝（跨来源数据结构不同） ── */
    switchSource('preview');
    check('switchSource.stillBlocked', sourceOf() === 'model', `source=${sourceOf()}`);

    /* ── 10. A 完成后 success 路径正常 ── */
    const aDone = await waitUntil(() => !sessionBusy(sA.id), 20000);
    check('a.finished', aDone && sA.state === 'idle', `state=${sA.state}`);
    check('a.successLabel', aDraft?.summary?.label === '已完成', `label=${aDraft?.summary?.label}`);
    check('a.fullBody', String(aDraft?.body || '').includes('后台分片 60'), `len=${(aDraft?.body || '').length}`);
    // B 的第二轮慢流在后台继续增长（A 活跃期间）
    const bDraft2 = sB.messages.at(-1);
    const bl1 = (bDraft2?.body || '').length;
    await sleep(700);
    const bl2 = (bDraft2?.body || '').length;
    check('b.backgroundBodyGrows', bl1 > 0 && bl2 > bl1, `${bl1}→${bl2}`);
    await waitUntil(() => !sessionBusy(sB.id), 20000);
    check('b.finishedToo', !sessionBusy(sB.id) && sB.state === 'idle', `state=${sB.state}`);
    // 全部收尾后：无运行中会话 → pill 隐藏
    check('pill.hiddenWhenIdle', $('#runningPill').hidden === true, `hidden=${$('#runningPill').hidden}`);

    /* ── 11. 收尾投影：中断续跑按钮来自消息数据（切走再切回不丢） ── */
    newChat();
    const sC = active();
    await waitIdle('[[read]] 验证收尾投影', sC, 15000);
    const cMsg = sC.messages.at(-1);
    if (cMsg) {
      cMsg.aborted = true;
      cMsg.resumeFrom = '验证';
      // renderChat 重建节点走的就是 assistantNode 投影：这里直接验证投影结果
      const rebuilt = assistantNode(cMsg);
      check('projection.resumeRowFromData', !!rebuilt.querySelector('.resume-row'), rebuilt ? 'ok' : 'no resume-row');
    }
  } catch (err) {
    check('probe.noThrow', false, err?.message || String(err));
  }

  // 下次运行进入分镜模式
  writeStorage('dsh.g5stage', 'shot1');
  return { pass: results.filter((r) => r.ok).length, total: results.length, results };
})();
