(async () => { console.log('[trace] e2e script started');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [] };
  const add = (name, pass, detail) => { out.checks.push({ name, pass: !!pass, detail: String(detail ?? '') }); void window.dsh.tools.exec('write_file', { path: 'e2e-trace.txt', content: '[mark] ' + name }, { permission: 'full' }).catch((e) => console.error('[trace-beacon-err]', e?.message || String(e))); };
  const waitUntil = async (fn, ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try { if (fn()) return true; } catch { /* 节点可能还没挂上 */ }
      await sleep(100);
    }
    return false;
  };

  const MOCK = 'http://127.0.0.1:57321/v1';
  const prevConnRaw = localStorage.getItem('dsh.conn');
  const prevConn = JSON.parse(JSON.stringify(state.connection));
  const prevWsRaw = localStorage.getItem('dsh.workspace');
  const prevProfilesRaw = localStorage.getItem('dsh.apis');
  const prevWorkspace = state.workspace;
  const prevPermission = state.permission;

  const assistantMsgs = () => active().messages.filter((m) => m.role === 'assistant');
  const lastAssistant = () => assistantMsgs().at(-1);
  const lastNode = () => {
    const m = lastAssistant();
    return m ? document.querySelector(`.msg.assistant[data-msg-id="${m.id}"]`) : null;
  };
  const runTurnAndWait = async (text, ms = 40000) => {
    runTurn(text);
    await waitUntil(() => state.busy === true, 3000);
    return waitUntil(() => state.busy === false, ms);
  };
  const approvalBtn = (kind) => {
    const node = lastNode();
    return node ? node.querySelector(`.approval-actions [data-approve="${kind}"]`) : null;
  };

  /* ── 1. 启动即加载工具定义 / 工作目录 ── */
  await waitUntil(() => state.toolsReady, 5000);
  add('启动后工具定义已加载', state.toolsReady === true, `specs=${state.toolSpecs.length}`);
  add('工具列表包含任务清单工具', state.toolSpecs.some((s) => s.function?.name === 'todo_write'), state.toolSpecs.map((s) => s.function?.name).join(','));
  const fine = document.querySelector('#toolsFine').textContent;
  add('工具设置区不再停在加载中', !fine.includes('加载中') && fine.includes('list_dir'), fine.slice(0, 80));
  add('默认工作目录已解析', !!state.workspace && document.querySelector('#workspacePath').textContent === state.workspace, state.workspace);
  add('工具区没有启用开关（始终开启）', !document.querySelector('#toolsToggle') && !document.querySelector('.tool-cfg'), '无开关');

  /* ── 2. 指向 mock 网关，建临时工作目录 ── */
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

  /* ── 3. 完全权限：模型下发工具 → 执行 → 结果回灌 → 继续输出 ── */
  const okA = await runTurnAndWait('[[write]] 请写入测试文件');
  const a = lastAssistant();
  add('请求确实带上 tools 并触发工具调用', okA && a.tools.length === 1, JSON.stringify((a.tools || []).map((t) => t.name)));
  add('工具执行成功（full 自动放行）', a.tools[0]?.status === 'ok', a.tools[0]?.result?.slice(0, 60));
  add('工具结果回灌后模型继续输出', String(a.body).includes('已收到工具结果'), String(a.body).slice(0, 90));
  const readBack = await window.dsh.tools.exec('read_file', { path: 'dsh-tool-e2e.txt' }, { workspace: ws, permission: 'readonly' });
  add('写文件真实落盘且内容正确', readBack.ok === true && String(readBack.content).includes('tool-call-ok'), readBack.ok ? 'ok' : readBack.error);

  /* ── 3.5 任务清单：同一回合内两次 todo_write，卡片跟随更新 ── */
  const okT = await runTurnAndWait('[[todo-update]] 建立并推进任务清单');
  const t = lastAssistant();
  add('单轮内可多次更新任务清单', okT && (t.tools || []).length === 2 && (t.tasks || []).length === 3,
    `tools=${(t.tools || []).length} tasks=${(t.tasks || []).length}`);
  add('最终任务状态全部完成', (t.tasks || []).every((x) => x.status === 'completed'),
    (t.tasks || []).map((x) => x.status).join(','));
  const tNode = lastNode();
  const taskItems = tNode ? tNode.querySelectorAll('.tasks-card .task-item') : [];
  add('任务清单卡片渲染 3 项且无进行中', taskItems.length === 3 && !tNode.querySelector('.task-item.is-in_progress')
    && tNode.querySelectorAll('.task-item.is-completed').length === 3, `items=${taskItems.length}`);
  add('任务卡片进度显示 3/3', !!tNode && tNode.querySelector('.tasks-head span').textContent === '3/3',
    tNode ? tNode.querySelector('.tasks-head span').textContent : '无卡片');

  /* ── 3.6 工具调用次数不设上限 ── */
  const okM = await runTurnAndWait('[[many]] 连续调用 20 次工具', 60000);
  const m = lastAssistant();
  add('工具调用 20 次仍继续（无上限）', okM && (m.tools || []).length === 20, `tools=${(m.tools || []).length}`);
  add('多轮工具后正常收尾', m.summary.label === '已完成' && String(m.body).includes('已收到工具结果'), `label=${m.summary.label}`);

  /* ── 3.7 收尾后置校验：产物被篡改 → 回合标记「校验失败」 ── */
  runTurn('[[tamper]] 写入产物并在收尾时校验');
  await waitUntil(() => state.busy === true, 3000);
  let wrote = false;
  for (let i = 0; i < 80; i++) {
    const r = await window.dsh.tools.exec('read_file', { path: 'dsh-validate-e2e.txt' }, { workspace: ws, permission: 'readonly' });
    if (r.ok) { wrote = true; break; }
    await sleep(100);
  }
  add('校验测试：模型产物已写入', wrote, wrote ? 'ok' : '未写入');
  const forged = await window.dsh.tools.exec('write_file',
    { path: 'dsh-validate-e2e.txt', content: 'tampered-by-e2e' },
    { workspace: ws, permission: 'full' });
  add('校验测试：产物被外部篡改', forged.ok === true, forged.ok ? 'ok' : forged.error);
  const okV = await waitUntil(() => state.busy === false, 40000);
  const vMsg = lastAssistant();
  const labelOk = await waitUntil(() => lastAssistant()?.summary?.label === '校验失败', 6000);
  add('收尾校验失败后回合标记「校验失败」', okV && vMsg?.summary?.label === '校验失败', `label=${vMsg?.summary?.label}`);
  add('校验失败后展示失败明细', labelOk && !!lastNode()?.querySelector('.prose')?.textContent.includes('后置校验未通过'), lastNode()?.querySelector('.prose')?.textContent?.slice(-80));
  const vTask = vMsg?.runtime?.taskId ? await window.dsh.runtime.tasks.get(vMsg.runtime.taskId) : null;
  add('Runtime Task/Run 同步标记 failed', vTask?.ok && vTask.data.task.status === 'failed' && vTask.data.runs[0]?.status === 'failed', JSON.stringify({ task: vTask?.data?.task?.status, run: vTask?.data?.runs?.[0]?.status }));

  /* ── 3.8 Phase 5：委派子 Agent、独立审批、父子 Trace ── */
  add('工具列表包含委派工具', state.toolSpecs.some((s) => s.function?.name === 'delegate_task'), state.toolSpecs.map((s) => s.function?.name).join(','));
  const childAgent = await window.dsh.runtime.agents.create({
    name: 'E2E 研究助手',
    systemPrompt: '你是 E2E 研究助手，按父 Agent 的 objective 工作。',
    permissionProfileId: 'ask',
  });
  add('可创建第二个 Agent', childAgent?.ok && /^agt_/.test(childAgent.data.agent.id), childAgent?.ok ? childAgent.data.agent.id : childAgent?.error?.message);
  if (childAgent?.ok) {
    const childAgentId = childAgent.data.agent.id;
    runTurn(`[[delegate:${childAgentId}]] 请委派一个写文件子任务`);
    await waitUntil(() => state.busy === true, 3000);
    const delegateCard = await waitUntil(() => !!approvalBtn('once'), 12000);
    add('委派前弹出父级审批', delegateCard, delegateCard ? 'ok' : '未出现');
    if (delegateCard) approvalBtn('once').click();
    const childApproval = await waitUntil(() => !!document.querySelector('#delegApprovals [data-deleg-approve="once"]'), 15000);
    add('子 Agent 审批独立展示', childApproval, childApproval ? 'ok' : document.querySelector('#delegApprovals')?.textContent || '未出现');
    const approvalSource = await waitUntil(() => document.querySelector('#delegApprovals')?.textContent.includes('E2E 研究助手'), 3000);
    add('子审批标注来源 Agent', approvalSource, document.querySelector('#delegApprovals')?.textContent?.slice(0, 80));
    if (childApproval) document.querySelector('#delegApprovals [data-deleg-approve="once"]').click();
    const okD = await waitUntil(() => state.busy === false, 60000);
    const dMsg = lastAssistant();
    add('委派工具执行成功', okD && (dMsg.tools || []).some((t) => t.name === 'delegate_task' && t.status === 'ok'), JSON.stringify((dMsg.tools || []).map((t) => `${t.name}:${t.status}`)));
    add('父回合收到子任务摘要', String(dMsg.body).includes('已收到工具结果'), String(dMsg.body).slice(0, 100));
    const delegationFile = await window.dsh.tools.exec('read_file', { path: 'delegated-e2e.txt' }, { workspace: ws, permission: 'readonly' });
    add('子 Agent 产物写入工作区', delegationFile.ok === true && String(delegationFile.content).includes('delegated-ok'), delegationFile.ok ? 'ok' : delegationFile.error);
    const parentTaskId = dMsg.runtime?.taskId || '';
    const delList = parentTaskId ? await window.dsh.runtime.delegations.list({ parentTaskId }) : null;
    add('委派记录持久化且成功', delList?.ok && delList.data.delegations.some((d) => d.status === 'succeeded' && d.parentTaskId === parentTaskId), delList?.ok ? `count=${delList.data.delegations.length}` : 'no-list');
    const parentRunId = dMsg.runtime?.runId || '';
    const graphR = parentRunId ? await window.dsh.runtime.runs.graph({ runId: parentRunId }) : null;
    add('父 Run Graph 含委派节点', graphR?.ok && graphR.data.graph.nodes.some((n) => n.kind === 'delegation' && n.status === 'succeeded'), graphR?.ok ? graphR.data.graph.nodes.filter((n) => n.kind === 'delegation').length + ' 个' : 'no-graph');
    add('委派审批横幅已清空', document.querySelector('#delegApprovals').hidden === true, 'hidden');
    document.querySelector('#panelBtn').click();
    const inspDel = await waitUntil(() => !!document.querySelector('#inspBody .insp-node[data-node-id^="del:"]'), 8000);
    add('检查器展示委派节点', inspDel, document.querySelector('#inspBody .insp-node[data-node-id^="del:"]')?.textContent?.slice(0, 60) || '未出现');
    const delNode = document.querySelector('#inspBody .insp-node[data-node-id^="del:"]');
    if (delNode) delNode.click();
    await sleep(150);
    add('委派节点可下钻子 Run', !!document.querySelector('#inspBody .insp-node-detail')?.textContent.includes('打开子 Run'), document.querySelector('#inspBody .insp-node-detail')?.textContent?.slice(0, 100));
    document.querySelector('#inspClose').click();
    openAgentSheet();
    const agentSheetOk = await waitUntil(() => document.querySelector('#agentList')?.textContent.includes('E2E 研究助手'), 4000);
    add('Agent 管理面板列出可委派 Agent', agentSheetOk, document.querySelector('#agentList')?.textContent?.slice(0, 80));
    closeSheets();
    const archiveChild = await window.dsh.runtime.agents.archive(childAgentId);
    add('子 Agent 可归档', archiveChild?.ok && archiveChild.data.agent.status === 'archived', archiveChild?.ok ? archiveChild.data.agent.status : archiveChild?.error?.message);
  }

  /* ── 4. 每次询问：弹审批卡 → 允许一次 → 执行 ── */
  setPermission('ask');
  runTurn('[[write]] 需要审批的写入');
  await waitUntil(() => state.busy === true, 3000);
  const okApproveCard = await waitUntil(() => !!approvalBtn('once'), 10000);
  add('ask 模式弹出审批卡', okApproveCard, okApproveCard ? 'ok' : '未出现');
  if (okApproveCard) approvalBtn('once').click();
  const okB = await waitUntil(() => state.busy === false, 40000);
  const b = lastAssistant();
  add('审批允许后工具执行成功', okB && b.tools[0]?.status === 'ok', b.tools[0]?.status + ' · ' + String(b.tools[0]?.result || '').slice(0, 50));
  add('允许结果同样回灌给模型', String(b.body).includes('已收到工具结果'), String(b.body).slice(0, 80));

  /* ── 5. 每次询问：拒绝 → 不执行，模型收到拒绝结果 ── */
  runTurn('[[write]] 拒绝这次写入');
  await waitUntil(() => state.busy === true, 3000);
  const okDenyCard = await waitUntil(() => !!approvalBtn('deny'), 10000);
  add('拒绝前同样弹审批卡', okDenyCard, okDenyCard ? 'ok' : '未出现');
  if (okDenyCard) approvalBtn('deny').click();
  await waitUntil(() => state.busy === false, 40000);
  const c = lastAssistant();
  add('拒绝后工具标记 denied 未执行', c.tools[0]?.status === 'denied', c.tools[0]?.status);
  add('拒绝结果回灌给模型', String(c.body).includes('用户拒绝'), String(c.body).slice(0, 90));

  /* ── 6. 恢复完全权限（后续配置操作不受影响） ── */
  setPermission('full');

  /* ── 7. 先把 mock 配置保存为活动连接，API 面板以活动连接为准 ── */
  openConnect();
  await sleep(150);
  document.querySelector('#apiProfileName').value = 'Mock 测试连接';
  document.querySelector('#apiBaseUrl').value = MOCK;
  document.querySelector('#apiKey').value = 'test-key';
  state.formModel = 'mock-tool-model';
  renderApiModelRow();
  document.querySelector('#connectBtn').click();
  await sleep(200);

  openConnect();
  await waitUntil(() => !document.querySelector('#connectSheet').hidden, 2000);
  add('API 面板回填已保存配置', document.querySelector('#apiBaseUrl').value === MOCK, document.querySelector('#apiBaseUrl').value);
  add('API 面板工具区已加载', !document.querySelector('#toolsFine').textContent.includes('加载中'), document.querySelector('#toolsFine').textContent.slice(0, 60));

  document.querySelector('#openModelSheet').click();
  const gotModels = await waitUntil(() => document.querySelectorAll('#modelList .model-item').length >= 2, 8000);
  add('从 API 面板打开模型列表能拉到上游模型', gotModels, `items=${document.querySelectorAll('#modelList .model-item').length}`);
  const alt = document.querySelector('#modelList .model-item[data-model="mock-alt-model"]');
  if (alt) alt.click();
  await sleep(60);
  document.querySelector('#modelApply').click();
  await sleep(150);
  add('API 面板选模型只改表单不落库', state.connection.api.model === 'mock-tool-model', `saved=${state.connection.api.model}`);
  add('选完模型返回 API 面板而非全部关闭', document.querySelector('#connectSheet').hidden === false && document.querySelector('#modelSheet').hidden === true, 'ok');
  add('表单模型行同步显示所选模型', document.querySelector('#apiModelName').textContent === 'mock-alt-model', document.querySelector('#apiModelName').textContent);

  state.formModel = 'mock-tool-model';
  renderApiModelRow();
  document.querySelector('#probeBtn').click();
  const probed = await waitUntil(() => {
    const el = document.querySelector('#probeResult');
    return !el.hidden && el.textContent.includes('连接成功');
  }, 12000);
  add('测试连接通过并显示明细', probed, document.querySelector('#probeResult').textContent.slice(0, 90));
  add('探活签名与结果被记录', state.probeOk === true && !!state.probeSig, state.probeSig.slice(0, 60));
  document.querySelector('#connectBtn').click();
  await sleep(250);
  add('探活后保存保留「已验证」', state.connection.verified === true, `verified=${state.connection.verified}`);

  /* ── 7.5 多 API 连接：新增 / 保存 / 切换 / 持久化 ── */
  const profilesBefore = state.profiles.length;
  document.querySelector('#addProfile').click();
  await sleep(120);
  add('可新增第二条 API 连接', state.profiles.length === profilesBefore + 1, `profiles=${state.profiles.length}`);
  document.querySelector('#apiProfileName').value = '备用 mock 连接';
  document.querySelector('#apiBaseUrl').value = MOCK;
  document.querySelector('#apiKey').value = 'test-key-2';
  document.querySelector('#connectBtn').click();
  await sleep(250);
  add('新连接保存后成为活动连接', state.connection.api.key === 'test-key-2' && state.activeProfileId === state.formProfileId,
    `key=${state.connection.api.key}`);
  const savedProfiles = JSON.parse(localStorage.getItem('dsh.apis') || '{}');
  add('连接列表持久化到本地', (savedProfiles.profiles || []).length === profilesBefore + 1
    && savedProfiles.profiles.some((p) => p.name === '备用 mock 连接')
    && savedProfiles.active === state.activeProfileId, `count=${(savedProfiles.profiles || []).length}`);
  add('localStorage 连接记录不含明文 Key', (savedProfiles.profiles || []).every((p) => !p.key), JSON.stringify((savedProfiles.profiles || []).map((p) => ({ name: p.name, hasKey: !!p.key }))));
  let vault = null;
  for (let i = 0; i < 30; i++) {
    vault = await window.dsh.secrets.getProfiles();
    if (vault?.ok && vault.data?.profiles?.some((p) => p.key === 'test-key-2')) break;
    await sleep(100);
  }
  add('Key 已进入 safeStorage 凭据库', vault?.ok && vault.data.profiles.some((p) => p.key === 'test-key-2'), vault?.ok ? `profiles=${vault.data?.profiles?.length}` : vault?.error?.message);
  document.querySelector('#profileRow .profile').click();
  await sleep(120);
  add('切换连接会加载对应配置', document.querySelector('#apiKey').value === 'test-key', `key=${document.querySelector('#apiKey').value}`);

  /* ── 8. 侧栏状态筛选 ── */
  const s = active();
  s.state = 'running';
  state.filter = 'running';
  add('「运行中」筛选按会话状态生效', sessionMatches(s) === true, 'ok');
  state.filter = 'all';
  s.state = 'idle';
  renderSessions();

  /* ── 8. 运行检查器：Run Graph、节点详情、事件流、只读回放 ── */
  document.querySelector('#panelBtn').click();
  const inspOpened = await waitUntil(() => {
    const el = document.querySelector('#inspector');
    return el && !el.hidden && document.querySelectorAll('#inspBody .insp-node').length > 0;
  }, 10000);
  add('运行检查器可打开并加载运行图', inspOpened, `nodes=${document.querySelectorAll('#inspBody .insp-node').length}`);
  const expectedRun = lastAssistant()?.runtime?.runId || '';
  add('检查器定位当前回合 Run', !!expectedRun && inspector.runId === expectedRun, `insp=${inspector.runId} expected=${expectedRun}`);
  const inspText = document.querySelector('#inspBody').textContent;
  add('检查器显示 Agent 与运行状态', inspText.includes('默认 Agent') && !!document.querySelector('#inspBody .insp-chip'), inspText.slice(0, 80));
  add('运行图包含步骤/模型/工具/校验/完成节点', ['步骤', '模型', '工具', '结果校验', '完成'].every((k) => inspText.includes(k)), inspText.slice(0, 120));
  const fullNodeCount = document.querySelectorAll('#inspBody .insp-node').length;
  add('运行图节点数量合理', fullNodeCount >= 6, `nodes=${fullNodeCount}`);

  const toolNode = [...document.querySelectorAll('#inspBody .insp-node')].find((n) => n.textContent.includes('工具 · write_file'));
  if (toolNode) toolNode.click();
  await sleep(120);
  const detailText = document.querySelector('#inspBody .insp-node-detail')?.textContent || '';
  add('点击工具节点显示策略与 actionHash', detailText.includes('策略：') && detailText.includes('actionHash：'), detailText.slice(0, 90));

  document.querySelector('#inspBody [data-insp-view="timeline"]').click();
  const timelineShown = await waitUntil(() => document.querySelectorAll('#inspBody .insp-timeline .insp-event').length > 0, 4000);
  add('可切换到事件流视图', timelineShown, `events=${document.querySelectorAll('#inspBody .insp-timeline .insp-event').length}`);
  document.querySelector('#inspBody [data-insp-view="graph"]').click();
  await waitUntil(() => document.querySelectorAll('#inspBody .insp-node').length >= 1, 4000);

  const runEventsBefore = await window.dsh.runtime.events.read({ runId: expectedRun, limit: 5000 });
  const seqBeforeReplay = runEventsBefore.data.events.at(-1)?.seq || 0;
  const eventCountBefore = runEventsBefore.data.events.length;
  document.querySelector('#inspPlay').click();
  await waitUntil(() => Number.isInteger(inspector.replayCursor), 2000);
  await sleep(900);
  const cursorMid = inspector.replayCursor;
  add('回放能按事件推进', Number.isInteger(cursorMid) && cursorMid > 0 && cursorMid < seqBeforeReplay, `cursor=${cursorMid}/${seqBeforeReplay}`);
  const replayNodes = document.querySelectorAll('#inspBody .insp-node').length;
  add('回放中图按截断事件重绘', replayNodes > 0 && replayNodes < fullNodeCount, `${replayNodes}/${fullNodeCount}`);
  const runEventsDuring = await window.dsh.runtime.events.read({ runId: expectedRun, limit: 5000 });
  add('回放不产生新事件', runEventsDuring.data.events.length === eventCountBefore && (runEventsDuring.data.events.at(-1)?.seq || 0) === seqBeforeReplay, `events=${runEventsDuring.data.events.length}`);
  document.querySelector('#inspLive').click();
  const liveRestored = await waitUntil(() => inspector.replayCursor === null && document.querySelectorAll('#inspBody .insp-node').length === fullNodeCount, 4000);
  add('实时按钮恢复完整运行图', liveRestored, `nodes=${document.querySelectorAll('#inspBody .insp-node').length}`);

  const inspTasks = document.querySelectorAll('#inspBody .insp-task').length;
  add('检查器列出历史任务', inspTasks >= 3, `tasks=${inspTasks}`);
  const runtimeTasks = await window.dsh.runtime.tasks.list({ limit: 20 });
  add('Runtime 任务列表可读且已持久化', runtimeTasks.ok && runtimeTasks.data.tasks.length >= 3, `count=${runtimeTasks.data?.tasks?.length}`);
  const auditRead = await window.dsh.runtime.audit.read({ limit: 20 });
  add('Runtime 审计链可读取', auditRead.ok && auditRead.data.records.length > 0, `records=${auditRead.data?.records?.length}`);
  const auditVerify = await window.dsh.runtime.audit.verify();
  add('Runtime 审计哈希链校验通过', auditVerify.ok && auditVerify.data.ok === true, JSON.stringify(auditVerify.data?.issues || []));
  document.querySelector('#inspClose').click();
  add('运行检查器可关闭', document.querySelector('#inspector').hidden === true, 'closed');

  /* ── 9. 清理测试目录并恢复原配置 ── */
  const clean = await window.dsh.tools.exec('run_command',
    { command: `rmdir /s /q "${ws}"`, timeout_ms: 15000 },
    { workspace: base, permission: 'full' });
  add('测试目录已清理', clean.ok === true, clean.ok ? 'ok' : String(clean.error || '').slice(0, 60));

  state.connection = prevConn;
  if (prevConnRaw === null) localStorage.removeItem('dsh.conn'); else localStorage.setItem('dsh.conn', prevConnRaw);
  state.workspace = prevWorkspace || '';
  if (prevWsRaw === null) localStorage.removeItem('dsh.workspace'); else localStorage.setItem('dsh.workspace', prevWsRaw);
  if (prevProfilesRaw === null) localStorage.removeItem('dsh.apis'); else localStorage.setItem('dsh.apis', prevProfilesRaw);
  setPermission(prevPermission);
  loadProfiles();
  loadProfile(state.activeProfileId);
  renderHeader();
  renderHost();
  renderSessions();
  renderChat();
  openConnect();

  out.total = out.checks.length;
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.total - out.passed;
  return out;
})();
