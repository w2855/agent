(async () => {
  const r = { bootPanelHidden: document.querySelector('#todoPanel')?.hidden ?? 'no-el',
    localStoragePinned: localStorage.getItem('dsh.todoPinned'),
    toggleType: typeof toggleTodoPanel,
    todoBtnExists: !!document.querySelector('#todoBtn') };
  toggleTodoPanel();
  await new Promise((res) => setTimeout(res, 80));
  r.afterToggle1 = document.querySelector('#todoPanel')?.hidden;
  toggleTodoPanel();
  await new Promise((res) => setTimeout(res, 80));
  r.afterToggle2 = document.querySelector('#todoPanel')?.hidden;
  return r;
})();
