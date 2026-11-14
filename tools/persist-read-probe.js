'use strict';

/* 持久化铁证·阶段 2（读取实例）：新实例启动 → 主动清掉 localStorage → 会话必须仍在。
 * 运行：npx electron . --user-data-dir=<与写入相同的共享目录> --shot --script=tools/persist-read-probe.js
 * 环境变量 DSH_PERSIST_MARK 传入写入阶段的时间戳标记。
 * localStorage 清空后还能读到 = 数据来自文件真值源（origin 无关）——
 * 等价于「打包版 origin 与开发版不同，但 userData 相同，历史不丢」。 */
(async () => {
  const PREFIX = '持久化铁证-';
  const findMark = (arr) => (JSON.stringify(arr || '').match(new RegExp(PREFIX + '\\d+')) || [''])[0];
  // 会话恢复（app.js 431-440）是同步顶层逻辑，但键按连接来源分存（SESSIONS_KEY）：
  // 打印 source 与实际键名，定位「读实例为何没恢复铁证会话」；同时给 5s 窗口防延后初始化。
  let waitInfo = '';
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      if (JSON.stringify(state.sessions || []).includes(PREFIX)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    waitInfo = `waited=${Date.now() - t0}ms source=${state.connection && state.connection.source} key=${(typeof SESSIONS_KEY === 'function' ? SESSIONS_KEY(state.connection && state.connection.source) : '?')}`;
  }
  /* 绕开 loadSavedSessions 的 catch，逐环节定位恢复失败点 */
  const diag = {};
  diag.snapKeys = Object.keys((window.dsh && window.dsh.storage && window.dsh.storage.snapshot) || {}).sort().join(',');
  diag.snapModelLen = (((window.dsh && window.dsh.storage && window.dsh.storage.snapshot) || {})['dsh.sessions.model'] || '').length;
  diag.legacyModelLen = (() => { try { return (localStorage.getItem('dsh.sessions.model') || '').length; } catch { return -1; } })();
  diag.mirrorModelLen = (FILE_STORE.get('dsh.sessions.model') || '').length;
  try {
    const raw = readStorage(SESSIONS_KEY(state.connection.source), null);
    diag.rawType = typeof raw;
    diag.rawLen = raw ? raw.length : 0;
    const data = raw ? JSON.parse(raw) : null;
    diag.sessionsShape = data && Array.isArray(data.sessions) ? ('array:' + data.sessions.length) : String(data && typeof data.sessions);
    diag.activeId = data && data.activeId;
    if (data && Array.isArray(data.sessions)) {
      try { for (const s of data.sessions) for (const m of s.messages) registerMsg(m); diag.registerMsgOk = true; }
      catch (e2) { diag.registerMsgErr = String((e2 && e2.message) || e2); }
    }
  } catch (e1) { diag.parseErr = String((e1 && e1.message) || e1); }
  const MARK = findMark(state.sessions && state.sessions[0] && state.sessions[0].messages);
  const before = {
    waitInfo,
    localStorageSessions: (() => { try { return localStorage.getItem('dsh.sessions.model'); } catch { return null; } })(),
    mirrorHasSession: FILE_STORE.has('dsh.sessions.model'),
    sessionCount: Array.isArray(state.sessions) ? state.sessions.length : -1,
    markFound: !!MARK,
    messageBodies: (state.sessions[0] && state.sessions[0].messages || []).map((m) => (m.body || '').slice(0, 24)),
  };

  // 关键一步：清空 localStorage（等价换 origin / 全新构建的空 localStorage）
  try { localStorage.clear(); } catch { /* 忽略 */ }
  const afterClear = {
    localStorageNow: (() => { try { return localStorage.getItem('dsh.sessions.model'); } catch { return undefined; } })(),
    mirrorStillHas: FILE_STORE.has('dsh.sessions.model'),
    readBackStillHas: readStorage('dsh.sessions.model', '') !== '',
    markStillFound: readStorage('dsh.sessions.model', '').includes(MARK) && !!MARK,
  };

  return { task: 'persist-read', mark: MARK, diag, restoreDiag: window.__restoreDiag || null, before, afterClear };
})();
