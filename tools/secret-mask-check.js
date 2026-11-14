'use strict';

/* 自检：API Key 掩码与按 profileId 解析（lib/secret-mask.js 纯函数）。
   运行：node tools/secret-mask-check.js */

const secretMask = require('../lib/secret-mask');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

const REAL_KEY = 'sk-live-abcd1234ef567890';
const REAL_KEY_2 = 'rk-prod-9876543210zyxwvu';

(async () => {
  /* 1. 掩码：正常 key 保留末 4 位；短 key 全掩码；空 key 原样为空 */
  const masked = secretMask.maskKey(REAL_KEY);
  add('正常 key 掩码保留末 4 位', masked === 'sk-****7890', masked);
  add('掩码不含明文片段', !masked.includes('abcd1234'), masked);
  add('短 key 全掩码（<8 位不留尾巴）', secretMask.maskKey('sk-ab') === 'sk-****', secretMask.maskKey('sk-ab'));
  add('8 位 key 恰好保留末 4 位', secretMask.maskKey('12345678') === 'sk-****5678', secretMask.maskKey('12345678'));
  add('空 key 掩码为空串', secretMask.maskKey('') === '' && secretMask.maskKey(null) === '', JSON.stringify(secretMask.maskKey('')));
  add('非字符串输入不抛错', secretMask.maskKey(undefined) === '' && secretMask.maskKey(42) === '', 'ok');

  /* 2. isMaskedKey：真实 key 不会被误判成掩码 */
  add('真实 key 不判为掩码', !secretMask.isMaskedKey(REAL_KEY) && !secretMask.isMaskedKey(''), 'ok');
  add('掩码值判为掩码', secretMask.isMaskedKey('sk-****7890') && secretMask.isMaskedKey('sk-****'), 'ok');

  /* 3. 掩码视图：hasKey / profileId / 无明文泄漏 */
  const data = {
    profiles: [
      { id: 'p1', name: '主力', baseUrl: 'https://api.example.com', key: REAL_KEY, model: 'gemini-3.8-flash' },
      { id: 'p2', name: '备用', baseUrl: 'https://backup.example.com', key: '', model: 'gpt-4o' },
      { id: 'p3', name: '短key', baseUrl: 'https://short.example.com', key: 'sk-ab', model: 'claude-3' },
    ],
    active: 'p1',
  };
  const view = secretMask.maskProfilesData(data);
  add('掩码视图 key = sk-**** + 末 4 位', view.profiles[0].key === 'sk-****7890', view.profiles[0].key);
  add('掩码视图非空 key hasKey=true', view.profiles[0].hasKey === true, view.profiles[0].hasKey);
  add('空 key hasKey=false 且 key 为空串', view.profiles[1].hasKey === false && view.profiles[1].key === '', JSON.stringify(view.profiles[1]));
  add('短 key 视图全掩码且 hasKey=true', view.profiles[2].key === 'sk-****' && view.profiles[2].hasKey === true, JSON.stringify(view.profiles[2]));
  add('掩码视图附加 profileId', view.profiles[0].profileId === 'p1' && view.profiles[2].profileId === 'p3', JSON.stringify(view.profiles.map((p) => p.profileId)));
  add('掩码视图保留其余字段', view.profiles[0].baseUrl === data.profiles[0].baseUrl && view.active === 'p1', view.profiles[0].baseUrl);
  add('掩码视图整体无明文泄漏', !JSON.stringify(view).includes(REAL_KEY), 'ok');
  add('原数据未被就地修改', data.profiles[0].key === REAL_KEY, data.profiles[0].key);
  add('缺 profiles 形状原样返回（同一引用）', secretMask.maskProfilesData(null) === null, 'ok');
  const noProfiles = { active: 'p1' };
  add('无 profiles 字段的对象原样返回', secretMask.maskProfilesData(noProfiles) === noProfiles, 'ok');

  /* 4. 内存 key 表：掩码值与空 key 不入库 */
  const map = secretMask.buildProfileKeyMap([
    { id: 'p1', key: REAL_KEY },
    { id: 'p2', key: '' },
    { id: 'p3', key: 'sk-****7890' },
    { id: ' p4 ', key: REAL_KEY_2 },
    null,
    { key: 'no-id-key' },
  ]);
  add('key 表收录明文 key', map.get('p1') === REAL_KEY, 'ok');
  add('key 表跳过空 key 与掩码值', !map.has('p2') && !map.has('p3'), 'ok');
  add('key 表 id 去首尾空白后收录', map.get('p4') === REAL_KEY_2, 'ok');
  add('key 表跳过非法条目', map.size === 2, `size=${map.size}`);

  /* 5. 按 profileId 解析：命中覆盖 / 未命中回退 / 无 profileId 原样通过 */
  const hit = secretMask.resolveProfileKey({ profileId: 'p1', key: 'stale-payload-key', baseUrl: 'https://x', model: 'm' }, map);
  add('profileId 命中时用主进程 key 覆盖', hit.ok && hit.key === REAL_KEY && hit.via === 'profileId', JSON.stringify(hit));
  const miss = secretMask.resolveProfileKey({ profileId: 'ghost', key: REAL_KEY_2 }, map);
  add('profileId 未命中回退 payload key', miss.ok && miss.key === REAL_KEY_2 && miss.via === 'payload', JSON.stringify(miss));
  const direct = secretMask.resolveProfileKey({ key: REAL_KEY }, map);
  add('无 profileId 原样通过', direct.ok && direct.key === REAL_KEY && direct.via === 'payload', JSON.stringify(direct));
  const emptyCfg = secretMask.resolveProfileKey(null, map);
  add('cfg 为空原样通过（空 key）', emptyCfg.ok && emptyCfg.key === '', JSON.stringify(emptyCfg));

  /* 6. 掩码回传防护：反查唯一命中放行；歧义 / 查不到报错，掩码绝不原样放行 */
  const viaMask = secretMask.resolveProfileKey({ key: 'sk-****7890' }, map);
  add('掩码反查唯一命中还原真实 key', viaMask.ok && viaMask.key === REAL_KEY && viaMask.via === 'mask', JSON.stringify(viaMask));
  const ambiguousMap = new Map([
    ['a', 'sk-live-aaaa1111'],
    ['b', 'sk-live-bbbb1111'],
  ]);
  const ambiguous = secretMask.resolveProfileKey({ key: 'sk-****1111' }, ambiguousMap);
  add('掩码反查歧义时报错不放行', !ambiguous.ok && ambiguous.code === 'KEY_AMBIGUOUS', JSON.stringify(ambiguous));
  const unknown = secretMask.resolveProfileKey({ key: 'sk-****zzzz' }, map);
  add('掩码反查不到时报错不放行', !unknown.ok && unknown.code === 'KEY_NOT_RESOLVED', JSON.stringify(unknown));
  add('解析失败信息不含明文', !JSON.stringify([ambiguous, unknown]).includes(REAL_KEY) && !JSON.stringify([ambiguous, unknown]).includes(REAL_KEY_2), 'ok');

  /* 7. 迁移期 set 防护：掩码回传用真实 key 还原，还原不了保留原样，明文不动 */
  const restored = secretMask.restoreMaskedProfileKeys(
    [
      { id: 'p1', key: 'sk-****7890' },
      { id: 'p9', key: 'sk-****zzzz' },
      { id: 'p1x', key: 'sk-plain-new' },
    ],
    map,
  );
  add('set 回传掩码被还原为真实 key', restored[0].key === REAL_KEY, restored[0].key);
  add('还原不了的掩码保持原样', restored[1].key === 'sk-****zzzz', restored[1].key);
  add('明文 key 原样保留', restored[2].key === 'sk-plain-new', restored[2].key);
  add('还原结果整体无掩码入库冲突', secretMask.buildProfileKeyMap(restored).get('p1') === REAL_KEY, 'ok');
  add('非数组输入原样返回', secretMask.restoreMaskedProfileKeys(null, map) === null, 'ok');

  /* 8. 兼容 profileId 字段（渲染层回传时附带 profileId 而非 id） */
  const byField = secretMask.buildProfileKeyMap([{ id: '', profileId: 'p1', key: REAL_KEY }]);
  add('profileId 字段可作为映射键', byField.get('p1') === REAL_KEY, 'ok');
  const resolvedByField = secretMask.resolveProfileKey({ profileId: ' p1 ' }, byField);
  add('cfg.profileId 去空白后命中', resolvedByField.ok && resolvedByField.key === REAL_KEY, JSON.stringify(resolvedByField));

  const result = { checks, total: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.failed ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
