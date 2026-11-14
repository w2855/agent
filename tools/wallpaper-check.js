/* 视频壁纸 / 去雾化自检：真实计算样式 + 真实 webm 播放，不依赖模拟服务 */
(async () => {
  const q = (s) => document.querySelector(s);
  const cs = (s) => getComputedStyle(q(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [] };
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '').slice(0, 220) });
  const V = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  await sleep(900); // 等 initWallpaper 与静默探活完成

  /* 1. 去雾化：所有模糊/磨砂必须彻底消失 */
  const blurs = ['.sidebar', '.composer', '.scrim', '.menu'].map((s) => [s, cs(s).backdropFilter || cs(s).webkitBackdropFilter]);
  add('四处 backdrop-filter 全部移除', blurs.every(([, v]) => !v || v === 'none'), JSON.stringify(blurs));
  add('body 不再有径向光晕', !cs('body').backgroundImage.includes('radial-gradient'), cs('body').backgroundImage.slice(0, 90));
  add('光晕变量已置透明', V('--glow-a') === 'transparent' && V('--glow-b') === 'transparent', `${V('--glow-a')} / ${V('--glow-b')}`);

  /* 2. 面板改为实色 */
  add('深色面板为实色 hex', /^#[0-9a-f]{6}$/i.test(V('--panel')), V('--panel'));
  add('菜单背景为实色 hex', /^#[0-9a-f]{6}$/i.test(V('--menu-bg')), V('--menu-bg'));
  add('输入区背景为实色 hex', /^#[0-9a-f]{6}$/i.test(V('--composer-bg')), V('--composer-bg'));
  add('侧栏实际背景不透明', (() => { const c = cs('.sidebar').backgroundColor; return c.startsWith('rgb(') && !c.startsWith('rgba('); })(), cs('.sidebar').backgroundColor);

  /* 3. 控件齐全与初始状态 */
  const needed = ['#wallpaper', '#wallpaperTint', '#pickWallpaper', '#clearWallpaper', '#tintRange', '#tintValue', '#wallpaperState'];
  add('壁纸控件齐全', needed.every((s) => !!q(s)), needed.filter((s) => !q(s)).join(',') || '全部存在');
  add('未设壁纸时视频层隐藏', !document.documentElement.dataset.wallpaper && cs('#wallpaper').display === 'none', `dataset=${document.documentElement.dataset.wallpaper} display=${cs('#wallpaper').display}`);

  /* 4. 压暗滑块只做纯色叠加 */
  q('#tintRange').value = '30';
  q('#tintRange').dispatchEvent(new Event('input', { bubbles: true }));
  add('压暗滑块写入纯色叠加变量', /rgba\(0, 0, 0, 0\.3/.test(V('--wall-tint')) && q('#tintValue').textContent === '30%', `${V('--wall-tint')} / ${q('#tintValue').textContent}`);
  add('压暗层不使用模糊', (cs('#wallpaperTint').backdropFilter || 'none') === 'none', cs('#wallpaperTint').backdropFilter || 'none');
  q('#tintRange').value = '0';
  q('#tintRange').dispatchEvent(new Event('input', { bubbles: true }));
  add('可回到 0% 完全透亮', /rgba\(0, 0, 0, 0(\.0+)?\)/.test(V('--wall-tint')), V('--wall-tint'));

  /* 5. 主进程 IPC 只读/清理分支 */
  try {
    const cur = await window.dsh.wallpaper.current();
    add('wallpaper:current 返回合法结果', cur === null || (typeof cur.file === 'string' && Number.isFinite(cur.size)), JSON.stringify(cur));
    const cleared = await window.dsh.wallpaper.clear();
    add('wallpaper:clear 正常返回', cleared && cleared.ok === true, JSON.stringify(cleared));
    add('清理后 current 为空', (await window.dsh.wallpaper.current()) === null, 'null');
  } catch (err) {
    add('wallpaper IPC 可用', false, String(err?.message || err));
  }

  /* 6. 真实 webm 播放（canvas 录制一段真视频，验证 video 层可播） */
  let recorded = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 96; canvas.height = 96;
    const ctx = canvas.getContext('2d');
    let frame = 0;
    const draw = () => { ctx.fillStyle = `hsl(${(frame++ * 12) % 360}, 72%, 52%)`; ctx.fillRect(0, 0, 96, 96); };
    draw();
    const stream = canvas.captureStream(0); // 手动推帧，保证每帧都进录制器
    const track = stream.getVideoTracks()[0];
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(100);
    let raf = 0;
    const loop = () => { draw(); track.requestFrame?.(); raf = requestAnimationFrame(loop); };
    loop();
    await sleep(1000);
    cancelAnimationFrame(raf);
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const video = q('#wallpaper');
    video.src = url;
    document.documentElement.dataset.wallpaper = 'on';
    let playErr = '';
    try { await video.play(); } catch (e) { playErr = e?.message || String(e); }
    await sleep(400);
    recorded = { mime, bytes: blob.size, readyState: video.readyState, w: video.videoWidth, h: video.videoHeight, paused: video.paused, blobUrl: video.currentSrc.startsWith('blob:'), playErr };
    add('真实 webm 能在壁纸层播放', recorded.bytes > 1000 && recorded.w > 0 && recorded.readyState >= 2 && recorded.blobUrl && !recorded.paused, JSON.stringify(recorded));
    // 纯 CSS 规则单独验证，不依赖视频解码结果
    document.documentElement.dataset.wallpaper = 'on';
    add('有壁纸时正文有实色底板', (() => {
      const probe = document.createElement('div');
      probe.className = 'prose';
      const wrap = document.createElement('div');
      wrap.className = 'msg assistant';
      wrap.appendChild(probe);
      q('.chat-inner')?.appendChild(wrap);
      const bg = getComputedStyle(probe).backgroundColor;
      wrap.remove();
      return bg.startsWith('rgb(') && !bg.startsWith('rgba(');
    })(), 'prose 背景为实色');
    video.pause();
    video.removeAttribute('src');
    try { video.load(); } catch { /* 忽略 */ }
    document.documentElement.removeAttribute('data-wallpaper');
    URL.revokeObjectURL(url);
  } catch (err) {
    add('真实 webm 能在壁纸层播放', false, `环境不支持录制：${err?.message || err}`);
  }

  out.total = out.checks.length;
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.total - out.passed;
  return out;
})();
