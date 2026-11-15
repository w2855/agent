'use strict';

const {
  app, BrowserWindow, ipcMain, shell, nativeTheme, net, dialog, safeStorage,
  Notification, Tray, Menu, nativeImage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
// 启动阶段打点：放在所有业务 require 之前，spawn 阶段覆盖整个模块加载（lib/* 的 require 开销也算进去）
const { BootTimer } = require('./lib/boot-timer');
const bootTimer = new BootTimer();
// spawn 起点 = 进程拉起时刻（backdate：main.js 首行执行时 process.uptime 已含 Electron 框架自举耗时）
bootTimer.begin('spawn', Date.now() - Math.round(process.uptime() * 1000));
const retry = require('./lib/retry');
const secretMask = require('./lib/secret-mask');
const notifyDedupe = require('./lib/notify-dedupe');
const guard = require('./lib/instance-guard');
const redact = require('./lib/redact');   // PII 脱敏管线（通知外显 / 会话导出 / 崩溃日志三个出口接入）
const lessons = require('./lib/lessons'); // Doctor 经验库检查（lessons:summary / lessons:tail）
const localTools = require('./lib/tools');
const mcpModule = require('./lib/mcp');
const skillsModule = require('./lib/skills');
const backup = require('./lib/backup');
const persistStoreModule = require('./lib/persist-store');
const userDataPaths = require('./lib/user-data');
const { createAutopilot } = require('./lib/autopilot'); // 无人值守任务推进循环（开关经 IPC 控制）
const { createToolGateway } = require('./lib/tool-gateway'); // 工具治理内核（旧通道 + MCP 旁路统一到同一策略/审批/审计）
const authority = require('./lib/permission-authority'); // 权限档位裁定（请求 vs 权威值，纯函数）
const runtimeModule = require('./runtime');

// 测试模式（--script/--shot）禁用硬件加速：本机 GPU 驱动间歇性导致渲染进程启动即崩
// （Renderer process crashed / GPU process exited），did-finish-load 不触发、脚本永远不跑；
// 该 UI 是纯 DOM/CSS，软件渲染完全够用。日常启动不受影响。
if (process.argv.includes('--script') || process.argv.includes('--shot')) {
  app.disableHardwareAcceleration();
}

// userData 路径统一（决策逻辑见 lib/user-data.js 的 resolveUserDataDir）：
// - 显式 --user-data-dir=X 优先级最高：e2e/探针的隔离测试路径原样生效（沿用原行为）。
// - 无隔离参数时，开发版与打包版强制统一到 %APPDATA%/dsh-desktop，历史/设置/密钥共用一份
//   （打包版 productName "DSH Desktop" 默认落 %APPDATA%/DSH Desktop，两套存储会分裂）。
// 时序关键：下面的 app.setPath 必须先于 requestSingleInstanceLock —— 单实例锁按 userData
// 隔离，先统一路径再拿锁，开发版与打包版才会竞争同一把锁；反过来先拿锁再改路径，
// 两个版本各持一把锁还能同时写同一目录，双开就撞 LevelDB 缓存锁。
const userDataDecision = userDataPaths.resolveUserDataDir(process.argv, app.getPath('appData'));
if (userDataDecision.source === 'flag') {
  // 测试隔离路径：沿用原逻辑，先建目录再指过去
  try {
    fs.mkdirSync(userDataDecision.dir, { recursive: true });
    app.setPath('userData', userDataDecision.dir);
  } catch (err) {
    console.log('[boot] 无法设置 userData 目录：', err?.message || err);
  }
} else {
  // 统一路径：目录由 Electron 按需创建，这里不主动 mkdir
  app.setPath('userData', userDataDecision.dir);
  if (userDataDecision.source === 'legacy') {
    // 只提示、不自动复制：leveldb 在应用运行中被复制容易损坏；手动迁移方法见 docs/e2e-guide.md
    console.log(`[boot] 发现旧打包版数据（${userDataDecision.legacyDir}），可手动迁移：`
      + '关闭应用后把其 Local Storage 目录整体拷贝到统一目录下（见 docs/e2e-guide.md）');
  }
}
// 固定打印生效路径（取 getPath 而非决策值：flag 建目录失败时如实反映回退结果）
console.log('[boot] userData =', app.getPath('userData'));

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
/* 思考内容上限：推理模型的 reasoning_content 可能比正文长一个数量级，
   全量转发只会把渲染层拖慢（而且没人会逐字回看）。超出部分丢弃并标记 truncated。 */
const MAX_REASON_CHARS = 40000;
/* SSE 行缓冲上限（R15/A8）：MAX_OUTPUT_CHARS 只保护「已解析的正文」，
   保护不到尚未出现空行分隔的 buf——异常网关持续发送不含 \n\n 的数据会让它无限增长。 */
const SSE_BUFFER_LIMIT = 4 * 1024 * 1024;
/* 输入字符上限 = 渲染层上下文窗口最大值（1,000,000）+ 系统提示/工具定义/本轮输入余量。
   两处必须一起改，否则设置里允许 100 万、主进程却按旧上限拒收。 */
const MAX_INPUT_CHARS = 1100000;
/* 消息条数的唯一用途是挡住异常输入（渲染层失控时不会把主进程拖死），
   不能当业务限制用：多步工具回合里一条工具结果就是一条消息，真实长任务
   很快超过 80，旧限制会在会话正当进行时把整轮打回「消息条数过多」。
   真正的上下文控制是字符预算（渲染层 dsh.ctxLimit + 自动压缩）。 */
const MAX_INPUT_MESSAGES = 2000;
const MAX_MODELS = 500;

/** @type {BrowserWindow | null} */
let win = null;
/** Runtime 基础服务（Phase 1：事件存储 / Policy / 工具注册表） */
let runtimeSvc = null;
/** Autopilot 实例（懒创建：勾选开关时才注入 taskApi 闭包；状态只存内存，重启即关） */
let autopilot = null;

/** Autopilot 的 runtime 任务 API 适配层：把 runtimeSvc 的 {ok,data} 包装成
 *  lib/autopilot.js 约定的「数据或抛错」契约。queued 任务在 runtime 只能等
 *  调度器 admit（resumeTask 仅支持 paused），因此降级为 waiting 信号而非失败。 */
function ensureAutopilot() {
  if (!autopilot) {
    autopilot = createAutopilot({
      taskApi: {
        listTasks: () => {
          const r = runtimeSvc?.listTasks({ limit: 200 });
          if (!r || r.ok !== true) throw new Error(r?.error?.message || 'listTasks 失败');
          return r.data;
        },
        resumeTask: ({ taskId, reason }) => {
          const r = runtimeSvc?.resumeTask({ taskId, reason });
          if (!r || r.ok !== true) {
            // queued 任务被拒（runtime 只有 paused 可恢复）→ 排队等待调度，不算失败
            if (/已暂停/.test(r?.error?.message || '')) return { waiting: true };
            throw new Error(r?.error?.message || 'resumeTask 失败');
          }
          return r.data;
        },
      },
      notify: (payload) => showOsNotification({ title: payload?.title || 'Autopilot', body: payload?.body || '', tag: 'autopilot' }),
      /* 进度落盘：之前 iteration / lastAdvanced / 连续失败只在内存，重启就从 0 开始，
         任务其实已经推进过多轮。存在 dsh-storage.json 里（与聊天记录同一份真值源）。 */
      loadState: () => {
        try {
          const raw = getStorageStore().get('dsh.autopilot');
          return raw ? JSON.parse(raw) : null;
        } catch { return null; }
      },
      saveState: (snapshot) => {
        try { getStorageStore().set('dsh.autopilot', JSON.stringify(snapshot)); } catch { /* 落盘失败不影响循环 */ }
      },
    });
  }
  return autopilot;
}
/** id -> { lifeCtrl, ctrl, cancelBody, aborted, reason, finish } */
const activeChats = new Map();

/** MCP stdio 客户端管理器（server 的启停/发现/调用都在主进程）。
 *  懒建：非首帧必需项，构建延后到 did-finish-load 之后（runDeferredBootInit 预热）；
 *  渲染层早期 IPC 若先到（tool:specs / mcp:servers:get），此处同步兜底构建——
 *  构建只是闭包 + Map，亚毫秒级，不会拖慢首帧 IPC。 */
let mcpManager = null;
function getMcpManager() {
  if (!mcpManager) mcpManager = mcpModule.createMcpManager();
  return mcpManager;
}
/** MCP server 配置的内存态；持久化由渲染层 localStorage 负责，经 IPC 同步下来 */
let mcpConfigs = [];

/** 主进程持有的真实 API Key（profileId → 明文）。
    任何发回渲染层的路径都只允许掩码：get 转掩码视图，chat/test/list 用这张表还原 key。 */
let profileKeyById = new Map();

/** F2 修复：委派链用的完整连接配置表（profileId → { baseUrl, key }）。
    跨接入点委派时 runtime 需要按 profileId 拿到 baseUrl + key 两者，
    单独一张 key 表不够；与 profileKeyById 同源同生命周期（get/set/懒加载时重建）。 */
let profileCfgById = new Map();
/** 加密凭据库是否已在本次进程内解密过（懒加载只做一次，set 时刷新表并置位）。 */
let vaultLoadedOnce = false;

/** 从 vault 明文 profiles 重建两张内存表；只传 null/undefined 时仅清空。 */
function refreshProfileMaps(profiles) {
  profileKeyById = secretMask.buildProfileKeyMap(profiles || []);
  const cfgMap = new Map();
  if (Array.isArray(profiles)) {
    for (const p of profiles) {
      if (!p || typeof p !== 'object') continue;
      const id = typeof p.id === 'string' ? p.id.trim() : '';
      const key = typeof p.key === 'string' ? p.key : '';
      const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '';
      // 掩码值与空 key 不入库（与 buildProfileKeyMap 口径一致）
      if (!id || !key || secretMask.isMaskedKey(key) || !baseUrl) continue;
      cfgMap.set(id, { baseUrl, key, effort: ['off', 'low', 'medium', 'high'].includes(p.effort) ? p.effort : 'off' });
    }
  }
  profileCfgById = cfgMap;
}

/** 懒加载加密凭据库：profileKeyById 未填充（渲染层尚未触发 secrets:profiles:get）时
    解密一次并缓存，保证委派在任何时刻发生都能解析到明文 key。进程内只解一次。 */
async function ensureVaultProfilesLoaded() {
  if (vaultLoadedOnce) return true;
  try {
    const encrypted = fs.readFileSync(vaultPath());
    const { result } = await safeStorage.decryptStringAsync(encrypted);
    const data = JSON.parse(result);
    if (data && Array.isArray(data.profiles)) refreshProfileMaps(data.profiles);
    vaultLoadedOnce = true;
    return true;
  } catch (err) {
    if (err?.code !== 'ENOENT') console.log('[vault] 懒加载失败：', err?.message || err);
    vaultLoadedOnce = true; // ENOENT（尚无凭据库）与解密失败都置位，避免每次委派重复解密
    return false;
  }
}

/**
 * F2 修复：注入给 runtime 的密钥解析器。
 * 按 profileId 返回完整连接配置 { baseUrl, key }；解析不到返回 null。
 * 先查内存表（secrets:profiles:get/set 维护），未命中时懒加载解密 vault 再查一次。
 */
async function resolveSecretKey(profileId) {
  const id = String(profileId || '').trim();
  if (!id) return null;
  let cfg = profileCfgById.get(id) || null;
  if (!cfg && !vaultLoadedOnce) {
    await ensureVaultProfilesLoaded();
    cfg = profileCfgById.get(id) || null;
  }
  return cfg;
}

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
  resolve: (fullName) => mcpModule.findTool(getMcpManager().status(), fullName),
  call: (serverId, toolName, args) => getMcpManager().callTool(serverId, toolName, args),
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
    // PII 脱敏（profile='standard'，理由：crash-log.jsonl 是落盘诊断数据——日志完整性优先，
    // 走 REDACT 全替换而非 strict 的 BLOCK 档，绝不因命中敏感信息而丢日志）；
    // message/stack 属异常文本，最可能夹带密钥/邮箱，写 jsonl 前先替换。
    fs.writeFileSync(crashLogPath(), guard.appendJsonlEntry(raw, redactCrashEntry(entry)), 'utf8');
  } catch (err) {
    console.log('[crash-log] 写入失败：', err?.message || err);
  }
}

