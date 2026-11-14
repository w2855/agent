/* e2e 挂起诊断 v2：经主进程真实发一次请求，测网络栈是否可用 */
(async () => {
  await new Promise((r) => setTimeout(r, 1500));
  const t0 = Date.now();
  let test = null, testErr = null;
  try {
    test = await Promise.race([
      window.dsh.model.test({ baseUrl: 'http://127.0.0.1:57321/v1', key: 'sk-test', model: 'mock-tool-model' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('model:test 8s 超时')), 8000)),
    ]);
  } catch (e) { testErr = e?.message || String(e); }
  return {
    ms: Date.now() - t0,
    testOk: !!test && !testErr,
    testErr,
    testKeys: test ? Object.keys(test).slice(0, 6) : null,
    fetchDirect: await Promise.race([
      fetch('http://127.0.0.1:57321/v1/models').then((r) => 'fetch-ok ' + r.status).catch((e) => 'fetch-err ' + e.message),
      new Promise((r) => setTimeout(() => 'fetch 5s 超时', 5000)),
    ]),
  };
})();
