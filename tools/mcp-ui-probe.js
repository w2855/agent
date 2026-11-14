/* MCP/技能设置页探针：
   1) paneMcp / paneSkills 空态可达，navCount=8；
   2) 走 UI DOM 添加假 server 配置 → getServers() 反映；
   3) 启动坏命令 → 状态 error 且 lastError 上屏（不崩溃）；
   4) 两段式删除生效；
   5) /skills 斜杠命令进技能 pane；
   最后停在 paneMcp（带一条 stopped 演示配置）供截图。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400);

  const $ = (sel) => document.querySelector(sel);
  const visiblePane = () => [...document.querySelectorAll('.settings-pane')].find((el) => !el.hidden)?.id || null;
  const results = {};

  /* ── 1) 两个新 pane 空态 + 导航数量 ── */
  openSettings('mcp');
  await sleep(350);
  results.mcp = {
    pageOpen: !$('#settingsPage').hidden,
    pane: visiblePane(),
    hasList: !!$('#mcpServerList'),
    hasAddForm: !!$('#mcpAddCard') && $('#mcpAddCard').hidden,
  };
  switchSettingsPane('skills');
  await sleep(450); // 等自动扫描 IPC 返回
  results.skills = {
    pane: visiblePane(),
    hasList: !!$('#skillsList'),
    listText: ($('#skillsList')?.textContent || '').slice(0, 60),
  };
  results.navCount = document.querySelectorAll('#settingsNav [data-sp]').length;
  results.paneCount = document.querySelectorAll('.settings-pane').length;

  /* ── 2) 通过 DOM 表单添加假 server ── */
  switchSettingsPane('mcp');
  await sleep(350);
  $('#mcpToggleAdd').click();
  await sleep(80);
  const fill = (sel, v) => {
    const el = $(sel);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  fill('#mcpAddName', 'probe-fake');
  fill('#mcpAddCommand', 'dsh-nonexistent-mcp-cmd-xyz');
  fill('#mcpAddArgs', '--probe 1');
  fill('#mcpAddEnv', 'PROBE=1');
  $('#mcpSaveAdd').click();
  await sleep(600);
  const st1 = await window.dsh.mcp.getServers();
  results.added = {
    configs: (st1.configs || []).map((c) => ({ id: c.id, command: c.command, args: c.args, env: c.env })),
    rowShown: !!$('#mcpServerList .mcp-row'),
    formCollapsed: $('#mcpAddCard')?.hidden,
    formCleared: !$('#mcpAddName')?.value,
  };

  /* ── 3) 坏命令启动 → error + lastError 上屏 ── */
  // 等自动启动收敛（保存并启动已在 mcpSaveAdd 里触发），再显式点一次「启动」验证按钮路径
  let rec = null;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const st = await window.dsh.mcp.getServers();
    rec = (st.servers || []).find((s) => s.id === 'probe-fake') || null;
    if (rec && rec.status !== 'starting') break;
  }
  const startBtn = $('#mcpServerList [data-mcp-start]');
  results.startButtonShown = !!startBtn;
  if (startBtn) { startBtn.click(); await sleep(120); }
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const st = await window.dsh.mcp.getServers();
    rec = (st.servers || []).find((s) => s.id === 'probe-fake') || null;
    if (rec && rec.status !== 'starting') break;
  }
  await sleep(500); // 等一次轮询渲染落 DOM
  const errRow = $('#mcpServerList .mcp-row.is-error');
  results.badStart = {
    status: rec?.status || 'missing',
    lastError: String(rec?.lastError || '').slice(0, 140),
    errorRowShown: !!errRow,
    errTextShown: (errRow?.querySelector('.mcp-err')?.textContent || '').slice(0, 140),
  };

  /* ── 4) 两段式删除 ── */
  const delBtn = () => $('#mcpServerList [data-mcp-del]');
  delBtn()?.click();
  await sleep(120);
  const armed = delBtn()?.classList.contains('is-armed') || (delBtn()?.textContent || '').includes('确认');
  delBtn()?.click();
  await sleep(700);
  const st2 = await window.dsh.mcp.getServers();
  results.twoStageDelete = {
    armedShown: !!armed,
    configGone: !(st2.configs || []).some((c) => c.id === 'probe-fake'),
    rowGone: !$('#mcpServerList .mcp-row'),
  };

  /* ── 5) /skills 斜杠命令 ── */
  const ta = $('#input');
  ta.value = '/skills';
  updateSlash();
  await sleep(80);
  const menu = $('#slashMenu');
  const item = menu.querySelector('[data-cmd="/skills"]');
  results.slashMenu = { shown: !menu.hidden, hasSkillsItem: !!item };
  if (item) item.click();      // 常规路径：填入输入框
  ta.value = '/skills';
  send();                       // 触发 handleCommand('/skills')
  await sleep(400);
  results.slashOpensSkills = visiblePane();

  /* ── 6) mcp_* 工具名兜底元数据 ── */
  const meta = toolMetaFor('mcp_probe_echo');
  results.toolMetaFallback = { verb: meta.verb, icon: meta.icon, tone: meta.tone };

  /* ── 收尾：留一条 stopped 演示配置，截 paneMcp 有内容的图 ── */
  openSettings('mcp');
  await sleep(350);
  $('#mcpToggleAdd').click();
  await sleep(80);
  fill('#mcpAddName', 'probe-demo');
  fill('#mcpAddCommand', 'node E:/demo/server.js');
  fill('#mcpAddArgs', '--root E:/demo');
  $('#mcpSaveAdd').click();
  await sleep(600); // 启动会失败（命令不存在），正好展示 error 行
  results.endPane = visiblePane();
  results.endRows = document.querySelectorAll('#mcpServerList .mcp-row').length;
  results.endErrRows = document.querySelectorAll('#mcpServerList .mcp-row.is-error').length;
  return results;
})();
