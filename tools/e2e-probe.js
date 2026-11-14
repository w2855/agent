/* e2e 分步探针：复刻 tool-e2e 前 3 步，逐秒回报第一回合的 busy/工具/正文状态，定位卡点 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };
  const T0 = Date.now();
  const mark = (name, detail) => out.steps.push({ name, detail: String(detail ?? ''), t: Date.now() - T0 });

  await sleep(800);
  mark('boot', `toolsReady=${state.toolsReady} specs=${state.toolSpecs.length} workspace=${state.workspace}`);

  const MOCK = 'http://127.0.0.1:57321/v1';
  const base = await window.dsh.tools.defaultWorkspace();
  const ws = String(base).replace(/[\\/]+$/, '') + '\\dsh-e2e-' + Date.now();
  state.workspace = ws;
  writeStorage('dsh.workspace', ws);
  renderToolsSetting();
  state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model' }, verified: false };
  if (sourceOf() !== 'model') switchSource('model');
  fillFormFromConn();
  setPermission('full');
  newChat();
  mark('setup', 'conn=mock perm=full newChat done');

  runTurn('[[write]] 请写入测试文件');
  for (let i = 1; i <= 25; i++) {
    await sleep(1000);
    const a = active().messages.filter((m) => m.role === 'assistant').at(-1);
    mark('t' + i + 's', `busy=${state.busy} turns=${state.turns ? state.turns.size : '?'} tools=${(a?.tools || []).length} bodyLen=${(a?.body || '').length} label=${a?.summary?.label || ''}`);
    if (!state.busy) break;
  }
  return out;
})();
