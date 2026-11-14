/* 场景探针 settings-appearance：打开设置页 · 外观 pane（主题/配色/壁纸）截图。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);
  openSettings('appearance');
  await sleep(300);
  // 视图守卫：并行 GUI 误触可能关掉设置页——截图窗口期内每 300ms 重开目标 pane
  const guard = setInterval(() => { if (document.querySelector('#settingsPage').hidden) openSettings('appearance'); }, 300);
  setTimeout(() => clearInterval(guard), 3000);
  return { ok: true, note: '设置页 · 外观', opened: !document.querySelector('#settingsPage').hidden };
})();
