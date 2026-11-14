'use strict';

/* 持久化铁证·阶段 1（写入实例）：造会话 → 立即落盘 → flush 等待 → 输出。
 * 运行：npx electron . --user-data-dir=<共享目录> --shot --script=tools/persist-write-probe.js
 * 之后阶段 2 用 persist-read-probe.js 在全新实例（localStorage 必为空）读回验证。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MARK = '持久化铁证-' + Date.now();

  state.probeBusy = true;
  newChat();
  const s = active();
  s.title = '铁证会话';
  s.messages.push({
    id: 'm-persist-1', role: 'user', body: MARK, ts: Date.now(), status: 'done',
  });
  saveSessions(); // 用户真实路径同款：push 后立即落盘

  // 等去抖窗口（200ms）+ flush 落盘，再由主进程 before-quit 兜底
  await sleep(500);
  let flushed = null;
  try { flushed = await window.dsh.storage.flush(); } catch { /* 尽力而为 */ }
  const local = localStorage.getItem('dsh.sessions.model');

  return {
    task: 'persist-write',
    mark: MARK,
    sessions: state.sessions.length,
    flushed: !!flushed && flushed.ok !== false,
    fileStoreAvailable: FILE_STORE.available === true,
    localStorageMirrorBytes: (local || '').length,
    markInMirror: (local || '').includes(MARK),
  };
})();
