/* G4 渲染检查：Doctor 体检（10 项 HealthCheck + scoreProfile 分支）/ Statusline 文本 /
   Pair 协作模式注入 / 任务清单三态循环 + blocked。经 main.js 的 --script 通道在渲染进程执行，
   返回值以 [script] JSON 输出。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail) }); return ok; };
  state.probeBusy = true; // 挡住启动期静默探活

  try {
    /* ───────── ② Statusline（先造数据，避免依赖网络） ───────── */
    const s = active();
    s.messages = [{
      role: 'user', text: '写个快排',
    }, {
      role: 'assistant', body: '好的。',
      startedAt: Date.now() - 12300, finishedAt: Date.now(),
      usage: { prompt_tokens: 900, completion_tokens: 340 },
      summary: { label: '已完成', tools: 0, messages: 1 },
      tools: [], files: [], approval: null, metrics: '',
    }];
    state.agents = [{ id: 'a1', status: 'active', name: 'A1' }, { id: 'a2', status: 'active', name: 'A2' }, { id: 'a3', status: 'idle', name: 'A3' }];
    updateStatusline();
    const slText = $('#statusline')?.textContent || '';
    check('statusline.hasModel', slText.includes(currentModel()), slText);
    check('statusline.ctxPct', /上下文 \d+%/.test(slText), slText);
    check('statusline.agents', slText.includes('智能体 2 活动'), slText);
    check('statusline.tokDur', /1,240 tok \/ 12\.3s/.test(slText), slText);
    // 事件驱动入口：scheduleStatusline 150ms 后不抛错且仍可刷新
    scheduleStatusline();
    await sleep(220);
    check('statusline.debouncedOk', !!($('#statusline')?.textContent || ''), $('#statusline')?.textContent?.slice(0, 30));

    /* ───────── ③ Pair 协作模式 ───────── */
    check('pair.promptTable', ['tdd', 'review', 'mentor'].every((k) => typeof PAIR_PROMPTS[k] === 'string' && PAIR_PROMPTS[k].length > 40),
      Object.keys(PAIR_PROMPTS).join(','));
    const pairSession = { id: 'pair-test', goal: '', messages: [], state: 'idle' };
    const sysTexts = (mode) => {
      pairMode = mode;
      return buildApiMessages(pairSession, '你好', null, null)
        .filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    };
    check('pair.noneNoInject', !sysTexts('none').includes('协作模式'), '');
    check('pair.tddInject', sysTexts('tdd').includes('协作模式「结对(TDD)」约束'), '');
    check('pair.reviewInject', sysTexts('review').includes('协作模式「评审」约束'), '');
    check('pair.mentorInject', sysTexts('mentor').includes('协作模式「导师」约束'), '');
    pairMode = 'none';

    // UI：切 tdd 后 seg 选中 + 徽标显示 + localStorage 持久化
    setPairMode('tdd');
    await sleep(30);
    check('pair.segActive', $('#pairSeg [data-pair="tdd"]')?.classList.contains('is-active'), '');
    check('pair.badgeShown', !$('#pairBadge').hidden && $('#pairBadge').textContent === '结对(TDD)', $('#pairBadge')?.textContent);
    check('pair.persisted', readStorage('dsh.pairMode', '') === 'tdd', readStorage('dsh.pairMode', ''));
    setPairMode('none');
    check('pair.badgeHiddenOnNone', $('#pairBadge').hidden, '');

    /* ───────── ④ 任务清单三态 + blocked ───────── */
    s.todoTasks = [{ content: '实现快排', status: 'pending' }];
    renderTodoPanel();
    const statusOf = () => active().todoTasks[0].status;
    const dotClass = () => $('#todoPanelBody .todo-item[data-idx="0"] .todo-dot')?.className || '';
    check('todo.initPending', statusOf() === 'pending', '');
    cycleTodoStatus(0);
    check('todo.cycleInProgress', statusOf() === 'in_progress' && dotClass().includes('in_progress'), statusOf());
    cycleTodoStatus(0);
    check('todo.cycleVerifying', statusOf() === 'verifying' && dotClass().includes('verifying'), statusOf());
    cycleTodoStatus(0);
    check('todo.cycleCompleted', statusOf() === 'completed' && dotClass().includes('completed'), statusOf());
    cycleTodoStatus(0);
    check('todo.cycleBackPending', statusOf() === 'pending', statusOf());
    // blocked：独立设入 / 解除（解除回到阻塞前状态 verifying）
    active().todoTasks[0].status = 'verifying';
    toggleTodoBlocked(0);
    check('todo.blockSet', statusOf() === 'blocked' && dotClass().includes('blocked'), statusOf());
    check('todo.blockBtnLabel', $('#todoPanelBody [data-todo-block="0"]')?.textContent === '解除', $('#todoPanelBody [data-todo-block="0"]')?.textContent);
    toggleTodoBlocked(0);
    check('todo.blockRelease', statusOf() === 'verifying', statusOf());

    /* ───────── ① Doctor 体检 ───────── */
    // scoreProfile 纯函数分支：全空 0 分 / 全满 100 分 / 各单项
    const zero = scoreProfile({});
    check('doctor.scoreZero', zero.score === 0, JSON.stringify(zero));
    const full = scoreProfile({ baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini', hasKey: true, name: '主力', lastProbeOk: true });
    check('doctor.scoreFull', full.score === 100, JSON.stringify(full.score));
    const partBase = scoreProfile({ baseUrl: 'https://x.com', model: 'gpt-4o' });
    check('doctor.scoreBase40Model20', partBase.score === 60, JSON.stringify(partBase.score));
    check('doctor.scoreDefaultName', scoreProfile({ baseUrl: 'https://x.com', model: 'gpt-4o', name: '连接' }).score === 60, '默认名「连接」不给分');
    check('doctor.scoreMaskedKeyNo', scoreProfile({ baseUrl: 'https://x.com', model: 'gpt-4o', key: 'sk-****abcd', hasKey: false }).score === 60, '掩码 key 不算已保管');

    // 真跑一轮体检：10 项、HealthCheck 形状、状态枚举
    await runDoctorChecks(true);
    await sleep(50);
    const checks = doctorCache?.checks || [];
    check('doctor.tenChecks', checks.length === 10, checks.length);
    check('doctor.shape', checks.every((c) => c && typeof c.name === 'string' && ['pass', 'warn', 'fail', 'skip'].includes(c.status) && typeof c.detail === 'string'),
      checks.map((c) => `${c.name}:${c.status}`).join(' '));
    check('doctor.failHaveFix', checks.filter((c) => c.status === 'fail' || c.status === 'warn').every((c) => typeof c.fix === 'string' && c.fix.length > 0),
      checks.filter((c) => c.fix).length);
    check('doctor.rendered', $$('#doctorList .doctor-item').length === 10, $$('#doctorList .doctor-item').length);
    check('doctor.scoresRendered', $$('#doctorScores .doctor-item.is-score').length >= 1, $$('#doctorScores .doctor-item.is-score').length);

    // 设置页导航：doctor 是第 9 个 pane
    check('doctor.navCount9', document.querySelectorAll('#settingsNav [data-sp]').length === 9,
      document.querySelectorAll('#settingsNav [data-sp]').length);
    openSettings('doctor');
    await sleep(240);
    check('doctor.paneVisible', !$('#paneDoctor')?.hidden && $('#paneDoctor').offsetParent !== null, '');
    check('doctor.cacheReused', doctorCache !== null, 'pane 级缓存已建');
  } catch (err) {
    check('probe.noThrow', false, err?.message || String(err));
  }
  return { pass: results.filter((r) => r.ok).length, total: results.length, results };
})();
