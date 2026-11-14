/* 场景探针 chat-idle：空会话 + 欢迎态——不做任何操作直接返回，
   用全新隔离 user-data-dir 启动，截应用默认的空闲首屏。 */
(async () => {
  // 视图守卫：并行 GUI 误触可能打开设置/菜单——截图窗口期内保持空闲首屏
  const guard = setInterval(() => {
    if (!$('#settingsPage').hidden) closeSettings();
    hideMenus();
  }, 300);
  setTimeout(() => clearInterval(guard), 3000);
  const s = active();
  const page = document.querySelector('#settingsPage');
  return {
    ok: true,
    note: '空会话欢迎态',
    msgs: s ? s.messages.length : -1,
    settingsClosed: !page || page.hidden,
  };
})();
