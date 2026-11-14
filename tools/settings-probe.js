/* 设置页探针：openSettings('connect') 基线 + 六个 pane 逐一切换校验，最后停在连接 pane 供截图 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400);

  const panes = () => [...document.querySelectorAll('.settings-pane')];
  const visiblePane = () => { const p = panes().find((el) => !el.hidden); return p ? p.id : null; };
  const results = {};

  /* 基线：打开设置页的「模型与连接」 */
  openSettings('connect');
  await sleep(320);
  results.connect = {
    opened: !document.querySelector('#settingsPage').hidden,
    pane: visiblePane(),
    connectBtnExists: !!document.querySelector('#connectBtn'),
  };

  /* 逐个切到其余分类，确认只有目标 pane 可见 */
  for (const cat of ['appearance', 'chat', 'tools', 'agents', 'about']) {
    switchSettingsPane(cat);
    await sleep(220); // 等 pane 入场动画走完再读状态
    results[cat] = {
      pane: visiblePane(),
      onlyOneVisible: panes().filter((el) => !el.hidden).length === 1,
    };
  }

  /* 收尾回连接 pane，截图呈现核心表单 */
  openSettings('connect');
  await sleep(320);
  results.endPane = visiblePane();
  results.navCount = document.querySelectorAll('#settingsNav [data-sp]').length;
  results.missingIds = [
    'settingsPage', 'settingsNav', 'settingsClose',
    'paneAppearance', 'paneChat', 'paneConnect', 'paneTools', 'paneAgents', 'paneAbout',
    'sourceSeg', 'paneModel', 'paneDemo', 'probeResult', 'connectFine',
    'apiProfileName', 'apiBaseUrl', 'apiKey', 'apiModelName', 'apiModelCount', 'resetApiCfg',
    'pickWorkspace', 'workspacePath', 'toolsFine', 'permSettingValue',
    'customPromptInput', 'saveCustomPrompt', 'retrySeg', 'retryFine',
    'themeSeg', 'accentRow', 'pickWallpaper', 'clearWallpaper', 'wallpaperState', 'tintRange', 'tintValue', 'veilRange', 'veilValue',
    'agentList', 'agentName', 'agentModelProfile', 'agentModel', 'agentPrompt', 'agentPermSeg', 'agentCreate', 'agentFine',
    'openArch', 'openAgents', 'openConnect', 'connSummary', 'agentsSummary',
    'sysPlatform', 'sysElectron', 'sysChrome', 'sysNode',
  ].filter((id) => !document.getElementById(id));
  results.legacySheetsGone = ['connectSheet', 'agentSheet', 'settingsSheet'].every((id) => !document.getElementById(id));
  return results;
})();
