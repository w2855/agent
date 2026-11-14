/* T1 截图一：会话头部 ID 徽标（#m-xxxx）。留在对话视图，shot.png 供目检。 */
(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const s = active();
  if (s) {
    s.title = '事件溯源方案讨论';
    s.messages.push(
      { role: 'user', text: '帮我梳理事件溯源的核心概念' },
      { role: 'assistant', summary: { label: '已完成', tools: 0, messages: 1 }, body: '事件溯源（Event Sourcing）把状态变更记录为不可变事件序列……', startedAt: Date.now(), finishedAt: Date.now() },
    );
  }
  renderHeader();
  renderChat();
  const badge = $('#sessionBadge');
  return { badgeText: badge?.textContent, badgeHidden: badge?.hidden, title: $('#title').textContent };
})();
