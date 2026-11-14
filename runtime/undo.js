'use strict';

/* ─────────────────────────────────────────────
   文件级撤销 runtime 门面

   把 lib/file-snapshots 的仓库绑定到 userData/file-snapshots，并给
   IPC（undo:list / undo:restore）与渲染层提供安全入口：
     - listUndoSnapshots(filePath)：某文件的检查点列表（新→旧）
     - undoFile(filePath, snapshotId)：恢复到指定检查点（带 changed-since
       预检，绝不盲目覆盖）

   main.js 接线建议（本文件不改 main.js，接线属后续任务）：
     const undo = require('./runtime/undo');
     const tools = require('./lib/tools');
     const store = undo.initFileSnapshots(app.getPath('userData'));
     tools.setSnapshotStore(store);                       // write_file 写前/写后快照
     ipcMain.handle('undo:list', (_e, filePath) => undo.listUndoSnapshots(filePath));
     ipcMain.handle('undo:restore', (_e, filePath, snapshotId) => undo.undoFile(filePath, snapshotId));

   本模块自身不读写文件系统之外的任何状态；所有失败都收敛成
   { ok:false } 或空列表，不向 IPC 调用方抛错。
   ───────────────────────────────────────────── */

const path = require('node:path');
const { createSnapshotStore } = require('../lib/file-snapshots');

let store = null;

/**
 * 初始化（幂等）：绑定 userData/file-snapshots 目录，返回共享仓库实例。
 * @param {string} userDataDir app.getPath('userData')
 */
function initFileSnapshots(userDataDir) {
  const dir = path.join(String(userDataDir || ''), 'file-snapshots');
  if (!store || store.dir !== dir) store = createSnapshotStore(dir);
  return store;
}

function getFileSnapshotStore() {
  return store;
}

/** 复位（测试用；生产进程内不需要） */
function resetFileSnapshots() {
  store = null;
}

/** 某文件的检查点列表（新→旧）；未初始化或出错返回空列表 */
async function listUndoSnapshots(filePath) {
  if (!store) return [];
  try { return await store.listSnapshots(filePath); } catch { return []; }
}

/** 恢复到指定检查点；未初始化返回 { ok:false, reason:'no-store' }，不抛错 */
async function undoFile(filePath, snapshotId) {
  if (!store) return { ok: false, reason: 'no-store', error: '撤销存储未初始化' };
  try { return await store.restore(filePath, snapshotId); } catch (err) {
    return { ok: false, reason: 'error', error: err?.message || String(err) };
  }
}

module.exports = {
  initFileSnapshots,
  getFileSnapshotStore,
  listUndoSnapshots,
  undoFile,
  resetFileSnapshots,
};
