/* 视频壁纸「清晰可见」取证：录一段四象限纯色视频设为壁纸，关掉一切遮挡，
   把界面切到有内容的正常状态，留给主进程截图。用于像素级复核。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const out = { checks: [] };
  const add = (name, pass, detail) => out.checks.push({ name, pass: !!pass, detail: String(detail ?? '').slice(0, 240) });

  await sleep(800);

  /* 1. 录四象限纯色视频：左上红、右上绿、左下蓝、右下黄 */
  const W = 600, H = 400;                       // 与窗口同为 3:2，object-fit:cover 不裁切
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const paint = () => {
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, W / 2, H / 2);
    ctx.fillStyle = '#00ff00'; ctx.fillRect(W / 2, 0, W / 2, H / 2);
    ctx.fillStyle = '#0000ff'; ctx.fillRect(0, H / 2, W / 2, H / 2);
    ctx.fillStyle = '#ffff00'; ctx.fillRect(W / 2, H / 2, W / 2, H / 2);
  };
  paint();
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(100);
  let raf = 0;
  const loop = () => { paint(); track.requestFrame?.(); raf = requestAnimationFrame(loop); };
  loop();
  await sleep(900);
  cancelAnimationFrame(raf);
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());

  /* 2. 设为壁纸。厚度取已保存的设置（可用 window.__FORCE_VEIL 覆盖），
     这样默认态与极限态都能取证。 */
  const video = q('#wallpaper');
  document.documentElement.dataset.wallpaper = 'on';
  const forceVeil = Number.isFinite(window.__FORCE_VEIL) ? window.__FORCE_VEIL : null;
  const veil = forceVeil != null ? forceVeil : Number(localStorage.getItem('dsh.veil') ?? 26);
  const tint = Number(localStorage.getItem('dsh.tint') ?? 0);
  applyTint(tint);
  applyVeil(veil);

  const blob = new Blob(chunks, { type: 'video/webm' });
  let mode = 'blob';
  let playErr = '';
  let liveRaf = 0;
  if (blob.size > 1000) {
    const url = URL.createObjectURL(blob);
    video.dataset.testUrl = url;
    video.src = url;
  } else {
    // 录制器没吐出数据时退回实时流：同样是真实 <video> 解码渲染，画布持续推帧
    mode = 'live-stream';
    const live = document.createElement('canvas');
    live.width = W; live.height = H;
    const lctx = live.getContext('2d');
    const drawLive = () => {
      lctx.fillStyle = '#ff0000'; lctx.fillRect(0, 0, W / 2, H / 2);
      lctx.fillStyle = '#00ff00'; lctx.fillRect(W / 2, 0, W / 2, H / 2);
      lctx.fillStyle = '#0000ff'; lctx.fillRect(0, H / 2, W / 2, H / 2);
      lctx.fillStyle = '#ffff00'; lctx.fillRect(W / 2, H / 2, W / 2, H / 2);
      liveRaf = requestAnimationFrame(drawLive);
    };
    drawLive();
    liveRaf = requestAnimationFrame(drawLive);
    video.srcObject = live.captureStream(30);
  }
  try { await video.play(); } catch (e) { playErr = e?.message || String(e); }
  await sleep(700);

  add('测试视频可播放', video.readyState >= 2 && !video.paused && (video.videoWidth || W) >= 300,
    JSON.stringify({ mode, veil, tint, recBytes: blob.size, recChunks: chunks.length, readyState: video.readyState, paused: video.paused, w: video.videoWidth, h: video.videoHeight, playErr }));

  /* 3. 收起所有浮层，保证截图里没有别的东西挡住取证区域 */
  document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
  const scrim = q('.scrim');
  if (scrim) scrim.hidden = true;

  /* 4. 铺一条真实对话，让界面处于正常使用状态（不是在空白首屏上取证） */
  if (!document.querySelector('.msg')) {
    const slot = q('.chat-inner');
    if (slot) {
      slot.insertAdjacentHTML('beforeend',
        '<div class="msg user"><div class="bubble">测一下壁纸透不透</div></div>' +
        '<div class="msg assistant"><div class="prose"><p>视频层在最底下，上面只叠了纯色底板。</p></div></div>');
    }
  }

  /* 5. 记录关键层的实际透明度，供人工核对 */
  const layers = ['.sidebar', '.composer', '.chat-inner', '.prose', '#wallpaperTint'].map((s) => {
    const el = q(s);
    if (!el) return [s, 'missing'];
    const c = getComputedStyle(el);
    return [s, c.backgroundColor, c.backdropFilter || 'none', c.filter || 'none'];
  });
  add('关键层透明度已记录', true, JSON.stringify(layers));
  add('视频层无滤镜无模糊',
    getComputedStyle(video).filter === 'none' && (getComputedStyle(video).backdropFilter || 'none') === 'none',
    `${getComputedStyle(video).filter} / ${getComputedStyle(video).backdropFilter || 'none'}`);

  out.total = out.checks.length;
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.total - out.passed;
  return out;
})();
