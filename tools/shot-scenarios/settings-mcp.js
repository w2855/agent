/* 场景探针 settings-mcp：打开设置页 · MCP pane（MCP 服务器与外部工具）截图。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);
  openSettings('mcp');
  await sleep(300);
  // 视图守卫：并行 GUI 误触可能关掉设置页——截图窗口期内每 300ms 重开目标 pane
  const guard = setInterval(() => { if (document.querySelector('#settingsPage').hidden) openSettings('mcp'); }, 300);
  setTimeout(() => clearInterval(guard), 3000);
  return { ok: true, note: '设置页 · MCP', opened: !document.querySelector('#settingsPage').hidden };
})();
