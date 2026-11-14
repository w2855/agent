/* 设置页截图：打开设置页供 --shot 目检 */
(async () => {
  await new Promise((r) => setTimeout(r, 600));
  openSettings('appearance');
  await new Promise((r) => setTimeout(r, 400));
  return { opened: !document.querySelector('#settingsPage').hidden, closeBtnVisible: (() => { const b = document.querySelector('#settingsClose'); const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })() };
})();
