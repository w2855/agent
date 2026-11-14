(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [] };
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
  const CFG = { baseUrl: 'https://jinitai.zh.kg/v1', key: process.env.DSH_TEST_KEY || '', model: 'gemini-3.8-flash' };

  /* ── 1. 上游模型列表（真实请求） ── */
  const listed = await window.dsh.model.list(CFG);
  add('上游 /models 返回成功', listed.ok === true, listed.ok ? `count=${listed.count}` : `${listed.code} ${listed.error}`);
  add('列表含 gemini-3.8-flash', !!listed.models?.some((m) => m.id === 'gemini-3.8-flash'),
    (listed.models || []).slice(0, 4).map((m) => m.id).join(','));
  add('列表数量 > 1（可选择的模型不止一个）', (listed.count || 0) > 1, `count=${listed.count}`);

  /* ── 2. 面板：真实拉列表 + 渲染 ── */
  openModelSheet();
  await sleep(300);
  const listItems = document.querySelectorAll('#modelList .model-item').length;
  add('模型面板渲染出条目', listItems > 0, `items=${listItems}`);
  const hasDefaultTag = !!document.querySelector('#modelList .m-tag');
  add('默认模型带「默认」标记', hasDefaultTag, hasDefaultTag ? 'ok' : '未找到');

  // 搜索过滤
  const search = document.querySelector('#modelSearch');
  search.value = 'agnes';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(80);
  const filtered = [...document.querySelectorAll('#modelList .model-item .m-name')].map((n) => n.textContent);
  add('搜索能过滤列表', filtered.length > 0 && filtered.every((n) => n.toLowerCase().includes('agnes')), filtered.join(','));
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));

  // 选中别的模型 -> 应用
  const target = (listed.models || []).find((m) => m.id !== 'gemini-3.8-flash');
  if (target) {
    const btn = document.querySelector(`#modelList .model-item[data-model="${target.id}"]`);
    if (btn) {
      btn.click();
      await sleep(50);
      document.querySelector('#modelApply').click();
      await sleep(120);
      add('选中后模型切换并落盘', state.connection.api.model === target.id
        && JSON.parse(localStorage.getItem('dsh.conn')).api.model === target.id,
        `model=${state.connection.api.model}`);
      add('顶栏模型名同步', document.querySelector('#modelName').textContent === target.id,
        document.querySelector('#modelName').textContent);
      // 切回默认
      state.connection.api.model = 'gemini-3.8-flash';
      localStorage.setItem('dsh.conn', JSON.stringify(state.connection));
      renderHeader();
    } else add('选中后模型切换并落盘', false, '未找到目标项');
  }

  /* ── 3. 真实流式对话 ── */
  const id = 'chk-' + Date.now();
  let text = '';
  let gotRetry = 0;
  let doneEvt = null;
  const seen = new Map();
  const errEvt = [];
  const tStart = Date.now();
  const firstChunkAt = { v: 0 };
  const off = window.dsh.model.onEvent((e) => {
    if (!e || e.id !== id) return;
    seen.set(e.type, (seen.get(e.type) || 0) + 1);
    if (e.type === 'chunk') {
      if (!firstChunkAt.v) firstChunkAt.v = Date.now() - tStart;
      text += e.text;
    }
    if (e.type === 'retry') gotRetry++;
    if (e.type === 'error') errEvt.push(`${e.code}: ${e.message}`);
    if (e.type === 'done') doneEvt = e;
  });
  window.dsh.model.chat(id, CFG, [{ role: 'user', content: '只回答四个字：链路正常' }]);
  for (let i = 0; i < 400 && !doneEvt; i++) await sleep(100);
  off();
  const elapsed = Date.now() - tStart;
  add('真实流式对话返回正文', text.trim().length > 0, JSON.stringify(text.trim().slice(0, 40)));
  add('回合正常收尾（done）', !!doneEvt, doneEvt
    ? `attempts=${doneEvt.attempts} retries=${doneEvt.retries}`
    : `${elapsed}ms 事件=${JSON.stringify([...seen])} 错误=${errEvt.join(' | ') || '无'}`);
  add('正常回合未触发重试', gotRetry === 0, `retryEvents=${gotRetry}`);
  add('首个增量到达时间记录', true, `${firstChunkAt.v}ms`);

  /* ── 4. 中断：真实中止 ── */
  const id2 = 'chk-abort-' + Date.now();
  let done2 = null;
  const off2 = window.dsh.model.onEvent((e) => {
    if (!e || e.id !== id2) return;
    if (e.type === 'done') done2 = e;
  });
  window.dsh.model.chat(id2, CFG, [{ role: 'user', content: '写一篇 800 字关于海洋的文章' }]);
  await sleep(900);
  const t0 = Date.now();
  window.dsh.model.abort(id2);
  for (let i = 0; i < 40 && !done2; i++) await sleep(50);
  const abortMs = Date.now() - t0;
  off2();
  add('中断在 1 秒内回执', !!done2 && abortMs < 1000, `done=${!!done2} ${abortMs}ms`);

  /* ── 5. 自动重试：指向一个必然连不上的地址，走真实网络错误 ── */
  const id3 = 'chk-retry-' + Date.now();
  const events3 = [];
  let done3 = null;
  const off3 = window.dsh.model.onEvent((e) => {
    if (!e || e.id !== id3) return;
    events3.push(e);
    if (e.type === 'done') done3 = e;
  });
  window.dsh.model.chat(id3, { ...CFG, baseUrl: 'http://127.0.0.1:59321/v1', retry: { maxAttempts: 3, baseDelayMs: 300, maxDelayMs: 800, jitter: 0 } },
    [{ role: 'user', content: 'ping' }]);
  for (let i = 0; i < 120 && !done3; i++) await sleep(100);
  off3();
  const retries = events3.filter((e) => e.type === 'retry');
  const err = events3.find((e) => e.type === 'error');
  add('不可达地址触发自动重试', retries.length >= 1, `retry=${retries.length}`);
  add('重试事件带次数与等待时间', retries.every((e) => e.nextAttempt > 1 && e.delayMs > 0 && e.maxAttempts === 3),
    JSON.stringify(retries.map((e) => `${e.nextAttempt}/${e.maxAttempts}@${e.delayMs}ms`)));
  add('重试用尽后报错收尾', !!err && !!done3, err ? `${err.code} ${String(err.message).slice(0, 50)}` : '无 error');
  add('用尽后 attempts 等于上限', (done3?.attempts || 0) === 3, `attempts=${done3?.attempts}`);

  /* ── 6. 权限级别 ── */
  setPermission('readonly');
  add('权限可切到只读', state.permission === 'readonly'
    && document.querySelector('#permBtn').dataset.level === 'readonly'
    && document.querySelector('#permName').textContent === '只读',
    document.querySelector('#permName').textContent);
  setPermission('full');
  add('权限可切回完全权限', document.querySelector('#permName').textContent === '完全权限', document.querySelector('#permName').textContent);

  out.total = out.checks.length;
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.total - out.passed;
  return out;
})();
