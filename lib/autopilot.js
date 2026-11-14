/**
 * Autopilot 主进程核心（无人值守循环）— ruflo 式轮询推进器
 *
 * 参考 ruflo autopilot-state.ts：maxIterations / 单轮超时 / 历史截断（环形日志）。
 *
 * 职责边界（安全设计）：
 * - 只「推进已存在的任务」（paused 恢复 / queued 触发），绝不虚构新任务；
 * - 终态任务带未完成子目标 → 只记录「等待用户」，不自动造新目标；
 * - 全部 runtime 调用 try/catch，autopilot 故障绝不影响主链路；
 * - 连续失败 ≥2 自动停（防无限失败循环烧钱）；达到 maxIterations 自动停。
 *
 * taskApi 契约（由 main.js 用 runtimeSvc 闭包适配）：
 * - listTasks() -> { tasks: Array<{ id, status, parentTaskId, ... }> }（同步或 Promise）
 * - resumeTask({ taskId, reason }) -> { task, run } 或 { waiting: true }（排队等待调度时返回，
 *   不计失败不迭代）；无法推进时抛错。
 */

'use strict';

/** 环形决策日志上限（参考 ruflo MAX_HISTORY_ENTRIES） */
const MAX_DECISIONS = 50;
/** 视为终态的任务状态（runtime/model.js task 转移表） */
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'expired']);

/**
 * @param {object} opts
 * @param {{listTasks: Function, resumeTask: Function}} opts.taskApi runtime 任务 API 适配层
 * @param {Function} opts.notify 通知回调 ({ title, body }) => void
 * @param {number} [opts.maxIterations=20] 最大推进迭代数
 * @param {number} [opts.intervalMs=30000] 轮询间隔
 * @param {number} [opts.taskTimeoutMs=600000] 单轮推进后的任务完成等待上限（10 分钟）
 * @param {Function} [opts.loadState] 读回上次持久化进度（() => object|null）
 * @param {Function} [opts.saveState] 进度落盘（(snapshot) => void）
 */
