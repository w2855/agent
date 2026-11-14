'use strict';

const { contextBridge, ipcRenderer } = require('electron');
// 会话导出序列化是纯函数（node 单测可直接跑）：渲染层进程没有 require，
// 由 preload 加载后透传给页面（见 lib/session-export.js）。
const sessionExport = require('./lib/session-export');
// token 估算同理：渲染层算上下文预算与用量记录时要和主进程用同一把尺子（见 lib/token-estimate.js）
const tokenEstimate = require('./lib/token-estimate');
// 有界读取规划器（R15/A9）：以前只有自检在调用，渲染层自己去截断；现在接到同一份规划器上
const contextPlan = require('./lib/context-plan');

/* 文件存储快照：sendSync 一次性取（页面脚本执行前 renderer 就要能同步读）。
   main.js 模块顶层注册了 storage:bootstrap，加载时序上必然先于本文件执行，不会阻塞。 */
const STORAGE_SNAPSHOT = (() => {
  try {
    const s = ipcRenderer.sendSync('storage:bootstrap');
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch { return {}; }
})();

contextBridge.exposeInMainWorld('dsh', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    onMaximized: (fn) => {
      const handler = (_e, value) => fn(value);
      ipcRenderer.on('win:maximized', handler);
      return () => ipcRenderer.removeListener('win:maximized', handler);
    },
  },
  /* 系统通知（main 进程 Windows toast；相同 tag 30s 内去重，主进程负责 isSupported 自检） */
  notify: {
    show: (p) => ipcRenderer.invoke('notify:show', p),
  },
  /* Windows 托盘：开关状态渲染层 localStorage 持有，经 tray:state 同步进主进程内存 */
  tray: {
    getState: () => ipcRenderer.invoke('tray:state:get'),
    setCloseToTray: (value) => ipcRenderer.invoke('tray:state:set', { closeToTray: value === true }),
    onNewChat: (fn) => {
      const handler = () => fn();
      ipcRenderer.on('tray:new-chat', handler);
      return () => ipcRenderer.removeListener('tray:new-chat', handler);
    },
  },
  /* 稳定性守护（P2）：单实例锁 / 崩溃恢复 / 启动日志的诊断状态（设置页「关于」后续可用） */
  guard: {
    getState: () => ipcRenderer.invoke('guard:state'),
  },
  /* 会话导出：保存走主进程对话框；序列化是纯函数，这里透传给页面复用 */
  export: {
    session: (p) => ipcRenderer.invoke('export:session', p),
    serializeSessionMd: (session) => sessionExport.serializeSessionMd(session),
    serializeSessionJson: (session) => sessionExport.serializeSessionJson(session),
  },
  wallpaper: {
    current: () => ipcRenderer.invoke('wallpaper:current'),
    pick: () => ipcRenderer.invoke('wallpaper:pick'),
    clear: () => ipcRenderer.invoke('wallpaper:clear'),
  },
  model: {
    test: (cfg) => ipcRenderer.invoke('model:test', cfg),
    list: (cfg) => ipcRenderer.invoke('model:list', cfg),
    chat: (id, cfg, messages, tools) => ipcRenderer.send('model:chat', { id, cfg, messages, tools }),
    abort: (id) => ipcRenderer.send('model:abort', id),
    abortAll: () => ipcRenderer.send('model:abort-all'),
    onEvent: (fn) => {
      const handler = (_e, payload) => fn(payload);
      ipcRenderer.on('model:event', handler);
      return () => ipcRenderer.removeListener('model:event', handler);
    },
  },
  secrets: {
    getProfiles: () => ipcRenderer.invoke('secrets:profiles:get'),
    setProfiles: (payload) => ipcRenderer.invoke('secrets:profiles:set', payload),
  },
  runtime: {
    apiVersion: '0.1',
    system: {
      health: () => ipcRenderer.invoke('runtime:system:health'),
    },
    events: {
      read: (query) => ipcRenderer.invoke('runtime:events:read', query),
      onEvent: (fn) => {
        const handler = (_e, event) => fn(event);
        ipcRenderer.on('runtime:event', handler);
        return () => ipcRenderer.removeListener('runtime:event', handler);
      },
    },
    tasks: {
      create: (input) => ipcRenderer.invoke('runtime:tasks:create', input),
      list: (query) => ipcRenderer.invoke('runtime:tasks:list', query),
      get: (taskId) => ipcRenderer.invoke('runtime:tasks:get', taskId),
      cancel: (input) => ipcRenderer.invoke('runtime:tasks:cancel', input),
      pause: (input) => ipcRenderer.invoke('runtime:tasks:pause', input),
      resume: (input) => ipcRenderer.invoke('runtime:tasks:resume', input),
    },
    settings: {
      get: () => ipcRenderer.invoke('runtime:settings:get'),
      set: (input) => ipcRenderer.invoke('runtime:settings:set', input),
    },
    agents: {
      list: () => ipcRenderer.invoke('runtime:agents:list'),
      get: (agentId) => ipcRenderer.invoke('runtime:agents:get', agentId),
      createVersion: (input) => ipcRenderer.invoke('runtime:agents:create-version', input),
      create: (input) => ipcRenderer.invoke('runtime:agents:create', input),
      update: (input) => ipcRenderer.invoke('runtime:agents:update', input),
      archive: (agentId) => ipcRenderer.invoke('runtime:agents:archive', agentId),
    },
    delegations: {
      list: (query) => ipcRenderer.invoke('runtime:delegations:list', query),
      get: (delegationId) => ipcRenderer.invoke('runtime:delegations:get', delegationId),
    },
    projects: {
      ensure: (input) => ipcRenderer.invoke('runtime:projects:ensure', input),
      list: () => ipcRenderer.invoke('runtime:projects:list'),
      get: (projectId) => ipcRenderer.invoke('runtime:projects:get', projectId),
      update: (input) => ipcRenderer.invoke('runtime:projects:update', input),
    },
    providers: {
      list: () => ipcRenderer.invoke('runtime:providers:list'),
    },
    runs: {
      get: (runId) => ipcRenderer.invoke('runtime:runs:get', runId),
      graph: (input) => ipcRenderer.invoke('runtime:runs:graph', input),
      beginStep: (input) => ipcRenderer.invoke('runtime:runs:begin-step', input),
      finishStep: (input) => ipcRenderer.invoke('runtime:runs:finish-step', input),
      modelStart: (input) => ipcRenderer.invoke('runtime:runs:model-start', input),
      modelFinish: (input) => ipcRenderer.invoke('runtime:runs:model-finish', input),
      finish: (input) => ipcRenderer.invoke('runtime:runs:finish', input),
    },
    tools: {
      propose: (input) => ipcRenderer.invoke('runtime:tools:propose', input),
      execute: (input) => ipcRenderer.invoke('runtime:tools:execute', input),
      reconcile: (input) => ipcRenderer.invoke('runtime:tools:reconcile', input),
    },
    approvals: {
      list: (query) => ipcRenderer.invoke('runtime:approvals:list', query),
      decide: (input) => ipcRenderer.invoke('runtime:approvals:decide', input),
    },
    audit: {
      read: (query) => ipcRenderer.invoke('runtime:audit:read', query),
      verify: () => ipcRenderer.invoke('runtime:audit:verify'),
    },
  },
  tools: {
    specs: () => ipcRenderer.invoke('tool:specs'),
    exec: (name, args, opts) => ipcRenderer.invoke('tool:exec', { name, args, opts }),
    defaultWorkspace: () => ipcRenderer.invoke('workspace:default'),
    pickWorkspace: (current) => ipcRenderer.invoke('workspace:pick', current),
  },
  /* 纯函数工具（无 IO）：渲染层用同一套估算口径，避免各处 /4 各算各的 */
  util: {
    estimateTokens: (text) => tokenEstimate.estimateTokens(text),
    estimateMessagesTokens: (messages) => tokenEstimate.estimateMessagesTokens(messages),
    planContextRead: (read, limits) => contextPlan.planContextRead(read, limits),
    contextPlanDefaults: { ...contextPlan.DEFAULT_LIMITS },
  },
  /* 备份浏览（R15/A7）：列出 userData/backups 下的时间戳快照，或打开某一份/根目录。
     恢复本身要先退出应用再覆盖文件，这里只提供「找到并打开」。 */
  backup: {
    list: () => ipcRenderer.invoke('backup:list'),
    open: (name) => ipcRenderer.invoke('backup:open', name),
  },
  /* 权限档位：权威值在主进程（dsh.perm）。set 只「请求」——提升到 full 由主进程弹原生
     确认框，降级直接生效；返回的 permission 是主进程裁定后的实际档位，调用方以此为准。 */
  permission: {
    get: () => ipcRenderer.invoke('permission:get'),
    set: (level) => ipcRenderer.invoke('permission:set', level),
  },
  mcp: {
    getServers: () => ipcRenderer.invoke('mcp:servers:get'),
    setServers: (list) => ipcRenderer.invoke('mcp:servers:set', list),
    startServer: (idOrCfg) => ipcRenderer.invoke('mcp:server:start', idOrCfg),
    stopServer: (id) => ipcRenderer.invoke('mcp:server:stop', id),
    listTools: (serverId) => ipcRenderer.invoke('mcp:tools:list', serverId),
    callTool: (serverId, name, args, timeoutMs) => ipcRenderer.invoke('mcp:tool:call', { serverId, name, args, timeoutMs }),
  },
  skills: {
    scan: (workspace) => ipcRenderer.invoke('skills:scan', { workspace }),
    read: (filePath, workspace) => ipcRenderer.invoke('skills:read', { path: filePath, workspace }),
    openDir: (workspace) => ipcRenderer.invoke('skills:open-dir', workspace),
  },
  /* Doctor 经验库检查（G4 妥协项修复）：统计概要 + 最近 5 条，只读；
     数据源 userData/runtime/lessons.jsonl，空库返回 { ok:false, reason:'empty' } */
  lessons: {
    summary: () => ipcRenderer.invoke('lessons:summary'),
    tail: () => ipcRenderer.invoke('lessons:tail'),
  },
  /* 文件存储（userData/dsh-storage.json）：localStorage 按 origin 键控，换构建方式历史必丢，
     真值源迁到主进程文件。snapshot 必须同步取（页面脚本执行前就要能同步读），
     之后写走 IPC 异步落盘；flush 供关闭前兜底。 */
  storage: {
    snapshot: STORAGE_SNAPSHOT,
    set: (key, value) => ipcRenderer.invoke('storage:set', { key, value }),
    setMany: (obj) => ipcRenderer.invoke('storage:set-many', obj),
    remove: (key) => ipcRenderer.invoke('storage:remove', key),
    flush: () => ipcRenderer.invoke('storage:flush'),
    stats: () => ipcRenderer.invoke('storage:stats'),
  },
});
