/* 截图辅助：等静默探活结束后打开 API 接入面板 */
(async () => {
  applyTheme('dark');
  await new Promise((r) => setTimeout(r, 1000));
  openConnect();
  return 'connect-panel';
})();