/** 崩溃日志条目脱敏：entry.message/stack 过 redactText(…, 'standard') 后返回新对象（不改原值）。 */
function redactCrashEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  for (const field of ['message', 'stack']) {
    if (typeof out[field] === 'string') out[field] = redact.redactText(out[field], 'standard');
  }
  return out;
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

/* ---------------- P2 启动提速：阶段打点落盘 / 立即显示窗口 ----------------
 * boot 各阶段（spawn→whenReady→createWindow→did-finish-load→renderer-ready）
 * 写入 crash-log.jsonl（type: 'boot-stages'），did-finish-load 时先落部分记录
 * （renderer-ready 为 null），渲染层经 IPC 上报后再补一条 complete: true 的完整记录。
 */

/** 启动窗口底色跟渲染层主题一致防白闪（与渲染层 splash 的约定值）：
 *  深色 #0e1526 / 浅色 #f5f7fb。按 nativeTheme.shouldUseDarkColors 推导——
 *  当前 themeSource 固定 'light'（见文件顶部），未来放开主题跟随系统时无需改这里。 */
function bootBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#0e1526' : '#f5f7fb';
}

/** 落一条 boot-stages 记录（complete=false 为部分记录，renderer-ready 尚未上报）。 */
function writeBootStages(complete) {
  const snap = bootTimer.snapshot();
  const entry = {
    type: 'boot-stages',
    complete: !!complete,
    stages: snap.stages,
    at: Date.now(),
  };
  appendCrashLog(entry);
  // 主进程 stdout 同步打一份，探针 / e2e 直接从运行输出取阶段耗时
  console.log('[boot-stages]', JSON.stringify(entry));
}

/** 非首帧必需项的延后初始化（幂等）：托盘创建、MCP 管理器预热。
 *  触发点：did-finish-load 后 setImmediate；另设 3s 兜底定时器，
 *  覆盖「渲染进程启动即崩、did-finish-load 不触发」的场景（软渲染守护已有，这里保托盘）。 */
let deferredBootDone = false;
function runDeferredBootInit() {
  if (deferredBootDone) return;
  deferredBootDone = true;
  // 托盘只在 Windows 创建（macOS 用 Dock，Linux 各发行版托盘行为差异大，先不铺开）
  createTray();
  // MCP 管理器预热：懒建闭包亚毫秒级，这里提前建只为让首帧后的 tool:specs 完全零开销
  getMcpManager();
}

/** 渲染层 boot 完成的上报钩子：渲染层代理负责在首帧（splash）可见后调用
 *  window.dsh… → ipcRenderer.invoke('boot:renderer-ready')。重复调用安全（幂等）。 */
ipcMain.handle('boot:renderer-ready', () => {
  if (!bootTimer.ended) {
    bootTimer.mark('renderer-ready');
    bootTimer.end();
    writeBootStages(true);
  }
  return { ok: true, stages: bootTimer.snapshot().stages };
});

/* ---------------- 窗口 ---------------- */

