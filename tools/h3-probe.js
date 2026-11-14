/* H3 探针（--shot 模式渲染层执行）：
   1) dsh.notify.show 同 tag 两次 → 断言主进程去重生效且不抛错；
   2) dsh.export 通道存在（不调 session，避免无头环境被保存对话框阻塞）+ 序列化透传可用；
   3) 托盘（win32）：tray:state 通道 + Tray 已创建 + closeToTray 开关往返。
   运行：electron . --shot --script=tools/h3-probe.js */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400);
  const out = { notify: {}, export: {}, tray: {} };

  /* 1. 系统通知：同 tag 连发两次，第二次应命中去重（deduped: true），全程不抛错 */
  try {
    const r1 = await window.dsh.notify.show({ title: 'H3 探针', body: '去重第一条', tag: 'h3-probe' });
    const r2 = await window.dsh.notify.show({ title: 'H3 探针', body: '去重第二条', tag: 'h3-probe' });
    const r3 = await window.dsh.notify.show({ title: 'H3 探针', body: '另一个 tag', tag: 'h3-probe-2' });
    const r4 = await window.dsh.notify.show({ title: 'H3 探针', body: '无 tag', tag: '' });
    out.notify = {
      first: r1,
      secondDeduped: r2 && r2.deduped === true,
      otherTagSent: r3 && r3.ok === true && !r3.deduped,
      emptyTagSent: r4 && r4.ok === true && !r4.deduped,
      ok: r1?.ok === true && r2?.deduped === true && r3?.ok === true && r4?.ok === true,
    };
  } catch (err) {
    out.notify = { ok: false, error: String(err && err.message || err) };
  }

  /* 2. 会话导出：只验证 IPC 面与序列化透传，不调带内容的 export.session（无头下 dialog 会阻塞） */
  try {
    const exp = window.dsh.export;
    const mock = {
      title: '探针会话',
      messages: [
        { role: 'user', text: '探针消息' },
        { role: 'assistant', body: '回复正文', tools: [{ name: 'run_command', target: 'echo hi', status: 'ok', result: 'hi' }], startedAt: 1700000000000 },
      ],
    };
    const md = exp?.serializeSessionMd?.(mock);
    let jsonOk = false;
    try { jsonOk = !!JSON.parse(exp?.serializeSessionJson?.(mock) || ''); } catch { jsonOk = false; }
    // 空内容会在打开保存对话框之前被主进程拒绝（不阻塞），据此验证 IPC 通道真实可达
    const empty = await exp.session({});
    out.export = {
      hasSession: typeof exp?.session === 'function',
      mdWorks: typeof md === 'string' && md.startsWith('# 探针会话') && md.includes('## 用户'),
      jsonWorks: jsonOk,
      emptyContentRejected: empty?.ok === false && !empty?.canceled && typeof empty?.error === 'string',
      ok: typeof exp?.session === 'function' && md.startsWith('# 探针会话') && jsonOk && empty?.ok === false,
    };
  } catch (err) {
    out.export = { ok: false, error: String(err && err.message || err) };
  }

  /* 3. 托盘：Tray 创建无异常（win32）+ closeToTray 开关往返（结束恢复默认 false） */
  try {
    const before = await window.dsh.tray.getState();
    await window.dsh.tray.setCloseToTray(true);
    const during = await window.dsh.tray.getState();
    await window.dsh.tray.setCloseToTray(false);
    const after = await window.dsh.tray.getState();
    out.tray = {
      supported: before?.supported === true,
      trayCreated: before?.trayCreated === true,
      toggleRoundTrip: during?.closeToTray === true && after?.closeToTray === false,
      onNewChatFn: typeof window.dsh.tray.onNewChat === 'function',
      ok: before?.ok === true && before?.supported === true && before?.trayCreated === true && during?.closeToTray === true && after?.closeToTray === false,
    };

    /* 设置页开关 → 主进程状态的端到端接线：点「开启」后主进程应收到 true（结束恢复默认关） */
    const segBtn = document.querySelector('#traySeg button[data-tray="on"]');
    segBtn?.click();
    await sleep(150);
    const afterUiOn = await window.dsh.tray.getState();
    document.querySelector('#traySeg button[data-tray="off"]')?.click();
    await sleep(150);
    const afterUiOff = await window.dsh.tray.getState();
    out.uiWiring = {
      onPropagated: afterUiOn?.closeToTray === true,
      offRestored: afterUiOff?.closeToTray === false,
      segActiveOn: document.querySelector('#traySeg button[data-tray="off"]')?.classList.contains('is-active') === true,
    };
    out.tray.uiWiring = out.uiWiring.onPropagated && out.uiWiring.offRestored && out.uiWiring.segActiveOn && out.tray.ok;
    out.tray.ok = out.tray.ok && out.tray.uiWiring;
  } catch (err) {
    out.tray = { ok: false, error: String(err && err.message || err) };
  }

  /* 4. 设置页新控件存在（设置页探针之外的自检） */
  out.ui = {
    traySeg: !!document.getElementById('traySeg'),
    exportMd: !!document.getElementById('exportSessionMd'),
    exportJson: !!document.getElementById('exportSessionJson'),
  };

  out.allOk = out.notify.ok === true && out.export.ok === true && out.tray.ok === true && out.ui.traySeg && out.ui.exportMd && out.ui.exportJson;
  return out;
})();
