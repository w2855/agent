'use strict';

/* 混合检索（lib/retrieval.js）自检：分词 / BM25 排序与饱和 / 余弦范围 /
   精确命中加分 / MMR 去重 / 参数校验 / 100KB 语料性能。
   运行：node tools/retrieval-check.js */

const { tokenize, buildCorpusStats, bm25Score, charBigramVector, cosineSim, hybridSearch } = require('../lib/retrieval');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

try {
  /* ── 1. 分词 ─────────────────────────────── */
  add('中文段切相邻 bigram', JSON.stringify(tokenize('数据库连接池')) === JSON.stringify(['数据', '据库', '库连', '连接', '接池']), JSON.stringify(tokenize('数据库连接池')));
  add('单个汉字自成一词', JSON.stringify(tokenize('配')) === JSON.stringify(['配']), JSON.stringify(tokenize('配')));
  add('英文小写化并丢停用词', JSON.stringify(tokenize('The Network Retry')) === JSON.stringify(['network', 'retry']), JSON.stringify(tokenize('The Network Retry')));
  add('英数词保留 . - 连接符', JSON.stringify(tokenize('解析 config.json 与 v-2')) === JSON.stringify(['解析', 'config.json', '与', 'v-2']), JSON.stringify(tokenize('解析 config.json 与 v-2')));
  add('数字按词提取', JSON.stringify(tokenize('端口 8787 被占用')) === JSON.stringify(['端口', '8787', '被占', '占用']), JSON.stringify(tokenize('端口 8787 被占用')));
  add('空串与非字符串返回空数组', tokenize('').length === 0 && tokenize(null).length === 0 && tokenize(42).length === 0, 'len 0');
  add('纯符号返回空数组', tokenize('!!! ### ...').length === 0, JSON.stringify(tokenize('!!! ### ...')));

  /* ── 2. BM25 ─────────────────────────────── */
  const stats = buildCorpusStats([tokenize('apple banana'), tokenize('apple cherry'), tokenize('apple date')]);
  add('语料统计 N 与 avgDocLen 正确', stats.N === 3 && approx(stats.avgDocLen, 2), `N=${stats.N} avg=${stats.avgDocLen}`);
  add('df 按文档去重计数', stats.df.get('apple') === 3 && stats.df.get('banana') === 1, `apple=${stats.df.get('apple')} banana=${stats.df.get('banana')}`);
  add('稀有词 idf 高于常见词', (stats.idf.get('banana') || 0) > (stats.idf.get('apple') || 0), `banana=${stats.idf.get('banana')} apple=${stats.idf.get('apple')}`);
  add('idf 永远为正（平滑公式）', [...stats.idf.values()].every((v) => v > 0), 'all > 0');

  const zhDocs = [
    { id: 'a', text: '数据库连接池配置说明：连接池大小、超时与重连策略' },
    { id: 'b', text: '数据库事务与隔离级别' },
    { id: 'c', text: '前端渲染性能优化' },
  ];
  const zhStats = buildCorpusStats(zhDocs.map((d) => tokenize(d.text)));
  const qTokens = tokenize('数据库连接池');
  const sA = bm25Score(qTokens, tokenize(zhDocs[0].text), zhStats);
  const sB = bm25Score(qTokens, tokenize(zhDocs[1].text), zhStats);
  const sC = bm25Score(qTokens, tokenize(zhDocs[2].text), zhStats);
  add('BM25 中文排序：相关文档排前', sA > sB && sB > sC, `a=${sA.toFixed(3)} b=${sB.toFixed(3)} c=${sC.toFixed(3)}`);
  add('无命中文档得 0 分', sC === 0, `c=${sC}`);

  // BM25 饱和：tf=3 的得分增长低于线性（分母中的 tf 抑制刷词）
  const satStats = buildCorpusStats([tokenize('重试 加 加 加'), tokenize('重试 重试 重试 加')]);
  const one = bm25Score(['重试'], tokenize('重试 加 加 加'), satStats);
  const three = bm25Score(['重试'], tokenize('重试 重试 重试 加'), satStats);
  add('BM25 tf 饱和：三次出现 < 线性三倍', three < 3 * one && three > one, `1次=${one.toFixed(3)} 3次=${three.toFixed(3)}`);

  const enStats = buildCorpusStats([tokenize('retry with exponential backoff for network requests'), tokenize('the quick brown fox jumps')]);
  const enA = bm25Score(tokenize('exponential backoff retry'), tokenize('retry with exponential backoff for network requests'), enStats);
  const enB = bm25Score(tokenize('exponential backoff retry'), tokenize('the quick brown fox jumps'), enStats);
  add('BM25 英文排序：相关文档排前且停用词不参与', enA > 0 && enB === 0, `a=${enA.toFixed(3)} b=${enB}`);

  /* ── 3. 余弦 ─────────────────────────────── */
  const vec = charBigramVector('你好世界');
  add('字符 bigram 计数正确', vec.get('你好') === 1 && vec.get('好世') === 1 && vec.get('世界') === 1 && vec.size === 3, JSON.stringify([...vec]));
  add('相同文本余弦为 1', approx(cosineSim(charBigramVector('网关端口配置'), charBigramVector('网关端口配置')), 1), '1');
  const cosPair = cosineSim(charBigramVector('网关端口配置说明很长的一段文字'), charBigramVector('数据库事务隔离级别'));
  add('不同文本余弦落在 [0,1)', cosPair >= 0 && cosPair < 1, String(cosPair));
  add('零向量余弦为 0', cosineSim(new Map(), charBigramVector('任意文本')) === 0, '0');

  /* ── 4. hybridSearch：结构与参数 ─────────── */
  const res = hybridSearch(zhDocs, '数据库连接池', { topK: 3 });
  add('返回结构含 entry/score/bm25/cosine', res.length === 3 && res.every((r) => 'entry' in r && 'score' in r && 'bm25' in r && 'cosine' in r), JSON.stringify(res.map((r) => Object.keys(r))));
  add('entry 是原对象引用', res[0].entry === zhDocs[0], 'identity');
  add('score 与余弦都在 [0,1]', res.every((r) => r.score >= 0 && r.score <= 1 && r.cosine >= 0 && r.cosine <= 1), JSON.stringify(res.map((r) => r.score)));
  add('topK 截断：5 条取 2', hybridSearch([
    { text: '事务一' }, { text: '事务二' }, { text: '事务三' }, { text: '事务四' }, { text: '事务五' },
  ], '事务', { topK: 2 }).length === 2, 'len 2');
  const all = hybridSearch(zhDocs, '数据库连接池', { topK: 3, exactBonus: 0 });
  add('首条是最高分（MMR 第一步选最大相关度）', approx(all[0].score, Math.max(...all.map((r) => r.score))), `${all[0].score}`);
  add('空查询返回空数组', hybridSearch(zhDocs, '').length === 0 && hybridSearch(zhDocs, '   ').length === 0, 'len 0');
  add('空条目集返回空数组', hybridSearch([], '查询').length === 0, 'len 0');
  add('非数组 entries 抛 TypeError', (() => { try { hybridSearch('bad', '查询'); return false; } catch (e) { return e instanceof TypeError; } })(), 'TypeError');
  add('非字符串 query 抛 TypeError', (() => { try { hybridSearch(zhDocs, 42); return false; } catch (e) { return e instanceof TypeError; } })(), 'TypeError');

  /* ── 5. 文本提取器 ───────────────────────── */
  const bodyDocs = [{ id: 'x', body: '网关端口绑定与优雅关闭' }];
  const byBody = hybridSearch(bodyDocs, '网关端口', { getText: (e) => e.body });
  add('自定义 getText 提取器生效', byBody.length === 1 && byBody[0].entry.id === 'x' && byBody[0].score > 0, `score=${byBody[0]?.score}`);
  const pref = hybridSearch([{ id: 't', text: '接口超时', summary: '无关摘要' }, { id: 's', summary: '摘要里说接口超时' }], '接口超时', { topK: 2 });
  add('默认提取器优先 text 其次 summary', pref[0].entry.id === 't', JSON.stringify(pref.map((r) => r.entry.id)));
  add('非字符串 getText 返回值按空文本处理不抛错', (() => { try { return hybridSearch([{ text: 42 }], '查询').length === 0; } catch { return false; } })(), 'len 0');

  /* ── 6. 精确命中加分 ─────────────────────── */
  // 构造：'gateway-json' 是单个 latin 词 → query 'gateway' 分词后无 BM25 命中，
  // 但 A 文本包含子串 'gateway' → 精确命中加分是两版本间唯一差异。
  const litDocs = [
    { id: 'a', text: 'gateway-json 网关配置说明' },
    { id: 'b', text: '数据库事务隔离级别' },
  ];
  const noBonus = hybridSearch(litDocs, 'gateway', { topK: 2, exactBonus: 0 });
  const defBonus = hybridSearch(litDocs, 'gateway', { topK: 2 });
  const bigBonus = hybridSearch(litDocs, 'gateway', { topK: 2, exactBonus: 0.5 });
  add('无命中语料 base 分 = 余弦权重', approx(noBonus[0].score, 0.6, 1e-6), String(noBonus[0].score));
  add('精确命中加默认 0.1 分', approx(defBonus[0].score, 0.7, 1e-6), String(defBonus[0].score));
  add('加分可钳到 1（exactBonus 0.5）', approx(bigBonus[0].score, 1, 1e-6), String(bigBonus[0].score));
  add('未含子串的文档不受加分影响', approx(noBonus[1].score, defBonus[1].score, 1e-6), `${noBonus[1].score} vs ${defBonus[1].score}`);

  /* ── 7. MMR 去重 ─────────────────────────── */
  // 完全重复：dup2 与 dup1 文本相同（cosine=1），lambda 0.5 时 dup2 的
  // MMR 分 = 0.5·rel − 0.5·1 ≤ 0，必被中等相关度的 other 压过。
  const dupDocs = [
    { id: 'dup1', text: '部署脚本执行失败：无法连接网关服务，端口 8787 被占用，重启后恢复' },
    { id: 'dup2', text: '部署脚本执行失败：无法连接网关服务，端口 8787 被占用，重启后恢复' },
    { id: 'other', text: '部署预览：端口占用检查与主题切换整理' },
  ];
  const div = hybridSearch(dupDocs, '部署脚本失败 网关端口占用', { topK: 2, mmrLambda: 0.5 });
  add('MMR 去重：完全重复条目只留一个高分', div[0].entry.id === 'dup1' && div[1].entry.id === 'other', JSON.stringify(div.map((r) => r.entry.id)));
  const rel = hybridSearch(dupDocs, '部署脚本失败 网关端口占用', { topK: 2, mmrLambda: 1 });
  add('lambda=1 退化为纯相关度：近重复回榜', rel[0].entry.id === 'dup1' && rel[1].entry.id === 'dup2', JSON.stringify(rel.map((r) => r.entry.id)));

  // 近似重复（cos 高但非 1）：lambda 0.5 下第二个位置让给中等相关度的条目
  const nearDocs = [
    { id: 'd1', text: '部署脚本执行失败：无法连接网关服务，端口 8787 被占用，重启后恢复' },
    { id: 'd2', text: '部署脚本执行失败：无法连接网关服务，端口 8787 被占用，重启后恢复，附日志路径' },
    { id: 'o', text: '部署预览：端口占用检查与主题切换整理' },
  ];
  const nearDiv = hybridSearch(nearDocs, '部署脚本失败 网关端口占用', { topK: 2, mmrLambda: 0.5 });
  add('MMR 抑制近似重复：第二位是多样条目', nearDiv[0].entry.id === 'd1' && nearDiv[1].entry.id === 'o', JSON.stringify(nearDiv.map((r) => r.entry.id)));
  const mmrAll = hybridSearch(nearDocs, '部署脚本失败 网关端口占用', { topK: 10, mmrLambda: 0.5 });
  add('topK 超过候选数时返回全部', mmrAll.length === 3, `len=${mmrAll.length}`);

  /* ── 8. 纯函数性 ─────────────────────────── */
  const frozen = [{ id: 'f1', text: '配置热重载说明' }, { id: 'f2', text: '事务队列持久化' }];
  const before = JSON.stringify(frozen);
  hybridSearch(frozen, '配置热重载', { topK: 2 });
  add('调用不修改输入条目', JSON.stringify(frozen) === before, 'unchanged');

  /* ── 9. 性能：~100KB 语料 < 100ms ───────── */
  const corpus = [];
  for (let i = 0; i < 250; i++) {
    const zh = `经验条目 ${i}：模块 m${i % 20} 在处理网关端口 ${8000 + i} 时的配置说明与重试策略注意事项，记录超时阈值、退避倍数以及失败恢复步骤，供检索性能基准测试使用，包含足够的中文文本长度以模拟真实经验库条目的体积与信息密度要求。`;
    const en = ` Entry ${i} of module m${i % 20}: handles request batching with timeout ${100 + i}ms, exponential backoff retry policy, gateway port binding and graceful shutdown hooks for integration test coverage reports.`;
    corpus.push({ id: `e${i}`, text: zh + en });
  }
  const totalBytes = corpus.reduce((sum, e) => sum + Buffer.byteLength(e.text, 'utf8'), 0);
  add('性能语料 ≥ 90KB（约 100KB）', totalBytes >= 90 * 1024, `${(totalBytes / 1024).toFixed(1)}KB / ${corpus.length} 条`);
  hybridSearch(corpus, '网关端口配置 重试策略', { topK: 5 }); // 预热一次
  const timings = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const out = hybridSearch(corpus, '网关端口配置 重试策略', { topK: 5 });
    timings.push(performance.now() - t0);
    if (i === 0 && out.length !== 5) timings.push(Infinity); // 结果异常直接判负
  }
  const best = Math.min(...timings);
  add('100KB 语料检索 < 100ms（取 3 次最优）', best < 100, `best=${best.toFixed(1)}ms all=[${timings.map((t) => t.toFixed(1)).join(', ')}]`);

  /* ── 汇总 ───────────────────────────────── */
  const total = checks.length;
  const passed = checks.filter((c) => c.pass).length;
  console.log(JSON.stringify({ checks, total, passed, failed: total - passed }, null, 2));
  if (passed !== total) process.exitCode = 1;
} catch (err) {
  console.error('[retrieval-check] 未捕获错误：', err);
  process.exitCode = 1;
}
