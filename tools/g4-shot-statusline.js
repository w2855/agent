/* G4 截图二：Statusline 状态条 + composer 协作徽标 + 任务清单三态（供 --shot 目检样式） */
(async () => {
  const s = active();
  s.messages = [{
    role: 'user', text: '帮我把任务清单整理一下',
  }, {
    role: 'assistant', body: '好的，任务清单已整理。\n\n- [x] 拆分步骤\n- [ ] 校验状态循环',
    startedAt: Date.now() - 12300, finishedAt: Date.now(),
    usage: { prompt_tokens: 900, completion_tokens: 340 },
    summary: { label: '已完成', tools: 0, messages: 1 },
    tools: [], files: [], approval: null, metrics: '0.4 秒 · 32 字 · 0 次工具',
  }];
  state.agents = [{ id: 'a1', status: 'active', name: 'A1' }, { id: 'a2', status: 'active', name: 'A2' }];
  s.todoTasks = [
    { content: '实现快排主体', status: 'completed' },
    { content: '写边界用例', status: 'in_progress' },
    { content: '验证性能基线', status: 'verifying' },
    { content: '等待上游接口', status: 'blocked' },
    { content: '整理文档', status: 'pending' },
  ];
  renderChat();
  scrollToBottom(true);
  setPairMode('tdd');
  updateStatusline();
  toggleTodoPanel(); // 打开任务清单面板（含四色圆点 + ⛔/解除按钮）
  await new Promise((r) => setTimeout(r, 300));
  return { statusline: $('#statusline')?.textContent, badge: $('#pairBadge')?.textContent, panelOpen: !$('#todoPanel').hidden };
})();
