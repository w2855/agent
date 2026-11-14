'use strict';

/* Runtime 基础自检：ID / 状态机 / 工具注册表 / Policy / 事件存储 / 重启恢复。
   运行：node tools/runtime-foundation-check.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ids = require('../runtime/ids');
const model = require('../runtime/model');
const registry = require('../runtime/tool-registry');
const policy = require('../runtime/policy');
const { EventStore } = require('../runtime/events');
const runtimeModule = require('../runtime');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`));
}

(async () => {
  /* 1. ID */
  const first = ids.newId('task');
  add('ID 带合法前缀与 26 位 ULID', ids.isId(first, 'task') && first.startsWith('task_'), first);
  const set = new Set();
  for (let i = 0; i < 1000; i++) set.add(ids.newId('evt'));
  add('1000 个 ID 无重复', set.size === 1000, `unique=${set.size}`);
  let rejected = false;
  try { ids.newId('nope'); } catch { rejected = true; }
  add('未知前缀被拒绝', rejected, 'ok');

  /* 2. 状态机 */
  add('Task：created → queued 合法', model.canTransition('task', 'created', 'queued'), 'ok');
  add('Task：queued → succeeded 非法', !model.canTransition('task', 'queued', 'succeeded'), 'ok');
  add('Run：running → interrupted 合法', model.canTransition('run', 'running', 'interrupted'), 'ok');
  add('ToolCall：proposed → executing 非法', !model.canTransition('toolCall', 'proposed', 'executing'), 'ok');
  add('Approval：pending → approved 合法', model.canTransition('approval', 'pending', 'approved'), 'ok');
  add('succeeded 是终态', model.isTerminal('run', 'succeeded'), 'ok');
  const task = model.baseTask({ workspaceId: 'ws_x', agentId: 'agent_x', input: 'hi' });
  add('Task 工厂字段完整', ids.isId(task.id, 'task') && task.status === 'created' && task.schemaVersion === 1, task.id);

  /* 3. 工具注册表 */
  const manifests = registry.listManifests();
  add('注册表含 9 个工具', manifests.length === 9, manifests.map((m) => m.name).join(','));
  add('write_file 声明为 local_write/ask', manifests.some((m) => m.name === 'write_file' && m.sideEffect === 'local_write' && m.defaultApproval === 'ask'), 'ok');
  add('delegate_task 声明为 delegation/ask', manifests.some((m) => m.name === 'delegate_task' && m.sideEffect === 'delegation' && m.defaultApproval === 'ask'), 'ok');
  add('project_architecture 声明为低风险元数据写入', manifests.some((m) => m.name === 'project_architecture' && m.sideEffect === 'none' && m.defaultApproval === 'never'), 'ok');
  const okArgs = registry.validateToolArgs('write_file', { path: 'a.txt', content: 'hello' });
  add('合法参数通过校验', okArgs.args.path === 'a.txt', 'ok');
  let badArgs = false;
  try { registry.validateToolArgs('write_file', { path: 'a.txt' }); } catch { badArgs = true; }
  add('缺少必填参数被拒绝', badArgs, 'ok');
  let extraArgs = false;
  try { registry.validateToolArgs('read_file', { path: 'a.txt', evil: 1 }); } catch { extraArgs = true; }
  add('额外参数被拒绝', extraArgs, 'ok');
  let unknownTool = false;
  try { registry.validateToolArgs('rm_rf', {}); } catch { unknownTool = true; }
  add('未注册工具被拒绝', unknownTool, 'ok');

  /* 4. Policy */
  const ws = tempDir('policy');
  fs.mkdirSync(ws, { recursive: true });
  const base = { workspace: ws, workspaceId: 'ws_test', agentId: 'agent_test' };

  const fullWrite = policy.evaluatePolicy({ ...base, profile: 'full', tool: 'write_file', args: { path: 'a.txt', content: 'x' } });
  add('full：工作区内写入 allow', fullWrite.decision === 'allow', fullWrite.decision);

  const askWrite = policy.evaluatePolicy({ ...base, profile: 'ask', tool: 'write_file', args: { path: 'a.txt', content: 'x' } });
  add('ask：写入 require_approval', askWrite.decision === 'require_approval' && askWrite.actionHash.startsWith('sha256:'), `${askWrite.decision} ${askWrite.actionHash.slice(0, 20)}…`);

  const roWrite = policy.evaluatePolicy({ ...base, profile: 'readonly', tool: 'write_file', args: { path: 'a.txt', content: 'x' } });
  add('readonly：写入 deny', roWrite.decision === 'deny', roWrite.ruleIds.join(','));

  const roRead = policy.evaluatePolicy({ ...base, profile: 'readonly', tool: 'read_file', args: { path: 'a.txt' } });
  add('readonly：读取 allow', roRead.decision === 'allow', roRead.decision);

  const askCmd = policy.evaluatePolicy({ ...base, profile: 'ask', tool: 'run_command', args: { command: 'echo hi' } });
  add('ask：命令 require_approval', askCmd.decision === 'require_approval', askCmd.decision);

  const formatCmd = policy.evaluatePolicy({ ...base, profile: 'full', tool: 'run_command', args: { command: 'format c:' } });
  add('full：灾难命令仍 deny', formatCmd.decision === 'deny' && formatCmd.ruleIds.includes('hard-deny-command'), formatCmd.ruleIds.join(','));

  const escape = policy.evaluatePolicy({ ...base, profile: 'full', tool: 'write_file', args: { path: path.join('..', 'outside.txt'), content: 'x' } });
  add('写入工作区外被拒绝', escape.decision === 'deny' && escape.ruleIds.includes('workspace-boundary'), escape.ruleIds.join(','));

  const systemPath = process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.txt' : '/etc/evil.txt';
  const sysWrite = policy.evaluatePolicy({ ...base, profile: 'full', tool: 'write_file', args: { path: systemPath, content: 'x' } });
  add('写入系统目录被拒绝', sysWrite.decision === 'deny' && sysWrite.ruleIds.includes('hard-deny-system-path'), sysWrite.ruleIds.join(','));

  const h1 = policy.evaluatePolicy({ ...base, profile: 'ask', tool: 'write_file', args: { path: 'a.txt', content: 'one' } }).actionHash;
  const h2 = policy.evaluatePolicy({ ...base, profile: 'ask', tool: 'write_file', args: { path: 'a.txt', content: 'one' } }).actionHash;
  const h3 = policy.evaluatePolicy({ ...base, profile: 'ask', tool: 'write_file', args: { path: 'a.txt', content: 'two' } }).actionHash;
  add('actionHash 稳定且随参数变化', h1 === h2 && h1 !== h3, `${h1.slice(0, 20)}…`);

  const netRead = policy.evaluatePolicy({ ...base, profile: 'ask', tool: 'fetch_url', args: { url: 'https://example.com/x' }, context: { priorSensitiveRead: true } });
  add('敏感读取后联网在 ask 下需审批', netRead.decision === 'require_approval' && netRead.ruleIds.includes('exfil-combination'), netRead.decision);

  const batWrite = policy.evaluatePolicy({ ...base, profile: 'ask', tool: 'write_file', args: { path: 'run.bat', content: 'x' } });
  add('写入可执行文件风险升高', batWrite.riskLevel === 'high', batWrite.riskLevel);

  const canonical = policy.canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  add('canonicalJson 键排序稳定', canonical === '{"a":{"c":3,"d":2},"b":1}', canonical);

  /* 5. 事件存储 */
  const dir = tempDir('events');
  const store = new EventStore({ dir }).init();
  const runId = ids.newId('run');
  let notified = 0;
  const off = store.subscribe((e) => { if (e.type === 'step.started') notified++; });

  for (let i = 0; i < 60; i++) {
    store.append({ type: 'step.started', runId, payload: { index: i } });
  }
  store.append({ type: 'run.finished', runId, payload: { outcome: 'succeeded' } });
  off();
  store.append({ type: 'step.started', runId, payload: { index: 60 } });

  add('事件 seq 单调递增', store.lastSeq === 62, `lastSeq=${store.lastSeq}`);
  add('订阅按类型收到事件', notified === 60, `notified=${notified}`);

  const page = store.read({ afterSeq: 55, limit: 10, runId });
  add('afterSeq/limit 分页正确', page.events.length === 7 && page.events[0].seq === 56 && page.nextSeq === 62, `count=${page.events.length} next=${page.nextSeq}`);
  add('事件日志校验无空洞', store.verify().ok === true, JSON.stringify(store.verify()));
  const metaAfter = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
  add('终态事件更新 runtime.json 水位', metaAfter.lastSeq >= 61, `meta=${metaAfter.lastSeq}`);

  store.close();
  const store2 = new EventStore({ dir }).init();
  add('重启后 lastSeq 恢复', store2.lastSeq === 62, `lastSeq=${store2.lastSeq}`);
  const all = store2.read({ afterSeq: 0, limit: 1000 });
  add('重启后事件完整可读', all.events.length === 62, `count=${all.events.length}`);
  const seq63 = store2.append({ type: 'step.started', runId, payload: { index: 61 } });
  add('重启后继续追加', seq63.seq === 63, `seq=${seq63.seq}`);

  const today = new Date(seq63.ts).toISOString().slice(0, 10) + '.jsonl';
  fs.appendFileSync(path.join(dir, 'events', today), '{broken json\n');
  store2.close();
  const store3 = new EventStore({ dir }).init();
  add('损坏尾行被跳过且可继续', store3.stats().eventLogOk === false && store3.lastSeq === 63, `malformed=${store3.stats().malformedLines}`);
  const seq64 = store3.append({ type: 'run.interrupted', runId, payload: {} });
  add('损坏日志后仍可追加终态事件', seq64.seq === 64, `seq=${seq64.seq}`);
  store3.close();

  /* 6. Runtime 门面 */
  const rdir = tempDir('runtime');
  const svc = runtimeModule.createRuntime({ dir: rdir, workspacePath: ws }).init();
  const health0 = svc.health();
  add('Runtime health 返回 Result 包装', health0.ok === true && health0.data.apiVersion === '0.1' && health0.data.status === 'ok', JSON.stringify(health0.data.store));
  const allow = svc.evaluateTool({ profile: 'full', tool: 'read_file', args: { path: 'a.txt' } });
  add('Runtime 门面可执行 Policy', allow.decision === 'allow', allow.decision);
  svc.append({ type: 'runtime.recovered', payload: { interruptedRuns: 0 } });
  add('Runtime 门面可写事件', svc.health().data.store.lastSeq >= 1, `lastSeq=${svc.health().data.store.lastSeq}`);
  svc.close();

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(rdir, { recursive: true, force: true });

  const total = checks.length;
  const passed = checks.filter((c) => c.pass).length;
  const out = { checks, total, passed, failed: total - passed };
  console.log(JSON.stringify(out, null, 2));
  if (out.failed) process.exitCode = 1;
})().catch((err) => {
  console.error('[runtime-foundation] 未捕获错误：', err);
  process.exitCode = 1;
});
