'use strict';

/* 架构会话隔离专项探针（用户实测「架构会话还是没有独立的隔离」）：
 *   ① 会话 A 打开架构页 ensure → 项目应带 A 的 sessionId（专属，非共享）
 *   ② 切会话 B ensure → 项目 id ≠ A 的（互不影响）
 *   ③ 切回 A → state.project 回到 A 的项目（缓存不串会话）
 * 运行：npx electron . --user-data-dir=<隔离目录> --shot --script=tools/arch-iso-probe.js */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 120) });

  state.probeBusy = true;
  state.sessions = [
    { id: 'isoA-' + Date.now(), title: '会话A', group: '今天', state: 'idle', messages: [] },
    { id: 'isoB-' + Date.now(), title: '会话B', group: '今天', state: 'idle', messages: [] },
  ];
  state.activeId = state.sessions[0].id;
  saveSessions();
  renderSessions();
  renderChat();

  state.projectOpen = true;
  state.workspace = state.workspace || 'F:\\';

  /* ① 会话 A：loadProject（内部 ensure 带 sessionId） */
  const pa = await loadProject(true);
  const projA = pa && pa.project;
  check('a.ensured', !!projA, projA ? projA.id : 'null');
  check('a.sessionScoped', projA && projA.sessionId === state.sessions[0].id,
    projA ? `sessionId=${projA.sessionId || '(共享!)'}` : '');
  check('a.notShared', projA && !!projA.sessionId, projA ? String(projA.name) : '');

  /* ② 切会话 B：ensure 应给出不同的专属项目 */
  state.activeId = state.sessions[1].id;
  renderSessions();
  const pb = await loadProject(true);
  const projB = pb && pb.project;
  check('b.ensured', !!projB, projB ? projB.id : 'null');
  check('b.sessionScoped', projB && projB.sessionId === state.sessions[1].id,
    projB ? `sessionId=${projB.sessionId || '(共享!)'}` : '');
  check('b.differsFromA', !!projA && !!projB && projA.id !== projB.id,
    projA && projB ? `${projA.id.slice(0, 14)} vs ${projB.id.slice(0, 14)}` : '');

  /* ③ 切回 A：缓存不串，回到 A 的项目 */
  state.activeId = state.sessions[0].id;
  renderSessions();
  const pa2 = await loadProject(true);
  check('a.restored', pa2 && pa2.project && pa2.project.id === projA.id,
    pa2 && pa2.project ? pa2.project.id.slice(0, 14) : 'null');

  return { task: 'arch-iso-probe', passed: results.filter((r) => r.ok).length, total: results.length, results };
})();
