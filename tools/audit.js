(async () => {
  const out = { viewport: [innerWidth, innerHeight], theme: document.documentElement.dataset.theme, checks: {}, issues: [] };
  const cs = (el) => getComputedStyle(el);
  const q = (s) => document.querySelector(s);
  const R = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  const rgb = (v) => { const d = document.createElement('div'); d.style.color = v; document.body.appendChild(d); const c = cs(d).color; d.remove(); return c; };
  const lum = (c) => { const m = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }); return .2126 * m[0] + .7152 * m[1] + .0722 * m[2]; };
  const contrast = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return +((x + .05) / (y + .05)).toFixed(2); };
  const V = (n) => cs(document.documentElement).getPropertyValue(n).trim();

  /* 1. 主布局几何 */
  out.checks.rects = {
    app: R('.app'), sidebar: R('.sidebar'), main: R('.main'), topbar: R('.topbar'),
    chat: R('.chat'), composerArea: R('.composer-area'), composer: R('.composer'),
    hint: R('.hint'), chatInner: R('.chat-inner'), sideFoot: R('.side-foot'),
  };
  const chat = q('.chat');
  out.checks.chatScroll = { clientHeight: chat.clientHeight, scrollHeight: chat.scrollHeight, scrollTop: chat.scrollTop };

  /* 2. 顶栏「展开侧栏」按钮：与弹出菜单 .menu 是否撞车 */
  const mb = q('#menuBtn');
  const s = cs(mb);
  out.checks.menuBtn = {
    className: mb.className, hidden: mb.hidden, position: s.position, display: s.display,
    width: Math.round(mb.getBoundingClientRect().width), minWidth: s.minWidth,
    padding: s.padding, background: s.backgroundColor, boxShadow: s.boxShadow.slice(0, 40),
    border: s.borderTopWidth, zIndex: s.zIndex,
  };
  if (s.position === 'fixed') out.issues.push('#menuBtn 误用 .menu 类 → position:fixed / 208px / 带面板背景');

  /* 3. hideMenus 会不会把展开按钮一起隐藏 */
  hideMenus();
  out.checks.menuBtnHiddenAfterHideMenus = mb.hidden;
  if (mb.hidden) out.issues.push('hideMenus() 把顶栏「展开侧栏」按钮设为 hidden，收起侧栏后无法还原');
  mb.hidden = false;

  /* 4. 收起侧栏后的几何 */
  q('#app').classList.add('collapsed');
  await new Promise(r => setTimeout(r, 320));
  out.checks.collapsed = {
    sidebar: R('.sidebar'), main: R('.main'), menuBtn: R('#menuBtn'), title: R('.title-block'),
    menuBtnVisible: cs(q('#menuBtn')).display,
  };
  q('#app').classList.remove('collapsed');
  await new Promise(r => setTimeout(r, 320));

  /* 5. 文本溢出（省略号 / 裁切） */
  const clipped = [];
  document.querySelectorAll('.s-title, .brand-name, .title-block h1, .host-text b, .host-text small, .hint span, .row-body small, .tool .t-target, .file-body b, .file-body small, .summary, .metrics, .chip, .model').forEach(e => {
    if (e.scrollWidth > e.clientWidth + 1 && cs(e).overflow !== 'visible') clipped.push({ sel: e.className || e.tagName, text: e.textContent.trim().slice(0, 32), scroll: e.scrollWidth, client: e.clientWidth });
  });
  out.checks.clipped = clipped;

  /* 6. 越界元素 */
  const oob = [];
  document.querySelectorAll('.app *').forEach(e => {
    const st = cs(e);
    if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) return;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) {
      oob.push({ sel: (e.id ? '#' + e.id : '.' + (e.className || e.tagName)).slice(0, 40), r: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    }
  });
  out.checks.outOfBounds = oob.slice(0, 14);

  /* 7. 对比度 */
  const bg = V('--page-bottom');
  out.checks.contrast = {
    'text/page': contrast(V('--text'), bg),
    'text-2/page': contrast(V('--text-2'), bg),
    'text-3/page': contrast(V('--text-3'), bg),
    'text-4/page': contrast(V('--text-4'), bg),
    'chip-active': contrast(V('--chip-active-ink'), V('--chip-active-bg')),
    'sendIcon': contrast(V('--accent-ink'), V('--accent')),
    'tone-read/page': contrast(V('--tone-read'), bg),
    'tone-terminal/page': contrast(V('--tone-terminal'), bg),
    'tone-neutral/page': contrast(V('--tone-neutral'), bg),
    'file-xlsx/bg': contrast('#6FD3A9', bg),
    'file-md/bg': contrast('#8FB8F8', bg),
    'warn/page': contrast(V('--warn'), bg),
  };

  /* 8. 阴影/边框在浅色主题是否仍用深色调 */
  out.checks.hardcoded = {
    composerShadow: cs(q('.composer')).boxShadow.slice(0, 90),
    fileIcoXlsx: cs(document.querySelector('.file-ico') || document.body).backgroundColor,
  };

  return out;
})();
