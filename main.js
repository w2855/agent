'use strict';

const {
  app, BrowserWindow, ipcMain, shell, nativeTheme, net, dialog, safeStorage,
  Notification, Tray, Menu, nativeImage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const retry = require('./lib/retry');
const secretMask = require('./lib/secret-mask');
const notifyDedupe = require('./lib/notify-dedupe');
const guard = require('./lib/instance-guard');
const localTools = require('./lib/tools');
const mcpModule = require('./lib/mcp');
const skillsModule = require('./lib/skills');
const runtimeModule = require('./runtime');

// 测试模式（--script/--shot）禁用硬件加速：本机 GPU 驱动间歇性导致渲染进程启动即崩
// （Renderer process crashed / GPU process exited），did-finish-load 不触发、脚本永远不跑；
// 该 UI 是纯 DOM/CSS，软件渲染完全够用。日常启动不受影响。
if (process.argv.includes('--script') || process.argv.includes('--shot')) {
  app.disableHardwareAcceleration();
}

// 允许用 --user-data-dir 隔离测试数据；正常启动仍使用系统默认目录
const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) {
  const dir = path.resolve(userDataArg.slice('--user-data-dir='.length));
  try {
    fs.mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
  } catch (err) {
    console.log('[boot] 无法设置 userData 目录：', err?.message || err);
  }
}

// 浅色是默认外观；窗口底色跟主题一致，避免启动瞬间白闪。
nativeTheme.themeSource = 'light';

/* ---------------- P2 稳定性守护（启动期） ----------------
 * 1) 软渲染标记：上次运行渲染进程 60s 内连续崩溃满 3 次时写入 userData/soft-render.flag，
 *    本次启动在 ready 之前禁用硬件加速（该 API 只在 ready 前调用才生效）；
 *    删除标记文件即可恢复 GPU。本机 GPU 驱动间歇崩溃见 docs/e2e-guide.md。
 * 2) 单实例锁：双开会同时占用同一份 userData（LevelDB 缓存锁冲突，docs/e2e-guide.md 坑 2），
 *    拿不到锁的第二实例直接退出，既有实例经 second-instance 事件把窗口拉到前台。
 */
let hwAccelDisabledAtBoot = false;
try {
  const softRenderFlag = path.join(app.getPath('userData'), 'soft-render.flag');
  if (fs.existsSync(softRenderFlag)) {
    app.disableHardwareAcceleration();
    hwAccelDisabledAtBoot = true;
    console.log('[boot] 检测到软渲染标记，本次启动已禁用硬件加速');
  }
} catch (err) {
  console.log('[boot] 软渲染标记检查失败：', err?.message || err);
}

const lockResult = guard.getLockResult(app.requestSingleInstanceLock());
let secondInstanceCount = 0;
if (!lockResult.isPrimary) {
  console.log('[boot] 已有 DSH 实例运行');
  app.quit();
} else {
  app.on('second-instance', () => {
    secondInstanceCount += 1;
    // 双开唤起：复用托盘的 showMainWindow（restore + show + focus），窗口不存在时静默跳过
    showMainWindow();
  });
}

// Windows toast 通知要求应用声明 AppUserModelID，否则 new Notification() 在 Windows 上
// 直接触发 failed 事件（toast 不显示）。打包后用 electron-builder 的 appId；
// 未打包（开发/探针）时 toast 只认可执行文件自身的 AUMID，用 process.execPath。
app.setAppUserModelId(app.isPackaged ? 'cn.dsh.desktop' : process.execPath);


