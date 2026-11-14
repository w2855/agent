'use strict';

/* ─────────────────────────────────────────────
   DSH Desktop · 渲染与交互
   状态是唯一真相，DOM 只是投影；所有分支都有真实行为。
   ───────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ico = (name, cls = 'ico') => `<svg class="${cls}"><use href="#${name}"/></svg>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatBytes = (n) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* 默认端点与默认模型（可用上游列表换成别的；默认值不改）。默认 key 不再硬编码在源码里，须由用户在 API 页填写。 */
const MODEL_ID = 'gemini-3.8-flash';
const DEFAULT_API = {
  baseUrl: 'https://jinitai.zh.kg/v1',
  key: '',
  model: MODEL_ID,
};
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/;
const ACCENTS = ['mist', 'daiqing', 'dusk', 'turquoise', 'amber', 'graphite'];
const ARCH_LAYERS = ['experience', 'application', 'domain', 'platform', 'data', 'external'];
const ARCH_LAYER_LABEL = {
  experience: '体验层', application: '应用层', domain: '领域层',
  platform: '平台层', data: '数据层', external: '外部系统',
};
const ARCH_STATUS_LABEL = { planned: '计划中', in_progress: '进行中', done: '已完成', blocked: '受阻' };
const ARCH_KIND_LABEL = {
  module: '模块', service: '服务', component: '组件', data: '数据', interface: '接口',
  agent: 'Agent', asset: '资源', external: '外部', custom: '自定义',
};
const enteredMessages = new WeakSet();
const enteredTools = new WeakSet();
const RETRY_CHOICES = [0, 2, 3, 5];
const LIMITS = {
  maxInput: 120000,
  maxAttachFiles: 8,
  maxAttachBytes: 512 * 1024,
  maxAttachChars: 120000,
  /* 上下文预算（字符）：发给上游的历史总量上限；超出时从最旧开始裁剪，
     裁剪按消息整条进行且只裁最旧端——已发过的前缀保持不变，缓存命中率优先。 */
  maxContextChars: 700000,
  turnTimeoutMs: 190000,
};

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch { return fallback; }
}
function readJson(key, fallback) {
  try { return JSON.parse(readStorage(key, 'null')) ?? fallback; } catch { return fallback; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch (err) { toast(`本地存储写入失败：${err?.message || err}`); return false; }
}

const validModel = (m) => typeof m === 'string' && MODEL_RE.test(m.trim());

function freshSessions(source) {
  if (source === 'preview') return structuredClone(window.DEMO.sessions);
  return [{
    id: 'm-' + Date.now(), title: '新对话', group: '今天',
    state: 'idle', filter: [], messages: [],
  }];
}

function normalizeConnection(raw) {
  const fallback = { source: 'model', api: { ...DEFAULT_API }, verified: false };
  if (!raw || typeof raw !== 'object') return fallback;
  const apiRaw = raw.api && typeof raw.api === 'object' ? raw.api : {};
  const baseUrl = typeof apiRaw.baseUrl === 'string' && apiRaw.baseUrl.trim() ? apiRaw.baseUrl.trim() : DEFAULT_API.baseUrl;
  const key = typeof apiRaw.key === 'string' && apiRaw.key.trim() ? apiRaw.key.trim() : DEFAULT_API.key;
  const model = validModel(apiRaw.model) ? apiRaw.model.trim() : DEFAULT_API.model;
  return {
    source: raw.source === 'preview' ? 'preview' : 'model',
    api: { baseUrl, key, model },
    verified: raw.verified === true,
  };
}

function retrySetting() {
  const n = Number(readStorage('dsh.retries', '3'));
  return RETRY_CHOICES.includes(n) ? n : 3;
}

const state = {
  connection: normalizeConnection(readJson('dsh.conn', null)),
  cache: {},
  sessions: [],
  activeId: '',
  filter: 'all',
  query: '',
  mode: 'now',
  busy: false,
  stopRequested: false,
  collapsed: false,
  theme: readStorage('dsh.theme2', 'light') === 'dark' ? 'dark' : 'light',
  accent: ACCENTS.includes(readStorage('dsh.accent', 'mist')) ? readStorage('dsh.accent', 'mist') : 'mist',
  pending: null,
  pendingTurn: null,
  permission: ['full', 'ask', 'readonly'].includes(readStorage('dsh.perm', 'full')) ? readStorage('dsh.perm', 'full') : 'full',
  attachments: [],
  compacted: new Map(),
  autoApproved: new Set(),
  turns: new Map(),
  activeTurnId: null,
  probeBusy: false,
  /* API 表单里选中的模型（未保存前不影响当前会话） */
  formModel: '',
  /* 模型列表 */
  models: [],
  modelsFor: '',
  modelsAt: 0,
  modelsLoading: false,
  modelsError: '',
  modelsErrorCode: '',
  pendingModel: '',
  /* 工具调用（始终启用，无开关） */
  workspace: readStorage('dsh.workspace', ''),
  toolSpecs: [],
  toolMeta: {},
  agents: [],
  defaultAgentId: '',
  delegApprovals: new Map(),
  /* 项目主体：一个工作区一个项目，由主控 Agent 维护整体架构 */
  project: null,
  projectWorkspace: '',
  projectLoading: false,
  projectError: '',
  projectOpen: false,
  readOnlyTools: new Set(),
  needsApprovalTools: new Set(),
  toolsReady: false,
  toolsLoading: false,
  toolsError: '',
  /* 模型列表 / API 面板 */
  modelReturnSheet: '',
  modelSheetFrom: '',
  probeSig: '',
  probeOk: false,
  /* 多 API 连接 */
  profiles: [],
  activeProfileId: '',
  formProfileId: '',
  vaultOk: false,
  /* 个性化提示词（每轮注入；持久化到 localStorage） */
  customPrompt: readStorage('dsh.customPrompt', ''),
};

/** 等待用户审批的工具调用：msgId -> { resolve, draft, node } */
const approvalWaiters = new Map();

/* 审批弹窗串行化：并行 delegate_task 各自等待确认时，一次只显示一个审批卡片 */
let approvalLock = Promise.resolve();
function withApprovalLock(fn) {
  const run = approvalLock.then(fn, fn);
  approvalLock = run.then(() => {}, () => {});
  return run;
}

/* ───────── 会话持久化（按来源分开存；工具结果体积大，落盘前裁剪） ───────── */
const SESSIONS_KEY = (source) => source === 'preview' ? 'dsh.sessions.preview' : 'dsh.sessions.model';
const SESSION_SAVE_MAX_MESSAGES = 200;
const SESSION_SAVE_RESULT_CHARS = 4000;

let storageWarned = false;
function saveSessions() {
  const source = sourceOf();
  try {
    const slim = state.sessions.map((s) => ({
      ...s,
      messages: (s.messages || []).slice(-SESSION_SAVE_MAX_MESSAGES).map((m) => {
        const copy = { ...m };
        if (Array.isArray(copy.tools)) {
          copy.tools = copy.tools.map((t) => ({ ...t, result: String(t.result || '').slice(0, SESSION_SAVE_RESULT_CHARS) }));
        }
        return copy;
      }),
    }));
    writeStorage(SESSIONS_KEY(source), JSON.stringify({ sessions: slim, activeId: state.activeId }));
    storageWarned = false;
  } catch {
    // 存储满：不静默吞掉，但也只提示一次，避免每回合刷屏
    if (!storageWarned) {
      storageWarned = true;
      toast('本地存储写入失败，最近的会话可能没有保存。请清理旧会话或其他应用数据后重试');
    }
  }
}

function loadSavedSessions(source) {
  try {
    const raw = readStorage(SESSIONS_KEY(source), null);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.sessions) || !data.sessions.length) return null;
    for (const s of data.sessions) {
      if (!Array.isArray(s.messages)) s.messages = [];
      for (const m of s.messages) registerMsg(m);
    }
    return data;
  } catch { return null; }
}

state.sessions = freshSessions(state.connection.source);
state.activeId = state.sessions[0].id;
{
  const saved = loadSavedSessions(state.connection.source);
  if (saved) {
    state.sessions = saved.sessions;
    state.activeId = saved.sessions.some((s) => s.id === saved.activeId)
      ? saved.activeId : saved.sessions[0].id;
  }
}
state.pendingModel = state.connection.api.model;

const msgStore = new Map();
let msgSeq = 0;
const registerMsg = (msg) => {
  if (!msg.id) msg.id = 'msg-' + (++msgSeq);
  msgStore.set(msg.id, msg);
  return msg.id;
};
// 释放不再被任何会话引用的消息（上下文压缩会整批替换 messages，不清理则旧消息对象永远无法回收）
function pruneMsgStore() {
  const live = new Set();
  for (const s of state.sessions) for (const m of s.messages || []) if (m.id) live.add(m.id);
  for (const id of msgStore.keys()) if (!live.has(id)) msgStore.delete(id);
}

const sourceOf = () => state.connection.source;
const currentModel = () => state.connection.api?.model || DEFAULT_API.model;
const formModel = () => (validModel(state.formModel) ? state.formModel : currentModel());
const retryConfig = () => ({ maxAttempts: retrySetting() + 1 });
const apiCfg = () => ({
  baseUrl: $('#apiBaseUrl').value.trim(),
  key: $('#apiKey').value.trim(),
  model: formModel(),
  retry: retryConfig(),
});
const cfgSig = (cfg) => [cfg?.baseUrl, cfg?.key, cfg?.model].map((v) => String(v ?? '').trim()).join('|');
const active = () => state.sessions.find((s) => s.id === state.activeId) || state.sessions[0];

function validateBaseAndKey(cfg) {
  const raw = String(cfg?.baseUrl ?? '').trim();
  if (!raw) return '请填写 API 地址';
  if (/\s/.test(raw)) return 'API 地址不能包含空格';
  // 只有「裸域名」才自动补 https；带了协议却不合法时必须拒绝，不能靠补前缀蒙混过关
  if (raw.includes('://') && !/^https?:\/\//i.test(raw)) return 'API 地址只支持 http/https';
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); }
  catch { return 'API 地址不是合法 URL'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'API 地址只支持 http/https';
  if (!u.hostname || !/^[a-z0-9.\-:\[\]]+$/i.test(u.hostname)) return 'API 地址主机名不合法';
  if (!String(cfg.key ?? '').trim()) return '请填写 API Key';
  return null;
}

function validateApiInput(cfg) {
  const baseErr = validateBaseAndKey(cfg);
  if (baseErr) return baseErr;
  if (!validModel(cfg?.model)) return '请选择或填写合法模型名';
  return null;
}

/* ───────── 主题 / 配色 ───────── */

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  $('#brandGlyph').src = state.theme === 'dark' ? '../assets/glyph-dark.svg' : '../assets/glyph-light.svg';
  writeStorage('dsh.theme2', state.theme);
  $$('#themeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.theme === state.theme));
  if (state.projectOpen) renderArchPage();
}

function applyAccent(accent) {
  state.accent = ACCENTS.includes(accent) ? accent : 'mist';
  document.documentElement.dataset.accent = state.accent;
  writeStorage('dsh.accent', state.accent);
  $$('#accentRow .accent').forEach((b) => b.classList.toggle('is-active', b.dataset.accent === state.accent));
  if (state.projectOpen) renderArchPage();
}

/* ───────── 权限级别 ───────── */

const PERM_LABELS = { full: '完全权限', ask: '每次询问', readonly: '只读' };
const PERM_PROMPT = {
  full: '权限级别：完全权限。可以读写文件、执行命令，不需要逐次确认。',
  ask: '权限级别：每次询问。写入文件或执行命令前必须先获得用户确认；读取、搜索与联网可直接进行。',
  readonly: '权限级别：只读。不得写入文件或执行命令，只能读取、搜索、联网与分析。',
};

function renderPerm() {
  const btn = $('#permBtn');
  if (!btn) return;
  btn.dataset.level = state.permission;
  $('#permName').textContent = PERM_LABELS[state.permission];
  $$('#permMenu .menu-item').forEach((m) => m.classList.toggle('is-active', m.dataset.perm === state.permission));
}

function setPermission(level) {
  if (!PERM_LABELS[level]) return;
  state.permission = level;
  writeStorage('dsh.perm', level);
  renderPerm();
  toast(`权限级别：${PERM_LABELS[level]}`);
}

/* ───────── 顶栏 / 侧栏投影 ───────── */

function sessionMatches(s) {
  if (state.filter === 'all') return true;
  if ((s.filter || []).includes(state.filter)) return true;
  if (state.filter === 'running') return s.state === 'running';
  if (state.filter === 'pending') return s.state === 'pending';
  if (state.filter === 'unread') return s.unread === true;
  return false;
}

function renderSessions() {
  const box = $('#sessions');
  const q = state.query.trim().toLowerCase();
  const list = state.sessions.filter((s) => {
    if (q && !String(s.title).toLowerCase().includes(q)) return false;
    return sessionMatches(s);
  });

  if (!list.length) {
    box.innerHTML = `<div class="group-label">${state.sessions.length ? '没有匹配的会话' : '还没有会话'}</div>`;
    return;
  }

  // 按分组聚合，避免筛选后相邻项造成分组标题重复/错乱
  const groups = new Map();
  for (const s of list) {
    const g = s.group || '其它';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }

  let html = '';
  for (const [group, items] of groups) {
    html += `<div class="group-label">${esc(group)}</div>`;
    for (const s of items) {
      const running = s.state === 'running';
      const pending = s.state === 'pending';
      html += `
        <div class="session ${s.id === state.activeId ? 'is-active' : ''}" data-id="${esc(s.id)}">
          ${running ? '<span class="s-spin"></span>' : pending ? '<span class="s-badge"></span>' : s.unread ? '<span class="s-unread"></span>' : '<span class="s-empty"></span>'}
          <span class="s-title">${esc(s.title)}</span>
          <button class="s-del ${deleteArmed.has(s.id) ? 'is-armed' : ''}" data-del="${esc(s.id)}" title="删除会话">${deleteArmed.has(s.id) ? '确认?' : '×'}</button>
        </div>`;
    }
  }
  box.innerHTML = html;
}

/* 会话删除：两段确认（3 秒内再点一次），运行中的会话不可删 */
const deleteArmed = new Set();
function deleteSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  if (s.state === 'running' || s.state === 'pending') { toast('该会话正在运行，结束后才能删除'); return; }
  if (s.id === state.activeId && state.busy) { toast('生成中不能删除当前会话'); return; }
  if (!deleteArmed.has(id)) {
    deleteArmed.add(id);
    setTimeout(() => { if (deleteArmed.delete(id)) renderSessions(); }, 3000);
    renderSessions();
    toast('再点一次确认删除');
    return;
  }
  deleteArmed.delete(id);
  state.sessions = state.sessions.filter((x) => x.id !== id);
  if (!state.sessions.length) {
    // 全删光时兜底留一个空会话，与启动时的初始状态一致
    state.sessions.unshift({
      id: (sourceOf() === 'model' ? 'm-' : 'p-') + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      title: '新对话', group: '今天', state: 'idle', messages: [],
    });
  }
  const wasActive = state.activeId === id;
  if (wasActive) state.activeId = state.sessions[0].id;
  pruneMsgStore();
  saveSessions();
  renderSessions();
  if (wasActive) {
    resetComposer();
    restoreDraft();
    renderHeader();
    renderTodoPanel();
    renderChat();
  }
  toast('已删除会话');
}

function renderHeader() {
  const s = active();
  if (!s) return;
  $('#title').textContent = s.title || '新对话';
  const label = sourceOf() === 'model' ? currentModel() : '离线预览';
  $('#modelName').textContent = label;
  const running = s.state === 'running';
  $('#subtitle').textContent = `${label} · ${state.busy || running ? '生成中' : '就绪'}`;
  $('#titleDot').className = 'dot' + (state.busy || running ? ' live' : ' ok');
  const goalEl = $('#goalLine');
  if (goalEl) {
    if (s.goal?.trim()) {
      goalEl.textContent = `目标：${s.goal.trim()}`;
      goalEl.hidden = false;
    } else {
      goalEl.hidden = true;
    }
  }
}

function renderHost() {
  const c = state.connection;
  if (sourceOf() === 'model') {
    let host = c.api.baseUrl;
    try { host = new URL(/^https?:\/\//i.test(c.api.baseUrl) ? c.api.baseUrl : 'https://' + c.api.baseUrl).host; } catch { /* 原样显示 */ }
    $('#hostName').textContent = currentModel();
    $('#hostState').textContent = c.verified ? '接口已验证' : '待验证';
    $('#connBadge').innerHTML = `<i class="dot"></i>${c.verified ? '模型 API 已连接' : '模型 API · 未验证'}`;
    $('#connBadge').classList.toggle('live', !!c.verified);
    $('#connSummary').textContent = `${currentModel()} · ${host}${c.verified ? ' · 探活通过' : ' · 未验证'}`;
  } else {
    $('#hostName').textContent = '本机';
    $('#hostState').textContent = '离线预览';
    $('#connBadge').innerHTML = `<i class="dot"></i>离线预览`;
    $('#connBadge').classList.remove('live');
    $('#connSummary').textContent = '离线预览 · 不发网络请求';
  }
}

/* ───────── Markdown（够用就好的子集，输入先转义） ───────── */

function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // 边界含中文标点：否则「、*斜体*、」这类紧跟中文标点的斜体不生效
    .replace(/(^|[\s(、，。！？：；【】（）“”‘’《》—…])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function markdown(src) {
  try {
    const lines = esc(src).split('\n');
    const out = [];
    let list = null;
    let code = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (const line of lines) {
      if (line.startsWith('```')) {
        if (code === null) { closeList(); code = []; }
        else { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; }
        continue;
      }
      if (code !== null) { code.push(line); continue; }
      if (!line.trim()) { closeList(); continue; }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { closeList(); out.push(`<p><strong>${inline(h[2])}</strong></p>`); continue; }
      const ul = line.match(/^[-*]\s+(.*)$/);
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ul || ol) {
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
        continue;
      }
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
    if (code !== null) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
    closeList();
    return out.join('');
  } catch (err) {
    // 单条消息渲染出错时降级为纯文本，不拖垮整个会话区（参考 ZCode markdown 错误边界）
    console.warn('[markdown] 渲染失败，已降级为纯文本', err);
    return `<p>${esc(src)}</p>`;
  }
}

/* ───────── 流式增量渲染：稳定块只解析一次，活动尾低开销重绘（参考 aider mdstream 滑动窗口） ───────── */

// 返回稳定前缀切点：前缀只含已完结块（空行收尾），不含未闭合代码围栏——切在围栏开始之前
function stableBoundary(src) {
  let i = 0, safe = 0, safeBeforeFence = 0, inFence = false;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const end = nl === -1 ? src.length : nl + 1;
    const line = src.slice(i, end);
    if (line.startsWith('```')) {
      if (!inFence) { safeBeforeFence = safe; inFence = true; }
      else inFence = false;
    } else if (!inFence && !line.trim()) {
      safe = end; // 空行收尾的块可整体进入稳定区
    }
    i = end;
  }
  return inFence ? safeBeforeFence : safe;
}

// 两条流式路径共用：稳定块落 div.md-stable（边界推进时才重解析），活动尾落 div.md-live（每帧只解析小段），光标常驻不重建
function createStreamPainter(prose) {
  const stableEl = document.createElement('div');
  stableEl.className = 'md-stable';
  const liveEl = document.createElement('div');
  liveEl.className = 'md-live';
  const caret = document.createElement('span');
  caret.className = 'caret';
  prose.replaceChildren(stableEl, liveEl, caret);
  let stableLen = -1;
  let lastTailPaint = 0;
  return {
    // 首个 token 到达前的思考指示（三点波浪），第一个 paint 自然把它冲掉
    think() {
      liveEl.innerHTML = '<span class="thinking"><i></i><i></i><i></i></span>';
    },
    paint(body) {
      const cut = stableBoundary(body);
      if (cut !== stableLen) {
        stableEl.innerHTML = markdown(body.slice(0, cut));
        stableLen = cut;
      }
      const tail = body.slice(cut);
      const now = performance.now();
      if (tail.length > 4000 && now - lastTailPaint < 120) return; // 超长单段降频，防退化成 O(n²)
      lastTailPaint = now;
      // 未闭合代码围栏：直接按 pre 渲染，不反复走 markdown 循环
      if (tail.startsWith('```')) {
        const nl = tail.indexOf('\n');
        liveEl.innerHTML = `<pre><code>${esc(nl === -1 ? '' : tail.slice(nl + 1))}</code></pre>`;
      } else {
        liveEl.innerHTML = markdown(tail);
      }
    },
  };
}

/* ───────── 消息渲染 ───────── */

function toolRow(t) {
  const status = t.status || 'ok';
  const fresh = !enteredTools.has(t);
  if (fresh) enteredTools.add(t);
  const cls = [
    'tool',
    fresh ? 'is-enter' : '',
    status === 'running' ? 'is-running' : '',
    status === 'error' ? 'is-error' : '',
    status === 'denied' ? 'is-denied' : '',
    (t.result || t.args) ? 'is-expandable' : '',
  ].filter(Boolean).join(' ');
  const canExpand = !!(t.result || t.args);
  return `
    <div class="${cls}" data-tool-id="${esc(t.id || '')}" ${canExpand ? 'title="点击查看参数与结果"' : ''}>
      <span class="t-ico" style="--tone: var(--tone-${esc(t.tone)})">${ico(esc(t.icon || 'i-terminal'))}</span>
      <span class="t-verb" style="--tone: var(--tone-${esc(t.tone)})">${esc(t.verb)}</span>
      <span class="t-target">${esc(t.target)}</span>
      <span class="t-meta">${esc(t.meta || '')}</span>
      ${status === 'running' ? '<span class="t-spin"></span>' : ''}
      ${canExpand ? `<span class="t-open">${ico(t.expanded ? 'i-chevron' : 'i-chevron-right', 'ico tiny')}</span>` : ''}
    </div>
    ${t.expanded ? toolDetail(t) : ''}`;
}

function prettyJson(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function toolDetail(t) {
  const args = t.args && Object.keys(t.args).length ? prettyJson(t.args) : '（无参数）';
  const result = t.result ? String(t.result) : (t.error || '（暂无结果）');
  const cut = result.length > 6000 ? result.slice(0, 6000) + '\n…（结果过长，界面只显示前 6000 字符）' : result;
  return `
    <div class="tool-detail">
      <div class="td-label">参数</div>
      <pre>${esc(args)}</pre>
      <div class="td-label">结果</div>
      <pre>${esc(cut)}</pre>
    </div>`;
}

/* ───────── 任务清单 ───────── */

const TASK_STATUS_TEXT = { pending: '待办', in_progress: '进行中', completed: '已完成' };

function taskCard(tasks) {
  if (!tasks || !tasks.length) return '';
  const done = tasks.filter((t) => t.status === 'completed').length;
  const rows = tasks.map((t, i) => {
    const mark = t.status === 'completed'
      ? ico('i-check')
      : t.status === 'in_progress' ? '<span class="t-spin"></span>' : `<i>${i + 1}</i>`;
    return `
      <div class="task-item is-${esc(t.status)}">
        <span class="task-dot">${mark}</span>
        <span class="task-text">${esc(t.content)}</span>
        <span class="task-status">${esc(TASK_STATUS_TEXT[t.status] || t.status)}</span>
      </div>`;
  }).join('');
  return `
    <div class="tasks-card">
      <div class="tasks-head">${ico('i-checklist')}<b>任务清单</b><span>${done}/${tasks.length}</span></div>
      ${rows}
    </div>`;
}

function renderTasks(node, msg) {
  const slot = $('.slot-tasks', node);
  if (slot) slot.innerHTML = taskCard(msg.tasks);
}

function renderTools(node, msg) {
  const box = $('.tools', node);
  if (!box) return;
  box.innerHTML = (msg.tools || []).map(toolRow).join('');
}

function fileIconFor(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (/^(xlsx?|csv|tsv|ods)$/.test(ext)) return 'i-sheet';
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(ext)) return 'i-image';
  if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz)$/.test(ext)) return 'i-package';
  if (/^(js|jsx|ts|tsx|py|go|rs|java|c|h|cpp|cs|rb|php|sh|bat|sql|html?|css)$/.test(ext)) return 'i-code';
  return 'i-file';
}

function noteWrittenFile(draft, pathText, meta) {
  const name = String(pathText || '').split(/[\\/]/).filter(Boolean).pop() || String(pathText || '');
  if (!name) return;
  const entry = { name, meta: meta || '已写入', kind: String(name).split('.').pop().toLowerCase(), icon: fileIconFor(name) };
  const existing = (draft.files || []).find((f) => f.name === name);
  if (existing) Object.assign(existing, entry);
  else draft.files.push(entry);
}

function filesCard(files) {
  if (!files || !files.length) return '';
  const rows = files.map((f, i) => `
      <div class="file" title="${esc(f.name)}">
        <span class="file-ico ${esc(f.kind)}">${ico(f.icon || 'i-file')}</span>
        <span class="file-body"><b>${esc(f.name)}</b><small>${esc(f.meta || '')}</small></span>
        <button class="icon-btn" data-file-more="${i}" title="查看文件信息">${ico('i-more')}</button>
      </div>`).join('');
  return `<div class="files"><div class="files-head">${ico('i-package')}交付了 ${files.length} 个文件</div>${rows}</div>`;
}

function approvalCard(a) {
  if (!a) return '';
  const done = !!a.outcome;
  return `
    <div class="approval ${done ? 'done' : ''}">
      <div class="approval-head">${ico(done ? (a.outcome === 'deny' ? 'i-close' : 'i-check') : 'i-shield')}${esc(done ? a.label : a.title)}</div>
      <p>${esc(a.text)}</p>
      <p><code>${esc(a.command)}</code></p>
      ${done ? '' : `
      <div class="approval-actions">
        <button class="btn primary" data-approve="once">允许一次</button>
        <button class="btn ghost" data-approve="always">本次会话都允许</button>
        <button class="btn soft" data-approve="deny">拒绝</button>
      </div>`}
    </div>`;
}

function summaryText(sm) {
  if (sm.label === '进行中') return '<span>思考中…</span>';
  if (sm.label === '重试中') return '<span>连接中断，正在自动重试…</span>';
  const icon = sm.label === '调用失败' ? 'i-close'
    : sm.label === '校验失败' ? 'i-alert'
      : sm.label === '已中断' ? 'i-stop'
        : sm.label === '上下文已压缩' ? 'i-package' : 'i-check';
  const parts = [];
  if (sm.tools) parts.push(`${sm.tools} 次工具调用`);
  if (sm.messages) parts.push(`${sm.messages} 条消息`);
  const tail = parts.length ? `<span class="s-sep">·</span><span>${parts.join(' · ')}</span>` : '';
  return `<span>${ico(icon)}${esc(sm.label)}</span>${tail}`;
}

function assistantNode(msg) {
  const node = document.createElement('div');
  node.className = 'msg assistant';
  node.dataset.msgId = registerMsg(msg);

  const hasTools = !!(msg.tools && msg.tools.length);
  const summaryCls = hasTools ? 'summary' : 'summary collapsed';
  const toolsCls = hasTools ? 'tools' : 'tools hidden';
  node.innerHTML = `
    <button class="${summaryCls}" ${hasTools ? '' : 'data-empty="1"'}>
      ${summaryText(msg.summary)}
      ${ico('i-chevron', 'ico tiny chev')}
    </button>
    <div class="slot-tasks"></div>
    <div class="${toolsCls}"></div>
    <div class="slot-retry"></div>
    <div class="slot-approval">${approvalCard(msg.approval)}</div>
    <div class="prose"></div>
    <div class="slot-files">${filesCard(msg.files)}</div>
    <div class="slot-metrics">${msg.metrics ? `<div class="metrics">${esc(msg.metrics)} ${ico('i-chevron-right', 'ico tiny')}</div>` : ''}</div>
    <div class="msg-actions"><button data-copy-msg title="复制全文"><svg class="ico tiny"><use href="#i-copy"/></svg></button></div>
  `;

  if (msg.body) $('.prose', node).innerHTML = markdown(msg.body);
  renderTasks(node, msg);
  renderTools(node, msg);

  const summary = $('.summary', node);
  summary?.addEventListener('click', () => {
    if (summary.dataset.empty) return;
    const tools = $('.tools', node);
    tools.classList.toggle('hidden');
    summary.classList.toggle('collapsed', tools.classList.contains('hidden'));
    // 标记用户手动操作过折叠区：流式回合中 runApiTurn 的自动收起据此跳过（ZCode 规则）
    node.dataset.toolsTouched = '1';
  });
  return node;
}

function userNode(msg) {
  const node = document.createElement('div');
  node.className = 'msg user';
  node.dataset.msgId = registerMsg(msg);
  const chips = (msg.attachments || []).map((a) =>
    `<span class="attach-inline ${a.error ? 'is-error' : ''}" title="${esc(a.error || a.name)}">${ico('i-file')}${esc(a.name)}</span>`
  ).join('');
  node.innerHTML = `<div class="bubble">${esc(msg.text)}${chips ? `<div class="attach-inline-row">${chips}</div>` : ''}</div>`;
  return node;
}

function emptyNode() {
  const node = document.createElement('div');
  node.className = 'empty';
  const preview = sourceOf() === 'preview';
  const project = state.project?.project;
  const projectSuggest = (!preview && project)
    ? `<button class="suggest">${state.project.live?.nodes?.length ? '继续推进项目整体架构' : '让主 Agent 规划这个项目的整体架构'}</button>`
    : '';
  node.innerHTML = `
    <img src="../assets/whale-happy.png" alt="" />
    <h2>有什么可以帮你的？</h2>
    <p>${preview ? '离线预览模式：下面是示例会话，发送不会调用模型。' : `已连接 ${esc(currentModel())}，直接提问即可。`}</p>
    <div class="suggests">
      ${projectSuggest}
      ${customPromptBadge()}
      <button class="suggest">把这个月的花销做成表和图</button>
      <button class="suggest">帮我把这段代码改成异步</button>
      <button class="suggest">整理这周的读书笔记</button>
      <button class="suggest">用一句话解释事件溯源</button>
    </div>`;
  $$('.suggest', node).forEach((b) =>
    b.addEventListener('click', () => {
      if (b.id === 'customPromptBadge') {
        openSheet('settingsSheet');
        $('#customPromptInput')?.focus();
        return;
      }
      $('#input').value = b.textContent;
      autoGrow();
      updateSendState();
      send(); // 点击建议直接发送，免去第二次点击
    })
  );
  return node;
}

function renderChat() {
  const chat = $('#chat');
  chat.innerHTML = '<div class="chat-inner"></div>';
  const inner = $('.chat-inner', chat);
  const s = active();
  if (!s || !s.messages.length) {
    inner.appendChild(emptyNode());
    stickBottom = true;
    return;
  }
  for (const m of s.messages) {
    const node = m.role === 'user' ? userNode(m) : assistantNode(m);
    if (!enteredMessages.has(m)) {
      enteredMessages.add(m);
      node.classList.add('is-enter');
    }
    inner.appendChild(node);
  }
  scrollToBottom(true);
}

let stickBottom = true;
function scrollToBottom(force = false) {
  const chat = $('#chat');
  if (!chat) return;
  if (force || stickBottom) chat.scrollTop = chat.scrollHeight;
  if (force) stickBottom = true;
}

/* ───────── 会话切换 / 新建 / 来源切换 ───────── */

function resetComposer() {
  $('#input').value = '';
  autoGrow();
  updateSendState();
  hideMenus();
}

/* ───────── 草稿按会话持久化：切会话/重启不丢（localStorage dsh.drafts，单条上限 5000 字符防体积失控） ───────── */
let draftTimer = null;
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      const s = active();
      if (!s) return;
      const drafts = JSON.parse(readStorage('dsh.drafts', '{}')) || {};
      const text = $('#input').value;
      if (text && text.length <= 5000) drafts[s.id] = text;
      else delete drafts[s.id];
      writeStorage('dsh.drafts', JSON.stringify(drafts));
    } catch { /* 草稿保存失败不影响输入 */ }
  }, 400);
}
function clearDraft() {
  clearTimeout(draftTimer);
  try {
    const s = active();
    if (!s) return;
    const drafts = JSON.parse(readStorage('dsh.drafts', '{}')) || {};
    if (drafts[s.id] !== undefined) {
      delete drafts[s.id];
      writeStorage('dsh.drafts', JSON.stringify(drafts));
    }
  } catch { /* 同上 */ }
}
function restoreDraft() {
  let text = '';
  try {
    const s = active();
    const drafts = s ? (JSON.parse(readStorage('dsh.drafts', '{}')) || {}) : {};
    text = s ? (drafts[s.id] || '') : '';
  } catch { text = ''; }
  $('#input').value = text;
  autoGrow();
  updateSendState();
}

