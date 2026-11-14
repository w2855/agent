'use strict';

/* ─────────────────────────────────────────────
   有界读取委托：上下文预算规划（纯函数、零依赖）。
   语义移植自 ruflo v3 @claude-flow/cli/src/services/context-delegation.ts 的
   planContextRead（ Ruflo 侧决定 direct/observe/delegate 路由；DSH 侧改造为
   full/sampled/split 三种读取策略 + 均匀拆分建议）。

   预算公式：readBudget = maxBytes × intent系数 ÷ (1 + 0.5·depth)
   - intent ∈ summary(0.5) / review(0.75) / full-verify(1.0)：只看摘要减半，
     完整校验给满额；
   - depth 越深，每文件预算越小（偏向抽样而非全读）；
   - 超过预算 → needsSplit=true，把文件区间均匀切成若干块（每块预算 =
     readBudgetBytes），调用方对每块单独执行读取（必要时再次调用本函数递归拆分）。

   maxBytes 默认 120000，对齐 renderer/app.js 的 TOOL_CONTEXT_BUDGET。
   本模块不做任何 IO——只产出计划；读取与委托由调用方执行。
   ───────────────────────────────────────────── */

/** 内置缺省 limits（可通过第二参覆盖单项）。 */
const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 120000,     // 单次委托可带入上下文的总字节预算（= TOOL_CONTEXT_BUDGET）
  maxFiles: 16,         // 单次委托最多文件数（对齐 ruflo DEFAULT_CONTEXT_LIMITS.maxFiles）
  maxChunks: 8,         // 拆分块数上限；达到上限时块内需再次 planContextRead 递归拆
  minBudgetBytes: 1000, // 预算下限：depth 极大时避免规划出 0 预算
});

/** intent → 预算系数。 */
const INTENT_FACTOR = Object.freeze({
  summary: 0.5,
  review: 0.75,
  'full-verify': 1.0,
});

/** 每层 depth 让预算除以 (1 + DEPTH_STEP·depth)。 */
const DEPTH_STEP = 0.5;

/** 把 [0, total) 均匀切成 parts 个连续区间（左闭右开），各段长度差 ≤ 1，无空段。 */
function evenChunks(total, parts) {
  if (!Number.isSafeInteger(total) || total <= 0) return [];
  const count = Math.max(1, Math.min(parts, total)); // 钳制：文件数不够时不产出空段
  const out = [];
  const base = Math.floor(total / count);
  const extra = total % count;
  let from = 0;
  for (let i = 0; i < count; i++) {
    const size = base + (i < extra ? 1 : 0);
    out.push({ from, to: from + size });
    from += size;
  }
  return out;
}

/**
 * 规划一次有界读取。
 *
 * @param {object} read { totalBytes, totalFiles, intent, depth? }
 *        - totalBytes: 待读内容总字节数
 *        - totalFiles: 待读文件数
 *        - intent: 'summary' | 'review' | 'full-verify'
 *        - depth: 委托深度（缺省 0），每层缩减每文件预算
 * @param {object} [limits] 覆盖 DEFAULT_LIMITS 的单项（maxBytes/maxFiles/maxChunks/minBudgetBytes）
 * @returns {{readBudgetBytes, fileBudget, perFileBytes, strategy: 'full'|'sampled'|'split',
 *            chunks: Array<{from,to}>, needsSplit: boolean, reason: string}}
 *          - chunks 为文件序号区间（左闭右开 [from, to)），覆盖全部待读文件且互不重叠；
 *          - 每块预算即 readBudgetBytes（split 时调用方按块委托，块内可再规划）；
 *          - perFileBytes = floor(readBudgetBytes / fileBudget)，depth 缩减效果的参考值。
 * @throws TypeError 入参/limits 非法时（对齐 ruflo 的严格风格：显式抛错，不静默兜底）。
 */
