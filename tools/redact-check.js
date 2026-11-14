'use strict';

/**
 * tools/redact-check.js — lib/redact.js 自检脚本（node tools/redact-check.js 直跑，零依赖）
 * ≥40 断言覆盖：类型探测/位置、四档动作、profile 管线、对象递归、循环引用、
 * 深度上限、中文混排、空串/非字符串防御、性能两条。
 * 全绿退出码 0；任一失败打印明细并退出码 1。
 */

const path = require('path');
const redact = require(path.join(__dirname, '..', 'lib', 'redact.js'));

// ---------------------------------------------------------------------------
// 极简断言框架
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed += 1;
    failures.push({ name, msg: e.message });
    console.log('  ✗ ' + name);
    console.log('      ' + String(e.message).split('\n').join('\n      '));
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || '不相等') + '\n        实际: ' + a + '\n        期望: ' + b);
}

function expectThrow(fn, ErrClass, msg) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) throw new Error(msg || '预期抛错但未抛');
  if (ErrClass && !(err instanceof ErrClass)) {
    throw new Error('异常类型不符: ' + err.name + '，期望 ' + (ErrClass.name || String(ErrClass)));
  }
  return err;
}

function timeMs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// ---------------------------------------------------------------------------
// 测试样本
// ---------------------------------------------------------------------------
const EMAIL = 'alice@example.com';
const PHONE = '13812345678';
const IDCARD = '11010119900307757X'; // 18 位，X 结尾
const APIKEY = 'sk-abcdefghij0123456789'; // sk- + 18 位主体
const BEARER_TOKEN = 'AbcDef0123456789xyz'; // 19 位
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
const CRED = 'password: hunter2secret';
const PRIVKEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7vK9x1q2w3e4r5t6y\n-----END RSA PRIVATE KEY-----';

const RULES_REDACT = [{ type: 'email', action: 'REDACT' }, { type: 'phone_cn', action: 'REDACT' }];

// ---------------------------------------------------------------------------
// 1. scanForPII 基础探测
// ---------------------------------------------------------------------------
console.log('== 1. scanForPII 类型探测与位置 ==');

t('空串 → 无命中', () => {
  eq(redact.scanForPII(''), [], '空串应返回空数组');
});

t('email 命中且位置正确', () => {
  const text = '联系 ' + EMAIL + ' 获取';
  const f = redact.scanForPII(text)[0];
  eq(f.type, 'email');
  eq(f.start, text.indexOf(EMAIL), 'start 应指向邮箱首字符');
  eq(f.end, f.start + EMAIL.length, 'end 应为 Exclusive 结尾');
  eq(f.sample, EMAIL);
});

t('email：无 @ 不命中', () => {
  eq(redact.scanForPII('aliceexample.com 邮箱占位').length, 0);
});

t('phone_cn 命中且位置正确', () => {
  const text = '手机 ' + PHONE + ' 已验证';
  const f = redact.scanForPII(text)[0];
  eq(f.type, 'phone_cn');
  eq(f.start, text.indexOf(PHONE));
  eq(f.end, f.start + PHONE.length);
});

t('phone_cn：12 位连续数字不命中（右侧防越界）', () => {
  eq(redact.scanForPII('订单号 138123456789 结尾').length, 0);
});

t('phone_cn：非 1 开头 11 位不命中', () => {
  eq(redact.scanForPII('编号 23812345678 参考').length, 0);
});

t('id_card_cn：18 位 X 结尾命中', () => {
  const text = '证件 ' + IDCARD + ' 已核验';
  const f = redact.scanForPII(text)[0];
  eq(f.type, 'id_card_cn');
  eq(f.start, text.indexOf(IDCARD));
});

t('id_card_cn：17 位不命中', () => {
  eq(redact.scanForPII('片段 11010119900307757 截断').length, 0);
});

t('api_key：sk- 前缀命中且位置正确', () => {
  const text = 'key=' + APIKEY;
  const f = redact.scanForPII(text)[0];
  eq(f.type, 'api_key');
  eq(f.start, text.indexOf(APIKEY));
  eq(f.end, f.start + APIKEY.length);
});

t('api_key：主体不足 16 位不命中', () => {
  eq(redact.scanForPII('密钥 sk-abc123 已失效').length, 0);
});

