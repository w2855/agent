/* 真实 API 自检：只访问 DEFAULT_API 指向的真实端点，不启动任何模拟服务。
 * 运行： electron . --shot --script=tools/self-check.js
 */
(async () => {
  const out = { checks: [] };
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '').slice(0, 220) });
  const lastProse = () => [...document.querySelectorAll('.prose')].at(-1);
  const lastSummary = () => [...document.querySelectorAll('.summary')].at(-1)?.textContent.replace(/\s+/g, ' ').trim();
  const waitIdle = async (limit = 60000) => {
    const t0 = Date.now();
    while (state.busy && Date.now() - t0 < limit) await sleep(100);
    return !state.busy;
  };

  // 静默探活可能正在跑，直接调用 IPC 层，避免与 UI 探活互斥
  await sleep(900);

  /* A. 默认配置与模型锁定 */
  add('默认端点为需求指定值', q('#apiBaseUrl').value === 'https://jinitai.zh.kg/v1', q('#apiBaseUrl').value);
  add('模型锁定为 gemini-3.8-flash', MODEL_ID === 'gemini-3.8-flash' && q('#apiModel').value === MODEL_ID && q('#apiModel').readOnly, q('#apiModel').value);
  add('默认来源为真实模型 API', sourceOf() === 'model', sourceOf());
  add('Key 已载入本机配置', !!q('#apiKey').value && q('#apiKey').value.startsWith('sk-'), `${q('#apiKey').value.length} 字符`);
  add('配置校验：合法配置通过', validateApiInput(DEFAULT_API) === null, String(validateApiInput(DEFAULT_API)));
  add('配置校验：空地址被拒', validateApiInput({ baseUrl: '', key: 'x', model: MODEL_ID }) !== null, validateApiInput({ baseUrl: '', key: 'x', model: MODEL_ID }));
  add('配置校验：非法 URL 被拒', validateApiInput({ baseUrl: 'ht!tp://%%', key: 'x', model: MODEL_ID }) !== null, validateApiInput({ baseUrl: 'ht!tp://%%', key: 'x', model: MODEL_ID }));
  add('配置校验：非 http(s) 被拒', validateApiInput({ baseUrl: 'ftp://x/v1', key: 'x', model: MODEL_ID }) !== null, validateApiInput({ baseUrl: 'ftp://x/v1', key: 'x', model: MODEL_ID }));
  add('配置校验：空 Key 被拒', validateApiInput({ baseUrl: DEFAULT_API.baseUrl, key: '', model: MODEL_ID }) !== null, validateApiInput({ baseUrl: DEFAULT_API.baseUrl, key: '', model: MODEL_ID }));
  add('配置校验：其它模型被拒', validateApiInput({ ...DEFAULT_API, model: 'gpt-4o' }) !== null, validateApiInput({ ...DEFAULT_API, model: 'gpt-4o' }));

  /* B. 主进程参数校验（真实 IPC，不产生网络请求） */
  const badModel = await window.dsh.model.test({ ...DEFAULT_API, model: 'gpt-4o' });
  add('主进程拒绝非白名单模型', badModel.ok === false && badModel.code === 'BAD_CONFIG', JSON.stringify(badModel));
  const badKey = await window.dsh.model.test({ ...DEFAULT_API, key: '' });
  add('主进程拒绝空 Key', badKey.ok === false, JSON.stringify(badKey));
  const badUrl = await window.dsh.model.test({ ...DEFAULT_API, baseUrl: 'ht!tp://%%' });
  add('主进程拒绝非法 URL', badUrl.ok === false, JSON.stringify(badUrl));

  const badChatEvents = [];
  const offBad = window.dsh.model.onEvent((e) => { if (e.id === 'bad-args-check') badChatEvents.push(e); });
  window.dsh.model.chat('bad-args-check', DEFAULT_API, []);
  await sleep(350);
  offBad();
  add('主进程拒绝空消息列表', badChatEvents.some((e) => e.type === 'error' && e.code === 'BAD_ARGS'), JSON.stringify(badChatEvents.map((e) => e.type + ':' + (e.code || ''))));

  /* C. 真实探活 + 真实错误分支（错误 Key 打真实端点） */
  const real = await window.dsh.model.test(DEFAULT_API);
  add('真实 /models 探活通过', real.ok === true && real.model === MODEL_ID, JSON.stringify(real));
  const wrongKey = await window.dsh.model.test({ ...DEFAULT_API, key: 'sk-invalid-key-for-check' });
  add('真实 401/鉴权错误被正确分类', wrongKey.ok === false && !!wrongKey.code, JSON.stringify(wrongKey));

  /* D. 真实流式对话 */
  newChat();
  const ta = q('#input');
  ta.value = '请只回复两个字：收到';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  q('#sendBtn').click();
  add('发送后进入生成态', state.busy === true && q('#sendBtn').classList.contains('streaming'), `busy=${state.busy}`);
  const idle = await waitIdle(90000);
  const body = lastProse()?.textContent.trim() || '';
  add('真实流式回合正常结束', idle && !state.busy, lastSummary());
  add('模型返回非空正文', body.length > 0 && !body.includes('API 调用失败'), body.slice(0, 90));
  add('回合状态为已完成', (lastSummary() || '').includes('已完成'), lastSummary());
  const metricsText = [...document.querySelectorAll('.metrics')].at(-1)?.textContent.trim() || '';
  add('统计行来自真实计时与字数', /\d+\.\d+ 秒/.test(metricsText) && /字/.test(metricsText), metricsText);
  q('.metrics')?.click();
  add('统计详情按真实数据展开', !!q('.metrics-detail') && (q('.metrics-detail').textContent || '').includes(MODEL_ID), (q('.metrics-detail')?.textContent || '').slice(0, 120));

  /* E. 真实请求中断 */
  const abortEvents = [];
  const offAbort = window.dsh.model.onEvent((e) => { if (e.id === 'real-abort-check') abortEvents.push(e); });
  window.dsh.model.chat('real-abort-check', DEFAULT_API, [{ role: 'user', content: '请写一段 2000 字的长文，逐字输出，不要省略' }]);
  await sleep(180);
  window.dsh.model.abort('real-abort-check');
  await sleep(900);
  offAbort();
  add('真实请求可中止并收到终止帧', abortEvents.some((e) => e.type === 'done' && e.aborted === true), JSON.stringify(abortEvents.slice(-3).map((e) => e.type + ':' + (e.code || e.reason || ''))));

  /* F. 上下文压缩（真实状态变更） */
  const beforeCompact = active().messages.length;
  handleCommand('/compact');
  add('/compact 生成真实摘要', state.compacted.has(active().id) && active().messages.length === 1 && beforeCompact >= 2, `before=${beforeCompact} after=${active().messages.length}`);
  const msgs = buildApiMessages(active(), '继续', null, null);
  add('压缩摘要注入后续请求', msgs.some((m) => m.role === 'system' && m.content.includes('压缩摘要')), `messages=${msgs.length}`);

  /* G. 附件真实读取（浏览器 File API，非模拟服务） */
  const file = new File(['alpha\nbeta'], 'notes.txt', { type: 'text/plain' });
  await addFiles([file]);
  const attached = state.attachments[0];
  add('文本附件被真实读取并纳入上下文', !!attached && attached.text === 'alpha\nbeta' && formatAttachments().includes('alpha'), JSON.stringify(attached));
  add('附件条渲染且可移除', !q('#attachBar').hidden && !!q('[data-attach-remove]'), q('#attachBar').textContent.trim().slice(0, 60));
  removeAttachment(0);
  add('移除附件后状态归零', state.attachments.length === 0 && q('#attachBar').hidden, `${state.attachments.length}`);
  const big = new File(['x'.repeat(10)], 'huge.bin', { type: 'application/octet-stream' });
  Object.defineProperty(big, 'size', { value: LIMITS.maxAttachBytes + 1 });
  await addFiles([big]);
  add('超大附件被拒绝且给出原因', !!state.attachments[0]?.error && state.attachments[0].error.includes('上限'), state.attachments[0]?.error);
  removeAttachment(0);

  /* H. 离线预览：审批状态持久化、文件详情、回放 */
  document.querySelector('#sourceSeg button[data-source="preview"]').click();
  q('#connectBtn').click();
  add('可切到离线预览且会话集合独立', sourceOf() === 'preview' && state.sessions.length > 1, `sessions=${state.sessions.length}`);
  const previewSession = state.sessions.find((s) => s.messages.some((m) => m.approval)) || state.sessions[0];
  selectSession(previewSession.id);
  const approvalBefore = [...document.querySelectorAll('[data-approve]')];
  if (approvalBefore.length) {
    approvalBefore[0].click();
    const msgWithApproval = active().messages.find((m) => m.approval);
    add('审批结果写入消息状态', msgWithApproval?.approval?.outcome === 'once', JSON.stringify(msgWithApproval?.approval));
    renderChat();
    add('重绘后审批结果保持一致', !!document.querySelector('.approval.done') && !document.querySelector('[data-approve]'), document.querySelector('.approval-head')?.textContent.trim());
  } else {
    add('审批结果写入消息状态', false, '预览会话中未找到审批卡');
    add('重绘后审批结果保持一致', false, '预览会话中未找到审批卡');
  }
  const fileSession = state.sessions.find((s) => s.messages.some((m) => m.files && m.files.length));
  if (fileSession) selectSession(fileSession.id);
  const moreBtn = document.querySelector('[data-file-more]');
  if (moreBtn) {
    moreBtn.click();
    add('文件卡「更多」展开真实元信息', !!document.querySelector('.file-detail'), document.querySelector('.file-detail')?.textContent.trim().slice(0, 80));
  } else {
    add('文件卡「更多」展开真实元信息', false, '预览会话中未找到文件卡');
  }
  const beforeTurn = active().messages.length;
  runTurn('帮我把这段代码改成异步');
  await waitIdle(20000);
  add('离线预览回合完整回放且不联网', active().messages.length > beforeTurn && !state.busy, lastSummary());

  /* I. 切回真实来源，状态恢复 */
  document.querySelector('#sourceSeg button[data-source="model"]').click();
  q('#connectBtn').click();
  add('切回模型 API 且会话集合恢复', sourceOf() === 'model' && state.sessions.length >= 1 && q('#modelName').textContent === MODEL_ID, `source=${sourceOf()}`);

  out.total = out.checks.length;
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.total - out.passed;
  return out;
})();
