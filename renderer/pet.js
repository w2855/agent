/* ═══════════════════════════════════════════════════════════════════════
   ⏸ 桌宠功能已暂停（用户决定，2026-11-14）。代码完好可随时恢复：见 docs/pet-paused.md。
   恢复步骤：
     ① 主进程接线（createPetWindow/petBridge，约 30 行，参考 docs/pet-paused.md）
     ② app.js 事件适配器 emitPetEvent（约 15 行）
     ③ 设置页开关
     ④ 关键帧补漏（tools/pet/pet_generate.py，网关配额恢复后）
     ⑤ 渲染 35 GIF（tools/pet/pet_render.py 直出模式）
   注：本文件当前未接线（main.js/preload.js 无 pet 引用），保持现状，不改任何运行逻辑。
   ═══════════════════════════════════════════════════════════════════════ */

/* ───────── DSH 桌宠运行时：PNG 帧序列播放器 + 动画状态机 + 事件分发 + 交互 ─────────
   事件来源：主进程经 petBridge.onEvent 转发的统一事件（Agent Event Adapter 映射后的结果）。
   事件结构: { type, turnId?, ts } — type 为 PetAnimationState 命名。
   播放器：PNG 帧序列 + canvas + rAF 累计时间调度（真 60fps，规避 GIF 20ms 精度问题）。
   回退链：帧序列缺失 → 同名 GIF（<img> 层）→ idle → 参考图静态。 */
'use strict';

/* ── 动作注册表（与 pet-prompts.json 的 35 动作一致）── */
const ACTIONS = [
  'idle', 'wave', 'happy', 'sleepy', 'confused', 'shy',
  'thinking', 'typing', 'working', 'reading', 'searching', 'waiting', 'processing', 'answering',
  'clicked', 'patted', 'dragging', 'awakened', 'message', 'welcome', 'greeting',
  'success', 'error', 'completed', 'issue_found', 'surprised', 'celebrating', 'encourage',
  'drink', 'eat', 'phone', 'play_cat', 'stretch', 'sleeping', 'dance',
];
const PRIORITY = {          // 数值越大优先级越高
  clicked: 6, patted: 6, dragging: 6, awakened: 6,
  success: 5, error: 5, completed: 5, issue_found: 5, surprised: 5, celebrating: 5, encourage: 5,
  searching: 4, typing: 4, reading: 4,
  thinking: 3, working: 3, waiting: 3, processing: 3, answering: 3, message: 3,
  idle: 1, sleepy: 1,
  drink: 0, eat: 0, phone: 0, play_cat: 0, stretch: 0, sleeping: 0, dance: 0,
  wave: 2, happy: 2, confused: 2, shy: 2, welcome: 2, greeting: 2,
};
const ONE_SHOT = new Set(['clicked', 'patted', 'awakened', 'success', 'error', 'completed',
  'issue_found', 'surprised', 'celebrating', 'encourage', 'wave', 'happy', 'confused', 'shy',
  'welcome', 'greeting', 'message', 'dragging']);

const FPS = 60;
const FRAME_MS = 1000 / FPS;
const IDLE_TIMEOUT = 90_000;   // 无事件 90s → sleepy
const MIN_ONESHOT_MS = 600;    // 一次性动画最短展示

/* ── 播放器 ── */
const canvas = document.getElementById('petCanvas');
const ctx = canvas.getContext('2d');
const fallbackBox = document.getElementById('petFallback');
const fallbackImg = document.getElementById('petFallbackImg');
fallbackImg.src = '../assets/pet/reference/character_master.png';

const frameCache = new Map();   // action → { images: HTMLImageElement[], ready: bool }
let curAction = 'idle';
let curFrames = null;           // 当前播放的帧数组
let curFrameIdx = 0;
let accMs = 0;
let lastTick = 0;
let curPriority = 1;
let oneShotUntil = 0;           // 一次性动画保护期
let baseState = 'idle';         // 被一次性动画打断前的有效状态
let basePriority = 1;
let lastEventAt = Date.now();
let currentTurnId = null;       // 只响应最新 turn 的事件
let gifFallbackShown = false;

function framesDir(action) { return `../assets/pet/final/${action}.frames/`; }

/* 预加载帧序列：帧数来自 manifest.js（pet_render.py 生成，脚本标签方式加载以兼容 file://） */
function loadFrames(action) {
  if (frameCache.has(action)) return frameCache.get(action);
  const entry = { images: [], ready: false };
  frameCache.set(action, entry);
  const info = (window.PET_MANIFEST && window.PET_MANIFEST[action]) || null;
  const count = info ? info.frames : 0;
  if (!count) { entry.failed = true; entry.ready = true; return entry; }
  for (let i = 1; i <= count; i++) {
    const img = new Image();
    const name = `f-${String(i).padStart(4, '0')}.png`;
    img.onload = () => { entry.loaded = (entry.loaded || 0) + 1; };
    img.onerror = () => { entry.missing = (entry.missing || 0) + 1; };
    img.src = framesDir(action) + name;
    entry.images.push(img);
  }
  entry.ready = true;
  return entry;
}

function showGifFallback(action) {
  /* 帧序列不可用：退回同名 GIF <img> 层 */
  const img = new Image();
  img.onerror = () => showStaticFallback();
  img.src = `../assets/pet/final/${action}.gif`;
  gifFallbackShown = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const paint = () => { try { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); } catch { showStaticFallback(); } };
  img.onload = paint;
  img.decode?.().then(paint).catch(() => {});
}

function showStaticFallback() {
  canvas.hidden = true;
  fallbackBox.hidden = false;
}