function selectSession(id) {
  if (state.busy) { toast('请先结束当前回合再切换会话'); return; }
  if (!state.sessions.some((s) => s.id === id)) return;
  state.activeId = id;
  saveSessions();
  const picked = active();
  if (picked) picked.unread = false;
  state.query = '';
  $('#searchInput').value = '';
  state.attachments = [];
  renderAttachments();
  resetComposer();
  restoreDraft(); // 切回会话时恢复未发送的草稿
  renderSessions();
  renderHeader();
  renderTodoPanel();
  renderChat();
  if (state.projectOpen) { archSessionState(); renderArchPage(); }
}

function newChat() {
  if (state.busy) { toast('请先结束当前回合再新建会话'); return; }
  const id = (sourceOf() === 'model' ? 'm-' : 'p-') + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  state.sessions.unshift({
    id, title: '新对话', group: '今天', state: 'idle', filter: [], messages: [],
  });
  state.activeId = id;
  saveSessions();
  state.filter = 'all';
  state.query = '';
  $('#searchInput').value = '';
  $$('.chip', $('#filters')).forEach((c) => c.classList.toggle('is-active', c.dataset.filter === 'all'));
  state.attachments = [];
  renderAttachments();
  resetComposer();
  renderSessions();
  renderHeader();
  renderChat();
  $('#input').focus();
  toast('已新建会话');
  if (state.projectOpen) { archSessionState(); renderArchPage(); }
}

function switchSource(next) {
  if (next === sourceOf()) return;
  if (state.busy) { toast('请先结束当前回合再切换来源'); return; }
  saveSessions();
  const cached = state.cache[next];
  const saved = loadSavedSessions(next);
  const restored = cached || saved;
  state.sessions = restored ? restored.sessions : freshSessions(next);
  state.activeId = restored?.activeId && state.sessions.some((s) => s.id === restored.activeId)
    ? restored.activeId : state.sessions[0].id;
  state.cache[next] = { sessions: state.sessions, activeId: state.activeId };
  saveSessions();
  state.pending = null;
  state.pendingTurn = null;
  $('#queue').hidden = true;
  state.attachments = [];
  renderAttachments();
  resetComposer();
  renderSessions();
  renderHeader();
  renderHost();
  renderChat();
  if (state.projectOpen) { archSessionState(); renderArchPage(); }
}

/* ───────── 上下文构造 ───────── */

function pickScript(text) {
  return window.DEMO.scripts.find((s) => s.match.test(text)) || window.DEMO.scripts.at(-1);
}

function formatAttachments() {
  if (!state.attachments.length) return '';
  const parts = state.attachments.map((a) => {
    if (a.error) return `[附件 ${a.name}：${a.error}，未纳入上下文]`;
    if (a.text) return `--- 文件：${a.name} ---\n${a.text}${a.truncated ? '\n…（内容已截断）' : ''}`;
    return `[附件 ${a.name}：${a.kind || '二进制文件'}，${formatBytes(a.size)}，二进制内容未纳入上下文]`;
  });
  return '\n\n' + parts.join('\n\n');
}

function projectPromptText() {
  const data = state.project;
  if (!data?.project || !state.workspace || state.projectWorkspace !== state.workspace) return '';
  const p = data.project;
  const live = data.live || {};
  const lines = [];
  lines.push(`你是项目「${p.name}」的主控 Agent（${live.mainAgent?.name || p.mainAgentId || '默认 Agent'}）。`);
  lines.push(`项目工作区：${p.workspace}`);
  if (p.goal) lines.push(`项目目标：${p.goal}`);
  if (p.techStack?.length) lines.push(`技术栈：${p.techStack.join('、')}`);
  const nodes = Array.isArray(live.nodes) ? live.nodes : [];
  if (!nodes.length) {
    lines.push('整体架构尚未建立。用户提出项目级目标时，先理解需求并调用 project_architecture 提交分层模块、依赖与里程碑，再开始编码。');
  } else {
    lines.push(`整体架构（revision ${p.revision}，${nodes.length} 个模块 / ${live.stats?.edges ?? p.edges?.length ?? 0} 条依赖）：`);
    for (const layer of ARCH_LAYERS) {
      const list = nodes.filter((n) => n.layer === layer);
      if (!list.length) continue;
      lines.push(`${ARCH_LAYER_LABEL[layer]}：${list.map((n) => `${n.label}(${n.effectiveStatus || n.status})`).join('、')}`);
    }
    lines.push('调整整体架构时调用 project_architecture（默认 merge；需要整体重排时 mode=replace）。模块对应子任务时填写 taskId。');
  }
  lines.push('项目级工作顺序：维护整体架构 → 用 todo_write 制定计划 → 用 delegate_task 把自包含模块任务分给子 Agent → 汇总结果并回填架构状态。');
  return lines.join('\n');
}

function buildApiMessages(session, currentText, draft, skipUser) {
  const out = [{
    role: 'system',
    content: '你是 DSH 桌面助手，用简体中文回答。回复简洁、结构化，可用 Markdown。'
      + '你可以使用系统提供的工具读写本地文件、搜索、执行命令或访问网页；需要时直接调用工具，'
      + '工具结果由系统返回。任务清单（todo_write）由你自行判断是否使用：任务复杂、步骤较多时可以建立清单并更新进度。'
      + '不要虚构工具调用、工具结果或文件产出。'
      + '调用工具前先用一句话（不超过 20 字）说明你接下来要做什么，让用户知道进展；连续同类工具调用不必反复说明；'
      + '关键工具结束后用一句话报告结果或下一步。',
  }, {
    role: 'system',
    content: PERM_PROMPT[state.permission],
  }];
  if (state.toolSpecs.length && state.workspace) {
    out.push({ role: 'system', content: `工具工作目录：${state.workspace}。相对路径都以此为根。` });
  }
  const projectPrompt = projectPromptText();
  if (projectPrompt) out.push({ role: 'system', content: projectPrompt });
  // 个性化提示词：用户自定义指令，每轮注入、优先遵守
  if (state.customPrompt?.trim()) {
    out.push({ role: 'system', content: `用户的个性化提示词（用户自定义，优先遵守）：\n${state.customPrompt.trim()}` });
  }
  // 会话目标：/goal 设置，每轮注入
  if (session.goal?.trim()) {
    out.push({ role: 'system', content: `本会话目标：${session.goal.trim()}` });
  }
  const delegateTargets = state.agents.filter((a) => a.status === 'active' && a.id !== state.defaultAgentId);
  if (state.toolSpecs.some((s) => s.function?.name === 'delegate_task')) {
    const lines = delegateTargets.map((a) => `- ${a.id} · ${a.name} · 权限 ${a.version?.permissionProfileId || '?'}`);
    const models = (state.models || []).map((m) => m.id).filter(validModel).slice(0, 12);
    out.push({
      role: 'system',
      content: `可委派 Agent：\n${lines.length ? lines.join('\n') + '\n' : ''}`
        + `可用模型：${models.length ? models.join(', ') : '（未获取到模型列表，委派时不要传 model）'}\n`
        + 'delegate_task 用法：agentId 省略或传 "new"/"auto" 时会自动创建一个新子 Agent（名称取自目标、权限继承当前档位、模型由你通过 model 参数从上面的可用模型中选择）；'
        + '也可以指定上面已有 Agent 的 ID。多个 delegate_task 可以在同一轮并行发起，子任务会同时运行。'
        + '仅当子任务自包含、适合独立 Agent 时使用。子 Agent 看不到当前对话；'
        + 'objective 必须写清背景、输入与目标，expectedOutput 写清验收标准，contextRefs 只放确实需要共享的工作区文件。',
    });
  }
  const compacted = state.compacted.get(session.id);
  if (compacted) out.push({ role: 'system', content: `以下是此前对话的压缩摘要，供你延续上下文：\n${compacted}` });
  /* 历史消息按字符预算从最新往回取，再按原顺序发出。
     只裁最旧端保证每次请求的前缀（system→旧消息）与上一轮尽可能一致，
     这是上游 prompt 缓存能命中的关键；命中率高则便宜且快。 */
  const budget = LIMITS.maxContextChars;
  const picked = [];
  let used = 0;
  const all = session.messages;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m === draft || m === skipUser || m.compacted) continue;
    const text = m.role === 'user' ? (m.text || '') + (m.apiSuffix || '') : (m.body || '');
    if (!text) continue;
    const size = text.length;
    if (used + size > budget && picked.length) break;
    picked.push({ role: m.role, content: text });
    used += size;
  }
  for (let i = picked.length - 1; i >= 0; i--) out.push(picked[i]);
  out.push({ role: 'user', content: currentText });
  return out;
}

/* ───────── 回合 ───────── */

async function runTurn(rawText) {
  if (state.busy) { toast('上一轮尚未结束'); return; }
  const text = String(rawText ?? '').trim();
  if (!text) return;
  if (text.length > LIMITS.maxInput) {
    toast(`输入过长（${text.length} 字符），上限 ${LIMITS.maxInput}`);
    return;
  }

  const s = active();
  state.busy = true;
  state.stopRequested = false;
  s.state = 'running';
  if (!s.messages.length) $('#chat').innerHTML = '<div class="chat-inner"></div>';
  if (s.title === '新对话') s.title = text.replace(/\s+/g, ' ').slice(0, 18) || '新对话';
  saveSessions();

  const suffix = formatAttachments();
  const userMsg = {
    role: 'user', text,
    attachments: state.attachments.map(({ name, error }) => ({ name, error })),
    apiSuffix: suffix,
  };
  const inner = $('.chat-inner');
  inner.appendChild(userNode(userMsg));
  s.messages.push(userMsg);

  const draft = {
    role: 'assistant',
    summary: { label: '进行中', tools: 0, messages: 0 },
    tools: [], tasks: [], body: '', files: [], approval: null, metrics: '',
    startedAt: Date.now(), finishedAt: 0,
    source: sourceOf(), model: sourceOf() === 'model' ? currentModel() : '离线预览',
    error: '', usage: null, aborted: false,
    attachmentsCount: userMsg.attachments.length,
    retries: 0,
    resumeFrom: text,
  };
  s.messages.push(draft);

  const node = assistantNode(draft);
  inner.appendChild(node);
  const prose = $('.prose', node);
  const toolsBox = $('.tools', node);
  const summary = $('.summary', node);

  state.attachments = [];
  renderAttachments();
  renderHeader();
  renderSessions();
  updateSendState();
  scrollToBottom(true);

  const ctx = { s, draft, node, prose, toolsBox, summary };
  if (sourceOf() === 'model') {
    const cfgErr = validateApiInput(state.connection.api);
    if (cfgErr || !window.dsh?.model) {
      const msg = cfgErr || '当前不在桌面外壳里运行，无法发起请求';
      return runApiTurn(ctx, { immediateError: msg });
    }
    await prepareTools();
    return runApiTurn(ctx, {
      cfg: { ...state.connection.api, retry: retryConfig() },
      messages: buildApiMessages(s, text + suffix, draft, userMsg),
    });
  }
  return runPreviewTurn(text, ctx);
}

/* ───────── 真实 API 回合 ───────── */

const RISKY_TOOLS = new Set(['write_file', 'run_command']);
const READ_TOOLS = new Set(['list_dir', 'read_file', 'search_files', 'fetch_url']);

function describeToolTarget(name, args) {
  let target = '';
  if (name === 'read_file' || name === 'write_file' || name === 'list_dir') target = args?.path || '.';
  else if (name === 'search_files') target = `${args?.pattern || ''}${args?.path ? ' · ' + args.path : ''}`;
  else if (name === 'run_command') target = args?.command || '';
  else if (name === 'fetch_url') target = args?.url || '';
  else if (name === 'delegate_task') {
    const rawAgent = String(args?.agentId || '').trim();
    const auto = !rawAgent || rawAgent === 'new' || rawAgent === 'auto';
    target = `${auto ? '自动创建子 Agent' : rawAgent}${args?.model ? ' · ' + args.model : ''} · ${args?.objective || ''}`;
  }
  else target = args?.path || args?.url || args?.command || '';
  return String(target).replace(/\s+/g, ' ').slice(0, 160);
}

/* 免审批 key 用完整参数（含名称），避免长命令被截断后前缀碰撞导致误放行 */
function approvalKey(name, args) {
  return `${name}::${JSON.stringify(args && typeof args === 'object' ? args : {})}`;
}

function revealTools(node, draft) {
  const box = $('.tools', node);
  if (box) box.classList.remove('hidden');
  const summary = $('.summary', node);
  if (summary) {
    delete summary.dataset.empty;
    summary.classList.remove('collapsed');
    draft.summary.tools = draft.tools.length;
    summary.innerHTML = summaryText(draft.summary) + ico('i-chevron', 'ico tiny chev');
  }
}

function renderToolsSetting() {
  const pathEl = $('#workspacePath');
  if (pathEl) pathEl.textContent = state.workspace || '（默认：文档目录）';
  const fine = $('#toolsFine');
  if (!fine) return;
  if (state.toolsLoading) { fine.textContent = '正在加载工具定义…'; return; }
  if (state.toolsError) { fine.textContent = `工具定义加载失败：${state.toolsError}`; return; }
  if (!state.toolsReady) { fine.textContent = '尚未加载工具定义'; return; }
  const names = state.toolSpecs.map((s) => s.function?.name).filter(Boolean);
  const ws = state.workspace ? `工作目录：${state.workspace}` : '工作目录：未设置（默认使用文档目录）';
  fine.textContent = `已启用 ${names.length} 个工具：${names.join('、')}。${ws}。`;
}

/* ───────── 运行检查器（Runtime Task/Run/Event） ───────── */

const inspector = {
  open: false, runId: '', timer: null, events: [], detail: null, history: [], agent: null, agents: [], defaultAgentId: '', health: null, audit: [],
  view: 'graph', graph: null, replayCursor: null, replayTimer: null, nodeDetail: '', seekTimer: null,
};

const RUN_STATUS_LABEL = {
  pending: '排队中', running: '运行中', waiting_approval: '等待审批',
  succeeded: '已完成', failed: '失败', canceled: '已取消', interrupted: '已中断',
};
const EVENT_LABEL = {
  'task.created': '任务创建', 'task.queued': '任务排队', 'task.started': '任务开始',
  'task.status_changed': '任务状态', 'task.finished': '任务结束', 'task.canceled': '任务取消',
  'run.started': '运行开始', 'run.status_changed': '运行状态', 'run.finished': '运行结束', 'run.interrupted': '运行中断',
  'step.started': '步骤开始', 'step.finished': '步骤结束',
  'model.request_started': '模型请求', 'model.completed': '模型返回', 'model.failed': '模型失败', 'model.aborted': '模型中断',
  'tool.proposed': '工具提议', 'policy.decided': '策略判定', 'approval.requested': '等待审批',
  'approval.decided': '审批决定', 'approval.expired': '审批过期', 'approval.canceled': '审批取消',
  'tool.started': '工具执行', 'tool.completed': '工具完成', 'tool.failed': '工具失败',
  'tool.denied': '工具拒绝', 'tool.unknown': '结果未知', 'tool.canceled': '工具取消',
  'artifact.created': '产出文件', 'validation.completed': '结果校验',
  'delegation.requested': '委派请求', 'delegation.started': '子任务开始', 'delegation.finished': '委派结束',
  'delegation.canceled': '委派取消', 'delegation.rejected': '委派拒绝', 'budget.exceeded': '预算耗尽',
  'project.updated': '项目架构',
};

const AUDIT_LABEL = {
  'task.created': '任务创建', 'task.canceled': '任务取消', 'policy.decided': '策略判定',
  'approval.requested': '审批请求', 'approval.decided': '审批决定', 'approval.expired': '审批过期',
  'approval.canceled': '审批取消', 'tool.result': '工具结果', 'run.interrupted': '运行中断',
  'runtime.recovered': '崩溃恢复', 'agent.updated': 'Agent 版本', 'provider.updated': 'Provider 变更',
  'delegation.requested': '委派请求', 'delegation.started': '子任务开始', 'delegation.finished': '委派结束',
  'delegation.canceled': '委派取消', 'delegation.rejected': '委派拒绝', 'budget.exceeded': '预算耗尽',
  'project.updated': '项目架构',
};

function auditTone(r) {
  if (['allow', 'approved', 'completed', 'succeeded', 'updated', 'created'].includes(r.outcome)) return 'is-ok';
  if (['deny', 'denied', 'failed', 'unknown', 'expired', 'canceled', 'interrupted'].includes(r.outcome)) return 'is-bad';
  return 'is-live';
}

function auditSummary(r) {
  const d = r.detail || {};
  if (r.action === 'policy.decided') return `${r.outcome} · ${(d.ruleIds || []).join(',')}${d.riskLevel ? ' · ' + d.riskLevel : ''}`;
  if (r.action === 'approval.requested') return `${d.toolName || '工具'} · ${d.scope || ''} · ${d.riskLevel || ''}`;
  if (r.action === 'approval.decided') return `${r.outcome} · ${d.scope || ''}`;
  if (r.action === 'tool.result') return `${r.outcome}${d.code ? ' · ' + d.code : ''}${d.summary ? ' · ' + d.summary : ''}`;
  if (r.action === 'task.created') return d.title || '';
  if (r.action === 'runtime.recovered') return '应用重启，未完成运行已中断';
  if (r.action === 'task.canceled' || r.action === 'run.interrupted') return d.reason || r.outcome;
  if (r.action === 'agent.updated') return `v${d.fromVersion} → v${d.toVersion}${d.status ? ' · ' + d.status : ''}`;
  if (r.action === 'provider.updated') return (d.changed || []).join(',');
  if (r.action === 'delegation.requested') return `${d.targetAgentId || ''} · 深度 ${d.depth ?? '?'} · ${d.budget?.maxModelCalls ?? '?'} 次模型调用预算`;
  if (r.action === 'delegation.started') return `${d.targetAgentId || ''} · 子任务 ${d.childTaskId || ''}`;
  if (r.action === 'delegation.finished') return `${r.outcome}${d.errorCode ? ' · ' + d.errorCode : ''}${d.summary ? ' · ' + d.summary : ''}`;
  if (r.action === 'delegation.canceled') return `${d.cascade ? '级联取消' : '取消'}${d.reason ? ' · ' + d.reason : ''}`;
  if (r.action === 'delegation.rejected') return `${d.code || ''}${d.reason ? ' · ' + d.reason : ''}`;
  if (r.action === 'budget.exceeded') return `${d.scope || ''} · 上限 ${d.limit ?? '?'}`;
  if (r.action === 'project.updated') return `revision ${d.revision ?? '?'} · ${d.nodeCount ?? 0} 模块 · ${d.source || ''}${d.mode ? ' · ' + d.mode : ''}`;
  return r.outcome;
}