/** 错误信息脱敏：任何回给渲染层/日志的文本不得包含 API Key 或常见密钥形态。 */
function scrubSecret(text, key) {
  let out = String(text == null ? '' : text);
  if (typeof key === 'string' && key.length >= 4) out = out.split(key).join('***');
  return out.replace(/(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-***');
}

/** 默认模型（用户指定）。列表里选别的也可以，但默认值不变。 */
const DEFAULT_MODEL = 'gemini-3.8-flash';
/** 模型名允许的字符集：各家的模型 id 会长成 a/b:c@v1 这类样子。 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/;

const CONNECT_TIMEOUT_MS = 15000;
const HARD_TIMEOUT_MS = 180000;   // 单次回合总时长上限（重试共享这一份预算）
const IDLE_TIMEOUT_MS = 45000;    // 两次 chunk 之间的最长静默
const MAX_OUTPUT_CHARS = 200000;  // 防止异常网关把内存打满
const MAX_INPUT_CHARS = 200000;
const MAX_MODELS = 500;

/** @type {BrowserWindow | null} */
let win = null;
/** Runtime 基础服务（Phase 1：事件存储 / Policy / 工具注册表） */
let runtimeSvc = null;
/** id -> { lifeCtrl, ctrl, cancelBody, aborted, reason, finish } */
const activeChats = new Map();

/** MCP stdio 客户端管理器（server 的启停/发现/调用都在主进程） */
const mcpManager = mcpModule.createMcpManager();
/** MCP server 配置的内存态；持久化由渲染层 localStorage 负责，经 IPC 同步下来 */
let mcpConfigs = [];

/** 主进程持有的真实 API Key（profileId → 明文）。
    任何发回渲染层的路径都只允许掩码：get 转掩码视图，chat/test/list 用这张表还原 key。 */
let profileKeyById = new Map();

/* ---------------- 系统通知 / 托盘（模块级状态） ---------------- */

/** 通知去重器：相同 tag 在 30s 内只发一次（后台回合/审批提醒可能由两条路径先后触发）。 */
const osNotifyDedupe = notifyDedupe.createNotifyDedupe();
/** 持有在途通知的引用，防止还没展示完就被 GC；close/failed 时移除。 */
const liveNotifications = new Set();

/** Windows 托盘引用放模块级：Tray 被回收图标会消失，托盘实例本身也不能丢。 */
let tray = null;
/** 「关闭时最小化到托盘」开关：渲染层 localStorage 持有，经 tray:state IPC 同步进内存。 */
let closeToTray = false;
/** 首次隐藏到托盘的提示只发一次。 */
let trayHintShown = false;
/** app.quit() 途中 close 事件也会触发： quitting 时不再拦截，否则永远退不出去。 */
let quitting = false;

/* ---------------- P2 稳定性守护（运行期状态） ---------------- */

/** 渲染进程崩溃计数：60s 窗口满 3 次标记软渲染，判定逻辑在 lib/instance-guard.js（可 node 单测）。 */
const crashTracker = new guard.CrashTracker();
/** render-process-gone 监听是否已挂上（createWindow 里置位，供 guard:state 诊断通道自检）。 */
let crashListenerAttached = false;
/** whenReady 完成时刻；首次 did-finish-load 时用它算 boot 耗时写入 crash-log.jsonl。 */
let bootReadyAt = 0;

/* MCP 工具与内置工具合流：executeTool 按 mcp_ 前缀路由到管理器。
   审批与 policy 不做任何特殊放行——MCP 工具一律按 run_command 同档
   （ask 需审批、readonly 拒绝），见 lib/tools.js 的 executeMcpTool。 */
localTools.setMcpBridge({
  resolve: (fullName) => mcpModule.findTool(mcpManager.status(), fullName),
  call: (serverId, toolName, args) => mcpManager.callTool(serverId, toolName, args),
});

/* ---------------- P2 启动时长 / 崩溃日志 ----------------
 * crash-log.jsonl 放在 userData：每行一条 JSON（boot 记录启动耗时，render-crash 记录崩溃），
 * 超过 50 行环形裁剪（裁剪与解析的纯逻辑在 lib/instance-guard.js）。写入失败只打日志，不碰主流程。
 */

function crashLogPath() {
  return path.join(app.getPath('userData'), 'crash-log.jsonl');
}

/** 追加一条 JSON 记录（环形裁剪到 50 行后整体重写；文件只有几十行，开销可忽略）。 */
function appendCrashLog(entry) {
  try {
    let raw = '';
    try { raw = fs.readFileSync(crashLogPath(), 'utf8'); } catch { /* 首次写入前文件不存在 */ }
    fs.mkdirSync(path.dirname(crashLogPath()), { recursive: true });
    fs.writeFileSync(crashLogPath(), guard.appendJsonlEntry(raw, entry), 'utf8');
  } catch (err) {
    console.log('[crash-log] 写入失败：', err?.message || err);
  }
}

/** 概要统计（guard:state 诊断通道用）：文件是否存在、行数、最后一条记录的 type。 */
function crashLogSummary() {
  try {
    const raw = fs.readFileSync(crashLogPath(), 'utf8');
    return { exists: true, ...guard.summarizeCrashLog(raw) };
  } catch {
    return { exists: false, lines: 0, lastType: null };
  }
}

/** 连续崩溃满阈值：写软渲染标记，下次启动生效（ready 之后调用 disableHardwareAcceleration 无效）。 */
function markSoftRenderNextBoot() {
  try {
    const flagPath = path.join(app.getPath('userData'), 'soft-render.flag');
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    fs.writeFileSync(flagPath, String(Date.now()), 'utf8');
    console.log('[crash] 已标记下次启动使用软渲染（删除 userData/soft-render.flag 可恢复硬件加速）');
  } catch (err) {
    console.log('[crash] 软渲染标记写入失败：', err?.message || err);
  }
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const sizeArg = process.argv.find((x) => x.startsWith('--size='));
  const [w, h] = sizeArg ? sizeArg.slice(7).split('x').map(Number) : [1320, 880];

  win = new BrowserWindow({
    width: Number.isFinite(w) && w >= 900 ? w : 1320,
    height: Number.isFinite(h) && h >= 620 ? h : 880,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#EBF1FE',
    title: 'DSH',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 自检时把渲染层报错带出来，避免「看起来没问题但其实脚本挂了」
  if (process.argv.includes('--shot')) {
    win.webContents.on('console-message', (...args) => {
      const d = typeof args[0] === 'object' ? args[0] : { level: args[1], message: args[2], lineNumber: args[3] };
      if (Number(d.level) >= 2) console.log('[renderer-error]', d.message, 'line', d.lineNumber);
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 主框架只允许停留在本地界面；外部链接交给系统浏览器，避免远端页面继承 preload 桥。
  const rendererEntry = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  const isLocalEntry = (url) => url === rendererEntry || url.startsWith(rendererEntry + '#');
  win.webContents.on('will-navigate', (event, url) => {
    if (isLocalEntry(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // P2 渲染进程崩溃恢复：本机 GPU 驱动间歇崩溃（docs/e2e-guide.md）时自动拉起；
  // 60s 窗口内连续满 3 次则写软渲染标记，下次启动转软件渲染。
  crashListenerAttached = true;
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = String(details?.reason || 'unknown');
    const exitCode = Number(details?.exitCode);
    appendCrashLog({
      type: 'render-crash',
      reason,
      exitCode: Number.isFinite(exitCode) ? exitCode : null,
      at: Date.now(),
    });
    const verdict = crashTracker.record(Date.now());
    console.log('[crash] 渲染进程异常退出：', reason, 'exitCode', exitCode, `（60s 窗口内第 ${verdict.count} 次）`);
    if (verdict.shouldMarkSoftRender) markSoftRenderNextBoot();
    if (quitting) return; // 正在退出：不再弹框 / 重载
    if (process.argv.includes('--script') || process.argv.includes('--shot')) {
      // 脚本 / 截图模式无头运行，弹框会卡死自检：静默重载让 did-finish-load 的自检回调接得上；
      // 阈值已满（第 3 次）就不再重载，避免无限崩溃循环。
      if (verdict.count < verdict.threshold && win && !win.isDestroyed()) win.webContents.reload();
      return;
    }
    dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning',
      title: 'DSH',
      message: '界面进程异常退出，是否重新加载？',
      detail: `渲染进程异常退出（${reason}）。若连续多次崩溃，下次启动将自动改用软渲染。`,
      buttons: ['重新加载', '暂不'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && win && !win.isDestroyed()) win.webContents.reload();
    }).catch(() => { /* 对话框失败即放弃，不打断主流程 */ });
  });

  // P2 启动时长：whenReady → 首次 did-finish-load，每次启动写一条 boot 记录
  win.webContents.once('did-finish-load', () => {
    if (bootReadyAt > 0) appendCrashLog({ type: 'boot', bootMs: Date.now() - bootReadyAt, at: Date.now() });
  });

  const emitMax = () => { if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized()); };
  win.on('maximize', emitMax);
  win.on('unmaximize', emitMax);
  win.on('closed', () => {
    for (const s of activeChats.values()) forceAbort(s);
    activeChats.clear();
    win = null;
  });

  // 关闭到托盘：开关开启（且不是真退出）时只隐藏窗口，首次隐藏发一条系统提示
  win.on('close', (event) => {
    if (quitting || !closeToTray) return;
    event.preventDefault();
    if (win && !win.isDestroyed()) win.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      showOsNotification({ title: 'DSH', body: '已最小化到托盘，右键托盘图标可退出', tag: 'tray-hint' });
    }
  });

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  // 启动即打开「API 接入」面板，方便直接测试连接
  if (process.argv.includes('--open-connect')) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 350));
      if (win && !win.isDestroyed()) {
        try { await win.webContents.executeJavaScript('openConnect()'); } catch (err) {
          console.log('[open-connect]', err && err.message ? err.message : String(err));
        }
      }
    });
  }

  // 截图自检：electron . --shot [--script=xxx]（脚本只允许 tools/ 目录内，防路径逃逸）
  if (process.argv.includes('--shot')) {
    const arg = process.argv.find((a) => a.startsWith('--script='));
    const scriptFile = arg ? arg.slice('--script='.length) : null;
    const scriptPath = scriptFile && /^tools[\\/][\w.-]+\.js$/.test(scriptFile)
      ? path.join(__dirname, scriptFile)
      : null;
    if (scriptFile && !scriptPath) console.log('[script-error] --script 只允许 tools/ 目录下的 .js 文件');
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 700));
      if (scriptPath) {
        try {
          const code = fs.readFileSync(scriptPath, 'utf8');
          const result = await win.webContents.executeJavaScript(code);
          if (result !== undefined) console.log('[script]', JSON.stringify(result));
        } catch (err) {
          console.log('[script-error]', err && err.message ? err.message : String(err));
        }
        await new Promise((r) => setTimeout(r, 1600));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, 'shot.png'), img.toPNG());
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  if (!lockResult.isPrimary) return; // 第二实例已请求退出，不再初始化任何服务
  bootReadyAt = Date.now();
  try {
    runtimeSvc = runtimeModule.createRuntime({
      dir: path.join(app.getPath('userData'), 'runtime'),
      workspacePath: app.getPath('documents'),
      executeTool: (name, args, opts) => localTools.executeTool(name, args, opts),
      modelRequest: delegationModelRequest,
    });
    runtimeSvc.init();
    runtimeSvc.subscribe((event) => {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('runtime:event', event); } catch { /* 窗口正在关闭 */ }
      }
    });
  } catch (err) {
    runtimeSvc = null;
    console.log('[runtime] 初始化失败：', err && err.message ? err.message : String(err));
  }
  createWindow();
  // 托盘只在 Windows 创建（macOS 用 Dock，Linux 各发行版托盘行为差异大，先不铺开）
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // quit 途中窗口还会收到 close 事件：置位后 close 拦截不再生效，保证能退干净
  quitting = true;
  try { runtimeSvc?.close(); } catch { /* 已关闭 */ }
  // 退出时停掉所有 MCP server（杀整棵进程树，避免遗留子进程）
  try { mcpManager.stopAll(); } catch { /* 尽力停止即可 */ }
  // 托盘先销毁再退出，防止图标残留在任务栏托盘区
  destroyTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- 窗口控制 ---------------- */

