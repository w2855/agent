'use strict';

/* ─────────────────────────────────────────────
   Hybrid 检索：BM25 + 字符余弦 + 精确命中加分 + MMR 多样性重排
   （纯函数、零依赖；移植自 ruflo v3 @claude-flow/cli/src/memory/hybrid-retrieval.ts）

   为什么混合：小语料（N < 1k）上纯余弦分数噪声大——随机短文本因低 IDF
   的偶然重合可能压过精确关键词命中。BM25 恢复「查询的内容词是否真的
   出现」的信号；两路分数各自归一化到 [0,1] 后线性合并，再叠加可选的
   精确命中加分，最后用 MMR 重排抑制近似重复霸榜。

   与 ruflo 原版的差异：分词改为「中文单字 bigram + 英文/数字按词」；
   分数归一化从 min-max 改为 max 缩放（小语料下 min-max 会把最差文档归到 0，
   使 MMR 无法正确抑制重复——见 normaliseMax 注释）。其余（BM25 公式
   k1=1.5 b=0.75、平滑 IDF、MMR 贪心）保持 ruflo 语义。

   纯函数边界：本模块不知道经验库（lib/lessons.js）的存在——
   与经验库的组合由调用方完成（把 lesson 条目数组当作 entries 传入即可）。
   ───────────────────────────────────────────── */

/** 英文停用词小集合：功能词无区分度，留着只会稀释 BM25 权重。 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'in', 'to', 'for', 'on', 'at',
  'by', 'with', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must', 'this',
  'that', 'these', 'those', 'it', 'its', 'as', 'also', 'not', 'no', 'so', 'too', 'very',
]);

/** CJK 统一表意文字（基本区 + 扩展 A）：覆盖常用汉字足够。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
/** 英文/数字词：字母数字开头结尾，内部允许 . _ / - 连接（config.json、v-2、a/b）。 */
const LATIN_RE = /[a-z0-9]+(?:[._/-][a-z0-9]+)*/g;
/** 单个英数字符（用于扫描分流）。 */
const ALNUM_RE = /[a-z0-9]/;

/**
 * 分词：中文连续段切成相邻单字 bigram（如「数据库」→ 数据/据库），
 * 英文/数字按词提取（小写化，丢停用词与单字符），其余字符一律当分隔符。
 * 中文段只剩一个字时取该字本身，保证单字查询可命中。
 * 导出供测试与调用方复用。
 */
function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  const lower = text.toLowerCase();
  const tokens = [];
  let i = 0;
  const n = lower.length;
  while (i < n) {
    const ch = lower[i];
    if (CJK_RE.test(ch)) {
      // 中文连续段：整段扫描后输出相邻 bigram
      let j = i + 1;
      while (j < n && CJK_RE.test(lower[j])) j++;
      const run = lower.slice(i, j);
      if (run.length === 1) tokens.push(run);
      else for (let k = 0; k + 1 < run.length; k++) tokens.push(run[k] + run[k + 1]);
      i = j;
    } else if (ALNUM_RE.test(ch)) {
      // 英文/数字词：从当前位置整词取出（正则要求首尾是字母数字）
      LATIN_RE.lastIndex = i;
      const m = LATIN_RE.exec(lower);
      if (!m || m.index !== i) { i++; continue; } // 理论不可达，防御正则状态被污染
      const word = m[0];
      if (word.length >= 2 && !STOPWORDS.has(word)) tokens.push(word);
      i += word.length;
    } else {
      i++; // 标点 / 空白 / 其他符号 = 分隔符
    }
  }
  return tokens;
}

/**
 * 构建 BM25 语料统计：每词文档频率 df、平滑 IDF（log(1 + (N-df+0.5)/(df+0.5))，
 * 永远 > 0）、平均文档长度。tokenisedDocs 为 tokenize() 的输出数组。
 */
function buildCorpusStats(tokenisedDocs) {
  const N = tokenisedDocs.length;
  const df = new Map();
  let totalLen = 0;
  for (const doc of tokenisedDocs) {
    totalLen += doc.length;
    const seen = new Set();
    for (const tok of doc) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      df.set(tok, (df.get(tok) || 0) + 1);
    }
  }
  const idf = new Map();
  for (const [tok, dfVal] of df) idf.set(tok, Math.log(1 + (N - dfVal + 0.5) / (dfVal + 0.5)));
  return { df, idf, avgDocLen: N > 0 ? totalLen / N : 0, N };
}