function hhmmss(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function eventTone(type) {
  if (['tool.failed', 'tool.denied', 'tool.unknown', 'model.failed', 'run.interrupted', 'task.canceled', 'approval.expired', 'delegation.canceled', 'delegation.rejected', 'budget.exceeded'].includes(type)) return 'is-bad';
  if (['tool.completed', 'run.finished', 'task.finished', 'validation.completed', 'approval.decided', 'delegation.finished', 'project.updated'].includes(type)) return 'is-ok';
  if (['model.request_started', 'tool.started', 'approval.requested', 'delegation.started'].includes(type)) return 'is-live';
  return '';
}

function eventSummary(e) {
  const p = e.payload || {};
  if (e.type === 'task.created') return `${p.title || ''}${p.agentId ? ' · ' + p.agentId.slice(-6) : ''}`;
  if (e.type === 'task.queued') return `队列位置 ${p.queuePosition ?? 1}`;
  if (e.type === 'task.started') return '已创建本次运行';
  if (e.type === 'task.status_changed' || e.type === 'run.status_changed') return `${p.from || ''} → ${p.to || ''}${p.reason ? ' · ' + p.reason : ''}`;
  if (e.type === 'run.started') return `尝试 ${p.attempt ?? 1}${p.model ? ' · ' + p.model : ''}`;
  if (e.type === 'step.finished') return `${p.status || ''}${(p.toolCallIds || []).length ? ' · ' + p.toolCallIds.length + ' 个工具' : ''}`;
  if (e.type === 'tool.proposed') return `${p.name || ''}${p.argsSummary ? ' · ' + p.argsSummary : ''}`;
  if (e.type === 'policy.decided') return `${p.decision || ''}${(p.ruleIds || []).length ? ' · ' + p.ruleIds.join(',') : ''}${p.reason ? ' · ' + p.reason : ''}`;
  if (e.type === 'approval.requested') return `${p.toolName || '工具'} · ${p.riskLevel || ''}${p.scope ? ' · ' + p.scope : ''}`;
  if (e.type === 'approval.decided') return `${p.decision === 'approved' ? '已批准' : '已拒绝'}${p.scope ? ' · ' + p.scope : ''}`;
  if (e.type === 'tool.started') return p.name || '';
  if (e.type === 'tool.completed') return `${p.resultCode || 'OK'}${p.summary ? ' · ' + p.summary : ''}`;
  if (e.type === 'tool.failed' || e.type === 'tool.denied' || e.type === 'tool.unknown') return `${p.code || ''}${p.message || p.reason ? ' · ' + (p.message || p.reason) : ''}`;
  if (e.type === 'tool.canceled') return '已取消';
  if (e.type === 'model.request_started') return `${p.model || ''} · ${p.messageCount ?? '?'} 条消息 · ~${p.approxInputTokens ?? '?'} tokens`;
  if (e.type === 'model.completed') {
    const u = p.usage || {};
    return `${p.finishReason || 'stop'}${u.completion_tokens != null ? ' · 输出 ' + u.completion_tokens + ' tokens' : ''}`;
  }
  if (e.type === 'run.finished') return p.outcome || '';
  if (e.type === 'task.finished') return `${p.status || ''}${p.errorCode ? ' · ' + p.errorCode : ''}`;
  if (e.type === 'step.started') return `#${p.index ?? '?'} · ${p.kind || ''}`;
  if (e.type === 'artifact.created') return `${p.kind || 'file'}${p.path ? ' · ' + p.path : ''}`;
  if (e.type === 'delegation.requested') return `${p.targetAgentId || ''} · 深度 ${p.depth ?? '?'} · ${p.budget?.maxModelCalls ?? '?'} 次模型调用预算`;
  if (e.type === 'delegation.started') return `${p.targetAgentId || ''} · 子任务运行中`;
  if (e.type === 'delegation.finished') return `${p.status || ''}${p.errorCode ? ' · ' + p.errorCode : ''}${p.summary ? ' · ' + p.summary : ''}`;
  if (e.type === 'delegation.canceled') return `${p.cascade ? '级联取消' : '取消'}${p.reason ? ' · ' + p.reason : ''}`;
  if (e.type === 'delegation.rejected') return `${p.code || ''}${p.reason ? ' · ' + p.reason : ''}`;
  if (e.type === 'budget.exceeded') return `${p.scope || ''} · 上限 ${p.limit ?? '?'}`;
  if (e.type === 'project.updated') return `revision ${p.revision ?? '?'} · ${p.nodeCount ?? 0} 模块 · ${p.edgeCount ?? 0} 依赖 · ${p.source || ''}`;
  if (e.type.startsWith('approval.')) return p.approvalId || '';
  return Object.keys(p).slice(0, 4).join(', ');
}

function findSessionRunId() {
  const msgs = active()?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.runtime?.runId) return msgs[i].runtime.runId;
  }
  return '';
}

async function refreshInspector() {
  const body = $('#inspBody');
  const rt = window.dsh?.runtime;
  if (!body || !inspector.open) return;
  if (!rt) {
    body.innerHTML = '<div class="insp-empty">当前不在桌面外壳里运行，无法读取 Runtime 数据。</div>';
    return;
  }

  let history = [];
  try {
    const list = await rt.tasks.list({ limit: 20 });
    if (list?.ok) history = list.data.tasks;
  } catch { /* 忽略 */ }
  inspector.history = history;

  if (!inspector.runId) {
    const fromSession = findSessionRunId();
    if (fromSession) inspector.runId = fromSession;
    else if (history[0]) {
      try {
        const t = await rt.tasks.get(history[0].id);
        inspector.runId = t?.ok ? (t.data.runs[0]?.id || '') : '';
      } catch { /* 忽略 */ }
    }
  }

  let detail = null;
  let events = [];
  if (inspector.runId) {
    try {
      const [d, e] = await Promise.all([
        rt.runs.get(inspector.runId),
        rt.events.read({ runId: inspector.runId, limit: 2000 }),
      ]);
      if (d?.ok) detail = d.data;
      if (e?.ok) events = e.data.events;
    } catch { /* 忽略 */ }
  }
  inspector.detail = detail;
  inspector.events = events;

  let graphData = null;
  if (inspector.runId && rt.runs.graph) {
    try {
      const g = await rt.runs.graph({
        runId: inspector.runId,
        beforeSeq: Number.isInteger(inspector.replayCursor) ? inspector.replayCursor : undefined,
      });
      if (g?.ok) graphData = g.data;
    } catch { /* 图形投影失败不阻塞其他数据 */ }
  }
  inspector.graph = graphData;
  if (!inspector.graph?.graph?.nodes?.some((n) => n.id === inspector.nodeDetail)) inspector.nodeDetail = '';

  try {
    const a = await rt.agents.list();
    if (a?.ok) {
      inspector.agents = Array.isArray(a.data.agents) ? a.data.agents : [];
      inspector.defaultAgentId = a.data.defaultAgentId || '';
      inspector.agent = inspector.agents.find((x) => x.id === inspector.defaultAgentId) || inspector.agents[0] || null;
      state.agents = inspector.agents;
      state.defaultAgentId = inspector.defaultAgentId;
    }
  } catch { /* 忽略 */ }
  try {
    const h = await rt.system.health();
    if (h?.ok) inspector.health = h.data;
  } catch { /* 忽略 */ }
  try {
    const au = await rt.audit.read({ limit: 30 });
    if (au?.ok) inspector.audit = au.data.records;
  } catch { /* 忽略 */ }

  renderInspector();
  scheduleInspectorPoll();
}

function scheduleInspectorPoll() {
  clearTimeout(inspector.timer);
  if (inspector.replayTimer || Number.isInteger(inspector.replayCursor)) return;
  const st = inspector.detail?.run?.status;
  if (!inspector.open || !st || !['pending', 'running', 'waiting_approval'].includes(st)) return;
  inspector.timer = setTimeout(() => refreshInspector(), 1500);
}


const NODE_STATUS_LABEL = {
  proposed: '待检查', ready: '待执行', waiting_approval: '待审批', executing: '执行中',
  succeeded: '成功', failed: '失败', denied: '拒绝', canceled: '取消', unknown: '结果未知',
  pending: '等待', approved: '已批准', expired: '已过期', skipped: '跳过', running: '运行中',
  interrupted: '已中断', created: '已创建', queued: '排队中', rejected: '已拒绝',
};

function nodeTone(status) {
  if (['succeeded', 'approved', 'passed'].includes(status)) return 'is-ok';
  if (['failed', 'denied', 'canceled', 'unknown', 'expired', 'interrupted'].includes(status)) return 'is-bad';
  if (['running', 'executing', 'waiting_approval', 'pending', 'proposed', 'ready'].includes(status)) return 'is-live';
  return '';
}

function graphNodeDetail(n) {
  const rows = [];
  if (n.toolCallId) rows.push(`ToolCall：${n.toolCallId}`);
  if (n.modelCallId) rows.push(`ModelCall：${n.modelCallId}`);
  if (n.approvalId) rows.push(`Approval：${n.approvalId}`);
  if (n.stepId) rows.push(`Step：${n.stepId}${n.stepKind ? ' · ' + n.stepKind : ''}`);
  if (n.policy) {
    rows.push(`策略：${n.policy.decision} · ${(n.policy.ruleIds || []).join(',')} · 风险 ${n.policy.riskLevel || '-'}`);
    if (n.policy.reason) rows.push(`理由：${n.policy.reason}`);
    if (n.policy.actionHash) rows.push(`actionHash：${n.policy.actionHash}`);
  } else if (n.risk) {
    rows.push(`风险：${n.risk}${n.sideEffect ? ' · ' + n.sideEffect : ''}`);
  }
  if (n.scope) rows.push(`审批作用域：${n.scope}`);
  if (n.decidedBy) rows.push(`决定人：${n.decidedBy}`);
  if (n.usage) rows.push(`Tokens：输入 ${n.usage.prompt_tokens ?? '-'} · 输出 ${n.usage.completion_tokens ?? '-'}`);
  if (n.finishReason) rows.push(`finishReason：${n.finishReason}`);
  if (n.artifacts?.length) rows.push(`产物：${n.artifacts.map((a) => a.path).filter(Boolean).join('、')}`);
  if (n.idempotencyKey) rows.push(`幂等键：${n.idempotencyKey}`);
  if (n.reconciled) rows.push('该结果已经人工核对');
  if (n.kind === 'delegation') {
    if (n.targetAgentId) rows.push(`目标 Agent：${n.targetAgentId}${n.targetAgentVersion ? ` @v${n.targetAgentVersion}` : ''}`);
    if (n.childTaskId) rows.push(`子任务：${n.childTaskId}`);
    if (n.childRunId) rows.push(`子 Run：${n.childRunId}`);
    if (n.budget) rows.push(`预算：${n.budget.maxModelCalls ?? '?'} 次模型调用 · ${n.budget.maxTokens ?? '?'} tokens · ${Math.round((n.budget.maxWallClockMs || 0) / 1000)} 秒`);
    if (n.effectiveProfile) rows.push(`有效权限：${n.effectiveProfile}`);
    if (n.contextRefCount != null) rows.push(`共享文件：${n.contextRefCount} 个`);
    if (n.artifactCount != null) rows.push(`产物：${n.artifactCount} 个`);
    if (n.childTaskId) rows.push(`<button class="insp-drill" data-child-task="${esc(n.childTaskId)}">打开子 Run</button>`);
  }
  const html = rows.map((r) => `<div>${esc(r)}</div>`).join('');
  if (n.kind === 'tool' && n.status === 'unknown' && n.toolCallId && !n.reconciled) {
    return `${html}<div class="insp-reconcile">
      <button data-reconcile="succeeded" data-tool-call="${esc(n.toolCallId)}">确认已成功</button>
      <button data-reconcile="failed" data-tool-call="${esc(n.toolCallId)}">确认失败</button>
      <button data-reconcile="canceled" data-tool-call="${esc(n.toolCallId)}">标记取消</button>
    </div>`;
  }
  return html;
}