function createAutopilot({
  taskApi,
  notify = () => {},
  maxIterations = 20,
  intervalMs = 30000,
  taskTimeoutMs = 600000,
  loadState = null,
  saveState = null,
} = {}) {
  if (!taskApi || typeof taskApi.listTasks !== 'function' || typeof taskApi.resumeTask !== 'function') {
    throw new Error('createAutopilot 需要注入 taskApi（listTasks / resumeTask）');
  }

  const state = {
    enabled: false,
    iteration: 0,        // 「推进」计数：只有真正推动任务才 +1，空闲观察不消耗预算
    lastAction: null,    // 最近一次决策的 action 名
    decisions: [],       // 环形日志，最多 MAX_DECISIONS 条
  };
  let timer = null;
  let ticking = false;                    // 并发保护：上一轮未结束不叠 tick
  let lastAdvanced = null;                // { taskId, at } 最近一次推进，用于单轮超时判定
  let consecutiveFailures = 0;            // 连续失败计数（成功推进即清零）

  /* 进度持久化：之前 iteration / lastAdvanced / consecutiveFailures 只在内存里，
     重启后进度丢失（用户看到「从 0 开始」，而任务其实已经推进过很多轮）。 */
  function restore() {
    if (typeof loadState !== 'function') return;
    try {
      const raw = loadState();
      if (!raw || typeof raw !== 'object') return;
      const it = Number(raw.iteration);
      if (Number.isFinite(it) && it >= 0) state.iteration = Math.min(Math.floor(it), maxIterations);
      const cf = Number(raw.consecutiveFailures);
      if (Number.isFinite(cf) && cf >= 0) consecutiveFailures = Math.floor(cf);
      const la = raw.lastAdvanced;
      if (la && typeof la.taskId === 'string'
        && Number.isFinite(Number(la.at))
        && Date.now() - Number(la.at) <= taskTimeoutMs * 2) {
        lastAdvanced = { taskId: la.taskId, at: Number(la.at) };
      }
      if (raw.enabled === true) {
        // 安全默认：重启后不自动开跑，只把「上次是开着停的」记录下来
        state.lastAction = 'restored';
        record('restored', `已恢复上次进度（第 ${state.iteration} 轮 / 连续失败 ${consecutiveFailures}）`);
      }
    } catch { /* 读坏进度不影响启动 */ }
  }

  function persist() {
    if (typeof saveState !== 'function') return;
    try {
      saveState({
        version: 1,
        enabled: state.enabled,
        iteration: state.iteration,
        consecutiveFailures,
        lastAdvanced,
        lastAction: state.lastAction,
        updatedAt: Date.now(),
      });
    } catch { /* 落盘失败不影响主循环 */ }
  }

  restore();

  /* ---------------- 内部工具 ---------------- */

  function record(action, detail, extra = {}) {
    state.lastAction = action;
    state.decisions.push({ ts: Date.now(), iteration: state.iteration, action, detail, ...extra });
    if (state.decisions.length > MAX_DECISIONS) state.decisions.splice(0, state.decisions.length - MAX_DECISIONS);
  }

  function safeNotify(title, body) {
    try { notify({ title, body }); } catch { /* 通知故障不影响主循环 */ }
  }

  function stop(reason, notifyBody) {
    if (timer) { clearInterval(timer); timer = null; }
    state.enabled = false;
    lastAdvanced = null;
    record('stopped', reason);
    persist();
    if (notifyBody) safeNotify('Autopilot 已停止', notifyBody);
  }

  /* ---------------- 单轮 tick ---------------- */

  async function tick() {
    if (!state.enabled || ticking) return; // start 幂等 / 并发保护
    ticking = true;
    try {
      const tasks = (await taskApi.listTasks())?.tasks || [];

      // 0) 上一轮推进的任务：超时未终态 → 计一次失败，本轮转观察
      if (lastAdvanced) {
        const t = tasks.find((x) => x && x.id === lastAdvanced.taskId);
        if (!t) {
          lastAdvanced = null; // 推进的任务已不在列表（收尾/被裁剪）→ 视为结束
        } else if (TERMINAL_STATUSES.has(t.status)) {
          lastAdvanced = null; // 本轮已收尾，正常
        } else if (Date.now() - lastAdvanced.at > taskTimeoutMs) {
          const timedOutId = lastAdvanced.taskId;
          consecutiveFailures += 1;
          // 超时后继续盯同一任务（重新计时），连续超时才能累加到自动停
          lastAdvanced = { taskId: timedOutId, at: Date.now() };
          record('timeout', `任务 ${timedOutId} 超过单轮时限未终态`, { taskId: timedOutId });
          if (consecutiveFailures >= 2) {
            stop('连续失败达到上限（超时）', '任务连续超时/失败已达 2 次，已自动停止以免空耗');
            return;
          }
        }
      }

      // 1) 无任务 → 空闲观察（不消耗迭代预算）
      if (tasks.length === 0) {
        record('idle', '任务列表为空，等待用户创建任务');
        return;
      }

      // 2) 全部终态 → 停止并通知
      if (tasks.every((t) => TERMINAL_STATUSES.has(t && t.status))) {
        record('all_done', '全部任务已终态');
        stop('全部任务终态', '全部任务已完成，Autopilot 已自动停止');
        return;
      }

      // 3) 已有推进在途且未超时 → 并发保护，只观察不叠加推进
      if (lastAdvanced) {
        const t = tasks.find((x) => x && x.id === lastAdvanced.taskId);
        record('observe', `任务 ${t?.id || lastAdvanced.taskId} 推进中（${t?.status || '未知'}），等待本轮收尾`, { taskId: t?.id });
        return;
      }

      // 4) 选一个可推进任务：paused 最优先（明确可恢复），其次最旧的 queued
      const paused = tasks.filter((t) => t && t.status === 'paused');
      const queued = tasks.filter((t) => t && t.status === 'queued')
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const target = paused[0] || queued[0];

      if (!target) {
        // 剩下的都是 running / waiting_approval / created / 终态带子目标
        const waitingChild = tasks.find(
          (t) => TERMINAL_STATUSES.has(t && t.status)
            && tasks.some((c) => c && c.parentTaskId === t.id && !TERMINAL_STATUSES.has(c.status))
        );
        if (waitingChild) {
          record('waiting_user', `任务 ${waitingChild.id} 已终态但子目标未完成，等待用户决策（不自动造新目标）`, { taskId: waitingChild.id });
        } else {
          record('observe', '任务运行/审批中，无需推进');
        }
        return;
      }

      // 5) 迭代预算检查：推进前校验
      if (state.iteration >= maxIterations) {
        stop(`达到迭代上限（${maxIterations}）`, `Autopilot 已连续推进 ${maxIterations} 次，达到迭代上限，已自动停止`);
        return;
      }

      // 6) 推进：paused 恢复 / queued 触发（异常全兜底）
      try {
        const result = await taskApi.resumeTask({ taskId: target.id, reason: 'autopilot_advance' });
        if (result && result.waiting) {
          // 闭包降级：queued 被 runtime 拒绝恢复（等待调度）→ 不计失败不耗迭代
          record('waiting_schedule', `任务 ${target.id} 排队等待 runtime 调度`, { taskId: target.id });
          return;
        }
        state.iteration += 1;
        consecutiveFailures = 0;
        lastAdvanced = { taskId: target.id, at: Date.now() };
        record('advance', `已推进任务 ${target.id}（${target.status} → 恢复/触发）`, { taskId: target.id, iteration: state.iteration });
        persist();
      } catch (err) {
        consecutiveFailures += 1;
        record('advance_failed', `推进任务 ${target.id} 失败：${err?.message || String(err)}`, { taskId: target.id });
        if (consecutiveFailures >= 2) {
          stop('连续失败达到上限', `连续 2 次推进失败，Autopilot 已自动停止，请人工检查任务状态`);
        }
        return;
      }

      // 7) 推进后若已耗尽预算 → 停止（下一 tick 也会兜底，这里即时反馈）
      if (state.iteration >= maxIterations) {
        stop(`达到迭代上限（${maxIterations}）`, `Autopilot 已连续推进 ${maxIterations} 次，达到迭代上限，已自动停止`);
      }
    } catch (err) {
      // runtime 层故障（如 listTasks 抛错）：记录并计失败，绝不向上抛
      consecutiveFailures += 1;
      record('error', `tick 异常：${err?.message || String(err)}`);
      if (consecutiveFailures >= 2) {
        stop('连续失败达到上限（runtime 异常）', 'runtime 连续异常，Autopilot 已自动停止');
      }
    } finally {
      ticking = false;
    }
  }

  /* ---------------- 对外 API ---------------- */

  function start() {
    if (state.enabled) return stateSnapshot(); // 幂等：已启用直接返回
    /* 迭代预算已经用完的（上次跑到上限才停）视为新会话；否则沿用恢复出来的进度，
       这样重启不会把「已推进 17 轮」清零成 0 重新烧一轮。 */
    if (state.iteration >= maxIterations) {
      state.iteration = 0;
      consecutiveFailures = 0;
      lastAdvanced = null;
    }
    state.enabled = true;
    timer = setInterval(() => { tick().catch(() => {}); }, Math.max(1000, intervalMs));
    if (timer.unref) timer.unref(); // 定时器不阻止进程退出
    record('started', `Autopilot 已启动（间隔 ${Math.round(intervalMs / 1000)}s，迭代上限 ${maxIterations}）`);
    persist();
    safeNotify('Autopilot 已启动', `每 ${Math.round(intervalMs / 1000)} 秒巡检任务，最多推进 ${maxIterations} 轮`);
    return stateSnapshot();
  }

  function stop_() {
    if (!state.enabled && !timer) return stateSnapshot();
    if (timer) { clearInterval(timer); timer = null; }
    state.enabled = false;
    lastAdvanced = null;
    record('stopped', '手动停止');
    persist();
    return stateSnapshot();
  }

  function stateSnapshot() {
    return {
      enabled: state.enabled,
      iteration: state.iteration,
      maxIterations,
      consecutiveFailures,
      lastAdvanced: lastAdvanced ? { taskId: lastAdvanced.taskId, at: lastAdvanced.at } : null,
      lastAction: state.lastAction,
      decisions: state.decisions.slice(), // 拷贝，防外部篡改内部数组
    };
  }

  return {
    start,
    stop: stop_,
    state: stateSnapshot,
    /** 测试钩子：直接执行一轮决策，不等定时器 */
    _tick: tick,
  };
}

module.exports = { createAutopilot, TERMINAL_STATUSES, MAX_DECISIONS };