function createWindow() {
  // activate 重建窗口会再次进这里：boot 打点只记首窗，同名重复 mark 会抛错
  if (!bootTimer.has('createWindow')) bootTimer.mark('createWindow');
  const sizeArg = process.argv.find((x) => x.startsWith('--size='));
  const [w, h] = sizeArg ? sizeArg.slice(7).split('x').map(Number) : [1320, 880];

  win = new BrowserWindow({
    width: Number.isFinite(w) && w >= 900 ? w : 1320,
    height: Number.isFinite(h) && h >= 620 ? h : 880,
    minWidth: 900,
    minHeight: 620,
    // 立即显示：不等 ready-to-show（原先 show:false 让「进程启动→窗口可见」全程无反馈，
    // 是用户体感启动慢的主因）。空窗期由 backgroundColor 垫底，渲染层 splash 第一帧接上。
    show: true,
    frame: false,
    roundedCorners: true,
    backgroundColor: bootBackgroundColor(),
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
  // 不再等 ready-to-show：窗口构造即 show（见上方 show: true 注释）

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

  // P2 启动时长：whenReady → 首次 did-finish-load，每次启动写一条 boot 记录（老口径保留）；
  // 并在此打点 + 延后落 boot-stages 明细 / 跑非首帧必需项（都不挡渲染层首帧）
  win.webContents.once('did-finish-load', () => {
    // 新窗口（activate 重建）也会触发：同名重复 mark 会抛错，只记首个 did-finish-load
    if (!bootTimer.has('did-finish-load')) bootTimer.mark('did-finish-load');
    if (bootReadyAt > 0) appendCrashLog({ type: 'boot', bootMs: Date.now() - bootReadyAt, at: Date.now() });
    // 非首帧必需：boot-stages 部分记录 + 托盘/MCP 预热，让出主线程给渲染层首帧
    setImmediate(() => {
      writeBootStages(false); // renderer-ready 未上报，先落部分记录（该阶段为 null）
      runDeferredBootInit();
    });
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
  bootTimer.mark('whenReady');
  try {
    runtimeSvc = runtimeModule.createRuntime({
      dir: path.join(app.getPath('userData'), 'runtime'),
      workspacePath: app.getPath('documents'),
      executeTool: (name, args, opts) => localTools.executeTool(name, args, opts),
      modelRequest: delegationModelRequest,
      // F2 修复：委派链密钥/连接解析器 —— 渲染层 profiles 只剩掩码，
      // runtime 按 profileId 换取明文（含跨接入点委派所需的 baseUrl）
      resolveSecretKey,
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
  // runtimeSvc 保持同步初始化：renderer 早期 IPC（runtime:* / tool:specs 经 localTools）都依赖它，
  // 延后会拖慢首帧交互，属于首帧必需项。
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // 兜底：渲染进程若启动即崩（did-finish-load 一直不触发），托盘等延后项也不能永久丢失——
  // 3s 后幂等补跑（正常路径由 did-finish-load 的 setImmediate 更早触发）
  setTimeout(runDeferredBootInit, 3000);
});

app.on('before-quit', () => {
  // quit 途中窗口还会收到 close 事件：置位后 close 拦截不再生效，保证能退干净
  quitting = true;
  // Autopilot：退出前停轮询定时器（unref 过，此处显式停是双保险）
  try { autopilot?.stop(); } catch { /* 已停止 */ }
  try { runtimeSvc?.close(); } catch { /* 已关闭 */ }
  // 文件存储兜底：去抖窗口内的写入必须在进程退出前落盘（否则丢的正是最后几条聊天）
  try { storageStore?.flushSync(); } catch { /* 尽力而为 */ }
  // 退出时停掉所有 MCP server（杀整棵进程树，避免遗留子进程）；
  // 注意用 if 而非 getMcpManager()：退出路径不允许懒建出一个新管理器
  if (mcpManager) { try { mcpManager.stopAll(); } catch { /* 尽力停止即可 */ } }
  /* 后台任务同样要收尾：run_command background:true 起的是真实进程，
     不杀就会在关窗后继续跑（dev server / watch 最典型）。 */
  try { localTools.backgroundTasks.stopAll(); } catch { /* 尽力停止即可 */ }
  /* 退出前轮换备份（R15/A7）：源从「经验库 + 水位」扩到「用户真正在乎的全部状态」——
     · dsh-storage.json：会话历史 / 设置 / 连接配置（真值源）
     · state.json：任务 / Run / 审批 / 委派快照
     · audit/：哈希链审计（整目录）
     · events/ 最近 3 天分片（事件链是审计真值；更早分片体积大、价值递减）
     保留 7 份，尽力而为，失败不影响退出。 */
  try {
    const userData = app.getPath('userData');
    const runtimeDir = path.join(userData, 'runtime');
    const eventsDir = path.join(runtimeDir, 'events');
    let eventFiles = [];
    try {
      eventFiles = fs.readdirSync(eventsDir)
        .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
        .sort()
        .slice(-3)
        .map((n) => path.join(eventsDir, n));
    } catch { /* 事件目录不存在：只备状态文件 */ }
    backup.rotateBackup([
      path.join(userData, 'dsh-storage.json'),
      path.join(runtimeDir, 'state.json'),
      path.join(runtimeDir, 'lessons.jsonl'),
      path.join(runtimeDir, 'runtime.json'),
      path.join(runtimeDir, 'audit'),
      ...eventFiles,
    ], path.join(userData, 'backups'), { keep: 7 });
  } catch { /* 备份失败不阻塞退出 */ }
  // 托盘先销毁再退出，防止图标残留在任务栏托盘区
  destroyTray();
});

/* ---------------- 备份浏览（R15/A7） ----------------
 * 只读 + 打开目录：真正的「恢复」需要先退出应用再覆盖文件，
 * 这里提供列目录与用系统文件管理器打开，避免在运行中覆盖自身状态。 */
ipcMain.handle('backup:list', () => {
  const dir = path.join(app.getPath('userData'), 'backups');
  try {
    const items = fs.readdirSync(dir)
      .filter((name) => backup.STAMP_RE.test(name))
      .sort()
      .reverse()
      .map((name) => ({ name, path: path.join(dir, name) }));
    return { ok: true, dir, items };
  } catch {
    return { ok: true, dir, items: [] };
  }
});

ipcMain.handle('backup:open', async (_event, name) => {
  const root = path.join(app.getPath('userData'), 'backups');
  const raw = typeof name === 'string' ? name.trim() : '';
  const target = raw ? path.join(root, raw) : root;
  // 防穿越：解析后必须仍在 backups 根下，且只接受时间戳形态的目录名
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return { ok: false, code: 'BAD_PATH', error: '备份路径非法' };
  }
  if (raw && !backup.STAMP_RE.test(raw)) {
    return { ok: false, code: 'BAD_PATH', error: '备份目录名非法' };
  }
  if (!fs.existsSync(resolvedTarget)) return { ok: false, code: 'NOT_FOUND', error: '备份目录不存在' };
  const err = await shell.openPath(resolvedTarget);
  return err ? { ok: false, code: 'OPEN_FAILED', error: err } : { ok: true, path: resolvedTarget };
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

/* ---------------- 文件存储（userData/dsh-storage.json） ----------------
 * 根治「换构建方式聊天记录全丢」：localStorage 按 origin 键控 —— 开发版（file:///E:/dsh-desktop/...）
 * 与打包版（asar 内路径）是两个 origin，两套存储，历史必然分裂。真相源改为主进程文件：
 *   · 渲染层启动时 preload 用 sendSync 一次性取快照（保持同步读语义，调用点不必改 async）；
 *   · 读走内存镜像，写经 IPC → 去抖原子落盘（tmp+rename），退出前 flushSync 兜底；
 *   · localStorage 退化为镜像：老数据首次启动自动迁入文件，同时继续双写以兼容既有探针。
 * 密钥不进这里（profiles 仍在 safeStorage 凭据库，本文件只存掩码视图）。
 */
let storageStore = null;
function getStorageStore() {
  if (!storageStore) {
    storageStore = persistStoreModule.createPersistStore({
      filePath: path.join(app.getPath('userData'), 'dsh-storage.json'),
    });
  }
  return storageStore;
}
// sendSync 通道：preload 在页面脚本执行前调用，必须同步返回
ipcMain.on('storage:bootstrap', (event) => {
  try { event.returnValue = getStorageStore().getAll(); }
  catch (err) {
    console.log('[storage] bootstrap 失败：', err && err.message ? err.message : err);
    event.returnValue = {};
  }
});
/* dsh.perm 是权限档位的权威值，只能经 permission:set 写（那条路径带提权确认框）。
   通用 storage 通道必须挡住它，否则 confirm 形同虚设——这是 R15/A1 的关键一环。 */
const STORAGE_GUARDED_KEYS = new Set(['dsh.perm']);

ipcMain.handle('storage:set', (_event, payload) => {
  const key = payload && payload.key;
  if (STORAGE_GUARDED_KEYS.has(key)) {
    return { ok: false, error: 'PROTECTED_KEY', message: '该键只能通过专用通道写入' };
  }
  const r = getStorageStore().set(payload && payload.key, payload && payload.value);
  if (!r.ok) console.log('[storage] set 被拒：', r.error, payload && payload.key);
  return r;
});
ipcMain.handle('storage:set-many', (_event, payload) => {
  if (!payload || typeof payload !== 'object') return getStorageStore().setMany(payload);
  const safe = {};
  for (const [k, v] of Object.entries(payload)) {
    if (STORAGE_GUARDED_KEYS.has(k)) continue;
    safe[k] = v;
  }
  return getStorageStore().setMany(safe);
});
ipcMain.handle('storage:remove', (_event, key) => {
  // 删除受保护键等于把档位回落到默认值（full），必须与 set 一并挡住
  if (STORAGE_GUARDED_KEYS.has(key)) {
    return { ok: false, error: 'PROTECTED_KEY', message: '该键只能通过专用通道修改' };
  }
  return getStorageStore().remove(key);
});
ipcMain.handle('storage:flush', () => getStorageStore().flushSync());
ipcMain.handle('storage:stats', () => getStorageStore().stats());

/* ---------------- 权限档位权威（R15/A1） ----------------
 * 档位只能由主进程裁定。渲染层传下来的 permission / profile 一律按「请求」处理：
 * 与权威值取更严格者，永不放大。理由是 R14 只收回了审批权（approved:true 已失效），
 * 但档位权仍在渲染层——被注入的渲染层可以传 permission:'full' 让 ask 档静默放行。
 *
 * 提升到 full 需要主进程原生确认框：正常切换多一次点击，注入者无法绕过。
 * 降级（full→ask→readonly）不需要确认，随时可以收紧。
 */
/* 裁定逻辑抽到 lib/permission-authority.js（纯函数，可单测）；这里只负责读写权威值。 */
function readPermissionAuthority() {
  try {
    const raw = getStorageStore().get('dsh.perm');
    return authority.isProfile(raw) ? raw : 'full';
  } catch { return 'full'; }
}

/** 请求档位只能比权威值更严格；非法值回落权威值。 */
function resolvePermission(requested) {
  return authority.resolvePermission(requested, readPermissionAuthority());
}

/** runtime 通道（tools:propose / tools:execute）用 profile 字段。 */
function withAuthorityProfile(input) {
  const src = input && typeof input === 'object' ? input : {};
  return { ...src, profile: resolvePermission(src.profile) };
}

/** 旧通道（tool:exec）用 opts.permission 字段。 */
function withAuthorityToolPayload(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const opts = src.opts && typeof src.opts === 'object' ? src.opts : {};
  return { ...src, opts: { ...opts, permission: resolvePermission(opts.permission) } };
}

async function confirmPermissionElevation(from) {
  // 无头自检不允许弹框：一律按拒绝处理（探针据此断言「提权被挡」）
  if (process.argv.includes('--shot') || process.argv.includes('--script')) return false;
  if (!win || win.isDestroyed()) return false;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'DSH · 提升权限',
      message: '把权限档位提升到「完全权限」？',
      detail: `当前档位：${from}。完全权限下，助手可以不经过确认直接写文件、执行命令。仅在信任当前任务时开启。`,
      buttons: ['提升到完全权限', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return response === 0;
  } catch { return false; }
}

ipcMain.handle('permission:get', () => ({ ok: true, permission: readPermissionAuthority() }));

ipcMain.handle('permission:set', async (_event, raw) => {
  const next = String(raw || '');
  if (!authority.isProfile(next)) return { ok: false, code: 'BAD_ARGS', error: '权限档位非法' };
  const current = readPermissionAuthority();
  const elevating = authority.isElevation(current, next);
  if (elevating && next === 'full') {
    const allowed = await confirmPermissionElevation(current);
    if (!allowed) return { ok: false, code: 'DENIED', error: '提权未获确认', permission: current };
  }
  const r = getStorageStore().set('dsh.perm', next);
  if (!r.ok) return { ok: false, code: r.error || 'STORAGE_ERROR', error: '档位保存失败' };
  try {
    runtimeSvc?.append?.({
      type: 'permission.changed',
      actor: { kind: 'user', id: 'local-user' },
      payload: { from: current, to: next, elevating, at: new Date().toISOString() },
    });
  } catch { /* 审计失败不影响切换 */ }
  return { ok: true, permission: next, elevated: elevating };
});

/* ---------------- 系统通知（Windows toast） ----------------
 * 渲染层只在 document.hidden 时发起（前台不打扰），走这里统一展示：
 * 相同 tag 30s 内去重成一条；点击通知聚焦主窗口。不支持通知的系统静默跳过。
 */

function showOsNotification(payload) {
  // 权限自检：不支持就静默跳过，让调用方拿到明确的 UNSUPPORTED
  if (!Notification.isSupported()) return { ok: false, code: 'UNSUPPORTED', message: '当前系统不支持通知' };
  const title = String(payload?.title || '').trim().slice(0, 80) || 'DSH';
  const body = String(payload?.body || '').slice(0, 200);
  /* PII 脱敏（profile='strict'，理由：系统通知是「外显」出口，任何路过屏幕的人都可能瞥到，
     凭据类（api_key/jwt/私钥）零容忍）：命中 BLOCK → 整条不发系统通知，只留主进程日志；
     个人信息类（email/手机号/身份证/cred_kv）→ REDACT 替换后照发。 */
  const titleRed = redact.pipeline(title, { profile: 'strict' });
  const bodyRed = redact.pipeline(body, { profile: 'strict' });
  if (titleRed.blocked || bodyRed.blocked) {
    const types = [...new Set([...(titleRed.error?.types || []), ...(bodyRed.error?.types || [])])];
    console.log('[notify] 命中 strict BLOCK，通知整体拦截不外显（类型: ' + types.join(', ') + '）');
    return { ok: false, blocked: true, code: 'REDACT_BLOCKED', types };
  }
  const safeTitle = titleRed.text || 'DSH';
  const safeBody = bodyRed.text;
  const tag = typeof payload?.tag === 'string' && payload.tag.trim() ? payload.tag.trim() : '';
  // 去重键 = tag：没有 tag 就每次都发；命中窗口期直接吞掉本次
  if (tag && !osNotifyDedupe.shouldSend(tag)) return { ok: true, deduped: true };
  const notification = new Notification({ title: safeTitle, body: safeBody, silent: false });
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

/* ---------------- Autopilot（无人值守任务推进） ----------------
 * 渲染层开关 UI 走这两个通道；状态只存主进程内存（重启即关，安全默认）。
 * 开启 = 每 30s 轮询 runtime 任务列表，推进 paused/queued 任务；
 * 停止条件（全部内建于 lib/autopilot.js）：全部终态 / 迭代上限 / 连续失败 ≥2。
 */
ipcMain.handle('autopilot:state:get', () => {
  if (!autopilot) {
    // 未实例化时返回默认态，渲染层据此画开关
    return { ok: true, state: { enabled: false, iteration: 0, lastAction: null, decisions: [] } };
  }
  try { return { ok: true, state: autopilot.state() }; }
  catch (err) { return { ok: false, error: `读取 Autopilot 状态失败：${err?.message || String(err)}` }; }
});

ipcMain.handle('autopilot:state:set', (_event, payload) => {
  const enabled = !!(payload && payload.enabled);
  try {
    if (!enabled) {
      autopilot?.stop();
      return { ok: true, state: autopilot?.state() || { enabled: false, iteration: 0, lastAction: null, decisions: [] } };
    }
    if (!runtimeSvc) return { ok: false, error: 'Runtime 未初始化，Autopilot 不可用' };
    const ap = ensureAutopilot();
    ap.start(); // 幂等：已启用时直接返回现状
    return { ok: true, state: ap.state() };
  } catch (err) {
    return { ok: false, error: `设置 Autopilot 失败：${err?.message || String(err)}` };
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
ipcMain.handle('runtime:tools:propose', (_event, input) => runtimeCall((rt) => rt.proposeTool(withAuthorityProfile(input))));
ipcMain.handle('runtime:tools:execute', (_event, input) => runtimeCall((rt) => rt.executeTool(withAuthorityProfile(input))));
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
    refreshProfileMaps(data.profiles);
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
      refreshProfileMaps(incoming.profiles);
      vaultLoadedOnce = true; // 表已按最新保存数据重建，无需再懒加载 vault
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

/* 上游网关「自己」没配好时，只照抄 HTTP 状态码会让人反复去查 key。
   这里把已知的网关级故障翻译成下一步该做的事；原始报文仍原样保留在前半句。 */
function upstreamHint(status, detail) {
  const d = String(detail || '');
  if (/no[_ ]accounts?|no accounts configured/i.test(d)) {
    return '这不是 API Key 的问题：接入点网关自身没有可用账号，请先到该网关（例如 DeepAI-Panel）登录账号，或切换到其他接入点。';
  }
  if (status === 401) {
    return '请确认地址与 key 属于同一个网关：不同本地端口（如 4399 / 6780）各有独立 key，换地址后需同步换 key。';
  }
  if (/model[ _]?not[ _]?found|unknown model|invalid model|no such model/i.test(d)) {
    return '模型名不在该网关的可用列表里，请点输入框上方的模型入口重新拉取后选择。';
  }
  return '';
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
  const hint = upstreamHint(status, detail);
  const head = `${labels[status] || `HTTP ${status}`}${detail ? '：' + detail : ''}`;
  return {
    code: String(status),
    message: hint ? `${head}\n${hint}` : head,
    retryable: retry.isRetryableStatus(status),
  };
}

/** 子 Agent 的非流式模型调用：由 Runtime 委派执行器注入，密钥只在内存中使用。 */
async function delegationModelRequest({ cfg, messages, tools, timeoutMs, signal } = {}) {
  const base = normalizeBase(cfg.baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Math.min(Number(timeoutMs) || 120000, 180000)));
  // 取消传播：Runtime 的 run 级 AbortSignal（父任务取消/收尾）直接断掉本次委派请求
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const body = {
      model: String(cfg.model).trim(),
      messages: sanitizeMessages(Array.isArray(messages) ? messages : []),
      stream: false,
    };
    const eff = wantEffort(cfg);
    if (eff) body.reasoning_effort = eff;
    const specs = sanitizeTools(tools);
    if (specs?.length) {
      body.tools = specs;
      body.tool_choice = 'auto';
    }
    const headers = { ...apiHeaders(cfg), 'content-type': 'application/json' };
    const post = () => net.fetch(base + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    let res = await post();
    let errText = res.ok ? '' : await res.text().catch(() => '');
    /* 不认 reasoning_effort 的网关：只给这个接入点去掉参数并重来一次，
       不让「思考强度」变成委派链路的硬阻塞，也不影响其它接入点。 */
    if (!res.ok && eff && res.status === 400 && effortRejected(errText)) {
      effortUnsupported.add(effortKeyOf(cfg));
      delete body.reasoning_effort;
      res = await post();
      errText = res.ok ? '' : await res.text().catch(() => '');
    }
    if (!res.ok) {
      const c = classifyHttp(res.status, errText);
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
    if (signal) signal.removeEventListener('abort', onAbort);
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
  if (msgs.length > MAX_INPUT_MESSAGES) return `消息条数异常（${msgs.length} > ${MAX_INPUT_MESSAGES}），已拒绝本次请求`;
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
  return msgs.slice(-MAX_INPUT_MESSAGES).map((m) => {
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


/** 取第一个「括号配平」的 JSON 对象子串：网关把同一个完整 JSON 重复推两遍时，
    拼接结果 `{...}{...}` 不是合法 JSON，取第一块即可还原模型本意。 */
function firstJsonObject(text) {
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return s.slice(i, j + 1); }
    }
  }
  return '';
}

/** 工具参数串修复：能直接 parse 就原样下发；否则尝试截取第一个完整对象。 */
function normalizeToolArgs(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '{}';
  try { JSON.parse(s); return s; } catch { /* 继续修复 */ }
  const block = firstJsonObject(s);
  if (block) { try { JSON.parse(block); return block; } catch { /* 落回原文 */ } }
  return s;
}

/** SSE 事件块解析：按空行分块，块内多行 data 拼接，兼容 CRLF / 心跳 / [DONE] / tool_calls */
/* 用量归一化：各家对「提示缓存命中」的字段叫法不同——
   OpenAI 用 prompt_tokens_details.cached_tokens，DeepSeek 直接给 prompt_cache_hit_tokens/miss，
   有些网关只给 cached_tokens。统一成一个口径，界面才能算出命中率。 */
/* 有的兼容网关不认 reasoning_effort，回 400 unknown parameter。
   按「接入点 + 模型」分别记住：某个网关不支持就只给它去掉参数，
   不能把其它支持思考链的接入点一起关掉。
   validEffort 同时兜住「未开启 / 配置缺失 / 脏值」：这些情况一律不发该参数。 */
const EFFORT_VALUES = Object.freeze(['low', 'medium', 'high']);
const effortUnsupported = new Set();
function effortKeyOf(cfg) {
  try { return `${normalizeBase(cfg.baseUrl)}|${String(cfg?.model || '').trim()}`; }
  catch { return `${String(cfg?.baseUrl || '')}|${String(cfg?.model || '')}`; }
}
function wantEffort(cfg) {
  const v = String(cfg?.effort || '').toLowerCase();
  if (!EFFORT_VALUES.includes(v)) return null;      // off / 缺失 / 非法值：不发
  return effortUnsupported.has(effortKeyOf(cfg)) ? null : v;
}
const effortRejected = (text) => /reasoning_effort|unknown (parameter|argument)|unsupported parameter|invalid.*parameter/i.test(String(text || ''));

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const prompt = num(u.prompt_tokens ?? u.input_tokens);
  const completion = num(u.completion_tokens ?? u.output_tokens);
  const total = num(u.total_tokens) ?? (prompt != null && completion != null ? prompt + completion : null);
  const details = u.prompt_tokens_details || u.prompt_tokens_detail || {};
  let cached = num(details.cached_tokens ?? u.cached_tokens ?? u.prompt_cache_hit_tokens);
  const miss = num(u.prompt_cache_miss_tokens);
  if (cached == null && miss != null && prompt != null) cached = Math.max(0, prompt - miss);
  const out = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
  if (cached != null) {
    out.cached_tokens = Math.max(0, Math.min(cached, prompt ?? cached));
    out.cache_rate = prompt ? Math.round((out.cached_tokens / prompt) * 1000) / 10 : null;  // 百分比，1 位小数
  }
  const reasoning = num(u.completion_tokens_details?.reasoning_tokens);
  if (reasoning != null) out.reasoning_tokens = reasoning;
  return out;
}

/* 一个用户回合可能包含多次上游请求（补答 / 网络重试 / 工具多步）。
   只取最后一次 usage 会把前面的 token 漏掉，平均命中率的分母也跟着变小。
   与 ZCode usage-stats-builder 的口径一致：按总量聚合，命中率 = Σcached / Σprompt，
   分母就是 total input，不再额外叠加缓存分项。 */
function mergeUsage(parts) {
  const merged = {};
  let count = 0;
  for (const raw of parts || []) {
    const u = normalizeUsage(raw);
    if (!u) continue;
    count += 1;
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens']) {
      if (Number.isFinite(u[key])) merged[key] = (merged[key] || 0) + u[key];
    }
  }
  return count ? merged : null;
}

/** 兼容各家把思考内容塞在不同形状里：字符串 / 对象 / content part 数组。 */
function reasonPartText(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  const v = part.thinking ?? part.reasoning ?? part.reasoning_content ?? part.text ?? part.content ?? '';
  /* 只认真实文本：对象/数组等异常形态一律忽略，绝不把 [object Object] 当成思考链。 */
  return typeof v === 'string' ? v : '';
}

/* 「上游一个正文字符都没给」时的本机兜底答复：从思考内容尾部整理出结论，
   宁可给出一段带说明的整理结果，也绝不留一个空气泡让用户以为程序死了。 */
function fallbackAnswerText(reasoning, code, finishReason) {
  const lines = [...new Set(String(reasoning || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
  const noise = /^(让|我|首先|接下来|然后|嗯|好的|需要|现在|再|接着|先|考虑|检查|等待|尝试|所以先)/;
  const useful = lines.filter((l) => !noise.test(l) && l.length >= 8);
  const pick = (useful.length ? useful : lines).slice(-6).join('\n').slice(-1200);
  const hasReason = pick.length > 0;
  const why = code && code !== 'REASON_ONLY' && code !== 'EMPTY_OUTPUT'
    ? `本轮请求未完成（${code}）`
    : finishReason === 'length'
      ? '输出额度耗尽（finish_reason=length）'
      : hasReason ? '上游本轮只返回了思考过程' : '上游本轮没有返回正文';
  if (hasReason) {
    return `**根据思考过程整理的答复**\n\n${pick}\n\n> ${why}；以上由本机从思考内容整理，完整推理见「思考过程」。把输入区「思考强度」调低后重试可获得更完整的正文。`;
  }
  /* 没有思考链可用：只陈述事实 + 中性建议，不谎称「只返回了思考过程」、
     不引导用户调思考强度（很多网关根本没有该能力），更不编造思考内容。 */
  return `**本轮没有取得模型正文**\n\n${why}；本轮也没有思考内容可整理。请重试、换一个更具体的问法，或检查接入点与模型配置。`;
}

function parseSseBlock(block, onDelta, onUsage, onToolDelta, onReason, onFinish) {
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
  const d = choice?.delta || {};
  const m = choice?.message || {};
  /* 推理模型（deepseek-reasoner / GLM 思考版 / Anthropic 兼容网关等）把「想」和
     「说」分成两个通道。以前只认字符串 reasoning_content、content 数组也只取 text：
     {type:'thinking', thinking:'…'} 这类分片会被整个丢掉，token 在涨、界面全白。
     这里把字符串 / 对象 / part 数组统一分流，正文口径（produced）不受影响。 */
  const emitReasonText = (value) => {
    if (typeof value === 'string') { if (value) onReason?.(value); return; }
    if (Array.isArray(value)) { for (const p of value) emitReasonText(p); return; }
    if (value && typeof value === 'object') {
      const t = reasonPartText(value);
      if (t) onReason?.(t);
    }
  };
  const reasonRaw = d.reasoning_content ?? d.reasoning ?? d.thinking ?? d.thought
    ?? m.reasoning_content ?? m.reasoning ?? m.thinking
    ?? j?.reasoning_content ?? j?.reasoning ?? '';
  if (reasonRaw) emitReasonText(reasonRaw);
  if (choice?.finish_reason && onFinish) onFinish(String(choice.finish_reason));

  const emitContent = (value) => {
    if (typeof value === 'string') { if (value) onDelta?.(value); return; }
    if (Array.isArray(value)) { for (const p of value) emitContent(p); return; }
    if (value && typeof value === 'object') {
      const type = String(value.type || '').toLowerCase();
      const txt = value.text ?? value.content ?? value.thinking ?? value.reasoning ?? '';
      if (['thinking', 'reasoning', 'reasoning_content', 'thought'].includes(type)) {
        emitReasonText(txt);
      } else if (txt) onDelta?.(String(txt));
    }
  };
  emitContent(d.content ?? m.content ?? choice?.text ?? j?.content ?? '');

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
    finishReason: '',
  };
  activeChats.set(id, session);

  let produced = 0;
  let totalChars = 0;
  let reasonChars = 0;   // 本回合思考字段的字符数：只用于「有没有产生内容」的判断，不进正文
  let reasonText = '';    // 有界保留思考文本尾部：上游彻底不给正文时，据此生成可见的最终答复
  /* 只想了不说的补救：推理模型把额度耗在思考上时正文为空。
     换一套「直接作答」的 user 指令重问（比 system 更容易被遵守），压低思考强度、
     关掉工具调用；最多两轮，仍不给正文就由本机兜底出一段答复。 */
  let nudgeLevel = 0;
  const ANSWER_NUDGES = [
    '请立刻停止思考，直接用中文给出最终答复。只输出正文：不要输出思考过程、不要调用任何工具、不要复述上面的问题。若刚才的思考里已经有结论，把它写成完整答案。',
    '不要思考、不要解释、不要调用工具，现在直接输出最终答案的正文。哪怕只写一句话也可以，但必须输出正文。',
  ];
  let usage = null;
  /* 每次上游请求只记最后一条 usage（同一流末尾多次上报不重复累加），
     不同请求（补答/重试）各占一项，收尾时统一聚合。 */
  const usageByAttempt = new Map();
  let finished = false;
  let attempts = 0;
  let retries = 0;

  const finish = (extra = {}) => {
    if (finished) return;
    finished = true;
    try { session.cancelBody?.(); } catch { /* 已关闭 */ }
    activeChats.delete(id);
    /* 最后一道保险：只要不是用户主动中断，且整轮一个正文字符都没产出，
       主进程自己发一段 chunk。渲染层的 body 因此必然非空，气泡不会是空的，
       也不会停在「思考中」——用户花了 token 就必须看到字。
       但「本步只发起了工具调用」不算零产出：工具循环还在进行，后面一步会说；
       以前这里不区分，模型选择沉默的每一步都会被塞一段「本轮没有取得模型正文」，
       多步任务里同一句兜底重复叠加、把真正的结论挤到最下面。 */
    const stepHasToolCalls = Array.isArray(session.toolCalls) && session.toolCalls.length > 0;
    if (!session.aborted && produced === 0 && !session.outputGuard && !stepHasToolCalls) {
      const fallback = scrubSecret(
        fallbackAnswerText(reasonText, extra.code, session.finishReason), cfg?.key);
      /* 出错的回合里，这段兜底只会跟渲染层的错误块抢位置、把状态码重复一遍。
         只有当它确实能整理出思考内容时才发；否则正文交给错误块本身。 */
      const redundantOnError = !!extra.code && !String(reasonText || '').trim();
      if (!redundantOnError) {
        produced += fallback.length;
        send('chunk', { text: fallback });
      }
    }
    const normUsage = normalizeUsage(mergeUsage([...usageByAttempt.values()]) || usage);
    if (normUsage) send('usage', { usage: normUsage });
    const done = {
      aborted: session.aborted,
      reason: session.reason,
      attempts,
      retries: Math.max(retries, Math.max(0, attempts - 1)),
      toolCalls: session.toolCalls || [],
      finishReason: session.finishReason || '',
      reasonChars,
      emptyContent: session.emptyContent === true,
      outputGuard: session.outputGuard || null,
      usage: normUsage,
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
    reasonChars = 0;   // 每次尝试重新计：重试后上一轮的思考不该冒充本轮产出
    reasonText = '';    // 兜底答复只取最后一轮思考，避免补答多轮时结论重复出现

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
      /* 有的网关把 arguments 直接给成对象而不是字符串；早期只认字符串，
         这类调用会变成 {} 下发，工具报「缺少 pattern 参数」，看起来像找文件坏了。 */
      if (typeof fn.arguments === 'string') slot.arguments += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === 'object') {
        slot.arguments = JSON.stringify(fn.arguments);
      }
    };
    const collectToolCalls = () => {
      const out = [];
      for (const [index, slot] of [...toolSlots.entries()].sort((a, b) => a[0] - b[0])) {
        if (!slot.name) continue;
        out.push({
          id: slot.id || `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: { name: slot.name, arguments: normalizeToolArgs(slot.arguments) },
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

    /* 输出守卫：部分网关/推理模型不把调用放进 tool_calls，而把
       「functions.read_file(path=…)」「<tool_call>{…}」当正文吐出来。这样既不会生成
       工具卡片，模型又会按「持续自主执行」协议在正文里反复重写调用草稿——用户看到
       的就是工具调用被纯文本直出、然后越滚越长停不下来。
       只在带工具定义的正常轮启用，且匹配到的名字必须是本次下发的工具，
       避免误伤讨论代码的普通对话。 */
    const toolNames = new Set((tools || []).map((t) => String(t?.function?.name || '')));
    const TEXT_CALL_RE = /\b(?:to=)?functions\.([A-Za-z_][\w]*)\b|<tool_call\b|"tool_calls"\s*:/i;
    const repeatedLine = (tail) => {
      const seen = new Map();
      for (const line of tail.split(/[\r\n。！？!?；;]/).map((x) => x.trim())) {
        if (line.length < 8) continue;
        const n = (seen.get(line) || 0) + 1;
        if (n >= 4) return true;
        seen.set(line, n);
      }
      return false;
    };
    let textTail = '';
    let guardStopped = false;
    const stopStream = (kind, name) => {
      if (guardStopped) return;
      guardStopped = true;
      session.outputGuard = { kind, name: name || '' };
      send('output-guard', session.outputGuard);
      try { session.cancelBody?.(); } catch { /* 已关闭 */ }
    };

    const emitDelta = (text) => {
      if (session.aborted || guardStopped) return;
      totalChars += text.length;
      if (totalChars > MAX_OUTPUT_CHARS) {
        session.reason = 'OUTPUT_LIMIT';
        session.aborted = true;
        try { session.cancelBody?.(); } catch { /* 已关闭 */ }
        ctrl.abort();
        return;
      }
      if (toolNames.size && !nudgeLevel) {
        textTail = (textTail + text).slice(-1200);
        const m = TEXT_CALL_RE.exec(textTail);
        if (m && (!m[1] || toolNames.has(m[1]))) { stopStream('text-tool-call', m[1] || ''); return; }
        if (repeatedLine(textTail)) { stopStream('repeat'); return; }
      }
      produced += text.length;
      armIdle();
      send('chunk', { text });
    };

    /* 思考流：单独上报，界面折叠展示；不计入正文、不进上下文。
       有界（MAX_REASON_CHARS）——推理模型可能吐几万字，全量传渲染层没有意义。 */
    const emitReason = (text) => {
      if (session.aborted) return;
      armIdle();   // 思考期间必须有数据在动，否则会被空闲超时误杀
      if (reasonChars >= MAX_REASON_CHARS) return;
      const room = MAX_REASON_CHARS - reasonChars;
      const piece = text.length > room ? text.slice(0, room) : text;
      reasonChars += piece.length;
      reasonText = (reasonText + piece).slice(-4000);  // 只留尾部结论，兜底答复要用
      send('think', { text: piece, truncated: reasonChars >= MAX_REASON_CHARS && piece.length < text.length });
    };

    const signal = anySignal([session.lifeCtrl.signal, ctrl.signal]);

    try {
      armIdle();
      connectTimer = setTimeout(() => {
        session.connectTimeout = true;
        try { session.cancelBody?.(); } catch { /* 已关闭 */ }
        ctrl.abort();
      }, Math.min(CONNECT_TIMEOUT_MS, budget));
      /* 补答轮用 user 角色而不是 system：兼容网关 / 推理模型对末尾 system 常常忽略，
         换成用户指令后「直接给正文」的遵守率明显更高。 */
      const attemptMessages = nudgeLevel
        ? [...messages, { role: 'user', content: ANSWER_NUDGES[nudgeLevel - 1] }]
        : messages;
      const requestBody = { model, messages: attemptMessages, stream: true, temperature: 0.7 };
      // 补答轮关掉工具：模型再跑去调工具就永远没有正文了
      if (!nudgeLevel && tools && tools.length) {
        requestBody.tools = tools;
        requestBody.tool_choice = 'auto';
      }
      /* 思考强度：普通轮按接入点配置（off / 缺失 / 非法值都不发）；
         补答轮强制 low——把额度留给正文，否则第二次还是只思考不说话。
         被上游以 400 拒绝过的「接入点 + 模型」整套不再发，其它接入点照常。 */
      const effort = wantEffort(cfg);
      if (!effortUnsupported.has(effortKeyOf(cfg))) {
        if (nudgeLevel) requestBody.reasoning_effort = 'low';
        else if (effort) requestBody.reasoning_effort = effort;
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
        /* 只有确实下发了该参数、且 400 明确指向它时才降级：
           无关的 400 不能顺手把思考强度关掉。 */
        if (requestBody.reasoning_effort && effortRejected(text)) {
          effortUnsupported.add(effortKeyOf(cfg));
          throw new ChatError('EFFORT_UNSUPPORTED', '该接入点不支持 reasoning_effort，已去掉该参数重试', true);
        }
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
        if (body?.usage) { usage = body.usage; usageByAttempt.set(attemptNo, body.usage); }
        session.finishReason = String(body?.choices?.[0]?.finish_reason || '');
        const reasonOnlyText = message?.reasoning_content ?? message?.reasoning ?? '';
        if (typeof reasonOnlyText === 'string' && reasonOnlyText) emitReason(reasonOnlyText);
        if (Array.isArray(message?.tool_calls)) {
          for (let i = 0; i < message.tool_calls.length; i++) mergeToolCall(message.tool_calls[i], i);
        }
        const calls = collectToolCalls();
        if (typeof content === 'string' && content) emitDelta(content);
        if (guardStopped) { session.toolCalls = []; return; }
        if ((typeof content === 'string' && content) || calls.length || reasonChars > 0) {
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
          if (parseSseBlock(block, emitDelta, (u) => { usage = u; usageByAttempt.set(attemptNo, u); }, mergeToolCall, emitReason,
            (r) => { session.finishReason = r; })) sawDone = true;
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
        // R15/A8：未分隔缓冲上限。超限说明上游数据不符合 SSE 分帧（或恶意灌流），
        // 直接按流错误收尾，避免内存被单条「永无空行」的响应撑爆。
        if (buf.length > SSE_BUFFER_LIMIT) {
          streamError = new Error(`上游数据块超限（缓冲 ${buf.length} 字符仍未出现事件分隔），已中止`);
          sawDone = true;
          return;
        }
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
      /* 守卫生效：文本形式的调用一律不执行、不补答、不重试，
         本步 toolCalls 为空 → 渲染层工具循环立刻 break，绝不会滚成死循环。 */
      if (guardStopped) {
        session.toolCalls = [];
        return;
      }
      session.toolCalls = calls;
      /* 只有思考、没有正文：用户看到的是「花了 token 却没人说话」。
         最多换两套「直接作答」指令重问（压低思考强度、关掉工具）；补答仍为空
         就正常收尾，由 finish() 发出本机兜底答复，绝不留空气泡。 */
      if (produced === 0 && !calls.length && reasonChars > 0 && nudgeLevel < ANSWER_NUDGES.length) {
        const needAnswer = new ChatError('REASON_ONLY', '模型只输出了思考过程，正在要求它直接作答', true);
        needAnswer.reasonOnly = true;
        throw needAnswer;
      }
      if (produced === 0 && !calls.length && (reasonChars > 0 || nudgeLevel)) {
        session.emptyContent = true;   // 补答后依然没正文：不再重问，交给兜底答复
        session.toolCalls = [];
        return;
      }
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

      // 只思考不出正文：逐级升级「直接作答」指令重问（不是原样重试，否则多半还是空）
      if (failure.reasonOnly && nudgeLevel < ANSWER_NUDGES.length) nudgeLevel += 1;
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

      const delayMs = failure.reasonOnly
        ? 150   // 补答是「换个问法」而不是等上游恢复，没必要退避
        : failure.retryAfterMs != null
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

/* ---------------- 工具治理内核 ----------------
 * 旧通道（tool:exec）与 MCP 直调（mcp:tool:call）都先经过这里：
 *   策略判定（复用 Runtime 的 policy，同一 workspaceId）→ 主进程原生确认框 → 审计事件。
 * 渲染层不再能通过传 approved:true 跳过审批。
 */
let toolGateway = null;
function getToolGateway() {
  if (!toolGateway) {
    toolGateway = createToolGateway({
      localTools,
      getRuntime: () => runtimeSvc,
      getMcp: () => getMcpManager(),
      confirm: confirmToolApproval,
      auditSink: (record) => console.log('[tool-gateway]', JSON.stringify(record)),
    });
  }
  return toolGateway;
}

/** 主进程自己弹的确认框：审批凭证不经过渲染层，无法被页面脚本伪造。 */
async function confirmToolApproval({ toolName, reason, riskLevel, summary }) {
  const detailLines = [];
  if (reason) detailLines.push(reason);
  if (riskLevel) detailLines.push(`风险等级：${riskLevel}`);
  if (summary) detailLines.push(`参数摘要：${summary}`);
  detailLines.push('批准只对本次调用有效。');
  const options = {
    type: 'warning',
    buttons: ['允许执行', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: '工具执行确认',
    message: `是否允许执行：${toolName}`,
    detail: detailLines.join('\n'),
  };
  try {
    const shotMode = process.argv.includes('--shot');
    if (shotMode) {
      // 无头探针没有可交互窗口：一律拒绝，避免测试卡在模态框上
      console.log('[tool-gateway] 无头模式拒绝需要人工确认的工具调用：', toolName);
      return false;
    }
    const result = win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return result && result.response === 0;
  } catch (err) {
    console.log('[tool-gateway] 确认框失败，按拒绝处理：', err?.message || err);
    return false;
  }
}

ipcMain.handle('tool:specs', () => {
  /* MCP 工具追加进 specs：inputSchema 本身就是 JSON Schema，基本直传。
     policy 无特殊放行：MCP 工具名追加进 needsApproval（与 run_command 同档）。 */
  const mcpEntries = mcpModule.buildToolSpecs(getMcpManager().status());
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
  // 单入口：策略 + 审批 + 审计都在主进程完成，渲染层传什么 approved 都不影响判定；
  // 档位同样走权威收敛（withAuthorityToolPayload）：渲染层只能请求更严格的档位。
  return getToolGateway().execLocal(withAuthorityToolPayload(payload));
});

ipcMain.handle('workspace:default', () => app.getPath('documents'));

/* 打开工作区技能目录（R15/A2）：专用通道。
   旧实现是渲染层用 run_command + permission:'full' + approved:true 打开 explorer，
   等于「用户设只读也会以完全权限跑一条命令」——档位收归主进程后这条路径必须消失。
   这里只做一件事：把 <workspace>/.dsh/skills 用系统文件管理器打开，不经过工具执行层。 */
ipcMain.handle('skills:open-dir', async (_event, rawWorkspace) => {
  const raw = typeof rawWorkspace === 'string' ? rawWorkspace.trim() : '';
  if (!raw) return { ok: false, code: 'NO_WORKSPACE', error: '暂未设置工作目录' };
  let base;
  try {
    base = fs.realpathSync(raw);
  } catch {
    return { ok: false, code: 'WORKSPACE_MISSING', error: '工作目录不存在或不可访问' };
  }
  try {
    if (!fs.statSync(base).isDirectory()) return { ok: false, code: 'NOT_DIR', error: '工作目录不是文件夹' };
  } catch {
    return { ok: false, code: 'WORKSPACE_MISSING', error: '工作目录不存在或不可访问' };
  }
  // 目录名是常量，不存在路径穿越面；建不出来（权限/只读盘）交给 openPath 返回错误
  const dir = path.join(base, '.dsh', 'skills');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在或不可写 */ }
  if (!fs.existsSync(dir)) return { ok: false, code: 'MKDIR_FAILED', error: '技能目录创建失败（工作区可能只读）' };
  const err = await shell.openPath(dir);
  return err ? { ok: false, code: 'OPEN_FAILED', error: err } : { ok: true, path: dir };
});

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
  servers: getMcpManager().status(),
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
  for (const s of getMcpManager().status()) {
    if (!aliveIds.has(s.id) && s.status !== 'stopped') getMcpManager().stopServer(s.id);
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
  return getMcpManager().startServer(cfg);
});

ipcMain.handle('mcp:server:stop', (_event, id) => getMcpManager().stopServer(String(id || '')));

ipcMain.handle('mcp:tools:list', (_event, serverId) => {
  const servers = getMcpManager().status();
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
  // MCP 不再有独立执行入口：走同一治理内核（策略 + 审批 + 审计 + 并发上限）
  return getToolGateway().callMcp(payload);
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

/* ---------------- Doctor 经验库检查（G4 妥协项修复） ----------------
 * 经验库落盘位置与 runtime/state.js 的 _ensureLessons 一致：userData/runtime/lessons.jsonl。
 * 路径推导复用 runtime/delegation.js budgetPath 的「与运行时 state.json 同目录」方式——
 * 以 userData/runtime 为基准拼接（before-quit 的备份轮换也用同一物理路径），不再各处硬编码。
 * 只读通道：summary 给统计概要（stats）、tail 给最近 5 条（含未验证/污染记录，Doctor 看全貌）；
 * 文件不存在 / 零条目 → { ok:false, reason:'empty' }；任何异常转 { ok:false, reason:'error' }，
 * 绝不让 Doctor 面板因经验库故障而抛错。 */

/** 经验库 store（每次调用现建，避免缓存与外部写入不一致；createLessonStore 内部容错不抛错）。 */
function lessonsStore() {
  return lessons.createLessonStore(path.join(app.getPath('userData'), 'runtime', 'lessons.jsonl'));
}

ipcMain.handle('lessons:summary', () => {
  try {
    const store = lessonsStore();
    const probe = store.readAll();
    // 经验库尚不存在（或为空文件）→ empty：Doctor 面板据此显示「暂无经验」而非报错
    if (probe.missing || (probe.entries.length === 0 && probe.corrupted === 0)) {
      return { ok: false, reason: 'empty' };
    }
    return { ok: true, ...lessons.stats(store) };
  } catch (err) {
    return { ok: false, reason: 'error', error: String(err?.message || err) };
  }
});

ipcMain.handle('lessons:tail', () => {
  try {
    const store = lessonsStore();
    const probe = store.readAll();
    if (probe.missing) return { ok: false, reason: 'empty' };
    // queryLessons 已按 ts 降序；includeUnverified/includeTainted 打开——最近记录不做可信过滤
    const q = lessons.queryLessons(store, { limit: 5, includeUnverified: true, includeTainted: true });
    return { ok: true, entries: q.entries };
  } catch (err) {
    return { ok: false, reason: 'error', error: String(err?.message || err) };
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
  /* PII 脱敏（profile='standard'，理由：导出是用户主动行为——不能因内容含密钥就 BLOCK 拒绝
     用户导出自己的会话）：REDACT 全替换后照常落盘，并回报命中数 redacted 供渲染层
     toast「已自动脱敏 N 处」。文本走 pipeline；结构化对象先走 redactValue 递归脱敏
     字符串字段（standard 全替换，无 BLOCK 档）再序列化。 */
  let outText = '';
  let redactedCount = 0;
  if (typeof payload.content === 'string') {
    const r = redact.pipeline(payload.content, { profile: 'standard' });
    outText = r.text;
    redactedCount = r.findings.length;
  } else if (payload.content && typeof payload.content === 'object') {
    // 计数：redactValue 不回报命中数，改在「原值序列化文本」上用同一套正则扫描一次
    //（两处命中天然一致）；脱敏结果再兜底过一遍 pipeline，正常余量为 0。
    redactedCount = redact.scanForPII(JSON.stringify(payload.content)).length;
    const cleaned = redact.redactValue(payload.content, 'standard');
    outText = redact.pipeline(JSON.stringify(cleaned), { profile: 'standard' }).text;
  }
  if (!outText.trim()) return { ok: false, error: '导出内容为空' };
  // 程序化导出（探针/e2e 断言用）：显式绝对路径 targetPath 时跳过保存对话框直接落盘
  const targetPath = typeof payload.targetPath === 'string' && path.isAbsolute(payload.targetPath)
    ? payload.targetPath : null;
  try {
    let filePath;
    if (targetPath) {
      filePath = targetPath;
    } else {
      const choice = await dialog.showSaveDialog(win || undefined, {
        title: '导出会话',
        defaultPath: sanitizeExportName(payload.defaultName, format),
        filters: format === 'json'
          ? [{ name: 'JSON', extensions: ['json'] }]
          : [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
      filePath = choice.filePath;
    }
    await fs.promises.writeFile(filePath, outText, 'utf8');
    return { ok: true, path: filePath, redacted: redactedCount };
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

/* node 自检钩子（tools/x1-check.js 在 mock electron 下 require 本文件用）：
   Electron 运行时 module.exports 无人消费，无副作用；自检脚本借此直接驱动真实函数。 */
module.exports = {
  DEFAULT_MODEL,
  showOsNotification,
  redactCrashEntry,
  appendCrashLog,
  lessonsStore,
};