function renderGraphViewHtml() {
  const gd = inspector.graph;
  if (!gd?.graph) return '<div class="insp-empty">暂无可投影的运行事件</div>';
  const depth = { run: 0, step: 0, model: 1, tool: 1, approval: 2, delegation: 1, validation: 0, end: 0 };
  const rows = gd.graph.nodes.map((n) => {
    const d = depth[n.kind] ?? 0;
    const tone = nodeTone(n.status);
    const open = inspector.nodeDetail === n.id;
    const status = NODE_STATUS_LABEL[n.status] || n.status;
    const chips = [];
    if (n.policy) chips.push(`${n.policy.decision}${n.policy.riskLevel ? ' · ' + n.policy.riskLevel : ''}`);
    else if (n.risk) chips.push(n.risk);
    if (n.toolCount) chips.push(`${n.toolCount} 工具`);
    if (n.artifacts?.length) chips.push(`${n.artifacts.length} 产物`);
    return `<div class="insp-node-wrap depth-${d}">
      <button class="insp-node ${tone} ${open ? 'is-open' : ''}" data-node-id="${esc(n.id)}">
        <span class="insp-node-dot"></span>
        <span class="insp-node-main">
          <b>${esc(n.label)}</b>
          <small>${esc(n.summary || '')}</small>
          ${chips.length ? `<span class="insp-node-chips">${chips.map((c) => `<i>${esc(c)}</i>`).join('')}</span>` : ''}
        </span>
        <span class="insp-chip ${tone}">${esc(status)}</span>
      </button>
      ${open ? `<div class="insp-node-detail">${graphNodeDetail(n)}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="insp-graph">${rows}</div>`;
}

function replayBarHtml() {
  const meta = inspector.graph;
  if (!meta) return '';
  const maxSeq = meta.lastSeq || 0;
  const cursor = Number.isInteger(inspector.replayCursor) ? inspector.replayCursor : maxSeq;
  const playing = !!inspector.replayTimer;
  return `<div class="insp-replay">
    <button class="insp-replay-btn" id="inspPlay">${playing ? '暂停' : '回放'}</button>
    <input type="range" id="inspRange" min="0" max="${maxSeq}" value="${cursor}" />
    <span class="insp-replay-pos">${cursor} / ${maxSeq}</span>
    <button class="insp-replay-btn ghost" id="inspLive">实时</button>
  </div>`;
}

function stopReplay() {
  if (inspector.replayTimer) {
    clearInterval(inspector.replayTimer);
    inspector.replayTimer = null;
  }
}

function toggleReplay() {
  if (inspector.replayTimer) { stopReplay(); renderInspector(); return; }
  if (!inspector.graph) return;
  const seqs = (inspector.events || []).map((e) => e.seq).filter(Number.isInteger);
  const maxSeq = inspector.graph.lastSeq || (seqs.length ? seqs[seqs.length - 1] : 0);
  if (!maxSeq) return;
  if (!Number.isInteger(inspector.replayCursor) || inspector.replayCursor >= maxSeq) inspector.replayCursor = 0;
  clearTimeout(inspector.timer);
  inspector.replayTimer = setInterval(async () => {
    const after = seqs.filter((s) => s > inspector.replayCursor);
    if (!after.length) { stopReplay(); renderInspector(); return; }
    inspector.replayCursor = after[0];
    await refreshInspector();
    if (inspector.replayCursor >= maxSeq) { stopReplay(); renderInspector(); }
  }, 260);
  renderInspector();
}

async function setReplayCursor(value) {
  stopReplay();
  inspector.replayCursor = Math.max(0, Math.min(Number(value) || 0, inspector.graph?.lastSeq || 0));
  await refreshInspector();
}

function renderInspector() {
  const body = $('#inspBody');
  if (!body) return;
  const d = inspector.detail;
  const run = d?.run;
  const task = d?.task;
  const events = inspector.events || [];
  const counts = {
    steps: d?.steps?.length || 0,
    tools: d?.toolCalls?.length || 0,
    model: d?.modelCalls?.length || 0,
    approvals: d?.approvals?.length || 0,
  };

  const agentRows = (inspector.agents || []).map((a) => `
    <div class="insp-agent-row ${a.status === 'archived' ? 'is-archived' : ''}">
      <span class="insp-agent-dot"></span>
      <div class="insp-agent-main"><b>${esc(a.name)}${a.id === inspector.defaultAgentId ? ' · 默认' : ''}</b>
      <small>v${a.currentVersion} · 权限 ${esc(a.version?.permissionProfileId || '?')} · ${esc(a.status)}</small></div>
      <span class="insp-agent-tag">${a.id === inspector.defaultAgentId ? '当前' : a.status === 'archived' ? '已归档' : '可委派'}</span>
    </div>`).join('');
  const agentHtml = agentRows
    ? `${agentRows}<button class="insp-manage" data-open-agents>管理 Agent</button>`
    : '<div class="insp-empty">尚未初始化 Agent</div>';

  let runHtml = '<div class="insp-empty">当前会话还没有 Runtime 运行记录。</div>';
  if (run) {
    const st = run.status;
    const cls = st === 'succeeded' ? 'is-ok' : ['failed', 'canceled', 'interrupted'].includes(st) ? 'is-bad' : 'is-live';
    const usage = run.usage || {};
    const started = run.startedAt ? hhmmss(run.startedAt) : '';
    runHtml = `
      <div class="insp-run-head">
        <span class="insp-run-title" title="${esc(task?.title || '')}">${esc(task?.title || '未命名任务')}</span>
        <span class="insp-chip ${cls}">${esc(RUN_STATUS_LABEL[st] || st)}</span>
      </div>
      <div class="insp-meta">运行 ${esc(run.id.slice(-8))} · 尝试 ${run.attempt} · ${esc(run.model || '未记录模型')} · 开始 ${esc(started)}</div>
      <div class="insp-stats">
        <div class="insp-stat"><b>${counts.steps}</b><small>步骤</small></div>
        <div class="insp-stat"><b>${counts.model}</b><small>模型调用</small></div>
        <div class="insp-stat"><b>${counts.tools}</b><small>工具调用</small></div>
        <div class="insp-stat"><b>${counts.approvals}</b><small>审批</small></div>
      </div>
      <div class="insp-meta">Tokens：输入 ${usage.inputTokens || 0} · 输出 ${usage.outputTokens || 0} · 工具 ${usage.toolCalls || 0}</div>`;
  }

  const visible = events.slice(-160);
  const timelineHtml = visible.length
    ? `<ul class="insp-timeline">${visible.map((e) => `
        <li class="insp-event ${eventTone(e.type)}">
          <time>${hhmmss(e.ts)}</time>
          <span class="insp-event-dot"></span>
          <span class="insp-event-body"><b>${esc(EVENT_LABEL[e.type] || e.type)}</b><small>${esc(eventSummary(e))}</small></span>
        </li>`).join('')}</ul>`
    : '<div class="insp-empty">暂无事件</div>';

  const auditAll = inspector.audit || [];
  const auditRecords = (task ? auditAll.filter((r) => r.taskId === task.id) : auditAll).slice(-8).reverse();
  const auditHtml = auditRecords.length
    ? `<ul class="insp-timeline">${auditRecords.map((r) => `
        <li class="insp-event ${auditTone(r)}">
          <time>${hhmmss(r.ts)}</time>
          <span class="insp-event-dot"></span>
          <span class="insp-event-body"><b>${esc(AUDIT_LABEL[r.action] || r.action)}</b><small>${esc(auditSummary(r))}</small></span>
        </li>`).join('')}</ul>`
    : '<div class="insp-empty">暂无审计记录</div>';

  const tasksHtml = inspector.history.length
    ? `<div class="insp-tasks">${inspector.history.map((t) => {
      const st = t.status;
      const cls = st === 'succeeded' ? 'is-ok' : ['failed', 'canceled'].includes(st) ? 'is-bad' : 'is-live';
      return `<button class="insp-task ${t.id === task?.id ? 'is-active' : ''}" data-task-id="${esc(t.id)}">
          <span class="insp-task-body"><b>${esc(t.title || '未命名任务')}</b><small>${hhmmss(t.createdAt)} · ${esc(t.agentId.slice(-6))}</small></span>
          <span class="insp-chip ${cls}">${esc(RUN_STATUS_LABEL[st] || st)}</span>
        </button>`;
    }).join('')}</div>`
    : '<div class="insp-empty">暂无历史任务</div>';

  const health = inspector.health;
  const healthOk = health?.status === 'ok';
  const auditOk = health?.audit?.ok === true;
  const pending = (d?.approvals || []).filter((a) => a.status === 'pending').length;
  const providerCount = health?.providers?.length || 0;
  const toolCount = state.toolSpecs?.length || 7;
  const permLabel = state.permission === 'full' ? '完全权限' : state.permission === 'ask' ? '每次询问' : '只读';
  const agentName = inspector.agent?.name || '默认 Agent';
  const agentVer = inspector.agent?.currentVersion ? `v${inspector.agent.currentVersion}` : 'v1';

  const archNode = (x, y, w, h, label, sub, tone = '') => `
    <g class="arch-node ${tone}">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7"/>
      <circle cx="${x + 9}" cy="${y + 10}" r="3" class="arch-dot"/>
      <text x="${x + w / 2}" y="${y + 14}" text-anchor="middle" class="arch-label">${esc(label)}</text>
      <text x="${x + w / 2}" y="${y + 26}" text-anchor="middle" class="arch-sub">${esc(sub)}</text>
    </g>`;
  const archEdge = (x1, y1, x2, y2, dashed = false) => `<path class="arch-edge ${dashed ? 'is-dashed' : ''}" d="M${x1} ${y1} L${x2} ${y2}"/>`;
  const archGraphHtml = `<svg class="insp-arch-graph" viewBox="0 0 364 218" role="img" aria-label="Agent 架构图">
      ${archEdge(182, 40, 182, 62)}
      ${archEdge(150, 94, 60, 118)}
      ${archEdge(182, 94, 182, 118)}
      ${archEdge(214, 94, 302, 118)}
      ${archEdge(182, 152, 64, 176)}
      ${archEdge(182, 152, 178, 176)}
      ${archEdge(302, 152, 296, 176)}
      ${archEdge(116, 193, 252, 152, true)}
      ${archNode(132, 6, 100, 34, agentName.slice(0, 12), `${agentVer} · ${permLabel}`, 'is-ok')}
      ${archNode(127, 62, 110, 32, 'Runtime 编排', '本地单进程', 'is-live')}
      ${archNode(8, 118, 104, 34, '模型网关', `${providerCount} 个 Provider`)}
      ${archNode(130, 118, 104, 34, 'Policy Engine', permLabel, 'is-live')}
      ${archNode(250, 118, 104, 34, '事件存储', `seq ${health?.store?.lastSeq ?? 0}`, healthOk ? 'is-ok' : 'is-bad')}
      ${archNode(12, 176, 104, 34, '工具执行器', `${toolCount} 个工具`)}
      ${archNode(126, 176, 104, 34, '审批队列', `${pending} 待审批`, pending ? 'is-live' : '')}
      ${archNode(244, 176, 108, 34, '审计哈希链', auditOk ? '校验通过' : '校验异常', auditOk ? 'is-ok' : 'is-bad')}
    </svg>`;
  const archHtml = `${archGraphHtml}
    <div class="insp-arch">
      <span class="${healthOk ? 'is-ok' : 'is-bad'}">事件日志 · seq ${health?.store?.lastSeq ?? 0}</span>
      <span>模型网关 · ${providerCount} 个 Provider</span>
      <span>工具执行器 · ${toolCount} 个工具</span>
      <span>策略引擎 · ${permLabel}</span>
      <span class="${pending ? 'is-live' : ''}">审批队列 · ${pending} 待处理</span>
      <span class="${health?.queue?.queued ? 'is-live' : ''}">并发 ${health?.queue?.activeRuns ?? 0}/${health?.queue?.maxConcurrentRuns ?? '-'} · 队列 ${health?.queue?.queued ?? 0}</span>
    </div>`;

  const viewToggle = `<div class="insp-seg">
      <button data-insp-view="graph" class="${inspector.view === 'graph' ? 'is-active' : ''}">运行图</button>
      <button data-insp-view="timeline" class="${inspector.view === 'timeline' ? 'is-active' : ''}">事件流</button>
    </div>`;
  const runtimeViewHtml = inspector.view === 'graph'
    ? `${renderGraphViewHtml()}${replayBarHtml()}`
    : timelineHtml;

  body.innerHTML = `
    <div class="insp-section"><div class="insp-section-head"><b>AGENT</b></div>${agentHtml}</div>
    <div class="insp-section"><div class="insp-section-head"><b>架构</b></div>${archHtml}</div>
    <div class="insp-section"><div class="insp-section-head"><b>当前运行</b></div>${runHtml}</div>
    <div class="insp-section"><div class="insp-section-head">${viewToggle}<span class="insp-meta">${events.length} 个事件</span></div>${runtimeViewHtml}</div>
    <div class="insp-section"><div class="insp-section-head"><b>审计链</b><span class="insp-meta">${health?.audit?.ok ? '校验通过' : '校验异常'} · ${health?.audit?.lastSeq ?? 0} 条</span></div>${auditHtml}</div>
    <div class="insp-section"><div class="insp-section-head"><b>历史任务</b><span class="insp-meta">最近 ${inspector.history.length} 条</span></div>${tasksHtml}</div>`;
}

async function openInspector() {
  if (!window.dsh?.runtime) { toast('当前不在桌面外壳里运行'); return; }
  inspector.open = true;
  stopReplay();
  inspector.replayCursor = null;
  inspector.nodeDetail = '';
  const panel = $('#inspector');
  if (panel) {
    panel.classList.remove('is-closing'); // 可能正播出场动画，取消它
    panel.hidden = false;
  }
  $('.main')?.classList.add('inspector-open');
  inspector.runId = findSessionRunId();
  const body = $('#inspBody');
  if (body) body.innerHTML = '<div class="insp-empty">正在读取 Runtime 数据…</div>';
  await refreshInspector();
}

function closeInspector() {
  inspector.open = false;
  stopReplay();
  clearTimeout(inspector.timer);
  clearTimeout(inspector.seekTimer);
  $('.main')?.classList.remove('inspector-open'); // 侧栏滑出与面板淡出同时进行
  animateOut($('#inspector'), 220);
}

async function pickInspectorTask(taskId) {
  const rt = window.dsh?.runtime;
  if (!rt) return;
  stopReplay();
  inspector.replayCursor = null;
  inspector.nodeDetail = '';
  try {
    const t = await rt.tasks.get(taskId);
    if (t?.ok && t.data.runs[0]) {
      inspector.runId = t.data.runs[0].id;
      await refreshInspector();
    }
  } catch { /* 忽略 */ }
}

async function pickWorkspace() {
  const btn = $('#pickWorkspace');
  if (btn?.disabled) return;
  if (!window.dsh?.tools?.pickWorkspace) { toast('当前桌面外壳不支持选择目录'); return; }
  if (btn) btn.disabled = true;
  try {
    const r = await window.dsh.tools.pickWorkspace(state.workspace);
    if (!r || r.canceled) return;
    if (!r.ok) { toast(r.error || '选择目录失败'); return; }
    state.workspace = r.path;
    writeStorage('dsh.workspace', r.path);
    state.project = null;
    state.projectWorkspace = '';
    renderToolsSetting();
    loadProject().then(() => {
      if (state.projectOpen) renderArchPage();
    }).catch(() => {});
    toast(`工作目录：${r.path}`);
  } catch (err) {
    toast(`选择目录失败：${err?.message || err}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadTools(force = false) {
  if (!window.dsh?.tools?.specs) {
    state.toolsReady = false;
    state.toolsError = '当前不在桌面外壳里运行，无法加载本地工具';
    renderToolsSetting();
    return { ok: false, error: state.toolsError };
  }
  if (state.toolsLoading) return { ok: false, error: '正在加载工具定义' };
  if (state.toolsReady && !force) { renderToolsSetting(); return { ok: true }; }
  state.toolsLoading = true;
  state.toolsError = '';
  renderToolsSetting();
  try {
    const r = await window.dsh.tools.specs();
    if (!r?.ok) throw new Error(r?.error || '主进程没有返回工具定义');
    state.toolSpecs = Array.isArray(r.specs) ? r.specs : [];
    state.toolMeta = r.meta && typeof r.meta === 'object' ? r.meta : {};
    state.readOnlyTools = new Set(Array.isArray(r.readOnly) ? r.readOnly : []);
    state.needsApprovalTools = new Set(Array.isArray(r.needsApproval) ? r.needsApproval : []);
    state.toolsReady = true;
    return { ok: true, count: state.toolSpecs.length };
  } catch (err) {
    state.toolsReady = false;
    state.toolSpecs = [];
    state.toolMeta = {};
    state.readOnlyTools = new Set();
    state.needsApprovalTools = new Set();
    state.toolsError = err?.message || String(err);
    return { ok: false, error: state.toolsError };
  } finally {
    state.toolsLoading = false;
    renderToolsSetting();
  }
}

async function ensureWorkspace() {
  if (state.workspace) { renderToolsSetting(); return state.workspace; }
  try {
    const def = await window.dsh?.tools?.defaultWorkspace?.();
    if (typeof def === 'string' && def.trim()) {
      state.workspace = def.trim();
      writeStorage('dsh.workspace', state.workspace);
    }
  } catch { /* 拿不到默认目录就交给主进程兜底 */ }
  renderToolsSetting();
  return state.workspace;
}

/** 工具定义/工作目录必须在构造请求之前就绪，否则首轮系统提示里没有工作目录。 */
async function loadAgents() {
  if (!window.dsh?.runtime?.agents?.list) return;
  try {
    const r = await window.dsh.runtime.agents.list();
    if (r?.ok) {
      state.agents = Array.isArray(r.data.agents) ? r.data.agents : [];
      state.defaultAgentId = r.data.defaultAgentId || '';
    }
  } catch { /* 无 Runtime 时保持空列表 */ }
}

async function loadProject(force = false) {
  if (!window.dsh?.runtime?.projects?.ensure) return null;
  const workspace = state.workspace;
  if (!workspace) return null;
  if (!force && state.project && state.projectWorkspace === workspace) return state.project;
  if (state.projectLoading) return state.project;
  state.projectLoading = true;
  state.projectError = '';
  try {
    const r = await window.dsh.runtime.projects.ensure({ workspace });
    if (r?.ok && r.data?.project) {
      state.project = r.data;
      state.projectWorkspace = workspace;
      return state.project;
    }
    state.projectError = r?.error?.message || '读取项目架构失败';
  } catch (err) {
    state.projectError = err?.message || String(err);
  } finally {
    state.projectLoading = false;
  }
  return state.project;
}

async function prepareTools() {
  if (!state.toolsReady) await loadTools();
  await ensureWorkspace();
  await loadAgents();
  await loadProject();
}

function askToolApproval(ctx, tool, runtimeApproval) {
  const { draft, node, s } = ctx;
  const risk = runtimeApproval?.riskLevel ? ` · 风险 ${runtimeApproval.riskLevel}` : '';
  return withApprovalLock(() => {
    draft.approval = {
      title: '需要你确认这一步',
      text: `模型请求执行「${tool.verb}」：${tool.target}${risk}`,
      command: tool.name === 'run_command' ? String(tool.args?.command || '') : tool.target,
      // 自动允许按渲染层归一化后的 target 记账，命令里的多空格/截断不会导致前后键不一致
      key: tool.target,
      outcome: null,
    };
    $('.slot-approval', node).innerHTML = approvalCard(draft.approval);
    if (s) { s.state = 'pending'; renderSessions(); }
    scrollToBottom(true);
    return new Promise((resolve) => {
      approvalWaiters.set(draft, { resolve, node });
    });
  });
}

function runApiTurn(ctx, opts) {
  const { draft, node, prose, s } = ctx;
  let body = '';
  let raf = 0;
  let retryTick = null;
  let finished = false;

  // 工具结果回灌给模型的字符预算：16 次调用 × 单条 60k 会撑爆 200k 输入上限
  const TOOL_CONTEXT_BUDGET = 120000;
  let toolContextUsed = 0;
  const forModel = (text) => {
    const room = TOOL_CONTEXT_BUDGET - toolContextUsed;
    if (room <= 0) return '（本轮工具结果总量已达上限，未再展开；请基于已有结果继续或直接结束。）';
    const out = text.length > room ? text.slice(0, room) + '\n…（超出本轮工具上下文预算，已截断）' : text;
    toolContextUsed += out.length;
    return out;
  };

  const painter = createStreamPainter(prose);
  painter.think(); // 首个 chunk 前的思考指示，避免「发出去就没动静」的死寂感
  const paint = () => {
    draft.body = body;
    painter.paint(body);
    scrollToBottom();
  };
  const schedulePaint = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; paint(); });
  };
  const setSummaryLabel = (label) => {
    if (draft.summary.label === label) return;
    draft.summary.label = label;
    const summaryEl = $('.summary', node);
    if (summaryEl) summaryEl.innerHTML = summaryText(draft.summary) + ico('i-chevron', 'ico tiny chev');
  };

  // 工具调用跑完后正文开始返回时，自动收起折叠区一次（ZCode shouldAutoCollapseReasoning 模式）。
  // 用户本轮手动点过就不再动；中断/出错路径收不到正文 chunk，天然不会触发。
  let toolsAutoCollapsed = false;
  const autoCollapseTools = () => {
    if (toolsAutoCollapsed || node.dataset.toolsTouched) return;
    const tools = $('.tools', node);
    if (!tools || tools.classList.contains('hidden')) return;
    const head = $('.summary', node);
    toolsAutoCollapsed = true;
    tools.classList.add('hidden');
    head?.classList.add('collapsed');
  };

  const clearRetry = () => {
    if (retryTick) { clearInterval(retryTick); retryTick = null; }
    const slot = $('.slot-retry', node);
    if (slot) slot.innerHTML = '';
  };

  const showRetry = (e) => {
    clearRetry();
    const slot = $('.slot-retry', node);
    if (!slot) return;
    const total = Number(e.maxAttempts) || 1;
    const next = Number(e.nextAttempt) || 2;
    const reason = e.code === '429' ? '被限流' : e.code === 'EMPTY_OUTPUT' ? '空响应' : '连接中断';
    const detail = String(e.message || '').replace(/\s+/g, ' ').slice(0, 60);
    slot.innerHTML = `
      <div class="retry">
        ${ico('i-retry')}
        <span><b>${esc(reason)}</b>，<span class="retry-num">—</span>后重试（第 ${next}/${total} 次）</span>
        <span class="retry-msg">${esc(detail)}</span>
        <button data-retry-cancel>取消</button>
      </div>`;
    const num = $('.retry-num', slot);
    const deadline = Date.now() + Math.max(0, Number(e.delayMs) || 0);
    const tick = () => {
      const left = Math.max(0, deadline - Date.now());
      if (num) num.textContent = (left / 1000).toFixed(1) + ' 秒';
    };
    tick();
    retryTick = setInterval(tick, 120);

    draft.retries = Number(e.attempt) || draft.retries;
    setSummaryLabel('重试中');
    scrollToBottom();
  };

  const finishApi = (err) => {
    if (finished) return;
    finished = true;
    clearRetry();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const aborted = !!draft.aborted || state.stopRequested;

    // 回合终结同步到 Runtime：取消走 cancelTask，正常/失败走 finishRun
    if (draft.runtime?.runId && window.dsh?.runtime?.runs?.finish) {
      const rt = window.dsh.runtime;
      const { runId, taskId } = draft.runtime;
      try {
        if (aborted) {
          rt.tasks.cancel({ taskId, reason: state.stopRequested ? 'user_interrupted' : 'aborted' });
        } else {
          const pending = rt.runs.finish({
            runId,
            outcome: err ? 'failed' : 'succeeded',
            summary: String(err || draft.body || '').slice(0, 500),
            errorCode: err ? 'MODEL_ERROR' : undefined,
          });
          Promise.resolve(pending).then((res) => {
            const v = res?.ok ? res.data?.validation : null;
            if (!v || v.status !== 'failed') return;
            draft.validation = v;
            draft.validationFailed = true;
            draft.summary.label = '校验失败';
            const head = $('.summary', node);
            if (head) head.innerHTML = summaryText(draft.summary) + ico('i-chevron', 'ico tiny chev');
            const failed = v.checks.filter((c) => c.status === 'failed');
            const lines = failed.map((c) => `- ${c.name}：${c.detail}`).join('\n');
            const bodyEl = $('.prose', node);
            if (bodyEl) bodyEl.insertAdjacentHTML('beforeend', markdown(`**后置校验未通过**\n\n${lines}`));
            toast('后置校验未通过，任务已标记失败');
          }).catch(() => { /* Runtime 不可用时不影响 UI 收尾 */ });
        }
      } catch { /* Runtime 不可用时不影响 UI 收尾 */ }
    }

    if (err) {
      draft.error = err;
      draft.body = `**API 调用失败**\n\n\`\`\`\n${err}\n\`\`\``;
      prose.innerHTML = markdown(draft.body);
      toast('API 调用失败');
      finish(draft, node, s, false, '调用失败');
    } else {
      draft.body = body || '（模型未返回内容）';
      prose.innerHTML = markdown(draft.body);
      finish(draft, node, s, aborted);
    }
  };

  /** 发一次模型请求；返回该步正文与工具调用，不负责收尾。 */
  const requestStep = (messages, toolSpecs) => new Promise((resolve) => {
    const id = 'turn-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let stepText = '';
    let firstChunk = true;
    let settled = false;
    let timer = null;

    const handler = {
      id,
      errorEvt: null,
      toolCalls: [],
      usage: null,
      onEvent(e) {
        if (settled) return;
        if (e.type === 'retry') { showRetry(e); }
        else if (e.type === 'chunk') {
          if (retryTick) clearRetry();
          setSummaryLabel('进行中');
          // 本轮已有工具调用、且是本步首个非空正文 chunk → 自动收起一次（仅 runApiTurn，预览路径不动）
          if (firstChunk && e.text && draft.tools.length) autoCollapseTools();
          stepText += e.text;
          if (firstChunk) {
            body += body ? '\n\n' + e.text : e.text;
            firstChunk = false;
          } else {
            body += e.text;
          }
          schedulePaint();
        } else if (e.type === 'usage') { draft.usage = e.usage; handler.usage = e.usage; }
        else if (e.type === 'error') { handler.errorEvt = e; }
        else if (e.type === 'done') {
          handler.toolCalls = Array.isArray(e.toolCalls) ? e.toolCalls : [];
          if (typeof e.retries === 'number') draft.retries = e.retries;
          if (typeof e.attempts === 'number') draft.attempts = e.attempts;
          if (e.aborted) draft.aborted = true;
          handler.end(handler.errorEvt?.message || '');
        }
      },
      end(err, endOpts = {}) {
        if (settled) return;
        settled = true;
        clearRetry();
        clearTimeout(timer);
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        state.turns.delete(id);
        if (state.activeTurnId === id) state.activeTurnId = null;
        const aborted = !!endOpts.localAbort || !!draft.aborted || state.stopRequested;
        if (aborted) draft.aborted = true;
        resolve({ error: err || null, aborted, text: stepText, toolCalls: handler.toolCalls, usage: handler.usage });
      },
    };

    state.turns.set(id, handler);
    state.activeTurnId = id;
    timer = setTimeout(() => {
      window.dsh?.model?.abort(id);
      handler.end(`请求超时：${Math.round(LIMITS.turnTimeoutMs / 1000)} 秒内未结束`);
    }, LIMITS.turnTimeoutMs);

    try {
      window.dsh.model.chat(id, opts.cfg, messages, toolSpecs || undefined);
    } catch (err) {
      handler.end(`发起请求失败：${err?.message || err}`);
    }
  });

  /** Runtime 可用时，工具调用统一走 propose → 审批 → execute，并记录 ToolCall 事件。 */
  const runtimeApi = window.dsh?.runtime;
  const runtimeRunId = () => draft.runtime?.runId || '';

  const beginToolStep = async () => {
    if (!runtimeApi?.runs?.beginStep || !runtimeRunId()) return null;
    try {
      const r = await runtimeApi.runs.beginStep({ runId: runtimeRunId(), kind: 'tool_call' });
      return r?.ok ? r.data.step.id : null;
    } catch { return null; }
  };
  const finishToolStep = async (stepId, status) => {
    if (!stepId || !runtimeApi?.runs?.finishStep) return;
    try { await runtimeApi.runs.finishStep({ stepId, status }); } catch { /* 运行可能已取消 */ }
  };

  const applyToolSuccess = (tool, name, r) => {
    tool.status = 'ok';
    tool.meta = r.meta?.label || '完成';
    tool.result = String(r.content || '');
    if (name === 'write_file') {
      noteWrittenFile(draft, tool.args?.path, r.meta?.label || '已写入');
      const filesSlot = $('.slot-files', node);
      if (filesSlot) filesSlot.innerHTML = filesCard(draft.files);
    }
    if (name === 'todo_write') {
      draft.tasks = Array.isArray(r.tasks) ? r.tasks : [];
      active().todoTasks = draft.tasks;
      renderTasks(node, draft);
      renderTodoPanel();
    }
    if (name === 'project_architecture') {
      loadProject(true).then(() => {
        if (state.projectOpen) renderArchPage();
      }).catch(() => {});
    }
  };

  const runToolViaRuntime = async (tool, name, args) => {
    if (!runtimeApi?.tools?.propose || !runtimeRunId()) return undefined;
    let stepId = null;
    try {
      stepId = await beginToolStep();
      const proposal = await runtimeApi.tools.propose({
        runId: runtimeRunId(),
        stepId,
        name,
        args,
        profile: state.permission,
        modelToolCallId: tool.id,
      });
      if (!proposal?.ok) {
        const code = proposal?.error?.code;
        if (code === 'EXECUTOR_UNAVAILABLE' || code === 'INTERNAL') { finishToolStep(stepId, 'canceled'); return undefined; }
        tool.status = 'error';
        tool.meta = '运行时拒绝';
        tool.result = proposal?.error?.message || '工具调用被运行时拒绝';
        renderTools(node, draft);
        finishToolStep(stepId, 'failed');
        return `工具调用失败（${name}）：${tool.result}`;
      }

      const p = proposal.data;
      if (p.status === 'denied') {
        tool.status = 'denied';
        tool.meta = '策略拒绝';
        tool.result = `策略拒绝执行该工具（${name}）：${p.message || p.policy?.reason || ''}`;
        renderTools(node, draft);
        finishToolStep(stepId, 'canceled');
        return `${tool.result} 不要重复同样的调用，直接向用户说明。`;
      }

      let approvalId = p.approval?.id || '';
      if (p.status === 'waiting_approval') {
        const key = active().id + '::' + approvalKey(name, args);
        let answer;
        if (state.autoApproved.has(key)) {
          answer = 'always';
          const auto = await runtimeApi.approvals.decide({
            approvalId, decision: 'approved', scope: 'run', reason: '本次会话已允许该目标',
          });
          if (!auto?.ok || auto.data?.expired) answer = 'deny';
        } else {
          answer = await askToolApproval(ctx, tool, p.approval);
          const decided = await runtimeApi.approvals.decide({
            approvalId,
            decision: answer === 'deny' ? 'denied' : 'approved',
            scope: answer === 'always' ? 'run' : 'once',
            reason: answer === 'deny' ? '用户拒绝' : '用户批准',
          });
          if (!decided?.ok || decided.data?.expired) answer = 'deny';
          if (state.stopRequested) answer = 'deny';
        }
        ctx.s.state = 'running';
        renderSessions();
        if (answer === 'deny') {
          tool.status = 'denied';
          tool.meta = '用户拒绝';
          tool.result = `用户拒绝执行该工具（${name}）。`;
          renderTools(node, draft);
          finishToolStep(stepId, 'canceled');
          return state.stopRequested ? null : `${tool.result} 不要重复同样的调用，直接向用户说明。`;
        }
        if (answer === 'always') state.autoApproved.add(key);
      }

      if (state.stopRequested) return null;
      tool.status = 'running';
      tool.meta = '执行中';
      renderTools(node, draft);
      scrollToBottom();

      const executed = await runtimeApi.tools.execute({
        toolCallId: p.toolCallId,
        approvalId,
        profile: state.permission,
        workspace: state.workspace,
        providerConfig: opts.cfg ? { baseUrl: opts.cfg.baseUrl, key: opts.cfg.key, model: opts.cfg.model, retry: opts.cfg.retry } : undefined,
      });
      if (!executed?.ok) {
        tool.status = 'error';
        tool.meta = '执行失败';
        tool.result = executed?.error?.message || '工具执行失败';
        renderTools(node, draft);
        finishToolStep(stepId, 'failed');
        return `工具执行失败（${name}）：${tool.result}`;
      }

      const r = executed.data;
      if (state.stopRequested) {
        tool.status = 'error';
        tool.meta = '已中断';
        tool.result = '本轮已被用户中断，工具执行结果未采用。';
        renderTools(node, draft);
        finishToolStep(stepId, 'canceled');
        return null;
      }
      if (r.ok) {
        applyToolSuccess(tool, name, r);
        renderTools(node, draft);
        scrollToBottom();
        finishToolStep(stepId, 'succeeded');
        return forModel(tool.result);
      }
      tool.status = 'error';
      tool.meta = r.status === 'unknown' ? '结果未知' : (r.code === 'DENIED' ? '被拒绝' : '失败');
      tool.result = String(r.error || r.content || '工具执行失败');
      renderTools(node, draft);
      scrollToBottom();
      finishToolStep(stepId, 'failed');
      return forModel(`工具执行失败（${name}）：${r.error || r.code || '未知错误'}${r.content ? '\n' + r.content : ''}`);
    } catch (err) {
      finishToolStep(stepId, 'canceled');
      console.warn('[runtime] 工具执行异常，回退本地执行：', err?.message || err);
      return undefined;
    }
  };

  /** 执行一个工具调用；返回给模型的工具消息。中断返回 null。 */
  const runToolCall = async (call) => {
    const name = String(call?.function?.name || '');
    const meta = state.toolMeta[name] || { verb: name || '工具', icon: 'i-terminal', tone: 'neutral' };
    let args = {};
    let parseError = '';
    try {
      args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) { parseError = '参数必须是 JSON 对象'; args = {}; }
    } catch (err) {
      parseError = err?.message || String(err);
    }

    const tool = {
      id: String(call?.id || 'tool-' + Date.now() + '-' + draft.tools.length),
      name,
      verb: meta.verb || name,
      icon: meta.icon || 'i-terminal',
      tone: meta.tone || 'neutral',
      target: describeToolTarget(name, args) || '（无参数）',
      status: 'pending',
      meta: parseError ? '参数错误' : '准备中',
      args,
      result: '',
      expanded: false,
    };
    draft.tools.push(tool);
    revealTools(node, draft);
    renderTools(node, draft);
    scrollToBottom();

    if (parseError) {
      tool.status = 'error';
      tool.meta = '参数错误';
      tool.result = `工具参数解析失败：${parseError}`;
      renderTools(node, draft);
      return tool.result;
    }

    if (runtimeApi?.tools?.propose && draft.runtime?.runId) {
      const viaRuntime = await runToolViaRuntime(tool, name, args);
      if (viaRuntime !== undefined) return viaRuntime;
    }

    const isReadOnly = READ_TOOLS.has(name) || state.readOnlyTools.has(name);
    let decision = 'allow';
    if (!isReadOnly) {
      if (state.permission === 'readonly') {
        decision = 'readonly';
      } else if (state.permission === 'ask') {
        const key = active().id + '::' + approvalKey(name, args);
        if (state.autoApproved.has(key)) {
          decision = 'auto';
        } else {
          const answer = await askToolApproval(ctx, tool);
          ctx.s.state = 'running';
          renderSessions();
          if (state.stopRequested) decision = 'abort';
          else if (answer === 'always') { state.autoApproved.add(key); decision = 'allow'; }
          else if (answer === 'once') decision = 'allow';
          else decision = 'deny';
        }
      }
    }

    if (decision === 'abort') return null;
    if (decision === 'readonly' || decision === 'deny') {
      tool.status = 'denied';
      tool.meta = decision === 'readonly' ? '只读模式拒绝' : '用户拒绝';
      tool.result = decision === 'readonly'
        ? `权限级别为只读，未执行 ${name}。`
        : `用户拒绝执行该工具（${name}）。`;
      renderTools(node, draft);
      return `${tool.result} 不要重复同样的调用，直接向用户说明。`;
    }
    if (state.stopRequested) return null;

    tool.status = 'running';
    tool.meta = '执行中';
    renderTools(node, draft);
    scrollToBottom();

    let r;
    try {
      if (!window.dsh?.tools?.exec) throw new Error('当前不在桌面外壳里运行，无法执行本地工具');
      r = await window.dsh.tools.exec(name, args, {
        workspace: state.workspace,
        permission: state.permission,
        approved: true,
      });
    } catch (err) {
      r = { ok: false, error: err?.message || String(err) };
    }

    if (state.stopRequested) {
      tool.status = 'error';
      tool.meta = '已中断';
      tool.result = '本轮已被用户中断，工具执行结果未采用。';
      renderTools(node, draft);
      return null;
    }

    if (r?.ok) {
      tool.status = 'ok';
      tool.meta = r.meta?.label || '完成';
      tool.result = String(r.content || '');
      if (name === 'write_file') {
        noteWrittenFile(draft, args.path, r.meta?.label || '已写入');
        const filesSlot = $('.slot-files', node);
        if (filesSlot) filesSlot.innerHTML = filesCard(draft.files);
      }
      if (name === 'todo_write') {
        draft.tasks = Array.isArray(r.tasks) ? r.tasks : [];
        active().todoTasks = draft.tasks;
        renderTasks(node, draft);
        renderTodoPanel();
      }
      renderTools(node, draft);
      scrollToBottom();
      return forModel(tool.result);
    }

    tool.status = 'error';
    tool.meta = r?.meta?.label || (r?.code === 'DENIED' ? '被拒绝' : '失败');
    tool.result = String(r?.content || r?.error || '工具执行失败');
    renderTools(node, draft);
    scrollToBottom();
    return forModel(`工具执行失败（${name}）：${r?.error || r?.code || '未知错误'}${r?.content ? '\n' + r.content : ''}`);
  };

  (async () => {
    if (opts.immediateError) { finishApi(opts.immediateError); return; }
    if (!state.toolsReady) await loadTools();
    await ensureWorkspace();

    const rt = window.dsh?.runtime;
    if (rt?.tasks?.create && !draft.runtime) {
      try {
        const lastUser = [...(opts.messages || [])].reverse().find((m) => m.role === 'user');
        const created = await rt.tasks.create({
          title: String(s.title || '本地对话').slice(0, 100),
          input: String(lastUser?.content || '').slice(0, 500),
          providerId: opts.cfg?.baseUrl || '',
          model: opts.cfg?.model || '',
          workspace: state.workspace || '',
          agentId: state.project?.project?.mainAgentId || undefined,
          idempotencyKey: `${s.id}:${draft.startedAt}`,
        });
        if (created?.ok && created.data.run) {
          draft.runtime = { taskId: created.data.task.id, runId: created.data.run.id };
          if (inspector.open) {
            stopReplay();
            inspector.replayCursor = null;
            inspector.nodeDetail = '';
            inspector.runId = draft.runtime.runId;
            refreshInspector();
          }
        }
      } catch { /* Runtime 不可用时退化为纯本地回合 */ }
    }

    const messages = opts.messages.slice();

    // 参考 opencode：工具调用次数不设上限，循环到模型不再调用工具、用户中断或出错为止
    for (;;) {
      if (state.stopRequested) { draft.aborted = true; break; }
      const useTools = state.toolSpecs.length > 0;

      let modelStepId = null;
      let modelCallId = null;
      if (rt?.runs?.beginStep && draft.runtime?.runId) {
        try {
          const st = await rt.runs.beginStep({ runId: draft.runtime.runId, kind: 'model' });
          modelStepId = st?.ok ? st.data.step.id : null;
          if (modelStepId && rt.runs.modelStart) {
            const mc = await rt.runs.modelStart({
              runId: draft.runtime.runId,
              stepId: modelStepId,
              providerId: opts.cfg?.baseUrl || '',
              model: opts.cfg?.model || '',
              messageCount: messages.length,
              approxInputTokens: Math.round(messages.reduce((n, m) => n + String(m.content || '').length, 0) / 4),
              meta: messages.map((m) => ({ role: m.role, chars: String(m.content || '').length })),
            });
            modelCallId = mc?.ok ? mc.data.modelCallId : null;
          }
        } catch { /* 记录失败不阻塞对话 */ }
      }

      const r = await requestStep(messages, useTools ? state.toolSpecs : null);

      if (modelCallId) {
        try {
          await rt.runs.modelFinish({
            modelCallId,
            status: r.error ? 'failed' : r.aborted ? 'aborted' : 'completed',
            usage: r.usage,
            error: r.error ? { code: 'MODEL_ERROR', message: String(r.error).slice(0, 200) } : undefined,
          });
        } catch { /* 忽略追踪失败 */ }
      }
      if (modelStepId) {
        try {
          await rt.runs.finishStep({
            stepId: modelStepId,
            status: r.error ? 'failed' : r.aborted ? 'canceled' : 'succeeded',
            modelCallId,
          });
        } catch { /* 忽略追踪失败 */ }
      }

      if (r.error) { finishApi(r.error); return; }
      if (r.aborted) { draft.aborted = true; break; }
      // 工具回合里模型的文字也显示出来：并入回合正文（带分隔，避免和上一段粘在一起）
      if (r.text && r.toolCalls.length) {
        body = body ? body + '\n\n' + r.text : r.text;
        schedulePaint();
      }
      if (!r.toolCalls.length) break;

      if (!useTools) {
        // 工具定义不可用时收到 tool_calls：不执行，结束本轮
        messages.push({ role: 'assistant', content: r.text || '', tool_calls: r.toolCalls });
        for (const call of r.toolCalls) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: '本地工具定义未加载，该调用未执行。' });
        }
        break;
      }

      messages.push({ role: 'assistant', content: r.text || '', tool_calls: r.toolCalls });
      let stopped = false;
      // 并行执行工具调用：delegate_task 等子任务不再互相阻塞，一轮内的多个委派同时排队运行
      const results = await Promise.all(r.toolCalls.map((call) => runToolCall(call)));
      for (const call of r.toolCalls) {
        const result = results.shift();
        if (result === null) { stopped = true; continue; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        if (state.stopRequested) { stopped = true; break; }
      }
      if (stopped) {
        if (state.stopRequested) draft.aborted = true;
        break;
      }
    }

    finishApi(null);
  })().catch((err) => {
    finishApi(`内部错误：${err?.message || err}`);
  });
}

/* ───────── 离线预览回合（内置示例数据回放，不是实现占位） ───────── */

async function interruptibleSleep(ms) {
  let left = ms;
  while (left > 0 && !state.stopRequested) {
    const step = Math.min(40, left);
    await sleep(step);
    left -= step;
  }
}

