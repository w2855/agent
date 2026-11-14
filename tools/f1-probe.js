/* F1 三 bug 修复探针（崩溃持久化 / 叙述去重 / 壁纸降级）：
   用法 npx electron . --user-data-dir=.s-f1 --shot --script=tools/f1-probe.js
   前置：mock 网关已在 127.0.0.1:57321（tools/mock-gateway.js，含新增 [[narr]] 触发）。
   JSON 返回 { part1, part2, part3, errors }；结尾摆出「叙述行+任务清单」画面供 --shot 目检。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { part1: {}, part2: {}, part3: {}, errors: [] };
  const assert = (part, name, cond, info) => {
    out[part][name] = { ok: !!cond, info: info === undefined ? null : info };
    if (!cond) out.errors.push(part + ':' + name);
  };
  const waitUntil = async (fn, ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try { if (fn()) return true; } catch { /* 节点可能还没挂上 */ }
      await sleep(80);
    }
    return false;
  };
  const readSaved = () => {
    try { return JSON.parse(localStorage.getItem('dsh.sessions.model')); } catch { return null; }
  };

  /* ── 环境准备：指向 mock 网关、临时工作区、完全权限（与 tool-e2e 同口径） ── */
  await waitUntil(() => state.toolsReady, 8000);
  const MOCK = 'http://127.0.0.1:57321/v1';
  const base = await window.dsh.tools.defaultWorkspace();
  const ws = String(base).replace(/[\\/]+$/, '') + '\\dsh-f1-' + Date.now();
  state.workspace = ws;
  writeStorage('dsh.workspace', ws);
  state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model' }, verified: false };
  if (sourceOf() !== 'model') switchSource('model');
  setPermission('full');
  newChat();
  const assistantMsgs = () => active().messages.filter((m) => m.role === 'assistant');
  const lastAssistant = () => assistantMsgs().at(-1);

  /* ── Part1 Bug1：回合发起即落盘（崩溃/重载聊天记录不再丢失） ── */
  // runTurn 同步前奏内完成 push(userMsg)+push(draft)+saveSessions：调用返回后立即可读
  runTurn('[[write]] 立即落盘探针');
  const savedNow = readSaved();
  const savedCur = savedNow?.sessions?.find((s) => s.id === state.activeId);
  const savedTail = savedCur?.messages?.slice(-2) || [];
  assert('part1', 'userMsgPersistedOnSend', savedTail[0]?.role === 'user' && String(savedTail[0]?.text || '').includes('立即落盘探针'),
    savedTail[0] ? `${savedTail[0].role}` : '无消息');
  assert('part1', 'draftPersistedOnSend', savedTail[1]?.role === 'assistant' && savedTail[1]?.summary?.label === '进行中',
    savedTail[1] ? savedTail[1].summary?.label : '无草稿');

  // 首个工具事件后：localStorage 里已能看到工具条目（工具事件立即保存生效）
  const toolSeen = await waitUntil(() => (lastAssistant()?.tools?.length || 0) >= 1, 20000);
  const savedMid = readSaved();
  const savedMidDraft = savedMid?.sessions?.find((s) => s.id === state.activeId)?.messages?.slice(-1)?.[0];
  assert('part1', 'toolEventPersistedImmediately', toolSeen && (savedMidDraft?.tools || []).some((t) => t.name === 'write_file'),
    `tools=${(savedMidDraft?.tools || []).map((t) => t.name).join(',')}`);
  const turnDone = await waitUntil(() => state.busy === false, 40000);
  assert('part1', 'turnFinishesNormal', turnDone && lastAssistant()?.summary?.label === '已完成', lastAssistant()?.summary?.label);
  const savedEnd = readSaved();
  const savedEndDraft = savedEnd?.sessions?.find((s) => s.id === state.activeId)?.messages?.slice(-1)?.[0];
  assert('part1', 'finishPersisted', savedEndDraft?.summary?.label === '已完成', savedEndDraft?.summary?.label);

  /* ── Part2 Bug2：叙述去重（正文不再两遍 + 叙述行让位模型文字） ── */
  newChat();
  const narrDone = await waitUntil(async () => { runTurn('[[narr]] 播报去重探针'); return state.busy === true; }, 3000);
  const okNarr = await waitUntil(() => state.busy === false, 40000);
  const b = String(lastAssistant()?.body || '');
  const cnt = (s) => (b.match(new RegExp(s, 'g')) || []).length;
  assert('part2', 'turnRan', narrDone && okNarr, `busy=${state.busy}`);
  assert('part2', 'step1TextOnce', cnt('先看一下目录结构') === 1, `count=${cnt('先看一下目录结构')} len=${b.length}`);
  assert('part2', 'step2TextOnce', cnt('再读一下文件内容') === 1, `count=${cnt('再读一下文件内容')}`);
  assert('part2', 'finalTextOnce', cnt('已收到工具结果') === 1, `count=${cnt('已收到工具结果')}`);
  assert('part2', 'bodyOrderIntact', b.indexOf('先看一下目录结构') >= 0 && b.indexOf('先看一下目录结构') < b.indexOf('再读一下文件内容'),
    b.slice(0, 120));

  // 叙述行退让：模型已有正文时 UI 不再叠加「正在 …」行（确定性单元断言，脱节点上驱动）
  const host = document.createElement('div');
  host.innerHTML = '<div class="slot-narrate"></div>';
  const fakeMsg = { body: '', tools: [{ id: 't1', verb: '读取', target: 'src/', status: 'running' }] };
  renderNarrate(host, fakeMsg);
  assert('part2', 'narrateShowsWhenSilent', !!host.querySelector('.tool-narrate'), '模型沉默时叙述行兜底仍在');
  fakeMsg.body = '模型已自行说明';
  renderNarrate(host, fakeMsg);
  const leaving = host.querySelector('.tool-narrate');
  assert('part2', 'narrateYieldsToModelText', !!leaving && leaving.classList.contains('is-leaving'), leaving ? '进入退场动画' : '无行');

  /* ── Part3 Bug3：壁纸失效路径不抛错、自动降级纯色 ──
     注：window.dsh 由 contextBridge 暴露，current/pick/clear 只读不可 stub——
     因此直接驱动 applyWallpaper 的失效入参覆盖核心防御；pick 的原生对话框失败分支
     无法在无头环境触发（真实 dialog 不可 mock），由代码审查保证 + 报告说明。 */
  const uncaught = [];
  const onErr = (e) => uncaught.push(String(e?.message || e));
  window.addEventListener('error', onErr);
  const toasts = [];
  const realToast = window.toast;
  window.toast = (t) => { toasts.push(String(t)); return realToast(t); };
  try {
    // a) current 返回失效路径（文件被外部删除）→ 加载失败自动降级 + 可读提示，不抛未捕获错误
    const okB = await applyWallpaper({ file: 'wallpaper.f1-missing.mp4', size: 1234 });
    const degraded = await waitUntil(
      () => /已回到纯色|无法加载/.test(document.querySelector('#wallpaperState')?.textContent || ''), 4000);
    const stateTextB = document.querySelector('#wallpaperState')?.textContent || '';
    assert('part3', 'stalePathDegrades', okB === false && degraded, stateTextB.slice(0, 60));
    assert('part3', 'stalePathReadableToast', toasts.some((t) => t.includes('无法加载') || t.includes('已回到纯色')),
      toasts.join('|').slice(0, 80));
    assert('part3', 'stalePathAttrRemoved', document.documentElement.dataset.wallpaper === undefined,
      String(document.documentElement.dataset.wallpaper));

    // b) 空值路径：applyWallpaper(null) 干净回退（clear 后状态无残留）
    const okC = await applyWallpaper(null);
    assert('part3', 'nullCleanFallback', okC === false && document.documentElement.dataset.wallpaper === undefined
      && /未设置/.test(document.querySelector('#wallpaperState')?.textContent || ''), `ok=${okC}`);
  } catch (err) {
    out.errors.push('part3:exception:' + String(err?.message || err));
  } finally {
    window.toast = realToast;
    window.removeEventListener('error', onErr);
  }
  assert('part3', 'noUncaughtErrors', uncaught.length === 0, uncaught.join('|').slice(0, 120));

  /* ── 清理：临时工作区 + 恢复连接 ── */
  await window.dsh.tools.exec('run_command', { command: `rmdir /s /q "${ws}"`, timeout_ms: 15000 }, { workspace: base, permission: 'full' });
  state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model' }, verified: false };

  /* ── 摆拍：叙述行 + 任务清单常驻画面，供 --shot 目检 ── */
  const stg = active();
  const fakeDraft = {
    role: 'assistant', id: 'f1-stage-' + Date.now(),
    summary: { label: '进行中', tools: 2, messages: 0 },
    body: '', files: [], approval: null, metrics: '',
    tools: [
      { id: 'f1a', name: 'list_dir', verb: '读取', icon: 'i-folder', tone: 'neutral', target: 'renderer/', status: 'ok', meta: '完成', args: {}, result: '3 项', expanded: false },
      { id: 'f1b', name: 'read_file', verb: '读取', icon: 'i-file', tone: 'neutral', target: 'app.js', status: 'running', meta: '执行中', args: {}, result: '', expanded: false },
    ],
    tasks: [
      { content: '崩溃后聊天记录保留', status: 'completed' },
      { content: '叙述文案只出现一次', status: 'in_progress' },
      { content: '壁纸失效自动降级纯色', status: 'pending' },
    ],
    startedAt: Date.now(), finishedAt: 0,
  };
  stg.messages.push(fakeDraft);
  const stageNode = assistantNode(fakeDraft);
  document.querySelector('.chat-inner').appendChild(stageNode);
  scrollToBottom(true);

  out.total = ['part1', 'part2', 'part3'].reduce((n, p) => n + Object.keys(out[p]).length, 0);
  out.passed = ['part1', 'part2', 'part3'].reduce((n, p) => n + Object.values(out[p]).filter((x) => x.ok).length, 0);
  return out;
})();
