/* 场景探针 settings-doctor：打开设置页 · 体检 pane。体检进入即跑一次，
   各检查项带 3s 超时——探针多等 1s 让结果尽量落定（仍未跑完的部分属正常 best-effort）。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);
  openSettings('doctor');
  await sleep(1000);
  // 视图守卫：并行 GUI 误触可能关掉设置页——截图窗口期内每 300ms 重开（pane 级缓存不会重跑体检）
  const guard = setInterval(() => { if (document.querySelector('#settingsPage').hidden) openSettings('doctor'); }, 300);
  setTimeout(() => clearInterval(guard), 3000);
  const rows = document.querySelectorAll('#paneDoctor .doctor-row, #paneDoctor [data-doctor-status]').length;
  return { ok: true, note: '设置页 · 体检（结果可能部分仍在跑）', opened: !document.querySelector('#settingsPage').hidden, rows };
})();