async function runPreviewTurn(text, ctx) {
  const { s, draft, node, prose, toolsBox, summary } = ctx;
  const script = pickScript(text);
  let stopped = false;
  const check = () => state.stopRequested;

  const bump = () => {
    draft.summary.tools = draft.tools.length;
    summary.innerHTML = summaryText(draft.summary) + ico('i-chevron', 'ico tiny chev');
    summary.classList.remove('collapsed');
    delete summary.dataset.empty;
    toolsBox.classList.remove('hidden');
  };

  await interruptibleSleep(420);
  if (check()) { stopped = true; }
  if (!stopped) {
    for (const tool of script.tools || []) {
      draft.tools.push(tool);
      toolsBox.insertAdjacentHTML('beforeend', toolRow(tool));
      const row = toolsBox.lastElementChild;
      const spin = document.createElement('span');
      spin.className = 't-spin';
      row.appendChild(spin);
      bump();
      scrollToBottom();
      await interruptibleSleep(300 + Math.random() * 300);
      spin.remove();
      if (check()) { stopped = true; break; }
    }
  }

  if (!stopped && script.approval) {
    const a = { ...script.approval };
    const key = s.id + '::' + a.command;
    // 权限级别决定审批卡是「自动放行 / 自动拒绝 / 等人点」
    if (state.permission === 'full') {
      a.outcome = 'always';
      a.label = '完全权限已自动放行';
    } else if (state.permission === 'readonly') {
      a.outcome = 'deny';
      a.label = '只读模式已拒绝写入';
    } else if (state.autoApproved.has(key)) {
      a.outcome = 'always';
      a.label = '本次会话已自动允许';
    }
    draft.approval = a;
    $('.slot-approval', node).innerHTML = approvalCard(a);
    scrollToBottom(true);
    if (!a.outcome) {
      s.state = 'pending';
      renderSessions();
      await new Promise((resolve) => approvalWaiters.set(draft, { resolve, node }));
      s.state = 'running';
      renderSessions();
      if (check()) stopped = true;
    }
  }

  if (!stopped) await streamText(script.body || '', prose, draft);
  if (check()) stopped = true;

  if (!stopped) {
    draft.files = script.files || [];
    if (draft.files.length) $('.slot-files', node).innerHTML = filesCard(draft.files);
  }
  finish(draft, node, s, stopped);
}

async function streamText(text, prose, draft) {
  draft.body = '';
  const painter = createStreamPainter(prose);
  let i = 0;
  while (i < text.length) {
    if (state.stopRequested) break;
    const step = 2 + Math.floor(Math.random() * 3);
    i = Math.min(text.length, i + step);
    draft.body = text.slice(0, i);
    painter.paint(draft.body);
    scrollToBottom();
    await sleep(16);
  }
  draft.body = text.slice(0, i);
  prose.innerHTML = markdown(draft.body);
}

function buildMetrics(draft) {
  const seconds = ((draft.finishedAt - draft.startedAt) / 1000).toFixed(1);
  const chars = (draft.body || '').length;
  const tokens = draft.usage?.total_tokens ?? draft.usage?.totalTokens;
  const retried = draft.retries > 0 ? ` · 重试 ${draft.retries} 次` : '';
  return `${seconds} 秒 · ${chars} 字 · ${draft.tools.length} 次工具${tokens ? ` · ${tokens} tokens` : ''}${retried}`;
}

function finish(draft, node, session, stopped, overrideLabel) {
  draft.finishedAt = Date.now();
  draft.summary.label = overrideLabel
    || (draft.validationFailed ? '校验失败' : stopped ? '已中断' : '已完成');
  draft.summary.tools = draft.tools.length;
  draft.summary.messages = draft.body ? 1 : 0;
  draft.metrics = buildMetrics(draft);

  const summary = $('.summary', node);
  if (summary) summary.innerHTML = summaryText(draft.summary) + ico('i-chevron', 'ico tiny chev');
  const slot = $('.slot-metrics', node);
  if (slot) {
    slot.innerHTML = `<div class="metrics">${esc(draft.metrics)} ${ico('i-chevron-right', 'ico tiny')}</div>`;
    if (stopped && draft.resumeFrom) {
      slot.insertAdjacentHTML('beforeend',
        `<div class="resume-row"><span>本轮已中断</span><button class="link-strong" data-resume>继续</button></div>`);
    } else if (draft.error) {
      // 失败回合给一条可操作的「重试」入口，不再只留一句错误 markdown（原只有中断态才有按钮）
      slot.insertAdjacentHTML('beforeend',
        `<div class="resume-row"><span>本轮调用失败</span><button class="link-strong" data-resume>重试</button></div>`);
    }
  }

  session.state = 'idle';
  state.busy = false;
  state.stopRequested = false;
  saveSessions();
  // 应用在后台时结束的回合标为未读，切回来点一下会话即清除
  if (document.hidden) session.unread = true;
  renderHeader();
  renderSessions();
  updateSendState();
  scrollToBottom();

  // 插话 / 立即发送优先；队列只在正常结束（非中断、非失败）时自动继续
  if (state.pendingTurn) {
    const next = state.pendingTurn;
    state.pendingTurn = null;
    setTimeout(() => runTurn(next), 80);
    return;
  }
  if (!stopped && !overrideLabel && state.pending) {
    const next = state.pending;
    state.pending = null;
    $('#queue').hidden = true;
    setTimeout(() => runTurn(next), 380);
  }
}

function abortActiveTurn() {
  state.stopRequested = true;
  for (const [msg, waiter] of [...approvalWaiters.entries()]) {
    approvalWaiters.delete(msg);
    if (msg.approval && !msg.approval.outcome) {
      msg.approval.outcome = 'deny';
      msg.approval.label = '本轮已中断';
      const slot = $('.slot-approval', waiter.node);
      if (slot) slot.innerHTML = approvalCard(msg.approval);
    }
    waiter.resolve('deny');
  }
  const id = state.activeTurnId;
  const handler = id ? state.turns.get(id) : null;
  if (handler) {
    // 顺序很重要：先让主进程取消网络流，再立刻本地收尾。
    // 不等待 IPC 回执，否则 read() 阻塞时界面会一直停在 busy。
    window.dsh?.model?.abort(id);
    handler.end('', { localAbort: true });
  } else {
    // 离线预览回合没有 IPC 句柄，靠 stopRequested 由可中断的 sleep 立即收尾
    window.dsh?.model?.abortAll?.();
  }
}

function stopTurn() {
  if (!state.busy) return;
  abortActiveTurn();
  toast('已中断本轮');
}

function requestInterrupt(text) {
  state.pendingTurn = String(text).trim();
  abortActiveTurn();
  // 预览回合没有 IPC 事件，靠 stopRequested 自行收尾并消费 pendingTurn
}

/* ───────── 输入历史（↑/↓ 翻阅，本机 localStorage，最多 30 条；空值/重复不入栈） ───────── */
let histIdx = -1;
function inputHistory() {
  if (!Array.isArray(state.inputHistory)) {
    try { state.inputHistory = JSON.parse(readStorage('dsh.inputHistory', '[]')) || []; }
    catch { state.inputHistory = []; }
  }
  return state.inputHistory;
}
function recordInputHistory(text) {
  const h = inputHistory();
  if (h[0] === text) return;
  h.unshift(text);
  if (h.length > 30) h.length = 30;
  histIdx = -1;
  try { writeStorage('dsh.inputHistory', JSON.stringify(h)); } catch { /* 存储满不影响发送 */ }
}
function tryHistory(dir) {
  const ta = $('#input');
  const h = inputHistory();
  if (!h.length) return false;
  // 只在输入为空（翻出第一条）或已在历史导航中时接管方向键，不干扰正常编辑
  if (histIdx === -1 && ta.value && dir === -1) return false;
  histIdx = Math.min(Math.max(histIdx + dir, -1), h.length - 1);
  ta.value = histIdx === -1 ? '' : h[histIdx];
  autoGrow();
  updateSendState();
  updateSlash();
  return true;
}

/* ───────── 输入框 / 附件 / 命令 ───────── */

function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 176) + 'px';
}

function updateSendState() {
  const btn = $('#sendBtn');
  const has = $('#input').value.trim().length > 0;
  btn.disabled = !has && !state.busy;
  btn.classList.toggle('streaming', state.busy);
  btn.innerHTML = state.busy ? ico('i-stop') : ico('i-arrow-up');
  btn.title = state.busy ? (has ? '中断并发送新消息' : '中断本轮') : '发送';
  updateInputCount();
}

/* 输入长度反馈：只在接近/超过上限时出现，平时零干扰 */
function updateInputCount() {
  const el = $('#inputCount');
  if (!el) return;
  const len = $('#input').value.length;
  const warn = LIMITS.maxInput * 0.8;
  if (len >= warn) {
    el.hidden = false;
    el.textContent = `${len.toLocaleString()} / ${LIMITS.maxInput.toLocaleString()}`;
    el.classList.toggle('is-over', len > LIMITS.maxInput);
  } else {
    el.hidden = true;
  }
}

function send() {
  const input = $('#input');
  const text = input.value.trim();

  if (state.busy) {
    if (!text) { stopTurn(); return; }
    if (state.mode === 'queue') {
      queuePending(text);
    } else {
      requestInterrupt(text);     // now / steer 都真正中止旧请求后再发
    }
    input.value = '';
    autoGrow();
    updateSendState();
    return;
  }

  if (!text) return;
  if (text.length > LIMITS.maxInput) {
    toast(`输入过长（${text.length} 字符），上限 ${LIMITS.maxInput}`);
    return;
  }

  if (text.startsWith('/')) {
    handleCommand(text);
    input.value = '';
    autoGrow();
    updateSendState();
    hideMenus();
    return;
  }

  input.value = '';
  autoGrow();
  updateSendState();
  hideMenus();
  recordInputHistory(text);
  clearDraft();
  runTurn(text);
}

function queuePending(text) {
  state.pending = text;
  $('#queueText').textContent = text;
  $('#queue').hidden = false;
  toast('已加入队列');
}

function handleCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  switch (cmd) {
    case '/new': newChat(); break;
    case '/model': openModelSheet(); break;
    case '/stop': stopTurn(); break;
    case '/compact': compactContext(); break;
    case '/arch': openArchPage(); break;
    case '/goal': handleGoal(parts.slice(1).join(' ').trim()); break;
    default:
      toast(`未识别的命令「${cmd}」，可用：/new、/model、/compact、/arch、/stop、/goal`);
  }
}

/** /goal：设置或查看本会话目标，目标会以 system 消息注入每轮请求 */
function handleGoal(text) {
  const s = active();
  if (!s) return;
  if (!text) {
    if (s.goal) toast(`当前目标：${s.goal}`);
    else toast('还没有设置目标。用法：/goal <目标描述>');
    return;
  }
  s.goal = text.slice(0, 500);
  saveSessions();
  renderHeader();
  renderTodoPanel();
  toast('会话目标已设置');
}

/** 真实上下文压缩：把历史消息折叠成摘要，后续请求以 system 消息注入 */
function compactContext() {
  if (state.busy) { toast('生成中不能压缩上下文'); return; }
  const s = active();
  const usable = s.messages.filter((m) => !m.compacted);
  if (usable.length < 2) { toast('当前会话没有可压缩的历史消息'); return; }

  const lines = usable.map((m) => {
    const content = m.role === 'user' ? m.text : (m.body || '');
    const flat = String(content).replace(/\s+/g, ' ').slice(0, 120);
    return `- ${m.role === 'user' ? '用户' : '助手'}：${flat}`;
  });
  const summary = lines.join('\n');
  state.compacted.set(s.id, summary);
  s.messages = [{
    role: 'assistant',
    summary: { label: '上下文已压缩', tools: 0, messages: 0 },
    tools: [], files: [], approval: null, metrics: '', compacted: true,
    body: `已将 ${usable.length} 条历史消息压缩为摘要，后续请求会带上这段上下文。\n\n${summary}`,
    startedAt: Date.now(), finishedAt: Date.now(),
  }];
  pruneMsgStore();
  renderChat();
  renderHeader();
  toast(`已压缩 ${usable.length} 条消息`);
}

function updateSlash() {
  const menu = $('#slashMenu');
  const value = $('#input').value;
  if (!value.startsWith('/') || value.includes(' ') || value.includes('\n')) { menu.hidden = true; return; }
  const rect = $('#composer').getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = rect.left + 'px';
  menu.style.top = Math.max(12, rect.top - menu.offsetHeight - 8) + 'px';
}

/* ───────── 附件（真实读取，失败逐项反馈） ───────── */

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|log|js|jsx|ts|tsx|py|java|go|rs|c|h|cpp|cs|rb|php|sh|bat|sql|html?|css|ini|toml|conf|env)$/i;

function renderAttachments() {
  const bar = $('#attachBar');
  if (!state.attachments.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = state.attachments.map((a, i) => `
    <span class="attach-chip ${a.error ? 'is-error' : ''}" title="${esc(a.error || a.name + ' · ' + formatBytes(a.size))}">
      ${ico(a.error ? 'i-close' : 'i-file')}
      <b>${esc(a.name)}</b>
      <span>${esc(a.error ? '读取失败' : formatBytes(a.size))}</span>
      <button data-attach-remove="${i}" title="移除">${ico('i-close')}</button>
    </span>`).join('');
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let added = 0;
  let skipped = 0;
  for (const f of files) {
    if (state.attachments.length >= LIMITS.maxAttachFiles) { skipped++; continue; }
    const entry = { name: f.name || '未命名', size: Number(f.size) || 0, type: f.type || '' };
    if (entry.size > LIMITS.maxAttachBytes) {
      entry.error = `超过 ${formatBytes(LIMITS.maxAttachBytes)} 上限`;
    } else if (!TEXT_EXT.test(entry.name) && !/^text\//i.test(entry.type) && !/json|xml|javascript/i.test(entry.type)) {
      entry.kind = '二进制';
    } else {
      try {
        const raw = await f.text();
        entry.text = raw.slice(0, LIMITS.maxAttachChars);
        entry.truncated = raw.length > LIMITS.maxAttachChars;
        entry.kind = '文本';
      } catch (err) {
        entry.error = `读取失败：${err?.message || err}`;
      }
    }
    state.attachments.push(entry);
    added++;
  }
  renderAttachments();
  if (added) toast(`已加入 ${added} 个附件${skipped ? `，另有 ${skipped} 个因数量上限跳过` : ''}`);
  else toast(`附件数量已达上限（${LIMITS.maxAttachFiles} 个）`);
}

function removeAttachment(i) {
  if (!Number.isInteger(i) || !state.attachments[i]) return;
  state.attachments.splice(i, 1);
  renderAttachments();
}

/* ───────── 浮层 ───────── */

/* 关闭动效共用：加 .is-closing 播完出场动画再真正隐藏。
   期间若被重新打开（is-closing 已被移除），超时回调自动作废，不会误关。 */
function animateOut(el, ms = 200) {
  if (!el || el.hidden) return;
  el.classList.add('is-closing');
  setTimeout(() => {
    if (!el.classList.contains('is-closing')) return;
    el.classList.remove('is-closing');
    el.hidden = true;
  }, ms);
}

function hideMenus() { $$('.menu').forEach((m) => animateOut(m, 130)); }

/* ───────── 任务清单面板（右上角） ───────── */

function renderTodoPanel() {
  const panel = $('#todoPanel');
  if (!panel) return;
  const s = active();
  const tasks = Array.isArray(s?.todoTasks) ? s.todoTasks : [];
  const body = $('#todoPanelBody');
  const summary = $('#todoPanelSummary');
  if (!tasks.length) {
    if (summary) summary.textContent = '';
    if (body) body.innerHTML = '<div class="todo-empty">本会话还没有任务清单</div>';
    return;
  }
  const done = tasks.filter((t) => t.status === 'completed').length;
  if (summary) summary.textContent = `${done}/${tasks.length} 完成`;
  if (body) {
    body.innerHTML = tasks.map((t) => `
      <div class="todo-item">
        <i class="todo-dot ${esc(t.status || 'pending')}"></i>
        <span>${esc(String(t.content || ''))}</span>
      </div>`).join('');
  }
}

function toggleTodoPanel() {
  const panel = $('#todoPanel');
  if (!panel) return;
  if (!panel.hidden) { animateOut(panel, 150); return; }
  hideMenus();
  renderTodoPanel();
  panel.classList.remove('is-closing');
  panel.hidden = false;
}

function openMenu(id, anchor) {
  const menu = document.getElementById(id);
  if (!menu.hidden) { animateOut(menu, 130); return; }
  hideMenus();
  menu.classList.remove('is-closing'); // 可能正播出场动画，取消它
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const width = menu.offsetWidth || 210;
  let left = r.left;
  left = Math.max(10, Math.min(left, window.innerWidth - width - 10));
  const h = menu.offsetHeight;
  const top = r.bottom + 7 + h <= window.innerHeight - 10
    ? r.bottom + 7 : Math.max(10, r.top - h - 14);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function openSheet(id) {
  hideMenus();
  const scrim = $('#scrim');
  scrim.classList.remove('is-closing');
  scrim.hidden = false;
  const sheet = document.getElementById(id);
  sheet.classList.remove('is-closing');
  sheet.hidden = false;
}
function closeSheets() {
  state.modelReturnSheet = '';
  state.modelSheetFrom = '';
  animateOut($('#scrim'), 170);
  $$('.sheet').forEach((s) => animateOut(s, 190));
}

/** 从模型列表返回时回到 API 面板，而不是把所有面板一起关掉。 */
function closeSheet(id) {
  if (id === 'modelSheet' && state.modelReturnSheet) {
    const back = state.modelReturnSheet;
    state.modelReturnSheet = '';
    state.modelSheetFrom = '';
    animateOut($('#modelSheet'), 190);
    const el = document.getElementById(back);
    if (el) {
      el.classList.remove('is-closing');
      el.hidden = false;
      $('#scrim').classList.remove('is-closing');
      $('#scrim').hidden = false;
      return;
    }
  }
  closeSheets();
}

/* Toast 队列：依次展示，互相不覆盖——旧实现单槽会把重要告警（如存储失败）顶掉 */
const toastQueue = [];
let toastBusy = false;
function toast(text) {
  toastQueue.push(String(text));
  if (toastQueue.length > 4) toastQueue.shift(); // 防积压：最多保留最近 4 条
  if (!toastBusy) nextToast();
}
function nextToast() {
  const text = toastQueue.shift();
  if (text === undefined) { toastBusy = false; return; }
  toastBusy = true;
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(nextToast, 200); // 等淡出过渡（180ms）走完再上第二条
  }, 2200);
}

/* ───────── Phase 5：Agent 管理与子 Agent 审批 ───────── */

let agentPermChoice = 'ask';

/* 子 Agent 模型选择：连接列表取自已保存的 API profiles，模型列表来自上游 /models */
function agentModelConfigFor(profileId) {
  const p = state.profiles.find((x) => x.id === profileId) || state.profiles[0];
  return p ? { baseUrl: p.baseUrl, key: p.key } : null;
}

function renderAgentModelPickers() {
  const profileSel = $('#agentModelProfile');
  const modelSel = $('#agentModel');
  if (!profileSel || !modelSel) return;
  const prevProfile = profileSel.value;
  const prevModel = modelSel.value;
  profileSel.innerHTML = state.profiles.length
    ? state.profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.baseUrl)}</option>`).join('')
    : '<option value="">（无可用连接，请先在 API 页添加）</option>';
  const picked = state.profiles.some((p) => p.id === prevProfile) ? prevProfile : (state.profiles[0]?.id || '');
  profileSel.value = picked;
  const models = (state.models || []).map((m) => m.id).filter(validModel);
  const source = models.length
    ? models
    : [state.connection.api?.model || DEFAULT_API.model].filter(Boolean);
  modelSel.innerHTML = source.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  if (source.includes(prevModel)) modelSel.value = prevModel;
  else if (!prevModel) modelSel.value = source[0] || '';
}

async function refreshAgentModelList() {
  renderAgentModelPickers();
  const cfg = agentModelConfigFor($('#agentModelProfile')?.value);
  if (!cfg || !window.dsh?.model?.list) return;
  try {
    const r = await window.dsh.model.list({ ...cfg, model: $('#agentModel')?.value || '' });
    if (r?.ok && Array.isArray(r.models) && r.models.length) {
      state.models = r.models.filter((m) => m && validModel(m.id));
      state.modelsFor = cfg.baseUrl + '|' + cfg.key;
      renderAgentModelPickers();
    }
  } catch { /* 列表拉取失败时保留当前选项 */ }
}

async function openAgentSheet() {
  closeSheets();
  openSheet('agentSheet');
  await loadAgents();
  renderAgentList();
  await refreshAgentModelList();
}

function renderAgentList() {
  const box = $('#agentList');
  if (!box) return;
  if (!state.agents.length) {
    box.innerHTML = '<div class="fine">还没有 Agent。创建一个后可把自包含的子任务委派给它。</div>';
    return;
  }
  box.innerHTML = state.agents.map((a) => {
    const archived = a.status === 'archived';
    const isDefault = a.id === state.defaultAgentId;
    return `<div class="agent-row ${archived ? 'is-archived' : ''}">
      <span class="agent-row-main">
        <b>${esc(a.name)}${isDefault ? ' · 默认' : ''}</b>
        <small>v${a.currentVersion} · ${esc(a.version?.permissionProfileId || '?')} · ${esc(a.status)}</small>
      </span>
      <span class="agent-tag">${isDefault ? '当前' : archived ? '已归档' : '可委派'}</span>
      ${!archived && !isDefault ? `<button class="agent-archive" data-agent-archive="${esc(a.id)}">归档</button>` : ''}
    </div>`;
  }).join('');
  const active = state.agents.filter((a) => a.status === 'active').length;
  const summary = $('#agentsSummary');
  if (summary) summary.textContent = `${active} 个可用 Agent`;
}

async function createAgentFromForm() {
  const btn = $('#agentCreate');
  const name = $('#agentName')?.value.trim() || '';
  if (!name) { toast('请填写 Agent 名称'); return; }
  if (!window.dsh?.runtime?.agents?.create) { toast('Runtime 不可用'); return; }
  if (btn) btn.disabled = true;
  try {
    const modelProfileId = $('#agentModelProfile')?.value || '';
    const cfgForModel = agentModelConfigFor(modelProfileId);
    // providerId 存 baseUrl，让 runtime 按 URL 派生 prov_ 标识（下拉仍按 profile id 选择）
    const r = await window.dsh.runtime.agents.create({
      name,
      systemPrompt: $('#agentPrompt')?.value || '',
      permissionProfileId: agentPermChoice,
      model: {
        providerId: cfgForModel?.baseUrl || '',
        model: $('#agentModel')?.value || '',
      },
      ...(cfgForModel ? { provider: cfgForModel } : {}),
    });
    if (!r?.ok) { toast(`创建失败：${r?.error?.message || '未知错误'}`); return; }
    $('#agentName').value = '';
    $('#agentPrompt').value = '';
    document.querySelector('#agentFine').textContent = `已创建「${name}」；下一轮对话即可委派。`;
    await loadAgents();
    renderAgentList();
    if (inspector.open) refreshInspector();
    toast('Agent 已创建');
  } catch (err) {
    toast(`创建失败：${err?.message || err}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function archiveAgentFromUi(agentId) {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent || !window.dsh?.runtime?.agents?.archive) return;
  try {
    const r = await window.dsh.runtime.agents.archive(agentId);
    if (!r?.ok) { toast(`归档失败：${r?.error?.message || '未知错误'}`); return; }
    await loadAgents();
    renderAgentList();
    if (inspector.open) refreshInspector();
    toast(`已归档「${agent.name}」`);
  } catch (err) {
    toast(`归档失败：${err?.message || err}`);
  }
}

function delegationApprovalCard(item) {
  const source = item.agentName || item.agentId || '子 Agent';
  const parent = item.parentTitle ? ` · 父任务「${item.parentTitle}」` : '';
  return `<div class="deleg-approval" data-approval-id="${esc(item.id)}">
    <b>子 Agent 请求执行工具</b>
    <p>来源：${esc(source)}${esc(parent)}<br>${esc(item.toolName || '工具')} · 风险 ${esc(item.riskLevel || '-')}；这是独立子任务发起的审批，不会沿用父级批准。</p>
    <button class="primary" data-deleg-approve="once">允许一次</button>
    <button data-deleg-approve="deny">拒绝</button>
  </div>`;
}

async function describeDelegationApproval(item) {
  const rt = window.dsh?.runtime;
  if (!rt?.tasks?.get || !item?.taskId) return;
  try {
    const t = await rt.tasks.get(item.taskId);
    if (!t?.ok) return;
    const task = t.data.task;
    const agent = state.agents.find((a) => a.id === task.agentId);
    item.agentId = task.agentId;
    item.agentName = agent?.name || task.agentId;
    if (task.parentTaskId) {
      const pt = await rt.tasks.get(task.parentTaskId);
      if (pt?.ok) item.parentTitle = pt.data.task?.title || '';
    }
    if (state.delegApprovals.has(item.id)) renderDelegationApprovals();
  } catch { /* 来源信息缺失不阻塞审批 */ }
}

function renderDelegationApprovals() {
  const box = $('#delegApprovals');
  if (!box) return;
  const items = [...state.delegApprovals.values()];
  box.hidden = items.length === 0;
  box.innerHTML = items.map(delegationApprovalCard).join('');
}

function isInlineRun(runId) {
  if (!runId) return false;
  const s = active();
  return !!s?.messages.some((m) => m?.runtime?.runId === runId);
}

function handleDelegationApprovalEvent(event) {
  if (!event || typeof event.type !== 'string') return;
  const p = event.payload || {};
  if (event.type === 'approval.requested' && p.approvalId) {
    if (isInlineRun(event.runId)) return;
    const item = {
      id: p.approvalId,
      toolName: p.toolName,
      riskLevel: p.riskLevel,
      runId: event.runId,
      taskId: event.taskId,
    };
    state.delegApprovals.set(p.approvalId, item);
    renderDelegationApprovals();
    describeDelegationApproval(item);
    return;
  }
  if (['approval.decided', 'approval.canceled', 'approval.expired'].includes(event.type) && p.approvalId) {
    if (state.delegApprovals.delete(p.approvalId)) renderDelegationApprovals();
  }
}

async function decideDelegationApproval(approvalId, decision) {
  const item = state.delegApprovals.get(approvalId);
  if (!item || !window.dsh?.runtime?.approvals?.decide) return;
  state.delegApprovals.delete(approvalId);
  renderDelegationApprovals();
  try {
    await window.dsh.runtime.approvals.decide({
      approvalId,
      decision: decision === 'deny' ? 'denied' : 'approved',
      scope: 'once',
      reason: decision === 'deny' ? '用户在委派审批中拒绝' : '用户在委派审批中允许',
    });
  } catch (err) {
    toast(`审批失败：${err?.message || err}`);
  }
}

/* ───────── 项目架构（主控 Agent + 独立架构页） ───────── */

const archState = {
  nodeId: '', goalDirty: false, refreshTimer: null, pollTimer: null,
  animProjectId: '', animReady: false, seenNodes: new Set(), seenStatus: new Map(), seenEdges: new Set(),
  detailFor: '', canvasSig: '', lastNodeId: '',
  htmlCache: new Map(),
  sessionId: '',
};

