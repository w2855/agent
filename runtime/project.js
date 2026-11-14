'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./policy');

/* 项目级架构：一个工作区对应一个项目，由主控 Agent 维护分层模块与依赖。
   架构只保存结构摘要（模块名、层级、路径、关联任务），不保存文件内容。 */

const NODE_KINDS = new Set(['module', 'service', 'component', 'data', 'interface', 'agent', 'asset', 'external', 'custom']);
const LAYERS = ['experience', 'application', 'domain', 'platform', 'data', 'external'];
const LAYER_SET = new Set(LAYERS);
const NODE_STATUS = new Set(['planned', 'in_progress', 'done', 'blocked']);
const EDGE_KINDS = new Set(['depends', 'calls', 'reads', 'writes', 'emits', 'exposes']);
const ACTIVE_TASK = new Set(['queued', 'running', 'waiting_approval', 'paused']);

const LAYER_LABEL = {
  experience: '体验层',
  application: '应用层',
  domain: '领域层',
  platform: '平台层',
  data: '数据层',
  external: '外部系统',
};

const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_MILESTONES = 20;
const MAX_SCAN_ENTRIES = 40;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.cache', '__pycache__', '.next', '.nuxt', 'coverage', '.idea', '.vscode',
  '.venv', 'venv', 'vendor', 'bin', 'obj',
]);

function clip(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function readSmall(file, max) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return '';
    return fs.readFileSync(file, 'utf8');
  } catch { return ''; }
}

function detectStack(workspace, entries) {
  const stack = [];
  const add = (name) => { if (name && !stack.includes(name)) stack.push(name); };
  const has = (name) => entries.some((e) => e.name.toLowerCase() === name.toLowerCase());

  const pkg = readSmall(path.join(workspace, 'package.json'), 128 * 1024);
  if (pkg) {
    add('Node.js');
    try {
      const data = JSON.parse(pkg);
      const deps = { ...(data.dependencies || {}), ...(data.devDependencies || {}) };
      const known = {
        electron: 'Electron', react: 'React', 'react-dom': 'React', vue: 'Vue',
        next: 'Next.js', nuxt: 'Nuxt', svelte: 'Svelte', vite: 'Vite',
        webpack: 'Webpack', typescript: 'TypeScript', express: 'Express',
        fastify: 'Fastify', koa: 'Koa', prisma: 'Prisma', sequelize: 'Sequelize',
        tailwindcss: 'Tailwind CSS', jest: 'Jest', vitest: 'Vitest',
        playwright: 'Playwright', three: 'Three.js', phaser: 'Phaser',
      };
      for (const [key, label] of Object.entries(known)) if (deps[key]) add(label);
    } catch { /* package.json 损坏时只记录 Node.js */ }
  }
  if (has('tsconfig.json')) add('TypeScript');
  if (has('Cargo.toml')) add('Rust');
  if (has('go.mod')) add('Go');
  if (has('requirements.txt') || has('pyproject.toml') || has('setup.py')) add('Python');
  if (has('pom.xml')) add('Java');
  if (has('build.gradle') || has('build.gradle.kts')) add('Java/Kotlin');
  if (entries.some((e) => /\.csproj$/i.test(e.name))) add('C#');
  if (has('pubspec.yaml')) add('Flutter/Dart');
  if (has('index.html')) add('Web');
  if (has('Dockerfile')) add('Docker');
  if (!stack.length) {
    const ext = entries.find((e) => /\.(js|ts|py|go|rs|java|cs|html)$/i.test(e.name));
    if (ext) add(path.extname(ext.name).slice(1).toUpperCase());
  }
  return stack.slice(0, 16);
}

