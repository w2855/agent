/* 动态化探针（架构页实时化 + 任务面板可编辑）：
   用法 npx electron . --user-data-dir=.s-dyn --shot --script=tools/dyn-probe.js
   两阶段复用同一个 .s-dyn（靠 localStorage 的 dsh.dynProbePhase 翻转）：
   第 1 次跑架构页动态断言（结束时留在架构页 → shot.png = 实时徽标截图）；
   第 2 次跑任务面板可编辑断言（结束时停在行内编辑态 → shot.png = 面板编辑态截图），
   跑完两个阶段后由外部 rm -rf .s-dyn 清理。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = { phase: '', checks: {}, errors: [] };
  const assert = (name, cond, info) => {
    results.checks[name] = { ok: !!cond, info: info === undefined ? null : info };
    if (!cond) results.errors.push(name);
  };

  try {
    const MODE = readStorage('dsh.dynProbePhase', '') === 'todo' ? 'todo' : 'arch';
    results.phase = MODE;

    /* ───────────────── 阶段 1：架构页实时动态 ───────────────── */
    if (MODE === 'arch') {
      // 注入假项目（绕开真实 Runtime 的 loadProject），让架构页有 3 个节点可渲染
      state.workspace = state.workspace || 'E:\\dsh-desktop';
      state.project = {
        project: {
          id: 'p-dyn-probe', revision: 3, name: '探针测试项目', workspace: 'E:\\dsh-desktop',
          mainAgentId: 'a1', goal: '探针注入的目标',
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
          milestones: [],
          tasks: [],
          stats: { nodes: 3, edges: 1, activeNodes: 1, done: 1, blocked: 0, linkedTasks: 0, activeTasks: 1 },
        },
      };
      state.projectWorkspace = state.project.project.workspace;
      const realLoadProject = loadProject;
      loadProject = async function () { return state.project; }; // 探针期间固定假数据

      // hook refreshArchitecture 计数（事件驱动路径走它，轮询兜底也走它）
      let refreshCount = 0;
      const realRefresh = refreshArchitecture;
      refreshArchitecture = async function (force) { refreshCount++; return realRefresh(force); };

      state.projectOpen = true;
      await openArchPage();
      await sleep(250);

      assert('arch.pageOpen', !document.querySelector('#archPage').hidden);
      assert('arch.svgRendered', !!document.querySelector('#archSvg'));
      assert('arch.nodeCount', document.querySelectorAll('#archSvg [data-arch-node]').length === 3, 3);
      assert('arch.liveAuraPresent', !!document.querySelector('[data-arch-node="n1"] .arch-live-aura'));
      assert('arch.badgeVisible', !document.querySelector('#archLiveBadge').hidden);

      // 事件驱动即时刷新：runtime 事件 → 断言 ≤500ms 内 refreshArchitecture 被调用
      const t0 = performance.now();
      const before = refreshCount;
      scheduleArchLiveRefresh({ type: 'run.started', runId: 'r-probe' });
      let latency = -1;
      for (let i = 0; i < 40; i++) {
        await sleep(20);
        if (refreshCount > before) { latency = Math.round(performance.now() - t0); break; }
      }
      assert('arch.eventRefreshLatency', latency >= 0 && latency <= 500, latency);
      assert('arch.badgeLiveText', document.querySelector('#archLiveBadge').textContent.includes('实时'));

      // diff 守卫：数据未变的事件刷新不应重建画布（DOM 引用保持）
      const svgBefore = document.querySelector('#archSvg');
      scheduleArchLiveRefresh({ type: 'tool.finished', runId: 'r-probe' });
      await sleep(320);
      const svgAfter = document.querySelector('#archSvg');
      assert('arch.diffGuardKeepsDom', svgBefore === svgAfter);
      assert('arch.refreshHappened', refreshCount > before + 1, refreshCount);

      // 状态变化 → is-flash 一次性闪光 + 光环数量跟随
      state.project.live.nodes[1].effectiveStatus = 'in_progress';
      renderArchPage();
      await sleep(30);
      assert('arch.statusFlash', document.querySelector('[data-arch-node="n2"]').classList.contains('is-flash'));
      assert('arch.auraCount', document.querySelectorAll('#archSvg .arch-live-aura').length === 2, 2);

      // 轮询兜底：静音事件驱动路径（真实 Runtime 偶发事件会翻转徽标，隔离后才能确定性地
      // 验证 3s 轮询真的触发），等待一个轮询周期后断言徽标翻转为「3s」
      const realLiveRefresh = scheduleArchLiveRefresh;
      scheduleArchLiveRefresh = function () {}; // 探针期间静音
      const countBeforePoll = refreshCount;
      await sleep(3500);
      scheduleArchLiveRefresh = realLiveRefresh;
      assert('arch.pollFired', refreshCount > countBeforePoll, refreshCount - countBeforePoll);
      assert('arch.pollFallbackBadge', archState.liveMode === 'poll'
        && document.querySelector('#archLiveBadge').textContent.includes('3s'),
        document.querySelector('#archLiveBadge').textContent.trim());

      // 结尾再触发一次事件驱动刷新，让截图定格在「实时」徽标态
      scheduleArchLiveRefresh({ type: 'task.started', runId: 'r-probe' });
      await sleep(300);
      assert('arch.badgeLiveAgain', document.querySelector('#archLiveBadge').textContent.includes('实时'));

      // 阶段旗标翻转：下一次运行走任务面板阶段
      writeStorage('dsh.dynProbePhase', 'todo');
      // 结束时保持架构页打开 → 截图呈现实时徽标
      return results;
    }

    /* ───────────────── 阶段 2：任务面板随时可改 ───────────────── */
    const s = active();
    if (!s) throw new Error('没有活动会话');
    s.todoTasks = [];
    // 捕获面板被谁关掉：hideMenus / toggleTodoPanel 每次调用记调用栈
    const hideCalls = [];
    const realHide = hideMenus;
    hideMenus = function () { hideCalls.push(new Error().stack.split('\n').slice(2, 5).join(' | ')); return realHide(); };
    const realToggle = toggleTodoPanel;
    toggleTodoPanel = function () { hideCalls.push('toggle(open=' + !document.querySelector('#todoPanel').hidden + ')'); return realToggle(); };
    // Y1 后任务面板默认展开：若已开则先收起再走标准开合流程，保证后续断言前提一致
    if (!document.querySelector('#todoPanel').hidden) toggleTodoPanel();
    // 开合走 animateOut/animateIn：hidden 在动画完成后才翻转，断言前必须等待
    const waitPanel = async (wantHidden, ms = 600) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (document.querySelector('#todoPanel').hidden === wantHidden) return true;
        await sleep(40);
      }
      return document.querySelector('#todoPanel').hidden === wantHidden;
    };
    if (!document.querySelector('#todoPanel').hidden) { toggleTodoPanel(); await waitPanel(true); }
    toggleTodoPanel(); // 程序化打开面板
    await waitPanel(false);
    await sleep(220);
    const body = $('#todoPanelBody');
    assert('todo.panelOpen', await waitPanel(false));
    assert('todo.addRowExists', !!$('.todo-add-input', body));

    // 1) inline 新增 2 项
    const addViaEnter = async (text) => {
      const inp = $('.todo-add-input', body);
      inp.value = text;
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(60);
    };
    await addViaEnter('写探针脚本');
    await addViaEnter('跑回归基线');
    assert('todo.addedTwo', s.todoTasks.length === 2, s.todoTasks.map((t) => t.content));
    assert('todo.addedPending', s.todoTasks.every((t) => t.status === 'pending'));
    assert('todo.rowsRendered', $$('#todoPanelBody .todo-item').length === 2);

    // 2) 编辑第 1 项文字（点击文字 → inline input → Enter 保存）
    $('#todoPanelBody .todo-item[data-idx="0"] [data-todo-edit]').click();
    await sleep(60);
    const editInput = $('.todo-edit-input', body);
    assert('todo.editInputShown', !!editInput);
    editInput.value = '写探针脚本(改)';
    editInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(80);
    assert('todo.editSaved', s.todoTasks[0].content === '写探针脚本(改)', s.todoTasks[0].content);
    assert('todo.editPersisted', JSON.parse(localStorage.getItem(sourceOf() === 'preview' ? 'dsh.sessions.preview' : 'dsh.sessions.model'))
      .sessions.find((x) => x.id === s.id).todoTasks[0].content === '写探针脚本(改)');

    // 3) 状态循环 pending → in_progress → verifying → completed → pending（G4 扩展了验证中态）
    const clickStatus = async () => {
      $('#todoPanelBody .todo-item[data-idx="0"] [data-todo-status]').click();
      await sleep(50);
    };
    await clickStatus();
    const after1 = s.todoTasks[0].status;
    await clickStatus();
    const after2 = s.todoTasks[0].status;
    await clickStatus();
    const after3 = s.todoTasks[0].status;
    await clickStatus();
    assert('todo.statusCycle', after1 === 'in_progress' && after2 === 'verifying' && after3 === 'completed'
      && s.todoTasks[0].status === 'pending',
      [after1, after2, after3, s.todoTasks[0].status]);

    // 4) 两段确认删除第 2 项
    $('#todoPanelBody .todo-item[data-idx="1"] [data-todo-del]').click();
    await sleep(50);
    assert('todo.deleteArmed', s.todoTasks.length === 2
      && $('#todoPanelBody .todo-item[data-idx="1"] [data-todo-del]').textContent.includes('确认?'));
    $('#todoPanelBody .todo-item[data-idx="1"] [data-todo-del]').click();
    await sleep(50);
    assert('todo.deleted', s.todoTasks.length === 1 && s.todoTasks[0].content === '写探针脚本(改)');

    // 5) 拖拽排序：补一项后把第 2 行拖到第 1 行之前
    await addViaEnter('排序用任务');
    assert('todo.twoRowsAgain', s.todoTasks.length === 2);
    const rows = $$('#todoPanelBody .todo-item');
    const dt = new DataTransfer();
    rows[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    rows[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    assert('todo.dropLineShown', rows[0].classList.contains('is-drop-before'));
    rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    rows[1].dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    await sleep(60);
    assert('todo.reordered', s.todoTasks[0].content === '排序用任务' && s.todoTasks[1].content === '写探针脚本(改)',
      s.todoTasks.map((t) => t.content));

    // 6) 持久化一致：s.todoTasks 与 localStorage 完全一致
    const key = sourceOf() === 'preview' ? 'dsh.sessions.preview' : 'dsh.sessions.model';
    const persisted = JSON.parse(localStorage.getItem(key)).sessions.find((x) => x.id === s.id).todoTasks;
    assert('todo.persistedEqual', JSON.stringify(persisted) === JSON.stringify(s.todoTasks));

    // 7) 模型刷新链不破坏：伪造 todo_write 成功后的更新（保留一项手工任务）。
    //    现有链路：工具回调只 renderTodoPanel，持久化在回合结束的 saveSessions() 落盘 —— 探针按真实时序模拟。
    s.todoTasks = [{ content: '模型写入的任务A', status: 'pending' }, { content: '写探针脚本(改)', status: 'in_progress' }];
    renderTodoPanel();
    await sleep(40);
    assert('todo.modelChainOk', $('#todoPanelBody').textContent.includes('模型写入的任务A')
      && $('#todoPanelBody').textContent.includes('写探针脚本(改)'));
    saveSessions(); // 模拟回合结束时现有保存链的落盘点
    const persisted2 = JSON.parse(localStorage.getItem(key)).sessions.find((x) => x.id === s.id).todoTasks;
    assert('todo.modelChainPersisted', JSON.stringify(persisted2) === JSON.stringify(s.todoTasks));

    // 8) 同步给模型开关：开启后手工变更进缓冲，apiSuffix 摘要取一次即清空
    $('#todoSyncChk').click();
    await sleep(30);
    assert('todo.syncToggleOn', todoSyncToModel === true && readStorage('dsh.todoSync', '') === '1');
    $('#todoPanelBody .todo-item[data-idx="0"] [data-todo-status]').click();
    await sleep(50);
    const suffix1 = todoSyncSuffix();
    const suffix2 = todoSyncSuffix();
    assert('todo.syncSuffixOnce', suffix1.includes('任务清单变更') && suffix1.includes('状态') && suffix2 === '', suffix1.trim());
    $('#todoSyncChk').click(); // 关回去，清空缓冲
    await sleep(30);
    assert('todo.syncToggleOffClears', todoSyncToModel === false && todoSyncLines.length === 0);

    // 收尾：进入行内编辑态作为截图画面
    $('#todoPanelBody .todo-item[data-idx="0"] [data-todo-edit]').click();
    await sleep(60);
    assert('todo.finalEditing', !!$('.todo-edit-input', body));
    // 诊断：面板可见性与位置（截图缺面板时定位是脚本内就关了，还是脚本结束后被关）
    const panelEl = document.querySelector('#todoPanel');
    const rect = panelEl.getBoundingClientRect();
    results.diag = {
      hidden: panelEl.hidden,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      display: getComputedStyle(panelEl).display,
      rows: $$('#todoPanelBody .todo-item').length,
      hideCalls,
    };
    // 面板行内操作（重建列表 + target 脱离 DOM）后不得被外部点击守卫误关
    assert('todo.panelStillOpen', await waitPanel(false));
    return results;
  } catch (err) {
    results.errors.push('exception: ' + (err && err.message ? err.message : String(err)));
    return results;
  }
})();