/* 架构页视图按会话隔离：项目数据仍由 Runtime 按工作区共享（不可改），
   但节点选择 / 目标草稿 / 入场动画全部跟随 activeId 切换重置，
   切回会话时重新看到一次完整的架构入场动画。 */
function archSessionState() {
  if (archState.sessionId !== state.activeId) {
    archState.sessionId = state.activeId;
    archState.nodeId = '';
    archState.goalDirty = false;
    resetArchAnimation();
  }
  return archState;
}

/* 当前会话最近一次运行绑定的 Runtime 任务（draft.runtime.taskId），
   用于架构页标注「当前会话」关联的任务。 */
function archSessionTaskId() {
  const s = active();
  if (!s) return '';
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m && m.runtime && m.runtime.taskId) return String(m.runtime.taskId);
  }
  return '';
}

/* 侧栏卡片按内容签名跳过相同重建：刷新（320ms 防抖 / 3s 轮询）不再打断悬停与动画 */
function archRenderBox(id, html) {
  const box = document.getElementById(id);
  if (!box) return;
  if (archState.htmlCache.get(id) === html) return;
  archState.htmlCache.set(id, html);
  box.innerHTML = html;
}

function resetArchAnimation() {
  archState.animProjectId = '';
  archState.animReady = false;
  archState.seenNodes = new Set();
  archState.seenStatus = new Map();
  archState.seenEdges = new Set();
  archState.detailFor = '';
  archState.canvasSig = '';
  archState.lastNodeId = '';
  archState.htmlCache.clear();
}

function archCanvasSignature(project, live) {
  if (!project) return 'none';
  return JSON.stringify([
    project.id, project.revision, project.name, project.mainAgentId,
    state.theme, state.accent,
    project.edges || [],
    (project.discovery?.techStack || []),
    (project.discovery?.entries || []).map((e) => [e.kind, e.name]),
    live.mainAgent ? [live.mainAgent.id, live.mainAgent.name, live.mainAgent.version, live.mainAgent.permissionProfileId] : null,
    (live.nodes || []).map((n) => [n.id, n.label, n.kind, n.layer, n.effectiveStatus, n.live ? 1 : 0, n.ownerAgentId || '', n.description || '', n.taskId || '']),
    (live.agents || []).map((a) => [a.id, a.name, a.version, a.role, a.status]),
  ]);
}

function archTheme() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: get('--surface-solid', '#ffffff'),
    card: get('--card', '#f6f9fe'),
    rule: get('--rule', '#dce0e8'),
    text: get('--text', '#1e232e'),
    text2: get('--text-2', '#4f5562'),
    text3: get('--text-3', '#646974'),
    accent: get('--accent', '#4b67b4'),
    accentSoft: get('--accent-soft', '#dee8ff'),
    ok: get('--ok', '#157452'),
    bad: get('--bad', '#a33f39'),
  };
}

function archCut(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function archSvg(live, project) {
  const nodes = Array.isArray(live.nodes) ? live.nodes : [];
  if (!nodes.length) return '';
  const c = archTheme();
  const agentName = new Map((live.agents || []).map((a) => [a.id, a.name]));
  const statusColor = { planned: c.text3, in_progress: c.accent, done: c.ok, blocked: c.bad };
  const statusLabel = (s) => ARCH_STATUS_LABEL[s] || s;

  if (archState.animProjectId !== project.id) {
    archState.animProjectId = project.id;
    archState.animReady = false;
    archState.seenNodes = new Set();
    archState.seenStatus = new Map();
    archState.seenEdges = new Set();
  }
  const firstRender = !archState.animReady;

  const groups = ARCH_LAYERS
    .map((layer) => ({ layer, nodes: nodes.filter((n) => n.layer === layer) }))
    .filter((g) => g.nodes.length);

  const CARD_W = 136;
  const CARD_H = 58;
  const HUB_W = 120;
  const HUB_H = 38;
  const GAP_X = 15;
  const GAP_Y = 16;
  const PAD = 24;
  const MAIN_W = 216;
  const MAIN_H = 54;
  const PROJ_W = 228;
  const PROJ_H = 44;
  const TOP = 26;
  const PROJ_Y = TOP + MAIN_H + 28;
  const HUB_Y = PROJ_Y + PROJ_H + 40;
  const MODULES_TOP = HUB_Y + HUB_H + 46;
  const contentW = groups.length * CARD_W + (groups.length - 1) * GAP_X;
  const width = Math.max(760, contentW + PAD * 2);
  const cx = width / 2;
  const startX = (width - contentW) / 2;
  const mainX = cx - MAIN_W / 2;
  const projX = cx - PROJ_W / 2;

  const positions = new Map();
  let maxRows = 0;
  const columns = groups.map((group, index) => {
    const x = startX + index * (CARD_W + GAP_X);
    group.nodes.forEach((node, row) => {
      positions.set(node.id, { x, y: MODULES_TOP + row * (CARD_H + GAP_Y), node });
    });
    maxRows = Math.max(maxRows, group.nodes.length);
    return { ...group, x, hubX: x + (CARD_W - HUB_W) / 2, hubCx: x + CARD_W / 2 };
  });
  const height = Math.max(MODULES_TOP + maxRows * CARD_H + (maxRows - 1) * GAP_Y + PAD, 430);

  const groupStatus = (list) => {
    if (list.some((n) => n.effectiveStatus === 'blocked')) return 'blocked';
    if (list.some((n) => n.effectiveStatus === 'in_progress')) return 'in_progress';
    if (list.every((n) => n.effectiveStatus === 'done')) return 'done';
    return 'planned';
  };

  const hubNode = (x, y, w, h, label, sub, tone, delay, extra = '') => {
    const color = statusColor[tone] || c.text3;
    const live = tone === 'in_progress';
    return `<g class="arch-svg-hub ${live ? 'is-live' : ''} ${extra}">
      <g class="arch-hub-body ${firstRender ? 'is-enter' : ''}" ${firstRender ? `style="animation-delay:${delay}ms"` : ''}>
        <rect class="arch-hub-card" x="${x}" y="${y}" width="${w}" height="${h}" rx="9"
          fill="${c.card}" stroke="${live ? c.accent : c.rule}" stroke-width="${live ? 1.5 : 1}"/>
        <circle class="arch-node-dot" cx="${x + 12}" cy="${y + 14}" r="3.2" fill="${color}"/>
        <text x="${x + w / 2}" y="${y + 17}" text-anchor="middle" fill="${c.text}" font-size="11.4" font-weight="600"
          font-family="Segoe UI, Microsoft YaHei, sans-serif">${esc(label)}</text>
        <text x="${x + w / 2}" y="${y + 30}" text-anchor="middle" fill="${c.text3}" font-size="8.9"
          font-family="Segoe UI, Microsoft YaHei, sans-serif">${esc(sub)}</text>
      </g>
    </g>`;
  };

  const structural = [];
  structural.push(`<path class="arch-edge is-link is-trunk ${firstRender ? 'is-enter' : ''}"
      d="M${cx} ${TOP + MAIN_H} L${cx} ${PROJ_Y}" stroke="${c.accent}" stroke-opacity="0.55" stroke-width="1.5">
      <title>主控 Agent → 项目编排</title></path>`);
  columns.forEach((col) => {
    structural.push(`<path class="arch-edge is-link ${firstRender ? 'is-enter' : ''}"
      d="M${cx} ${PROJ_Y + PROJ_H} L${col.hubCx} ${HUB_Y}" stroke="${c.rule}" stroke-opacity="0.7" stroke-width="1.1">
      <title>项目编排 → ${esc(ARCH_LAYER_LABEL[col.layer] || col.layer)}</title></path>`);
    const hubBottom = HUB_Y + HUB_H;
    const busY = MODULES_TOP - 16;
    const spineX = col.x - 12;
    const lastCenter = MODULES_TOP + (col.nodes.length - 1) * (CARD_H + GAP_Y) + CARD_H / 2;
    let d = `M${col.hubCx} ${hubBottom} L${col.hubCx} ${busY} L${spineX} ${busY} L${spineX} ${lastCenter}`;
    col.nodes.forEach((_, row) => {
      const centerY = MODULES_TOP + row * (CARD_H + GAP_Y) + CARD_H / 2;
      d += ` M${spineX} ${centerY} L${col.x} ${centerY}`;
    });
    structural.push(`<path class="arch-edge is-link ${firstRender ? 'is-enter' : ''}" d="${d}"
      stroke="${c.rule}" stroke-opacity="0.62" stroke-width="1">
      <title>${esc(ARCH_LAYER_LABEL[col.layer] || col.layer)} 模块</title></path>`);
  });

  const depPath = (a, b) => {
    const ax = a.x + CARD_W / 2;
    const ay = a.y + CARD_H / 2;
    const bx = b.x + CARD_W / 2;
    const by = b.y + CARD_H / 2;
    if (Math.abs(a.y - b.y) < 6) {
      const right = bx >= ax;
      const sx = right ? a.x + CARD_W : a.x;
      const ex = right ? b.x : b.x + CARD_W;
      const mid = (sx + ex) / 2;
      return `M${sx} ${ay} C${mid} ${ay}, ${mid} ${by}, ${ex} ${by}`;
    }
    const down = by > ay;
    const sy = down ? a.y + CARD_H : a.y;
    const ey = down ? b.y : b.y + CARD_H;
    const bend = down ? 34 : -34;
    return `M${ax} ${sy} C${ax} ${sy + bend}, ${bx} ${ey - bend}, ${bx} ${ey}`;
  };

  const dependencies = [];
  (project.edges || []).forEach((edge) => {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) return;
    const key = `${edge.from}->${edge.to}:${edge.kind}`;
    const isNew = firstRender || !archState.seenEdges.has(key);
    const call = edge.kind === 'calls';
    const from = a.node.label || edge.from;
    const to = b.node.label || edge.to;
    dependencies.push(`<path class="arch-edge ${call ? 'is-call' : 'is-dep'} ${isNew ? 'is-enter' : ''}"
      d="${depPath(a, b)}" stroke="${call ? c.accent : c.text3}"
      stroke-opacity="${call ? 0.55 : 0.38}" stroke-width="${call ? 1.4 : 1.1}"
      ${call ? 'pathLength="1"' : ''}><title>${esc(from)} → ${esc(to)} · ${esc(edge.kind)}${edge.label ? ' · ' + esc(edge.label) : ''}</title></path>`);
    archState.seenEdges.add(key);
  });

  let animStep = 0;
  const nodesHtml = [...positions.values()].map(({ x, y, node }) => {
    const color = statusColor[node.effectiveStatus] || c.text3;
    const owner = node.ownerAgentId ? (agentName.get(node.ownerAgentId) || node.ownerAgentId) : '未分配';
    const status = statusLabel(node.effectiveStatus);
    const selected = archState.nodeId === node.id;
    const isNew = firstRender || !archState.seenNodes.has(node.id);
    const changed = !firstRender && archState.seenStatus.has(node.id)
      && archState.seenStatus.get(node.id) !== node.effectiveStatus;
    const delay = 110 + animStep++ * 36 + Math.max(0, ARCH_LAYERS.indexOf(node.layer)) * 22;
    archState.seenNodes.add(node.id);
    archState.seenStatus.set(node.id, node.effectiveStatus);
    return `<g class="arch-svg-node ${node.effectiveStatus === 'in_progress' ? 'is-live' : ''} ${selected ? 'is-selected' : ''} ${changed ? 'is-flash' : ''}"
        data-arch-node="${esc(node.id)}" tabindex="0" role="button"
        aria-label="${esc(node.label)} · ${esc(ARCH_LAYER_LABEL[node.layer] || node.layer)} · ${esc(status)}">
      <title>${esc(node.label)}${node.description ? ' · ' + esc(node.description) : ''}</title>
      <g class="arch-node-body ${isNew ? 'is-enter' : ''}" ${isNew ? `style="animation-delay:${delay}ms"` : ''}>
        ${selected ? `<rect class="arch-node-ring" x="${x - 4}" y="${y - 4}" width="${CARD_W + 8}" height="${CARD_H + 8}" rx="13" fill="none" stroke="${c.accent}" stroke-opacity="0.45"/>` : ''}
        <rect class="arch-node-card" x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="9"
          fill="${c.card}" stroke="${node.effectiveStatus === 'planned' ? c.rule : color}" stroke-width="${node.effectiveStatus === 'planned' ? 1 : 1.6}"/>
        ${node.live ? `<circle class="arch-live-halo" cx="${x + CARD_W - 13}" cy="${y + 13}" r="8" fill="${c.accent}" opacity="0.16"/>` : ''}
        ${node.live ? `<circle class="arch-live-dot" cx="${x + CARD_W - 13}" cy="${y + 13}" r="3.2" fill="${c.accent}"/>` : ''}
        <circle class="arch-node-dot" cx="${x + 12}" cy="${y + 15}" r="3.2" fill="${color}"/>
        <text x="${x + CARD_W / 2}" y="${y + 21}" text-anchor="middle" fill="${c.text}" font-size="11.8" font-weight="600"
          font-family="Segoe UI, Microsoft YaHei, sans-serif">${esc(archCut(node.label, 8))}</text>
        <text x="${x + CARD_W / 2}" y="${y + 37}" text-anchor="middle" fill="${c.text3}" font-size="9.2"
          font-family="Segoe UI, Microsoft YaHei, sans-serif">${esc(archCut(`${ARCH_KIND_LABEL[node.kind] || node.kind} · ${owner}`, 14))}</text>
        <text x="${x + CARD_W - 10}" y="${y + CARD_H - 8}" text-anchor="end" fill="${color}" font-size="9.4"
          font-family="Segoe UI, Microsoft YaHei, sans-serif">${esc(status)}</text>
      </g>
    </g>`;
  }).join('');

  const main = live.mainAgent;
  const subs = (live.agents || []).filter((a) => a.role === 'sub');
  const mainLabel = archCut(main?.name || '主控 Agent', 10);
  const mainSub = `${main ? `v${main.version} · ${main.permissionProfileId || '?'}` : '未绑定 Agent'} · ${subs.length} 个子 Agent`;
  const mainNode = `<g class="arch-svg-hub is-main">
    <g class="arch-hub-body ${firstRender ? 'is-enter' : ''}">
      <rect class="arch-main-card" x="${mainX}" y="${TOP}" width="${MAIN_W}" height="${MAIN_H}" rx="10"
        fill="${c.card}" stroke="${c.accent}" stroke-opacity="0.45" stroke-width="1.2"/>
      <circle class="arch-node-dot" cx="${mainX + 15}" cy="${TOP + 16}" r="3.2" fill="${c.accent}"/>
      <text x="${cx}" y="${TOP + 23}" text-anchor="middle" fill="${c.text}" font-size="12.6" font-weight="600"
        font-family="Segoe UI, Microsoft YaHei, sans-serif">${esc(mainLabel)}</text>
      <text x="${cx}" y="${TOP + 40}" text-anchor="middle" fill="${c.text3}" font-size="9.4"
        font-family="Segoe UI, Microsoft YaHei, sans-serif">${esc(archCut(`主控 · ${mainSub}`, 34))}</text>
    </g>
  </g>`;

  const projSub = `revision ${project.revision} · ${nodes.length} 模块 · ${(project.edges || []).length} 依赖`;
  const projNode = hubNode(projX, PROJ_Y, PROJ_W, PROJ_H, archCut(project.name || '项目', 14), projSub, 'planned', 60, 'is-project');
  const hubHtml = columns.map((col) => {
    const tone = groupStatus(col.nodes);
    const active = col.nodes.filter((n) => n.effectiveStatus === 'in_progress').length;
    const sub = `${col.nodes.length} 模块${active ? ` · ${active} 进行中` : ''}`;
    return hubNode(col.hubX, HUB_Y, HUB_W, HUB_H, ARCH_LAYER_LABEL[col.layer] || col.layer, sub, tone, 150 + ARCH_LAYERS.indexOf(col.layer) * 36);
  }).join('');

  archState.animReady = true;

  return `<svg id="archSvg" class="arch-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"
      style="max-width:${width}px" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(project.name)} 项目架构图">
    <defs></defs>
    <rect width="${width}" height="${height}" fill="${c.bg}"/>
    ${mainNode}
    ${projNode}
    ${hubHtml}
    ${structural.join('')}
    ${dependencies.join('')}
    ${nodesHtml}
  </svg>`;
}

function archLegendHtml() {
  return `<div class="arch-legend">
    <span><i class="arch-lg planned"></i>计划中</span>
    <span><i class="arch-lg in_progress"></i>进行中</span>
    <span><i class="arch-lg done"></i>已完成</span>
    <span><i class="arch-lg blocked"></i>受阻</span>
    <span class="arch-legend-sep"></span>
    <span><i class="arch-lg line solid"></i>调用</span>
    <span><i class="arch-lg line dashed"></i>依赖</span>
  </div>`;
}

function archEmptyHtml(live) {
  const discovery = state.project?.project?.discovery;
  const chips = (discovery?.techStack || []).map((s) => `<span class="arch-chip">${esc(s)}</span>`).join('');
  const entries = (discovery?.entries || []).slice(0, 8)
    .map((e) => `<span class="arch-entry">${ico(e.kind === 'dir' ? 'i-folder' : 'i-file')}${esc(e.name)}</span>`).join('');
  return `<div class="arch-empty-state">
    <span class="arch-empty-icon">${ico('i-package')}</span>
    <h3>还没有整体架构</h3>
    <p>回到聊天框，把项目目标和约束告诉主控 Agent。它会在对话里拆成分层模块（体验 / 应用 / 领域 / 平台 / 数据），
    再按模块委派子 Agent，并从这里实时查看进度。</p>
    ${chips ? `<div class="arch-chips">${chips}</div>` : ''}
    ${entries ? `<div class="arch-discovery-entries">${entries}</div>` : '<p class="fine">工作区尚未检测到可识别的结构。</p>'}
    <button class="btn primary" data-arch-chat>${ico('i-arrow-up')} 回到聊天框规划</button>
  </div>`;
}

function renderArchMainAgent(live) {
  const main = live.mainAgent;
  if (!main) {
    archRenderBox('archMainAgent', '<div class="arch-card-title">主控 Agent</div><p class="fine">尚未绑定主控 Agent。</p>');
    return;
  }
  const subs = (live.agents || []).filter((a) => a.role === 'sub');
  const rows = subs.length
    ? subs.map((a) => `<div class="arch-agent-row ${a.status === 'archived' ? 'is-archived' : ''}">
        <span class="arch-agent-dot ${a.activeTasks ? 'is-live' : ''}"></span>
        <span class="arch-agent-main"><b>${esc(a.name)}</b><small>${esc(a.id)} · v${a.version} · ${esc(a.permissionProfileId || '?')}</small></span>
        <span class="arch-agent-tag">${a.activeTasks ? a.activeTasks + ' 个任务' : a.status === 'archived' ? '已归档' : '空闲'}</span>
      </div>`).join('')
    : '<p class="fine">还没有子 Agent。主控 Agent 可以把模块任务委派给新建的 Agent。</p>';
  archRenderBox('archMainAgent', `<div class="arch-card-title">主控 Agent</div>
    <div class="arch-main-agent">
      <span class="arch-main-badge">主控</span>
      <span class="arch-agent-main"><b>${esc(main.name)}</b><small>${esc(main.id)} · v${main.version} · ${esc(main.permissionProfileId || '?')}${main.activeTasks ? ' · ' + main.activeTasks + ' 个进行中任务' : ''}</small></span>
      <span class="arch-agent-dot ${main.activeTasks ? 'is-live' : ''}"></span>
    </div>
    <div class="arch-sub-title">子 Agent</div>
    ${rows}
    <button class="arch-link" data-arch-agents>管理 Agent</button>`);
}

function renderArchStats(live) {
  const s = live.stats || {};
  archRenderBox('archStats', `<div class="arch-card-title">项目状态</div>
    <div class="arch-stats">
      <div><b>${s.nodes || 0}</b><small>模块</small></div>
      <div><b>${s.edges || 0}</b><small>依赖</small></div>
      <div><b>${s.activeNodes || 0}</b><small>进行中</small></div>
      <div><b>${s.done || 0}</b><small>已完成</small></div>
      <div><b>${s.blocked || 0}</b><small>受阻</small></div>
      <div><b>${s.linkedTasks || 0}</b><small>关联任务</small></div>
    </div>`);
}

function renderArchMilestones(live) {
  const list = live.milestones || [];
  archRenderBox('archMilestones', `<div class="arch-card-title">里程碑 <span>${list.length}</span></div>
    ${list.length ? `<div class="arch-miles">${list.map((m) => `<div class="arch-mile">
      <span class="arch-mile-dot status-${esc(m.effectiveStatus)}"></span>
      <span class="arch-mile-main"><b>${esc(m.label)}</b>${m.taskTitle ? `<small>${esc(m.taskTitle)}</small>` : ''}</span>
      <span class="arch-chip status-${esc(m.effectiveStatus)}">${esc(ARCH_STATUS_LABEL[m.effectiveStatus] || m.effectiveStatus)}</span>
    </div>`).join('')}</div>` : '<p class="fine">让主 Agent 在提交架构时写入里程碑。</p>'}`);
}

function renderArchDiscovery() {
  const discovery = state.project?.project?.discovery;
  if (!discovery) { archRenderBox('archDiscovery', '<div class="arch-card-title">工作区发现</div><p class="fine">尚未扫描工作区。</p>'); return; }
  const chips = (discovery.techStack || []).map((s) => `<span class="arch-chip">${esc(s)}</span>`).join('');
  const entries = (discovery.entries || []).slice(0, 12)
    .map((e) => `<span class="arch-entry">${ico(e.kind === 'dir' ? 'i-folder' : 'i-file')}${esc(e.name)}</span>`).join('');
  archRenderBox('archDiscovery', `<div class="arch-card-title">工作区发现</div>
    ${chips ? `<div class="arch-chips">${chips}</div>` : ''}
    <div class="arch-discovery-entries">${entries || '<span class="fine">没有可显示的顶层条目</span>'}</div>`);
}

function taskStatusLabel(status) {
  return RUN_STATUS_LABEL[status] || status || '—';
}

function renderArchTasks(live, sessionTaskId = '') {
  const list = live.tasks || [];
  const agentName = new Map((live.agents || []).map((a) => [a.id, a.name]));
  archRenderBox('archTasks', `<div class="arch-card-title">关联任务 <span>${list.length}</span></div>
    ${list.length ? `<div class="arch-task-list">${list.map((t) => {
      const cls = t.status === 'succeeded' ? 'is-ok' : ['failed', 'canceled', 'interrupted'].includes(t.status) ? 'is-bad' : 'is-live';
      const mine = sessionTaskId && t.id === sessionTaskId;
      return `<button class="arch-task ${mine ? 'is-session' : ''}" data-arch-task="${esc(t.id)}"${mine ? ' title="当前会话绑定的任务"' : ''}>
        <span class="arch-task-main"><b>${esc(archCut(t.title || '未命名任务', 26))}${mine ? ' · 当前会话' : ''}</b><small>${esc(agentName.get(t.agentId) || t.agentId)}${t.parentTaskId ? ' · 子任务' : ''}</small></span>
        <span class="arch-chip ${cls}">${esc(taskStatusLabel(t.status))}</span>
      </button>`;
    }).join('')}</div>` : '<p class="fine">还没有关联到项目的任务。</p>'}`);
}

function archNodeDetailHtml(live) {
  if (!archState.nodeId) return '';
  const node = (live.nodes || []).find((n) => n.id === archState.nodeId);
  if (!node) return '';
  const agents = new Map((live.agents || []).map((a) => [a.id, a.name]));
  const rows = [
    ['层级', ARCH_LAYER_LABEL[node.layer] || node.layer],
    ['类型', ARCH_KIND_LABEL[node.kind] || node.kind],
    ['职责', node.description || '—'],
    ['路径', node.path || '—'],
    ['负责 Agent', node.ownerAgentId ? `${agents.get(node.ownerAgentId) || node.ownerAgentId}` : '未分配'],
    ['计划状态', ARCH_STATUS_LABEL[node.planStatus] || node.planStatus],
    ['实际状态', ARCH_STATUS_LABEL[node.effectiveStatus] || node.effectiveStatus],
  ];
  if (node.runtimeStatus) rows.push(['任务状态', taskStatusLabel(node.runtimeStatus)]);
  if (node.taskTitle) rows.push(['关联任务', node.taskTitle]);
  return `<div class="arch-detail-head">
      <span class="arch-detail-dot status-${esc(node.effectiveStatus)}"></span>
      <b>${esc(node.label)}</b>
      <span class="arch-chip status-${esc(node.effectiveStatus)}">${esc(ARCH_STATUS_LABEL[node.effectiveStatus] || node.effectiveStatus)}</span>
      <button class="icon-btn ghost" data-arch-detail-close title="关闭">${ico('i-close')}</button>
    </div>
    <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${node.taskId ? `<button class="arch-link" data-arch-task="${esc(node.taskId)}">在运行检查器中打开任务</button>` : ''}`;
}

function renderArchPage() {
  if (!state.projectOpen) return;
  const st = archSessionState();
  const page = $('#archPage');
  if (!page) return;
  const data = state.project;
  const project = data?.project;
  const live = data?.live || { nodes: [], agents: [], milestones: [], tasks: [], stats: {} };
  const sessionTaskId = archSessionTaskId();
  const sessionTask = sessionTaskId
    ? (live.tasks || []).find((t) => t.id === sessionTaskId)
    : null;
  const title = $('#archTitle');
  const subtitle = $('#archSubtitle');
  if (title) title.textContent = project?.name || '项目架构';
  if (subtitle) {
    if (project) {
      const linked = sessionTask ? ` · 当前会话任务：${archCut(sessionTask.title || sessionTaskId, 18)}` : '';
      subtitle.textContent = `${project.workspace} · revision ${project.revision} · 主控 ${live.mainAgent?.name || '未绑定'}${state.projectLoading ? ' · 同步中…' : ''}${linked}`;
    } else {
      subtitle.textContent = state.projectError || '尚未读取项目';
    }
  }
  const goal = $('#archGoal');
  if (goal && (!st.goalDirty || document.activeElement !== goal)) {
    goal.value = project?.goal || '';
    st.goalDirty = false;
  }

  const canvas = $('#archCanvas');
  if (canvas) {
    const sig = archCanvasSignature(project, live);
    if (sig !== st.canvasSig || st.nodeId !== st.lastNodeId) {
      let scrollLeft = 0;
      let scrollTop = 0;
      const oldScroll = $('.arch-svg-scroll', canvas);
      if (oldScroll) { scrollLeft = oldScroll.scrollLeft; scrollTop = oldScroll.scrollTop; }
      if (!project) {
        canvas.innerHTML = `<div class="arch-empty-state"><span class="arch-empty-icon">${ico('i-package')}</span><h3>无法读取项目</h3><p>${esc(state.projectError || 'Runtime 不可用')}</p></div>`;
      } else if (!live.nodes?.length) {
        canvas.innerHTML = archEmptyHtml(live);
      } else {
        canvas.innerHTML = `<div class="arch-svg-scroll">${archSvg(live, project)}</div>${archLegendHtml()}`;
        const nextScroll = $('.arch-svg-scroll', canvas);
        if (nextScroll) { nextScroll.scrollLeft = scrollLeft; nextScroll.scrollTop = scrollTop; }
      }
      archState.canvasSig = sig;
      archState.lastNodeId = archState.nodeId;
    }
    const detail = $('#archDetail');
    if (detail) {
      const html = archNodeDetailHtml(live);
      const fresh = !!html && archState.detailFor !== archState.nodeId;
      if (archState.htmlCache.get('#archDetail') !== html) {
        archState.htmlCache.set('#archDetail', html);
        detail.hidden = !html;
        detail.innerHTML = html;
        if (fresh) {
          detail.classList.remove('is-enter');
          void detail.offsetWidth;
          detail.classList.add('is-enter');
        } else if (!html) {
          detail.classList.remove('is-enter');
        }
      } else if (fresh) {
        detail.classList.remove('is-enter');
        void detail.offsetWidth;
        detail.classList.add('is-enter');
      }
      archState.detailFor = archState.nodeId;
    }
  }

  renderArchMainAgent(live);
  renderArchStats(live);
  renderArchMilestones(live);
  renderArchDiscovery();
  renderArchTasks(live, sessionTaskId);
  scheduleArchPoll((live.stats?.activeTasks || 0) > 0);
}

