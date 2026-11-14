'use strict';

/* ─────────────────────────────────────────────
   稳定性守护纯逻辑（不依赖 Electron，可单独跑 node 测试，见 tools/p2-check.js）

   1. getLockResult：把 app.requestSingleInstanceLock() 的返回值收敛成显式决定
      （首个实例 → 正常启动；没拿到锁 → 直接退出）。双开同时占用同一份 userData
      会撞 LevelDB 缓存锁（docs/e2e-guide.md 坑 2），必须单实例。
   2. CrashTracker：渲染进程崩溃计数。60s 滑动窗口内累计满阈值（默认 3 次）只触发
      一次「标记软渲染」，之后不重复标记；窗口边界语义与 lib/notify-dedupe.js 一致：
      间隔恰好等于窗口长视为已出窗。
   3. crash-log.jsonl 环形裁剪：追加一条记录后只保留最后 maxLines 行（默认 50）。
      坏行（非法 JSON）原样保留，但照常参与裁剪计数。
   ───────────────────────────────────────────── */

/** 崩溃统计滑动窗口：60s 内连续崩溃达到阈值才标记软渲染。 */
const CRASH_WINDOW_MS = 60 * 1000;
/** 连续崩溃阈值。 */
const CRASH_THRESHOLD = 3;
/** crash-log.jsonl 最大保留行数（环形裁剪）。 */
const CRASH_LOG_MAX_LINES = 50;

/**
 * 单实例锁结果判定。
 * @param {boolean} hasLock app.requestSingleInstanceLock() 的返回值
 * @returns {{ isPrimary: boolean, shouldQuit: boolean }}
 *   isPrimary=true 表示拿到锁（首个实例，正常启动）；否则 shouldQuit=true 直接退出。
 *   非布尔输入一律按「没拿到锁」处理（fail-closed：宁可误退也不双开）。
 */
function getLockResult(hasLock) {
  const primary = hasLock === true;
  return { isPrimary: primary, shouldQuit: !primary };
}

/**
 * 渲染进程崩溃计数器：只在时间窗口内累计，跨过阈值时恰好触发一次软渲染标记。
 * 主进程全局共用一个实例（模块级状态），时间戳由调用方传入，便于测试注入。
 */
class CrashTracker {
  /**
   * @param {{ windowMs?: number, threshold?: number }} [opts] 窗口长度与阈值，缺省 60s / 3 次
   */
  constructor(opts = {}) {
    this.windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : CRASH_WINDOW_MS;
    this.threshold = Number.isInteger(opts.threshold) && opts.threshold > 0 ? opts.threshold : CRASH_THRESHOLD;
    /** 窗口内的崩溃时间戳样本。 */
    this.timestamps = [];
    /** 是否已触发过软渲染标记（触发后不再重复）。 */
    this.softRenderMarked = false;
  }

  /**
   * 记录一次崩溃。
   * @param {number} [now] 崩溃时刻（默认 Date.now()）
   * @returns {{ count: number, windowMs: number, threshold: number,
   *             shouldMarkSoftRender: boolean, softRenderMarked: boolean }}
   *   count 为当前窗口内样本数；shouldMarkSoftRender 只在跨过阈值的那一次为 true。
   */
  record(now = Date.now()) {
    const t = Number(now);
    const stamp = Number.isFinite(t) ? t : Date.now();
    // 只保留窗口内样本：间隔恰好等于 windowMs 的旧样本视为已出窗，未来样本（时钟回跳）丢弃
    this.timestamps = this.timestamps.filter((ts) => ts <= stamp && stamp - ts < this.windowMs);
    this.timestamps.push(stamp);
    const count = this.timestamps.length;
    let shouldMarkSoftRender = false;
    if (!this.softRenderMarked && count >= this.threshold) {
      this.softRenderMarked = true;
      shouldMarkSoftRender = true;
    }
    return {
      count,
      windowMs: this.windowMs,
      threshold: this.threshold,
      shouldMarkSoftRender,
      softRenderMarked: this.softRenderMarked,
    };
  }

  /** 是否已触发过软渲染标记。 */
  isSoftRenderMarked() {
    return this.softRenderMarked;
  }
}

/** 把 jsonl 文本拆成非空行（去首尾空白；坏行原样保留，由调用方决定怎么处理）。 */
function parseJsonlLines(text) {
  if (typeof text !== 'string' || !text) return [];
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/** 环形裁剪：只保留最后 maxLines 行（maxLines 非法时回退默认值）。 */
function keepLastLines(lines, maxLines = CRASH_LOG_MAX_LINES) {
  const max = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : CRASH_LOG_MAX_LINES;
  if (!Array.isArray(lines)) return [];
  return lines.slice(Math.max(0, lines.length - max));
}

/**
 * 追加一条 jsonl 记录（entry 序列化为一行 JSON），超出上限时环形裁剪。
 * @param {string} rawText 现有文件内容（可空）
 * @param {*} entry 要追加的记录（null/undefined 兜底为空对象）
 * @param {number} [maxLines] 最大保留行数，默认 50
 * @returns {string} 写回磁盘的完整内容（带结尾换行）
 */
function appendJsonlEntry(rawText, entry, maxLines = CRASH_LOG_MAX_LINES) {
  const lines = keepLastLines(parseJsonlLines(rawText), maxLines);
  lines.push(JSON.stringify(entry == null ? {} : entry));
  return keepLastLines(lines, maxLines).join('\n') + '\n';
}

/** 概要统计：行数 + 最后一条可解析记录的 type（坏行跳过，继续向前找）。 */
function summarizeCrashLog(rawText) {
  const lines = parseJsonlLines(rawText);
  let lastType = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (j && typeof j.type === 'string') {
        lastType = j.type;
        break;
      }
    } catch { /* 坏行跳过 */ }
  }
  return { lines: lines.length, lastType };
}

module.exports = {
  CRASH_WINDOW_MS,
  CRASH_THRESHOLD,
  CRASH_LOG_MAX_LINES,
  getLockResult,
  CrashTracker,
  parseJsonlLines,
  keepLastLines,
  appendJsonlEntry,
  summarizeCrashLog,
};
