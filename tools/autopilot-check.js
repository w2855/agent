/**
 * Autopilot 自检（node tools/autopilot-check.js 直跑，mock taskApi，不依赖 Electron）
 * 覆盖：queued/paused 推进、空闲决策、连续失败自动停、maxIterations 停、
 * 环形日志 50、并发保护（start 幂等 / 在途只观察）、单轮超时、异常兜底。
 */

'use strict';

const { createAutopilot } = require('../lib/autopilot');

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { passed += 1; console.log(`  ok  ${passed}. ${name}`); }
  else { failed += 1; console.error(`  FAIL ${passed + failed}. ${name}`); }
}

/** 构造 mock：tasks 为可变数组；resumeFail 设为 Error 则推进抛错；resumeWaiting 设 true 则返回 {waiting:true} */
function makeMock(tasks) {
  const mock = {
    tasks,
    resumeCalls: [],
    resumeFail: null,
    resumeWaiting: false,
    notifyLog: [],
    async listTasks() { if (mock.listFail) throw mock.listFail; return { tasks: mock.tasks }; },
    async resumeTask({ taskId, reason }) {
      mock.resumeCalls.push({ taskId, reason });
      if (mock.resumeFail) throw mock.resumeFail;
      if (mock.resumeWaiting) return { waiting: true };
      return { task: { id: taskId } };
    },
    notify(payload) { mock.notifyLog.push(payload); },
  };
  return mock;
}

const lastAction = (ap) => ap.state().lastAction;
const actions = (ap) => ap.state().decisions.map((d) => d.action);