t('api_key：Bearer 只覆盖 token 本体', () => {
  const text = 'Authorization: Bearer ' + BEARER_TOKEN + ' 已过期';
  const fs = redact.scanForPII(text);
  eq(fs.length, 1);
  eq(fs[0].type, 'api_key');
  eq(fs[0].start, text.indexOf(BEARER_TOKEN), 'start 应指向 token 而非 Bearer');
  eq(fs[0].end, fs[0].start + BEARER_TOKEN.length);
});

t('jwt 三段式命中', () => {
  const text = '会话 ' + JWT + ' 校验';
  const fs = redact.scanForPII(text);
  eq(fs.length, 1);
  eq(fs[0].type, 'jwt');
  eq(fs[0].start, text.indexOf(JWT));
});

t('jwt 缺第三段不命中', () => {
  eq(redact.scanForPII('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJh').length, 0);
});

t('cred_kv：password= 命中（含值）', () => {
  const f = redact.scanForPII('配置 ' + CRED)[0];
  eq(f.type, 'cred_kv');
  eq(f.sample, CRED, '应命中 password: 及其值');
});

t('cred_kv：TOKEN= 大写命中', () => {
  const fs = redact.scanForPII('TOKEN=abc123456789');
  eq(fs.length, 1);
  eq(fs[0].type, 'cred_kv');
});

t('cred_kv：access_token 下划线前缀命中', () => {
  const fs = redact.scanForPII('access_token=xyz987654321');
  eq(fs.length, 1);
  eq(fs[0].type, 'cred_kv');
});

t('cred_kv：键后无 =/: 不命中', () => {
  eq(redact.scanForPII('the password is strong').length, 0);
});

t('private_key：整块命中（跨行）', () => {
  const text = '证书内容：\n' + PRIVKEY + '\n以上';
  const fs = redact.scanForPII(text);
  eq(fs.length, 1);
  eq(fs[0].type, 'private_key');
  eq(fs[0].start, text.indexOf('-----BEGIN'), 'start 指向块头');
  eq(fs[0].end, fs[0].start + PRIVKEY.length, 'end 覆盖整块含结尾横线');
});

t('private_key：块内 cred_kv 不重复报', () => {
  const pk = '-----BEGIN PRIVATE KEY-----\ntoken: inner123\n-----END PRIVATE KEY-----';
  const fs = redact.scanForPII(pk);
  eq(fs.length, 1);
  eq(fs[0].type, 'private_key', '整块优先，内部子命中被吞掉');
});

t('混合多类型按位置升序', () => {
  const text = '邮箱 ' + EMAIL + '，手机 ' + PHONE + '，密钥 ' + APIKEY;
  const fs = redact.scanForPII(text);
  eq(fs.map((f) => f.type), ['email', 'phone_cn', 'api_key']);
  ok(fs[0].start < fs[1].start && fs[1].start < fs[2].start, 'findings 应按 start 升序');
});

t('重叠优先级：token=sk-… 只保留 api_key', () => {
  const fs = redact.scanForPII('token=' + APIKEY);
  eq(fs.length, 1);
  eq(fs[0].type, 'api_key', 'api_key 优先级高于 cred_kv');
});

t('sample 超长截断（start/end 不受影响）', () => {
  const fs = redact.scanForPII(PRIVKEY);
  ok(fs[0].sample.length <= redact.SAMPLE_MAX + 1, 'sample 应截断到 SAMPLE_MAX+省略号');
  ok(fs[0].sample.endsWith('…'), '截断应以省略号结尾');
  eq(fs[0].end - fs[0].start, PRIVKEY.length, 'start/end 仍覆盖整块');
});

// ---------------------------------------------------------------------------
// 2. redactText 四档动作
// ---------------------------------------------------------------------------
console.log('== 2. redactText 四档动作 ==');

t('REDACT → [REDACTED:type]', () => {
  eq(redact.redactText('a ' + EMAIL + ' b', RULES_REDACT), 'a [REDACTED:email] b');
});

t('HASH 格式、确定性与可复算', () => {
  const rules = [{ type: 'email', action: 'HASH' }];
  const out = redact.redactText('x ' + EMAIL + ' y', rules);
  const m = /^x \[HASH:([0-9a-f]{12})\] y$/.exec(out);
  ok(m, '输出应为 x [HASH:12位hex] y，实际: ' + out);
  eq(m[1], redact.sha256Prefix(EMAIL), '哈希应等于 sha256 前 12 位');
  const out2 = redact.redactText('x ' + EMAIL + ' y', rules);
  eq(out, out2, '同输入两次哈希应一致');
});

t('PASS 原样保留', () => {
  const text = 'x ' + EMAIL + ' y';
  eq(redact.redactText(text, [{ type: 'email', action: 'PASS' }]), text);
});

