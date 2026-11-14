'use strict';

/* ─────────────────────────────────────────────
   后台任务注册表（run_command background:true 的落点）

   为什么需要它：同步 run_command 最长 180 秒，dev server / watch / 长测试这类
   命令根本没法跑——模型只能反复起进程再杀掉，输出还会丢。有了后台任务，
   模型可以「起服务 → 做别的事 → 回来读输出 → 收尾时停掉」。

   设计约束：
   - 输出用「绝对偏移」记账（base 是被丢弃的头部字符数，total 是累计产出），
     因此调用方拿到的 offset 在环形裁剪后依然有效。
   - 每个任务保留 200KB，超出从头部丢弃；裁到 200KB 时留 25% 余量再裁一次，
     避免高频日志每来一行就重排整个缓冲。
   - 结束的任务保留 30 分钟、最多 16 个，新任务进来时按「最老的已结束」淘汰。
   - 应用退出时必须 stopAll，否则关窗会留下孤儿进程（Windows 上尤其明显）。
   ───────────────────────────────────────────── */

const { spawn } = require('node:child_process');

const MAX_TASKS = 16;
const MAX_BUFFER_CHARS = 200 * 1024;
const TRIM_SLACK = 1.25;
const KEEP_FINISHED_MS = 30 * 60 * 1000;
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_READ_CHARS = 20000;
const MAX_READ_CHARS = 60000;
const DEFAULT_WAIT_MS = 5000;
const MAX_WAIT_MS = 30000;

/** @type {Map<string, any>} */
const tasks = new Map();
let seq = 0;

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 进程可能已退出 */ }
}

function nowId() {
  seq += 1;
  return `bg-${seq}`;
}

function statusText(task) {
  if (task.status === 'running') return '运行中';
  if (task.status === 'killed') return '已停止';
  if (task.status === 'timeout') return '超时终止';
  return task.exitCode == null ? '已结束' : `退出码 ${task.exitCode}`;
}

function isFinished(task) {
  return task.status !== 'running';
}

/** 淘汰：先清过期，再按「最老的已结束」压到上限以下（运行中的任务不淘汰）。 */
function evict() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (isFinished(t) && t.endedAt && now - t.endedAt > KEEP_FINISHED_MS) tasks.delete(id);
  }
  if (tasks.size <= MAX_TASKS) return;
  const finished = [...tasks.values()]
    .filter(isFinished)
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  for (const t of finished) {
    if (tasks.size <= MAX_TASKS) break;
    tasks.delete(t.id);
  }
}

function append(task, chunk) {
  const text = chunk.toString('utf8');
  if (!text) return;
  task.buf += text;
  task.total += text.length;
  if (task.buf.length > MAX_BUFFER_CHARS * TRIM_SLACK) {
    const drop = task.buf.length - MAX_BUFFER_CHARS;
    task.buf = task.buf.slice(drop);
    task.base += drop;
    task.dropped += drop;
  }
  wake(task);
}

function wake(task) {
  if (!task.waiters.length) return;
  const list = task.waiters.splice(0, task.waiters.length);
  for (const w of list) w();
}

function settle(task, patch) {
  if (isFinished(task)) return;
  task.status = patch.status || 'exited';
  task.exitCode = patch.exitCode == null ? null : patch.exitCode;
  task.signal = patch.signal || null;
  task.endedAt = Date.now();
  if (task.lifetimeTimer) clearTimeout(task.lifetimeTimer);
  if (task.killTimer) clearTimeout(task.killTimer);
  wake(task);
}

/**
 * 启动一个后台任务。
 * @param {{command:string, cwd:string, env:object, label?:string}} opts
 */