function scheduleArchPoll(active) {
  clearTimeout(archState.pollTimer);
  if (!state.projectOpen || !active) return;
  archState.pollTimer = setTimeout(() => { refreshArchitecture(true).catch(() => {}); }, 3000);
}

async function refreshArchitecture(force = true) {
  if (!state.projectOpen) return;
  await loadProject(force);
  renderArchPage();
}

function handleArchitectureEvent(event) {
  if (!state.projectOpen || !event?.type) return;
  const p = event.payload || {};
  if (event.type === 'project.updated' && state.project?.project?.id && p.projectId && p.projectId !== state.project.project.id) return;
  if (
    event.type === 'project.updated'
    || event.type.startsWith('task.')
    || event.type.startsWith('run.')
    || event.type.startsWith('delegation.')
    || event.type === 'approval.requested'
    || event.type === 'approval.decided'
  ) {
    clearTimeout(archState.refreshTimer);
    archState.refreshTimer = setTimeout(() => { refreshArchitecture(true).catch(() => {}); }, 320);
  }
}

async function openArchPage() {
  if (!window.dsh?.runtime?.projects?.ensure) { toast('当前不在桌面外壳里运行，无法读取项目架构'); return; }
  state.projectOpen = true;
  archSessionState();
  const page = $('#archPage');
  if (page) {
    page.classList.remove('is-closing'); // 可能正播出场动画，取消它
    page.hidden = false;
  }
  const canvas = $('#archCanvas');
  if (canvas) canvas.innerHTML = `<div class="arch-empty-state"><span class="arch-empty-icon">${ico('i-package')}</span><h3>正在读取项目架构…</h3><p>同步 Runtime 中的项目、任务与 Agent 状态。</p></div>`;
  await ensureWorkspace();
  await refreshArchitecture(true);
}

function closeArchPage() {
  state.projectOpen = false;
  archState.nodeId = '';
  archState.goalDirty = false;
  resetArchAnimation();
  clearTimeout(archState.refreshTimer);
  clearTimeout(archState.pollTimer);
  animateOut($('#archPage'), 220);
}

async function saveArchGoal(silent = false) {
  const goalEl = $('#archGoal');
  const projectId = state.project?.project?.id;
  if (!goalEl || !projectId || !window.dsh?.runtime?.projects?.update) return false;
  const goal = goalEl.value.trim().slice(0, 2000);
  try {
    const r = await window.dsh.runtime.projects.update({ projectId, goal });
    if (!r?.ok) { toast(`保存目标失败：${r?.error?.message || '未知错误'}`); return false; }
    state.project = r.data;
    archState.goalDirty = false;
    renderArchPage();
    if (!silent) toast('项目目标已保存');
    return true;
  } catch (err) {
    toast(`保存目标失败：${err?.message || err}`);
    return false;
  }
}

async function openTaskFromArch(taskId) {
  closeArchPage();
  await openInspector();
  await pickInspectorTask(taskId);
}

function exportArchSvg() {
  const svg = $('#archCanvas .arch-svg');
  if (!svg) { toast('当前没有可导出的架构图'); return; }
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const source = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${source}`], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const name = String(state.project?.project?.name || 'project-architecture').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-架构图.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('架构图已导出 SVG');
}

function bindArchPage() {
  $('#archBtn')?.addEventListener('click', openArchPage);
  $('#openArch')?.addEventListener('click', () => { closeSheets(); openArchPage(); });
  $('#archBack')?.addEventListener('click', closeArchPage);
  $('#archRefresh')?.addEventListener('click', () => refreshArchitecture(true));
  $('#archExport')?.addEventListener('click', exportArchSvg);
  $('#archSaveGoal')?.addEventListener('click', () => saveArchGoal(false));
  $('#archGoal')?.addEventListener('input', () => { archState.goalDirty = true; });

  const canvas = $('#archCanvas');
  canvas?.addEventListener('click', (e) => {
    if (e.target.closest('[data-arch-chat]')) {
      closeArchPage();
      $('#input')?.focus();
      return;
    }
    const nodeEl = e.target.closest('[data-arch-node]');
    if (nodeEl) {
      archState.nodeId = archState.nodeId === nodeEl.dataset.archNode ? '' : nodeEl.dataset.archNode;
      renderArchPage();
      return;
    }
    if (e.target.closest('[data-arch-detail-close]')) {
      archState.nodeId = '';
      renderArchPage();
    }
  });
  canvas?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const nodeEl = e.target.closest('[data-arch-node]');
    if (!nodeEl) return;
    e.preventDefault();
    archState.nodeId = nodeEl.dataset.archNode;
    renderArchPage();
  });

  const side = $('#archSide');
  side?.addEventListener('click', (e) => {
    if (e.target.closest('[data-arch-agents]')) { openAgentSheet(); return; }
    const taskBtn = e.target.closest('[data-arch-task]');
    if (taskBtn) openTaskFromArch(taskBtn.dataset.archTask);
  });
  const detail = $('#archDetail');
  detail?.addEventListener('click', (e) => {
    if (e.target.closest('[data-arch-detail-close]')) { archState.nodeId = ''; renderArchPage(); return; }
    const taskBtn = e.target.closest('[data-arch-task]');
    if (taskBtn) openTaskFromArch(taskBtn.dataset.archTask);
  });
}

/* ───────── 详情 / 审批 / 文件卡 ───────── */

function toggleMetrics(node, msg) {
  const slot = $('.slot-metrics', node);
  const existing = $('.metrics-detail', slot);
  if (existing) { existing.remove(); return; }
  const rows = [
    ['来源', msg.source === 'model' ? '模型 API' : '离线预览'],
    ['模型', msg.model || (msg.source === 'model' ? currentModel() : '—')],
    ['状态', msg.summary?.label || '—'],
    ['耗时', msg.finishedAt && msg.startedAt ? `${((msg.finishedAt - msg.startedAt) / 1000).toFixed(1)} 秒` : '进行中'],
    ['工具调用', `${(msg.tools || []).length} 次`],
    ['输出字符', `${(msg.body || '').length} 字`],
    ['附件', `${msg.attachmentsCount ?? (msg.attachments || []).length} 个`],
  ];
  if (msg.attempts) rows.push(['请求次数', `${msg.attempts} 次（重试 ${msg.retries || 0} 次）`]);
  if (msg.usage) rows.push(['Token 用量', JSON.stringify(msg.usage)]);
  if (msg.error) rows.push(['错误', msg.error]);
  const html = `<div class="metrics-detail"><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
  slot.insertAdjacentHTML('beforeend', html);
  scrollToBottom();
}

function toggleFileDetail(node, msg, index) {
  const slot = $('.slot-files', node);
  const existing = $('.file-detail', slot);
  if (existing) existing.remove();
  const f = (msg.files || [])[index];
  if (!f) return;
  slot.insertAdjacentHTML('beforeend', `
    <div class="file-detail">
      <b>${esc(f.name)}</b><br />
      类型：${esc(f.kind || '未知')} · 说明：${esc(f.meta || '无')}<br />
      ${msg.source === 'model' ? '真实 API 模式不会产出本地文件，此条目来自离线预览数据。' : '这是离线预览里的示例交付物，磁盘上没有对应文件。'}
    </div>`);
}

function applyApproval(node, msg, kind) {
  if (!msg?.approval || msg.approval.outcome) return;
  const labels = {
    once: '已允许这一次',
    always: '本次会话都将允许',
    deny: '已拒绝',
  };
  const label = labels[kind];
  if (!label) return;
  msg.approval.outcome = kind;
  msg.approval.label = label;
  if (kind === 'always') state.autoApproved.add(active().id + '::' + (msg.approval.key || msg.approval.command));
  $('.slot-approval', node).innerHTML = approvalCard(msg.approval);
  toast(label);
  const waiter = approvalWaiters.get(msg);
  if (waiter) {
    approvalWaiters.delete(msg);
    waiter.resolve(kind);
  }
}

/* ───────── 模型选择（列表来自上游 /models） ───────── */

const MODEL_CACHE_KEY = 'dsh.models';

function loadModelCache() {
  const cached = readJson(MODEL_CACHE_KEY, null);
  if (!cached || !Array.isArray(cached.models)) return;
  const api = state.connection.api;
  if (cached.baseUrl !== api.baseUrl || cached.key !== api.key) return;
  state.models = cached.models.filter((m) => m && validModel(m.id));
  state.modelsFor = cached.baseUrl + '|' + cached.key;
  state.modelsAt = Number(cached.at) || 0;
  renderModelMeta();
}

function saveModelCache(cfg = state.connection.api) {
  writeStorage(MODEL_CACHE_KEY, JSON.stringify({
    baseUrl: cfg.baseUrl,
    key: cfg.key,
    at: state.modelsAt,
    models: state.models,
  }));
}

function renderModelMeta() {
  const count = state.models.length;
  const formBase = ($('#apiBaseUrl')?.value || '').trim();
  const formKey = ($('#apiKey')?.value || '').trim();
  const forForm = `${formBase}|${formKey}`;
  const stale = !!state.modelsFor && state.modelsFor !== forForm;
  $('#apiModelCount').textContent = state.modelsLoading
    ? '获取中…'
    : count ? `上游 ${count} 个${stale ? '（配置已改）' : ''}` : (state.modelsError ? '获取失败' : '未获取列表');
  $('#modelSource').innerHTML = count
    ? `列表来自 <code>${esc(hostOf(formBase || state.connection.api.baseUrl))}/models</code>，共 ${count} 个模型${stale ? '（地址或 Key 已改，请刷新）' : ''}。`
    : `列表来自上游 <code>/models</code>，只显示该端点真实提供的模型。`;
}

/** API 表单里「模型」这一行跟随 formModel，而不是已保存的当前模型。 */
function renderApiModelRow() {
  const el = $('#apiModelName');
  if (el) el.textContent = formModel();
  renderModelMeta();
}

function hostOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).host; } catch { return url; }
}

function renderModelList() {
  const box = $('#modelList');
  const q = ($('#modelSearch').value || '').trim().toLowerCase();
  if (state.modelsLoading) {
    box.innerHTML = '<div class="model-empty">正在向上游获取模型列表…</div>';
    return;
  }
  if (!state.models.length) {
    const reason = state.modelsError ? esc(state.modelsError) : '还没有获取到模型列表';
    box.innerHTML = `<div class="model-empty">${reason}<br />可以点「刷新」重试，或在下方手动填写模型名。</div>`;
    $('#manualModelField').hidden = false;
    return;
  }
  const list = q ? state.models.filter((m) => m.id.toLowerCase().includes(q) || String(m.owner || '').toLowerCase().includes(q)) : state.models;
  if (!list.length) {
    box.innerHTML = `<div class="model-empty">没有匹配「${esc(q)}」的模型</div>`;
    return;
  }
  box.innerHTML = list.map((m) => `
    <button class="model-item ${m.id === state.pendingModel ? 'is-active' : ''}" data-model="${esc(m.id)}">
      <span class="m-name">${esc(m.id)}</span>
      ${m.id === DEFAULT_API.model ? '<span class="m-tag">默认</span>' : ''}
      ${m.owner ? `<span class="m-owner">${esc(m.owner)}</span>` : ''}
      ${ico('i-check', 'ico m-check')}
    </button>`).join('');
}

async function fetchModels(options = {}) {
  const { silent = false } = options;
  // 优先用当前编辑的 profile 的已保存值：切到某个连接后，即使表单字段被打过草稿，
  // 拉取的仍是那个连接自己的地址与 Key；仅当该连接没有记录时才回退到表单字段。
  const profile = state.profiles.find((p) => p.id === state.formProfileId);
  const cfg = {
    baseUrl: (profile?.baseUrl || $('#apiBaseUrl').value).trim(),
    key: (profile?.key || $('#apiKey').value).trim(),
    model: formModel(),
  };
  const err = validateBaseAndKey(cfg);
  if (err) {
    if (!silent) {
      state.modelsError = err;
      state.modelsErrorCode = 'BAD_CONFIG';
      renderModelList();
      showModelStatus(false, `配置校验失败：${err}`);
    }
    return { ok: false, error: err };
  }
  if (!window.dsh?.model?.list) {
    const msg = '当前不在桌面外壳里运行，无法获取模型列表';
    if (!silent) { state.modelsError = msg; renderModelList(); showModelStatus(false, msg); }
    return { ok: false, error: msg };
  }

  state.modelsLoading = true;
  state.modelsError = '';
  state.modelsErrorCode = '';
  renderModelMeta();
  if (!silent) {
    renderModelList();
    showModelStatus(null, '正在连接上游获取模型列表…');
  }

  try {
    const r = await window.dsh.model.list(cfg);
    state.modelsLoading = false;
    if (r?.ok) {
      state.models = (r.models || []).filter((m) => m && validModel(m.id));
      state.modelsFor = cfg.baseUrl + '|' + cfg.key;
      state.modelsAt = Date.now();
      state.modelsError = '';
      state.modelsErrorCode = '';
      saveModelCache(cfg);
      renderModelMeta();
      renderModelList();
      if (!silent) showModelStatus(true, `已获取 ${state.models.length} 个模型${r.attempts > 1 ? `（第 ${r.attempts} 次请求成功）` : ''}`);
      return r;
    }
    state.modelsErrorCode = r?.code || 'ERROR';
    state.modelsError = r?.error || '获取模型列表失败';
    state.models = [];
    renderModelMeta();
    renderModelList();
    if (!silent) showModelStatus(false, `获取失败：${state.modelsError}`);
    return r || { ok: false, error: state.modelsError };
  } catch (e) {
    state.modelsLoading = false;
    state.modelsError = `请求异常：${e?.message || e}`;
    state.modelsErrorCode = 'EXCEPTION';
    state.models = [];
    renderModelMeta();
    renderModelList();
    if (!silent) showModelStatus(false, state.modelsError);
    return { ok: false, error: state.modelsError };
  }
}

function showModelStatus(ok, text) {
  const box = $('#modelStatus');
  if (ok === null && !text) { box.hidden = true; return; }
  box.hidden = false;
  box.className = 'probe' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
  box.textContent = text;
}

function openModelSheet(origin = 'topbar') {
  const fromConnect = origin === 'connect';
  state.modelSheetFrom = fromConnect ? 'connect' : 'topbar';
  state.modelReturnSheet = fromConnect ? 'connectSheet' : '';
  if (fromConnect) {
    state.pendingModel = formModel();
  } else {
    // 顶栏切换以已保存配置为准，先把表单同步回来，避免用草稿地址拉列表
    fillFormFromConn();
    state.pendingModel = currentModel();
  }
  $('#modelSearch').value = '';
  $('#manualModel').value = validModel(state.pendingModel) ? state.pendingModel : '';
  $('#manualModelField').hidden = true;
  showModelStatus(null, '');
  renderModelMeta();
  renderModelList();
  openSheet('modelSheet');

  const formBase = ($('#apiBaseUrl').value || '').trim();
  const formKey = ($('#apiKey').value || '').trim();
  const stale = !state.models.length || state.modelsFor !== `${formBase}|${formKey}`
    || Date.now() - state.modelsAt > 10 * 60 * 1000;
  if (stale) fetchModels();
}

function applyModelChoice() {
  const manual = $('#manualModel').value.trim();
  const chosen = manual || state.pendingModel;
  if (!validModel(chosen)) { toast('请选择或填写合法模型名'); return; }
  const value = chosen.trim();

  // 从 API 接入面板进入时，只改表单草稿，点「保存并启用」才真正生效
  if (state.modelSheetFrom === 'connect') {
    state.formModel = value;
    state.pendingModel = value;
    renderApiModelRow();
    closeSheet('modelSheet');
    toast(`已选择 ${value}，保存后生效`);
    return;
  }

  state.connection.api.model = value;
  state.formModel = value;
  state.pendingModel = value;
  const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId);
  if (activeProfile) {
    activeProfile.model = value;
    saveProfiles();
    renderProfiles();
  }
  writeStorage('dsh.conn', JSON.stringify(state.connection));
  renderHeader();
  renderHost();
  renderApiModelRow();
  closeSheets();
  toast(`已切换到 ${value}`);
}

/* ───────── API 接入面板 ───────── */

const FINE_TEXT = {
  model: '地址与 Key 只保存在本机。模型列表来自上游 /models；发送走流式接口，中断会真正中止请求。',
  preview: '离线预览只回放内置示例数据，不发起任何网络请求；界面与交互仍可完整操作。',
};

function currentSource() { return $('#sourceSeg button.is-active')?.dataset.source || sourceOf(); }

function syncSourcePane(source) {
  const src = source === 'preview' ? 'preview' : 'model';
  $('#paneModel').hidden = src !== 'model';
  $('#paneDemo').hidden = src !== 'preview';
  $('#probeBtn').hidden = src !== 'model';
  $('#connectBtn').textContent = src === 'model' ? '保存并启用' : '切到离线预览';
  $('#connectFine').textContent = FINE_TEXT[src];
}

function openConnect() {
  const activeProfile = state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0];
  if (activeProfile) loadProfile(activeProfile.id); else fillFormFromConn();
  const src = sourceOf();
  $$('#sourceSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.source === src));
  syncSourcePane(src);
  $('#probeResult').hidden = true;
  if (!state.toolsReady) loadTools(); else renderToolsSetting();
  openSheet('connectSheet');
}

function persistConn(c) {
  state.connection = c;
  // 凭据库可用时 dsh.conn 不落明文 key，启动后由活动连接回填
  const persisted = state.vaultOk
    ? { ...c, api: { ...c.api, key: '' } }
    : c;
  writeStorage('dsh.conn', JSON.stringify(persisted));
  renderHost();
  renderHeader();
  renderApiModelRow();
}

/* ───────── 多 API 连接 ───────── */

const PROFILES_KEY = 'dsh.apis';

function defaultProfileName(api) {
  const raw = String(api?.baseUrl || '').trim();
  if (!raw) return '未命名连接';
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).host; } catch { return raw.slice(0, 40); }
}

function makeProfile(api) {
  return {
    id: 'api-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    name: defaultProfileName(api).slice(0, 40),
    baseUrl: String(api?.baseUrl || ''),
    key: String(api?.key || ''),
    model: validModel(api?.model) ? api.model : DEFAULT_API.model,
  };
}

function normalizeProfiles(rawProfiles) {
  return Array.isArray(rawProfiles)
    ? rawProfiles
      .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id)
      .map((p) => ({
        id: String(p.id),
        name: (typeof p.name === 'string' && p.name.trim() ? p.name.trim() : '连接').slice(0, 40),
        baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
        key: typeof p.key === 'string' ? p.key : '',
        model: validModel(p.model) ? p.model : DEFAULT_API.model,
      }))
    : [];
}

function loadProfiles(persist = true) {
  const raw = readJson(PROFILES_KEY, null);
  const api = state.connection.api || DEFAULT_API;
  const profiles = normalizeProfiles(raw?.profiles);

  let current = profiles.find((p) => p.id === raw?.active)
    || profiles.find((p) => p.baseUrl === api.baseUrl && (!api.key || p.key === api.key));
  if (!current) { current = makeProfile(api); profiles.push(current); }
  current.model = validModel(api.model) ? api.model : current.model;
  // localStorage 可能已脱敏（key 在凭据库里），先把活动连接的 key 接回内存
  if (!api.key && current.key) state.connection.api = { ...api, key: current.key };
  // 连接本体以已保存的 profile 为准（重启后确保 model 与 profile 一致）
  state.connection.api = {
    baseUrl: current.baseUrl || api.baseUrl,
    key: state.connection.api.key || current.key,
    model: validModel(current.model) ? current.model : api.model,
  };

  state.profiles = profiles;
  state.activeProfileId = current.id;
  state.formProfileId = current.id;
  if (persist) saveProfiles();
}

function saveProfiles() {
  const active = state.activeProfileId;
  const stripped = () => JSON.stringify({
    profiles: state.profiles.map(({ key, ...rest }) => rest),
    active,
  });
  const full = () => JSON.stringify({ profiles: state.profiles, active });
  writeStorage(PROFILES_KEY, state.vaultOk ? stripped() : full());
  if (!window.dsh?.secrets?.setProfiles) return;
  window.dsh.secrets.setProfiles({ profiles: state.profiles, active }).then((r) => {
    if (!r?.ok) return;
    state.vaultOk = true;
    // 密钥进入系统凭据库后，localStorage 只保留非敏感元数据
    writeStorage(PROFILES_KEY, stripped());
  }).catch(() => { /* 凭据库不可用时保留本地可用的降级数据 */ });
}

/** 从 safeStorage 凭据库回填 API Key；老版本 localStorage 中的密钥会在首次保存时迁移。 */
async function hydrateProfilesFromVault() {
  if (!window.dsh?.secrets?.getProfiles) return;
  try {
    const v = await window.dsh.secrets.getProfiles();
    if (!v?.ok) return;
    state.vaultOk = true;
    const vaultProfiles = normalizeProfiles(v.data?.profiles);
    if (vaultProfiles.length) {
      const byId = new Map(state.profiles.map((p) => [p.id, p]));
      for (const vp of vaultProfiles) byId.set(vp.id, { ...(byId.get(vp.id) || {}), ...vp });
      state.profiles = [...byId.values()];
      const wanted = v.data.active || state.activeProfileId;
      state.activeProfileId = state.profiles.some((p) => p.id === wanted) ? wanted : state.profiles[0].id;
      state.formProfileId = state.activeProfileId;
      const p = state.profiles.find((x) => x.id === state.activeProfileId);
      if (p && sourceOf() === 'model') {
        state.connection.api = { baseUrl: p.baseUrl, key: p.key, model: p.model };
        renderHost();
        renderHeader();
      }
      loadProfile(state.activeProfileId);
      renderProfiles();
    }
    saveProfiles();
  } catch { /* 凭据库不可用时保持 localStorage 降级模式 */ }
}

function renderProfiles() {
  const row = $('#profileRow');
  if (!row) return;
  row.innerHTML = state.profiles.map((p) => {
    const isActive = p.id === state.activeProfileId;
    return `
    <button type="button" class="profile ${p.id === state.formProfileId ? 'is-active' : ''}" data-profile="${esc(p.id)}" title="${esc(p.baseUrl || '未填写地址')}">
      <b>${esc(p.name || '连接')}${isActive ? ' · 当前使用' : ''}</b>
      <small>${esc(hostOf(p.baseUrl) || '未配置')}</small>
    </button>`;
  }).join('');
  const del = $('#deleteProfile');
  if (del) del.disabled = state.profiles.length <= 1;
}

function loadProfile(id) {
  const p = state.profiles.find((x) => x.id === id) || state.profiles[0];
  if (!p) return;
  state.formProfileId = p.id;
  $('#apiBaseUrl').value = p.baseUrl || '';
  $('#apiKey').value = p.key || '';
  if ($('#apiProfileName')) $('#apiProfileName').value = p.name || '';
  state.formModel = validModel(p.model) ? p.model : DEFAULT_API.model;
  state.pendingModel = state.formModel;
  state.probeSig = '';
  state.probeOk = false;
  $('#manualModel').value = '';
  $('#probeResult').hidden = true;
  renderProfiles();
  renderApiModelRow();
}

function addProfile() {  const p = makeProfile({ baseUrl: DEFAULT_API.baseUrl, key: '', model: DEFAULT_API.model });
  p.name = `连接 ${state.profiles.length + 1}`;
  state.profiles.push(p);
  state.activeProfileId = state.activeProfileId || p.id;
  saveProfiles();
  loadProfile(p.id);
  $('#apiKey').focus();
  toast('已新增连接，填写后点「保存并启用」');
}

function deleteProfile() {
  if (state.profiles.length <= 1) { toast('至少保留一个连接'); return; }
  const p = state.profiles.find((x) => x.id === state.formProfileId);
  if (!p) return;
  if (!confirm(`删除连接「${p.name}」？`)) return;
  state.profiles = state.profiles.filter((x) => x.id !== p.id);
  const next = state.profiles[0];
  if (state.activeProfileId === p.id) {
    state.activeProfileId = next.id;
    if (sourceOf() === 'model') {
      state.connection.api = { baseUrl: next.baseUrl, key: next.key, model: next.model };
      state.connection.verified = false;
      persistConn({ ...state.connection });
    }
  }
  saveProfiles();
  loadProfile(next.id);
  toast('已删除连接');
}

function fillFormFromConn() {
  const api = state.connection.api || DEFAULT_API;
  $('#apiBaseUrl').value = api.baseUrl;
  $('#apiKey').value = api.key;
  const p = state.profiles.find((x) => x.id === state.activeProfileId);
  if ($('#apiProfileName')) $('#apiProfileName').value = p?.name || '';
  state.formModel = validModel(api.model) ? api.model : DEFAULT_API.model;
  state.pendingModel = state.formModel;
  $('#manualModel').value = '';
  renderApiModelRow();
}