function scanProjectName(workspace, pkgName, readme) {
  if (pkgName) return pkgName;
  const heading = readme.match(/^\s*#\s+(.+)$/m);
  if (heading) return heading[1].replace(/[#*_`]/g, '').trim().slice(0, 80);
  return path.basename(workspace) || '未命名项目';
}

class ProjectService {
  constructor({ state, events, workspacePath } = {}) {
    if (!state) throw new Error('ProjectService 需要 state');
    if (!events) throw new Error('ProjectService 需要 events');
    this.state = state;
    this.events = events;
    this.workspacePath = workspacePath || process.cwd();
  }

  /* ---------------- 工作区发现 ---------------- */

  discover(workspace) {
    const root = path.resolve(String(workspace || this.workspacePath));
    const entries = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
        .slice(0, MAX_SCAN_ENTRIES);
    } catch { /* 工作区不可读时保留空发现 */ }
    for (const ent of dirs) {
      let size = 0;
      try { size = ent.isFile() ? fs.statSync(path.join(root, ent.name)).size : 0; } catch { /* 忽略 */ }
      entries.push({ name: ent.name, kind: ent.isDirectory() ? 'dir' : 'file', size });
    }

    const pkgRaw = readSmall(path.join(root, 'package.json'), 128 * 1024);
    let pkg = null;
    try { pkg = pkgRaw ? JSON.parse(pkgRaw) : null; } catch { pkg = null; }
    const readme = readSmall(path.join(root, 'README.md'), 8192) || readSmall(path.join(root, 'README.txt'), 8192);
    const name = scanProjectName(root, typeof pkg?.name === 'string' ? pkg.name : '', readme);
    const description = clip(pkg?.description || '', 200)
      || clip(readme.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith('#')) || '', 200);

    return {
      name: clip(name, 80),
      description,
      techStack: detectStack(root, entries),
      entries: entries.slice(0, MAX_SCAN_ENTRIES),
      scannedAt: Date.now(),
    };
  }

  /* ---------------- 项目生命周期 ---------------- */

  /* 会话短码：sessionId 前 6 位并清理为 id 安全字符（用于项目 id 后缀）。 */
  _sessionShort(sessionId) {
    return String(sessionId || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 6);
  }

  ensure(workspace, { mainAgentId, sessionId } = {}) {
    const root = path.resolve(String(workspace || this.workspacePath));
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    // 带 sessionId：按 workspace+sessionId 查找/创建（同会话独占架构，同工作区不同会话互不影响）；
    // 不带 sessionId：保持旧行为，按 workspace 查找共享项目（兼容旧调用路径与旧数据）。
    const existing = sid
      ? this.state.findProjectBySession(root, sid)
      : this.state.findProjectByWorkspace(root);
    if (existing) {
      const main = this.state.state.agents[existing.mainAgentId];
      if (!main || main.status !== 'active') {
        const fallback = this.state.getDefaultAgent();
        if (fallback) {
          return this.state.applyProject(existing.id, {
            fields: { mainAgentId: fallback.id },
            source: 'main_agent_fallback',
            detail: { previousMainAgentId: existing.mainAgentId || null },
          });
        }
      }
      return existing;
    }
    const discovery = this.discover(root);
    // 会话项目的默认名带「·<sessionId 前 6 位>」后缀，便于 UI 区分同工作区的多份架构
    const short = this._sessionShort(sid);
    const name = sid && short ? `${discovery.name} · ${short}` : discovery.name;
    return this.state.createProject({
      workspace: root,
      name,
      description: discovery.description,
      mainAgentId: mainAgentId || this.state.defaultAgentId,
      discovery,
      sessionId: sid || undefined,
    });
  }

  get(projectId) {
    const project = this.state.getProject(projectId);
    if (!project) return null;
    return this._withLive(project);
  }

  list() {
    return this.state.listProjects().map((project) => this._withLive(project));
  }

  /* 按会话列出项目（UI 侧按 activeId 过滤的辅助入口），返回带实时叠加的完整视图。 */
  listBySession(sessionId) {
    return this.state.listProjectsBySession(sessionId).map((project) => this._withLive(project));
  }

  update(projectId, input = {}) {
    const project = this.state.getProject(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    const fields = {};
    if (typeof input.name === 'string' && input.name.trim()) fields.name = clip(input.name, 80);
    if (typeof input.description === 'string') fields.description = clip(input.description, 300);
    if (typeof input.goal === 'string') fields.goal = clip(input.goal, 2000);
    if (Array.isArray(input.techStack)) {
      fields.techStack = [...new Set(input.techStack.map((s) => clip(s, 40)).filter(Boolean))].slice(0, 20);
    }
    if (typeof input.mainAgentId === 'string' && input.mainAgentId) {
      const agent = this.state.state.agents[input.mainAgentId];
      if (!agent || agent.status !== 'active') throw new Error('主控 Agent 必须是处于 active 状态的 Agent');
      fields.mainAgentId = agent.id;
    }
    if (!Object.keys(fields).length) return this._withLive(project);
    const updated = this.state.applyProject(project.id, {
      fields,
      source: 'user',
      detail: { changed: Object.keys(fields) },
    });
    return this._withLive(updated);
  }

  /* ---------------- 架构更新 ---------------- */

  _normalizeNode(raw, index, existingByLabel, existingById) {
    if (!raw || typeof raw !== 'object') return null;
    const label = clip(raw.label || raw.name, 60);
    if (!label) return null;
    const previous = (raw.id && existingById?.get(String(raw.id))) || existingByLabel.get(label.toLowerCase());
    const kind = NODE_KINDS.has(raw.kind) ? raw.kind : (previous?.kind || 'module');
    const layer = LAYER_SET.has(raw.layer) ? raw.layer : (previous?.layer || 'application');
    const incomingId = clip(raw.id, 64);
    const id = /^[A-Za-z0-9_.:-]{1,64}$/.test(incomingId)
      ? incomingId
      : (previous?.id || `mod_${sha256(`${label}|${kind}|${index}`).slice(0, 10)}`);
    const status = NODE_STATUS.has(raw.status) ? raw.status : (previous?.status || 'planned');
    const ownerAgentId = typeof raw.ownerAgentId === 'string' && this.state.state.agents[raw.ownerAgentId]?.status === 'active'
      ? raw.ownerAgentId
      : (previous?.ownerAgentId || null);
    const taskId = typeof raw.taskId === 'string' && this.state.state.tasks[raw.taskId]
      ? raw.taskId
      : (previous?.taskId || null);
    return {
      id,
      label,
      kind,
      layer,
      description: raw.description === undefined ? (previous?.description || '') : clip(raw.description, 400),
      path: raw.path === undefined ? (previous?.path || '') : clip(raw.path, 300),
      ownerAgentId,
      taskId,
      status,
      createdAt: previous?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
  }

  _resolveEdgeEndpoint(value, nodes, byId) {
    const key = clip(value, 80);
    if (!key) return null;
    if (byId.has(key)) return key;
    const hit = nodes.find((n) => n.label.toLowerCase() === key.toLowerCase());
    return hit ? hit.id : null;
  }

  _normalizeEdges(rawEdges, nodes) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const seen = new Set();
    const edges = [];
    let dropped = 0;
    for (const raw of Array.isArray(rawEdges) ? rawEdges : []) {
      if (!raw || typeof raw !== 'object') { dropped++; continue; }
      const from = this._resolveEdgeEndpoint(raw.from, nodes, byId);
      const to = this._resolveEdgeEndpoint(raw.to, nodes, byId);
      if (!from || !to || from === to) { dropped++; continue; }
      const kind = EDGE_KINDS.has(raw.kind) ? raw.kind : 'depends';
      const label = clip(raw.label, 40);
      const key = `${from}|${to}|${kind}|${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: `edge_${sha256(key).slice(0, 10)}`, from, to, kind, label });
    }
    return { edges, dropped };
  }

  _normalizeMilestones(raw, project) {
    const previous = new Map((project.milestones || []).map((m) => [m.label.toLowerCase(), m]));
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!item || typeof item !== 'object') continue;
      const label = clip(item.label || item.content, 100);
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      const prev = previous.get(label.toLowerCase());
      const taskId = typeof item.taskId === 'string' && this.state.state.tasks[item.taskId]
        ? item.taskId
        : (prev?.taskId || null);
      out.push({
        id: prev?.id || `ms_${sha256(label).slice(0, 8)}`,
        label,
        status: NODE_STATUS.has(item.status) ? item.status : (prev?.status || 'planned'),
        taskId,
      });
      if (out.length >= MAX_MILESTONES) break;
    }
    return out;
  }

  applyArchitecture({ workspace, agentId, args = {} } = {}) {
    // args.sessionId 可选：由 project_architecture 工具参数透传；省略时走共享项目（老行为）
    const project = this.ensure(workspace, { mainAgentId: agentId, sessionId: args.sessionId });
    if (!project.mainAgentId) throw new Error('项目缺少主控 Agent');
    if (project.mainAgentId !== agentId) {
      throw new Error(`只有主控 Agent（${project.mainAgentId}）可以更新项目架构`);
    }

    const touched = ['nodes', 'edges', 'milestones', 'name', 'description', 'goal', 'techStack']
      .some((key) => args[key] !== undefined);
    if (!touched) throw new Error('架构更新至少需要 nodes、edges、milestones、goal 或 techStack 之一');

    const mode = args.mode === 'replace' ? 'replace' : 'merge';
    const rawNodes = Array.isArray(args.nodes) ? args.nodes : null;
    const rawEdges = Array.isArray(args.edges) ? args.edges : [];
    const rawMilestones = Array.isArray(args.milestones) ? args.milestones : null;
    if (rawNodes && rawNodes.length > MAX_NODES) throw new Error(`模块数量超过上限（${MAX_NODES}）`);
    if (rawEdges.length > MAX_EDGES) throw new Error(`依赖边数量超过上限（${MAX_EDGES}）`);

    const existing = project.nodes || [];
    const existingByLabel = new Map(existing.map((n) => [n.label.toLowerCase(), n]));
    const existingById = new Map(existing.map((n) => [n.id, n]));
    const incoming = [];
    let invalidNodes = 0;
    const seenIds = new Set();
    const seenLabels = new Set();
    for (const [i, raw] of (rawNodes || []).entries()) {
      const node = this._normalizeNode(raw, i, existingByLabel, existingById);
      if (!node || seenIds.has(node.id) || seenLabels.has(node.label.toLowerCase())) {
        invalidNodes++;
        continue;
      }
      seenIds.add(node.id);
      seenLabels.add(node.label.toLowerCase());
      incoming.push(node);
    }

    let nodes;
    let added = 0;
    let updated = 0;
    let removed = 0;
    if (rawNodes) {
      if (mode === 'replace') {
        const incomingIds = new Set(incoming.map((n) => n.id));
        const incomingLabels = new Set(incoming.map((n) => n.label.toLowerCase()));
        removed = existing.filter((n) => !incomingIds.has(n.id) && !incomingLabels.has(n.label.toLowerCase())).length;
        nodes = incoming;
      } else {
        nodes = [...existing];
        const indexById = new Map(nodes.map((n, i) => [n.id, i]));
        const indexByLabel = new Map(nodes.map((n, i) => [n.label.toLowerCase(), i]));
        for (const node of incoming) {
          const idx = indexById.has(node.id)
            ? indexById.get(node.id)
            : indexByLabel.has(node.label.toLowerCase()) ? indexByLabel.get(node.label.toLowerCase()) : -1;
          if (idx >= 0) {
            nodes[idx] = { ...nodes[idx], ...node };
            updated++;
          } else {
            nodes.push(node);
            added++;
          }
        }
        if (nodes.length > MAX_NODES) throw new Error(`合并后模块数量超过上限（${MAX_NODES}）`);
      }
    } else {
      nodes = existing;
    }

    const edgeResult = this._normalizeEdges(rawEdges, nodes);
    let edges;
    if (mode === 'replace' && rawNodes) {
      // 整体替换模块时，未提交的依赖不应残留到已删除的节点上
      edges = edgeResult.edges;
    } else {
      const merged = new Map((project.edges || []).map((e) => [`${e.from}|${e.to}|${e.kind}|${e.label || ''}`, e]));
      for (const e of edgeResult.edges) merged.set(`${e.from}|${e.to}|${e.kind}|${e.label || ''}`, e);
      edges = [...merged.values()];
    }

    const fields = {
      nodes,
      edges,
      status: nodes.length ? 'planned' : project.status,
    };
    if (typeof args.name === 'string' && args.name.trim()) fields.name = clip(args.name, 80);
    if (typeof args.description === 'string') fields.description = clip(args.description, 300);
    if (typeof args.goal === 'string') fields.goal = clip(args.goal, 2000);
    if (Array.isArray(args.techStack)) {
      const stack = args.techStack.map((s) => clip(s, 40)).filter(Boolean);
      fields.techStack = [...new Set([...project.techStack, ...stack])].slice(0, 20);
    }
    if (rawMilestones) fields.milestones = this._normalizeMilestones(rawMilestones, project);

    const updatedProject = this.state.applyProject(project.id, {
      fields,
      source: 'agent',
      detail: {
        mode,
        agentId,
        added,
        updated,
        removed,
        invalidNodes,
        droppedEdges: edgeResult.dropped,
        layerCounts: this._layerCounts(nodes),
      },
    });

    const summary = this._architectureSummary(updatedProject, {
      mode, added, updated, removed, invalidNodes, droppedEdges: edgeResult.dropped,
    });
    return { project: updatedProject, summary };
  }

  _layerCounts(nodes) {
    const out = {};
    for (const layer of LAYERS) out[layer] = 0;
    for (const node of nodes) out[node.layer] = (out[node.layer] || 0) + 1;
    return out;
  }

  _architectureSummary(project, diff = {}) {
    const lines = [];
    lines.push(`项目架构已更新：${project.name}（revision ${project.revision}）`);
    if (project.goal) lines.push(`目标：${project.goal}`);
    const layers = this._layerCounts(project.nodes);
    const layerText = LAYERS.filter((l) => layers[l]).map((l) => `${LAYER_LABEL[l]} ${layers[l]}`).join(' · ');
    if (layerText) lines.push(`分层：${layerText}`);
    if (project.techStack?.length) lines.push(`技术栈：${project.techStack.join('、')}`);
    if (diff.mode) {
      lines.push(`本次变更：${diff.mode === 'replace' ? '整体替换' : '合并'} · 新增 ${diff.added || 0} · 更新 ${diff.updated || 0} · 移除 ${diff.removed || 0}`);
    }
    const nodes = project.nodes.slice(0, 24).map((n) => `- [${LAYER_LABEL[n.layer] || n.layer}] ${n.label}（${n.kind}·${n.status}）${n.path ? ' · ' + n.path : ''}`);
    if (nodes.length) lines.push('模块：\n' + nodes.join('\n'));
    if (project.nodes.length > nodes.length) lines.push(`…另有 ${project.nodes.length - nodes.length} 个模块未展开`);
    const edges = project.edges.slice(0, 16).map((e) => {
      const from = project.nodes.find((n) => n.id === e.from)?.label || e.from;
      const to = project.nodes.find((n) => n.id === e.to)?.label || e.to;
      return `- ${from} → ${to}（${e.kind}${e.label ? '·' + e.label : ''}）`;
    });
    if (edges.length) lines.push('关键依赖：\n' + edges.join('\n'));
    if (project.edges.length > edges.length) lines.push(`…另有 ${project.edges.length - edges.length} 条依赖未展开`);
    if (diff.invalidNodes) lines.push(`忽略无效模块：${diff.invalidNodes} 个`);
    if (diff.droppedEdges) lines.push(`忽略无法解析的依赖边：${diff.droppedEdges} 条`);
    lines.push('后续请用 delegate_task 把模块级任务分给子 Agent，并用 project_architecture（merge 模式）回填模块状态与任务关联。');
    return lines.join('\n').slice(0, 4000);
  }

  /* ---------------- 实时叠加 ---------------- */

  _withLive(project) {
    const tasks = Object.values(this.state.state.tasks);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const linkedIds = new Set([
      ...(project.nodes || []).map((n) => n.taskId),
      ...(project.milestones || []).map((m) => m.taskId),
    ].filter(Boolean));
    // 只有本项目工作区或显式关联的任务才影响本项目的实时状态
    const scopedTasks = tasks.filter((t) => linkedIds.has(t.id)
      || (t.workspace && path.resolve(t.workspace) === project.workspace));
    const activeByAgent = new Map();
    for (const task of scopedTasks) {
      if (!ACTIVE_TASK.has(task.status)) continue;
      const list = activeByAgent.get(task.agentId) || [];
      list.push(task);
      activeByAgent.set(task.agentId, list);
    }

    const nodes = (project.nodes || []).map((node) => {
      const task = node.taskId ? byId.get(node.taskId) : null;
      const agentActive = node.ownerAgentId ? (activeByAgent.get(node.ownerAgentId) || []) : [];
      const runtimeStatus = task?.status || null;
      let effectiveStatus = node.status || 'planned';
      if (task) {
        if (task.status === 'succeeded') effectiveStatus = 'done';
        else if (['failed', 'canceled', 'interrupted', 'expired'].includes(task.status)) effectiveStatus = 'blocked';
        else if (['running', 'waiting_approval', 'queued', 'paused'].includes(task.status)) effectiveStatus = 'in_progress';
      } else if (agentActive.length) {
        effectiveStatus = 'in_progress';
      }
      return {
        ...node,
        planStatus: node.status || 'planned',
        effectiveStatus,
        runtimeStatus,
        taskTitle: task?.title || '',
        live: !!task && ACTIVE_TASK.has(task.status),
        agentActive: !task && agentActive.length > 0,
      };
    });

    const agentIds = [...new Set([
      project.mainAgentId,
      ...nodes.map((n) => n.ownerAgentId),
      ...scopedTasks.map((t) => t.agentId),
    ].filter(Boolean))];
    const agents = agentIds.map((id) => {
      const agent = this.state.getAgent(id);
      if (!agent) return null;
      const active = activeByAgent.get(id) || [];
      return {
        id,
        name: agent.agent.name,
        status: agent.agent.status,
        version: agent.agent.currentVersion,
        permissionProfileId: agent.currentVersion?.permissionProfileId || null,
        activeTasks: active.length,
        role: id === project.mainAgentId ? 'main' : 'sub',
      };
    }).filter(Boolean);

    const linkedTaskIds = new Set(nodes.map((n) => n.taskId).filter(Boolean));
    const projectTasks = scopedTasks.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const milestones = (project.milestones || []).map((m) => {
      const task = m.taskId ? byId.get(m.taskId) : null;
      let status = m.status;
      if (task) {
        if (task.status === 'succeeded') status = 'done';
        else if (['failed', 'canceled', 'interrupted'].includes(task.status)) status = 'blocked';
        else if (ACTIVE_TASK.has(task.status)) status = 'in_progress';
      }
      return { ...m, effectiveStatus: status, taskStatus: task?.status || null, taskTitle: task?.title || '' };
    });

    const done = nodes.filter((n) => n.effectiveStatus === 'done').length;
    const blocked = nodes.filter((n) => n.effectiveStatus === 'blocked').length;
    const activeNodes = nodes.filter((n) => n.effectiveStatus === 'in_progress').length;
    return {
      project,
      live: {
        nodes,
        agents,
        mainAgent: agents.find((a) => a.role === 'main') || null,
        milestones,
        tasks: projectTasks.slice(0, 8).map((t) => ({
          id: t.id, title: t.title, status: t.status, agentId: t.agentId,
          parentTaskId: t.parentTaskId || null, createdAt: t.createdAt,
        })),
        stats: {
          nodes: nodes.length,
          edges: (project.edges || []).length,
          layers: new Set(nodes.map((n) => n.layer)).size,
          agents: agents.length,
          linkedTasks: linkedTaskIds.size,
          activeTasks: projectTasks.filter((t) => ACTIVE_TASK.has(t.status)).length,
          activeNodes,
          done,
          blocked,
        },
        activeTasks: projectTasks.filter((t) => ACTIVE_TASK.has(t.status)).length,
      },
    };
  }

}

module.exports = {
  ProjectService,
  LAYERS,
  LAYER_LABEL,
  MAX_NODES,
  MAX_EDGES,
  NODE_KINDS,
  NODE_STATUS,
  EDGE_KINDS,
};
