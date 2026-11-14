'use strict';

/* 验证经验库（lib/lessons.js）自检：追加 / 查询过滤 / 幂等去重 / 损坏行跳过 /
   环形上限 / runtime 收尾接线冒烟（钩子异常不影响主链路）/
   验证门（ruflo verified-guards）：污点判定 detectTaint / 验证命令门 detectVerification /
   置信门 confidenceFor 三态 / stats-query 默认排除未验证与污染记录 /
   Hybrid 检索组合（lib/retrieval.js hybridSearch）：searchLessons 中文命中与
   MMR 去重 / relatedLessonsForTask 双路关联 / 空库与故障注入绝不抛错。
   运行：node tools/lessons-check.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lessons = require('../lib/lessons');
const runtimeModule = require('../runtime');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-lessons-${tag}-`));
}

(async () => {
  const tmp = tempDir('unit');
  const file = path.join(tmp, 'lessons.jsonl');

  /* 1. 校验：必填与枚举 */
  const store = lessons.createLessonStore(file);
  add('工厂拒绝空 path', (() => { try { lessons.createLessonStore(''); return false; } catch { return true; } })(), 'throw');
  add('缺 taskId 拒绝', lessons.recordLesson(store, { kind: 'outcome', outcome: 'success' }).ok === false, 'INVALID_ENTRY');
  add('缺 kind 拒绝', lessons.recordLesson(store, { taskId: 'task_x', outcome: 'success' }).ok === false, 'INVALID_ENTRY');
  add('outcome 记录缺合法 outcome 拒绝', lessons.recordLesson(store, { taskId: 'task_x', kind: 'outcome' }).ok === false, 'INVALID_ENTRY');
  add('outcome 非法值拒绝', lessons.recordLesson(store, { taskId: 'task_x', kind: 'outcome', outcome: 'ok?' }).ok === false, 'INVALID_ENTRY');
  add('entry 不是对象拒绝', lessons.recordLesson(store, 'bad').ok === false, 'INVALID_ENTRY');
  add('全部拒绝后文件不存在', !fs.existsSync(file), 'no file');

  /* 2. 追加：首条成功即自动建文件，单行 JSON，字段已清洗 */
  const first = lessons.recordLesson(store, {
    taskId: 'task_a',
    agentId: 'agent_main',
    kind: 'outcome',
    outcome: 'success',
    summary: '目标：实现 X\n换行会被清洗\t制表符也清洗',
    tags: ['agent_main', 'agent_main', ' ', 42],
    evidence: { runId: 'run_a', errorCode: 'RUNTIME_CRASH', junk: 'dropped' },
    verified: true,
    verifiedBy: ['npm test', 'npm test', 123],
    ts: 1700000000000,
  });
  add('首条写入成功', first.ok === true && !first.deduped, first.detail || '');
  const raw1 = fs.readFileSync(file, 'utf8');
  add('文件只有一行且以换行结尾', raw1.split('\n').length === 2 && raw1.endsWith('\n'), 'JSONL 单行');
  const line1 = JSON.parse(raw1.trim());
  add('换行/制表符被清洗为空格', !/[\n\t]/.test(line1.summary) && line1.summary.includes('实现 X'), line1.summary);
  add('标签去重且非字符串被丢弃', JSON.stringify(line1.tags) === JSON.stringify(['agent_main']), JSON.stringify(line1.tags));
  add('evidence 只留白名单字段，其余丢弃', line1.evidence.runId === 'run_a' && line1.evidence.errorCode === 'RUNTIME_CRASH' && !('junk' in line1.evidence), JSON.stringify(line1.evidence));
  add('ts 保留为整数', line1.ts === 1700000000000, String(line1.ts));
  add('verified=true 落盘且 verifiedBy 去重清洗', line1.verified === true && JSON.stringify(line1.verifiedBy) === JSON.stringify(['npm test']), JSON.stringify(line1.verifiedBy));

  /* 3. 幂等：按 (taskId, kind) 去重 */
  const dup = lessons.recordLesson(store, { taskId: 'task_a', kind: 'outcome', outcome: 'failed', summary: '不应写入' });
  add('重复 (taskId,kind) 命中幂等', dup.ok === true && dup.deduped === true && dup.entry.outcome === 'success', 'deduped');
  add('幂等命中后仍只有一行', fs.readFileSync(file, 'utf8').trim().split('\n').length === 1, '1 line');
  const secondKind = lessons.recordLesson(store, { taskId: 'task_a', kind: 'lesson', summary: '经验：先跑 check 再交付', tags: ['交付'] });
  add('同 taskId 不同 kind 允许各记一条', secondKind.ok === true && fs.readFileSync(file, 'utf8').trim().split('\n').length === 2, '2 lines');
  add('lesson 记录不带 verified 门槛字段', !('verified' in secondKind.entry) && !('tainted' in secondKind.entry), JSON.stringify(secondKind.entry));

  /* 4. 损坏行跳过 */
  fs.appendFileSync(file, 'this is not json\n', 'utf8');
  fs.appendFileSync(file, JSON.stringify({ taskId: '', kind: 'nope' }) + '\n', 'utf8');
  fs.appendFileSync(file, '[1,2,3]\n', 'utf8');
  const afterBad = store.readAll();
  add('损坏行跳过且计数', afterBad.entries.length === 2 && afterBad.corrupted === 3, `entries=${afterBad.entries.length} corrupted=${afterBad.corrupted}`);

  /* 5. 查询与过滤（验证门：outcome 默认只返回 verified=true 且未污染的） */
  const now = 1700000100000;
  lessons.recordLesson(store, { taskId: 'task_b', agentId: 'agent_sub', kind: 'outcome', outcome: 'failed', summary: '委派子任务失败', tags: ['agent_sub', 'delegation'], evidence: { runId: 'run_b', errorCode: 'TIMEOUT' }, verified: true, ts: now });
  lessons.recordLesson(store, { taskId: 'task_c', agentId: 'agent_main', kind: 'outcome', outcome: 'canceled', summary: '用户取消', tags: ['agent_main'], verified: false, ts: now + 1000 });
  const byOutcome = lessons.queryLessons(store, { outcome: 'failed' });
  add('按 outcome 过滤', byOutcome.total === 1 && byOutcome.entries[0].taskId === 'task_b', `total=${byOutcome.total}`);
  const byTags = lessons.queryLessons(store, { tags: ['delegation'] });
  add('按 tags 过滤（AND 语义）', byTags.total === 1 && byTags.entries[0].taskId === 'task_b', `total=${byTags.total}`);
  const byTagsAnd = lessons.queryLessons(store, { tags: ['delegation', 'agent_main'] });
  add('不存在的标签组合返回空', byTagsAnd.total === 0, 'AND 语义');
  const since = lessons.queryLessons(store, { sinceTs: now + 500 });
  add('sinceTs 过滤且默认排除未验证 outcome（task_c，lesson 记录不受门槛限制）', !since.entries.some((e) => e.taskId === 'task_c')
    && since.entries.every((e) => e.kind !== 'outcome'), `total=${since.total}`);
  const sinceAll = lessons.queryLessons(store, { sinceTs: now + 500, includeUnverified: true });
  add('includeUnverified 显式含入未验证 outcome', sinceAll.entries.every((e) => Number(e.ts) >= now + 500)
    && sinceAll.entries.some((e) => e.taskId === 'task_c'), `total=${sinceAll.total}`);
  const limited = lessons.queryLessons(store, { limit: 2 });
  add('limit 默认只返回可信记录且按 ts 降序', limited.entries.length === 2
    && limited.entries.every((e) => e.kind !== 'outcome' || e.verified === true)
    && Number(limited.entries[0].ts) >= Number(limited.entries[1].ts), `total=${limited.total}`);
  const limitedAll = lessons.queryLessons(store, { limit: 2, includeUnverified: true });
  add('includeUnverified 后 limit 覆盖未验证记录', limitedAll.entries.length === 2
    && limitedAll.entries.some((e) => e.taskId === 'task_c'), JSON.stringify(limitedAll.entries.map((e) => e.taskId)));
  add('查询带出损坏行计数', limited.corrupted === 3, String(limited.corrupted));

  /* 6. stats 聚合（默认只统计可信条目；total/corrupted 是全量文件事实） */
  const st = lessons.stats(store);
  add('stats 默认只统计可信 outcome（未验证 canceled 被排除）', st.byOutcome.success === 1 && st.byOutcome.failed === 1 && st.byOutcome.canceled === 0, JSON.stringify(st.byOutcome));
  const stAll = lessons.stats(store, { includeUnverified: true });
  add('stats includeUnverified 显式含入', stAll.byOutcome.canceled === 1, JSON.stringify(stAll.byOutcome));
  add('stats 汇总数、损坏行与门槛计数（total 为全量事实）', st.total === 4 && st.corrupted === 3 && st.unverified === 1 && st.tainted === 0,
    `total=${st.total} corrupted=${st.corrupted} unverified=${st.unverified} tainted=${st.tainted}`);
  add('stats byTag 默认只含可信条目', st.byTag.agent_main === 1 && st.byTag.agent_sub === 1 && st.byTag.delegation === 1 && st.byTag['交付'] === 1, JSON.stringify(st.byTag));
  add('stats byTag 含入未验证后计数恢复', stAll.byTag.agent_main === 2, JSON.stringify(stAll.byTag));
  add('stats 附 per-tag 置信（全成功 → trusted）', st.confidence.agent_main === 'trusted' && st.byTagOutcome.agent_main.successes === 1, JSON.stringify(st.confidence));
  add('stats 附 per-tag 置信（数据不足 → insufficient）', st.confidence.agent_sub === 'insufficient' && st.confidence.delegation === 'insufficient' && st.confidence['交付'] === 'insufficient', JSON.stringify(st.confidence));

  /* 7. 污点判定 detectTaint：成功写入测试文件 / 验证器配置 → 污染；普通代码 / 失败写入 → 干净 */
  add('taint：写 app.test.js → edited-tests', (() => {
    const r = lessons.detectTaint([{ name: 'write_file', args: { path: 'src/app.test.js', content: 'x' }, ok: true }]);
    return r.tainted === true && r.reason === 'edited-tests';
  })(), 'edited-tests');
  add('taint：写 user.spec.ts → edited-tests', lessons.detectTaint([{ name: 'write_file', args: { path: 'test/user.spec.ts' }, ok: true }]).reason === 'edited-tests', 'spec');
  add('taint：写测试目录 __tests__/ 下的文件 → edited-tests', lessons.detectTaint([{ name: 'write_file', args: { path: '__tests__/foo.js' }, ok: true }]).tainted === true, '__tests__');
  add('taint：写 test_*.py → edited-tests', lessons.detectTaint([{ name: 'write_file', args: { path: 'tests/test_login.py' }, ok: true }]).tainted === true, 'test_*.py');
  add('taint：写普通源码不污染', (() => {
    const r = lessons.detectTaint([{ name: 'write_file', args: { path: 'src/app.js', content: 'x' }, ok: true }]);
    return r.tainted === false && r.reason === '';
  })(), 'clean');
  add('taint：写失败的测试文件不污染（ok=false 不算改动）', lessons.detectTaint([{ name: 'write_file', args: { path: 'app.test.js' }, ok: false }]).tainted === false, 'failed write');
  add('taint：改 package.json → edited-verifier-config', (() => {
    const r = lessons.detectTaint([{ name: 'write_file', args: { path: 'package.json' }, ok: true }]);
    return r.tainted === true && r.reason === 'edited-verifier-config';
  })(), 'verifier config');
  add('taint：改 vitest.config.ts → edited-verifier-config', lessons.detectTaint([{ name: 'write_file', args: { path: 'vitest.config.ts' }, ok: true }]).reason === 'edited-verifier-config', 'vitest.config');
  add('taint：两类同时命中 reason 用 + 连接', lessons.detectTaint([
    { name: 'write_file', args: { path: 'jest.config.js' }, ok: true },
    { name: 'write_file', args: { path: 'a.spec.js' }, ok: true },
  ]).reason === 'edited-tests+edited-verifier-config', 'joined');
  add('taint：非 write_file 工具不产生污点（run_command 删测试文件不算）', lessons.detectTaint([{ name: 'run_command', args: { command: 'rm app.test.js' }, ok: true }]).tainted === false, 'only write_file');
  add('taint：Windows 反斜杠路径可识别', lessons.detectTaint([{ name: 'write_file', args: { path: 'src\\app.test.js' }, ok: true }]).tainted === true, 'backslash');
  add('taint：空链 / 非法输入视为干净', lessons.detectTaint([]).tainted === false
    && lessons.detectTaint(null).tainted === false
    && lessons.detectTaint([null, 42, { name: 'write_file' }, { name: 'write_file', args: {}, ok: true }]).tainted === false, 'robust');

  /* 8. 验证门 detectVerification：验证类命令退出码 0 → verified；失败 / 无命令 → false */
  add('verified：npm test 通过 → true 且 verifiedBy 记录命令', (() => {
    const r = lessons.detectVerification([{ name: 'run_command', args: { command: 'npm test' }, ok: true, exitCode: 0 }]);
    return r.verified === true && JSON.stringify(r.verifiedBy) === JSON.stringify(['npm test']);
  })(), 'npm test');
  add('verified：npm test 失败（退出码 1）→ false', (() => {
    const r = lessons.detectVerification([{ name: 'run_command', args: { command: 'npm test' }, ok: false, exitCode: 1 }]);
    return r.verified === false && r.verifiedBy.length === 0;
  })(), 'exit 1');
  add('verified：无工具链 / 无验证命令 → false', lessons.detectVerification([]).verified === false
    && lessons.detectVerification([{ name: 'write_file', args: { path: 'a.js' }, ok: true }]).verified === false, 'no verify cmd');
  add('verified：npm run build 通过 → true', lessons.detectVerification([{ name: 'run_command', args: { command: 'npm run build' }, exitCode: 0 }]).verified === true, 'build');
  add('verified：tsc --noEmit 通过 → true', lessons.detectVerification([{ name: 'run_command', args: { command: 'npx tsc --noEmit' }, exitCode: 0 }]).verified === true, 'tsc');
  add('verified：非验证命令（ls）通过也不算验证', lessons.detectVerification([{ name: 'run_command', args: { command: 'ls -la' }, exitCode: 0 }]).verified === false, 'ls');
  add('verified：多条验证命令去重且失败的不进 verifiedBy', (() => {
    const r = lessons.detectVerification([
      { name: 'run_command', args: { command: 'npm test' }, exitCode: 0 },
      { name: 'run_command', args: { command: 'npm test' }, exitCode: 0 },
      { name: 'run_command', args: { command: 'pnpm build' }, exitCode: 2 },
    ]);
    return r.verified === true && JSON.stringify(r.verifiedBy) === JSON.stringify(['npm test']);
  })(), 'dedupe');

  /* 9. 置信门 confidenceFor 三态（ruflo CAUTION_MIN_FAILURES 模式） */
  add('confidence：verified 成功1 + 失败2 → caution', lessons.confidenceFor('t', { successes: 1, failures: 2 }) === 'caution', 'caution');
  add('confidence：verified 成功3 + 失败5 → caution', lessons.confidenceFor('t', { successes: 3, failures: 5 }) === 'caution', 'caution 2');
  add('confidence：全 verified 成功 → trusted', lessons.confidenceFor('t', { successes: 1, failures: 0 }) === 'trusted'
    && lessons.confidenceFor('t', { successes: 9, failures: 0 }) === 'trusted', 'trusted');
  add('confidence：数据不足 → insufficient（无成功 / 1失败 / 空计数）', lessons.confidenceFor('t', { successes: 0, failures: 2 }) === 'insufficient'
    && lessons.confidenceFor('t', { successes: 1, failures: 1 }) === 'insufficient'
    && lessons.confidenceFor('t', {}) === 'insufficient', 'insufficient');
  add('confidence：非法输入 → insufficient', lessons.confidenceFor('t', null) === 'insufficient'
    && lessons.confidenceFor('t', { successes: -3, failures: 'x' }) === 'insufficient', 'robust');
  add('confidence：CAUTION_MIN_FAILURES 常量为 2', lessons.CAUTION_MIN_FAILURES === 2, String(lessons.CAUTION_MIN_FAILURES));

  /* 10. 环形上限：超过 500 条裁最旧 */
  const ringFile = path.join(tmp, 'ring.jsonl');
  const ringStore = lessons.createLessonStore(ringFile);
  const ringEntries = [];
  for (let i = 0; i < lessons.MAX_LESSONS + 5; i++) {
    ringEntries.push(JSON.stringify({ taskId: `task_ring_${String(i).padStart(4, '0')}`, kind: 'outcome', outcome: 'success', summary: `第 ${i} 条`, tags: [], evidence: {}, ts: 1700000000000 + i }));
  }
  fs.writeFileSync(ringFile, ringEntries.join('\n') + '\n', 'utf8');
  const ringRes = lessons.recordLesson(ringStore, { taskId: 'task_ring_new', kind: 'outcome', outcome: 'success', summary: '触发裁剪', ts: 1700000999999 });
  const ringLines = fs.readFileSync(ringFile, 'utf8').trim().split('\n');
  add('环形上限后正好 500 条', ringRes.ok === true && ringLines.length === lessons.MAX_LESSONS, `lines=${ringLines.length}`);
  add('裁掉的是最旧记录（506 条裁掉前 6 条）', !ringLines.some((l) => l.includes('task_ring_0000'))
    && !ringLines.some((l) => l.includes('task_ring_0005'))
    && ringLines.some((l) => l.includes('task_ring_0006')), 'oldest gone');
  add('最新记录仍在', ringLines.some((l) => l.includes('task_ring_new')), 'newest kept');
  add('裁剪后每行仍是合法 JSON', ringLines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), 'valid jsonl');

  /* 11. runtime 接线冒烟：任务收尾 / 取消 / 委派收尾自动入库 */
  const rdir = tempDir('runtime');
  const rt = runtimeModule.createRuntime({ dir: rdir, workspacePath: tmp }).init();
  const agentId = rt.stateStore.getDefaultAgent()?.id || '';

  const t1 = rt.createTask({ title: '经验库冒烟任务', input: '验证任务收尾自动写入经验库', idempotencyKey: 'lesson-smoke-1' });
  rt.finishRun({ runId: t1.data.run.id, outcome: 'succeeded', summary: '完成' });
  const t2 = rt.createTask({ title: '取消冒烟', input: '验证取消路径', idempotencyKey: 'lesson-smoke-2' });
  rt.cancelTask({ taskId: t2.data.task.id, reason: 'lesson_smoke' });
  const t3 = rt.createTask({ title: '失败冒烟', input: '验证失败路径', idempotencyKey: 'lesson-smoke-3' });
  rt.finishRun({ runId: t3.data.run.id, outcome: 'failed', errorCode: 'LESSON_SMOKE', summary: '失败' });

  const rtFile = path.join(rdir, 'lessons.jsonl');
  const rtStore = lessons.createLessonStore(rtFile);
  const rtEntries = rtStore.readAll().entries;
  const findTask = (id) => rtEntries.find((e) => e.taskId === id);
  add('runtime：run 成功收尾自动记 outcome', findTask(t1.data.task.id)?.outcome === 'success' && findTask(t1.data.task.id)?.tags.includes(agentId), 'success + [agentId]');
  add('runtime：summary 是目标前 120 字 + 结束标签', (findTask(t1.data.task.id)?.summary || '').endsWith('[succeeded]'), findTask(t1.data.task.id)?.summary);
  add('runtime：取消路径自动记 outcome', findTask(t2.data.task.id)?.outcome === 'canceled', 'canceled');
  add('runtime：失败路径带 errorCode 证据', findTask(t3.data.task.id)?.outcome === 'failed' && findTask(t3.data.task.id)?.evidence.errorCode === 'LESSON_SMOKE', 'evidence.errorCode');

  // 委派收尾：直接走 StateStore.updateDelegation 的终态钩子（DelegationService.finish 的回存点）
  const del = rt.stateStore.createDelegationRecord({ parentTaskId: t1.data.task.id, parentRunId: t1.data.run.id, targetAgentId: agentId, childTaskId: t2.data.task.id, childRunId: t2.data.run.id, objective: '委派冒烟目标' });
  rt.stateStore.updateDelegation(del.id, { status: 'succeeded', summary: '委派完成' });
  const delLesson = rtEntries.concat(rtStore.readAll().entries).find((e) => e.taskId === del.id);
  add('runtime：委派收尾自动记 outcome 且 tag 含 delegation', delLesson?.outcome === 'success' && delLesson?.tags.includes('delegation'), JSON.stringify(delLesson?.tags));

  // 级联取消：父任务取消会级联取消委派（_cancelDelegationsForTask 的钩子）
  const rt2dir = tempDir('runtime2');
  const rt2 = runtimeModule.createRuntime({ dir: rt2dir, workspacePath: tmp }).init();
  const p = rt2.createTask({ title: '级联取消父任务', input: 'p', idempotencyKey: 'lesson-smoke-4' });
  const del2 = rt2.stateStore.createDelegationRecord({ parentTaskId: p.data.task.id, parentRunId: p.data.run.id, targetAgentId: agentId, childTaskId: p.data.task.id, childRunId: p.data.run.id, objective: '级联取消目标' });
  rt2.cancelTask({ taskId: p.data.task.id, reason: 'lesson_smoke' });
  const del2Lesson = lessons.createLessonStore(path.join(rt2dir, 'lessons.jsonl')).readAll().entries.find((e) => e.taskId === del2.id);
  add('runtime：父任务取消级联记委派 canceled', del2Lesson?.outcome === 'canceled' && del2Lesson?.tags.includes('delegation'), 'delegation canceled');
  add('runtime：同一 taskId 重复收尾幂等', rt.finishRun({ runId: t1.data.run.id, outcome: 'succeeded', summary: 'again' }).data?.deduped === true
    && lessons.createLessonStore(rtFile).readAll().entries.filter((e) => e.taskId === t1.data.task.id).length === 1, '1 entry only');

  /* 12. 钩子异常隔离：经验库 IO 故障不得影响主链路 / 事件链 */
  const rt3dir = tempDir('runtime3');
  const rt3 = runtimeModule.createRuntime({ dir: rt3dir, workspacePath: tmp }).init();
  rt3.stateStore.lessons = { path: 'Z:\\definitely\\locked.jsonl', readAll() { throw new Error('boom'); }, appendLine() { throw new Error('boom'); } };
  const beforeSeq = rt3.store.lastSeq;
  const t4 = rt3.createTask({ title: '故障注入', input: '经验库异常不影响主链路', idempotencyKey: 'lesson-smoke-5' });
  const finishRes = rt3.finishRun({ runId: t4.data.run.id, outcome: 'succeeded', summary: '仍应成功' });
  const taskStillOk = finishRes.ok === true && finishRes.data.run.status === 'succeeded';
  const eventsStillOk = rt3.store.lastSeq > beforeSeq && rt3.audit.verify().ok;
  add('经验库故障时任务收尾不受影响', taskStillOk, JSON.stringify(finishRes.error || {}));
  add('经验库故障时事件链/审计链不受影响', eventsStillOk, `seq ${beforeSeq} -> ${rt3.store.lastSeq}`);

  /* 13. runtime 验证门接线：污点写入 + 验证命令通过 → outcome 带 verified/tainted */
  const rt4dir = tempDir('runtime4');
  const rt4 = runtimeModule.createRuntime({ dir: rt4dir, workspacePath: tmp }).init();
  /** 造一个工具调用并推进到指定终态（proposed → policy_check → ready → executing → 终态） */
  const mkCall = (store, runId, name, args, status = 'succeeded', patch = {}) => {
    const call = store.createToolCall({ runId, name, args });
    store.setToolCallStatus(call.id, 'policy_check', {});
    store.setToolCallStatus(call.id, 'ready', {});
    store.setToolCallStatus(call.id, 'executing', {});
    store.setToolCallStatus(call.id, status, patch);
    return call.id;
  };
  const t5 = rt4.createTask({ title: '验证门冒烟', input: '写测试文件+跑测试', idempotencyKey: 'lesson-gate-1' });
  mkCall(rt4.stateStore, t5.data.run.id, 'write_file', { path: 'src/app.test.js', content: 'x' });
  mkCall(rt4.stateStore, t5.data.run.id, 'run_command', { command: 'npm test' }, 'succeeded', { resultMeta: { exitCode: 0 } });
  rt4.finishRun({ runId: t5.data.run.id, outcome: 'succeeded', summary: '完成' });
  const gateStore = lessons.createLessonStore(path.join(rt4dir, 'lessons.jsonl'));
  const gateEntry = gateStore.readAll().entries.find((e) => e.taskId === t5.data.task.id);
  add('runtime：写测试文件 → outcome tainted=true 且 reason=edited-tests', gateEntry?.tainted === true && gateEntry?.taintReason === 'edited-tests', JSON.stringify(gateEntry));
  add('runtime：npm test 通过 → outcome verified=true 且 verifiedBy 含命令', gateEntry?.verified === true && Array.isArray(gateEntry?.verifiedBy) && gateEntry.verifiedBy.includes('npm test'), JSON.stringify(gateEntry?.verifiedBy));
  add('runtime：污染记录默认被 query 排除（防自欺）', lessons.queryLessons(gateStore, { outcome: 'success' }).total === 0, 'tainted excluded');
  add('runtime：includeTainted 显式含入污染记录', lessons.queryLessons(gateStore, { outcome: 'success', includeTainted: true }).total === 1, 'tainted included');

  // 干净任务：只写源码、不跑验证命令 → verified=false 且不携带 tainted 字段
  const t6 = rt4.createTask({ title: '干净任务冒烟', input: '只写源码不跑测试', idempotencyKey: 'lesson-gate-2' });
  mkCall(rt4.stateStore, t6.data.run.id, 'write_file', { path: 'src/index.js', content: 'x' });
  rt4.finishRun({ runId: t6.data.run.id, outcome: 'succeeded', summary: '完成' });
  const cleanEntry = gateStore.readAll().entries.find((e) => e.taskId === t6.data.task.id);
  add('runtime：干净任务 verified=false 且无 tainted 字段', cleanEntry?.verified === false && !('tainted' in (cleanEntry || {})), JSON.stringify(cleanEntry));

  // 委派收尾的验证门：沿用子任务（childTaskId）的工具执行链判定
  const del3 = rt4.stateStore.createDelegationRecord({
    parentTaskId: t6.data.task.id, parentRunId: t6.data.run.id, targetAgentId: agentId,
    childTaskId: t5.data.task.id, childRunId: t5.data.run.id, objective: '委派验证门冒烟',
  });
  rt4.stateStore.updateDelegation(del3.id, { status: 'succeeded' });
  const del3Entry = gateStore.readAll().entries.find((e) => e.taskId === del3.id);
  add('runtime：委派收尾沿用子任务工具链的污点/验证判定', del3Entry?.tainted === true && del3Entry?.verified === true, JSON.stringify(del3Entry));

  /* 14. 取消路径也过验证门：取消前改了验证器配置 → 委派/任务 outcome 污染 */
  const rt5dir = tempDir('runtime5');
  const rt5 = runtimeModule.createRuntime({ dir: rt5dir, workspacePath: tmp }).init();
  const t7 = rt5.createTask({ title: '取消验证门冒烟', input: '取消前改了 package.json', idempotencyKey: 'lesson-gate-3' });
  mkCall(rt5.stateStore, t7.data.run.id, 'write_file', { path: 'package.json', content: '{}' });
  rt5.cancelTask({ taskId: t7.data.task.id, reason: 'lesson_smoke' });
  const cancelEntry = lessons.createLessonStore(path.join(rt5dir, 'lessons.jsonl')).readAll().entries.find((e) => e.taskId === t7.data.task.id);
  add('runtime：取消路径过验证门（改验证器配置 → tainted）', cancelEntry?.tainted === true && cancelEntry?.taintReason === 'edited-verifier-config' && cancelEntry?.outcome === 'canceled', JSON.stringify(cancelEntry));

  /* 15. 置信门端到端：1 成功 + 2 失败 → caution；污染的成功不参与可信度 */
  const confStore = lessons.createLessonStore(path.join(tmp, 'conf.jsonl'));
  lessons.recordLesson(confStore, { taskId: 'task_ca1', agentId: 'agent_x', kind: 'outcome', outcome: 'success', summary: '成功1', tags: ['agent_x'], verified: true, ts: 1 });
  lessons.recordLesson(confStore, { taskId: 'task_cf1', agentId: 'agent_x', kind: 'outcome', outcome: 'failed', summary: '失败1', tags: ['agent_x'], verified: true, ts: 2 });
  add('confidence：1成功+1失败仍是 insufficient', lessons.stats(confStore).confidence.agent_x === 'insufficient', 'insufficient');
  lessons.recordLesson(confStore, { taskId: 'task_cf2', agentId: 'agent_x', kind: 'outcome', outcome: 'failed', summary: '失败2', tags: ['agent_x'], verified: true, ts: 3 });
  const confEnd = lessons.stats(confStore);
  add('confidence：1成功+2失败 → caution（byTagOutcome 明细正确）', confEnd.confidence.agent_x === 'caution'
    && confEnd.byTagOutcome.agent_x.successes === 1 && confEnd.byTagOutcome.agent_x.failures === 2, JSON.stringify(confEnd.confidence));

  const taintStore = lessons.createLessonStore(path.join(tmp, 'taint-conf.jsonl'));
  lessons.recordLesson(taintStore, { taskId: 'task_t1', agentId: 'agent_y', kind: 'outcome', outcome: 'success', summary: '被污染的成功', tags: ['agent_y'], verified: true, tainted: true, taintReason: 'edited-tests', ts: 1 });
  lessons.recordLesson(taintStore, { taskId: 'task_t2', agentId: 'agent_y', kind: 'outcome', outcome: 'failed', summary: '失败1', tags: ['agent_y'], verified: true, ts: 2 });
  lessons.recordLesson(taintStore, { taskId: 'task_t3', agentId: 'agent_y', kind: 'outcome', outcome: 'failed', summary: '失败2', tags: ['agent_y'], verified: true, ts: 3 });
  const taintStats = lessons.stats(taintStore);
  add('confidence：污染的成功不参与可信度 → insufficient', taintStats.confidence.agent_y === 'insufficient', JSON.stringify(taintStats.confidence));
  add('stats：tainted 计数且默认从 byOutcome 排除', taintStats.tainted === 1 && taintStats.byOutcome.success === 0 && taintStats.byOutcome.failed === 2, JSON.stringify(taintStats.byOutcome));

  /* 16. Hybrid 检索组合：searchLessons（queryLessons × hybridSearch）与 relatedLessonsForTask */
  const hybStore = lessons.createLessonStore(path.join(tmp, 'hybrid.jsonl'));
  lessons.recordLesson(hybStore, { taskId: 'task_h1', kind: 'lesson', summary: '数据库连接池大小应按并发量配置，超时后自动重连', tags: ['db'], ts: 1 });
  lessons.recordLesson(hybStore, { taskId: 'task_h2', kind: 'lesson', summary: '前端渲染卡顿应检查重排与虚拟列表', tags: ['ui'], ts: 2 });
  lessons.recordLesson(hybStore, { taskId: 'task_h3', kind: 'outcome', outcome: 'success', summary: '网关端口 8787 被占用：先查占用进程再重启网关服务', tags: ['gw'], verified: true, ts: 3 });
  lessons.recordLesson(hybStore, { taskId: 'task_h4', kind: 'outcome', outcome: 'failed', summary: '数据库连接池超时未配置重连导致失败', tags: ['db'], verified: false, ts: 4 });
  const dupText = '部署脚本执行失败：环境变量未注入，重新部署后恢复正常';
  lessons.recordLesson(hybStore, { taskId: 'task_h5', kind: 'lesson', summary: dupText, ts: 5 });
  lessons.recordLesson(hybStore, { taskId: 'task_h6', kind: 'lesson', summary: dupText, ts: 6 });
  lessons.recordLesson(hybStore, { taskId: 'task_h7', kind: 'lesson', summary: '部署预览与主题切换整理', ts: 7 });

  const zh = lessons.searchLessons(hybStore, '数据库连接池');
  add('searchLessons：中文查询命中相关 lesson（bigram + 精确加分，首条即最高分）',
    zh.hits.length > 0 && zh.hits[0].entry.taskId === 'task_h1' && zh.hits[0].score > 0,
    JSON.stringify(zh.hits.map((h) => [h.entry.taskId, h.score])));
  add('searchLessons：未验证 outcome 被默认门槛排除（task_h4 不参与检索）',
    zh.hits.every((h) => h.entry.taskId !== 'task_h4'), 'verified gate');
  add('searchLessons：返回结构 {entry,score} 且 score ∈ [0,1]',
    zh.hits.every((h) => h.entry && typeof h.entry.taskId === 'string' && typeof h.score === 'number' && h.score >= 0 && h.score <= 1), 'shape');
  add('searchLessons：total 为过滤后候选总数（6 条可信，未验证不计）', zh.total === 6, `total=${zh.total}`);
  add('searchLessons：topK 截断', lessons.searchLessons(hybStore, '部署', { topK: 2 }).hits.length === 2, 'topK 2');
  add('searchLessons：空查询安全返回空 hits（total 仍为候选数）', (() => {
    const r = lessons.searchLessons(hybStore, '   ');
    return r.hits.length === 0 && r.total === 6;
  })(), 'blank query');

  // MMR 去重：task_h5 / task_h6 summary 完全相同（不同 taskId 各记一条），只应留高分一条；
  // query 拆成「部署脚本失败」+「网关端口被占用」两半，让 h3（网关侧）与重复对（部署侧）竞争。
  const mmr = lessons.searchLessons(hybStore, '部署脚本失败 网关端口被占用', { topK: 2 });
  const dupIds = mmr.hits.filter((h) => h.entry.taskId === 'task_h5' || h.entry.taskId === 'task_h6');
  add('searchLessons：MMR 去重（完全相同 summary 只留高分一条，多样条目补位）',
    mmr.hits.length === 2 && dupIds.length === 1 && mmr.hits.some((h) => h.entry.taskId === 'task_h3'),
    JSON.stringify(mmr.hits.map((h) => [h.entry.taskId, h.score])));

  // relatedLessonsForTask：结构关联（精确 / 前缀 / tag）+ 关键词双路合并去重
  const relStore = lessons.createLessonStore(path.join(tmp, 'related.jsonl'));
  lessons.recordLesson(relStore, { taskId: 'task_rel_1', kind: 'lesson', summary: '经验库要支持混合检索与任务关联', tags: ['lessons', 'retrieval'], ts: 10 });
  lessons.recordLesson(relStore, { taskId: 'task_rel_1', kind: 'outcome', outcome: 'success', summary: '混合检索实现完成并通过自检', tags: ['retrieval'], verified: true, ts: 11 });
  lessons.recordLesson(relStore, { taskId: 'task_rel_1_sub', kind: 'lesson', summary: '子任务拆分时前缀命名便于关联查询', tags: ['task_rel_1'], ts: 12 });
  lessons.recordLesson(relStore, { taskId: 'task_other', kind: 'lesson', summary: '前端渲染卡顿应检查重排与虚拟列表', tags: ['ui'], ts: 13 });
  lessons.recordLesson(relStore, { taskId: 'task_rel_2', kind: 'lesson', summary: '经验库要支持混合检索与任务关联的补充说明', tags: ['misc'], ts: 14 });
  lessons.recordLesson(relStore, { taskId: 'task_tagonly', kind: 'lesson', summary: '渲染管线与着色器编译注意事项', tags: ['task_rel_1'], ts: 15 });

  const rel = lessons.relatedLessonsForTask(relStore, 'task_rel_1');
  const relIds = rel.hits.map((h) => h.entry.taskId);
  add('related：精确 taskId 命中（同 taskId 的 lesson + outcome 两条都在）', relIds.includes('task_rel_1'), JSON.stringify(relIds));
  add('related：taskId 前缀命中子任务（task_rel_1_sub）', relIds.includes('task_rel_1_sub'), JSON.stringify(relIds));
  add('related：tag 命中（summary 与关键词无关但 tags 带 taskId）', relIds.includes('task_tagonly'), JSON.stringify(relIds));
  add('related：关键词路命中（summary 与该任务记录相似的其他任务）', relIds.includes('task_rel_2'), JSON.stringify(relIds));
  add('related：无关任务不入榜（task_other 与关键词零交集）', !relIds.includes('task_other'), JSON.stringify(relIds));
  add('related：按 (taskId,kind) 去重且 total 为去重后条数',
    new Set(rel.hits.map((h) => `${h.entry.taskId}\u0001${h.entry.kind}`)).size === rel.hits.length
    && rel.hits.length === rel.total && rel.total === 5, `total=${rel.total} hits=${rel.hits.length}`);
  add('related：按 score 降序且都在 [0,1]',
    rel.hits.every((h, i) => i === 0 || rel.hits[i - 1].score >= h.score)
    && rel.hits.every((h) => h.score >= 0 && h.score <= 1), JSON.stringify(rel.hits.map((h) => h.score)));
  add('related：精确 taskId 的结构分（1）高于纯关键词语义分（<1）', (() => {
    const exact = rel.hits.find((h) => h.entry.taskId === 'task_rel_1');
    const kwOnly = rel.hits.find((h) => h.entry.taskId === 'task_rel_2');
    return !!exact && !!kwOnly && exact.score === 1 && kwOnly.score < 1;
  })(), 'exact > keyword');

  /* 17. 空库 / 非法输入 / 故障注入：一律 {hits:[], total:0}，绝不抛错 */
  const emptyStore = lessons.createLessonStore(path.join(tmp, 'empty.jsonl'));
  const emptySearch = lessons.searchLessons(emptyStore, '任意查询');
  const emptyRel = lessons.relatedLessonsForTask(emptyStore, 'task_x');
  add('searchLessons：空库安全', emptySearch.hits.length === 0 && emptySearch.total === 0, JSON.stringify(emptySearch));
  add('relatedLessonsForTask：空库安全', emptyRel.hits.length === 0 && emptyRel.total === 0, JSON.stringify(emptyRel));
  const badStore = { path: 'Z:\\bad.jsonl', readAll() { throw new Error('boom'); }, appendLine() { throw new Error('boom'); } };
  add('检索故障注入不抛错（坏 store / null store / 非字符串查询 / 空 taskId / null taskId）',
    (() => { const r = lessons.searchLessons(badStore, '查询'); return r.hits.length === 0 && r.total === 0; })()
    && (() => { const r = lessons.searchLessons(null, '查询'); return r.hits.length === 0 && r.total === 0; })()
    && (() => { const r = lessons.searchLessons(hybStore, 42); return r.hits.length === 0 && r.total === 0; })()
    && lessons.relatedLessonsForTask(relStore, '').total === 0
    && lessons.relatedLessonsForTask(relStore, null).total === 0
    && (() => { const r = lessons.relatedLessonsForTask(badStore, 'task_rel_1'); return r.hits.length === 0 && r.total === 0; })(),
    'fail-safe');

  /* 清理临时目录 */
  rt.close();
  rt2.close();
  rt3.close();
  rt4.close();
  rt5.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(rdir, { recursive: true, force: true });
  fs.rmSync(rt2dir, { recursive: true, force: true });
  fs.rmSync(rt3dir, { recursive: true, force: true });
  fs.rmSync(rt4dir, { recursive: true, force: true });
  fs.rmSync(rt5dir, { recursive: true, force: true });

  const total = checks.length;
  const passed = checks.filter((c) => c.pass).length;
  const out = { checks, total, passed, failed: total - passed };
  console.log(JSON.stringify(out, null, 2));
  if (out.failed) process.exitCode = 1;
})().catch((err) => {
  console.error('[lessons-check] 未捕获错误：', err);
  process.exitCode = 1;
});
