/* 「思考强度按钮可点 + 可见状态反馈」与「/goal 对齐 ZCode」定向回归探针。
   经 main.js 的 --script 通道在渲染进程执行，返回值以 [script] JSON 输出。
   断言以状态与真实计算样式/DOM 为准，不依赖截图。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [] };
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
  const EFFORT_TEXT = { off: '关闭', low: '低', medium: '中', high: '高' };
  const s = active();

  // 保存现场，跑完恢复，避免污染同一 user-data-dir 的后续探针
  const snapshot = {
    goal: s.goal, goalStatus: s.goalStatus,
    effort: state.connection?.api?.effort,
  };

  /* 捕获 toast 文案：app.js 是普通 script，全局函数声明可临时替换 */
  const origToast = window.toast;
  let captured = [];
  const patchOk = typeof origToast === 'function';
  if (patchOk) window.toast = (t) => { captured.push(String(t)); };
  const lastToast = () => captured[captured.length - 1] || $('#toast')?.textContent || '';
  const runGoal = async (cmd) => { captured = []; handleCommand(cmd); await sleep(20); return lastToast(); };

  /* ───────── A. 思考强度点击链路 ───────── */
  const wrap = $('#composerEffortWrap');
  const sel = $('#composerEffort');
  const wr = wrap?.getBoundingClientRect();
  const sr = sel?.getBoundingClientRect();
  const cs = sel ? getComputedStyle(sel) : null;
  const hitAt = (x, y) => document.elementFromPoint(x, y);

  add('控件不再是 label[for] 嵌套 select', wrap?.tagName === 'DIV' && !wrap?.getAttribute('for')
    && sel?.parentElement === wrap, `wrap=${wrap?.tagName} for=${wrap?.getAttribute('for')}`);
  add('select 透明铺满整个胶囊（可点面积）',
    !!wr && !!sr && sr.width > 100 && Math.abs(sr.width - wr.width) < 4 && Math.abs(sr.height - wr.height) < 4,
    `wrap=${Math.round(wr?.width || 0)}x${Math.round(wr?.height || 0)} select=${Math.round(sr?.width || 0)}x${Math.round(sr?.height || 0)}`);
  add('select 可交互且视觉透明', cs?.pointerEvents === 'auto' && Number(cs?.opacity) === 0,
    `pointerEvents=${cs?.pointerEvents} opacity=${cs?.opacity}`);

  const span = wrap?.querySelector('span');
  const spr = span?.getBoundingClientRect();
  const hitSpan = spr ? hitAt(spr.left + spr.width / 2, spr.top + spr.height / 2) : null;
  add('点击「思考强度」文字命中 select（能展开下拉）', hitSpan === sel,
    `hit=${hitSpan?.tagName}#${hitSpan?.id}`);
  const hitLeft = wr ? hitAt(wr.left + 6, wr.top + wr.height / 2) : null;
  const hitRight = wr ? hitAt(wr.right - 6, wr.top + wr.height / 2) : null;
  add('点击图标/箭头两端也命中 select', hitLeft === sel && hitRight === sel,
    `left=${hitLeft?.tagName}#${hitLeft?.id} right=${hitRight?.tagName}#${hitRight?.id}`);

  const effort0 = normEffort(state.connection?.api?.effort);
  add('常显当前档位文字与高亮状态',
    $('#composerEffortName')?.textContent === EFFORT_TEXT[effort0]
    && wrap?.classList.contains('is-on') === (effort0 !== 'off'),
    `text=${$('#composerEffortName')?.textContent} isOn=${wrap?.classList.contains('is-on')} effort=${effort0}`);

  if (sel) {
    captured = [];
    sel.value = 'high';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(60);
    add('选择档位后按原有设计生效（连接/设置页/apiCfg）',
      state.connection.api.effort === 'high' && $('#apiEffort')?.value === 'high' && apiCfg().effort === 'high',
      `conn=${state.connection.api.effort} form=${$('#apiEffort')?.value} cfg=${apiCfg().effort}`);
    add('选择档位后有可见反馈（文字/高亮/提示）',
      $('#composerEffortName')?.textContent === '高' && wrap?.classList.contains('is-on')
      && lastToast().includes('思考强度'),
      `text=${$('#composerEffortName')?.textContent} isOn=${wrap?.classList.contains('is-on')} toast=${lastToast().slice(0, 40)}`);
    captured = [];
    sel.value = 'off';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(60);
    add('改回关闭时状态同步复位',
      $('#composerEffortName')?.textContent === '关闭' && !wrap?.classList.contains('is-on')
      && state.connection.api.effort === 'off',
      `text=${$('#composerEffortName')?.textContent} isOn=${wrap?.classList.contains('is-on')}`);
  }

  /* ───────── B. /goal 对齐 ZCode ───────── */
  const goalSys = () => {
    try {
      return buildApiMessages(s, '测试', {}, false)
        .filter((m) => m.role === 'system' && String(m.content).includes('本会话目标'));
    } catch (e) { return [{ content: 'ERROR:' + e.message }]; }
  };
  const goalLine = () => ({ text: $('#goalLine')?.textContent || '', hidden: $('#goalLine')?.hidden });

  // 干净起点
  s.goal = ''; s.goalStatus = 'active'; renderHeader();

  let t = await runGoal('/goal');
  add('无目标时 /goal 查看给用法提示', !s.goal && /还没有设置目标/.test(t), t.slice(0, 60));

  t = await runGoal('/goal 完成登录模块');
  add('/goal 设置目标', s.goal === '完成登录模块' && s.goalStatus === 'active', `${s.goal} / ${s.goalStatus}`);
  add('目标在头部可见', !goalLine().hidden && goalLine().text.includes('完成登录模块'), JSON.stringify(goalLine()));
  add('active 目标注入每轮 system 消息', goalSys().length === 1 && goalSys()[0].content.includes('完成登录模块'),
    JSON.stringify(goalSys().map((m) => m.content.slice(0, 40))));

  t = await runGoal('/goal 换成支付模块');
  add('已有目标首次 /goal 不静默覆盖（需确认）', s.goal === '完成登录模块' && /确认替换/.test(t), `${s.goal} | ${t.slice(0, 50)}`);
  t = await runGoal('/goal 换成支付模块');
  add('5 秒内重复同一条 /goal 完成替换', s.goal === '换成支付模块', s.goal);
  await runGoal('/goal 换成支付模块'); // 重新武装后清掉，避免影响后续
  s.goal = '换成支付模块'; s.goalStatus = 'active'; clearGoalReplaceArm(); renderHeader();

  t = await runGoal('/goal replace');
  add('/goal replace 空参数给用法且不改目标', s.goal === '换成支付模块' && /用法/.test(t), `${s.goal} | ${t.slice(0, 40)}`);
  t = await runGoal('/goal replace 重构缓存');
  add('/goal replace 强制替换', s.goal === '重构缓存', s.goal);

  t = await runGoal('/goal show');
  add('/goal show 只查看不改目标', s.goal === '重构缓存' && /当前目标/.test(t), t.slice(0, 50));

  t = await runGoal('/goal pause');
  add('/goal pause 切换为 paused', s.goalStatus === 'paused' && /暂停/.test(t), `${s.goalStatus} | ${t.slice(0, 30)}`);
  add('暂停状态在头部可见', goalLine().text.includes('已暂停'), goalLine().text);
  add('paused 目标不再注入（对齐 ZCode 且省 token）', goalSys().length === 0,
    JSON.stringify(goalSys().map((m) => m.content.slice(0, 40))));

  t = await runGoal('/goal resume');
  add('/goal resume 恢复 active', s.goalStatus === 'active' && goalSys().length === 1, `${s.goalStatus} | sys=${goalSys().length}`);

  t = await runGoal('/goal clear');
  add('/goal clear 清除目标并隐藏头部', !s.goal && goalLine().hidden && goalSys().length === 0, JSON.stringify(goalLine()));
  t = await runGoal('/goal clear');
  add('重复 /goal clear 安全提示', !s.goal && /无需清除/.test(t), t.slice(0, 40));
  t = await runGoal('/goal pause');
  add('无目标时 pause 不产生目标', !s.goal && s.goalStatus === 'active', `${s.goal} / ${s.goalStatus}`);

  t = await runGoal('/target 通过别名设置');
  add('/target 别名生效', s.goal === '通过别名设置', s.goal);

  // 下面几条都是「设置」语义：已有目标会正确进入确认替换分支，先清空才能一次命中
  await runGoal('/goal clear');
  t = await runGoal('/target 含  双空格  目标');
  add('目标原文保留内部空格（不做 split/join 改写）', s.goal === '含  双空格  目标', s.goal);

  await runGoal('/goal clear');
  const long = '目'.repeat(520);
  await runGoal('/goal ' + long);
  add('超长目标截断到 500 字', s.goal.length === 500, String(s.goal.length));

  await runGoal('/goal clear');
  // 真实输入入口：往 textarea 填命令再走 send()
  const ta = $('#input');
  if (ta) {
    ta.value = '/target 从输入框设置';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    try { send(); } catch (e) { add('真实输入入口 /target', false, e.message); }
    await sleep(40);
    add('真实输入入口 /target 同样生效', s.goal === '从输入框设置', s.goal);
  }

  const cmds = Array.from(document.querySelectorAll('#slashMenu .menu-item')).map((m) => m.dataset.cmd);
  add('斜杠菜单列出 /goal 与 /target', cmds.includes('/goal') && cmds.includes('/target'), cmds.join(','));
  add('命令帮助与分发含 /target 别名',
    String(handleCommand).includes('/target') && String(handleCommand).includes('case \'/target\''), 'ok');
  add('每轮注入逻辑带状态判断',
    String(buildApiMessages).includes("goalStatus !== 'paused'"), 'ok');

  /* 恢复现场 */
  if (patchOk) window.toast = origToast;
  s.goal = snapshot.goal; s.goalStatus = snapshot.goalStatus;
  clearGoalReplaceArm();
  if (snapshot.effort !== undefined && sel) {
    sel.value = snapshot.effort;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  renderHeader();
  await sleep(20);

  out.total = out.checks.length;
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.total - out.passed;
  return out;
})();