t('BLOCK 抛 RedactBlockedError 且携带 type/count', () => {
  const err = expectThrow(
    () => redact.redactText(APIKEY + ' 和 ' + APIKEY, [{ type: 'api_key', action: 'BLOCK' }]),
    redact.RedactBlockedError
  );
  eq(err.type, 'api_key', 'type 应为首个阻断类型');
  eq(err.count, 2, 'count 应为命中总数');
  eq(err.hits.api_key, 2, 'hits 应含分类型计数');
});

t('BLOCK 多类型汇总进 types', () => {
  const err = expectThrow(
    () => redact.redactText(APIKEY + ' ' + JWT, [
      { type: 'api_key', action: 'BLOCK' },
      { type: 'jwt', action: 'BLOCK' },
    ]),
    redact.RedactBlockedError
  );
  ok(err.types.indexOf('api_key') !== -1 && err.types.indexOf('jwt') !== -1, 'types 应含两类');
  eq(err.count, 2);
});

t('未配置的类型默认 PASS（白名单语义）', () => {
  const out = redact.redactText(EMAIL + ' ' + PHONE, [{ type: 'email', action: 'REDACT' }]);
  eq(out, '[REDACTED:email] ' + PHONE, 'phone 未配置应原样');
});

t('未知 action 抛错', () => {
  expectThrow(() => redact.redactText('x', [{ type: 'email', action: 'NOPE' }]), Error);
});

t('rules 非数组抛 TypeError', () => {
  expectThrow(() => redact.redactText('x', { email: 'REDACT' }), TypeError);
});

t('redactText 非字符串抛 TypeError', () => {
  expectThrow(() => redact.redactText(42), TypeError);
  expectThrow(() => redact.redactText(null), TypeError);
});

t('rules 可直接传 profile 名', () => {
  eq(redact.redactText('x ' + EMAIL, 'off'), 'x ' + EMAIL, 'off profile 应全放行');
});

t('重叠应用：键名保留、值替换', () => {
  eq(redact.redactText('token=' + APIKEY, [{ type: 'api_key', action: 'REDACT' }]), 'token=[REDACTED:api_key]');
});

t('private_key 整块替换', () => {
  eq(redact.redactText(PRIVKEY, [{ type: 'private_key', action: 'REDACT' }]), '[REDACTED:private_key]');
});

// ---------------------------------------------------------------------------
// 3. profiles / pipeline
// ---------------------------------------------------------------------------
console.log('== 3. profiles / pipeline ==');

t('standard：七类全替换且不残留原始样本', () => {
  const text = [PRIVKEY, 'key: ' + APIKEY, JWT, EMAIL, PHONE, IDCARD, CRED].join('\n');
  const r = redact.pipeline(text);
  eq(r.blocked, false);
  eq(r.findings.length, 7, '应恰好命中 7 类各 1 次');
  const out = r.text;
  for (const ph of ['[REDACTED:private_key]', '[REDACTED:api_key]', '[REDACTED:jwt]', '[REDACTED:email]',
    '[REDACTED:phone_cn]', '[REDACTED:id_card_cn]', '[REDACTED:cred_kv]']) {
    ok(out.indexOf(ph) !== -1, '输出应含 ' + ph);
  }
  for (const secret of [PRIVKEY, APIKEY, JWT, EMAIL, PHONE, IDCARD, CRED]) {
    ok(out.indexOf(secret) === -1, '输出不应残留: ' + secret.slice(0, 16) + '…');
  }
});

t('strict：api_key 触发 BLOCK 且原文返回', () => {
  const text = '普通日志 ' + EMAIL + '，密钥 ' + APIKEY;
  const r = redact.pipeline(text, { profile: 'strict' });
  eq(r.blocked, true);
  eq(r.text, text, 'BLOCK 时应原文返回，不做半替换');
  ok(r.error instanceof redact.RedactBlockedError, 'error 应为 RedactBlockedError');
  eq(r.error.type, 'api_key');
});

t('strict：email 仍按 REDACT 处理', () => {
  const r = redact.pipeline('用户 ' + EMAIL + ' 登录', { profile: 'strict' });
  eq(r.blocked, false);
  eq(r.text, '用户 [REDACTED:email] 登录');
});

t('off：全放行但 findings 仍报告', () => {
  const text = EMAIL + ' ' + APIKEY;
  const r = redact.pipeline(text, { profile: 'off' });
  eq(r.blocked, false);
  eq(r.text, text, 'off 应原样输出');
  eq(r.findings.length, 2, 'findings 仍应报告命中');
});