/* ── 状态机 ── */
function setState(state, opts = {}) {
  if (!ACTIONS.includes(state)) state = 'idle';
  const priority = PRIORITY[state] ?? 1;
  const now = Date.now();
  lastEventAt = now;
  if (opts.turnId !== undefined) {
    // 过期任务的事件直接丢弃，防止旧回合覆盖新回合状态
    if (opts.turnId !== null && currentTurnId !== null && opts.turnId !== currentTurnId
        && state !== 'idle' && PRIORITY[state] < 5) return;
    if (opts.turnId !== null && opts.turnId !== undefined) currentTurnId = opts.turnId;
  }
  // 一次性动画保护期内，低优先级事件不打断
  if (now < oneShotUntil && priority <= curPriority) return;
  if (state === curAction && curPriority === priority) { curAction = state; return; } // 同状态不重建
  if (priority > PRIORITY[baseState] && state !== baseState) {
    // 更高优先级成为新的基础状态
    baseState = state; basePriority = priority;
  } else if (PRIORITY[baseState] > priority && !ONE_SHOT.has(state)) {
    // 低于当前基础状态的循环态：仅当基础态已不是工作态时才降级
    if (['working', 'thinking', 'searching', 'typing', 'reading', 'waiting', 'processing', 'answering']
      .includes(baseState)) return;
  }
  curAction = state;
  curPriority = priority;
  if (ONE_SHOT.has(state)) {
    oneShotUntil = now + MIN_ONESHOT_MS;
  } else {
    oneShotUntil = 0;
    if (priority >= PRIORITY[baseState]) { baseState = state; basePriority = priority; }
  }
  curFrames = loadFrames(state);
  curFrameIdx = 0;
  accMs = 0;
  gifFallbackShown = false;
  canvas.hidden = false;
  fallbackBox.hidden = true;
}

function restoreBase() {
  setState(baseState, { turnId: currentTurnId });
}

/* ── 主循环：rAF + 累计时间（60fps）── */
function tick(ts) {
  const dt = lastTick ? Math.min(ts - lastTick, 100) : FRAME_MS;
  lastTick = ts;
  if (curFrames && curFrames.ready && curFrames.images.length) {
    accMs += dt;
    if (accMs >= FRAME_MS) {
      const step = Math.floor(accMs / FRAME_MS);
      accMs -= step * FRAME_MS;
      curFrameIdx = (curFrameIdx + step) % curFrames.images.length;
    }
    const img = curFrames.images[curFrameIdx];
    if (img && img.complete && img.naturalWidth) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } else if (curFrames.images.every((im) => !im.complete || !im.naturalWidth)) {
      // 全部帧都加载失败 → GIF 回退
      if (!gifFallbackShown) showGifFallback(curAction);
    }
    // 一次性动画播完一圈 → 回基础状态
    if (ONE_SHOT.has(curAction) && Date.now() > oneShotUntil
        && curFrameIdx >= curFrames.images.length - 2) {
      restoreBase();
    }
  } else if (curFrames && curFrames.failed) {
    if (!gifFallbackShown) showGifFallback(curAction);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ── 事件接入：主进程桥（preload 提供 petBridge）── */
function bindBridge() {
  const bridge = window.petBridge || (window.dsh && window.dsh.petBridge);
  if (bridge && typeof bridge.onEvent === 'function') {
    bridge.onEvent((ev) => {
      if (!ev || !ev.type) return;
      setState(ev.type, { turnId: ev.turnId ?? undefined });
    });
    return true;
  }
  return false;
}
if (!bindBridge()) {
  // 桥未就绪（preload 延迟）时重试；仍失败进入本地演示模式
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (bindBridge() || tries > 20) {
      clearInterval(timer);
      if (!window.petBridge && !window.dsh?.petBridge) demoMode();
    }
  }, 500);
}

/* 本地演示模式：?demo=1 或无桥时，自动循环播放动作便于目检 */
function demoMode() {
  const seq = ['idle', 'wave', 'thinking', 'typing', 'success', 'error', 'happy', 'sleepy'];
  let i = 0;
  setState(seq[0]);
  setInterval(() => {
    i = (i + 1) % seq.length;
    setState(seq[i], { turnId: null });
  }, 4000);
}
if (new URLSearchParams(location.search).get('demo') === '1') demoMode();

/* ── 交互：单击 / 双击(摸头) / 拖动 ── */
let downAt = 0, lastClick = 0;
canvas.addEventListener('mousedown', () => {
  document.body.classList.add('pressing');
  downAt = Date.now();
});
canvas.addEventListener('mouseup', () => {
  document.body.classList.remove('pressing');
  const gap = Date.now() - downAt;
  if (gap < 300) {
    const now = Date.now();
    if (now - lastClick < 350) { setState('patted'); lastClick = 0; }  // 双击 = 摸头
    else { lastClick = now; setState('clicked'); }                      // 单击 = 被点击
  }
});

/* ── 待机超时：无事件 90s → sleepy；有新事件自动唤醒 ── */
setInterval(() => {
  if (Date.now() - lastEventAt > IDLE_TIMEOUT
      && !['sleeping', 'sleepy'].includes(curAction)
      && PRIORITY[curAction] <= 1) {
    setState('sleepy');
  }
}, 15_000);

/* ── 迷你按钮：测试态手动触发 ── */
document.body.insertAdjacentHTML('beforeend',
  '<div class="pet-mini"><button id="pmHappy">☺</button><button id="pmDance">♪</button></div>');
document.getElementById('pmHappy').addEventListener('click', () => setState('happy'));
document.getElementById('pmDance').addEventListener('click', () => setState('dance'));

/* 启动：进入 idle */
setState('idle');
