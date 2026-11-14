'use strict';

/* ─────────────────────────────────────────────
   权限档位裁定（R15/A1）。纯函数、零 IO，便于单测。

   模型：权威值只存在主进程（持久化键 dsh.perm）。渲染层传下来的
   `permission` / `profile` 一律按「请求」处理，规则只有一条——
   **只能比权威值更严格，永不更宽松**。

   为什么需要：R14 收回了审批权（渲染层传 approved:true 已失效），
   但档位权仍在渲染层。被注入的渲染层只要传 profile:'full'，
   就能让用户设置的 ask 档静默放行所有危险工具，界面上看不出异常。
   ───────────────────────────────────────────── */

const PROFILE_VALUES = Object.freeze(['full', 'ask', 'readonly']);
/** rank 越大越严格 */
const PROFILE_RANK = Object.freeze({ full: 0, ask: 1, readonly: 2 });

function isProfile(value) {
  return typeof value === 'string' && PROFILE_VALUES.includes(value);
}

/**
 * 把请求档位收敛到权威值。
 * @param {string} requested 调用方请求的档位（可能来自渲染层，不可信）
 * @param {string} authority 主进程权威档位
 * @returns {'full'|'ask'|'readonly'} 实际生效档位（≤ 权威值的宽松程度）
 */
function resolvePermission(requested, authority) {
  const auth = isProfile(authority) ? authority : 'full';
  if (!isProfile(requested)) return auth;
  return PROFILE_RANK[requested] >= PROFILE_RANK[auth] ? requested : auth;
}

/** 从 from 切到 to 是否为「放宽」（需要原生确认框）。 */
function isElevation(from, to) {
  const a = isProfile(from) ? from : 'full';
  const b = isProfile(to) ? to : 'full';
  return PROFILE_RANK[b] < PROFILE_RANK[a];
}

module.exports = { PROFILE_VALUES, PROFILE_RANK, isProfile, resolvePermission, isElevation };