t('未知 profile 抛错', () => {
  expectThrow(() => redact.pipeline('x', { profile: 'nope' }), Error);
});

t('pipeline 空串', () => {
  eq(redact.pipeline(''), { text: '', findings: [], blocked: false });
});

t('pipeline 非字符串抛 TypeError', () => {
  expectThrow(() => redact.pipeline(123), TypeError);
  expectThrow(() => redact.pipeline(null), TypeError);
});

t('opts.rules 优先于 profile', () => {
  const r = redact.pipeline('k ' + APIKEY, {
    profile: 'strict',
    rules: [{ type: 'api_key', action: 'PASS' }],
  });
  eq(r.blocked, false, '显式 rules 覆盖 strict 的 BLOCK');
  eq(r.text, 'k ' + APIKEY);
});

// ---------------------------------------------------------------------------
// 4. redactValue 递归
// ---------------------------------------------------------------------------
console.log('== 4. redactValue 对象递归 ==');

t('对象递归脱敏且不改原值', () => {
  const orig = { user: 'alice', email: EMAIL, meta: { phone: PHONE, tags: ['ok', EMAIL] } };
  const snapshot = JSON.stringify(orig);
  const out = redact.redactValue(orig, RULES_REDACT);
  eq(out.email, '[REDACTED:email]');
  eq(out.meta.phone, '[REDACTED:phone_cn]');
  eq(out.meta.tags[1], '[REDACTED:email]');
  eq(out.meta.tags[0], 'ok');
  eq(out.user, 'alice');
  eq(JSON.stringify(orig), snapshot, '原对象不得被修改');
  ok(out !== orig && out.meta !== orig.meta && out.meta.tags !== orig.meta.tags, '应返回全新结构');
});

t('数组与非字符串字段原样', () => {
  const out = redact.redactValue([PHONE, 42, null, true, 'fine'], RULES_REDACT);
  eq(out, ['[REDACTED:phone_cn]', 42, null, true, 'fine']);
});

t('循环引用 → [Circular] 不爆栈', () => {
  const obj = { name: 'a', email: EMAIL };
  obj.self = obj;
  const out = redact.redactValue(obj, RULES_REDACT);
  eq(out.self, '[Circular]');
  eq(out.email, '[REDACTED:email]');
  ok(out !== obj, '应返回新对象');
});

t('共享引用（非环）各自生成独立副本', () => {
  const shared = { email: EMAIL };
  const root = { b: shared, c: shared };
  const out = redact.redactValue(root, RULES_REDACT);
  ok(out.b !== out.c, '非环共享应各自产生副本');
  eq(out.b.email, '[REDACTED:email]');
  eq(out.c.email, '[REDACTED:email]');
});

t('深度上限：第 7 层对象原样返回', () => {
  // depth 0..5 下钻脱敏；depth 6 的对象原样返回（含其内层 L7）。
  // 注意用 ':' 分隔：'-' 与 '.' 都是合法邮箱局部字符，'L0-<email>' 会被整串命中。
  const leaf = { s: 'L7:' + PHONE };
  const six = { s: 'L6:' + PHONE, child: leaf };
  let chain = six;
  for (let i = 5; i >= 0; i--) chain = { s: 'L' + i + ':' + EMAIL, child: chain };
  const out = redact.redactValue(chain, undefined);
  let cur = out;
  for (let i = 0; i <= 5; i++) {
    eq(cur.s, 'L' + i + ':[REDACTED:email]', 'L' + i + ' 应被脱敏');
    cur = cur.child;
  }
  ok(cur === six, 'depth 6 层应原样返回（同一引用）');
  eq(cur.s, 'L6:' + PHONE, 'L6 未脱敏');
  eq(cur.child.s, 'L7:' + PHONE, 'L7 未脱敏');
});

t('Date/Buffer/TypedArray/Map 不展开', () => {
  const d = new Date(1234567890123);
  const buf = Buffer.from('binary-data');
  const u8 = new Uint8Array([1, 2, 3]);
  const m = new Map([[1, 2]]);
  const out = redact.redactValue({ d, buf, u8, m }, undefined);
  ok(out.d instanceof Date, 'Date 应原样');
  ok(Buffer.isBuffer(out.buf), 'Buffer 应原样');
  ok(out.u8 instanceof Uint8Array, 'TypedArray 应原样');
  ok(out.m instanceof Map, 'Map 应原样');
});

