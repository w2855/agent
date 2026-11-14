'use strict';

/* ─────────────────────────────────────────────
   中英混合 token 估算（零依赖、纯函数）。

   存在的理由：以前全链路用 `text.length / 4` 估算 token，那是英文经验值。
   中文 1 个字符通常就是 1 个 token（部分分词器 0.6–1.5 字/token），
   `length / 4` 会把中文输入低估 4–6 倍，导致：
     · 上下文预算看起来还很宽裕，实际早已撞上游窗口；
     · modelStart 记录的 approxInputTokens 与真实账单差一个数量级；
     · 自动压缩阈值判断失真。

   这不是精确计费器，只要求「同一把尺子 + 不会低估」。规则：
     · CJK（汉字 / 假名 / 谚文）：1 字符 ≈ 1 token
     · 其它（ASCII、拉丁、标点、空白）：4 字符 ≈ 1 token
   两者相加向上取整，空串为 0。
   ───────────────────────────────────────────── */

/* 汉字（基本区+扩展A+兼容）、日文假名、韩文谚文 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

/** 估算一段文本的 token 数。非字符串按 String() 处理，null/undefined 记 0。 */
function estimateTokens(text) {
  if (text == null) return 0;
  const s = typeof text === 'string' ? text : String(text);
  if (!s) return 0;
  let cjk = 0;
  // replace 的回调里自增：避免 match 产生大数组，长文本下更省内存
  s.replace(CJK_RE, () => { cjk += 1; return ''; });
  const rest = s.length - cjk;
  return Math.max(1, Math.ceil(cjk + rest / 4));
}

/**
 * 估算一组对话消息的 token 数。
 * @param {Array<{role?:string, content?:any}>} messages
 * @param {{perMessageOverhead?:number}} [opts] 每条消息的角色/分隔开销，默认 4
 */
function estimateMessagesTokens(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const overhead = Number.isFinite(opts.perMessageOverhead) ? opts.perMessageOverhead : 4;
  let total = 0;
  for (const m of list) {
    if (!m) continue;
    total += estimateTokens(m.content) + overhead;
  }
  return total;
}

/**
 * 把「字符预算」折算成 token 预算的保守估计（用于只拿得到字符数的旧路径）。
 * 按全中文最坏情况算，即 1 字符 = 1 token。
 */
function charsToTokens(chars) {
  const n = Number(chars);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
}

module.exports = { estimateTokens, estimateMessagesTokens, charsToTokens, CJK_RE };