/**
 * BM25 单文档打分（Okapi 标准式，k1=1.5 b=0.75）。
 * stats 须来自包含该文档的同一语料（IDF 才有意义）。
 */
function bm25Score(queryTokens, docTokens, stats, k1 = 1.5, b = 0.75) {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const tf = new Map();
  for (const tok of docTokens) tf.set(tok, (tf.get(tok) || 0) + 1);
  const docLen = docTokens.length;
  const norm = docLen / (stats.avgDocLen || 1);
  let score = 0;
  for (const qt of queryTokens) {
    const f = tf.get(qt);
    if (!f) continue;
    const idf = stats.idf.get(qt) || 0;
    if (idf === 0) continue;
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * norm)));
  }
  return score;
}

/**
 * 字符 bigram 计数向量：整个字符串小写化、折叠空白后切成相邻字符对
 * （长度为 1 的串退化为单字符）。用于余弦相似度与 MMR 的文档间相似度。
 */
function charBigramVector(text) {
  const vec = new Map();
  if (typeof text !== 'string' || !text) return vec;
  const s = text.toLowerCase().replace(/\s+/g, ' ');
  for (let k = 0; k + 1 < s.length; k++) {
    const g = s[k] + s[k + 1];
    vec.set(g, (vec.get(g) || 0) + 1);
  }
  if (s.length === 1) vec.set(s, 1);
  return vec;
}

/**
 * 余弦相似度（两个 bigram 计数向量，Map 形式）。
 * 任一向量为空（零范数）时返回 0；计数非负，结果天然落在 [0,1]。
 */
function cosineSim(va, vb) {
  if (!(va instanceof Map) || !(vb instanceof Map) || va.size === 0 || vb.size === 0) return 0;
  const [small, big] = va.size <= vb.size ? [va, vb] : [vb, va];
  let dot = 0;
  for (const [g, c] of small) {
    const o = big.get(g);
    if (o) dot += c * o;
  }
  let na = 0;
  for (const c of va.values()) na += c * c;
  let nb = 0;
  for (const c of vb.values()) nb += c * c;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-9 ? dot / denom : 0;
}

/**
 * 归一化到 [0,1]：按语料内最大值缩放（s / max）。
 * 有意不用 ruflo 的 min-max——小语料下最低分文档必被压到 0，丢失「离零有多远」
 * 的绝对质量信息，会让 MMR 把重复条目（λ·1 − (1−λ)·1 ≥ 0）排在真实相关但
 * 归一化为 0 的条目之上。max 缩放保序且保留该信息，MMR 的多样性惩罚才有意义。
 * 全零/无正信号归一为全 0（不凭空给分）。
 */
function normaliseMax(scores) {
  if (scores.length === 0) return [];
  let hi = -Infinity;
  for (const s of scores) if (s > hi) hi = s;
  if (!(hi > 1e-9)) return scores.map(() => 0);
  return scores.map((s) => (s > 0 ? s / hi : 0));
}

/**
 * MMR 贪心重排（内部）：每步选 argmax(lambda·相关度 − (1−lambda)·与已选的最大相似度)。
 * lambda=1 退化为纯相关度排序；lambda 越小多样性越强。
 * candidates: [{ item, relevance, vector }]，vector 为 charBigramVector 输出。
 */
function mmrRerank(candidates, k, lambda) {
  const picked = [];
  const remaining = candidates.slice();
  while (picked.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      let maxSim = 0;
      for (const p of picked) {
        const s = cosineSim(cand.vector, p.vector);
        if (s > maxSim) maxSim = s;
      }
      const mmr = lambda * cand.relevance - (1 - lambda) * maxSim;
      if (mmr > bestScore) { bestScore = mmr; bestIdx = i; }
    }
    picked.push(remaining.splice(bestIdx, 1)[0]);
  }
  return picked;
}

/** 默认文本提取器：字符串直通；对象依次找 text / summary / title 字段。 */
function defaultGetText(e) {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    if (typeof e.text === 'string') return e.text;
    if (typeof e.summary === 'string') return e.summary;
    if (typeof e.title === 'string') return e.title;
  }
  return '';
}

