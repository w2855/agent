(async () => {
  applyTheme('dark');
  const out = { issues: [] };
  const q = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  /* 1. 所有图标引用是否都能解析到 symbol */
  const missing = [...new Set($$('svg use').map(u => u.getAttribute('href')))].filter(h => h && !q(h));
  out.missingIcons = missing;
  if (missing.length) out.issues.push('图标引用缺失: ' + missing.join(','));

  /* 2. 关键元素齐全 */
  const needed = ['#sidebar', '#menuBtn', '.title-block', '#modelBtn', '#chat', '.composer',
                  '#sendBtn', '#input', '.hint', '#sessions', '.side-foot', '#settingsSheet', '#connectSheet'];
  out.missingEls = needed.filter(s => !q(s));
  if (out.missingEls.length) out.issues.push('关键元素缺失: ' + out.missingEls.join(','));

  /* 3. 切到离线预览，用示例会话里的审批卡验证 DOM 顺序（不发网络请求） */
  if (sourceOf() !== 'preview') {
    switchSource('preview');
    persistConn({ source: 'preview', verified: true });
  }
  const target = state.sessions.find(s => s.messages.some(m => m.approval));
  const other = state.sessions.find(s => s !== target);
  if (target) selectSession(target.id);
  const approvalNode = () => $$('#chat .msg.assistant').find(n => n.querySelector('.approval'));
  const orderOf = (n) => n ? [...n.children].map(c => c.className) : null;
  out.orderStreamed = orderOf(approvalNode());
  out.approvalButtonsStreamed = $$('#chat .approval:not(.done) .approval-actions button').length;
  out.busy = state.busy;

  /* 4. 切走再切回，验证重绘后顺序/按钮一致 */
  if (target) { if (other) selectSession(other.id); selectSession(target.id); }
  out.orderRepainted = orderOf(approvalNode());
  out.approvalButtonsRepainted = $$('#chat .approval:not(.done) .approval-actions button').length;
  if (JSON.stringify(out.orderStreamed) !== JSON.stringify(out.orderRepainted))
    out.issues.push('会话重绘后 DOM 顺序与流式生成时不一致');
  if (out.approvalButtonsRepainted !== 3)
    out.issues.push('重绘后审批卡按钮数量异常: ' + out.approvalButtonsRepainted);

  /* 5. 明暗往返后仍是深色，且语义色跟着变 */
  const darkBg = getComputedStyle(document.documentElement).getPropertyValue('--page-bottom').trim();
  applyTheme('light');
  const lightBg = getComputedStyle(document.documentElement).getPropertyValue('--page-bottom').trim();
  applyTheme('dark');
  const backBg = getComputedStyle(document.documentElement).getPropertyValue('--page-bottom').trim();
  out.themeRoundTrip = [darkBg, lightBg, backBg];
  if (darkBg !== backBg || darkBg === lightBg) out.issues.push('主题往返异常');

  /* 6. 菜单定位：模式菜单不能压到输入框上 */
  const composer = q('.composer').getBoundingClientRect();
  openMenu('modeMenu', q('#modeBtn'));
  const mm = q('#modeMenu').getBoundingClientRect();
  out.modeMenu = { bottom: Math.round(mm.bottom), composerTop: Math.round(composer.top), gap: Math.round(composer.top - mm.bottom) };
  if (mm.bottom > composer.top + 1) out.issues.push('模式菜单压到了输入框');
  hideMenus();

  /* 7. 收起侧栏后展开按钮仍是普通小按钮 */
  q('#collapseBtn').click();
  await new Promise(r => setTimeout(r, 300));
  const b = q('#menuBtn').getBoundingClientRect();
  const t = q('.title-block').getBoundingClientRect();
  out.collapsed = { btn: [Math.round(b.width), Math.round(b.height)], overlap: b.right > t.left };
  if (b.width > 40 || b.right > t.left) out.issues.push('展开侧栏按钮仍是异常尺寸/与标题重叠');
  q('#menuBtn').click();
  await new Promise(r => setTimeout(r, 300));

  return out;
})();
