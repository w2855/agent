'use strict';

const { TOOL_SPECS } = require('../lib/tools');

/* 工具清单：在现有 TOOL_SPECS 之上补充治理元数据，不复制参数 schema。 */

const MANIFESTS = {
  list_dir: {
    title: '列目录', sideEffect: 'read', risk: 'low', defaultApproval: 'never', idempotency: 'safe',
    timeout: { default: 15000, max: 60000 },
    limits: { maxEntries: 300 },
    resource: { workspaceOnly: false, network: false },
  },
  read_file: {
    title: '读取文件', sideEffect: 'read', risk: 'low', defaultApproval: 'never', idempotency: 'safe',
    timeout: { default: 15000, max: 60000 },
    limits: { maxOutputChars: 60000, maxInputBytes: 4 * 1024 * 1024 },
    resource: { workspaceOnly: false, network: false },
  },
  write_file: {
    title: '写入文件', sideEffect: 'local_write', risk: 'medium', defaultApproval: 'ask', idempotency: 'keyed',
    timeout: { default: 15000, max: 60000 },
    limits: { maxInputChars: 500000 },
    resource: { workspaceOnly: true, network: false },
  },
  edit_file: {
    title: '编辑文件', sideEffect: 'local_write', risk: 'medium', defaultApproval: 'ask', idempotency: 'unsafe',
    timeout: { default: 15000, max: 60000 },
    limits: { maxInputChars: 500000, maxOccurrences: 200 },
    resource: { workspaceOnly: true, network: false },
  },
  find_files: {
    title: '查找文件', sideEffect: 'read', risk: 'low', defaultApproval: 'never', idempotency: 'safe',
    timeout: { default: 20000, max: 60000 },
    limits: { maxResults: 300, maxEntries: 20000 },
    resource: { workspaceOnly: false, network: false },
  },
  task_output: {
    title: '读取后台输出', sideEffect: 'read', risk: 'low', defaultApproval: 'never', idempotency: 'safe',
    timeout: { default: 10000, max: 35000 },
    limits: { maxOutputChars: 60000 },
    resource: { workspaceOnly: false, network: false },
  },
  task_stop: {
    title: '停止后台任务', sideEffect: 'process_exec', risk: 'medium', defaultApproval: 'never', idempotency: 'keyed',
    timeout: { default: 10000, max: 10000 },
    resource: { workspaceOnly: false, network: false },
  },
  task_list: {
    title: '后台任务列表', sideEffect: 'read', risk: 'low', defaultApproval: 'never', idempotency: 'safe',
    timeout: { default: 5000, max: 5000 },
    resource: { workspaceOnly: false, network: false },
  },
  search_files: {
    title: '搜索内容', sideEffect: 'read', risk: 'low', defaultApproval: 'never', idempotency: 'safe',
    timeout: { default: 30000, max: 120000 },
    limits: { maxMatches: 200, maxEntries: 1500 },
    resource: { workspaceOnly: false, network: false },
  },
  run_command: {
    title: '执行命令', sideEffect: 'process_exec', risk: 'high', defaultApproval: 'ask', idempotency: 'unsafe',
    timeout: { default: 60000, max: 180000 },
    limits: { maxInputChars: 4000, maxOutputChars: 30000 },
    resource: { workspaceOnly: false, network: false },
  },
  fetch_url: {
    title: '访问网页', sideEffect: 'network', risk: 'medium', defaultApproval: 'never', idempotency: 'safe',
    timeout: { default: 20000, max: 20000 },
    limits: { maxOutputChars: 40000 },
    resource: { workspaceOnly: false, network: true },
  },
  todo_write: {
    title: '更新任务清单', sideEffect: 'none', risk: 'low', defaultApproval: 'never', idempotency: 'safe',
    timeout: { default: 5000, max: 5000 },
    limits: { maxItems: 30, maxItemChars: 200 },
    resource: { workspaceOnly: false, network: false },
  },
  project_architecture: {
    title: '更新项目架构', sideEffect: 'none', risk: 'low', defaultApproval: 'never', idempotency: 'keyed',
    timeout: { default: 5000, max: 5000 },
    limits: { maxNodes: 60, maxEdges: 120, maxMilestones: 20 },
    resource: { workspaceOnly: true, network: false },
  },
  delegate_task: {
    title: '委派子任务', sideEffect: 'delegation', risk: 'high', defaultApproval: 'ask', idempotency: 'keyed',
    timeout: { default: 300000, max: 600000 },
    limits: { maxObjectiveChars: 4000, maxContextRefs: 10 },
    resource: { workspaceOnly: true, network: false },
  },
};

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((s) => [s.function.name, s]));

function listManifests() {
  return [...SPEC_BY_NAME.entries()].map(([name, spec]) => ({
    name,
    version: '1.0.0',
    title: MANIFESTS[name]?.title || name,
    description: spec.function.description,
    sideEffect: MANIFESTS[name]?.sideEffect || 'external',
    risk: MANIFESTS[name]?.risk || 'high',
    defaultApproval: MANIFESTS[name]?.defaultApproval || 'ask',
    inputSchema: spec.function.parameters,
  }));
}

function getManifest(name) {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) return null;
  return {
    name,
    version: '1.0.0',
    title: MANIFESTS[name]?.title || name,
    description: spec.function.description,
    sideEffect: MANIFESTS[name]?.sideEffect || 'external',
    risk: MANIFESTS[name]?.risk || 'high',
    defaultApproval: MANIFESTS[name]?.defaultApproval || 'ask',
    idempotency: MANIFESTS[name]?.idempotency || 'unsafe',
    timeout: MANIFESTS[name]?.timeout || { default: 60000, max: 180000 },
    limits: MANIFESTS[name]?.limits || {},
    resource: MANIFESTS[name]?.resource || { workspaceOnly: true, network: false },
    inputSchema: spec.function.parameters,
  };
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeOf(value) === type;
}

/** 仅覆盖本项目工具 schema 用到的 JSON Schema 子集。 */
function validateSchema(schema, value, path = '参数') {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type && !matchesType(value, schema.type)) {
    throw new Error(`${path} 应为 ${schema.type}，实际为 ${typeOf(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${path} 必须是 ${schema.enum.join(' / ')} 之一`);
  }
  if (schema.type === 'object') {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null || value[key] === '') {
        throw new Error(`${path}.${key} 不能为空`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) throw new Error(`${path}.${key} 不是允许的参数`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] !== undefined) validateSchema(sub, value[key], `${path}.${key}`);
    }
  }
  if (schema.type === 'array' && schema.items) {
    value.forEach((item, i) => validateSchema(schema.items, item, `${path}[${i}]`));
  }
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') return raw.trim() ? JSON.parse(raw) : {};
  throw new Error('工具参数必须是对象或 JSON 字符串');
}

function validateToolArgs(name, rawArgs) {
  const manifest = getManifest(name);
  if (!manifest) throw new Error(`未注册工具：${name}`);
  let args;
  try { args = parseArgs(rawArgs); } catch (err) { throw new Error(`工具参数不是合法 JSON：${err.message}`); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
  validateSchema(manifest.inputSchema, args);
  return { manifest, args };
}

module.exports = {
  MANIFESTS,
  listManifests,
  getManifest,
  validateToolArgs,
  validateSchema,
};