t('redactValue 透传 BLOCK', () => {
  expectThrow(
    () => redact.redactValue({ k: APIKEY }, [{ type: 'api_key', action: 'BLOCK' }]),
    redact.RedactBlockedError
  );
});

// ---------------------------------------------------------------------------
// 5. 中文混排与防御
// ---------------------------------------------------------------------------
console.log('== 5. 中文混排与入参防御 ==');

t('中文混排：命中与替换保留中文上下文', () => {
  const text = '用户邮箱是 ' + EMAIL + '，手机 ' + PHONE + '，请勿泄露';
  const fs = redact.scanForPII(text);
  eq(fs.length, 2);
  const r = redact.pipeline(text, { profile: 'standard' });
  eq(r.text, '用户邮箱是 [REDACTED:email]，手机 [REDACTED:phone_cn]，请勿泄露');
});

t('中文全角冒号不触发 cred_kv', () => {
  eq(redact.scanForPII('密码：abc123456').length, 0);
});

t('scanForPII 非字符串防御', () => {
  expectThrow(() => redact.scanForPII(42), TypeError);
  expectThrow(() => redact.scanForPII(null), TypeError);
  expectThrow(() => redact.scanForPII(['a']), TypeError);
});

// ---------------------------------------------------------------------------
// 6. 性能
// ---------------------------------------------------------------------------
console.log('== 6. 性能 ==');

/** 构造 ~1KB/段、七类各一次的低密度混合文本（另夹中文与普通日志行） */
function buildMixed(kb) {
  const chunk = [
    '用户 alice@example.com 于 2026-11-14 提交工单，手机号 13812345678，证件号 11010119900307757X，来自上海。',
    '会话令牌 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c 已校验。',
    '请求头 Authorization: Bearer AbcDef0123456789xyz，密码 password: hunter2secret，访问密钥 sk-abcdefghij0123456789。',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEA7vK9x1q2w3e4r5t6y7u8i9o0pAsDfGhJkLzXcVbNm1234567890QwErTyUiOpAsDfGhJkL',
    '-----END RSA PRIVATE KEY-----',
    '系统巡检完成：队列深度 12，慢查询 3 条，缓存命中率 98.4%，无异常事件，本次巡检耗时 215ms，全部指标正常。',
    '备注：本段为普通业务日志，用于填充体积；关键字包括 order、payment、settlement、invoice、warehouse 等等。',
  ].join('\n');
  const target = kb * 1024;
  let out = '';
  while (out.length < target) out += chunk + '\n';
  return out.slice(0, target);
}

t('100KB 混合文本 scanForPII < 100ms', () => {
  const big = buildMixed(100);
  ok(big.length >= 100 * 1024, '测试文本应 ≥100KB');
  // 预热（JIT/正则引擎），避免首跑抖动
  for (let i = 0; i < 3; i++) redact.scanForPII(big.slice(0, 20 * 1024));
  const ms = timeMs(() => redact.scanForPII(big));
  console.log('      [perf] scanForPII(100KB) = ' + ms.toFixed(1) + 'ms');
  ok(ms < 100, '耗时 ' + ms.toFixed(1) + 'ms 应 <100ms');
});

t('100KB redactText(standard) 无灾难性退化 (<500ms)', () => {
  const big = buildMixed(100);
  const ms = timeMs(() => redact.redactText(big, 'standard'));
  console.log('      [perf] redactText(100KB) = ' + ms.toFixed(1) + 'ms');
  ok(ms < 500, '耗时 ' + ms.toFixed(1) + 'ms 应 <500ms');
});

t("病态输入 'a×24!' 各正则 1000 次 <1s", () => {
  const pathological = 'a'.repeat(24) + '!';
  for (const p of redact.PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    const ms = timeMs(() => {
      for (let i = 0; i < 1000; i++) {
        re.lastIndex = 0;
        re.exec(pathological);
      }
    });
    ok(ms < 1000, p.type + ' 病态输入 1000 次 = ' + ms.toFixed(1) + 'ms 应 <1000ms');
  }
});

// ---------------------------------------------------------------------------
// 结果汇总
// ---------------------------------------------------------------------------
console.log('');
console.log('== 结果 ==');
console.log('通过: ' + passed + '  失败: ' + failed);
if (failed > 0) {
  console.log('');
  console.log('失败明细:');
  for (const f of failures) console.log('  - ' + f.name + ': ' + f.msg);
  process.exit(1);
}
console.log('ALL GREEN');
process.exit(0);
