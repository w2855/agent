/* 场景探针 todo-panel：注入 3 条不同状态的任务（已完成/进行中/待办）并确保面板展开，
   覆盖清单常驻面板的状态点、进度摘要与新增行的视觉基线。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const s = active();
  s.todoTasks = [
    { content: '整理会话历史', status: 'completed' },
    { content: '编写回归探针', status: 'in_progress' },
    { content: '等待人工验收', status: 'pending' },
  ];
  renderTodoPanel();
  // 视图守卫：并行 GUI 误触可能收起面板/打开设置——截图窗口期内每 300ms 重断言目标视图
  const guard = setInterval(() => {
    const panel = $('#todoPanel');
    if (panel?.hidden) openTodoPanel();
    if (!$('#settingsPage').hidden) closeSettings();
  }, 300);
  setTimeout(() => clearInterval(guard), 3000);
  if ($('#todoPanel').hidden) openTodoPanel(); // 启动默认常驻展开；被收起过则重新打开
  await sleep(250);
  const rows = document.querySelectorAll('#todoPanelBody .todo-item').length;
  return {
    ok: !$('#todoPanel').hidden && rows === 3,
    note: '任务面板展开 + 三种状态',
    panelOpen: !$('#todoPanel').hidden,
    rows,
    summary: ($('#todoPanelSummary') || {}).textContent || '',
  };
})();
