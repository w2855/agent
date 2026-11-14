'use strict';

/* 有界读取委托（lib/context-plan.js）自检：预算公式（intent 系数 / depth 缩减 /
   下限钳制）/ 三种策略判定 / 拆分块均匀性与覆盖完整性 / 严格参数校验 / 纯函数性。
   运行：node tools/context-plan-check.js */

const { planContextRead, DEFAULT_LIMITS, INTENT_FACTOR, DEPTH_STEP, evenChunks } = require('../lib/context-plan');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
const throws = (fn) => { try { fn(); return false; } catch { return true; } }; // 抛错才返回 true

try {
  /* ── 1. 缺省值与导出 ─────────────────────── */
  add('缺省 maxBytes 对齐 TOOL_CONTEXT_BUDGET=120000', DEFAULT_LIMITS.maxBytes === 120000, String(DEFAULT_LIMITS.maxBytes));
  add('缺省 maxFiles 对齐 ruflo=16', DEFAULT_LIMITS.maxFiles === 16, String(DEFAULT_LIMITS.maxFiles));
  add('INTENT_FACTOR 三档系数', INTENT_FACTOR.summary === 0.5 && INTENT_FACTOR.review === 0.75 && INTENT_FACTOR['full-verify'] === 1.0, JSON.stringify(INTENT_FACTOR));
  add('DEPTH_STEP = 0.5', DEPTH_STEP === 0.5, String(DEPTH_STEP));

  /* ── 2. 预算公式 ─────────────────────────── */
  const base = planContextRead({ totalBytes: 100000, totalFiles: 8, intent: 'full-verify', depth: 0 });
  add('full-verify depth0 预算 = 120000', base.readBudgetBytes === 120000, String(base.readBudgetBytes));
  add('summary 系数减半 = 60000', planContextRead({ totalBytes: 50000, totalFiles: 8, intent: 'summary', depth: 0 }).readBudgetBytes === 60000, '60000');
  add('review 系数 = 90000', planContextRead({ totalBytes: 80000, totalFiles: 8, intent: 'review', depth: 0 }).readBudgetBytes === 90000, '90000');
  add('depth=1 预算 ÷1.5 = 80000', planContextRead({ totalBytes: 100000, totalFiles: 8, intent: 'full-verify', depth: 1 }).readBudgetBytes === 80000, '80000');
  add('depth=2 预算 ÷2 = 60000', planContextRead({ totalBytes: 100000, totalFiles: 8, intent: 'full-verify', depth: 2 }).readBudgetBytes === 60000, '60000');
  add('depth=4 预算 ÷3 = 40000', planContextRead({ totalBytes: 100000, totalFiles: 8, intent: 'full-verify', depth: 4 }).readBudgetBytes === 40000, '40000');
  const per0 = planContextRead({ totalBytes: 100000, totalFiles: 4, intent: 'full-verify', depth: 0 });
  const per2 = planContextRead({ totalBytes: 100000, totalFiles: 4, intent: 'full-verify', depth: 2 });
  add('depth 缩减每文件预算（30000 → 15000）', per0.perFileBytes === 30000 && per2.perFileBytes === 15000, `${per0.perFileBytes} → ${per2.perFileBytes}`);
  add('depth 极大时钳到 minBudgetBytes', planContextRead({ totalBytes: 100000, totalFiles: 4, intent: 'full-verify', depth: 999 }).readBudgetBytes === DEFAULT_LIMITS.minBudgetBytes, '1000');
  add('自定义 maxBytes 生效且预算不超总预算', planContextRead({ totalBytes: 900000, totalFiles: 8, intent: 'full-verify', depth: 0 }, { maxBytes: 50000 }).readBudgetBytes === 50000, '50000');
  add('部分 limits 覆盖：未指定项保留缺省', (() => { const p = planContextRead({ totalBytes: 1000, totalFiles: 2, intent: 'summary', depth: 0 }, { maxFiles: 4 }); return p.readBudgetBytes === 60000 && p.fileBudget === 2; })(), 'summary 预算仍 60000');

  /* ── 3. 策略判定 ─────────────────────────── */
  const full = planContextRead({ totalBytes: 100000, totalFiles: 8, intent: 'full-verify', depth: 0 });
  add('预算内 → full 整读', full.strategy === 'full' && full.needsSplit === false && full.chunks.length === 1 && full.chunks[0].from === 0 && full.chunks[0].to === 8, JSON.stringify(full.chunks));
  add('字节恰等于预算 → full（边界含等号）', planContextRead({ totalBytes: 120000, totalFiles: 8, intent: 'full-verify', depth: 0 }).strategy === 'full', '==budget → full');
  add('字节超预算 1 字节 → split', planContextRead({ totalBytes: 120001, totalFiles: 8, intent: 'full-verify', depth: 0 }).strategy === 'split', '+1 → split');
  const sampled = planContextRead({ totalBytes: 100000, totalFiles: 40, intent: 'full-verify', depth: 0 });
  add('文件超限但字节够 → sampled 前 16 个', sampled.strategy === 'sampled' && sampled.fileBudget === 16 && sampled.needsSplit === false && sampled.chunks.length === 1 && sampled.chunks[0].to === 16, JSON.stringify(sampled.chunks));
  add('maxFiles 边界：16 文件 full / 17 文件 sampled', planContextRead({ totalBytes: 100000, totalFiles: 16, intent: 'full-verify', depth: 0 }).strategy === 'full'
    && planContextRead({ totalBytes: 100000, totalFiles: 17, intent: 'full-verify', depth: 0 }).strategy === 'sampled', '16/17');
  const empty = planContextRead({ totalBytes: 0, totalFiles: 0, intent: 'summary', depth: 0 });
  add('空文件集 → full 且 chunks 为空', empty.strategy === 'full' && empty.chunks.length === 0 && empty.fileBudget === 0 && empty.perFileBytes === 0, JSON.stringify(empty.chunks));
  add('depth 压缩预算可把 full 变 split', (() => { const p = planContextRead({ totalBytes: 100000, totalFiles: 8, intent: 'full-verify', depth: 4 }); return p.readBudgetBytes === 40000 && p.strategy === 'split'; })(), 'depth4 → split');

  /* ── 4. 拆分：块数 / 均匀 / 覆盖 ─────────── */
  const split = planContextRead({ totalBytes: 300000, totalFiles: 8, intent: 'full-verify', depth: 0 });
  add('超预算 → split 且 needsSplit=true', split.strategy === 'split' && split.needsSplit === true, split.reason);
  add('块数 = ceil(300000/120000) = 3', split.chunks.length === 3, JSON.stringify(split.chunks));
  add('块区间覆盖全部文件且互不重叠', split.chunks[0].from === 0 && split.chunks[2].to === 8
    && split.chunks.every((c, i) => c.to === (split.chunks[i + 1] ? split.chunks[i + 1].from : c.to) && c.to > c.from), JSON.stringify(split.chunks));
  const sizes = split.chunks.map((c) => c.to - c.from);
  add('均匀切块：段长差 ≤ 1', Math.max(...sizes) - Math.min(...sizes) <= 1, JSON.stringify(sizes));
  const both = planContextRead({ totalBytes: 300000, totalFiles: 40, intent: 'full-verify', depth: 0 });
  add('字节与文件数双超 → 块数取较大者', both.chunks.length === 3 && both.chunks[0].to - both.chunks[0].from === 14, JSON.stringify(both.chunks));
  const truncated = planContextRead({ totalBytes: 2000000, totalFiles: 5, intent: 'full-verify', depth: 0 });
  add('理想块数被文件数钳制：5 文件最多 5 块（无空段）', truncated.chunks.length === 5 && truncated.chunks.every((c) => c.to - c.from === 1), JSON.stringify(truncated.chunks));
  add('钳制时 reason 提示块内需再次拆分', truncated.reason.includes('再次 planContextRead'), truncated.reason);
  const capped = planContextRead({ totalBytes: 2000000, totalFiles: 200, intent: 'full-verify', depth: 0 });
  add('块数达 maxChunks=8 上限', capped.chunks.length === 8 && capped.chunks[0].to - capped.chunks[0].from === 25, JSON.stringify(capped.chunks));
  add('intent 系数影响拆分块数', planContextRead({ totalBytes: 300000, totalFiles: 8, intent: 'summary', depth: 0 }).chunks.length === 5
    && planContextRead({ totalBytes: 300000, totalFiles: 8, intent: 'full-verify', depth: 0 }).chunks.length === 3, 'summary 5 块 vs full-verify 3 块');
  add('split 时每块预算仍为 readBudgetBytes（reason 带出）', split.reason.includes('120000'), split.reason);

  /* ── 5. 严格校验 ─────────────────────────── */
  add('非法 intent 抛 TypeError', throws(() => planContextRead({ totalBytes: 100, totalFiles: 1, intent: 'edit' })), 'edit');
  add('缺 intent 抛 TypeError', throws(() => planContextRead({ totalBytes: 100, totalFiles: 1 })), 'undefined');
  add('totalBytes 负数抛 TypeError', throws(() => planContextRead({ totalBytes: -1, totalFiles: 1, intent: 'summary' })), '-1');
  add('totalFiles 非整数抛 TypeError', throws(() => planContextRead({ totalBytes: 100, totalFiles: 1.5, intent: 'summary' })), '1.5');
  add('depth 负数抛 TypeError', throws(() => planContextRead({ totalBytes: 100, totalFiles: 1, intent: 'summary', depth: -1 })), '-1');
  add('read 非对象抛 TypeError', throws(() => planContextRead(null)), 'null');
  add('limits 非正数抛 TypeError', throws(() => planContextRead({ totalBytes: 100, totalFiles: 1, intent: 'summary' }, { maxBytes: 0 }))
    && throws(() => planContextRead({ totalBytes: 100, totalFiles: 1, intent: 'summary' }, { maxFiles: -2 }))
    && throws(() => planContextRead({ totalBytes: 100, totalFiles: 1, intent: 'summary' }, { maxChunks: 1.5 })), '0/-2/1.5');

  /* ── 6. 纯函数性 ─────────────────────────── */
  const limitsArg = { maxBytes: 50000, maxFiles: 4, maxChunks: 8, minBudgetBytes: 1000 };
  const limitsBefore = JSON.stringify(limitsArg);
  const p1 = planContextRead({ totalBytes: 200000, totalFiles: 10, intent: 'review', depth: 1 }, limitsArg);
  const p2 = planContextRead({ totalBytes: 200000, totalFiles: 10, intent: 'review', depth: 1 }, limitsArg);
  add('同输入两次调用结果一致（纯函数）', JSON.stringify(p1) === JSON.stringify(p2), 'deep equal');
  add('调用不修改传入的 limits 对象', JSON.stringify(limitsArg) === limitsBefore, limitsBefore);
  add('自定义 limits 下预算正确（review=0.75，depth1=÷1.5）', p1.readBudgetBytes === Math.round(50000 * 0.75 / 1.5), String(p1.readBudgetBytes));
  add('自定义 maxFiles 生效（fileBudget=4）', p1.fileBudget === 4, String(p1.fileBudget));

  /* ── 7. evenChunks 直接验证 ──────────────── */
  add('evenChunks 均匀切 10 → 4,3,3', JSON.stringify(evenChunks(10, 3).map((c) => c.to - c.from)) === JSON.stringify([4, 3, 3]), JSON.stringify(evenChunks(10, 3)));
  add('evenChunks 部件多于文件数时不产出空段', evenChunks(3, 8).length === 3 && evenChunks(3, 8).every((c) => c.to > c.from), JSON.stringify(evenChunks(3, 8)));
  add('evenChunks total=0 返回空数组', evenChunks(0, 4).length === 0, 'len 0');

  /* ── 汇总 ───────────────────────────────── */
  const total = checks.length;
  const passed = checks.filter((c) => c.pass).length;
  console.log(JSON.stringify({ checks, total, passed, failed: total - passed }, null, 2));
  if (passed !== total) process.exitCode = 1;
} catch (err) {
  console.error('[context-plan-check] 未捕获错误：', err);
  process.exitCode = 1;
}
