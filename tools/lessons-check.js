'use strict';

/* 验证经验库（lib/lessons.js）自检：追加 / 查询过滤 / 幂等去重 / 损坏行跳过 /
   环形上限 / runtime 收尾接线冒烟（钩子异常不影响主链路）。
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

  /* 3. 幂等：按 (taskId, kind) 去重 */
  const dup = lessons.recordLesson(store, { taskId: 'task_a', kind: 'outcome', outcome: 'failed', summary: '不应写入' });
  add('重复 (taskId,kind) 命中幂等', dup.ok === true && dup.deduped === true && dup.entry.outcome === 'success', 'deduped');
  add('幂等命中后仍只有一行', fs.readFileSync(file, 'utf8').trim().split('\n').length === 1, '1 line');
  const secondKind = lessons.recordLesson(store, { taskId: 'task_a', kind: 'lesson', summary: '经验：先跑 check 再交付', tags: ['交付'] });
  add('同 taskId 不同 kind 允许各记一条', secondKind.ok === true && fs.readFileSync(file, 'utf8').trim().split('\n').length === 2, '2 lines');

  /* 4. 损坏行跳过 */
  fs.appendFileSync(file, 'this is not json\n', 'utf8');
  fs.appendFileSync(file, JSON.stringify({ taskId: '', kind: 'nope' }) + '\n', 'utf8');
  fs.appendFileSync(file, '[1,2,3]\n', 'utf8');
  const afterBad = store.readAll();
  add('损坏行跳过且计数', afterBad.entries.length === 2 && afterBad.corrupted === 3, `entries=${afterBad.entries.length} corrupted=${afterBad.corrupted}`);

  /* 5. 查询与过滤 */
  const now = 1700000100000;
  lessons.recordLesson(store, { taskId: 'task_b', agentId: 'agent_sub', kind: 'outcome', outcome: 'failed', summary: '委派子任务失败', tags: ['agent_sub', 'delegation'], evidence: { runId: 'run_b', errorCode: 'TIMEOUT' }, ts: now });
  lessons.recordLesson(store, { taskId: 'task_c', agentId: 'agent_main', kind: 'outcome', outcome: 'canceled', summary: '用户取消', tags: ['agent_main'], ts: now + 1000 });
  const byOutcome = lessons.queryLessons(store, { outcome: 'failed' });
  add('按 outcome 过滤', byOutcome.total === 1 && byOutcome.entries[0].taskId === 'task_b', `total=${byOutcome.total}`);
  const byTags = lessons.queryLessons(store, { tags: ['delegation'] });
  add('按 tags 过滤（AND 语义）', byTags.total === 1 && byTags.entries[0].taskId === 'task_b', `total=${byTags.total}`);
  const byTagsAnd = lessons.queryLessons(store, { tags: ['delegation', 'agent_main'] });
  add('不存在的标签组合返回空', byTagsAnd.total === 0, 'AND 语义');
  const since = lessons.queryLessons(store, { sinceTs: now + 500 });
  add('按 sinceTs 过滤（旧记录被排除）', since.entries.every((e) => e.ts >= now + 500)
    && since.entries.some((e) => e.taskId === 'task_c')
    && !since.entries.some((e) => e.taskId === 'task_b'), `total=${since.total}`);
  const limited = lessons.queryLessons(store, { limit: 2 });
  add('limit 返回按 ts 降序的最新 N 条', limited.entries.length === 2
    && Number(limited.entries[0].ts) >= Number(limited.entries[1].ts), 'ts 降序');
  add('查询带出损坏行计数', limited.corrupted === 3, String(limited.corrupted));

  /* 6. stats 聚合 */
  const st = lessons.stats(store);
  add('stats 按 outcome 聚合', st.byOutcome.success === 1 && st.byOutcome.failed === 1 && st.byOutcome.canceled === 1, JSON.stringify(st.byOutcome));
  add('stats 按 tag 聚合', st.byTag.agent_main === 2 && st.byTag.delegation === 1, JSON.stringify(st.byTag));
  add('stats 汇总数与损坏行', st.total === 4 && st.corrupted === 3, `total=${st.total} corrupted=${st.corrupted}`);

  /* 7. 环形上限：超过 500 条裁最旧 */
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

  /* 8. runtime 接线冒烟：任务收尾 / 取消 / 委派收尾自动入库 */
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

  /* 9. 钩子异常隔离：经验库 IO 故障不得影响主链路 / 事件链 */
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

  /* 清理临时目录 */
  rt.close();
  rt2.close();
  rt3.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(rdir, { recursive: true, force: true });
  fs.rmSync(rt2dir, { recursive: true, force: true });
  fs.rmSync(rt3dir, { recursive: true, force: true });

  const total = checks.length;
  const passed = checks.filter((c) => c.pass).length;
  const out = { checks, total, passed, failed: total - passed };
  console.log(JSON.stringify(out, null, 2));
  if (out.failed) process.exitCode = 1;
})().catch((err) => {
  console.error('[lessons-check] 未捕获错误：', err);
  process.exitCode = 1;
});
