/* T1 截图二：对话 pane 的「上下文」卡片（含会话上下文窗口输入行）。shot.png 供目检。 */
(async () => {
  openSettings('chat');
  await new Promise((r) => setTimeout(r, 400));
  const input = $('#ctxLimitInput');
  const card = input?.closest('.settings-card');
  card?.scrollIntoView({ block: 'center' });
  return {
    paneOpen: !$('#settingsPage').hidden,
    inputExists: !!input,
    inputValue: input?.value,
    badgeHintPresent: !!$('#customPromptInput'),
  };
})();
