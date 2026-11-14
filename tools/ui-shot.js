(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (sourceOf() !== 'model') switchSource('model');
  const s = active();
  s.title = '任务清单展示';
  s.state = 'idle';
  s.messages = [
    { role: 'user', text: '帮我把这个月的花销整理成表，并生成趋势图。' },
    {
      role: 'assistant',
      summary: { label: '已完成', tools: 3, messages: 1 },
      tasks: [
        { content: '读取账单-10月.csv', status: 'completed' },
        { content: '按类别汇总并生成图表', status: 'completed' },
        { content: '写出汇总文件', status: 'in_progress' },
      ],
      tools: [
        { id: 't1', name: 'read_file', verb: '读取', icon: 'i-read', tone: 'read', target: '账单-10月.csv', status: 'ok', meta: '218 行', args: { path: '账单-10月.csv' }, result: '（218 行）', expanded: false },
        { id: 't2', name: 'run_command', verb: '运行', icon: 'i-terminal', tone: 'terminal', target: 'python3 summarize.py', status: 'ok', meta: '0:05', args: { command: 'python3 summarize.py' }, result: '退出码 0', expanded: false },
        { id: 't3', name: 'write_file', verb: '写入', icon: 'i-code', tone: 'edit', target: '本月汇总.xlsx', status: 'ok', meta: '已写入', args: { path: '本月汇总.xlsx' }, result: '已写入', expanded: false },
      ],
      body: '正在生成最后的工作表…',
      files: [],
      approval: null,
      metrics: '12 秒 · 3 次工具',
      startedAt: Date.now() - 12000,
      finishedAt: Date.now(),
    },
  ];
  renderHeader();
  renderSessions();
  renderChat();
  await sleep(400);
  return { ok: true, tasks: 3 };
})();