(async () => {
  console.log('[autopilot-check] 开始');

  // 0. taskApi 校验
  let threw = false;
  try { createAutopilot({}); } catch { threw = true; }
  assert(threw, '缺少 taskApi 时 createAutopilot 抛错');

  // 1. 默认态
  const m0 = makeMock([]);
  const ap0 = createAutopilot({ taskApi: m0, notify: m0.notify });
  const s0 = ap0.state();
  assert(!s0.enabled && s0.iteration === 0 && s0.lastAction === null && Array.isArray(s0.decisions) && s0.decisions.length === 0, '默认态 enabled=false / iteration=0 / 空日志');

  // 2. start 幂等（两次 start 只记一条 started，不产生双循环）
  ap0.start(); ap0.start();
  assert(ap0.state().enabled === true, 'start 后 enabled=true');
  assert(actions(ap0).filter((a) => a === 'started').length === 1, 'start 幂等：只记录一条 started');
  ap0.stop();

  // 3. stop 后 tick 不再决策
  const beforeStop = ap0.state().decisions.length;
  await ap0._tick();
  assert(ap0.state().decisions.length === beforeStop, 'stop 后 _tick 不产生新决策');

  // 4. queued 任务推进
  const m1 = makeMock([{ id: 'task_q1', status: 'queued', createdAt: 1 }]);
  const ap1 = createAutopilot({ taskApi: m1, notify: m1.notify });
  ap1.start();
  await ap1._tick();
  assert(lastAction(ap1) === 'advance' && m1.resumeCalls[0]?.taskId === 'task_q1', 'queued 任务被推进（resumeTask 调用）');
  assert(m1.resumeCalls[0]?.reason === 'autopilot_advance', '推进 reason=autopilot_advance');
  assert(ap1.state().iteration === 1, '推进后 iteration=1');
  ap1.stop();

  // 5. paused 优先于 queued
  const m2 = makeMock([{ id: 'task_q', status: 'queued', createdAt: 1 }, { id: 'task_p', status: 'paused', createdAt: 2 }]);
  const ap2 = createAutopilot({ taskApi: m2, notify: m2.notify });
  ap2.start();
  await ap2._tick();
  assert(m2.resumeCalls[0]?.taskId === 'task_p', 'paused 任务优先于 queued 推进');
  ap2.stop();

  // 6. queued 里选最旧
  const m3 = makeMock([
    { id: 'task_new', status: 'queued', createdAt: 20 },
    { id: 'task_old', status: 'queued', createdAt: 10 },
  ]);
  const ap3 = createAutopilot({ taskApi: m3, notify: m3.notify });
  ap3.start();
  await ap3._tick();
  assert(m3.resumeCalls[0]?.taskId === 'task_old', '多个 queued 时优先推进最旧（createdAt 小）');
  ap3.stop();

  // 7. 空闲决策
  const m4 = makeMock([]);
  const ap4 = createAutopilot({ taskApi: m4, notify: m4.notify, intervalMs: 1000 });
  ap4.start();
  await ap4._tick();
  assert(lastAction(ap4) === 'idle' && ap4.state().iteration === 0, '无任务时记录空闲决策，不耗迭代');
  ap4.stop();

  // 8. running / waiting_approval 只观察
  const m5 = makeMock([{ id: 'task_r', status: 'running' }]);
  const ap5 = createAutopilot({ taskApi: m5, notify: m5.notify });
  ap5.start();
  await ap5._tick();
  assert(lastAction(ap5) === 'observe' && m5.resumeCalls.length === 0, 'running 任务只观察不推进');
  ap5.stop();

  // 9. 终态任务带未完成子目标 → 等待用户（不虚构新任务）
  // 子目标任务存在但仍是 created（未被 runtime 排队，恢复 API 推不动）→ 只能等用户
  const m6 = makeMock([
    { id: 'task_parent', status: 'failed' },
    { id: 'task_child', status: 'created', parentTaskId: 'task_parent' },
  ]);
  const ap6 = createAutopilot({ taskApi: m6, notify: m6.notify });
  ap6.start();
  await ap6._tick();
  assert(lastAction(ap6) === 'waiting_user', '终态+未完成子目标 → waiting_user 决策');
  assert(m6.resumeCalls.length === 0, 'waiting_user 时不调用恢复（安全边界）');
  ap6.stop();

  // 10. 全部终态 → 停止 + 通知
  const m7 = makeMock([{ id: 'task_done', status: 'succeeded' }]);
  const ap7 = createAutopilot({ taskApi: m7, notify: m7.notify });
  ap7.start();
  await ap7._tick();
  assert(ap7.state().enabled === false, '全部终态 → 自动停止');
  assert(m7.notifyLog.some((n) => /全部任务/.test(n.body || '')), '全部终态 → 发出通知');
  assert(actions(ap7).includes('all_done'), '全部终态 → all_done 决策');

  // 11. 推进后收尾（下一 tick 任务已终态）→ 不误报超时，且 all_done
  const m8 = makeMock([{ id: 'task_x', status: 'queued', createdAt: 1 }]);
  const ap8 = createAutopilot({ taskApi: m8, notify: m8.notify, taskTimeoutMs: 0 /* 最苛刻时限 */ });
  ap8.start();
  await ap8._tick(); // 推进
  m8.tasks[0].status = 'succeeded';
  await ap8._tick(); // 收尾检查
  assert(!actions(ap8).includes('timeout'), '推进后任务已终态 → 不计超时');

  // 12. 单轮超时：任务长期不终态 → timeout 计失败；连续两次超时 → 自动停
  const m9 = makeMock([{ id: 'task_stuck', status: 'queued', createdAt: 1 }]);
  const ap9 = createAutopilot({ taskApi: m9, notify: m9.notify, taskTimeoutMs: -1 /* 立即超时 */ });
  ap9.start();
  await ap9._tick();
  m9.tasks[0].status = 'running';
  await ap9._tick(); // 超时 1
  assert(actions(ap9).includes('timeout'), '任务超时限未终态 → timeout 决策');
  await ap9._tick(); // 超时 2 → 连续失败 ≥2 → 停
  assert(ap9.state().enabled === false, '连续两次超时 → 自动停止');

  // 13. 并发保护：推进在途（未超时）→ 只观察，不叠加推进第二个 queued
  const m10 = makeMock([
    { id: 'task_a', status: 'queued', createdAt: 1 },
    { id: 'task_b', status: 'queued', createdAt: 2 },
  ]);
  const ap10 = createAutopilot({ taskApi: m10, notify: m10.notify });
  ap10.start();
  await ap10._tick(); // 推进 task_a
  m10.tasks[0].status = 'running';
  await ap10._tick(); // task_a 在途
  assert(lastAction(ap10) === 'observe' && m10.resumeCalls.length === 1, '在途任务未收尾时只观察（同时只推一个）');

  // 14. 连续 2 次推进失败 → 自动停
  const m11 = makeMock([{ id: 'task_f', status: 'queued', createdAt: 1 }]);
  m11.resumeFail = new Error('模拟恢复失败');
  const ap11 = createAutopilot({ taskApi: m11, notify: m11.notify });
  ap11.start();
  await ap11._tick();
  assert(ap11.state().enabled === true, '失败 1 次不停止');
  await ap11._tick();
  assert(ap11.state().enabled === false, '连续 2 次推进失败 → 自动停止');
  assert(m11.notifyLog.some((n) => /失败/.test(n.body || '')), '连续失败停止时发出通知');

  // 15. 成功推进清零失败计数（失败→成功→失败 不停）
  // 用一个常驻 running 任务垫底，避免唯一任务变终态触发 all_done 干扰
  const m12 = makeMock([{ id: 'task_bg', status: 'running' }, { id: 'task_t', status: 'queued', createdAt: 1 }]);
  const ap12 = createAutopilot({ taskApi: m12, notify: m12.notify });
  ap12.start();
  m12.resumeFail = new Error('x'); await ap12._tick(); // 失败 1
  m12.resumeFail = null;
  await ap12._tick(); // 成功推进 task_t → 清零
  m12.tasks = [{ id: 'task_bg', status: 'running' }, { id: 'task_t2', status: 'queued', createdAt: 2 }];
  m12.resumeFail = new Error('y');
  await ap12._tick(); // 又失败 1（task_t 已收尾离开列表）
  assert(ap12.state().enabled === true, '失败→成功→失败：计数被成功清零，不停');
  assert(ap12.state().iteration === 1, '成功清零后 iteration=1（只有一次成功推进）');

  // 16. maxIterations 达上限 → 停止 + 通知
  // 每次推进后把旧任务移出列表（模拟已收尾），补新 queued 继续推进
  const m15 = makeMock([{ id: 'g1', status: 'queued', createdAt: 1 }]);
  const ap15 = createAutopilot({ taskApi: m15, notify: m15.notify, maxIterations: 2 });
  ap15.start();
  await ap15._tick(); // 推进 g1 (iteration=1)
  m15.tasks = [{ id: 'g2', status: 'queued', createdAt: 2 }];
  await ap15._tick(); // g1 不在列表 = 已离开运行集；g2 推进 (iteration=2)
  await ap15._tick(); // iteration 2>=2 → 停
  assert(ap15.state().enabled === false, 'iteration 达 maxIterations(2) → 自动停止');
  assert(ap15.state().iteration === 2, '停止时 iteration=2');

  // 17. 环形日志上限 50
  const m16 = makeMock([]);
  const ap16 = createAutopilot({ taskApi: m16, notify: m16.notify });
  ap16.start();
  for (let i = 0; i < 55; i += 1) { /* eslint-disable no-await-in-loop */ await ap16._tick(); }
  const d16 = ap16.state().decisions;
  assert(d16.length === 50, '环形决策日志最多保留 50 条');
  assert(d16.every((d) => d.ts && typeof d.action === 'string' && typeof d.detail === 'string' && 'iteration' in d), '决策条目含 ts/action/detail/iteration 字段');
  assert(d16[0].ts <= d16[49].ts, '环形日志按时间有序（旧条目被裁剪）');

  // 18. listTasks 异常兜底：不外抛；连续 2 次 → 停
  const m17 = makeMock([]);
  m17.listFail = new Error('runtime 崩了');
  const ap17 = createAutopilot({ taskApi: m17, notify: m17.notify });
  ap17.start();
  await ap17._tick(); // error 1
  assert(ap17.state().enabled === true && lastAction(ap17) === 'error', 'listTasks 抛错 → tick 兜底记录 error 不外抛');
  await ap17._tick(); // error 2
  assert(ap17.state().enabled === false, 'runtime 连续异常 → 自动停止');

  // 19. waiting_schedule：闭包降级信号不计失败不耗迭代
  const m18 = makeMock([{ id: 'task_w', status: 'queued', createdAt: 1 }]);
  m18.resumeWaiting = true;
  const ap18 = createAutopilot({ taskApi: m18, notify: m18.notify });
  ap18.start();
  await ap18._tick();
  assert(lastAction(ap18) === 'waiting_schedule' && ap18.state().iteration === 0, 'resumeTask 返回 waiting → waiting_schedule 决策不耗迭代');
  ap18.stop();

  // 20. notify 抛错不影响主循环
  const m19 = makeMock([{ id: 'task_n', status: 'queued', createdAt: 1 }]);
  const ap19 = createAutopilot({ taskApi: m19, notify: () => { throw new Error('通知炸了'); } });
  ap19.start();
  await ap19._tick();
  assert(ap19.state().enabled === true && lastAction(ap19) === 'advance', 'notify 抛错被吞掉，推进照常');

  // 21. 重启重置迭代与失败计数，历史日志保留
  ap19.stop();
  const itBefore = ap19.state().iteration;
  ap19.start();
  assert(ap19.state().enabled === true && ap19.state().iteration === 0, `重启后 iteration 清零（停前 ${itBefore}）`);
  assert(ap19.state().decisions.length > 0, '重启保留历史决策日志');
  ap19.stop();

  console.log(`\n[autopilot-check] 通过 ${passed} / ${passed + failed}`);
  if (failed > 0) { console.error(`[autopilot-check] 失败 ${failed} 项`); process.exit(1); }
})().catch((err) => { console.error('[autopilot-check] 未捕获异常：', err); process.exit(1); });
