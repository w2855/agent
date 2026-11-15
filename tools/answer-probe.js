/* 「最终答复必须肉眼可见 + 输入框常驻 + 输入区可调思考强度/模型」回归探针。
   与只查 textContent 的老探针不同：这里用 getComputedStyle / getBoundingClientRect
   检查「用户真的看得见」，因为正文曾被 opacity:0 / max-height:0 整块藏掉。
   经 main.js 的 --script 通道在渲染进程执行，返回值以 [script] JSON 输出。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [] };
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
  const vis = (el) => {
    if (!el) return { ok: false, why: '节点不存在' };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      ok: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
        && r.width > 0 && r.height > 0 && cs.maxHeight !== '0px',
      why: `opacity=${cs.opacity} maxHeight=${cs.maxHeight} rect=${Math.round(r.width)}x${Math.round(r.height)}`,
      h: Math.round(r.height),
    };
  };
  const mk = (body, tools) => ({
    role: 'assistant', body, tools: tools || [], summary: { label: '已完成', tools: (tools || []).length, messages: 1 },
    finishedAt: Date.now(), metrics: '1.0 秒 · 10 字 · 0 次工具', tasks: [], files: [], approval: null,
    reasoning: '', retries: 0, error: '', source: 'model', model: 'test',
  });
  const s = active();

  /* ① 纯文字答复（无工具调用）：历史上 .tools.hidden 把整段正文藏了 */
  s.messages.push(mk('这是纯文字答复，用户必须看得见', []));
  renderChat();
  await sleep(140);
  let node = document.querySelector('.msg.assistant:last-child');
  let box = node.querySelector('.tools');
  let proses = [...node.querySelectorAll('.prose')];
  let prose = proses[proses.length - 1];
  let v = vis(prose);
  add('纯文字答复肉眼可见', v.ok && prose.textContent.includes('纯文字答复'),
    JSON.stringify({ cls: box.className, ...v, text: prose.textContent.slice(0, 24) }));

  /* ② 工具列表被折叠时，正文仍然可见（autoCollapseTools 不再连正文一起收起） */
  s.messages.push(mk('这是带工具回复的说明文字', [
    { id: 't1', verb: '读取', target: 'a.txt', meta: '完成', status: 'ok', result: 'ok', bodyAtStart: 0 },
  ]));
  renderChat();
  await sleep(140);
  node = document.querySelector('.msg.assistant:last-child');
  box = node.querySelector('.tools');
  box.classList.add('hidden');
  await sleep(240); // 等折叠过渡结束再看真实计算样式
  proses = [...node.querySelectorAll('.prose')];
  prose = proses[proses.length - 1];
  v = vis(prose);
  add('工具折叠后正文仍可见', v.ok && prose.textContent.includes('带工具回复'),
    JSON.stringify({ cls: box.className, ...v, text: prose.textContent.slice(0, 24) }));

  /* ③ 输入框常驻：默认视图、生成中、设置页覆盖层三种状态 */
  const areaVis = () => vis($('.composer-area'));
  const inputVis = () => vis($('#input'));
  add('默认视图输入框常驻可见', areaVis().ok && inputVis().ok,
    JSON.stringify({ area: areaVis(), input: inputVis() }));

  updateSendState();
  add('生成中（按钮切换 stop 后）输入框仍在', areaVis().ok && inputVis().ok,
    JSON.stringify({ area: areaVis().why }));

  openSettings('connect');
  await sleep(160);
  const docked = vis($('.composer-area'));
  add('设置页打开时输入框以 dock 常驻',
    docked.ok && $('.composer-area').parentNode === document.body && document.body.classList.contains('page-open'),
    JSON.stringify({ ...docked, parent: $('.composer-area').parentNode?.tagName }));
  closeSettings();
  await sleep(520);
  add('关闭设置页后输入框回到对话主区',
    $('.composer-area').parentNode?.classList?.contains('main') && areaVis().ok,
    JSON.stringify({ parent: $('.composer-area').parentNode?.className, ...areaVis() }));

  /* ④ 输入区控制：思考强度、模型入口都在，且改了立即写进连接配置 */
  const effortSel = $('#composerEffort');
  const modelBtn = $('#composerModelBtn');
  add('输入区有思考强度与模型入口', !!effortSel && !!modelBtn && !!$('#composerModelName'),
    JSON.stringify({ effort: !!effortSel, model: !!modelBtn }));
  add('输入区模型名跟随当前模型', ($('#composerModelName')?.textContent || '') === currentModel(),
    $('#composerModelName')?.textContent || '');

  if (effortSel) {
    effortSel.value = 'high';
    effortSel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(60);
    add('输入区改思考强度立即写入连接', state.connection.api.effort === 'high',
      String(state.connection.api.effort));
    add('设置页同源控件同步', $('#apiEffort')?.value === 'high', String($('#apiEffort')?.value));
    add('apiCfg 取到同一档位（下一条请求生效）', apiCfg().effort === 'high', String(apiCfg().effort));
    effortSel.value = 'off';
    effortSel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(60);
    add('思考强度可改回关闭', state.connection.api.effort === 'off', String(state.connection.api.effort));
  }

  if (modelBtn) {
    modelBtn.click();
    await sleep(120);
    add('输入区模型入口打开模型列表', !$('#modelSheet')?.hidden, String(!$('#modelSheet')?.hidden));
    closeSheets();
    await sleep(80);
  }

  /* ⑤ 事件分发异常不会把回合挂在思考中：收尾函数仍可用 */
  add('回合收尾函数可用', typeof finish === 'function' && typeof finalTurnAnswer === 'function', 'ok');

  out.total = out.checks.length;
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.total - out.passed;
  return out;
})();