function planContextRead(read, limits) {
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) };
  for (const [k, v] of Object.entries(lim)) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`无效 limits.${k}: ${v}`);
  }
  if (!read || typeof read !== 'object') throw new TypeError('read 必须是对象');
  const intent = read.intent;
  if (typeof intent !== 'string' || !(intent in INTENT_FACTOR)) {
    throw new TypeError(`无效 intent: ${String(intent)}（应为 summary | review | full-verify）`);
  }
  for (const [k, v] of Object.entries({ totalBytes: read.totalBytes, totalFiles: read.totalFiles, depth: read.depth ?? 0 })) {
    if (!Number.isSafeInteger(v) || v < 0) throw new TypeError(`无效 read.${k}: ${v}`);
  }

  const depth = read.depth ?? 0;
  // 预算 = maxBytes × intent系数 ÷ (1 + 0.5·depth)，夹在 [minBudgetBytes, maxBytes] 内
  const raw = (lim.maxBytes * INTENT_FACTOR[intent]) / (1 + DEPTH_STEP * depth);
  const readBudgetBytes = Math.min(lim.maxBytes, Math.max(lim.minBudgetBytes, Math.round(raw)));
  const fileBudget = Math.min(read.totalFiles, lim.maxFiles);
  const perFileBytes = fileBudget > 0 ? Math.floor(readBudgetBytes / fileBudget) : 0;

  // 1) 空文件集：无事可做
  if (read.totalFiles === 0) {
    return { readBudgetBytes, fileBudget: 0, perFileBytes: 0, strategy: 'full', chunks: [], needsSplit: false, reason: '空文件集，无需读取' };
  }
  // 2) 字节与文件数都在预算内 → 整读
  if (read.totalBytes <= readBudgetBytes && read.totalFiles <= lim.maxFiles) {
    return { readBudgetBytes, fileBudget, perFileBytes, strategy: 'full', chunks: [{ from: 0, to: read.totalFiles }], needsSplit: false, reason: '总量在预算内，整读' };
  }
  // 3) 字节够但文件数超限 → 抽样：只读前 maxFiles 个文件
  if (read.totalFiles > lim.maxFiles && read.totalBytes <= readBudgetBytes) {
    return { readBudgetBytes, fileBudget, perFileBytes, strategy: 'sampled', chunks: [{ from: 0, to: lim.maxFiles }], needsSplit: false, reason: `文件数超限（${read.totalFiles} > ${lim.maxFiles}），按预算抽样前 ${lim.maxFiles} 个文件` };
  }
  // 4) 字节超预算 → 拆分：块数取「字节需求」与「文件数需求」的较大者，
  //    并受 maxChunks 与 totalFiles 双上限约束（文件不够切不出更多非空块）。
  const bytesChunks = Math.ceil(read.totalBytes / readBudgetBytes);
  const fileChunks = Math.ceil(read.totalFiles / lim.maxFiles);
  const idealChunks = Math.max(bytesChunks, fileChunks);
  const chunkCount = Math.min(idealChunks, lim.maxChunks, read.totalFiles);
  const chunks = evenChunks(read.totalFiles, chunkCount);
  const needsRecursion = chunkCount < idealChunks;
  const reason = needsRecursion
    ? `超预算（${read.totalBytes} > ${readBudgetBytes} 字节），理想 ${idealChunks} 块被上限压到 ${chunkCount} 块，每块预算 ${readBudgetBytes} 字节；块内需再次 planContextRead 拆分`
    : `超预算（${read.totalBytes} > ${readBudgetBytes} 字节），均匀拆为 ${chunkCount} 块，每块预算 ${readBudgetBytes} 字节`;
  return { readBudgetBytes, fileBudget, perFileBytes, strategy: 'split', chunks, needsSplit: true, reason };
}

module.exports = { planContextRead, DEFAULT_LIMITS, INTENT_FACTOR, DEPTH_STEP, evenChunks };
