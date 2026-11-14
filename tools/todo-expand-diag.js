/* 诊断：agent todo_write → 面板收起态下是否自动展开 */
(async () => {
  const s = active();
  s.todoCollapsedByUser = true; // 模拟用户手动收起过
  toggleTodoPanel(); // 收起
  await new Promise((r) => setTimeout(r, 250));
  const collapsedBefore = document.querySelector('#todoPanel').hidden;
  // 模拟 agent 调 todo_write 的入列路径（收起态）
  s.todoTasks = [
    { content: '设计数据模型', status: 'completed' },
    { content: '实现存储层', status: 'in_progress' },
    { content: '编写接口文档', status: 'pending' },
  ];
  renderTodoPanel();
  if (s.todoCollapsedByUser !== true) openTodoPanel();
  await new Promise((r) => setTimeout(r, 300));
  const afterAgentWrite = document.querySelector('#todoPanel').hidden;
  // 清除手动收起标记（模拟用户手动展开过一次）→ 再写任务应展开
  s.todoCollapsedByUser = false;
  toggleTodoPanel(); // 此时面板是开的→收起
  await new Promise((r) => setTimeout(r, 250));
  s.todoTasks = [...s.todoTasks, { content: '第四项任务', status: 'pending' }];
  renderTodoPanel();
  if (s.todoCollapsedByUser !== true) openTodoPanel();
  await new Promise((r) => setTimeout(r, 300));
  const afterAgentWrite2 = document.querySelector('#todoPanel').hidden;
  return {
    collapsedBefore,
    afterAgentWrite_withUserCollapse: afterAgentWrite, // 期望 true（尊重手动收起）
    afterAgentWrite2_withoutUserCollapse: afterAgentWrite2, // 期望 false（自动展开）
    taskCount: s.todoTasks.length,
  };
})();