const DEFAULT_OPTIONS = Object.freeze({
  topK: 5,        // 返回条数上限
  mmrLambda: 0.7, // MMR 多样性/相关度平衡（ruflo 默认 0.5，DSH 偏向相关度取 0.7）
  alpha: 0.6,     // 归一化后余弦权重（BM25 权重 = 1 - alpha），对齐 ruflo hybridScores
  exactBonus: 0.1, // 精确命中加分：原文包含完整查询串（忽略大小写）时叠加；0 = 关闭
});

/**
 * 混合检索主入口。
 *
 * @param {Array<object|string>} entries 任意对象数组（不要求特定字段），
 *        文本由 options.getText(e) 提取（缺省找 text/summary/title）。
 * @param {string} query 查询串。
 * @param {object} [options] { topK=5, mmrLambda=0.7, alpha=0.6, exactBonus=0.1, getText }
 * @returns {Array<{entry, score, bm25, cosine}>} MMR 重排后的前 topK 条：
 *          score = min(1, alpha·cosNorm + (1-alpha)·bm25Norm + 精确命中加分)；
 *          bm25 / cosine 为原始（未归一化）分数，便于调用方调试。
 *          纯函数：不修改 entries，返回的 entry 是原对象引用。
 */
function hybridSearch(entries, query, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError('hybridSearch: entries 必须是数组');
  if (typeof query !== 'string') throw new TypeError('hybridSearch: query 必须是字符串');

  const getText = typeof options.getText === 'function' ? options.getText : defaultGetText;
  const topK = Number.isInteger(options.topK) && options.topK > 0 ? options.topK : DEFAULT_OPTIONS.topK;
  const mmrLambda = typeof options.mmrLambda === 'number' && options.mmrLambda >= 0 && options.mmrLambda <= 1
    ? options.mmrLambda : DEFAULT_OPTIONS.mmrLambda;
  const alpha = typeof options.alpha === 'number' && options.alpha >= 0 && options.alpha <= 1
    ? options.alpha : DEFAULT_OPTIONS.alpha;
  const exactBonus = typeof options.exactBonus === 'number' && options.exactBonus >= 0
    ? options.exactBonus : DEFAULT_OPTIONS.exactBonus;

  const q = query.trim();
  if (entries.length === 0 || !q) return [];

  // 文本提取（非字符串返回值按空文本处理，不抛错——坏字段不应炸掉整次检索）。
  // 提取不出文本的条目永远无法命中，直接跳过：不参与语料统计，也不会返回。
  const texts = [];
  const textIdx = [];
  for (let i = 0; i < entries.length; i++) {
    const t = getText(entries[i]);
    if (typeof t === 'string' && t) { texts.push(t); textIdx.push(i); }
  }
  if (texts.length === 0) return [];

  const queryTokens = tokenize(q);
  const queryVec = charBigramVector(q);
  // 分词后无内容词且字符 bigram 也为空（如纯空白被 trim 掉）→ 无从打分
  if (queryTokens.length === 0 && queryVec.size === 0) return [];

  const docTokens = texts.map(tokenize);
  const stats = buildCorpusStats(docTokens);
  const bm25Raw = docTokens.map((dt) => bm25Score(queryTokens, dt, stats));
  const cosRaw = texts.map((t) => cosineSim(queryVec, charBigramVector(t)));
  const bm25Norm = normaliseMax(bm25Raw);
  const cosNorm = normaliseMax(cosRaw);
  const qLower = q.toLowerCase();

  const items = texts.map((t, i) => {
    const exact = t.toLowerCase().includes(qLower);
    const base = alpha * cosNorm[i] + (1 - alpha) * bm25Norm[i];
    return {
      item: entries[textIdx[i]],
      relevance: Math.min(1, base + (exact ? exactBonus : 0)),
      bm25: bm25Raw[i],
      cosine: cosRaw[i],
      vector: charBigramVector(t),
    };
  });

  const picked = mmrRerank(items, Math.min(topK, entries.length), mmrLambda);
  // vector 是内部中间量，不外泄；返回形状固定为 { entry, score, bm25, cosine }
  return picked.map((p) => ({ entry: p.item, score: p.relevance, bm25: p.bm25, cosine: p.cosine }));
}

module.exports = { tokenize, buildCorpusStats, bm25Score, charBigramVector, cosineSim, hybridSearch };
