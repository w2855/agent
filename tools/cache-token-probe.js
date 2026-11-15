/* 缓存指标口径 + 省 token 回归探针（渲染进程 --script 通道）。
   ① 本轮 / 平均缓存命中率的统计口径、标签、同屏可见性与 hover 说明
   ② 重复只读调用去重：只执行一次、第二次回短引用、写后重读不被误判
   ③ 补答/重试涉及多次上游请求时，usage 按请求聚合，不漏计 token
   不改动任何既有探针断言。 */

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [] };
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
  const MOCK = 'http://127.0.0.1:57321/v1';

  state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model' }, verified: false };
  if (sourceOf() !== 'model') switchSource('model');
  fillFormFromConn();
  newChat();
  await sleep(200);

  const s = active();
  const u75 = { prompt_tokens: 4000, completion_tokens: 90, total_tokens: 4090, cached_tokens: 3000, cache_rate: 75 };

  /* ── ① 口径：与 ZCode usage-stats-builder 一致，Σcached / Σprompt 累计加权 ── */
  add('单次命中率沿用 cached/prompt 口径', /缓存 75%/.test(cacheHitText(u75)), cacheHitText(u75));
  add('未上报缓存时不显示成 0%', cacheHitText({ prompt_tokens: 100 }) === '', cacheHitText({ prompt_tokens: 100 }));
  s.cacheStats = { cached: 3000, prompt: 5000, turns: 2 }; // 75% 与 0% 两轮
  const weighted = sessionCacheStats(s);
  add('平均命中率是累计加权（60%），不是逐轮算术平均（37.5%）',
    weighted && weighted.rate === 60 && weighted.turns === 2, JSON.stringify(weighted));
  s.cacheStats = { cached: 3000, prompt: 4000, turns: 1 };
  s.messages.push({
    role: 'assistant', body: '示例正文', startedAt: Date.now() - 1000, finishedAt: Date.now(),
    usage: u75, summary: { label: '已完成' }, metrics: buildMetrics({ usage: u75, body: '示例正文', tools: [], startedAt: Date.now() - 1000, finishedAt: Date.now(), retries: 0 }),
  });
  add('消息耗时行标注「本轮缓存」', /本轮缓存 75%/.test(s.messages.at(-1).metrics), s.messages.at(-1).metrics);

  updateStatusline();
  const bar = $('#statusline');
  const text = bar?.textContent || '';
  add('上下文信息与平均缓存命中率同屏可见',
    /上下文 \d+%（\d+k\/\d+k）/.test(text) && /平均缓存命中率：均值 75%/.test(text), text);
  add('本轮与平均各自带标签，口径不混淆',
    /本轮缓存 75%/.test(text) && /平均缓存命中率/.test(text) && /会话 1 轮/.test(text), text);
  add('状态条保留原有「均值 75%」断言格式', /均值 75%/.test(text), text);
  add('悬停可查两类指标的统计范围与数据来源',
    /Σcached_tokens/.test(bar?.title || '') && /未上报/.test(bar?.title || '') && /上下文预算/.test(bar?.title || ''),
    (bar?.title || '').slice(0, 90));
  const barRect = bar?.getBoundingClientRect();
  const composerRect = $('.composer-area')?.getBoundingClientRect();
  add('状态条与常驻输入框同屏（原交互不受影响）',
    !!barRect && barRect.height > 0 && !!composerRect && composerRect.height > 0 && !$('#input')?.disabled,
    `bar=${barRect?.height} composer=${composerRect?.height}`);

  /* ── ② 省 token：重复工具调用 / 重复上下文读取 / 冗余输出 ── */
  const call = (name, args) => ({ id: 'c_' + Math.random().toString(36).slice(2), function: { name, arguments: JSON.stringify(args) } });
  const k1 = toolReuseKey('read_file', { path: 'a.txt', offset: 0 }, 0);
  const k2 = toolReuseKey('read_file', { offset: 0, path: 'a.txt' }, 0);
  add('稳定化参数：键顺序不同仍识别为同一调用', !!k1 && k1 === k2, k1);
  add('写工具不参与只读去重', toolReuseKey('write_file', { path: 'a.txt' }, 0) === '', 'ok');
  add('写操作版本变化后允许重读', toolReuseKey('read_file', { path: 'a.txt' }, 1) !== k1, 'ok');

  let runs = 0;
  const saver = createToolCallSaver(async () => { runs += 1; return 'X'.repeat(20000); });
  const first = await saver.run(call('read_file', { path: 'a.txt' }));
  const second = await saver.run(call('read_file', { path: 'a.txt' }));
  add('相同只读调用只真正执行一次', runs === 1, `runs=${runs}`);
  add('第二次回灌为短引用，不重复展开整份结果',
    /未重复执行或展开/.test(second) && second.length < first.length / 10, `${first.length} → ${second.length} 字符`);
  await saver.run(call('read_file', { path: 'b.txt' }));
  add('不同参数仍真实执行（功能不丢）', runs === 2, `runs=${runs}`);
  saver.markWrite();
  const afterWrite = await saver.run(call('read_file', { path: 'a.txt' }));
  add('写后重读不被误判为重复（上下文完整性）',
    runs === 3 && afterWrite === first && saver.epoch === 1, `runs=${runs} epoch=${saver.epoch}`);
  const failing = createToolCallSaver(async () => '工具执行失败：磁盘不可读');
  await failing.run(call('read_file', { path: 'a.txt' }));
  const retry = await failing.run(call('read_file', { path: 'a.txt' }));
  add('失败结果不缓存，下一次会真重试', !/未重复执行/.test(retry), retry.slice(0, 40));
  add('去重已接入真实工具循环', String(runApiTurn).includes('toolSaver.run'), 'ok');
  add('状态条文案已接入（非纯函数摆设）', String(formatStatusline).includes('平均缓存命中率'), 'ok');

  /* ── ③ usage 聚合：[[thinkonly]] 会发起两次请求（120/4096/4216 + 120/40/160） ── */
  const waitIdle = async (ms = 30000) => {
    const t = Date.now();
    while (state.busy && Date.now() - t < ms) await sleep(120);
  };
  runTurn('[[thinkonly]] 验证多请求用量聚合');
  await waitIdle();
  const lastMsg = active().messages.filter((m) => m.role === 'assistant').at(-1);
  const merged = lastMsg?.usage || {};
  add('补答轮次 token 不漏计（Σprompt=240 / Σtotal=4376）',
    merged.prompt_tokens === 240 && merged.total_tokens === 4376 && merged.completion_tokens === 4136,
    JSON.stringify(merged));
  add('聚合后原有缓存口径仍准确（无缓存上报则不计入平均）',
    !Number.isFinite(merged.cached_tokens) && active().cacheStats.turns === 1,
    `cached=${merged.cached_tokens} turns=${active().cacheStats.turns}`);

  return out;
})();
