'use strict';

/* ─────────────────────────────────────────────
   系统通知去重（纯函数，不依赖 Electron，可单独跑 node 测试）

   同一个 tag 在窗口期（默认 30 秒）内只发一次：后台回合完成 / 等待审批
   这类提醒可能由 toast 处与收尾逻辑先后各触发一次，用 tag 合并成一条，
   避免后台堆着一模一样的 Windows toast。
   tag 为空字符串 / 非字符串时没有去重键，每次都发。
   ───────────────────────────────────────────── */

/** 去重窗口：相同 tag 在 30s 内只发一次。 */
const NOTIFY_DEDUPE_WINDOW_MS = 30 * 1000;

/** 单条判定：lastAt 为该 tag 上次发送时间；时间非法或窗口非法时视为「不在窗口内」。 */
function withinWindow(lastAt, now, windowMs) {
  const last = Number(lastAt);
  const t = Number(now);
  if (!Number.isFinite(last) || !Number.isFinite(t) || !(windowMs > 0)) return false;
  return t >= last && t - last < windowMs;
}

/** 创建一个独立的去重器；主进程全局共用一个实例（模块级状态）。 */
function createNotifyDedupe(windowMs = NOTIFY_DEDUPE_WINDOW_MS) {
  const lastByTag = new Map();
  return {
    /** 相同 tag 在窗口期内只发一次；返回 true 表示本次应发送。 */
    shouldSend(tag, now = Date.now()) {
      const key = typeof tag === 'string' ? tag.trim() : '';
      if (!key) return true; // 没有 tag 就没有去重键
      if (withinWindow(lastByTag.get(key), now, windowMs)) return false;
      lastByTag.set(key, Number(now));
      return true;
    },
    reset() { lastByTag.clear(); },
  };
}

module.exports = { NOTIFY_DEDUPE_WINDOW_MS, withinWindow, createNotifyDedupe };