ipcMain.on('win:minimize', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.on('win:toggle-maximize', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => { if (win && !win.isDestroyed()) win.close(); });
ipcMain.handle('win:is-maximized', () => !!(win && !win.isDestroyed() && win.isMaximized()));

/* ---------------- 系统通知（Windows toast） ----------------
 * 渲染层只在 document.hidden 时发起（前台不打扰），走这里统一展示：
 * 相同 tag 30s 内去重成一条；点击通知聚焦主窗口。不支持通知的系统静默跳过。
 */

function showOsNotification(payload) {
  // 权限自检：不支持就静默跳过，让调用方拿到明确的 UNSUPPORTED
  if (!Notification.isSupported()) return { ok: false, code: 'UNSUPPORTED', message: '当前系统不支持通知' };
  const title = String(payload?.title || '').trim().slice(0, 80) || 'DSH';
  const body = String(payload?.body || '').slice(0, 200);
  const tag = typeof payload?.tag === 'string' && payload.tag.trim() ? payload.tag.trim() : '';
  // 去重键 = tag：没有 tag 就每次都发；命中窗口期直接吞掉本次
  if (tag && !osNotifyDedupe.shouldSend(tag)) return { ok: true, deduped: true };
  const notification = new Notification({ title, body, silent: false });
  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.on('click', () => {
    // 点击通知 → 聚焦主窗口
    showMainWindow();
  });
  notification.on('close', release);
  notification.on('failed', (_event, error) => {
    release();
    console.log('[notify] 展示失败：', error || '未知原因');
  });
  notification.show();
  return { ok: true };
}

ipcMain.handle('notify:show', (_event, payload) => {
  try { return showOsNotification(payload); } catch (err) {
    return { ok: false, error: `通知发送失败：${err?.message || String(err)}` };
  }
});

/* ---------------- Windows 托盘 ----------------
 * 仅 win32 创建；左键点击显示并聚焦窗口，右键菜单提供打开 / 新对话 / 退出。
 * 「新对话」发 tray:new-chat，由渲染层 bind() 监听后调 newChat()。
 */

function showMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  if (process.platform !== 'win32') return;
  try {
    // png 直接可用；缩到 16px 高，避免大图在托盘区被系统按原尺寸渲染
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('DSH');
    tray.on('click', () => showMainWindow());
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 DSH', click: () => showMainWindow() },
      {
        label: '新对话',
        click: () => {
          showMainWindow();
          try { win?.webContents?.send('tray:new-chat'); } catch { /* 窗口正在关闭 */ }
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
  } catch (err) {
    tray = null;
    console.log('[tray] 创建失败：', err?.message || err);
  }
}

function destroyTray() {
  try { tray?.destroy(); } catch { /* 已销毁 */ }
  tray = null;
}

ipcMain.handle('tray:state:get', () => ({
  ok: true,
  platform: process.platform,
  supported: process.platform === 'win32',
  closeToTray,
  trayCreated: !!(tray && !tray.isDestroyed()),
}));

// 开关状态由渲染层 localStorage 持有，启动时 set 一次同步进内存（与 mcpConfigs 同一模式）
ipcMain.handle('tray:state:set', (_event, payload) => {
  closeToTray = !!(payload && payload.closeToTray === true);
  return { ok: true, closeToTray };
});

/* ---------------- P2 稳定性守护（诊断通道） ----------------
 * 供设置页「关于」与探针自检：单实例锁状态、崩溃监听、软渲染标记、crash-log 概要。
 */

ipcMain.handle('guard:state', () => ({
  ok: true,
  isPrimary: lockResult.isPrimary,
  secondInstanceCount,
  hwAccelDisabledAtBoot,
  softRenderMarked: crashTracker.isSoftRenderMarked(),
  crashListenerAttached,
  crashLog: crashLogSummary(),
}));

/* ---------------- Runtime（Phase 1 基础） ---------------- */

ipcMain.handle('runtime:system:health', () => {
  if (!runtimeSvc) return { ok: false, error: { code: 'INTERNAL', message: 'Runtime 未初始化' } };
  try {
    return runtimeSvc.health();
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL', message: err?.message || String(err) } };
  }
});

ipcMain.handle('runtime:events:read', (_event, query) => {
  if (!runtimeSvc) return { ok: false, error: { code: 'INTERNAL', message: 'Runtime 未初始化' } };
  const q = query && typeof query === 'object' ? query : {};
  try {
    const data = runtimeSvc.read({
      afterSeq: Number.isInteger(q.afterSeq) ? q.afterSeq : 0,
      limit: Number.isInteger(q.limit) ? q.limit : 500,
      runId: typeof q.runId === 'string' ? q.runId : undefined,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: { code: 'STORAGE_ERROR', message: err?.message || String(err) } };
  }
});

function runtimeCall(handler) {
  if (!runtimeSvc) return { ok: false, error: { code: 'INTERNAL', message: 'Runtime 未初始化' } };
  return handler(runtimeSvc);
}

ipcMain.handle('runtime:tasks:create', (_event, input) => runtimeCall((rt) => rt.createTask(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:agents:list', () => runtimeCall((rt) => rt.listAgents()));
ipcMain.handle('runtime:agents:get', (_event, agentId) => runtimeCall((rt) => rt.getAgent(agentId)));
ipcMain.handle('runtime:agents:create-version', (_event, input) => runtimeCall((rt) => rt.createAgentVersion(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:agents:create', (_event, input) => runtimeCall((rt) => rt.createAgent(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:agents:update', (_event, input) => runtimeCall((rt) => rt.updateAgent(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:agents:archive', (_event, agentId) => runtimeCall((rt) => rt.archiveAgent(agentId)));
ipcMain.handle('runtime:projects:ensure', (_event, input) => runtimeCall((rt) => rt.ensureProject(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:projects:list', () => runtimeCall((rt) => rt.listProjects()));
ipcMain.handle('runtime:projects:get', (_event, projectId) => runtimeCall((rt) => rt.getProject(projectId)));
ipcMain.handle('runtime:projects:update', (_event, input) => runtimeCall((rt) => rt.updateProject(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:delegations:list', (_event, query) => runtimeCall((rt) => rt.listDelegations(query && typeof query === 'object' ? query : {})));
ipcMain.handle('runtime:delegations:get', (_event, delegationId) => runtimeCall((rt) => rt.getDelegation(delegationId)));
ipcMain.handle('runtime:providers:list', () => runtimeCall((rt) => rt.listProviders()));
ipcMain.handle('runtime:tasks:list', (_event, query) => runtimeCall((rt) => rt.listTasks(query && typeof query === 'object' ? query : {})));
ipcMain.handle('runtime:tasks:get', (_event, taskId) => runtimeCall((rt) => rt.getTask(taskId)));
ipcMain.handle('runtime:tasks:cancel', (_event, input) => runtimeCall((rt) => rt.cancelTask(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:tasks:pause', (_event, input) => runtimeCall((rt) => rt.pauseTask(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:tasks:resume', (_event, input) => runtimeCall((rt) => rt.resumeTask(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:settings:get', () => runtimeCall((rt) => rt.getSettings()));
ipcMain.handle('runtime:settings:set', (_event, input) => runtimeCall((rt) => rt.setSettings(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:runs:get', (_event, runId) => runtimeCall((rt) => rt.getRun(runId)));
ipcMain.handle('runtime:runs:graph', (_event, input) => runtimeCall((rt) => rt.runGraph(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:runs:begin-step', (_event, input) => runtimeCall((rt) => rt.beginStep(input)));
ipcMain.handle('runtime:runs:finish-step', (_event, input) => runtimeCall((rt) => rt.finishStep(input)));
ipcMain.handle('runtime:runs:model-start', (_event, input) => runtimeCall((rt) => rt.modelStart(input)));
ipcMain.handle('runtime:runs:model-finish', (_event, input) => runtimeCall((rt) => rt.modelFinish(input)));
ipcMain.handle('runtime:runs:finish', (_event, input) => runtimeCall((rt) => rt.finishRun(input)));
ipcMain.handle('runtime:tools:propose', (_event, input) => runtimeCall((rt) => rt.proposeTool(input)));
ipcMain.handle('runtime:tools:execute', (_event, input) => runtimeCall((rt) => rt.executeTool(input)));
ipcMain.handle('runtime:tools:reconcile', (_event, input) => runtimeCall((rt) => rt.reconcileTool(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:approvals:list', (_event, query) => runtimeCall((rt) => rt.listApprovals(query && typeof query === 'object' ? query : {})));
ipcMain.handle('runtime:approvals:decide', (_event, input) => runtimeCall((rt) => rt.decideApproval(input && typeof input === 'object' ? input : {})));
ipcMain.handle('runtime:audit:read', (_event, query) => runtimeCall((rt) => rt.auditRead(query && typeof query === 'object' ? query : {})));
ipcMain.handle('runtime:audit:verify', () => runtimeCall((rt) => rt.auditVerify()));

/* ---------------- 本地凭据库（safeStorage） ---------------- */

function vaultPath() {
  return path.join(app.getPath('userData'), 'secrets', 'profiles.bin');
}

ipcMain.handle('secrets:profiles:get', async () => {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    return { ok: false, error: { code: 'UNSUPPORTED', message: '系统凭据加密不可用' } };
  }
  try {
    const encrypted = fs.readFileSync(vaultPath());
    const { result } = await safeStorage.decryptStringAsync(encrypted);
    const data = JSON.parse(result);
    if (!data || !Array.isArray(data.profiles)) return { ok: true, data: null };
    // 明文只留在主进程内存；发往渲染层前统一转掩码视图，任何路径都不回传明文 key
    profileKeyById = secretMask.buildProfileKeyMap(data.profiles);
    return { ok: true, data: secretMask.maskProfilesData(data) };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, data: null };
    console.log('[vault] 读取失败：', err?.message || err);
    return { ok: false, error: { code: 'STORAGE_ERROR', message: err?.message || String(err) } };
  }
});

ipcMain.handle('secrets:profiles:set', async (_event, payload) => {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    return { ok: false, error: { code: 'UNSUPPORTED', message: '系统凭据加密不可用' } };
  }
  try {
    const incoming = payload && typeof payload === 'object' ? payload : {};
    if (Array.isArray(incoming.profiles)) {
      // 迁移期渲染层可能把 get 返回的掩码值原样传回：先用内存里的真实 key 还原，
      // 避免掩码覆盖凭据库里的明文；然后据此刷新主进程持有的真实 key 表。
      incoming.profiles = secretMask.restoreMaskedProfileKeys(incoming.profiles, profileKeyById);
      profileKeyById = secretMask.buildProfileKeyMap(incoming.profiles);
    }
    const json = JSON.stringify(incoming);
    if (json.length > 1024 * 1024) return { ok: false, error: { code: 'TOO_LARGE', message: '凭据数据过大' } };
    fs.mkdirSync(path.dirname(vaultPath()), { recursive: true });
    const enc = await safeStorage.encryptStringAsync(json);
    const tmp = vaultPath() + '.tmp';
    fs.writeFileSync(tmp, enc);
    fs.renameSync(tmp, vaultPath());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: { code: 'STORAGE_ERROR', message: err?.message || String(err) } };
  }
});

/* ---------------- 请求基础设施 ---------------- */

function normalizeBase(raw) {
  const value = String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
  if (!value) throw new Error('请填写 API 地址');
  if (/\s/.test(value)) throw new Error('API 地址不能包含空格');
  if (value.includes('://') && !/^https?:\/\//i.test(value)) throw new Error('API 地址只支持 http/https');
  const withScheme = /^https?:\/\//i.test(value) ? value : 'https://' + value;
  let u;
  try { u = new URL(withScheme); } catch { throw new Error('API 地址不是合法 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('API 地址只支持 http/https');
  if (!u.hostname || !/^[a-z0-9.\-:\[\]]+$/i.test(u.hostname)) throw new Error('API 地址主机名不合法');
  // http 明文会以 Bearer 发送 API Key，只允许本机回环地址使用 http
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
  if (u.protocol === 'http:' && !loopback) {
    throw new Error('非本机地址必须使用 https（API Key 会明文传输）');
  }
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/v1';
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function validateModel(model) {
  const value = String(model == null ? '' : model).trim();
  if (!value) return '请选择模型';
  if (!MODEL_PATTERN.test(value)) return `模型名不合法：${value.slice(0, 60)}`;
  return null;
}

function validateCfg(cfg) {
  if (!cfg || typeof cfg !== 'object') return '连接配置为空';
  try { normalizeBase(cfg.baseUrl); } catch (err) { return err.message; }
  if (!String(cfg.key || '').trim()) return '请填写 API Key';
  const modelErr = validateModel(cfg.model);
  if (modelErr) return modelErr;
  return null;
}

/**
 * 把渲染层传入的 cfg 解析成「可直接使用」的版本：
 * profileId 命中主进程内存表就用真实 key 覆盖；掩码值反查不到时抛错，
 * 因为掩码一定不是真 key，发上游只会得到 401。
 */
function resolveCfgKey(cfg) {
  const resolved = secretMask.resolveProfileKey(cfg, profileKeyById);
  if (!resolved.ok) throw new Error(resolved.message);
  return { ...(cfg && typeof cfg === 'object' ? cfg : {}), key: resolved.key };
}

function apiHeaders(cfg) {
  return {
    authorization: `Bearer ${String(cfg.key).trim()}`,
    accept: 'application/json, text/event-stream',
    'user-agent': 'DSH-Desktop/0.1',
  };
}

function extractServerMessage(text) {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.message ?? j?.error ?? '';
    return typeof m === 'string' ? m : JSON.stringify(m);
  } catch {
    return String(text).replace(/\s+/g, ' ').trim();
  }
}

function classifyHttp(status, text) {
  const labels = {
    400: '请求参数有误（400）', 401: 'API Key 无效或已过期（401）',
    403: '无权访问该模型（403）', 404: '接口不存在（404）',
    405: '接口不支持该方法（405）', 408: '请求超时（408）',
    409: '请求冲突（409）', 413: '请求体过大（413）', 422: '请求内容不合规（422）',
    429: '请求过于频繁或额度不足（429）',
    500: '服务端错误（500）', 502: '网关错误（502）',
    503: '服务暂不可用（503）', 504: '网关超时（504）',
    522: '源站连接超时（522）', 524: '源站响应超时（524）', 529: '服务过载（529）',
  };
  const detail = extractServerMessage(text).slice(0, 180);
  return {
    code: String(status),
    message: `${labels[status] || `HTTP ${status}`}${detail ? '：' + detail : ''}`,
    retryable: retry.isRetryableStatus(status),
  };
}

/** 子 Agent 的非流式模型调用：由 Runtime 委派执行器注入，密钥只在内存中使用。 */
async function delegationModelRequest({ cfg, messages, tools, timeoutMs } = {}) {
  const base = normalizeBase(cfg.baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Math.min(Number(timeoutMs) || 120000, 180000)));
  try {
    const body = {
      model: String(cfg.model).trim(),
      messages: sanitizeMessages(Array.isArray(messages) ? messages : []),
      stream: false,
    };
    const specs = sanitizeTools(tools);
    if (specs?.length) {
      body.tools = specs;
      body.tool_choice = 'auto';
    }
    const res = await net.fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { ...apiHeaders(cfg), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const c = classifyHttp(res.status, await res.text().catch(() => ''));
      const err = new Error(scrubSecret(c.message, cfg.key));
      err.code = c.code;
      err.retryable = c.retryable;
      throw err;
    }
    const json = await res.json().catch(() => ({}));
    const choice = json?.choices?.[0] || {};
    const msg = choice.message || {};
    const toolCalls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.filter((t) => t?.function?.name).map((t, i) => ({
        id: String(t.id || `call_child_${i}`),
        type: 'function',
        function: {
          name: String(t.function.name),
          arguments: typeof t.function.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function.arguments || {}),
        },
      }))
      : [];
    return {
      content: typeof msg.content === 'string' ? msg.content : '',
      toolCalls,
      usage: json?.usage && typeof json.usage === 'object' ? json.usage : null,
      finishReason: String(choice.finish_reason || ''),
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeout = new Error('子 Agent 模型请求超时');
      timeout.code = 'TIMEOUT';
      timeout.retryable = true;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function abortError(err, session) {
  if (err?.name === 'AbortError' || session?.aborted) {
    return { code: session?.reason || 'ABORTED', message: '' };
  }
  return { code: 'NETWORK', message: err?.message || String(err) };
}

/** 合并多个 signal（兼容没有 AbortSignal.any 的运行时）。 */
function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const ctrl = new AbortController();
  for (const s of list) {
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

/**
 * 拉取上游模型列表。网关不支持 /models 时返回 NO_MODELS_ENDPOINT，
 * 让渲染层退回「手填模型名」，而不是把整块配置判死。
 */
async function fetchModels(base, cfg, opts = {}) {
  const maxAttempts = Math.max(1, Math.min(3, Number(opts.maxAttempts) || 2));
  const retryOpts = retry.normalizeOptions(opts.retry);
  let last = null;

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
    try {
      const res = await net.fetch(base + '/models', { headers: apiHeaders(cfg), signal: ctrl.signal });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 404 || res.status === 405) {
          return { ok: false, code: 'NO_MODELS_ENDPOINT', error: '该端点没有 /models 接口，请手动填写模型名' };
        }
        const c = classifyHttp(res.status, text);
        last = { ok: false, code: c.code, error: scrubSecret(c.message, cfg.key), retryable: c.retryable };
        if (!c.retryable || attemptNo === maxAttempts) return { ...last, attempts: attemptNo };
        await retry.sleep(retry.nextDelay({ attempt: attemptNo, headers: res.headers, opts: retryOpts }), ctrl.signal);
        continue;
      }

      let body = null;
      try { body = await res.json(); } catch { body = null; }
      const raw = Array.isArray(body?.data) ? body.data
        : Array.isArray(body?.models) ? body.models
          : Array.isArray(body) ? body : null;
      if (!raw) {
        return { ok: false, code: 'BAD_RESPONSE', error: '模型列表格式无法识别（既不是 {data:[…]} 也不是数组）' };
      }

      const seen = new Set();
      const models = [];
      for (const item of raw) {
        const id = typeof item === 'string' ? item : String(item?.id ?? item?.name ?? '');
        if (!id || seen.has(id)) continue;
        if (validateModel(id)) continue;
        seen.add(id);
        const entry = { id };
        if (item && typeof item === 'object') {
          const owner = item.owned_by ?? item.owner ?? item.provider;
          if (typeof owner === 'string' && owner) entry.owner = owner;
          const created = Number(item.created);
          if (Number.isFinite(created) && created > 0) entry.created = created * (created > 1e12 ? 1 : 1000);
          const ctx = Number(item.context_window ?? item.context_length ?? item.contextWindow);
          if (Number.isFinite(ctx) && ctx > 0) entry.context = ctx;
        }
        models.push(entry);
        if (models.length >= MAX_MODELS) break;
      }
      models.sort((a, b) => a.id.localeCompare(b.id));

      return {
        ok: true,
        models,
        count: models.length,
        hasDefault: models.some((m) => m.id === DEFAULT_MODEL),
        detail: models.length ? `共 ${models.length} 个可用模型` : '端点未返回任何模型',
        attempts: attemptNo,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        return { ok: false, code: 'TIMEOUT', error: `连接超时（${CONNECT_TIMEOUT_MS / 1000} 秒）` };
      }
      const retryable = retry.isRetryableNetworkError(err);
      last = { ok: false, code: 'NETWORK', error: scrubSecret(err?.message || String(err), cfg.key), retryable };
      if (!retryable || attemptNo === maxAttempts) return { ...last, attempts: attemptNo };
      await retry.sleep(retry.backoffDelay(attemptNo, retryOpts));
    } finally {
      clearTimeout(timer);
    }
  }
  return last || { ok: false, code: 'UNKNOWN', error: '未知错误' };
}

/* ---------------- 模型列表 / 探活 ---------------- */

ipcMain.handle('model:list', async (_event, rawCfg) => {
  let cfg;
  try { cfg = resolveCfgKey(rawCfg); } catch (err) {
    return { ok: false, code: 'BAD_CONFIG', error: err?.message || String(err) };
  }
  const invalid = validateCfg(cfg);
  if (invalid) return { ok: false, code: 'BAD_CONFIG', error: invalid };
  let base;
  try { base = normalizeBase(cfg.baseUrl); } catch (err) { return { ok: false, code: 'BAD_CONFIG', error: err.message }; }
  return fetchModels(base, cfg);
});

ipcMain.handle('model:test', async (_event, rawCfg) => {
  let cfg;
  try { cfg = resolveCfgKey(rawCfg); } catch (err) {
    return { ok: false, code: 'BAD_CONFIG', error: err?.message || String(err) };
  }
  const invalid = validateCfg(cfg);
  if (invalid) return { ok: false, code: 'BAD_CONFIG', error: invalid };

  let base;
  try { base = normalizeBase(cfg.baseUrl); } catch (err) { return { ok: false, code: 'BAD_CONFIG', error: err.message }; }

  const listed = await fetchModels(base, cfg);
  if (listed.ok) {
    const target = String(cfg.model || '').trim();
    const present = listed.models.some((m) => m.id === target);
    return {
      ok: true,
      model: target,
      models: listed.models,
      present,
      detail: present
        ? `接口可达，共 ${listed.count} 个模型，${target} 可用`
        : `接口可达，共 ${listed.count} 个模型；当前选的 ${target} 不在列表里`,
    };
  }
  // /models 不通就直接做一次 1-token 真实对话，验证鉴权与模型
  if (listed.code !== 'NO_MODELS_ENDPOINT') {
    return { ok: false, code: listed.code, error: listed.error, retryable: listed.retryable };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  try {
    const r = await net.fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { ...apiHeaders(cfg), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: String(cfg.model).trim(),
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const c = classifyHttp(r.status, await r.text().catch(() => ''));
      return { ok: false, code: c.code, error: c.message, retryable: c.retryable };
    }
    return { ok: true, model: String(cfg.model).trim(), models: [], detail: `接口可达（无 /models），${String(cfg.model).trim()} 对话测试通过` };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, code: 'TIMEOUT', error: `连接超时（${CONNECT_TIMEOUT_MS / 1000} 秒）` };
    return { ok: false, code: 'NETWORK', error: scrubSecret(err?.message || String(err), cfg.key), retryable: retry.isRetryableNetworkError(err) };
  } finally {
    clearTimeout(timer);
  }
});

/* ---------------- 对话 ---------------- */

function validateChatArgs(payload) {
  if (!payload || typeof payload !== 'object') return '请求参数为空';
  if (typeof payload.id !== 'string' || !payload.id) return '缺少回合 id';
  if (activeChats.has(payload.id)) return '回合 id 重复';
  const invalid = validateCfg(payload.cfg);
  if (invalid) return invalid;
  const msgs = payload.messages;
  if (!Array.isArray(msgs) || !msgs.length) return '消息列表为空';
  if (msgs.length > 80) return `消息条数过多（${msgs.length} > 80）`;
  let total = 0;
  let hasUser = false;
  for (const [i, m] of msgs.entries()) {
    if (!m || typeof m !== 'object') return `第 ${i + 1} 条消息不是对象`;
    const role = String(m.role || '');
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) return `第 ${i + 1} 条消息角色非法：${role}`;
    if (role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) return `第 ${i + 1} 条工具消息缺少 tool_call_id`;
      if (typeof m.content !== 'string') return `第 ${i + 1} 条工具消息内容不是文本`;
    } else if (typeof m.content !== 'string' && !(role === 'assistant' && Array.isArray(m.tool_calls))) {
      return `第 ${i + 1} 条消息内容不是文本`;
    }
    if (role === 'assistant' && m.tool_calls != null) {
      if (!Array.isArray(m.tool_calls) || m.tool_calls.length > 24) return `第 ${i + 1} 条消息的 tool_calls 非法`;
      for (const [j, call] of m.tool_calls.entries()) {
        if (!call || typeof call !== 'object') return `第 ${i + 1} 条消息第 ${j + 1} 个工具调用不是对象`;
        if (typeof call.id !== 'string' || !call.id) return `第 ${i + 1} 条消息第 ${j + 1} 个工具调用缺少 id`;
        const name = call.function?.name;
        if (typeof name !== 'string' || !MODEL_PATTERN.test(name)) {
          return `第 ${i + 1} 条消息第 ${j + 1} 个工具名非法`;
        }
        if (typeof call.function?.arguments !== 'string') {
          return `第 ${i + 1} 条消息第 ${j + 1} 个工具参数不是字符串`;
        }
      }
    }
    total += typeof m.content === 'string' ? m.content.length : 0;
    if (role === 'user') hasUser = true;
  }
  if (!hasUser) return '消息列表里没有用户消息';
  if (total > MAX_INPUT_CHARS) return `上下文过长（${total} > ${MAX_INPUT_CHARS} 字符）`;
  if (payload.tools != null) {
    const tools = payload.tools;
    if (!Array.isArray(tools) || tools.length > 24) return '工具列表非法';
    for (const [i, tool] of tools.entries()) {
      if (!tool || typeof tool !== 'object' || tool.type !== 'function') return `第 ${i + 1} 个工具定义非法`;
      const fn = tool.function;
      if (!fn || typeof fn !== 'object') return `第 ${i + 1} 个工具缺少 function`;
      if (typeof fn.name !== 'string' || !MODEL_PATTERN.test(fn.name)) return `第 ${i + 1} 个工具名非法`;
      if (typeof fn.description !== 'string' || fn.description.length > 2000) return `第 ${i + 1} 个工具描述非法`;
      if (!fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)) {
        return `第 ${i + 1} 个工具的 parameters 非法`;
      }
    }
  }
  return null;
}

/** 只向上游传协议允许的字段，避免渲染层混入任意属性。 */
function sanitizeMessages(msgs) {
  return msgs.slice(-80).map((m) => {
    const role = String(m.role);
    if (role === 'tool') {
      return { role: 'tool', tool_call_id: String(m.tool_call_id), content: String(m.content ?? '') };
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      return {
        role: 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
        tool_calls: m.tool_calls.slice(0, 24).map((call) => ({
          id: String(call.id),
          type: 'function',
          function: {
            name: String(call.function.name),
            arguments: String(call.function.arguments ?? '{}'),
          },
        })),
      };
    }
    return { role, content: typeof m.content === 'string' ? m.content : '' };
  });
}

function sanitizeTools(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.slice(0, 24).map((tool) => ({
    type: 'function',
    function: {
      name: String(tool.function.name),
      description: String(tool.function.description || ''),
      parameters: tool.function.parameters,
    },
  }));
}


/** SSE 事件块解析：按空行分块，块内多行 data 拼接，兼容 CRLF / 心跳 / [DONE] / tool_calls */
function parseSseBlock(block, onDelta, onUsage, onToolDelta) {
  const lines = block.split(/\r?\n/);
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;         // 注释 / 心跳
    if (line.startsWith('event:')) continue;
    if (!line.startsWith('data:')) continue;
    data.push(line.slice(5).trimStart());
  }
  if (!data.length) return false;
  const payload = data.join('\n').trim();
  if (payload === '[DONE]') return true;
  let j;
  try { j = JSON.parse(payload); } catch { return false; }  // 畸形帧跳过
  if (j?.usage && typeof j.usage === 'object') onUsage(j.usage);
  const choice = j?.choices?.[0];
  const delta = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? '';
  if (typeof delta === 'string' && delta) onDelta(delta);
  else if (Array.isArray(delta)) {
    for (const part of delta) if (part && typeof part.text === 'string') onDelta(part.text);
  }

  // 流式工具调用：每个 chunk 只带片段，index 标识同一次调用；部分网关一次性放在 message 里。
  const calls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
  if (Array.isArray(calls)) {
    for (let i = 0; i < calls.length; i++) onToolDelta(calls[i], i);
  } else if (choice?.delta?.function_call) {
    onToolDelta({ index: 0, function: choice.delta.function_call }, 0);
  }

  if (j?.error) {
    const msg = typeof j.error === 'string' ? j.error : (j.error.message || '流式响应返回错误');
    const err = new Error(msg);
    err.serverError = true;
    throw err;
  }
  // finish_reason 不代表传输结束：usage 帧可能在其后，只有 [DONE] 或流自然结束才收尾。
  return false;
}

class ChatError extends Error {
  constructor(code, message, retryable = false) {
    super(message || code);
    this.name = 'ChatError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = null;
  }
}

/** 流式对话：id 路由 + 可中断 + 自动重试 + 双重超时 + 输出上限 + 完整错误分类 */
ipcMain.on('model:chat', (event, rawPayload) => {
  // 先按 profileId 解析真实 key：后续校验、脱敏、上游请求都用解析后的 cfg。
  // 解析失败（掩码反查不到）保持原 payload，让下面的错误路径给出明确提示。
  let payload = rawPayload;
  let resolveError = null;
  if (rawPayload && typeof rawPayload === 'object' && rawPayload.cfg && typeof rawPayload.cfg === 'object') {
    try {
      payload = { ...rawPayload, cfg: resolveCfgKey(rawPayload.cfg) };
    } catch (err) {
      resolveError = err;
    }
  }

  const send = (type, extra = {}) => {
    const safe = { ...extra };
    if (typeof safe.message === 'string') safe.message = scrubSecret(safe.message, payload?.cfg?.key);
    if (!event.sender.isDestroyed()) event.sender.send('model:event', { id: payload?.id, type, ...safe });
  };

  if (resolveError) {
    send('error', { code: 'BAD_CONFIG', message: resolveError.message });
    send('done', { aborted: true, code: 'BAD_CONFIG' });
    return;
  }

  const bad = validateChatArgs(payload);
  if (bad) {
    send('error', { code: 'BAD_ARGS', message: bad });
    send('done', { aborted: true, code: 'BAD_ARGS' });
    return;
  }

  const { id, cfg } = payload;
  const messages = sanitizeMessages(payload.messages);
  const tools = sanitizeTools(payload.tools);
  let base;
  try { base = normalizeBase(cfg.baseUrl); } catch (err) {
    send('error', { code: 'BAD_CONFIG', message: err.message });
    send('done', { aborted: true, code: 'BAD_CONFIG' });
    return;
  }

  const retryOpts = retry.normalizeOptions(cfg.retry);
  const model = String(cfg.model).trim();
  const startedAt = Date.now();

  const session = {
    lifeCtrl: new AbortController(),
    ctrl: null,
    cancelBody: null,
    aborted: false,
    reason: null,
    idle: false,
    hard: false,
    connectTimeout: false,
    toolCalls: null,
  };
  activeChats.set(id, session);

  let produced = 0;
  let totalChars = 0;
  let usage = null;
  let finished = false;
  let attempts = 0;
  let retries = 0;

  const finish = (extra = {}) => {
    if (finished) return;
    finished = true;
    try { session.cancelBody?.(); } catch { /* 已关闭 */ }
    activeChats.delete(id);
    if (usage) send('usage', { usage });
    const done = {
      aborted: session.aborted,
      reason: session.reason,
      attempts,
      retries: Math.max(retries, Math.max(0, attempts - 1)),
      toolCalls: session.toolCalls || [],
      ...extra,
    };
    send('done', done);
  };
  session.finish = finish;

  /** 单次尝试。成功 return；失败 throw ChatError。 */
  const runAttempt = async (attemptNo) => {
    const ctrl = new AbortController();
    session.ctrl = ctrl;
    session.idle = false;
    session.hard = false;
    session.connectTimeout = false;
    session.toolCalls = null;

    // 工具调用是分片到达的：按 index 合并 id / name / arguments。
    const toolSlots = new Map();
    const mergeToolCall = (call, fallbackIndex) => {
      if (!call || typeof call !== 'object') return;
      const rawIndex = Number.isInteger(call.index) ? call.index : fallbackIndex;
      const index = Number.isInteger(rawIndex) ? rawIndex : toolSlots.size;
      let slot = toolSlots.get(index);
      if (!slot) {
        slot = { id: '', name: '', arguments: '' };
        toolSlots.set(index, slot);
      }
      if (typeof call.id === 'string' && call.id) slot.id = call.id;
      const fn = call.function || {};
      if (typeof fn.name === 'string' && fn.name && !slot.name) slot.name = fn.name;
      if (typeof fn.arguments === 'string') slot.arguments += fn.arguments;
    };
    const collectToolCalls = () => {
      const out = [];
      for (const [index, slot] of [...toolSlots.entries()].sort((a, b) => a[0] - b[0])) {
        if (!slot.name) continue;
        out.push({
          id: slot.id || `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: { name: slot.name, arguments: slot.arguments || '{}' },
        });
      }
      return out;
    };

    let idleTimer = null;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        session.idle = true;
        try { session.cancelBody?.(); } catch { /* 已关闭 */ }
        ctrl.abort();
      }, IDLE_TIMEOUT_MS);
    };
    const budget = Math.max(5000, HARD_TIMEOUT_MS - (Date.now() - startedAt));
    const hardTimer = setTimeout(() => {
      session.hard = true;
      try { session.cancelBody?.(); } catch { /* 已关闭 */ }
      ctrl.abort();
    }, budget);
    // 建连超时：只负责「响应头迟迟不来」。地址黑洞（SYN 被丢弃）时 15 秒失败，
    // 不必干等到 45 秒的空闲超时。拿到响应头即清除。
    let connectTimer = null;
    const clearConnect = () => { if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; } };
    const stopTimers = () => { clearTimeout(idleTimer); clearTimeout(hardTimer); clearConnect(); };

    const emitDelta = (text) => {
      if (session.aborted) return;
      totalChars += text.length;
      if (totalChars > MAX_OUTPUT_CHARS) {
        session.reason = 'OUTPUT_LIMIT';
        session.aborted = true;
        try { session.cancelBody?.(); } catch { /* 已关闭 */ }
        ctrl.abort();
        return;
      }
      produced += text.length;
      armIdle();
      send('chunk', { text });
    };

    const signal = anySignal([session.lifeCtrl.signal, ctrl.signal]);

    try {
      armIdle();
      connectTimer = setTimeout(() => {
        session.connectTimeout = true;
        try { session.cancelBody?.(); } catch { /* 已关闭 */ }
        ctrl.abort();
      }, Math.min(CONNECT_TIMEOUT_MS, budget));
      const requestBody = { model, messages, stream: true, temperature: 0.7 };
      if (tools && tools.length) {
        requestBody.tools = tools;
        requestBody.tool_choice = 'auto';
      }
      const res = await net.fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { ...apiHeaders(cfg), 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal,
      });
      clearConnect();

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const c = classifyHttp(res.status, text);
        const err = new ChatError(c.code, c.message, c.retryable);
        err.retryAfterMs = retry.parseRetryAfter(res.headers);
        throw err;
      }

      const ctype = String(res.headers.get('content-type') || '').toLowerCase();

      if (!ctype.includes('text/event-stream')) {
        // 部分网关忽略 stream:true，直接返回完整 JSON
        const raw = await res.text().catch(() => '');
        let body = null;
        try { body = JSON.parse(raw); } catch { /* 落到下方统一报错 */ }
        const message = body?.choices?.[0]?.message;
        const content = message?.content ?? body?.choices?.[0]?.text;
        if (body?.usage) usage = body.usage;
        if (Array.isArray(message?.tool_calls)) {
          for (let i = 0; i < message.tool_calls.length; i++) mergeToolCall(message.tool_calls[i], i);
        }
        const calls = collectToolCalls();
        if (typeof content === 'string' && content) emitDelta(content);
        if ((typeof content === 'string' && content) || calls.length) {
          session.toolCalls = calls;
          return;
        }
        if (body?.error) {
          const msg = extractServerMessage(raw);
          throw new ChatError('API_ERROR', msg || '接口返回错误', produced === 0);
        }
        throw new ChatError(
          'BAD_RESPONSE',
          `响应既不是 SSE 也不是可解析的对话 JSON（content-type: ${ctype || '未知'}）`,
          false,
        );
      }

      if (!res.body) throw new ChatError('BAD_RESPONSE', '流式响应体为空', true);

      const decoder = new TextDecoder();
      let buf = '';
      let sawDone = false;
      let streamError = null;

      const handleBlock = (block) => {
        try {
          if (parseSseBlock(block, emitDelta, (u) => { usage = u; }, mergeToolCall)) sawDone = true;
        } catch (err) {
          streamError = err;
          sawDone = true;
        }
      };

      const feed = (chunk) => {
        // 收到任何字节（哪怕只是心跳/注释行）都证明连接还活着，必须重置空闲计时。
        // 上游可能在首个 token 前连发几十秒 keep-alive，此时不能判成卡死。
        armIdle();
        buf += decoder.decode(chunk, { stream: true });
        const sep = /\r?\n\r?\n/;
        let idx;
        while ((idx = buf.search(sep)) >= 0) {
          const matched = buf.match(sep)[0];
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + matched.length);
          if (block.trim()) handleBlock(block);
          if (sawDone || streamError) return;
        }
      };

      if (typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        session.cancelBody = () => { try { reader.cancel(); } catch { /* 已关闭 */ } };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          feed(value);
          if (sawDone || streamError || session.aborted) break;
        }
      } else if (typeof res.body[Symbol.asyncIterator] === 'function') {
        for await (const value of res.body) {
          feed(value);
          if (sawDone || streamError || session.aborted) break;
        }
      } else {
        throw new ChatError('BAD_RESPONSE', '响应体不可读', true);
      }

      if (streamError) {
        throw new ChatError('STREAM_ERROR', streamError.message || String(streamError), produced === 0);
      }
      if (session.aborted) return;   // 交给外层按 reason 收尾
      if (!sawDone && buf.trim()) handleBlock(buf);
      if (streamError) {
        throw new ChatError('STREAM_ERROR', streamError.message || String(streamError), produced === 0);
      }
      const calls = collectToolCalls();
      session.toolCalls = calls;
      if (produced === 0 && !calls.length) {
        throw new ChatError('EMPTY_OUTPUT', '模型未返回任何正文（可能触发了内容过滤或模型不可用）', attemptNo < 2);
      }
    } finally {
      stopTimers();
    }
  };

  (async () => {
    for (let attemptNo = 1; attemptNo <= retryOpts.maxAttempts; attemptNo++) {
      attempts = attemptNo;
      let failure = null;

      try {
        await runAttempt(attemptNo);
        if (session.aborted) break;
        finish();
        return;
      } catch (err) {
        if (session.aborted) break;
        if (session.hard) failure = new ChatError('HARD_TIMEOUT', `${HARD_TIMEOUT_MS / 1000} 秒总时限已到，已中止`, false);
        else if (session.connectTimeout) failure = new ChatError('CONNECT_TIMEOUT', `连接超时（${CONNECT_TIMEOUT_MS / 1000} 秒内未拿到响应头）`, produced === 0);
        else if (session.idle) failure = new ChatError('IDLE_TIMEOUT', `${IDLE_TIMEOUT_MS / 1000} 秒未收到数据，已中止`, produced === 0);
        else if (err instanceof ChatError) failure = err;
        else if (err?.name === 'AbortError') failure = new ChatError('ABORTED', '请求被中止', produced === 0);
        else if (retry.isRetryableNetworkError(err)) failure = new ChatError('NETWORK', err?.message || String(err), true);
        else failure = new ChatError('NETWORK', err?.message || String(err), false);
      }

      const canRetry = failure.retryable && attemptNo < retryOpts.maxAttempts && produced === 0 && !session.aborted;
      if (!canRetry) {
        send('error', {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          attempts: attemptNo,
          retries: attemptNo - 1,
        });
        finish({ code: failure.code });
        return;
      }

      const delayMs = failure.retryAfterMs != null
        ? Math.min(failure.retryAfterMs, Math.max(retryOpts.maxDelayMs, 60000))
        : retry.backoffDelay(attemptNo, retryOpts);

      retries = attemptNo;
      send('retry', {
        attempt: attemptNo,
        nextAttempt: attemptNo + 1,
        maxAttempts: retryOpts.maxAttempts,
        delayMs,
        code: failure.code,
        message: failure.message,
      });

      try {
        await retry.sleep(delayMs, session.lifeCtrl.signal);
      } catch {
        finish({ code: 'USER_ABORT' });
        return;
      }
      if (session.aborted) break;
    }

    // 只有用户主动中断 / 输出超限会走到这里
    const reason = session.reason || 'USER_ABORT';
    const messagesByReason = {
      OUTPUT_LIMIT: '输出超过上限，已中止',
      USER_ABORT: '',
    };
    const text = messagesByReason[reason] ?? '';
    if (text) send('error', { code: reason, message: text });
    finish({ code: reason });
  })().catch((err) => {
    if (finished) return;
    send('error', { code: 'INTERNAL', message: err?.message || String(err) });
    finish({ code: 'INTERNAL' });
  });
});

function forceAbort(s) {
  if (!s || s.aborted) return;
  s.aborted = true;
  s.reason = 'USER_ABORT';
  try { s.cancelBody?.(); } catch { /* 流已关闭 */ }
  try { s.ctrl?.abort(); } catch { /* 无当前连接 */ }
  try { s.lifeCtrl?.abort(); } catch { /* 已中止 */ }
  // 立即回执，不依赖被取消的流自己走到收尾逻辑
  s.finish?.({ code: 'USER_ABORT' });
}

ipcMain.on('model:abort', (_event, id) => forceAbort(activeChats.get(id)));

ipcMain.on('model:abort-all', () => {
  for (const s of [...activeChats.values()]) forceAbort(s);
});

/* ---------------- 本地工具 / 工作目录 ----------------
 * 工具定义与执行都在主进程，渲染层只拿到结果；
 * 是否调用由模型决定，是否需要用户确认由权限级别决定。
 */

ipcMain.handle('tool:specs', () => {
  /* MCP 工具追加进 specs：inputSchema 本身就是 JSON Schema，基本直传。
     policy 无特殊放行：MCP 工具名追加进 needsApproval（与 run_command 同档）。 */
  const mcpEntries = mcpModule.buildToolSpecs(mcpManager.status());
  return {
    ok: true,
    specs: [...localTools.TOOL_SPECS, ...mcpEntries.map((e) => e.spec)],
    meta: localTools.TOOL_META,
    readOnly: [...localTools.READ_ONLY],
    needsApproval: [...localTools.NEEDS_APPROVAL, ...mcpEntries.map((e) => e.fullName)],
  };
});

ipcMain.handle('tool:exec', async (_event, payload) => {
  if (!payload || typeof payload !== 'object') return { ok: false, code: 'BAD_ARGS', error: '工具调用参数为空' };
  const name = String(payload.name || '');
  const args = payload.args;
  const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : {};
  const permission = ['full', 'ask', 'readonly'].includes(opts.permission) ? opts.permission : 'ask';
  return localTools.executeTool(name, args, {
    workspace: typeof opts.workspace === 'string' ? opts.workspace : '',
    permission,
    approved: opts.approved === true,
  });
});

ipcMain.handle('workspace:default', () => app.getPath('documents'));

ipcMain.handle('workspace:pick', async (_event, currentPath) => {
  try {
    const fallback = app.getPath('documents');
    let current = fallback;
    if (typeof currentPath === 'string' && currentPath.trim()) {
      try {
        const resolved = path.resolve(currentPath);
        if (fs.statSync(resolved).isDirectory()) current = resolved;
      } catch { /* 旧目录不存在就退回文档目录 */ }
    }
    const choice = await dialog.showOpenDialog(win || undefined, {
      title: '选择工具工作目录',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (choice.canceled || !choice.filePaths?.length) return { ok: false, canceled: true };
    const picked = path.resolve(choice.filePaths[0]);
    const st = fs.statSync(picked);
    if (!st.isDirectory()) return { ok: false, error: '选择的不是目录' };
    return { ok: true, path: picked };
  } catch (err) {
    return { ok: false, error: `选择目录失败：${err?.message || String(err)}` };
  }
});

/* ---------------- MCP 客户端 ----------------
 * stdio MCP server 的启动/停止/工具发现/调用都在主进程；
 * 配置列表由渲染层 localStorage 传下来，这里只保存内存态。
 * 启动时不自动连接任何 server，全部由用户在设置里手动启动；
 * app 退出时在 before-quit 里统一 stopAll。
 */

/** 单条 MCP 配置的规范化（mcp:servers:set 与 mcp:server:start 共用）。 */
function normalizeMcpConfig(raw, label) {
  if (!raw || typeof raw !== 'object') throw new Error(`${label}不是对象`);
  const id = String(raw.id || '').trim();
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error(`${label}的 id 非法（字母/数字/下划线/中划线，≤64）`);
  const command = String(raw.command || '').trim();
  if (!command) throw new Error(`MCP 配置 ${id} 缺少 command`);
  return {
    id,
    name: String(raw.name || id).trim() || id,
    command,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
      ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [String(k), String(v)]))
      : {},
  };
}

ipcMain.handle('mcp:servers:get', () => ({
  ok: true,
  configs: mcpConfigs,
  servers: mcpManager.status(),
}));

ipcMain.handle('mcp:servers:set', (_event, list) => {
  if (!Array.isArray(list)) return { ok: false, code: 'BAD_ARGS', error: 'MCP 配置必须是数组' };
  const next = [];
  const seen = new Set();
  try {
    for (const [i, raw] of list.entries()) {
      const cfg = normalizeMcpConfig(raw, `第 ${i + 1} 个 MCP 配置`);
      if (seen.has(cfg.id)) return { ok: false, code: 'BAD_ARGS', error: `MCP 配置 id 重复：${cfg.id}` };
      seen.add(cfg.id);
      next.push(cfg);
    }
  } catch (err) {
    return { ok: false, code: 'BAD_ARGS', error: err?.message || String(err) };
  }
  // 配置里被删掉的 server 如果还在运行，顺手停掉，避免游离进程
  const aliveIds = new Set(next.map((c) => c.id));
  for (const s of mcpManager.status()) {
    if (!aliveIds.has(s.id) && s.status !== 'stopped') mcpManager.stopServer(s.id);
  }
  mcpConfigs = next;
  return { ok: true, configs: mcpConfigs };
});

ipcMain.handle('mcp:server:start', async (_event, idOrCfg) => {
  let cfg;
  try {
    if (idOrCfg && typeof idOrCfg === 'object') {
      // 直接传完整配置：规范化后 upsert 进内存配置表
      cfg = normalizeMcpConfig(idOrCfg, 'MCP 配置');
      const idx = mcpConfigs.findIndex((c) => c.id === cfg.id);
      if (idx >= 0) mcpConfigs[idx] = cfg;
      else mcpConfigs.push(cfg);
    } else {
      const id = String(idOrCfg || '').trim();
      cfg = mcpConfigs.find((c) => c.id === id);
      if (!cfg) return { ok: false, code: 'NOT_FOUND', error: `没有这个 MCP 配置：${id}` };
    }
  } catch (err) {
    return { ok: false, code: 'BAD_ARGS', error: err?.message || String(err) };
  }
  return mcpManager.startServer(cfg);
});

ipcMain.handle('mcp:server:stop', (_event, id) => mcpManager.stopServer(String(id || '')));

ipcMain.handle('mcp:tools:list', (_event, serverId) => {
  const servers = mcpManager.status();
  const scoped = serverId ? servers.filter((s) => s.id === String(serverId)) : servers;
  const entries = mcpModule.buildToolSpecs(scoped);
  return {
    ok: true,
    tools: entries.map((e) => ({
      serverId: e.serverId,
      serverName: e.serverName,
      name: e.toolName,
      fullName: e.fullName,
      description: e.description,
      inputSchema: e.inputSchema,
      spec: e.spec,
    })),
  };
});

ipcMain.handle('mcp:tool:call', async (_event, payload) => {
  if (!payload || typeof payload !== 'object') return { ok: false, code: 'BAD_ARGS', error: '参数为空' };
  const serverId = String(payload.serverId || '');
  const name = String(payload.name || '');
  if (!serverId || !name) return { ok: false, code: 'BAD_ARGS', error: '缺少 serverId 或 name' };
  const args = payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : {};
  return mcpManager.callTool(serverId, name, args, payload.timeoutMs);
});

/* ---------------- Skills（技能） ----------------
 * 用户级 = userData/skills，项目级 = workspace/.dsh/skills；
 * 目录不存在就当没有。扫描与读取都在主进程，读取按扫描目录做边界校验。
 */

function skillScanDirs(workspace) {
  const dirs = [{ source: 'user', dir: path.join(app.getPath('userData'), 'skills') }];
  const ws = String(workspace || '').trim();
  if (ws) dirs.push({ source: 'project', dir: path.join(ws, '.dsh', 'skills') });
  return dirs;
}

ipcMain.handle('skills:scan', (_event, payload) => {
  const workspace = payload && typeof payload === 'object' ? payload.workspace : payload;
  try {
    return { ok: true, skills: skillsModule.scanSkills(skillScanDirs(workspace)) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('skills:read', async (_event, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  try {
    return await skillsModule.readSkillFile(skillScanDirs(p.workspace), p.path);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

/* ---------------- 会话导出 ----------------
 * 序列化（Markdown / JSON）在 preload 侧 lib/session-export.js 完成，
 * 这里只负责保存对话框与落盘；无头探针不弹框、不阻塞。
 */

/** 导出文件名清洗：非法字符换成下划线，缺扩展名按 format 补上。 */
function sanitizeExportName(raw, format) {
  let name = String(raw || '').trim() || '会话导出';
  name = name.replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^\.+/, '').trim();
  if (name.length > 80) name = name.slice(0, 80).trim();
  const ext = format === 'json' ? '.json' : '.md';
  if (!name.toLowerCase().endsWith(ext)) name += ext;
  return name;
}

ipcMain.handle('export:session', async (_event, payload) => {
  if (!payload || typeof payload !== 'object') return { ok: false, error: '导出参数为空' };
  const format = payload.format === 'json' ? 'json' : 'md';
  const content = typeof payload.content === 'string' ? payload.content : '';
  if (!content.trim()) return { ok: false, error: '导出内容为空' };
  try {
    const choice = await dialog.showSaveDialog(win || undefined, {
      title: '导出会话',
      defaultPath: sanitizeExportName(payload.defaultName, format),
      filters: format === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    await fs.promises.writeFile(choice.filePath, content, 'utf8');
    return { ok: true, path: choice.filePath };
  } catch (err) {
    return { ok: false, error: `导出失败：${err?.message || String(err)}` };
  }
});

/* ---------------- 自定义视频壁纸 ----------------
 * 视频复制到应用内 assets/，用相对路径加载，符合页面 CSP 的 'self'。
 * 不注册自定义协议，也不做模糊/磨砂处理。
 */

const ASSETS_DIR = path.join(__dirname, 'assets');
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv', '.avi']);
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

function sizeLabel(n) {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

function currentWallpaper() {
  try {
    const file = fs.readdirSync(ASSETS_DIR).find(
      (n) => /^wallpaper\.[a-z0-9]+$/i.test(n) && VIDEO_EXT.has(path.extname(n).toLowerCase())
    );
    if (!file) return null;
    return { file, size: fs.statSync(path.join(ASSETS_DIR, file)).size };
  } catch {
    return null;
  }
}

function removeWallpaperFiles() {
  try {
    for (const n of fs.readdirSync(ASSETS_DIR)) {
      if (/^wallpaper\./i.test(n)) fs.unlinkSync(path.join(ASSETS_DIR, n));
    }
  } catch (err) {
    console.log('[wallpaper] 清理旧文件失败：', err?.message || err);
  }
}

ipcMain.handle('wallpaper:current', () => currentWallpaper());

ipcMain.handle('wallpaper:pick', async () => {
  try {
    const choice = await dialog.showOpenDialog(win || undefined, {
      title: '选择视频壁纸',
      properties: ['openFile'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi'] }],
    });
    if (choice.canceled || !choice.filePaths?.length) return { ok: false, canceled: true };
    const src = choice.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    if (!VIDEO_EXT.has(ext)) return { ok: false, error: `不支持的视频格式：${ext || '未知'}` };
    let stat;
    try { stat = fs.statSync(src); } catch (err) { return { ok: false, error: `无法读取文件：${err.message}` }; }
    if (!stat.isFile()) return { ok: false, error: '选择的不是普通文件' };
    if (stat.size === 0) return { ok: false, error: '视频文件为空' };
    if (stat.size > MAX_VIDEO_BYTES) {
      return { ok: false, error: `视频过大：${sizeLabel(stat.size)}，上限 ${sizeLabel(MAX_VIDEO_BYTES)}` };
    }
    removeWallpaperFiles();
    const file = 'wallpaper' + ext;
    fs.copyFileSync(src, path.join(ASSETS_DIR, file));
    return { ok: true, file, size: stat.size };
  } catch (err) {
    return { ok: false, error: `设置失败：${err?.message || String(err)}` };
  }
});

ipcMain.handle('wallpaper:clear', () => {
  removeWallpaperFiles();
  return { ok: true };
});

module.exports = { DEFAULT_MODEL };
