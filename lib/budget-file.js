'use strict';

const fs = require('node:fs');
const path = require('node:path');

/* 持久成本预算文件（参考 ruflo cost/budget-file 的硬停阶梯模式）。
   这是"跨任务持久总额"层：与 runtime/delegation.js 里 computeChildBudget 的
   "单次父子预算"（内存态、只约束一条委派）正交 —— 这里只管一段时间内所有
   任务/委派累计消耗了多少 tokens、要不要硬停或降级模型。
   文件路径由调用方传入（DelegationService 默认落在运行时目录 budget.json），
   结构：
   {
     windows: {
       daily:   { limit, spent, modelCalls, windowStart },
       weekly:  { ... },
       monthly: { ... },
     },
     hardStop: false,
     fallbackModel: '',
   }
   - limit=0 表示该窗口无限制；spent 单位为 tokens。
   - modelCalls 只是观测计数，不参与超限判定（记账口径取舍见 spend 注释）。
   - windowStart 为当前周期起点（UTC 毫秒）；与 periodStart 对不上即视为跨窗，
     spent/modelCalls 清零（daily 按 UTC 日界、weekly 按周一、monthly 按 1 号）。 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS = ['daily', 'weekly', 'monthly'];
/* budget.json 是几百字节的文件；超尺寸一律按损坏处理（防止被塞进垃圾数据拖垮读取） */
const MAX_FILE_BYTES = 64 * 1024;
/* 与 ruflo cost 的模型名校验一致：委派层用它判断 fallbackModel 是否"可替换" */
const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,128}$/;

/* 三种窗口的当前周期起点（UTC）：
   daily = UTC 当日 0 点；weekly = UTC 本周周一 0 点；monthly = UTC 本月 1 号 0 点。
   窗口滚动（跨窗 spent 清零）就是靠持久化的 windowStart 与这里的当前值对不上来判定。 */
function periodStart(kind, now) {
  const d = new Date(now);
  const dayUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (kind === 'daily') return dayUtc;
  if (kind === 'weekly') {
    const dow = d.getUTCDay(); /* 0=周日..6=周六；换算成"周一为一周起点"的偏移 */
    return dayUtc - ((dow + 6) % 7) * DAY_MS;
  }
  if (kind === 'monthly') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  throw new Error(`未知预算窗口：${kind}（应为 ${WINDOWS.join('/')}）`);
}

function defaultWindow(now, kind) {
  return { limit: 0, spent: 0, modelCalls: 0, windowStart: periodStart(kind, now) };
}

/* 全新预算（缺文件 / 现文件损坏 / 超尺寸时的兜底）：全 0 无限制，不拦截任何委派。
   预算层的原则是"宁可放行也不阻塞主链路"，硬停阶梯只在配置了限额后才生效。 */
function defaultBudget(now) {
  return {
    windows: {
      daily: defaultWindow(now, 'daily'),
      weekly: defaultWindow(now, 'weekly'),
      monthly: defaultWindow(now, 'monthly'),
    },
    hardStop: false,
    fallbackModel: '',
  };
}

/* 归一化：任意输入 → 合法 budget 对象。字段缺失 / 类型不对 / 负数 / NaN
   全部落到安全默认值，绝不因为文件内容异常而抛错。 */
function normalizeBudget(value, now) {
  const base = defaultBudget(now);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  const srcWindows = value.windows && typeof value.windows === 'object' && !Array.isArray(value.windows)
    ? value.windows : {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  for (const kind of WINDOWS) {
    const w = srcWindows[kind] && typeof srcWindows[kind] === 'object' ? srcWindows[kind] : {};
    base.windows[kind] = {
      limit: num(w.limit),
      spent: num(w.spent),
      modelCalls: num(w.modelCalls),
      windowStart: Number.isFinite(Number(w.windowStart)) ? Number(w.windowStart) : base.windows[kind].windowStart,
    };
  }
  base.hardStop = value.hardStop === true;
  if (typeof value.fallbackModel === 'string') base.fallbackModel = value.fallbackModel.trim().slice(0, 128);
  return base;
}

/* 把过期窗口就地滚动到当前周期：windowStart 对不上当前周期起点 → spent/modelCalls 清零。
   修改传入对象（loadBudget/spend 内部使用）。 */
function rollWindows(budget, now) {
  for (const kind of WINDOWS) {
    const w = budget.windows[kind];
    const cur = periodStart(kind, now);
    if (w.windowStart !== cur) {
      w.windowStart = cur;
      w.spent = 0;
      w.modelCalls = 0;
    }
  }
  return budget;
}

/* 读取 budget.json 并归一化。任何失败（缺文件 / 损坏 / 超尺寸）都返回"全 0 无限制"
   默认值，绝不抛错 —— 调用方虽另有 try/catch，这里也保证自身不成为故障源。
   读取时就把过期窗口滚动到当前周期（仅内存内），磁盘留待下一次 spend 回写；
   这样"昨天写满的文件今天再读"不会误判超限。now 可注入（spend 用同一时钟
   读写，避免内部 Date.now() 与调用方注入时刻不一致导致跨窗误清零）。 */
function loadBudget(filePath, now = Date.now()) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return defaultBudget(now);
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return rollWindows(normalizeBudget(value, now), now);
  } catch {
    /* ENOENT（还没设过预算）与 JSON 损坏同路径：按无限制处理，下次 spend 会重写成合法结构 */
    return defaultBudget(now);
  }
}

