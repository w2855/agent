/* G3 渲染检查：会话内查找（Ctrl+F + Custom Highlight）/ 选区浮动菜单 / profileId 接线 / 掩码 key 不回写。
   经 main.js 的 --script=tools/g3-probe.js 通道在渲染进程执行，返回值以 [script] JSON 输出。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail) }); return ok; };
  const bootProfileIds = { active: state.activeProfileId, form: state.formProfileId };
  state.probeBusy = true; // 挡住启动期静默探活，避免干扰后续掩码路径断言

  try {
    /* ───────── ① 会话内查找 ───────── */
    const s = active();
    s.messages = [{
      role: 'user',
      text: '萤火虫为什么会发光？',
    }, {
      role: 'assistant',
      summary: { label: '已完成', tools: 0, messages: 1 },
      tools: [], files: [], approval: null,
      body: '萤火虫通过荧光素发光。\n\n- 萤火虫的发光是冷光\n- 每只萤火虫的节奏不同',
      startedAt: Date.now(), finishedAt: Date.now(),
      metrics: '0.1 秒 · 40 字 · 0 次工具',
    }];
    renderChat();
    check('find.renderTwoMessages', $$('#chat .msg').length === 2, $$('#chat .msg').length);

    // 模拟 Ctrl+F（真事件走 document keydown 分支）
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(30);
    check('find.barVisibleOnCtrlF', $('#findBar') && !$('#findBar').hidden);
    check('find.inputFocused', document.activeElement === $('#findInput'));

    $('#findInput').value = '萤火虫';
    $('#findInput').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(260); // 输入去抖 120ms + 余量
    const hits = findState.hits;
    const byMsg = {};
    for (const h of hits) byMsg[h.msgId] = (byMsg[h.msgId] || 0) + 1;
    const segDump = [...($$('#chat .msg')[1] ? $$('.prose', $$('#chat .msg')[1]) : [])].map((el) => el.textContent.slice(0, 24)).join('|');
    check('find.hitCount', hits.length === 4, JSON.stringify(byMsg) + ' SEG=' + segDump);
    check('find.highlightRegistered', !!CSS.highlights?.get('find-highlight'), CSS.highlights?.get('find-highlight')?.size);
    check('find.activeRegistered', !!CSS.highlights?.get('find-highlight-active'));
    check('find.countText', $('#findCount').textContent === '1/4', $('#findCount').textContent);
    check('find.hitIdsStable', hits.every((h) => h.msgId && Number.isInteger(h.nth)), hits.map((h) => `${h.msgId}#${h.nth}`).join(','));

    // Enter 下一个 / Shift+Enter 上一个
    $('#findInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    check('find.enterNext', $('#findCount').textContent === '2/4', $('#findCount').textContent);
    $('#findInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    check('find.enterNext2', $('#findCount').textContent === '3/4', $('#findCount').textContent);
    $('#findInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    $('#findInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    check('find.enterWraps', $('#findCount').textContent === '1/4', $('#findCount').textContent);
    $('#findInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    check('find.shiftEnterPrev', $('#findCount').textContent === '4/4', $('#findCount').textContent);

    // 换词无命中 → 0/0
    $('#findInput').value = '不存在的词';
    $('#findInput').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(260);
    check('find.noHitZeroOverZero', $('#findCount').textContent === '0/0', $('#findCount').textContent);
    check('find.noHitNoHighlight', !CSS.highlights?.get('find-highlight'));

    // Esc 关闭并清高亮（出场动画 130ms，等它播完再断言 hidden）
    $('#findInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(220);
    check('find.escCloses', $('#findBar').hidden);
    check('find.escClearsHighlight', !CSS.highlights?.get('find-highlight') && !CSS.highlights?.get('find-highlight-active'));

    /* ───────── ② 选区浮动操作菜单 ───────── */
    const bubble = $('#chat .msg.user .bubble');
    const range = document.createRange();
    range.selectNodeContents(bubble);
    // 真实选区路径：selectionchange（节流 150ms）→ 菜单自动出现
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    await sleep(300);
    const menu = $('#selectionMenu');
    check('sel.realSelectionShows', !menu.hidden, menu.style.left + ',' + menu.style.top);
    const left = parseFloat(menu.style.left) || 0;
    const top = parseFloat(menu.style.top) || 0;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    check('sel.inViewport', left >= 12 && top >= 12
      && left + w <= window.innerWidth - 12 + 0.5
      && top + h <= window.innerHeight - 12 + 0.5,
    `l=${left.toFixed(1)} t=${top.toFixed(1)} w=${w} h=${h} vw=${window.innerWidth} vh=${window.innerHeight}`);
    const selRect = range.getBoundingClientRect();
    check('sel.aboveSelection', top + h <= selRect.top + 9, `menuBottom=${(top + h).toFixed(1)} selTop=${selRect.top.toFixed(1)}`);
    // 选区消失 → 菜单隐藏
    getSelection().removeAllRanges();
    await sleep(300);
    check('sel.collapsesHides', menu.hidden);

    // 直接调用显示函数：位置断言 + 复制（stub clipboard）+ 追问预填
    showSelectionMenu(range, '这是被选中的测试文本，用于断言复制与追问。');
    check('sel.directShow', !menu.hidden);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t) => { navigator.__copied = t; } },
      configurable: true,
    });
    const copyBtn = $('[data-sel-copy]', menu);
    copyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(60);
    check('sel.copyWritesClipboard', navigator.__copied === '这是被选中的测试文本，用于断言复制与追问。', navigator.__copied);
    check('sel.copyCheckmark', copyBtn.classList.contains('is-copied'));
    const askBtn = $('[data-sel-ask]', menu);
    askBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(220); // animateOut 130ms 播完
    check('sel.askPrefills', $('#input').value.startsWith('关于「'), $('#input').value);
    check('sel.askFocusesInput', document.activeElement === $('#input'));
    check('sel.askNotSent', $('#input').value.endsWith('，') && !state.busy, $('#input').value);
    check('sel.askHidesMenu', menu.hidden);
    $('#input').value = '';

    /* ───────── ③ apiCfg 携带 profileId ───────── */
    state.formProfileId = 'api-probe-form';
    state.activeProfileId = 'api-probe-active';
    const cfg = apiCfg();
    check('cfg.profileIdPresent', typeof cfg.profileId === 'string' && !!cfg.profileId, cfg.profileId);
    check('cfg.profileIdIsFormFirst', cfg.profileId === 'api-probe-form', cfg.profileId);
    check('cfg.keyUntouched', 'key' in cfg, typeof cfg.key);
    state.formProfileId = '';
    const cfgNoProfile = apiCfg();
    check('cfg.profileIdFallsBackToActive', cfgNoProfile.profileId === 'api-probe-active', cfgNoProfile.profileId);

    /* ───────── ④ 掩码 key 不回写 ───────── */
    check('mask.detect', isMaskedKey('sk-****ef56') && !isMaskedKey('sk-real-key-123456'));

    // contextBridge 暴露的 window.dsh 及其子对象均为只读/瞬时包装，无法 stub IPC；
    // 脱敏逻辑已提为纯函数 profilesForLocalStorage，直接断言它 + 落盘结果。

    // ④a saveProfiles：localStorage（full 模式）不得落掩码；发 setProfiles 的载荷保持掩码供主进程还原
    state.vaultOk = false;
    state.profiles = [{ id: 'p-m', name: 'M', baseUrl: 'https://m.example/v1', key: 'sk-****abcd', model: 'gemini-3.8-flash', hasKey: true }];
    state.activeProfileId = 'p-m';
    state.formProfileId = 'p-m';
    const localView = profilesForLocalStorage('p-m');
    check('mask.localViewDropsMask', localView.profiles[0].key === '' && localView.active === 'p-m', localView.profiles[0].key);
    saveProfiles();
    await sleep(30);
    const storedApis = JSON.parse(localStorage.getItem('dsh.apis') || '{}');
    check('mask.localStorageSanitized', !JSON.stringify(storedApis).includes('sk-****')
      && (storedApis.profiles?.[0]?.key === '' || storedApis.profiles?.[0]?.key === undefined), JSON.stringify(storedApis).slice(0, 120));
    // saveProfiles 原样发送 state.profiles 给 setProfiles：内存值即载荷
    check('mask.setProfilesPayloadKeepsMask', state.profiles[0]?.key === 'sk-****abcd', state.profiles[0]?.key);

    // ④b hydrate：掩码不得降级覆盖本地明文；hasKey=false 不清掉本地 key
    // （真实 getProfiles：掩码来自主进程掩码视图，行为与 stub 等价）
    state.profiles = [
      { id: 'p-a', name: 'A', baseUrl: 'https://a.example/v1', key: 'sk-real-key-A-0001', model: 'gemini-3.8-flash' },
      { id: 'p-b', name: 'B', baseUrl: 'https://b.example/v1', key: 'sk-****bbbb', model: 'gemini-3.8-flash' },
    ];
    state.activeProfileId = 'p-a';
    state.formProfileId = 'p-a';
    await hydrateProfilesFromVault();
    const pa = state.profiles.find((p) => p.id === 'p-a');
    const pb = state.profiles.find((p) => p.id === 'p-b');
    check('mask.hydrateKeepsPlaintext', pa.key === 'sk-real-key-A-0001', pa.key);
    check('mask.hydrateHasFalseKeepsLocal', pb.key === 'sk-****bbbb', pb.key);
    check('mask.hydrateVaultOk', state.vaultOk === true);

    // ④c saveConnection：表单里是掩码时，不把掩码写进 profile 存储 / dsh.conn
    $('#apiBaseUrl').value = 'https://probe.example/v1';
    $('#apiKey').value = 'sk-****abcd';
    $('#apiProfileName').value = '探针连接';
    state.profiles = [{ id: 'p-c', name: 'C', baseUrl: 'https://probe.example/v1', key: 'sk-****abcd', model: 'gemini-3.8-flash', hasKey: true }];
    state.activeProfileId = 'p-c';
    state.formProfileId = 'p-c';
    state.connection = { source: 'model', api: { baseUrl: 'https://probe.example/v1', key: 'sk-****abcd', model: 'gemini-3.8-flash' }, verified: false };
    saveConnection();
    await sleep(30);
    const apisAfterSave = JSON.parse(localStorage.getItem('dsh.apis') || '{}');
    const connAfterSave = JSON.parse(localStorage.getItem('dsh.conn') || '{}');
    check('mask.saveNoMaskInApis', !JSON.stringify(apisAfterSave).includes('sk-****'), JSON.stringify(apisAfterSave).slice(0, 160));
    check('mask.saveNoMaskInConn', !JSON.stringify(connAfterSave).includes('sk-****'), JSON.stringify(connAfterSave).slice(0, 160));
    check('mask.saveKeepsProfileKeyForRestore', state.profiles.find((p) => p.id === 'p-c').key === 'sk-****abcd', state.profiles.find((p) => p.id === 'p-c').key);
    check('mask.saveConnApiEmpty', state.connection.api.key === '', state.connection.api.key);

    // ④d 空明文 + profileId 时对话校验放行（主进程按 profileId 注入）
    check('mask.validateAllowsVaultKey', validateApiInput({ baseUrl: 'https://x.example/v1', key: '', model: 'gemini-3.8-flash', profileId: 'p-c' }, { allowVaultKey: true }) === null);
    check('mask.validateStillRequiresKey', validateApiInput({ baseUrl: 'https://x.example/v1', key: '', model: 'gemini-3.8-flash' }) === '请填写 API Key');

    /* ───────── 恢复现场 ───────── */
    state.probeBusy = false;
    state.activeProfileId = bootProfileIds.active;
    state.formProfileId = bootProfileIds.form;
  } catch (err) {
    state.probeBusy = false;
    results.push({ name: 'probe.exception', ok: false, detail: err?.stack || String(err) });
  }

  return {
    task: 'g3-probe',
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
})();
