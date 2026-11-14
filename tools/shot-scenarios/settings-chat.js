/* 场景探针 settings-chat：打开设置页 · 聊天 pane（个性化提示词/失败重试/上下文设置）截图。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);
  openSettings('chat');
  await sleep(300);
  // 视图守卫：并行 GUI 误触可能关掉设置页——截图窗口期内每 300ms 重开目标 pane
  const guard = setInterval(() => { if (document.querySelector('#settingsPage').hidden) openSettings('chat'); }, 300);
  setTimeout(() => clearInterval(guard), 3000);
  return { ok: true, note: '设置页 · 聊天', opened: !document.querySelector('#settingsPage').hidden };
})();
