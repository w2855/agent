/* 场景探针 arch-page：注入假 project 数据后打开架构页，验证离线渲染路径
   （refreshArchitecture 可在无真实 Runtime 数据时出图——不能则走注入 state.project + openArchPage）。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  state.workspace = state.workspace || 'E:\\dsh-desktop';
  state.project = {
    project: {
      id: 'p-shot-arch', revision: 1, name: '截图验收项目', workspace: 'E:\\dsh-desktop',
      mainAgentId: 'a1', goal: 'shot-suite 注入的目标',
      edges: [{ from: 'n1', to: 'n2', kind: 'calls' }],
      discovery: { techStack: ['Electron', 'Node'], entries: [{ kind: 'dir', name: 'renderer' }] },
    },
    live: {
      mainAgent: { id: 'a1', name: '主控 Agent', version: 1, permissionProfileId: 'full', activeTasks: 1 },
      agents: [{ id: 'a1', name: '主控 Agent', version: 1, role: 'main', status: 'active', activeTasks: 1 }],
      nodes: [
        { id: 'n1', label: '界面层', kind: 'module', layer: 'experience', effectiveStatus: 'in_progress', live: true, planStatus: 'in_progress' },
        { id: 'n2', label: '核心逻辑', kind: 'service', layer: 'domain', effectiveStatus: 'planned' },
        { id: 'n3', label: '存储', kind: 'data', layer: 'data', effectiveStatus: 'done' },
      ],
      milestones: [{ label: '单机核心循环可玩', status: 'in_progress' }],
      tasks: [],
      stats: { nodes: 3, edges: 1, activeNodes: 1, done: 1, blocked: 0, linkedTasks: 0, activeTasks: 1 },
    },
  };
  state.projectWorkspace = state.project.project.workspace;
  const realLoadProject = loadProject;
  loadProject = async function () { return state.project; }; // 探针期间固定假数据，防轮询拉真库
  state.projectOpen = true;
  await openArchPage();
  await sleep(400);
  // 视图守卫：本机常有并行 GUI 操作，偶发点击会把视图切走——截图窗口期内每 300ms 重断言目标视图
  const guard = setInterval(() => {
    if (document.querySelector('#archPage').hidden) { state.projectOpen = true; openArchPage(); }
  }, 300);
  setTimeout(() => clearInterval(guard), 3000);
  const nodes = document.querySelectorAll('#archSvg [data-arch-node]').length;
  return {
    ok: !document.querySelector('#archPage').hidden && nodes > 0,
    note: '架构页离线渲染（假项目注入）',
    pageOpen: !document.querySelector('#archPage').hidden,
    svgNodes: nodes,
  };
})();
