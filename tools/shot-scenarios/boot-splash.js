/* 场景探针 boot-splash：截「应用就绪瞬间」——立即返回、不做任何操作，
   让引擎在启动画面渐隐前后的时间窗内截图（best-effort：受 main.js 固定延时影响，
   实际截到的可能是 splash 已淡出后的首帧，适合守护「就绪态无异常白屏/报错弹层」）。 */
(async () => {
  const splash = document.getElementById('bootSplash');
  // 视图守卫：并行 GUI 误触可能打开设置——截图窗口期内保持首屏
  const guard = setInterval(() => { if (!$('#settingsPage').hidden) closeSettings(); }, 300);
  setTimeout(() => clearInterval(guard), 3000);
  return {
    ok: true,
    note: '立即返回，捕获启动画面渐隐前后画面（best-effort）',
    splashStillMounted: !!splash,
  };
})();
