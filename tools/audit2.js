(async () => {
  const out = { viewport: [innerWidth, innerHeight], issues: [], checks: {} };
  const cs = (el) => getComputedStyle(el);
  const q = (s) => document.querySelector(s);
  const R = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  const rgb = (v) => { const d = document.createElement('div'); d.style.color = v; document.body.appendChild(d); const c = cs(d).color; d.remove(); return c; };
  const lum = (c) => { const m = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }); return .2126 * m[0] + .7152 * m[1] + .0722 * m[2]; };
  const contrast = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return +((x + .05) / (y + .05)).toFixed(2); };
  const V = (n) => cs(document.documentElement).getPropertyValue(n).trim();

  /* 文件卡/审批卡只在离线预览的示例会话里出现，先切过去再量对比度 */
  if (sourceOf() !== 'preview') {
    switchSource('preview');
    persistConn({ source: 'preview', verified: true });
  }
  const fileSession = state.sessions.find(s => s.messages.some(m => m.files && m.files.length));
  if (fileSession) selectSession(fileSession.id);

  /* ── 浅色主题 ── */
  applyTheme('light');
  await new Promise(r => setTimeout(r, 120));
  const bg = V('--page-bottom');
  out.checks.lightContrast = {
    'text/page': contrast(V('--text'), bg),
    'text-2/page': contrast(V('--text-2'), bg),
    'text-3/page': contrast(V('--text-3'), bg),
    'text-4/page': contrast(V('--text-4'), bg),
    'chip-active': contrast(V('--chip-active-ink'), V('--chip-active-bg')),
    'sendIcon': contrast(V('--accent-ink'), V('--accent')),
    'tone-read/page': contrast(V('--tone-read'), bg),
    'tone-terminal/page': contrast(V('--tone-terminal'), bg),
    'warn/page': contrast(V('--warn'), bg),
  };
  // 示例会话不一定含全部文件类型；对未出现的类型补一个真实节点，确保三类样式都被量到
  for (const k of ['xlsx', 'png', 'md']) {
    if (q('.file-ico.' + k)) continue;
    const probe = document.createElement('div');
    probe.className = 'file-ico ' + k;
    probe.textContent = 'M';
    (q('.files') || q('.chat-inner') || document.body).appendChild(probe);
  }
  out.checks.fileIco = ['xlsx', 'png', 'md'].map(k => {
    const el = q('.file-ico.' + k);
    if (!el) return [k, null];
    const c = cs(el).color;
    return [k, c, +contrast(c, bg).toFixed(2)];
  });
  Object.entries(out.checks.lightContrast).forEach(([k, v]) => { if (v < 4.5) out.issues.push('浅色对比度不足 ' + k + ' = ' + v); });
  out.checks.fileIco.forEach(([k, c, cr]) => {
    if (c === null || (typeof cr === 'number' && cr < 4.5)) out.issues.push('文件卡图标缺失或对比度不足 ' + k + ' = ' + cr);
  });
  out.checks.lightShadows = {
    composer: cs(q('.composer')).boxShadow.slice(0, 70),
    sidebar: cs(q('.sidebar')).boxShadow.slice(0, 70),
    menu: cs(q('#modelMenu')).boxShadow.slice(0, 70),
    sheet: cs(q('#settingsSheet')).boxShadow.slice(0, 70),
    toast: cs(q('#toast')).boxShadow.slice(0, 70),
  };

  /* ── 空状态 ── */
  q('#newChatBtn').click();
  await new Promise(r => setTimeout(r, 220));
  const chat = q('.chat');
  out.checks.empty = {
    chat: R('.chat'), inner: R('.chat-inner'), empty: R('.empty'), img: R('.empty img'),
    suggests: R('.suggests'), scroll: [chat.clientHeight, chat.scrollHeight, chat.scrollTop],
    imgLoaded: (() => { const i = q('.empty img'); return i && i.complete && i.naturalWidth > 0; })(),
  };
  if (chat.scrollHeight > chat.clientHeight + 2) out.issues.push('空会话出现纵向滚动条：' + chat.scrollHeight + ' > ' + chat.clientHeight);

  /* ── 浮层定位 ── */
  applyTheme('dark');
  openMenu('modelMenu', q('#modelBtn'));
  out.checks.modelMenu = { rect: R('#modelMenu'), anchor: R('#modelBtn'), winH: innerHeight };
  hideMenus();
  openMenu('modeMenu', q('#modeBtn'));
  out.checks.modeMenu = { rect: R('#modeMenu'), anchor: R('#modeBtn') };
  hideMenus();
  q('#input').value = '/';
  q('#input').dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  out.checks.slashMenu = { rect: R('#slashMenu'), composer: R('.composer') };
  hideMenus();
  q('#input').value = '';
  openSheet('settingsSheet');
  out.checks.settings = { rect: R('#settingsSheet'), win: [innerWidth, innerHeight] };
  closeSheets();

  /* ── 长消息 / 气泡 ── */
  const s = active();
  return out;
})();
