'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { newId } = require('./ids');
const model = require('./model');
const { listManifests } = require('./tool-registry');

/* 任务 / 运行 / 步骤 / 模型调用 / 工具调用 / 审批的本地快照。
   事件日志是事实来源，本文件保存可快速读取的当前状态；每次变更原子写盘。 */

const KEEP_TASKS = 300;
const TERMINAL_TASK = new Set(['succeeded', 'failed', 'canceled', 'expired']);
const TERMINAL_RUN = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);
const TERMINAL_DELEGATION = new Set(['succeeded', 'failed', 'canceled', 'rejected']);

class StateStore {
  constructor({ dir, events, now = Date.now } = {}) {
    if (!dir) throw new Error('StateStore 需要 dir');
    if (!events) throw new Error('StateStore 需要 events');
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'state.json');
    this.events = events;
    this.now = now;
    this.state = this._empty();
    this.ready = false;
  }

  _empty() {
    return {
      schemaVersion: 1,
      updatedAt: 0,
      taskOrder: [],
      tasks: {},
      runs: {},
      steps: {},
      modelCalls: {},
      toolCalls: {},
      approvals: {},
      delegations: {},
      delegationOrder: [],
      agents: {},
      agentVersions: {},
      providers: {},
      projects: {},
      defaultAgentId: null,
      settings: { maxConcurrentRuns: 4 },
    };
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    let corrupted = false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.schemaVersion === 1) {
        this.state = { ...this._empty(), ...raw };
        if (!Array.isArray(this.state.taskOrder)) this.state.taskOrder = Object.keys(this.state.tasks);
        this.state.settings = { ...this._empty().settings, ...(raw.settings || {}) };
      }
    } catch {
      /* 首次启动或快照损坏，从空状态开始；损坏时留下备份并告警 */
      if (fs.existsSync(this.file)) {
        corrupted = true;
        try { fs.copyFileSync(this.file, this.file + '.corrupt'); } catch { /* 忽略 */ }
        console.error(`[runtime] 状态快照损坏，已备份到 ${this.file}.corrupt，本次从空状态启动`);
      }
    }
    this.ready = true;
    this._ensureDefaultAgent();
    this._migrateDefaultAgentTools();
    this.recoverInterrupted();
    if (corrupted) {
      this._append('state.corrupt-recovered', { payload: { backup: this.file + '.corrupt' } });
    }
    return this;
  }

  _migrateDefaultAgentTools() {
    const agent = this.getDefaultAgent();
    const version = agent ? this.state.agentVersions[`${agent.id}@${agent.currentVersion}`] : null;
    const allow = version?.toolPolicy?.allow;
    if (!Array.isArray(allow)) return;
    // 内置默认 Agent 历来登记的是「完整工具集」，补齐后续新增的工具；
    // 用户自定义过的工具列表不在迁移范围内。
    const base = new Set(['list_dir', 'read_file', 'write_file', 'search_files', 'run_command', 'fetch_url', 'todo_write']);
    const extras = ['delegate_task', 'project_architecture'];
    if (!allow.every((name) => base.has(name) || extras.includes(name))) return;
    const missing = extras.filter((name) => !allow.includes(name));
    if (!missing.length) return;
    version.toolPolicy = { ...version.toolPolicy, allow: [...allow, ...missing] };
    version.updatedAt = this.now();
    this._append('agent.updated', {
      payload: { agentId: agent.id, fromVersion: agent.currentVersion, toVersion: agent.currentVersion, reason: 'enable_new_tools' },
    });
    this._persist();
  }

  _ensureDefaultAgent() {
    if (Object.keys(this.state.agents).length) {
      this.defaultAgentId = this.state.agents[this.state.defaultAgentId]
        ? this.state.defaultAgentId
        : Object.keys(this.state.agents)[0];
      return;
    }
    const now = this.now();
    const agent = {
      id: newId('agt', now),
      workspaceId: this.events.workspaceId,
      name: '默认 Agent',
      description: '本地通用任务 Agent',
      status: 'active',
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };
    const version = {
      id: newId('aver', now),
      agentId: agent.id,
      version: 1,
      systemPrompt: '',
      // 空模型表示沿用当前连接的 Provider/Model，可在后续 Agent 配置页覆盖
      model: { providerId: '', model: '' },
      toolPolicy: { allow: listManifests().map((m) => m.name), deny: [] },
      permissionProfileId: 'full',
      memoryPolicy: { enabled: false, scopes: ['workspace'], autoWrite: 'never' },
      budget: {},
      createdAt: now,
      createdBy: { kind: 'user', id: 'local-user' },
      schemaVersion: 1,
    };
    this.state.agents[agent.id] = agent;
    this.state.agentVersions[`${agent.id}@1`] = version;
    this.defaultAgentId = agent.id;
    this.state.defaultAgentId = agent.id;
    this._append('agent.updated', { payload: { agentId: agent.id, fromVersion: 0, toVersion: 1 } });
    this._persist();
  }

  getDefaultAgent() {
    return this.state.agents[this.defaultAgentId] || Object.values(this.state.agents)[0] || null;
  }

  listAgents() {
    return Object.values(this.state.agents).map((agent) => ({
      ...agent,
      version: this.state.agentVersions[`${agent.id}@${agent.currentVersion}`] || null,
    }));
  }

  getAgent(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent) return null;
    const versions = Object.values(this.state.agentVersions)
      .filter((v) => v.agentId === agentId)
      .sort((a, b) => b.version - a.version);
    return { agent, currentVersion: versions.find((v) => v.version === agent.currentVersion) || null, versions };
  }

  getAgentVersion(agentId, version) {
    const agent = this.state.agents[agentId];
    if (!agent) return null;
    const v = Number.isInteger(version) ? version : agent.currentVersion;
    return this.state.agentVersions[`${agentId}@${v}`] || null;
  }

  createAgentVersion({ agentId, patch = {}, createdBy = { kind: 'user', id: 'local-user' } } = {}) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error(`Agent 不存在：${agentId}`);
    const prev = this.state.agentVersions[`${agentId}@${agent.currentVersion}`] || {};
    const nextVersion = agent.currentVersion + 1;
    const version = {
      ...prev,
      id: newId('aver'),
      agentId,
      version: nextVersion,
      systemPrompt: typeof patch.systemPrompt === 'string' ? patch.systemPrompt : prev.systemPrompt || '',
      model: patch.model && typeof patch.model === 'object' ? { ...(prev.model || {}), ...patch.model } : prev.model || { providerId: '', model: '' },
      toolPolicy: patch.toolPolicy && typeof patch.toolPolicy === 'object' ? patch.toolPolicy : prev.toolPolicy || { allow: [], deny: [] },
      permissionProfileId: ['full', 'ask', 'readonly'].includes(patch.permissionProfileId) ? patch.permissionProfileId : prev.permissionProfileId || 'full',
      budget: patch.budget && typeof patch.budget === 'object' ? patch.budget : prev.budget || {},
      createdAt: this.now(),
      createdBy,
      schemaVersion: 1,
    };
    this.state.agentVersions[`${agentId}@${nextVersion}`] = version;
    const fromVersion = agent.currentVersion;
    agent.currentVersion = nextVersion;
    agent.updatedAt = this.now();
    this._append('agent.updated', { payload: { agentId, fromVersion, toVersion: nextVersion } });
    this._persist();
    return version;
  }

  createAgent(input = {}) {
    const name = String(input.name || '').trim().slice(0, 60);
    if (!name) throw new Error('Agent 名称不能为空');
    if (Object.values(this.state.agents).some((a) => a.status !== 'archived' && a.name === name)) {
      throw new Error(`Agent 名称已存在：${name}`);
    }
    const now = this.now();
    const allTools = listManifests().map((m) => m.name);
    const requested = Array.isArray(input.toolPolicy?.allow) ? input.toolPolicy.allow.filter((n) => allTools.includes(n)) : allTools;
    const deny = Array.isArray(input.toolPolicy?.deny) ? input.toolPolicy.deny.filter((n) => allTools.includes(n)) : [];
    const agent = {
      id: newId('agt', now),
      workspaceId: this.events.workspaceId,
      name,
      description: String(input.description || '').slice(0, 200),
      status: 'active',
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };
    const version = {
      id: newId('aver', now),
      agentId: agent.id,
      version: 1,
      systemPrompt: String(input.systemPrompt || '').slice(0, 4000),
      model: {
        providerId: String(input.model?.providerId || ''),
        model: String(input.model?.model || '').slice(0, 128),
      },
      toolPolicy: { allow: requested, deny },
      permissionProfileId: ['full', 'ask', 'readonly'].includes(input.permissionProfileId) ? input.permissionProfileId : 'ask',
      memoryPolicy: { enabled: false, scopes: ['workspace'], autoWrite: 'never' },
      budget: input.budget && typeof input.budget === 'object' ? input.budget : {},
      createdAt: now,
      createdBy: { kind: 'user', id: 'local-user' },
      schemaVersion: 1,
    };
    this.state.agents[agent.id] = agent;
    this.state.agentVersions[`${agent.id}@1`] = version;
    this._append('agent.updated', { payload: { agentId: agent.id, fromVersion: 0, toVersion: 1, name } });
    this._persist();
    return { agent, version };
  }

  updateAgent(input = {}) {
    const agent = this.state.agents[String(input.agentId || '')];
    if (!agent) throw new Error(`Agent 不存在：${input.agentId}`);
    if (agent.status === 'archived') throw new Error('已归档的 Agent 不能修改');
    if (typeof input.name === 'string' && input.name.trim()) {
      const name = input.name.trim().slice(0, 60);
      if (Object.values(this.state.agents).some((a) => a.id !== agent.id && a.status !== 'archived' && a.name === name)) {
        throw new Error(`Agent 名称已存在：${name}`);
      }
      agent.name = name;
    }
    if (typeof input.description === 'string') agent.description = input.description.slice(0, 200);
    agent.updatedAt = this.now();
    const version = input.patch && typeof input.patch === 'object'
      ? this.createAgentVersion({ agentId: agent.id, patch: input.patch })
      : null;
    this._persist();
    return { agent, version };
  }

  archiveAgent(agentId) {
    const agent = this.state.agents[String(agentId || '')];
    if (!agent) throw new Error(`Agent 不存在：${agentId}`);
    if (agent.status === 'archived') return agent;
    if (agent.id === this.defaultAgentId) throw new Error('默认 Agent 不能归档');
    agent.status = 'archived';
    agent.archivedAt = this.now();
    agent.updatedAt = this.now();
    this._append('agent.updated', {
      payload: { agentId: agent.id, fromVersion: agent.currentVersion, toVersion: agent.currentVersion, status: 'archived' },
    });
    this._persist();
    return agent;
  }

  /* ---------------- 项目 / 主控 Agent ---------------- */

  findProjectByWorkspace(workspace) {
    const raw = String(workspace || '').trim();
    if (!raw) return null;
    const normalized = path.resolve(raw);
    return Object.values(this.state.projects).find((p) => p.workspace && path.resolve(p.workspace) === normalized) || null;
  }

  listProjects() {
    return Object.values(this.state.projects).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  getProject(projectId) {
    return this.state.projects[String(projectId || '')] || null;
  }

  createProject(input = {}) {
    const workspace = path.resolve(String(input.workspace || ''));
    const existing = this.findProjectByWorkspace(workspace);
    if (existing) return existing;
    const now = this.now();
    const wantedMain = String(input.mainAgentId || '');
    const mainAgent = this.state.agents[wantedMain]?.status === 'active'
      ? this.state.agents[wantedMain]
      : this.getDefaultAgent();
    const project = {
      id: newId('prj', now),
      workspaceId: this.events.workspaceId,
      workspace,
      name: String(input.name || path.basename(workspace) || '未命名项目').slice(0, 80),
      description: String(input.description || '').slice(0, 300),
      goal: String(input.goal || '').slice(0, 2000),
      mainAgentId: mainAgent?.id || null,
      status: 'draft',
      techStack: Array.isArray(input.techStack)
        ? input.techStack
        : (Array.isArray(input.discovery?.techStack) ? input.discovery.techStack : []),
      nodes: [],
      edges: [],
      milestones: [],
      discovery: input.discovery && typeof input.discovery === 'object' ? input.discovery : null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };
    this.state.projects[project.id] = project;
    this._append('project.updated', {
      payload: {
        projectId: project.id,
        revision: project.revision,
        source: 'ensure',
        workspace: project.workspace,
        name: project.name,
        mainAgentId: project.mainAgentId,
        nodeCount: 0,
        edgeCount: 0,
      },
    });
    this._persist();
    return project;
  }

  applyProject(projectId, { fields = {}, source = 'update', detail = {} } = {}) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    Object.assign(project, fields);
    project.revision = (project.revision || 1) + 1;
    project.updatedAt = this.now();
    this._append('project.updated', {
      payload: {
        projectId: project.id,
        revision: project.revision,
        source,
        workspace: project.workspace,
        name: project.name,
        mainAgentId: project.mainAgentId,
        nodeCount: project.nodes.length,
        edgeCount: project.edges.length,
        ...detail,
      },
    });
    this._persist();
    return project;
  }

  registerProvider(baseUrl, id) {
    if (!baseUrl) return null;
    let host = baseUrl;
    try { host = new URL(baseUrl).host; } catch { /* 非 URL 时保留原值 */ }
    const existing = this.state.providers[id];
    if (existing) {
      if (existing.baseUrl !== baseUrl) {
        existing.baseUrl = baseUrl;
        existing.updatedAt = this.now();
        this._append('provider.updated', { payload: { providerId: id, changed: ['baseUrl'] } });
        this._persist();
      }
      return existing;
    }
    const provider = {
      id,
      workspaceId: this.events.workspaceId,
      name: host,
      baseUrl,
      createdAt: this.now(),
      schemaVersion: 1,
    };
    this.state.providers[id] = provider;
    this._append('provider.updated', { payload: { providerId: id, changed: ['baseUrl'] } });
    this._persist();
    return provider;
  }

  listProviders() {
    return Object.values(this.state.providers);
  }

  _persist() {
    this.state.updatedAt = this.now();
    const raw = JSON.stringify(this.state);
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, raw);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, this.file);
    } catch {
      /* rename 失败（如跨卷/占用）时退化为备份+覆盖，绝不直接覆盖正式文件 */
      try { fs.copyFileSync(this.file, this.file + '.bak'); } catch { /* 首次无旧文件 */ }
      const fd = fs.openSync(this.file, 'w');
      try {
        fs.writeFileSync(fd, raw);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    }
  }

  _append(type, fields) {
    return this.events.append({ type, ...fields });
  }

  /* ---------------- 任务 / 运行 ---------------- */

  createTask(input = {}) {
    const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : '';
    if (idempotencyKey) {
      for (const id of this.state.taskOrder) {
        const t = this.state.tasks[id];
        if (t && t.idempotencyKey === idempotencyKey) {
          const runs = this.listRuns({ taskId: id, limit: 1 }).runs;
          return { task: t, run: runs[0] || null, deduped: true };
        }
      }
    }

    const agentId = input.agentId || this.defaultAgentId || 'agent_local';
    const agent = this.state.agents[agentId];
    const parent = input.parentTaskId ? this.state.tasks[input.parentTaskId] : null;
    const rootTaskId = input.rootTaskId
      || parent?.rootTaskId
      || parent?.id
      || null;
    const task = model.baseTask({
      workspaceId: this.events.workspaceId,
      workspace: typeof input.workspace === 'string' && input.workspace ? input.workspace : undefined,
      agentId,
      agentVersion: input.agentVersion || agent?.currentVersion || 1,
      title: input.title || '本地对话',
      input: typeof input.input === 'string' ? input.input.slice(0, 500) : '',
      priority: input.priority,
      parentTaskId: input.parentTaskId,
      rootTaskId: rootTaskId || undefined,
      idempotencyKey: idempotencyKey || undefined,
    });
    if (!task.rootTaskId) task.rootTaskId = task.id;
    task.delegationDepth = Number.isInteger(input.delegationDepth) ? input.delegationDepth : 0;
    if (input.delegationId) task.delegationId = input.delegationId;
    if (typeof input.expectedOutput === 'string') task.expectedOutput = input.expectedOutput.slice(0, 500);
    this.state.tasks[task.id] = task;
    this.state.taskOrder.push(task.id);
    this._append('task.created', {
      taskId: task.id,
      actor: { kind: 'user', id: 'local-user' },
      payload: {
        agentId: task.agentId,
        title: task.title,
        priority: task.priority,
        inputPreview: task.input,
        parentTaskId: task.parentTaskId,
        rootTaskId: task.rootTaskId,
        delegationDepth: task.delegationDepth,
      },
    });

    model.assertTransition('task', 'created', 'queued');
    task.status = 'queued';
    task.providerId = input.providerId;
    task.model = input.model;
    task.budget = input.budget;
    this._reindexQueue();
    this._append('task.queued', { taskId: task.id, payload: { queuePosition: task.queuePosition ?? 1 } });

    const run = this._admitTask(task);
    this._prune();
    this._persist();
    return { task, run, deduped: false };
  }

  /* ---------------- 队列与并发 ---------------- */

  _activeRunCount() {
    return Object.values(this.state.runs).filter((r) => r.status === 'running' || r.status === 'waiting_approval').length;
  }

  _reindexQueue() {
    let position = 0;
    for (const id of this.state.taskOrder) {
      const task = this.state.tasks[id];
      if (!task) continue;
      if (task.status === 'queued') {
        position++;
        task.queuePosition = position;
      } else if (task.queuePosition != null) {
        delete task.queuePosition;
      }
    }
    return position;
  }

  _admitTask(task) {
    if (!task || task.status !== 'queued') return null;
    const limit = Math.max(1, Number(this.state.settings?.maxConcurrentRuns) || 1);
    if (this._activeRunCount() >= limit) return null;
    const run = this._createRun(task, {
      providerId: task.providerId,
      model: task.model,
      budget: task.budget,
      workspace: task.workspace,
    });
    model.assertTransition('task', 'queued', 'running');
    task.status = 'running';
    task.startedAt = this.now();
    delete task.queuePosition;
    this._reindexQueue();
    this._append('task.started', { taskId: task.id, runId: run.id, payload: { runId: run.id } });
    this._append('run.started', {
      taskId: task.id,
      runId: run.id,
      payload: {
        attempt: run.attempt,
        resumeOfRunId: run.resumeOfRunId,
        providerId: run.providerId,
        model: run.model,
        budget: run.budget,
      },
    });
    this._persist();
    return run;
  }

  _drainQueue() {
    const limit = Math.max(1, Number(this.state.settings?.maxConcurrentRuns) || 1);
    let promoted = 0;
    for (const id of this.state.taskOrder) {
      const task = this.state.tasks[id];
      if (!task || task.status !== 'queued') continue;
      if (this._activeRunCount() >= limit) break;
      if (this._admitTask(task)) promoted++;
    }
    this._reindexQueue();
    if (promoted) this._persist();
    return promoted;
  }

  getSettings() {
    return { maxConcurrentRuns: Math.max(1, Number(this.state.settings?.maxConcurrentRuns) || 1) };
  }

  queueStats() {
    return {
      maxConcurrentRuns: this.getSettings().maxConcurrentRuns,
      activeRuns: this._activeRunCount(),
      queued: Object.values(this.state.tasks).filter((t) => t.status === 'queued').length,
      paused: Object.values(this.state.tasks).filter((t) => t.status === 'paused').length,
    };
  }

  setSettings(patch = {}) {
    if (patch.maxConcurrentRuns != null) {
      const next = Math.max(1, Math.min(16, Number(patch.maxConcurrentRuns) || 1));
      this.state.settings.maxConcurrentRuns = next;
    }
    this._persist();
    this._drainQueue();
    return this.getSettings();
  }

  pauseTask({ taskId, reason = 'user_paused' } = {}) {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.status === 'paused') return task;
    if (task.status !== 'queued') throw new Error('仅排队中的任务支持暂停；运行中暂停需要 Orchestrator 协作');
    model.assertTransition('task', 'queued', 'paused');
    task.status = 'paused';
    task.pausedAt = this.now();
    this._reindexQueue();
    this._append('task.paused', { taskId, actor: { kind: 'user', id: 'local-user' }, payload: { reason } });
    this._persist();
    return task;
  }

  resumeTask({ taskId, reason = 'user_resumed' } = {}) {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.status !== 'paused') throw new Error('只有已暂停的任务可以恢复');
    model.assertTransition('task', 'paused', 'queued');
    task.status = 'queued';
    this._reindexQueue();
    this._append('task.resumed', { taskId, actor: { kind: 'user', id: 'local-user' }, payload: { reason } });
    const run = this._admitTask(task);
    this._persist();
    return { task, run };
  }

  _createRun(task, opts = {}) {
    const previous = Object.values(this.state.runs).filter((r) => r.taskId === task.id);
    const run = model.baseRun({
      taskId: task.id,
      agentId: task.agentId,
      agentVersion: task.agentVersion,
      attempt: opts.attempt || previous.length + 1,
      resumeOfRunId: opts.resumeOfRunId,
      providerId: opts.providerId,
      model: opts.model,
      budget: opts.budget,
      workspace: opts.workspace,
    });
    this.state.runs[run.id] = run;
    model.assertTransition('run', 'pending', 'running');
    run.status = 'running';
    return run;
  }

  getTask(taskId) {
    return this.state.tasks[taskId] || null;
  }

  getRun(runId) {
    return this.state.runs[runId] || null;
  }

  setRunEffectiveProfile(runId, profile) {
    const run = this.state.runs[runId];
    if (!run || !['full', 'ask', 'readonly'].includes(profile) || run.effectiveProfile === profile) return;
    run.effectiveProfile = profile;
    this._persist();
  }

  applyDelegationScope(runId, { toolAllow, delegationId, effectiveProfile } = {}) {
    const run = this.state.runs[runId];
    if (!run) return null;
    if (Array.isArray(toolAllow)) run.delegationToolAllow = [...toolAllow];
    if (delegationId) run.delegationId = delegationId;
    if (['full', 'ask', 'readonly'].includes(effectiveProfile)) run.effectiveProfile = effectiveProfile;
    this._persist();
    return run;
  }

  /** 断点续跑：把因重启中断的子 Run 重新置回 running（仅限带检查点的委派）。 */
  resumeRunForDelegation(runId) {
    const run = this.state.runs[runId];
    if (!run) throw new Error(`运行不存在：${runId}`);
    if (run.status !== 'interrupted') return run;
    model.assertTransition('run', 'interrupted', 'running');
    run.status = 'running';
    run.endedAt = undefined;
    this._append('run.status_changed', { taskId: run.taskId, runId, payload: { from: 'interrupted', to: 'running', reason: 'delegation_checkpoint_resume' } });
    const task = this.state.tasks[run.taskId];
    if (task && task.status === 'failed') {
      task.status = 'running';
      task.finishedAt = undefined;
      this._append('task.status_changed', { taskId: task.id, runId, payload: { from: 'failed', to: 'running', reason: 'delegation_checkpoint_resume' } });
    }
    this._persist();
    return run;
  }

  listTasks({ limit = 50, status, agentId } = {}) {
    const max = Math.max(1, Math.min(200, Number(limit) || 50));
    const out = [];
    for (let i = this.state.taskOrder.length - 1; i >= 0 && out.length < max; i--) {
      const task = this.state.tasks[this.state.taskOrder[i]];
      if (!task) continue;
      if (status && task.status !== status) continue;
      if (agentId && task.agentId !== agentId) continue;
      out.push(task);
    }
    return { tasks: out };
  }

  listRuns({ taskId, limit = 50 } = {}) {
    const max = Math.max(1, Math.min(100, Number(limit) || 50));
    const runs = Object.values(this.state.runs)
      .filter((r) => !taskId || r.taskId === taskId)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, max);
    return { runs };
  }

  /* ---------------- 委派 ---------------- */

  createDelegationRecord(input = {}) {
    const now = this.now();
    const record = {
      id: newId('del', now),
      parentTaskId: input.parentTaskId,
      parentRunId: input.parentRunId,
      parentAgentId: input.parentAgentId,
      targetAgentId: input.targetAgentId,
      targetAgentVersion: input.targetAgentVersion,
      childTaskId: input.childTaskId,
      childRunId: input.childRunId,
      objective: String(input.objective || '').slice(0, 2000),
      expectedOutput: String(input.expectedOutput || '').slice(0, 500),
      contextRefs: Array.isArray(input.contextRefs) ? input.contextRefs.slice(0, 10) : [],
      budget: input.budget && typeof input.budget === 'object' ? input.budget : {},
      effectiveProfile: input.effectiveProfile,
      toolAllow: Array.isArray(input.toolAllow) ? input.toolAllow : [],
      depth: Number.isInteger(input.depth) ? input.depth : 1,
      rootTaskId: input.rootTaskId,
      workspace: input.workspace,
      status: 'queued',
      createdAt: now,
      /* 断点续跑检查点：子 Agent 每回合完成后写入 messages/用量，
         重启恢复时从这里继续而不是重头执行（借鉴 LangGraph checkpoint）。 */
      checkpoint: null,
      schemaVersion: 1,
    };
    this.state.delegations[record.id] = record;
    this.state.delegationOrder.push(record.id);
    this._persist();
    return record;
  }

  /** 保存/清除子 Agent 检查点（messages 需可 JSON 序列化）。 */
  saveDelegationCheckpoint(delegationId, checkpoint) {
    const record = this.state.delegations[delegationId];
    if (!record) return null;
    record.checkpoint = checkpoint && typeof checkpoint === 'object'
      ? {
        messages: Array.isArray(checkpoint.messages) ? checkpoint.messages.slice(-200) : [],
        modelCalls: Number(checkpoint.modelCalls) || 0,
        tokens: Number(checkpoint.tokens) || 0,
        finalText: String(checkpoint.finalText || '').slice(0, 5000),
        savedAt: this.now(),
      }
      : null;
    this._persist();
    return record.checkpoint;
  }

  getDelegation(delegationId) {
    return this.state.delegations[delegationId] || null;
  }

  listDelegations({ parentRunId, parentTaskId, childTaskId, status, limit = 50 } = {}) {
    const max = Math.max(1, Math.min(200, Number(limit) || 50));
    return {
      delegations: Object.values(this.state.delegations)
        .filter((d) => (!parentRunId || d.parentRunId === parentRunId)
          && (!parentTaskId || d.parentTaskId === parentTaskId)
          && (!childTaskId || d.childTaskId === childTaskId)
          && (!status || d.status === status))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, max),
    };
  }

  updateDelegation(delegationId, patch = {}) {
    const record = this.state.delegations[delegationId];
    if (!record) throw new Error(`委派不存在：${delegationId}`);
    Object.assign(record, patch);
    this._persist();
    return record;
  }

  _cancelDelegationsForTask(taskId, reason) {
    for (const record of Object.values(this.state.delegations)) {
      if (TERMINAL_DELEGATION.has(record.status)) continue;
      if (record.parentTaskId !== taskId && record.childTaskId !== taskId) continue;
      record.status = 'canceled';
      record.finishedAt = this.now();
      record.errorCode = reason === 'parent_canceled' ? 'PARENT_CANCELED' : 'TASK_CANCELED';
      this._append('delegation.canceled', {
        taskId: record.parentTaskId,
        runId: record.parentRunId,
        payload: {
          delegationId: record.id,
          childTaskId: record.childTaskId,
          childRunId: record.childRunId,
          cascade: record.parentTaskId === taskId,
          reason,
        },
      });
    }
  }

  getRunDetail(runId) {
    const run = this.state.runs[runId];
    if (!run) return null;
    return {
      run,
      task: this.state.tasks[run.taskId] || null,
      steps: Object.values(this.state.steps).filter((s) => s.runId === runId),
      modelCalls: Object.values(this.state.modelCalls).filter((m) => m.runId === runId),
      toolCalls: Object.values(this.state.toolCalls).filter((t) => t.runId === runId),
      approvals: Object.values(this.state.approvals).filter((a) => a.runId === runId),
      delegations: Object.values(this.state.delegations).filter((d) => d.parentRunId === runId),
    };
  }

  cancelTask({ taskId, reason = 'user_canceled' } = {}) {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (TERMINAL_TASK.has(task.status)) return task;
    // MA-4：父任务取消必须级联取消所有未终态子任务
    for (const child of Object.values(this.state.tasks)) {
      if (child.parentTaskId !== taskId || TERMINAL_TASK.has(child.status)) continue;
      this.cancelTask({ taskId: child.id, reason: 'parent_canceled' });
    }
    this._cancelDelegationsForTask(taskId, reason);
    for (const run of Object.values(this.state.runs)) {
      if (run.taskId !== taskId || TERMINAL_RUN.has(run.status)) continue;
      this._cancelRun(run, reason);
    }
    if (task.status === 'waiting_approval') {
      this._cancelApprovals(taskId, reason);
    }
    task.status = 'canceled';
    task.finishedAt = this.now();
    this._reindexQueue();
    this._append('task.canceled', { taskId: task.id, actor: { kind: 'user', id: 'local-user' }, payload: { reason } });
    this._persist();
    this._drainQueue();
    return task;
  }

  _cancelRun(run, reason) {
    const from = run.status;
    this._cancelApprovals(run.taskId, reason, run.id);
    for (const call of Object.values(this.state.toolCalls)) {
      if (call.runId !== run.id || model.isTerminal('toolCall', call.status)) continue;
      if (call.status === 'succeeded' || call.status === 'failed' || call.status === 'denied') continue;
      try {
        model.assertTransition('toolCall', call.status, 'canceled');
        call.status = 'canceled';
        call.deniedReason = reason;
        this._append('tool.canceled', {
          taskId: call.taskId,
          runId: call.runId,
          stepId: call.stepId,
          payload: { toolCallId: call.id, reason },
        });
      } catch { /* 状态已不可取消 */ }
    }
    for (const step of Object.values(this.state.steps)) {
      if (step.runId !== run.id || model.isTerminal('step', step.status)) continue;
      try {
        model.assertTransition('step', step.status, 'canceled');
        step.status = 'canceled';
        step.endedAt = this.now();
        this._append('step.finished', {
          taskId: run.taskId,
          runId: run.id,
          stepId: step.id,
          payload: { status: 'canceled', modelCallId: step.modelCallId, toolCallIds: step.toolCallIds },
        });
      } catch { /* 状态已不可取消 */ }
    }
    model.assertTransition('run', from, 'canceled');
    run.status = 'canceled';
    run.endedAt = this.now();
    this._append('run.status_changed', { taskId: run.taskId, runId: run.id, payload: { from, to: 'canceled', reason } });
    this._append('run.finished', {
      taskId: run.taskId,
      runId: run.id,
      payload: { outcome: 'canceled', usage: run.usage, validated: false, reason },
    });
  }

  finishRun({ runId, outcome = 'succeeded', usage, validated = false, summary = '', errorCode, checks = [] } = {}) {
    const run = this.state.runs[runId];
    if (!run) throw new Error(`运行不存在：${runId}`);
    if (TERMINAL_RUN.has(run.status)) {
      return { run, task: this.state.tasks[run.taskId] || null, deduped: true };
    }
    const list = Array.isArray(checks) ? checks.filter((c) => c && typeof c === 'object' && c.name) : [];
    const validationStatus = list.length ? (list.some((c) => c.status === 'failed') ? 'failed' : 'passed') : 'skipped';
    let to = ['succeeded', 'failed', 'canceled', 'interrupted'].includes(outcome) ? outcome : 'failed';
    let finalErrorCode = errorCode;
    if (to === 'succeeded' && validationStatus === 'failed') {
      to = 'failed';
      finalErrorCode = 'VALIDATION_FAILED';
    }
    if (run.status === 'waiting_approval') model.assertTransition('run', 'waiting_approval', to === 'succeeded' ? 'failed' : to);
    else model.assertTransition('run', run.status, to);
    if (usage && typeof usage === 'object') run.usage = { ...run.usage, ...usage };
    run.status = to;
    run.endedAt = this.now();
    run.validated = to === 'succeeded' && (validated === true || validationStatus === 'passed');

    const task = this.state.tasks[run.taskId];
    this._append('validation.completed', {
      taskId: run.taskId,
      runId: run.id,
      payload: { status: validationStatus, checks: list },
    });
    this._append('run.finished', {
      taskId: run.taskId,
      runId: run.id,
      payload: { outcome: to, usage: run.usage, validated: run.validated, errorCode: finalErrorCode || undefined },
    });

    if (task && !TERMINAL_TASK.has(task.status)) {
      const taskTo = to === 'succeeded' ? 'succeeded' : to === 'canceled' ? 'canceled' : 'failed';
      if (task.status === 'waiting_approval') model.assertTransition('task', 'waiting_approval', taskTo);
      else model.assertTransition('task', task.status, taskTo);
      task.status = taskTo;
      task.finishedAt = this.now();
      this._append('task.finished', {
        taskId: task.id,
        runId: run.id,
        payload: {
          status: taskTo,
          resultSummary: typeof summary === 'string' ? summary.slice(0, 500) : '',
          errorCode: finalErrorCode || undefined,
        },
      });
    }
    this._persist();
    this._drainQueue();
    return { run, task, validation: { status: validationStatus, checks: list }, errorCode: finalErrorCode };
  }

  /* ---------------- 步骤 / 模型调用 ---------------- */

  beginStep({ runId, kind = 'model', index } = {}) {
    const run = this.state.runs[runId];
    if (!run) throw new Error(`运行不存在：${runId}`);
    if (TERMINAL_RUN.has(run.status)) throw new Error('运行已结束');
    const step = model.baseStep({ runId, kind, index: Number.isInteger(index) ? index : this._nextStepIndex(runId) });
    step.status = 'running';
    this.state.steps[step.id] = step;
    run.currentStepIndex = step.index;
    this._append('step.started', { taskId: run.taskId, runId, stepId: step.id, payload: { index: step.index, kind } });
    this._persist();
    return step;
  }

  _nextStepIndex(runId) {
    let max = -1;
    for (const s of Object.values(this.state.steps)) {
      if (s.runId === runId && Number.isInteger(s.index) && s.index > max) max = s.index;
    }
    return max + 1;
  }

  finishStep({ stepId, status = 'succeeded', modelCallId, toolCallIds } = {}) {
    const step = this.state.steps[stepId];
    if (!step) throw new Error(`步骤不存在：${stepId}`);
    if (model.isTerminal('step', step.status)) return step;
    const to = ['succeeded', 'failed', 'canceled', 'skipped'].includes(status) ? status : 'failed';
    model.assertTransition('step', step.status, to);
    step.status = to;
    step.endedAt = this.now();
    if (modelCallId) step.modelCallId = modelCallId;
    if (Array.isArray(toolCallIds)) step.toolCallIds = toolCallIds;
    const run = this.state.runs[step.runId];
    this._append('step.finished', {
      taskId: run?.taskId,
      runId: step.runId,
      stepId: step.id,
      payload: { status: to, modelCallId: step.modelCallId, toolCallIds: step.toolCallIds },
    });
    this._persist();
    return step;
  }

  beginModelCall({ runId, stepId, providerId, model: modelName, messageCount = 0, approxInputTokens = 0, requestDigest = '' } = {}) {
    const run = this.state.runs[runId];
    if (!run) throw new Error(`运行不存在：${runId}`);
    const call = {
      id: newId('mcall'),
      runId,
      stepId,
      providerId: providerId || run.providerId || '',
      model: modelName || run.model || '',
      status: 'started',
      messageCount: Math.max(0, Number(messageCount) || 0),
      approxInputTokens: Math.max(0, Number(approxInputTokens) || 0),
      requestDigest: typeof requestDigest === 'string' ? requestDigest : '',
      startedAt: this.now(),
      schemaVersion: 1,
    };
    this.state.modelCalls[call.id] = call;
    run.usage.modelCalls++;
    this._append('model.request_started', {
      taskId: run.taskId,
      runId,
      stepId,
      payload: {
        modelCallId: call.id,
        providerId: call.providerId,
        model: call.model,
        requestDigest: call.requestDigest,
        messageCount: call.messageCount,
        approxInputTokens: call.approxInputTokens,
      },
    });
    this._persist();
    return call;
  }

  finishModelCall({ modelCallId, status = 'completed', usage, finishReason, error, attempts } = {}) {
    const call = this.state.modelCalls[modelCallId];
    if (!call) throw new Error(`模型调用不存在：${modelCallId}`);
    if (model.isTerminal('modelCall', call.status)) return call;
    const to = ['completed', 'failed', 'aborted'].includes(status) ? status : 'failed';
    model.assertTransition('modelCall', call.status, to);
    call.status = to;
    call.endedAt = this.now();
    if (finishReason) call.finishReason = String(finishReason).slice(0, 40);
    if (usage && typeof usage === 'object') call.usage = usage;
    const run = this.state.runs[call.runId];
    if (run && usage && typeof usage === 'object') {
      run.usage.inputTokens += Number(usage.prompt_tokens) || 0;
      run.usage.outputTokens += Number(usage.completion_tokens) || 0;
    }
    if (to === 'completed') {
      this._append('model.completed', {
        taskId: run?.taskId, runId: call.runId, stepId: call.stepId,
        payload: { modelCallId, usage: usage || null, finishReason: call.finishReason, responseDigest: '' },
      });
    } else if (to === 'aborted') {
      this._append('model.aborted', {
        taskId: run?.taskId, runId: call.runId, stepId: call.stepId,
        payload: { modelCallId },
      });
    } else {
      this._append('model.failed', {
        taskId: run?.taskId, runId: call.runId, stepId: call.stepId,
        payload: {
          modelCallId,
          code: String(error?.code || 'MODEL_ERROR').slice(0, 60),
          message: String(error?.message || '').slice(0, 300),
          retryable: error?.retryable === true,
          attempts: Number(attempts) || 0,
        },
      });
    }
    this._persist();
    return call;
  }

  /* ---------------- 工具调用 / 审批 ---------------- */

  createToolCall(input = {}) {
    const run = this.state.runs[input.runId];
    if (!run) throw new Error(`运行不存在：${input.runId}`);
    const call = model.baseToolCall({
      runId: input.runId,
      stepId: input.stepId,
      name: input.name,
      version: input.version,
      args: input.args,
      argsDigest: input.argsDigest,
      sideEffect: input.sideEffect,
      risk: input.risk,
      policyDecisionId: input.policyDecisionId,
    });
    call.taskId = run.taskId;
    call.workspace = input.workspace || run.workspace;
    call.modelToolCallId = input.modelToolCallId;
    this.state.toolCalls[call.id] = call;
    if (input.stepId && this.state.steps[input.stepId]) {
      this.state.steps[input.stepId].toolCallIds.push(call.id);
    }
    run.usage.toolCalls++;
    this._persist();
    return call;
  }

  getToolCall(toolCallId) {
    return this.state.toolCalls[toolCallId] || null;
  }

  setToolCallStatus(toolCallId, to, patch = {}) {
    const call = this.state.toolCalls[toolCallId];
    if (!call) throw new Error(`工具调用不存在：${toolCallId}`);
    if (model.isTerminal('toolCall', call.status)) return call;
    model.assertTransition('toolCall', call.status, to);
    call.status = to;
    Object.assign(call, patch);
    this._persist();
    return call;
  }

  reconcileToolCall({ toolCallId, outcome, reason = 'user_reconciled' } = {}) {
    const call = this.state.toolCalls[toolCallId];
    if (!call) throw new Error(`工具调用不存在：${toolCallId}`);
    const wanted = ['succeeded', 'failed', 'canceled'].includes(outcome) ? outcome : null;
    if (!wanted) throw new Error('核对结果必须是 succeeded / failed / canceled');
    if (call.reconciledAt) return call;
    if (call.status !== 'unknown') throw new Error('只有结果未知（unknown）的工具调用需要人工核对');
    model.assertTransition('toolCall', 'unknown', wanted);
    call.status = wanted;
    call.reconciledAt = this.now();
    call.reconcileReason = String(reason || '').slice(0, 200);
    this._append('tool.reconciled', {
      taskId: call.taskId,
      runId: call.runId,
      stepId: call.stepId,
      actor: { kind: 'user', id: 'local-user' },
      payload: { toolCallId: call.id, name: call.name, outcome: wanted, reason: call.reconcileReason },
    });
    this._persist();
    return call;
  }

  createApproval(input = {}) {
    const approval = model.baseApproval({
      runId: input.runId,
      taskId: input.taskId,
      toolCallId: input.toolCallId,
      actionHash: input.actionHash,
      scope: input.scope,
      reason: input.reason,
      expiresAt: input.expiresAt,
    });
    approval.resourceKey = input.resourceKey;
    approval.riskLevel = input.riskLevel;
    approval.toolName = input.toolName;
    approval.paramsSummary = input.paramsSummary;
    this.state.approvals[approval.id] = approval;
    this._append('approval.requested', {
      taskId: approval.taskId,
      runId: approval.runId,
      stepId: this.state.toolCalls[approval.toolCallId]?.stepId,
      payload: {
        approvalId: approval.id,
        toolCallId: approval.toolCallId,
        actionHash: approval.actionHash,
        expiresAt: approval.expiresAt,
        scope: approval.scope,
        toolName: approval.toolName,
        riskLevel: approval.riskLevel,
      },
    });
    this._persist();
    return approval;
  }

  getApproval(approvalId) {
    return this.state.approvals[approvalId] || null;
  }

  listApprovals({ runId, taskId, status } = {}) {
    this.sweepExpiredApprovals();
    const approvals = Object.values(this.state.approvals)
      .filter((a) => (!runId || a.runId === runId) && (!taskId || a.taskId === taskId) && (!status || a.status === status))
      .sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
    return { approvals };
  }

  sweepExpiredApprovals() {
    let expired = 0;
    for (const approval of Object.values(this.state.approvals)) {
      if (approval.status === 'pending' && this.now() > approval.expiresAt) {
        this._expireApproval(approval);
        expired++;
      }
    }
    return expired;
  }

  setRunWaitingApproval(runId, waiting) {
    const run = this.state.runs[runId];
    if (!run) return;
    const task = this.state.tasks[run.taskId];
    if (waiting) {
      if (run.status !== 'running') return;
      run.status = 'waiting_approval';
      this._append('run.status_changed', { taskId: run.taskId, runId, payload: { from: 'running', to: 'waiting_approval' } });
      if (task && task.status === 'running') {
        task.status = 'waiting_approval';
        this._append('task.status_changed', { taskId: task.id, runId, payload: { from: 'running', to: 'waiting_approval', reason: 'approval_required' } });
      }
    } else {
      if (run.status !== 'waiting_approval') return;
      run.status = 'running';
      this._append('run.status_changed', { taskId: run.taskId, runId, payload: { from: 'waiting_approval', to: 'running' } });
      if (task && task.status === 'waiting_approval') {
        task.status = 'running';
        this._append('task.status_changed', { taskId: task.id, runId, payload: { from: 'waiting_approval', to: 'running', reason: 'approval_decided' } });
      }
    }
    this._persist();
  }

  decideApproval({ approvalId, decision, scope, reason = '', decidedBy = 'user' } = {}) {
    const approval = this.state.approvals[approvalId];
    if (!approval) throw new Error(`审批不存在：${approvalId}`);
    if (approval.status !== 'pending') return { approval, deduped: true };
    if (this.now() > approval.expiresAt) {
      return this._expireApproval(approval);
    }
    const wanted = decision === 'approved' || decision === 'allow' ? 'approved' : 'denied';
    const effectiveScope = ['once', 'run', 'task'].includes(scope) ? scope : approval.scope;
    approval.status = wanted;
    approval.scope = effectiveScope;
    approval.decidedAt = this.now();
    approval.decidedBy = decidedBy;
    approval.decisionReason = String(reason || '').slice(0, 300);
    this._append('approval.decided', {
      taskId: approval.taskId,
      runId: approval.runId,
      actor: { kind: 'user', id: decidedBy || 'local-user' },
      payload: {
        approvalId: approval.id,
        decision: wanted,
        scope: effectiveScope,
        decidedBy,
        reason: approval.decisionReason || undefined,
      },
    });
    const call = this.state.toolCalls[approval.toolCallId];
    if (call && call.status === 'waiting_approval') {
      if (wanted === 'approved') {
        this.setToolCallStatus(call.id, 'ready', { approvalId: approval.id });
      } else {
        this.setToolCallStatus(call.id, 'denied', { approvalId: approval.id, deniedReason: 'user_denied' });
        this._append('tool.denied', {
          taskId: approval.taskId,
          runId: approval.runId,
          payload: { toolCallId: call.id, name: call.name, code: 'USER_DENIED', reason: '用户拒绝执行该工具' },
        });
      }
    }
    if (wanted === 'approved' && effectiveScope !== 'once') {
      const sourceRun = this.state.runs[approval.runId];
      const targets = effectiveScope === 'task'
        ? Object.values(this.state.runs).filter((r) => r.taskId === approval.taskId && r.agentId === sourceRun?.agentId)
        : [sourceRun];
      for (const run of targets) {
        if (!run) continue;
        run.approvalGrants = run.approvalGrants || {};
        run.approvalGrants[approval.actionHash] = {
          approvalId: approval.id,
          scope: effectiveScope,
          resourceKey: approval.resourceKey,
          expiresAt: approval.expiresAt,
        };
      }
    }
    this._persist();
    return { approval, deduped: false };
  }

  _expireApproval(approval) {
    approval.status = 'expired';
    approval.decidedAt = this.now();
    this._append('approval.expired', {
      taskId: approval.taskId,
      runId: approval.runId,
      payload: { approvalId: approval.id },
    });
    const call = this.state.toolCalls[approval.toolCallId];
    if (call && call.status === 'waiting_approval') {
      this.setToolCallStatus(call.id, 'denied', { deniedReason: 'approval_expired' });
      this._append('tool.denied', {
        taskId: approval.taskId,
        runId: approval.runId,
        payload: { toolCallId: call.id, name: call.name, code: 'APPROVAL_EXPIRED', reason: '审批已过期' },
      });
    }
    // 该 run 没有其余 pending 审批时，解除 waiting_approval 卡死
    const stillPending = Object.values(this.state.approvals)
      .some((a) => a.status === 'pending' && a.runId === approval.runId);
    if (!stillPending) this.setRunWaitingApproval(approval.runId, false);
    this._persist();
    return { approval, expired: true };
  }

  findRunGrant(runId, hash) {
    const run = this.state.runs[runId];
    const grant = run?.approvalGrants?.[hash];
    if (!grant) return null;
    if (this.now() > grant.expiresAt) {
      delete run.approvalGrants[hash];
      this._persist();
      return null;
    }
    return grant;
  }

  _cancelApprovals(taskId, reason, runId) {
    for (const approval of Object.values(this.state.approvals)) {
      if (approval.taskId !== taskId || approval.status !== 'pending') continue;
      if (runId && approval.runId !== runId) continue;
      approval.status = 'canceled';
      approval.decidedAt = this.now();
      approval.decisionReason = reason;
      this._append('approval.canceled', {
        taskId,
        runId: approval.runId,
        payload: { approvalId: approval.id, reason },
      });
      const call = this.state.toolCalls[approval.toolCallId];
      if (call && call.status === 'waiting_approval') {
        this.setToolCallStatus(call.id, 'canceled', { deniedReason: reason });
      }
    }
  }

  markSensitiveRead(runId) {
    const run = this.state.runs[runId];
    if (!run || run.sensitiveRead) return;
    run.sensitiveRead = true;
    this._persist();
  }

  /* ---------------- 恢复与清理 ---------------- */

  recoverInterrupted() {
    const now = this.now();
    let changed = 0;
    for (const run of Object.values(this.state.runs)) {
      if (TERMINAL_RUN.has(run.status)) continue;
      const task = this.state.tasks[run.taskId];
      const fromRun = run.status;
      const toRun = fromRun === 'pending' ? 'canceled' : 'interrupted';
      model.assertTransition('run', fromRun, toRun);
      this._cancelApprovals(run.taskId, 'runtime_restart', run.id);
      run.status = toRun;
      run.endedAt = now;
      if (toRun === 'interrupted') {
        this._append('run.interrupted', {
          taskId: run.taskId,
          runId: run.id,
          payload: { lastStepIndex: run.currentStepIndex ?? 0, reason: 'runtime_restart' },
        });
      } else {
        this._append('run.finished', {
          taskId: run.taskId,
          runId: run.id,
          payload: { outcome: 'canceled', usage: run.usage, validated: false, reason: 'runtime_restart' },
        });
      }
      for (const step of Object.values(this.state.steps)) {
        if (step.runId === run.id && !model.isTerminal('step', step.status)) {
          const to = step.status === 'pending' ? 'canceled' : 'failed';
          step.status = to;
          step.endedAt = now;
          this._append('step.finished', {
            taskId: run.taskId,
            runId: run.id,
            stepId: step.id,
            payload: { status: to, modelCallId: step.modelCallId, toolCallIds: step.toolCallIds },
          });
        }
      }
      for (const call of Object.values(this.state.toolCalls)) {
        if (call.runId !== run.id || model.isTerminal('toolCall', call.status)) continue;
        const to = call.status === 'executing' ? 'failed' : 'canceled';
        call.status = to;
        if (to === 'failed') {
          this._append('tool.failed', {
            taskId: run.taskId,
            runId: run.id,
            payload: { toolCallId: call.id, name: call.name, code: 'UNKNOWN_OUTCOME', message: '应用退出时工具仍在执行，结果未知', retryable: false },
          });
        }
      }
      if (task && !TERMINAL_TASK.has(task.status)) {
        task.status = 'failed';
        task.finishedAt = now;
        this._append('task.finished', {
          taskId: task.id,
          runId: run.id,
          payload: { status: 'failed', resultSummary: '应用重启，未完成的运行已安全中断', errorCode: 'RUNTIME_RESTART' },
        });
      }
      changed++;
    }
    for (const record of Object.values(this.state.delegations)) {
      if (TERMINAL_DELEGATION.has(record.status)) continue;
      // 有检查点的委派保留 queued 状态 + 检查点，下次委派同目标时自动续跑；
      // 没有检查点的（一步都没跑完）才直接置 failed。
      const resumable = !!(record.checkpoint && Array.isArray(record.checkpoint.messages) && record.checkpoint.messages.length);
      record.status = resumable ? 'queued' : 'failed';
      record.finishedAt = resumable ? undefined : now;
      record.errorCode = resumable ? undefined : 'RUNTIME_RESTART';
      this._append(resumable ? 'delegation.resumable' : 'delegation.finished', {
        taskId: record.parentTaskId,
        runId: record.parentRunId,
        payload: resumable
          ? { delegationId: record.id, childTaskId: record.childTaskId, childRunId: record.childRunId, checkpointAt: record.checkpoint.savedAt }
          : {
            delegationId: record.id,
            childTaskId: record.childTaskId,
            childRunId: record.childRunId,
            status: 'failed',
            errorCode: 'RUNTIME_RESTART',
            summary: '应用重启，委派已中断',
          },
      });
      changed++;
    }
    if (changed) {
      this._persist();
      this._drainQueue();
    }
    return changed;
  }

  _prune() {
    while (this.state.taskOrder.length > KEEP_TASKS) {
      const idx = this._prunableIndex();
      if (idx < 0) break;
      const oldestId = this.state.taskOrder[idx];
      this.state.taskOrder.splice(idx, 1);
      delete this.state.tasks[oldestId];
      for (const [id, run] of Object.entries(this.state.runs)) {
        if (run.taskId !== oldestId) continue;
        delete this.state.runs[id];
        for (const [sid, step] of Object.entries(this.state.steps)) if (step.runId === id) delete this.state.steps[sid];
        for (const [mid, call] of Object.entries(this.state.modelCalls)) if (call.runId === id) delete this.state.modelCalls[mid];
        for (const [tid, tc] of Object.entries(this.state.toolCalls)) if (tc.runId === id) delete this.state.toolCalls[tid];
        for (const [aid, ap] of Object.entries(this.state.approvals)) if (ap.runId === id) delete this.state.approvals[aid];
      }
      for (const [did, del] of Object.entries(this.state.delegations)) {
        if (del.parentTaskId !== oldestId && del.childTaskId !== oldestId) continue;
        delete this.state.delegations[did];
      }
      this.state.delegationOrder = this.state.delegationOrder.filter((id) => this.state.delegations[id]);
    }
  }

  /** 从最旧开始找第一个可清理条目：幽灵条目、已终态且没有子任务仍通过 parentTaskId 引用它。
      被引用的父任务跳过（不能删），但继续向后清理，避免一个被引用任务永久卡死清理。 */
  _prunableIndex() {
    for (let i = 0; i < this.state.taskOrder.length; i++) {
      const id = this.state.taskOrder[i];
      const task = this.state.tasks[id];
      if (!task) return i;
      if (!TERMINAL_TASK.has(task.status)) continue;
      if (this._isReferencedParent(id)) continue;
      return i;
    }
    return -1;
  }

  _isReferencedParent(taskId) {
    for (const other of Object.values(this.state.tasks)) {
      if (other && other.parentTaskId === taskId) return true;
    }
    return false;
  }

  stats() {
    return {
      tasks: Object.keys(this.state.tasks).length,
      runs: Object.keys(this.state.runs).length,
      steps: Object.keys(this.state.steps).length,
      toolCalls: Object.keys(this.state.toolCalls).length,
      approvals: Object.keys(this.state.approvals).length,
      delegations: Object.keys(this.state.delegations).length,
      agents: Object.keys(this.state.agents).length,
      providers: Object.keys(this.state.providers).length,
      projects: Object.keys(this.state.projects || {}).length,
    };
  }

  close() {
    if (!this.ready) return;
    this._persist();
    this.ready = false;
  }
}

module.exports = { StateStore, KEEP_TASKS };