function saveConnection() {
  const source = currentSource();
  if (source === 'preview') {
    // 先用旧来源做缓存键切换会话集合，再落盘新来源，避免 switchSource 被相等判断短路
    if (sourceOf() !== 'preview') switchSource('preview');
    persistConn({ ...state.connection, source: 'preview', verified: true });
    closeSheets();
    toast('已切到离线预览');
    return;
  }

  const cfg = apiCfg();
  const err = validateApiInput(cfg);
  if (err) { toast(err); return; }
  const old = state.connection.api;
  const sameSaved = old && old.baseUrl === cfg.baseUrl && old.key === cfg.key && old.model === cfg.model;
  // 刚对同一份表单配置探活通过时保留「已验证」，否则保存后要重新测试
  const verified = sameSaved
    ? !!state.connection.verified
    : (state.probeOk === true && state.probeSig === cfgSig(cfg));
  if (sourceOf() !== 'model') switchSource('model');
  state.formModel = cfg.model;
  state.pendingModel = cfg.model;

  // 保存表单为一条连接记录，并把「保存并启用」的连接设为活动
  const nameInput = $('#apiProfileName');
  const name = ((nameInput?.value || '').trim() || defaultProfileName(cfg)).slice(0, 40);
  let profile = state.profiles.find((p) => p.id === state.formProfileId);
  if (!profile) { profile = makeProfile(cfg); state.profiles.push(profile); }
  Object.assign(profile, { name, baseUrl: cfg.baseUrl, key: cfg.key, model: cfg.model });
  state.activeProfileId = profile.id;
  state.formProfileId = profile.id;
  if (nameInput) nameInput.value = name;
  saveProfiles();
  renderProfiles();

  persistConn({
    source: 'model',
    api: { baseUrl: cfg.baseUrl, key: cfg.key, model: cfg.model },
    verified,
  });
  closeSheets();
  toast(`已启用模型 API · ${cfg.model}`);
}

/** 点某个连接芯片 = 直接把它设为活动连接（同步模型列表缓存），不必再点「保存并启用」。 */
function activateProfile(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  if (!p.baseUrl.trim() || !p.key.trim()) { loadProfile(id); toast('请先补全该连接的地址与 Key，再点「保存并启用」'); return; }
  state.activeProfileId = p.id;
  saveProfiles();
  loadProfile(id);
  if (sourceOf() !== 'model') switchSource('model');
  // 模型列表按 baseUrl|key 缓存：连接已切换，立即重新拉取
  state.models = [];
  state.modelsFor = '';
  state.modelsError = '';
  fetchModels({ silent: false });
  persistConn({ source: 'model', api: { baseUrl: p.baseUrl, key: p.key, model: p.model }, verified: false });
  toast(`已切换到 ${p.name || hostOf(p.baseUrl)}`);
}

/* ───────── 个性化提示词 ───────── */

function saveCustomPrompt() {
  const el = $('#customPromptInput');
  if (!el) return;
  state.customPrompt = el.value.slice(0, 8000);
  writeStorage('dsh.customPrompt', state.customPrompt);
  toast(el.value.trim() ? '个性化提示词已保存，之后每轮对话都会生效' : '个性化提示词已清空');
}

/** 空状态里的「个性化提示词」指示：已启用时显示，点击直达设置。 */
function customPromptBadge() {
  const on = !!state.customPrompt?.trim();
  return `<button class="suggest ${on ? 'is-custom-on' : ''}" id="customPromptBadge" title="在设置中编辑个性化提示词">
    ${on ? '个性化提示词已启用 · 点击编辑' : '个性化提示词未设置 · 点击配置'}
  </button>`;
}

function showProbe(ok, text) {
  const box = $('#probeResult');
  box.hidden = false;
  box.className = 'probe' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
  box.textContent = text;
}

async function probe(options = {}) {
  const { silent = false } = options;
  if (state.probeBusy) return { ok: false, error: '正在测试连接，请稍候' };
  const cfg = apiCfg();
  const err = validateApiInput(cfg);
  if (err) { if (!silent) showProbe(false, '配置校验失败：' + err); return { ok: false, error: err }; }
  if (!window.dsh?.model) {
    const msg = '当前不在桌面外壳里运行，无法发起跨域请求';
    if (!silent) showProbe(false, msg);
    return { ok: false, error: msg };
  }

  state.probeBusy = true;
  const btn = $('#probeBtn');
  btn.disabled = true;
  if (!silent) showProbe(null, '正在连接…');
  try {
    const r = await window.dsh.model.test(cfg);
    state.probeSig = cfgSig(cfg);
    state.probeOk = r.ok === true;
    if (r.ok) {
      if (!silent) showProbe(true, `连接成功：${r.detail}`);
      // 探活顺手带回模型列表，省一次请求
      if (Array.isArray(r.models) && r.models.length) {
        state.models = r.models.filter((m) => m && validModel(m.id));
        state.modelsFor = cfg.baseUrl + '|' + cfg.key;
        state.modelsAt = Date.now();
        saveModelCache(cfg);
        renderModelMeta();
        renderModelList();
      }
      if (state.connection.source === 'model' && state.connection.api.baseUrl === cfg.baseUrl && state.connection.api.key === cfg.key) {
        persistConn({ ...state.connection, verified: true });
      }
    } else if (!silent) {
      showProbe(false, '连接失败：' + (r.error || '未知错误'));
    }
    return r;
  } catch (e) {
    state.probeSig = cfgSig(cfg);
    state.probeOk = false;
    const msg = `探活异常：${e?.message || e}`;
    if (!silent) showProbe(false, msg);
    return { ok: false, error: msg };
  } finally {
    state.probeBusy = false;
    btn.disabled = false;
  }
}

/* ───────── 视频壁纸 ───────── */

let wallErrorHandled = false;

function setWallState(text) {
  const el = $('#wallpaperState');
  if (el) el.textContent = String(text);
}

function applyTint(value) {
  const n = clamp(Math.round((Number(value) || 0) / 5) * 5, 0, 60);
  document.documentElement.style.setProperty('--wall-tint', `rgba(0, 0, 0, ${(n / 100).toFixed(2)})`);
  $('#tintValue').textContent = n + '%';
  $('#tintRange').value = String(n);
  writeStorage('dsh.tint', String(n));
  return n;
}

function applyVeil(value) {
  const n = clamp(Math.round((Number(value) || 0) / 5) * 5, 0, 80);
  const root = document.documentElement;
  // 对话底板厚度
  root.style.setProperty('--wall-veil-a', (n / 100).toFixed(2));
  // 侧栏/输入条厚度：同一根滑块驱动，略厚一点保证文字可读；0 时同样归零，
  // 这样拖到 0% 视频是真的完全不被遮挡，而不是还留一层底。
  root.style.setProperty('--wall-panel-a', Math.min(0.92, (n / 100) * 1.2).toFixed(3));
  $('#veilValue').textContent = n + '%';
  $('#veilRange').value = String(n);
  writeStorage('dsh.veil', String(n));
  return n;
}

async function applyWallpaper(info) {
  const video = $('#wallpaper');
  if (!info || !info.file) {
    try { video.pause(); } catch { /* 尚未播放 */ }
    video.removeAttribute('src');
    try { video.load(); } catch { /* 忽略 */ }
    document.documentElement.removeAttribute('data-wallpaper');
    setWallState('未设置 · 纯色界面，无模糊、无雾感');
    return false;
  }
  wallErrorHandled = false;
  video.src = '../assets/' + encodeURIComponent(info.file);
  document.documentElement.dataset.wallpaper = 'on';
  setWallState(`正在载入 ${info.file} · ${formatBytes(info.size)} · 静音循环`);
  try {
    await video.play();
    setWallState(`播放中 ${info.file} · ${formatBytes(info.size)} · 静音循环 · 无遮挡`);
    return true;
  } catch (err) {
    // 静音视频一般可自动播放；被拦时首帧仍可见，明确告知而不是静默失败
    setWallState(`已载入 ${info.file}，自动播放被阻止：${err?.message || err}`);
    return false;
  }
}

async function initWallpaper() {
  const video = $('#wallpaper');
  if (!video) return;
  video.addEventListener('error', () => {
    if (wallErrorHandled) return;
    wallErrorHandled = true;
    toast('视频编码不受支持，已回到纯色背景');
    document.documentElement.removeAttribute('data-wallpaper');
    video.removeAttribute('src');
    try { video.load(); } catch { /* 忽略 */ }
    setWallState('视频无法解码 · 已回到纯色界面（无模糊）');
    window.dsh?.wallpaper?.clear?.().catch?.(() => {});
  });
  applyTint(readStorage('dsh.tint', '0'));
  applyVeil(readStorage('dsh.veil', '26'));
  try {
    await applyWallpaper(await window.dsh?.wallpaper?.current?.());
  } catch (err) {
    setWallState(`读取壁纸失败：${err?.message || err}`);
  }
}

/* ───────── 重命名 ───────── */

function startRename() {
  const title = $('#title');
  const s = active();
  if (!s) return;
  title.contentEditable = 'plaintext-only';
  title.focus();
  document.execCommand?.('selectAll', false, null);

  const cleanup = () => {
    title.contentEditable = 'false';
    title.onkeydown = null;
  };
  const commit = () => {
    cleanup();
    const value = title.textContent.trim() || s.title;
    s.title = value.slice(0, 80);
    title.textContent = s.title;
    saveSessions();
    renderSessions();
    renderHeader();
  };
  title.addEventListener('blur', commit, { once: true });
  title.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    if (e.key === 'Escape') { title.textContent = s.title; title.blur(); }
  };
}

/* ───────── 事件绑定 ───────── */

function bind() {
  const win = window.dsh?.win;
  $('#winMin').addEventListener('click', () => win?.minimize());
  $('#winMax').addEventListener('click', () => win?.toggleMaximize());
  $('#winClose').addEventListener('click', () => win?.close());
  win?.onMaximized((max) => {
    $('#winMax').innerHTML = `<svg class="ico"><use href="#${max ? 'i-restore' : 'i-max'}"/></svg>`;
  });

  $('#collapseBtn').addEventListener('click', () => {
    state.collapsed = true;
    $('#app').classList.add('collapsed');
  });
  $('#menuBtn').addEventListener('click', () => {
    state.collapsed = false;
    $('#app').classList.remove('collapsed');
  });
  $('#newChatBtn').addEventListener('click', newChat);

  $('#searchInput').addEventListener('input', (e) => { state.query = e.target.value; renderSessions(); });
  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $$('.chip', $('#filters')).forEach((c) => c.classList.toggle('is-active', c === chip));
    renderSessions();
  });

  $('#modelBtn').addEventListener('click', (e) => { e.stopPropagation(); openModelSheet(); });

  $('#renameBtn').addEventListener('click', startRename);
  $('#panelBtn').addEventListener('click', () => {
    if (inspector.open) closeInspector();
    else openInspector();
  });
  $('#todoBtn').addEventListener('click', toggleTodoPanel);
  $('#inspClose').addEventListener('click', closeInspector);
  $('#inspRefresh').addEventListener('click', () => refreshInspector());
  $('#inspBody').addEventListener('click', (e) => {
    const viewBtn = e.target.closest('[data-insp-view]');
    if (viewBtn) {
      inspector.view = viewBtn.dataset.inspView;
      inspector.nodeDetail = '';
      refreshInspector();
      return;
    }
    const nodeBtn = e.target.closest('.insp-node');
    if (nodeBtn) {
      inspector.nodeDetail = inspector.nodeDetail === nodeBtn.dataset.nodeId ? '' : nodeBtn.dataset.nodeId;
      renderInspector();
      return;
    }
    const reconcileBtn = e.target.closest('[data-reconcile]');
    if (reconcileBtn) {
      const toolCallId = reconcileBtn.dataset.toolCall;
      window.dsh.runtime.tools.reconcile({
        toolCallId,
        outcome: reconcileBtn.dataset.reconcile,
        reason: '用户在运行检查器中人工核对',
      }).then((r) => {
        if (!r?.ok) { toast(r?.error?.message || '核对失败'); return; }
        toast('已记录人工核对结果');
        refreshInspector();
      });
      return;
    }
    if (e.target.closest('#inspPlay')) { toggleReplay(); return; }
    if (e.target.closest('#inspLive')) {
      stopReplay();
      inspector.replayCursor = null;
      refreshInspector();
      return;
    }
    const btn = e.target.closest('.insp-task');
    if (btn?.dataset.taskId) { pickInspectorTask(btn.dataset.taskId); return; }
    const child = e.target.closest('[data-child-task]');
    if (child?.dataset.childTask) { pickInspectorTask(child.dataset.childTask); return; }
    if (e.target.closest('[data-open-agents]')) openAgentSheet();
  });
  $('#inspBody').addEventListener('input', (e) => {
    if (e.target.id !== 'inspRange') return;
    clearTimeout(inspector.seekTimer);
    const value = e.target.value;
    inspector.seekTimer = setTimeout(() => setReplayCursor(value), 90);
  });

  const ta = $('#input');
  ta.addEventListener('input', () => { autoGrow(); updateSendState(); updateSlash(); saveDraftSoon(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape') hideMenus();
    if (e.key === 'ArrowUp' && !e.shiftKey && tryHistory(-1)) e.preventDefault();
    if (e.key === 'ArrowDown' && !e.shiftKey && tryHistory(1)) e.preventDefault();
  });
  // 交给 send() 统一判定：busy+空输入=停止，busy+有文字=插话/排队，空闲=发送
  $('#sendBtn').addEventListener('click', send);
  $('#modeBtn').addEventListener('click', (e) => { e.stopPropagation(); openMenu('modeMenu', $('#modeBtn')); });
  $('#permBtn').addEventListener('click', (e) => { e.stopPropagation(); openMenu('permMenu', $('#permBtn')); });
  $('#permMenu').addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    setPermission(item.dataset.perm);
    hideMenus();
  });
  $('#modeMenu').addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    state.mode = item.dataset.mode;
    $('#modeName').textContent = { now: '现在', queue: '排队', steer: '插话' }[state.mode];
    $$('.menu-item', $('#modeMenu')).forEach((m) => m.classList.toggle('is-active', m === item));
    hideMenus();
  });
  $('#slashMenu').addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    ta.value = item.dataset.cmd + ' ';
    hideMenus();
    ta.focus();
    autoGrow();
    updateSendState();
    updateSlash();
  });

  $('#plusBtn').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => addFiles(input.files));
    input.click();
  });
  $('#attachBar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-attach-remove]');
    if (btn) removeAttachment(Number(btn.dataset.attachRemove));
  });

  $('#queueCancel').addEventListener('click', () => {
    state.pending = null;
    $('#queue').hidden = true;
    toast('已撤销排队消息');
  });
  $('#queueNow').addEventListener('click', () => {
    if (!state.pending) return;
    const text = state.pending;
    state.pending = null;
    $('#queue').hidden = true;
    requestInterrupt(text);
  });
  $('#queueSteer').addEventListener('click', () => {
    if (!state.pending) return;
    const text = state.pending;
    state.pending = null;
    $('#queue').hidden = true;
    requestInterrupt(text);
  });

  $('#scrim').addEventListener('click', closeSheets);
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => {
    const sheet = b.closest('.sheet');
    if (sheet) closeSheet(sheet.id); else closeSheets();
  }));
  $('#settingsBtn').addEventListener('click', () => {
    const el = $('#customPromptInput');
    if (el) el.value = state.customPrompt || '';
    openSheet('settingsSheet');
  });
  $('#saveCustomPrompt').addEventListener('click', saveCustomPrompt);
  $('#openAgents').addEventListener('click', openAgentSheet);
  $('#agentPermSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    agentPermChoice = ['full', 'ask', 'readonly'].includes(b.dataset.agentPerm) ? b.dataset.agentPerm : 'ask';
    $$('#agentPermSeg button').forEach((x) => x.classList.toggle('is-active', x === b));
  });
  $('#agentCreate').addEventListener('click', createAgentFromForm);
  $('#agentList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-agent-archive]');
    if (b) archiveAgentFromUi(b.dataset.agentArchive);
  });
  $('#agentModelProfile').addEventListener('change', refreshAgentModelList);
  bindArchPage();
  $('#delegApprovals').addEventListener('click', (e) => {
    const b = e.target.closest('[data-deleg-approve]');
    if (!b) return;
    const card = b.closest('[data-approval-id]');
    if (card) decideDelegationApproval(card.dataset.approvalId, b.dataset.delegApprove);
  });
  $('#themeBtn').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
  $('#themeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) applyTheme(b.dataset.theme);
  });
  $('#accentRow').addEventListener('click', (e) => {
    const b = e.target.closest('.accent');
    if (b) applyAccent(b.dataset.accent);
  });

  /* 重试次数 */
  const syncRetrySeg = () => {
    $$('#retrySeg button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.retries) === retrySetting()));
    const n = retrySetting();
    $('#retryFine').textContent = n === 0
      ? '已关闭自动重试：任何失败都直接把错误交给界面。'
      : `限流、5xx、网关超时与网络中断会自动重试：2s → 4s → 8s 指数退避，最多 ${n} 次；服务端给了 Retry-After 就按它等。参数错误与鉴权失败不重试。`;
  };
  $('#retrySeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const n = Number(b.dataset.retries);
    if (!RETRY_CHOICES.includes(n)) return;
    writeStorage('dsh.retries', String(n));
    syncRetrySeg();
    toast(n === 0 ? '已关闭自动重试' : `自动重试最多 ${n} 次`);
  });
  syncRetrySeg();

  $('#hostBtn').addEventListener('click', openConnect);
  $('#openConnect').addEventListener('click', () => { closeSheets(); openConnect(); });
  $('#sourceSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#sourceSeg button').forEach((x) => x.classList.toggle('is-active', x === b));
    syncSourcePane(b.dataset.source);
    $('#probeResult').hidden = true;
  });
  $('#resetApiCfg').addEventListener('click', () => {
    $('#apiBaseUrl').value = DEFAULT_API.baseUrl;
    $('#apiKey').value = DEFAULT_API.key;
    state.formModel = DEFAULT_API.model;
    state.pendingModel = DEFAULT_API.model;
    state.probeSig = '';
    state.probeOk = false;
    $('#manualModel').value = '';
    $('#probeResult').hidden = true;
    renderApiModelRow();
    toast('已恢复默认值，保存后生效');
  });
  $('#probeBtn').addEventListener('click', () => probe());
  $('#connectBtn').addEventListener('click', saveConnection);

  /* 本地工具设置（工具始终启用，只需选择工作目录） */
  $('#pickWorkspace').addEventListener('click', pickWorkspace);

  /* 多连接管理 */
  $('#profileRow').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-profile]');
    if (chip) activateProfile(chip.dataset.profile);
  });
  $('#addProfile').addEventListener('click', addProfile);
  $('#deleteProfile').addEventListener('click', deleteProfile);

  /* 模型选择面板 */
  $('#openModelSheet').addEventListener('click', () => openModelSheet('connect'));
  $('#refreshModels').addEventListener('click', () => fetchModels());
  $('#modelSearch').addEventListener('input', renderModelList);
  $('#modelList').addEventListener('click', (e) => {
    const item = e.target.closest('.model-item');
    if (!item) return;
    state.pendingModel = item.dataset.model;
    $('#manualModel').value = '';
    renderModelList();
  });
  $('#manualModel').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (v) { state.pendingModel = v; renderModelList(); }
  });
  $('#modelApply').addEventListener('click', applyModelChoice);

  $('#pickWallpaper').addEventListener('click', async () => {
    if (!window.dsh?.wallpaper) { toast('当前桌面外壳不支持视频壁纸'); return; }
    const btn = $('#pickWallpaper');
    btn.disabled = true;
    try {
      const r = await window.dsh.wallpaper.pick();
      if (r?.canceled) return;
      if (!r?.ok) { toast(r?.error || '设置失败'); return; }
      await applyWallpaper({ file: r.file, size: r.size });
      toast('视频壁纸已启用');
    } catch (err) {
      toast(`设置失败：${err?.message || err}`);
    } finally {
      btn.disabled = false;
    }
  });
  $('#clearWallpaper').addEventListener('click', async () => {
    try {
      const r = await window.dsh?.wallpaper?.clear?.();
      if (r && r.ok === false) { toast(r.error || '移除失败'); return; }
      await applyWallpaper(null);
      toast('已移除视频壁纸');
    } catch (err) {
      toast(`移除失败：${err?.message || err}`);
    }
  });
  $('#tintRange').addEventListener('input', (e) => applyTint(e.target.value));
  $('#veilRange').addEventListener('input', (e) => applyVeil(e.target.value));

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('#modeBtn') && !e.target.closest('#permBtn') && !e.target.closest('#todoBtn')) hideMenus();
  });
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#searchInput').focus();
      $('#searchInput').select();
    }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
    if (e.key === 'Escape') {
      hideMenus();
      closeSheets();
      if (state.projectOpen && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) closeArchPage();
    }
  });

  $('#chat').addEventListener('click', (e) => {
    if (e.target.closest('[data-retry-cancel]')) { stopTurn(); return; }
    const resume = e.target.closest('[data-resume]');
    if (resume) {
      const node = resume.closest('.msg');
      const msg = node ? msgStore.get(node.dataset.msgId) : null;
      // 中断续跑看 resumeFrom；失败重试只要求该轮确实失败了
      if (!msg?.resumeFrom && !msg?.error) return;
      if (state.busy) { toast('请先结束当前回合'); return; }
      runTurn('继续');
      return;
    }
    const copyBtn = e.target.closest('[data-copy-msg]');
    if (copyBtn) {
      const node = copyBtn.closest('.msg');
      const msg = node ? msgStore.get(node.dataset.msgId) : null;
      const text = String(msg?.body || msg?.text || '');
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        // 成功打勾 1.2s 还原（ZCode CopyRowAction 模式），比 toast 更轻
        copyBtn.classList.add('is-copied');
        copyBtn.innerHTML = '<svg class="ico tiny"><use href="#i-check"/></svg>';
        setTimeout(() => {
          copyBtn.classList.remove('is-copied');
          copyBtn.innerHTML = '<svg class="ico tiny"><use href="#i-copy"/></svg>';
        }, 1200);
      }).catch(() => toast('复制失败'));
      return;
    }
    const codeBtn = e.target.closest('.code-copy');
    if (codeBtn) {
      const pre = codeBtn.closest('pre');
      const text = pre?.querySelector('code')?.textContent || pre?.textContent || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        codeBtn.classList.add('is-copied');
        codeBtn.innerHTML = '<svg class="ico tiny"><use href="#i-check"/></svg>';
        setTimeout(() => {
          codeBtn.classList.remove('is-copied');
          codeBtn.innerHTML = '<svg class="ico tiny"><use href="#i-copy"/></svg>';
        }, 1200);
      }).catch(() => toast('复制失败'));
      return;
    }
    const node = e.target.closest('.msg');
    if (!node) return;
    const msg = msgStore.get(node.dataset.msgId);
    if (!msg) return;
    const toolEl = e.target.closest('.tool');
    if (toolEl) {
      const t = (msg.tools || []).find((x) => x.id === toolEl.dataset.toolId);
      if (t && (t.result || t.args)) {
        t.expanded = !t.expanded;
        renderTools(node, msg);
      }
      return;
    }
    if (e.target.closest('.metrics')) { toggleMetrics(node, msg); return; }
    const more = e.target.closest('[data-file-more]');
    if (more) { toggleFileDetail(node, msg, Number(more.dataset.fileMore)); return; }
    const btn = e.target.closest('[data-approve]');
    if (btn) applyApproval(node, msg, btn.dataset.approve);
  });

  $('#chat').addEventListener('scroll', () => {
    const chat = $('#chat');
    stickBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    const jump = $('#jumpBottom');
    if (jump) jump.hidden = stickBottom; // 上滚离开底部时给一个「回到底部」入口
  });

  $('#jumpBottom')?.addEventListener('click', () => scrollToBottom(true));

  // 会话列表事件委托：renderSessions 每次重建 DOM，不再逐行挂监听
  $('#sessions').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); deleteSession(del.dataset.del); return; }
    const row = e.target.closest('.session');
    if (row) selectSession(row.dataset.id);
  });

  // 代码块复制：悬停时注入角落按钮（流式重绘会冲掉按钮，悬停即补）
  $('#chat').addEventListener('mouseover', (e) => {
    const pre = e.target.closest('.prose pre');
    if (pre && !pre.querySelector(':scope > .code-copy')) {
      pre.insertAdjacentHTML('beforeend', '<button class="code-copy" title="复制代码"><svg class="ico tiny"><use href="#i-copy"/></svg></button>');
    }
  });

  window.addEventListener('focus', () => {
    const s = active();
    if (s?.unread) { s.unread = false; renderSessions(); }
  });
  window.addEventListener('beforeunload', () => window.dsh?.model?.abortAll?.());
}

/* ───────── 启动 ───────── */

function boot() {
  applyTheme(state.theme);
  applyAccent(state.accent);
  renderPerm();
  loadProfiles(false);
  loadProfile(state.activeProfileId);
  hydrateProfilesFromVault();
  loadModelCache();
  syncSourcePane(sourceOf());
  renderSessions();
  renderHeader();
  renderHost();
  renderChat();
  bind();
  restoreDraft(); // 启动时恢复当前会话的未发送草稿
  autoGrow();
  updateSendState();
  renderAttachments();
  renderToolsSetting();

  // 启动即加载工具定义并解析默认工作目录，API 面板不再停在「加载中…」
  if (window.dsh?.tools) {
    loadTools().then(() => ensureWorkspace()).catch(() => renderToolsSetting());
  }

  window.dsh?.model?.onEvent((e) => {
    // 严格按 id 路由：旧回合迟到的 done 绝不能落到刚发起的新回合上
    if (!e || !e.id) return;
    const handler = state.turns.get(e.id);
    if (handler) handler.onEvent(e);
  });

  // 运行检查器实时跟随当前 Run 的事件
  window.dsh?.runtime?.events?.onEvent?.((event) => {
    handleDelegationApprovalEvent(event);
    handleArchitectureEvent(event);
    // 主 Agent 委派时可能自动创建子 Agent（agent.updated 事件）：刷新 Agent 列表与架构页
    if (event?.type === 'agent.updated' && window.dsh?.runtime?.agents?.list) {
      loadAgents().then(() => {
        renderAgentList();
        if (inspector.open) refreshInspector();
      }).catch(() => {});
    }
    if (!inspector.open || !event?.runId || event.runId !== inspector.runId) return;
    inspector.events.push(event);
    if (inspector.replayTimer || Number.isInteger(inspector.replayCursor)) return;
    renderInspector();
    if (['run.finished', 'run.interrupted', 'task.finished'].includes(event.type)) {
      clearTimeout(inspector.timer);
      setTimeout(() => refreshInspector(), 300);
    }
  });

  // 静默真实探活：只校验端点与模型，不改变用户配置、不弹面板
  if (sourceOf() === 'model' && window.dsh?.model && !window.__DSH_NO_AUTOPROBE) {
    setTimeout(() => probe({ silent: true }), 300);
  }
  initWallpaper();
  $('#input').focus();
}

boot();