function startTask(opts) {
  evict();
  const id = nowId();
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(opts.command, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      env: opts.env,
    });
  } catch (err) {
    const failed = {
      id, command: opts.command, cwd: opts.cwd, label: opts.label || '',
      status: 'exited', exitCode: null, signal: null,
      startedAt, endedAt: Date.now(),
      buf: '', base: 0, total: 0, dropped: 0, readCursor: 0,
      waiters: [], child: null,
      spawnError: err?.message || String(err),
    };
    tasks.set(id, failed);
    return { ok: false, task: failed, error: failed.spawnError };
  }

  const task = {
    id,
    command: opts.command,
    cwd: opts.cwd,
    label: opts.label || '',
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt,
    endedAt: null,
    buf: '',
    base: 0,
    total: 0,
    dropped: 0,
    readCursor: 0,
    waiters: [],
    child,
    spawnError: '',
    lifetimeTimer: null,
    killTimer: null,
  };
  tasks.set(id, task);

  child.stdout?.on('data', (c) => append(task, c));
  child.stderr?.on('data', (c) => append(task, c));
  child.on('error', (err) => {
    task.spawnError = err?.message || String(err);
    settle(task, { status: 'exited', exitCode: null });
  });
  child.on('close', (code, signal) => {
    settle(task, { status: task.status === 'running' ? 'exited' : task.status, exitCode: code, signal });
  });

  // 生命周期上限：防止「起了个 server 忘了关」一直挂在后台
  task.lifetimeTimer = setTimeout(() => {
    if (!isFinished(task)) {
      task.status = 'timeout';
      killTree(child);
      task.killTimer = setTimeout(() => {
        if (!isFinished(task)) settle(task, { status: 'timeout', exitCode: null });
      }, 4000);
    }
  }, MAX_LIFETIME_MS);
  if (task.lifetimeTimer.unref) task.lifetimeTimer.unref();

  return { ok: true, task };
}

function getTask(taskId) {
  const id = String(taskId || '').trim();
  if (!id) return null;
  return tasks.get(id) || null;
}

/**
 * 读取任务输出。
 * offset 缺省时沿用该任务的读取游标（连续 poll 只拿新增内容）。
 * @returns {{task:any, text:string, offset:number, nextOffset:number, dropped:number}|null}
 */
async function readTask(taskId, opts = {}) {
  const task = getTask(taskId);
  if (!task) return null;

  const maxChars = Math.max(200, Math.min(MAX_READ_CHARS, Math.floor(Number(opts.maxChars) || DEFAULT_MAX_READ_CHARS)));
  const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(Number(opts.waitMs) || 0)));

  const resolveOffset = () => {
    const raw = Number(opts.offset);
    if (Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
    if (opts.full === true) return task.base;
    return Math.max(task.base, Math.min(task.readCursor, task.total));
  };

  let offset = resolveOffset();
  // 头部已被裁掉时把游标顶到最早的可用位置，并如实报告丢了多少
  if (offset < task.base) offset = task.base;

  if (waitMs > 0 && !isFinished(task) && offset >= task.total) {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const i = task.waiters.indexOf(done);
        if (i >= 0) task.waiters.splice(i, 1);
        resolve();
      }, waitMs);
      task.waiters.push(done);
    });
    if (offset < task.base) offset = task.base;
  }

  const from = Math.max(0, offset - task.base);
  const text = task.buf.slice(from, from + maxChars);
  const nextOffset = offset + text.length;
  if (nextOffset > task.readCursor) task.readCursor = nextOffset;

  return { task, text, offset, nextOffset, dropped: task.dropped, truncated: from + maxChars < task.buf.length };
}

/** 停止任务：killTree + 等 close（最多 3 秒），返回结束后的任务快照。 */
async function stopTask(taskId) {
  const task = getTask(taskId);
  if (!task) return null;
  if (!isFinished(task)) {
    killTree(task.child);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      const check = () => {
        if (isFinished(task)) { clearTimeout(timer); resolve(); }
        else task.waiters.push(check);
      };
      check();
    });
    if (!isFinished(task)) settle(task, { status: 'killed', exitCode: null });
    else if (task.status === 'exited') task.status = 'killed';
  }
  return task;
}

function listTasks() {
  evict();
  return [...tasks.values()].map((t) => ({
    id: t.id,
    command: t.command,
    label: t.label,
    status: t.status,
    statusText: statusText(t),
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    seconds: Math.round(((t.endedAt || Date.now()) - t.startedAt) / 100) / 10,
    total: t.total,
    dropped: t.dropped,
    unread: Math.max(0, t.total - t.readCursor),
    exitCode: t.exitCode,
  }));
}

function stopAll() {
  for (const t of tasks.values()) if (!isFinished(t)) killTree(t.child);
  tasks.clear();
}

module.exports = {
  startTask,
  readTask,
  stopTask,
  listTasks,
  getTask,
  stopAll,
  statusText,
  MAX_BUFFER_CHARS,
  MAX_LIFETIME_MS,
  DEFAULT_WAIT_MS,
};