/* 原子写（临时文件 + rename，ruflo writeBudget 同款），失败向上抛由调用方吞掉 */
function saveBudget(filePath, budget) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(budget, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
  return budget;
}

/* 记账：把 {modelCalls?, tokens?} 同时落入日/周/月三个窗口（同一笔消耗三窗都算）。
   落账前先滚动过期窗口（跨窗 spent 清零），再原子回写。返回更新后的 budget。
   记账口径取舍：tokens 是唯一参与超限判定的单位；modelCalls 仅累计作观测，
   因为不同调用方的"一次调用"成本差异极大，混入判定会造成口径混乱 ——
   委派层的预扣也只按 tokens（见 delegation.js _spendPersistentBudget）。 */
function spend(filePath, delta, now = Date.now()) {
  const budget = rollWindows(loadBudget(filePath, now), now);
  const tokens = Math.max(0, Number(delta && delta.tokens) || 0);
  const calls = Math.max(0, Number(delta && delta.modelCalls) || 0);
  for (const kind of WINDOWS) {
    budget.windows[kind].spent += tokens;
    budget.windows[kind].modelCalls += calls;
  }
  return saveBudget(filePath, budget);
}

/* 硬停阶梯判定（纯函数，不改入参、不读文件）：
   任一窗口超限（limit>0 且 spent>limit；窗口已过期视为已清零）时：
     hardStop=true            → 'hard-stop'（调用方必须拒绝）
     否则设置了 fallbackModel → 'fallback'（调用方尽量换降级模型）
     否则                     → 'allow'（只记账不拦截）
   未超限一律 'allow'。
   allowed = (action === 'allow')：false 表示超限需要干预（硬停或降级）。
   可传 now 便于测试注入固定时刻；对 hand-built 预算同样把过期窗口当作已清零。 */
function checkBudget(budget, now = Date.now()) {
  const out = { allowed: true, exceededWindows: [], action: 'allow' };
  if (!budget || typeof budget !== 'object') return out;
  for (const kind of WINDOWS) {
    const w = budget.windows && budget.windows[kind];
    if (!w || typeof w !== 'object') continue;
    const stale = w.windowStart != null && Number(w.windowStart) !== periodStart(kind, now);
    const spent = stale ? 0 : (Number(w.spent) || 0);
    const limit = Number(w.limit) || 0;
    if (limit > 0 && spent > limit) out.exceededWindows.push(kind);
  }
  if (out.exceededWindows.length > 0) {
    if (budget.hardStop === true) out.action = 'hard-stop';
    else if (typeof budget.fallbackModel === 'string' && budget.fallbackModel.trim()) out.action = 'fallback';
  }
  out.allowed = out.action === 'allow';
  return out;
}

/* 设置某窗口限额并持久化。window ∈ daily/weekly/monthly，limit ≥ 0（0 = 无限制）。
   非法窗口名 / 非法数值直接抛错（调用方是显式的管理动作，应当看到错误）。 */
function setLimit(filePath, window, limit) {
  if (!WINDOWS.includes(window)) throw new Error(`未知预算窗口：${window}（应为 ${WINDOWS.join('/')}）`);
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 0) throw new Error('limit 必须是非负有限数字');
  const budget = loadBudget(filePath);
  budget.windows[window].limit = n;
  return saveBudget(filePath, budget);
}

module.exports = {
  loadBudget,
  saveBudget,
  spend,
  checkBudget,
  setLimit,
  periodStart,
  defaultBudget,
  WINDOWS,
  MODEL_RE,
  MAX_FILE_BYTES,
};
