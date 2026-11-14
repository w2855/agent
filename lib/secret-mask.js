'use strict';

/* ─────────────────────────────────────────────
   API Key 掩码与按 profileId 解析（纯函数，不依赖 Electron，可单独跑 node 测试）

   目标：明文 key 只留在主进程（内存表 + 加密凭据库），渲染层永远只拿到掩码。
   1) maskKey：真实 key → 'sk-****' + 末 4 位（不足 8 位时全掩码，不留尾巴）。
   2) resolveProfileKey：cfg 带 profileId 时用主进程持有的真实 key 覆盖；
      迁移期渲染层可能仍传明文，原样放行；唯一不能放行的是掩码值——
      '*' 不可能出现在真实 key 里，把它发给上游只会得到 401，
      因此按掩码反查内存表，唯一命中才放行，否则报错让用户重新保存。
   3) restoreMaskedProfileKeys：迁移期渲染层把掩码值回传 set 时，
      用内存里的真实 key 还原，避免掩码覆盖凭据库里的明文。
   ───────────────────────────────────────────── */

/** 掩码前缀：'*' 不在真实 key 的字符集里，据此区分「掩码回传」与「明文」。 */
const MASK_PREFIX = 'sk-****';
/** key 至少这么长才保留末 4 位；更短的 key 掩码后不许残留可辨认片段。 */
const TAIL_MIN_LENGTH = 8;

/** 掩码一个 key：'sk-abcd1234ef56' → 'sk-****ef56'；空 key 返回空串。 */
function maskKey(key) {
  const value = typeof key === 'string' ? key : '';
  if (!value) return '';
  if (value.length < TAIL_MIN_LENGTH) return MASK_PREFIX;
  return MASK_PREFIX + value.slice(-4);
}

/** 判断一个字符串是不是掩码值（真实 key 不含 '*'，掩码必以 MASK_PREFIX 开头）。 */
function isMaskedKey(key) {
  return typeof key === 'string' && key.startsWith(MASK_PREFIX);
}

/** 取 profile 的 id：优先 id，兼容渲染层回传时附带的 profileId 字段。 */
function profileIdOf(profile) {
  if (!profile || typeof profile !== 'object') return '';
  if (typeof profile.id === 'string' && profile.id) return profile.id;
  if (typeof profile.profileId === 'string') return profile.profileId;
  return '';
}

/** 单个 profile 的掩码视图：key 变掩码，附加 hasKey / profileId，其余字段原样保留。 */
function maskProfile(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const key = typeof profile.key === 'string' ? profile.key : '';
  const hasKey = key.trim().length > 0;
  return {
    ...profile,
    key: hasKey ? maskKey(key) : '',
    hasKey,
    profileId: profileIdOf(profile),
  };
}

/** 凭据库数据（{ profiles, active }）整体转掩码视图；缺 profiles 的形状原样返回。 */
function maskProfilesData(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.profiles)) return data;
  return { ...data, profiles: data.profiles.map(maskProfile) };
}

/** 从 profiles 构建 profileId → 明文 key 的内存映射；掩码值与空 key 不入库。 */
function buildProfileKeyMap(profiles) {
  const map = new Map();
  if (!Array.isArray(profiles)) return map;
  for (const p of profiles) {
    if (!p || typeof p !== 'object') continue;
    const id = profileIdOf(p).trim();
    const key = typeof p.key === 'string' ? p.key : '';
    if (!id || !key || isMaskedKey(key)) continue;
    map.set(id, key);
  }
  return map;
}

/** 迁移期保护：渲染层把掩码值回传时，用内存里的真实 key 还原；还原不了就原样保留。 */
function restoreMaskedProfileKeys(profiles, profileKeyById) {
  if (!Array.isArray(profiles)) return profiles;
  const map = profileKeyById instanceof Map ? profileKeyById : new Map();
  return profiles.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const key = typeof p.key === 'string' ? p.key : '';
    if (!isMaskedKey(key)) return p;
    const id = profileIdOf(p).trim();
    const real = id ? map.get(id) : null;
    if (typeof real === 'string' && real) return { ...p, key: real };
    return p;
  });
}

/**
 * 按 cfg 解析实际要用的 API Key。
 * 返回 { ok: true, key, via } 或 { ok: false, code, message }。
 * 顺序：profileId 命中内存表 → 掩码值反查（唯一命中才放行）→ 原样放行。
 */
function resolveProfileKey(cfg, profileKeyById) {
  const source = cfg && typeof cfg === 'object' ? cfg : {};
  const payloadKey = typeof source.key === 'string' ? source.key : '';
  const profileId = typeof source.profileId === 'string' ? source.profileId.trim() : '';
  const map = profileKeyById instanceof Map ? profileKeyById : new Map();

  if (profileId && map.has(profileId)) {
    return { ok: true, key: map.get(profileId), via: 'profileId' };
  }

  if (isMaskedKey(payloadKey)) {
    const matches = new Set();
    for (const key of map.values()) {
      if (maskKey(key) === payloadKey) matches.add(key);
    }
    if (matches.size === 1) {
      const [key] = matches;
      return { ok: true, key, via: 'mask' };
    }
    return {
      ok: false,
      code: matches.size > 1 ? 'KEY_AMBIGUOUS' : 'KEY_NOT_RESOLVED',
      message: matches.size > 1
        ? '多个连接的密钥掩码相同，无法确定用哪个；请在「API 接入」里重新填写并保存 API Key'
        : 'API Key 已改由主进程保管，当前配置解析不到它；请在「API 接入」里重新填写并保存 API Key',
    };
  }

  return { ok: true, key: payloadKey, via: 'payload' };
}

module.exports = {
  MASK_PREFIX,
  TAIL_MIN_LENGTH,
  maskKey,
  isMaskedKey,
  maskProfile,
  maskProfilesData,
  buildProfileKeyMap,
  restoreMaskedProfileKeys,
  resolveProfileKey,
};
