(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitUntil = async (fn, ms = 30000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try { if (fn()) return true; } catch { /* 等待节点 */ }
      await sleep(100);
    }
    return false;
  };

  state.connection = {
    source: 'model',
    api: { baseUrl: 'http://127.0.0.1:57321/v1', key: 'test-key', model: 'mock-tool-model' },
    verified: false,
  };
  if (sourceOf() !== 'model') switchSource('model');
  setPermission('full');
  newChat();
  runTurn('[[write]] 生成运行检查器样例');
  await waitUntil(() => state.busy === true, 3000);
  await waitUntil(() => state.busy === false, 40000);
  document.querySelector('#panelBtn').click();
  await waitUntil(() => !document.querySelector('#inspector').hidden
    && document.querySelectorAll('#inspBody .insp-node').length > 0, 8000);
  await sleep(500);
  const body = document.querySelector('#inspBody');
  if (body) body.scrollTop = 0;
  await sleep(150);
  return {
    ok: !document.querySelector('#inspector').hidden,
    runId: inspector.runId,
    nodes: document.querySelectorAll('#inspBody .insp-node').length,
    tasks: document.querySelectorAll('#inspBody .insp-task').length,
    status: document.querySelector('#inspBody .insp-chip')?.textContent || '',
  };
})();
