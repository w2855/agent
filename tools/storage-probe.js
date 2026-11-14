/* 文件存储检查（HANDOFF 四.1 深层根因）：localStorage 按 origin 键控 → 真值源移到
   userData/dsh-storage.json。本探针经 --script 通道在渲染进程执行，断言：
   ① preload sendSync 快照可用（不挂死、类型正确）② 合并策略（文件优先 / 只存 legacy 的迁移集合）
   ③ write→read 同步语义不变 ④ localStorage 镜像双写 ⑤ 会话落盘进入文件真值源
   ⑥ 清掉 localStorage 后仍可从内存镜像读到（等价于换 origin 后历史仍在）
   ⑦ remove 语义 ⑧ flush 后无待写。返回值以 [script] JSON 输出。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail) }); return ok; };

  try {
    const bridge = window.dsh && window.dsh.storage;

    /* ① 桥接与快照 */
    check('bridge.exposed', !!bridge);
    check('bridge.snapshotIsObject', bridge && bridge.snapshot && typeof bridge.snapshot === 'object' && !Array.isArray(bridge.snapshot), JSON.stringify(bridge && bridge.snapshot).slice(0, 80));
    check('store.available', FILE_STORE.available === true, JSON.stringify(FILE_STORE.info()));

    const st0 = await FILE_STORE.stats();
    check('store.statsHasPath', !!st0 && /dsh-storage\.json$/.test(st0.path || ''), st0 && st0.path);

    /* ② 合并策略纯函数 */
    const m = mergeStorageSource(new Map([['dsh.a', '1'], ['dsh.b', 'old']]), { 'dsh.b': 'new', 'dsh.c': '3' });
    check('merge.fileWins', m.merged.get('dsh.b') === 'new', m.merged.get('dsh.b'));
    check('merge.keepsLegacyOnly', m.merged.get('dsh.a') === '1', m.merged.get('dsh.a'));
    check('merge.migrateSetOnlyLegacy', JSON.stringify(Object.keys(m.onlyLegacy)) === JSON.stringify(['dsh.a']), JSON.stringify(m.onlyLegacy));
    check('merge.ignoresNonString', (() => { const r = mergeStorageSource(new Map(), { 'dsh.x': 1 }); return r.merged.size === 0; })());

    /* ③ 写读同步语义 */
    const KEY = 'dsh.storageProbe';
    check('write.returnsTrue', writeStorage(KEY, 'v1') === true);
    check('read.sameTurn', readStorage(KEY, '') === 'v1', readStorage(KEY, ''));
    check('read.jsonRoundtrip', (() => { writeStorage(KEY, JSON.stringify({ n: 42 })); return readJson(KEY, null)?.n === 42; })());

    /* ④ localStorage 镜像（兼容既有探针 / 旧路径） */
    let mirror = null;
    try { mirror = localStorage.getItem(KEY); } catch { /* 无 */ }
    check('mirror.localStorage', mirror === JSON.stringify({ n: 42 }), String(mirror).slice(0, 40));

    /* ⑤ 会话落盘：写进文件真值源，而非只在 localStorage */
    const src = sourceOf();
    const key = SESSIONS_KEY(src);
    const probeSession = { id: 'm-probe-storage', title: '存储探针会话', group: '今天', state: 'idle', filter: [], messages: [{ role: 'user', text: '存储探针内容-A1' }] };
    const backupSessions = state.sessions;
    const backupActive = state.activeId;
    state.sessions = [probeSession, ...backupSessions];
    state.activeId = probeSession.id;
    saveSessions();
    const raw = FILE_STORE.get(key) || '';
    check('session.inFileMirror', raw.includes('存储探针内容-A1'), raw.length);
    check('session.activeIdSaved', raw.includes('m-probe-storage'));

    /* ⑥ 换 origin 等价性：清掉 localStorage 仍可读（真值源在文件/内存镜像） */
    try { localStorage.removeItem(key); } catch { /* 忽略 */ }
    check('session.survivesLocalClear', (readStorage(key, '') || '').includes('存储探针内容-A1'));

    /* ⑦ flush → 无待写、无错误 */
    try { await window.dsh.storage.flush(); } catch { /* 忽略 */ }
    await sleep(260); // 去抖余量
    const st1 = await FILE_STORE.stats();
    check('flush.noPending', st1 && st1.pending === false, JSON.stringify({ pending: st1 && st1.pending }));
    check('flush.noError', st1 && !st1.lastError, st1 && st1.lastError);
    check('flush.wroteKeys', st1 && st1.keys > 0, st1 && st1.keys);

    /* ⑧ remove 语义：删后回退 fallback，且 localStorage 同步清掉 */
    FILE_STORE.remove(KEY);
    check('remove.fallback', readStorage(KEY, 'gone') === 'gone', readStorage(KEY, 'gone'));
    let afterRemove = 'x';
    try { afterRemove = localStorage.getItem(KEY); } catch { /* 无 */ }
    check('remove.localStorageCleared', afterRemove === null, String(afterRemove));

    /* 现场恢复：探针会话不入库（避免污染真实历史） */
    state.sessions = backupSessions;
    state.activeId = backupActive;
    saveSessions();
    await window.dsh.storage.flush().catch(() => {});
  } catch (err) {
    results.push({ name: 'probe.exception', ok: false, detail: (err && err.stack) || String(err) });
  }

  return {
    task: 'storage-probe',
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
})();
