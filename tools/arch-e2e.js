(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [] };
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
  const waitUntil = async (fn, ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try { if (fn()) return true; } catch { /* DOM 可能尚未挂载 */ }
      await sleep(100);
    }
    return false;
  };
  const lastAssistant = () => active().messages.filter((m) => m.role === 'assistant').at(-1);
  const runTurnAndWait = async (text, ms = 40000) => {
    runTurn(text);
    await waitUntil(() => state.busy === true, 3000);
    return waitUntil(() => state.busy === false, ms);
  };

  const MOCK = 'http://127.0.0.1:57321/v1';
  await waitUntil(() => state.toolsReady, 6000);

  const base = await window.dsh.tools.defaultWorkspace();
  const ws = String(base).replace(/[\\/]+$/, '') + '\\dsh-arch-e2e-' + Date.now();
  const pkg = {
    name: 'e2e-game',
    description: 'E2E 像素塔防游戏',
    dependencies: { phaser: '^3.80.0' },
    devDependencies: { typescript: '^5.6.0' },
  };
  await window.dsh.tools.exec('write_file', { path: 'package.json', content: JSON.stringify(pkg, null, 2) }, { workspace: ws, permission: 'full' });
  await window.dsh.tools.exec('write_file', { path: 'README.md', content: '# E2E Game\n像素风塔防游戏。\n' }, { workspace: ws, permission: 'full' });
  state.workspace = ws;
  writeStorage('dsh.workspace', ws);
  state.project = null;
  state.projectWorkspace = '';
  renderToolsSetting();

  state.connection = { source: 'model', api: { baseUrl: MOCK, key: 'test-key', model: 'mock-tool-model' }, verified: false };
  if (sourceOf() !== 'model') switchSource('model');
  newChat();

  /* 1. 入口与空状态 */
  add('顶栏有项目架构入口', !!document.querySelector('#archBtn'), '#archBtn');
  add('设置页有项目架构入口', !!document.querySelector('#openArch'), '#openArch');
  add('命令面板包含 /arch', !!document.querySelector('#slashMenu [data-cmd="/arch"]'), '/arch');
  await openArchPage();
  const emptyOk = await waitUntil(() => !document.querySelector('#archPage').hidden && !!document.querySelector('#archCanvas .arch-empty-state'), 12000);
  add('架构页可打开并显示空状态', emptyOk, emptyOk ? 'ok' : document.querySelector('#archCanvas')?.textContent?.slice(0, 60));
  add('空状态展示工作区发现', String(document.querySelector('.arch-empty-state')?.textContent || '').includes('Node.js')
    && String(document.querySelector('.arch-empty-state')?.textContent || '').includes('package.json'), document.querySelector('.arch-empty-state')?.textContent?.slice(0, 100));
  add('空状态引导回到聊天框', !!document.querySelector('.arch-empty-state [data-arch-chat]'), 'ok');
  add('主控 Agent 卡片已渲染', String(document.querySelector('#archMainAgent')?.textContent || '').includes('主控'), document.querySelector('#archMainAgent')?.textContent?.slice(0, 40));
  document.querySelector('#archBack').click();
  add('架构页可返回对话', document.querySelector('#archPage').hidden === true, 'hidden');

  /* 2. 主 Agent 通过工具提交架构 */
  const okTurn = await runTurnAndWait('[[arch]] 请为游戏项目规划整体架构');
  const msg = lastAssistant();
  const archTool = (msg?.tools || []).find((t) => t.name === 'project_architecture');
  add('模型成功调用项目架构工具', okTurn && !!archTool && archTool.status === 'ok', archTool?.meta || '未调用');
  const projectLoaded = await waitUntil(() => (state.project?.project?.nodes || []).length === 8, 8000);
  const proj = state.project?.project;
  add('架构写入 Runtime 并同步到渲染层', projectLoaded && proj?.name === 'e2e-game' && proj?.mainAgentId === state.defaultAgentId,
    `${proj?.name} · ${proj?.nodes?.length} 节点 · ${proj?.edges?.length} 依赖`);
  add('主 Agent 收到架构工具结果', String(msg?.body || '').includes('已收到工具结果') && String(archTool?.result || '').includes('revision'), String(msg?.body || '').slice(0, 80));

  /* 3. 架构页图形与侧栏 */
  document.querySelector('#archBtn').click();
  const pageOk = await waitUntil(() => !document.querySelector('#archPage').hidden && document.querySelectorAll('#archCanvas .arch-svg-node').length === 8, 12000);
  add('架构页渲染 8 个模块节点', pageOk, document.querySelectorAll('#archCanvas .arch-svg-node').length);
  const svg = document.querySelector('#archCanvas .arch-svg');
  add('SVG 架构图带无障碍描述', !!svg && svg.getAttribute('role') === 'img' && !!svg.getAttribute('aria-label'), svg?.getAttribute('aria-label'));
  const svgText = svg?.textContent || '';
  add('架构图包含分层与依赖', ['体验层', '领域层', '平台层', '数据层', '外部系统', '游戏主循环', '渲染层'].every((s) => svgText.includes(s)), svgText.slice(0, 100));
  add('标题与主控 Agent 正确', document.querySelector('#archTitle').textContent === 'e2e-game'
    && String(document.querySelector('#archSubtitle').textContent).includes('revision'), document.querySelector('#archSubtitle').textContent.slice(0, 80));
  add('统计显示 8 模块 / 7 依赖', document.querySelector('#archStats .arch-stats').textContent.replace(/\s+/g, '') === '8模块7依赖0进行中0已完成0受阻0关联任务', document.querySelector('#archStats .arch-stats').textContent.replace(/\s+/g, ''));
  add('里程碑与目标已展示', document.querySelectorAll('#archMilestones .arch-mile').length === 2
    && String(document.querySelector('#archGoal').value).includes('像素风塔防'), document.querySelectorAll('#archMilestones .arch-mile').length);
  add('工作区发现包含技术栈', String(document.querySelector('#archDiscovery').textContent).includes('Phaser')
    && String(document.querySelector('#archDiscovery').textContent).includes('package.json'), document.querySelector('#archDiscovery').textContent.slice(0, 80));
  add('关联任务列表已有本轮任务', document.querySelectorAll('#archTasks .arch-task').length >= 1, document.querySelectorAll('#archTasks .arch-task').length);

  /* 4. 节点详情 */
  const loopNode = document.querySelector('#archCanvas [data-arch-node="game-loop"]');
  add('节点可聚焦并带 aria-label', !!loopNode && loopNode.getAttribute('tabindex') === '0' && String(loopNode.getAttribute('aria-label')).includes('游戏主循环'), loopNode?.getAttribute('aria-label'));
  loopNode.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const detailOk = await waitUntil(() => !document.querySelector('#archDetail').hidden, 3000);
  const detailText = document.querySelector('#archDetail').textContent;
  add('点击节点展示详情', detailOk && detailText.includes('src/game') && detailText.includes('固定步长'), detailText.slice(0, 100));
  document.querySelector('#archDetail [data-arch-detail-close]').click();
  add('节点详情可关闭', document.querySelector('#archDetail').hidden === true, 'hidden');

  /* 5. 实时状态：手动关联运行中任务，事件驱动架构页刷新 */
  const created = await window.dsh.runtime.tasks.create({
    title: '实时架构验证',
    input: '把游戏主循环关联到运行中任务',
    workspace: ws,
    agentId: state.project.project.mainAgentId,
    providerId: MOCK,
    model: 'mock-tool-model',
  });
  add('主 Agent 任务绑定当前主控', created?.ok && created.data.task.agentId === state.project.project.mainAgentId, created?.data?.task?.agentId);
  const runId = created.data.run.id;
  const step = await window.dsh.runtime.runs.beginStep({ runId, kind: 'tool_call' });
  const prop = await window.dsh.runtime.tools.propose({
    runId,
    stepId: step.data.step.id,
    name: 'project_architecture',
    args: { nodes: [{ id: 'game-loop', label: '游戏主循环', taskId: created.data.task.id }] },
    profile: 'full',
  });
  const exec = prop?.ok ? await window.dsh.runtime.tools.execute({ toolCallId: prop.data.toolCallId, profile: 'full' }) : null;
  await window.dsh.runtime.runs.finishStep({ stepId: step.data.step.id, status: exec?.ok ? 'succeeded' : 'failed' });
  add('运行中任务可关联到模块', prop?.data?.status === 'ready' && exec?.data?.ok === true, exec?.data?.code || prop?.data?.status);

  const liveOk = await waitUntil(() => {
    const g = document.querySelector('#archCanvas [data-arch-node="game-loop"]');
    return g && g.textContent.includes('进行中');
  }, 6000);
  add('架构页实时显示进行中', liveOk, document.querySelector('#archCanvas [data-arch-node="game-loop"]')?.textContent || '');
  add('实时节点有脉冲标记', !!document.querySelector('#archCanvas .arch-svg-node.is-live .arch-live-dot'), 'ok');
  add('节点关联后保留职责与路径', String(loopNode?.textContent || '').length > 0 && (state.project.live.nodes.find((n) => n.id === 'game-loop')?.description || '').includes('固定步长'), state.project.live.nodes.find((n) => n.id === 'game-loop')?.description);
  add('统计显示 1 个进行中', String(document.querySelector('#archStats .arch-stats').textContent).includes('1进行中'), document.querySelector('#archStats .arch-stats').textContent.replace(/\s+/g, ''));

  const finished = await window.dsh.runtime.runs.finish({ runId, outcome: 'succeeded', summary: '实时验证完成' });
  add('任务收尾成功', finished?.ok && finished.data.run.status === 'succeeded', finished?.data?.run?.status);
  const doneOk = await waitUntil(() => {
    const g = document.querySelector('#archCanvas [data-arch-node="game-loop"]');
    return g && g.textContent.includes('已完成');
  }, 8000);
  add('任务结束后架构页自动变为已完成', doneOk, document.querySelector('#archCanvas [data-arch-node="game-loop"]')?.textContent || '');

  /* 6. 导出与规划提示 */
  let download = '';
  let blobText = '';
  const origClick = HTMLAnchorElement.prototype.click;
  const origCreate = URL.createObjectURL;
  HTMLAnchorElement.prototype.click = function () { download = this.download; };
  URL.createObjectURL = function (blob) { blobText = blob; return origCreate.call(URL, blob); };
  exportArchSvg();
  HTMLAnchorElement.prototype.click = origClick;
  URL.createObjectURL = origCreate;
  const exported = blobText ? await blobText.text() : '';
  add('导出 SVG 触发下载', /架构图\.svg$/.test(download), download);
  add('导出内容为自包含 SVG', exported.startsWith('<?xml') && exported.includes('<svg') && exported.includes('游戏主循环'), exported.slice(0, 60));

  const independentPlan = document.querySelector('#archPlan') || document.querySelector('[data-arch-plan]');
  add('架构页不再提供独立规划入口', !independentPlan, independentPlan ? '仍存在规划按钮' : '聊天框统一规划');
  const sysText = buildApiMessages(active(), '测试', null, null).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  add('主 Agent 系统提示注入项目架构', sysText.includes('主控 Agent') && sysText.includes('project_architecture')
    && sysText.includes('体验层') && sysText.includes('游戏主循环'), sysText.slice(-200));
  const chatTask = msg?.runtime?.taskId ? await window.dsh.runtime.tasks.get(msg.runtime.taskId) : null;
  add('对话任务以主控 Agent 身份运行', chatTask?.ok && chatTask.data.task.agentId === state.project.project.mainAgentId,
    chatTask?.data?.task?.agentId);

  const cleaned = await window.dsh.tools.exec('run_command', { command: `rmdir /s /q "${ws}"` }, { workspace: base, permission: 'full' });
  add('测试目录已清理', cleaned?.ok === true, cleaned?.code || 'ok');

  /* 页面保持打开用于截图 */
  const passed = out.checks.filter((c) => c.pass).length;
  out.total = out.checks.length;
  out.passed = passed;
  out.failed = out.checks.length - passed;
  return out;
})()
