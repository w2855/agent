'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
});
