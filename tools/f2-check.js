'use strict';

/* F2 自检：委派链密钥解析（掩码 → 明文）与跨接入点委派。
   背景：R7-secrets 把密钥迁入主进程后，渲染层传给委派链的 providerConfig.key 是掩码
   （sk-****末4位），原样发上游必然 401。修复分三层：
     1) main.js 注入 resolveSecretKey（profileId → { baseUrl, key } | null，含 vault 懒加载）；
     2) runtime/index.js _providerConfigForRun：cfg 带 profileId 且 key 为掩码/空时换真钥；
     3) 跨接入点委派：delegate_task args.profileId 指定目标连接，delegation 记录保存
        profileId（key 不落盘），请求时经解析器现取现用。
   运行：node tools/f2-check.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtimeModule = require('../runtime');
const localTools = require('../lib/tools');
const { isMaskedKey, maskKey } = require('../lib/secret-mask');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-f2-${tag}-`));
}

const REAL_KEY_A = 'zk2-real-key-aaaa1111';
const REAL_KEY_B = 'zk2-real-key-bbbb2222';
const MOCK_RESOLVER_TABLE = {
  'prof-a': { baseUrl: 'http://mock-a.local/v1', key: REAL_KEY_A },
  'prof-b': { baseUrl: 'http://mock-b.local/v1', key: REAL_KEY_B },
};
/* 掩码形态必须以 sk-**** 开头（与 secret-mask.js 的 MASK_PREFIX 一致） */
const MASKED_A = maskKey(REAL_KEY_A);
const PROVIDER = { baseUrl: 'http://mock.local/v1', key: 'test-key', model: 'mock-model' };

function makeRuntime(dir, workspace, modelHandler, resolveSecretKey) {
  const rt = runtimeModule.createRuntime({
    dir,
    workspacePath: workspace,
    executeTool: (name, args, opts) => localTools.executeTool(name, args, opts),
    modelRequest: (ctx) => modelHandler(ctx),
    resolveSecretKey,
  });
  rt.init();
  return rt;
}

function textReply(content) {
  return { content, toolCalls: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }, finishReason: 'stop' };
}

function proposeDelegation(rt, runId, args, profile = 'full') {
  const step = rt.beginStep({ runId, kind: 'tool_call' }).data.step;
  const proposal = rt.proposeTool({ runId, stepId: step.id, name: 'delegate_task', args, profile });
  return { step, proposal };
}

function approveIfNeeded(rt, proposal) {
  if (proposal?.data?.status !== 'waiting_approval') return false;
  rt.decideApproval({ approvalId: proposal.data.approval.id, decision: 'approved', scope: 'once', reason: '测试批准' });
  return true;
}

/* 临时替换 console.warn 收集告警（掩码解析失败必须 warn 而不是静默吞掉） */
function captureWarn(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  return Promise.resolve().then(fn).finally(() => { console.warn = original; }).then((value) => ({ value, warnings }));
}

(async () => {
  /* ────────── 1. isMaskedKey / maskKey 基础判定 ────────── */
  add('isMaskedKey：掩码串判定为 true', isMaskedKey(MASKED_A), MASKED_A);
  add('isMaskedKey：真实 key 判定为 false', !isMaskedKey(REAL_KEY_A), REAL_KEY_A.slice(0, 6) + '…');
  add('isMaskedKey：非字符串/空值判定为 false', !isMaskedKey('') && !isMaskedKey(null) && !isMaskedKey(123), 'ok');

  /* ────────── 2. _normalizeProviderConfig 透传 profileId ────────── */
  const rt0 = makeRuntime(tempDir('norm'), tempDir('ws0'), async () => textReply('ok'));
  const norm = rt0._normalizeProviderConfig({ baseUrl: 'http://x.local/v1', key: MASKED_A, model: 'm1', profileId: 'prof-a', retry: 1 });
  add('normalize：profileId 不再被丢弃', norm && norm.profileId === 'prof-a', JSON.stringify(norm));
  add('normalize：无 profileId 时输出不带该字段', !rt0._normalizeProviderConfig({ baseUrl: 'http://x.local/v1', key: 'k', model: 'm' }).profileId, 'ok');

  /* ────────── 3. _providerConfigForRun 掩码解析（核心修复） ────────── */
  const resolverCalls = [];
  const mockResolver = async (profileId) => {
    resolverCalls.push(profileId);
    return MOCK_RESOLVER_TABLE[profileId] || null;
  };
  const rt = makeRuntime(tempDir('main'), tempDir('ws1'), async () => textReply('ok'), mockResolver);

  const runA = { providerId: 'prov_a' };
  const resolvedMasked = await rt._providerConfigForRun(runA, { baseUrl: 'http://old.local/v1', key: MASKED_A, model: 'm1', profileId: 'prof-a' });
  add('掩码 key + profileId → 换成真钥', resolvedMasked && resolvedMasked.key === REAL_KEY_A, JSON.stringify(resolvedMasked));
  add('跨接入点：baseUrl 来自 profile（解析器覆盖旧 baseUrl）', resolvedMasked.baseUrl === 'http://mock-a.local/v1', resolvedMasked.baseUrl);
  add('模型名保持不变', resolvedMasked.model === 'm1', resolvedMasked.model);
  add('解析器收到了正确的 profileId', resolverCalls.includes('prof-a'), JSON.stringify(resolverCalls));

  const plainPass = await rt._providerConfigForRun({ providerId: 'prov_p' }, { baseUrl: 'http://old.local/v1', key: 'plain-key-xyz', model: 'm1', profileId: 'prof-a' });
  add('明文 key + profileId → 原样通过（向后兼容）', plainPass.key === 'plain-key-xyz', plainPass.key);

  const emptyKeyProfile = await rt._providerConfigForRun({ providerId: 'prov_e' }, { baseUrl: 'http://old.local/v1', key: '', model: 'm1', profileId: 'prof-b' });
  add('空 key + profileId → 也按 profileId 解析真钥', emptyKeyProfile && emptyKeyProfile.key === REAL_KEY_B, JSON.stringify(emptyKeyProfile));

  const unresolvable = await captureWarn(() => rt._providerConfigForRun(
    { providerId: 'prov_u' },
    { baseUrl: 'http://old.local/v1', key: MASKED_A, model: 'm1', profileId: 'prof-missing' },
  ));
  add('profileId 无对应 → 保留掩码原值', unresolvable.value.key === MASKED_A, unresolvable.value.key);
  add('profileId 无对应 → 输出 console.warn', unresolvable.warnings.length > 0 && /prof-missing/.test(unresolvable.warnings.join('\n')), JSON.stringify(unresolvable.warnings));

  const noCfg = await rt._providerConfigForRun({ providerId: 'prov_none' }, { baseUrl: '', key: '', model: '' });
  add('无 profileId 且 key 为空 → 现有失败行为不变（返回 null → PROVIDER_CONFIG_MISSING）', noCfg === null, String(noCfg));

  const throwingResolver = async () => { throw new Error('resolver boom'); };
  const rtThrow = makeRuntime(tempDir('thr'), tempDir('ws2'), async () => textReply('ok'), throwingResolver);
  const throwCase = await captureWarn(() => rtThrow._providerConfigForRun({ providerId: 'prov_t' }, { baseUrl: 'http://old.local/v1', key: MASKED_A, model: 'm1', profileId: 'prof-a' }));
  add('解析器抛异常 → 保留掩码并 warn，不中断委派', throwCase.value.key === MASKED_A && throwCase.warnings.some((w) => /boom|prof-a/.test(w)), JSON.stringify(throwCase.warnings));

  const rtLegacy = makeRuntime(tempDir('legacy'), tempDir('ws3'), async () => textReply('ok'));
  const legacyCase = await rtLegacy._providerConfigForRun({ providerId: 'prov_l' }, { baseUrl: 'http://old.local/v1', key: MASKED_A, model: 'm1' });
  add('未注入解析器（旧调用方）→ no-op 保留掩码，不抛错', legacyCase && legacyCase.key === MASKED_A, legacyCase && legacyCase.key);

  /* ────────── 4. 端到端委派：掩码 providerConfig 委派成功且子请求带真钥 ────────── */
  const wsE2E = tempDir('ws4');
  const rtE2E = makeRuntime(tempDir('e2e'), wsE2E, async () => textReply('子任务完成：ok'), mockResolver);
  const target = rtE2E.createAgent({ name: 'F2子代理', permissionProfileId: 'full' }).data.agent;
  let parent = rtE2E.createTask({
    title: 'F2 父任务', input: '委派', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'f2-parent-1',
  }).data;
  let seenChildCfg = null;
  rtE2E.modelRequest = async (ctx) => { seenChildCfg = ctx.cfg; return textReply('子任务完成：ok'); };

  const d1 = proposeDelegation(rtE2E, parent.run.id, { agentId: target.id, objective: 'F2 修复验证', expectedOutput: '返回确认。' });
  approveIfNeeded(rtE2E, d1.proposal);
  const maskedProvider = { baseUrl: 'http://mock.local/v1', key: MASKED_A, model: 'mock-model', profileId: 'prof-a' };
  const exec1 = await rtE2E.executeTool({ toolCallId: d1.proposal.data.toolCallId, providerConfig: maskedProvider, profile: 'full' });
  add('掩码 providerConfig 端到端委派成功（修复前必 401）', exec1.ok && exec1.data.ok === true, JSON.stringify(exec1.data?.code || exec1.data?.status));
  add('子模型请求收到真钥', seenChildCfg && seenChildCfg.key === REAL_KEY_A, seenChildCfg && String(seenChildCfg.key).slice(0, 10) + '…');
  add('子模型请求 baseUrl 来自 profile', seenChildCfg && seenChildCfg.baseUrl === 'http://mock-a.local/v1', seenChildCfg && seenChildCfg.baseUrl);

  const del1 = rtE2E.listDelegations({ parentRunId: parent.run.id }).data.delegations[0];
  const del1Json = JSON.stringify(del1);
  add('委派记录不落任何明文 key（真钥 A）', !del1Json.includes(REAL_KEY_A), 'ok');
  add('委派记录不落掩码 key', !del1Json.includes('sk-****'), 'ok');

  /* 事件日志 / 审计链同样不允许泄漏明文或掩码 key */
  const eventJson = JSON.stringify(rtE2E.read({ afterSeq: 0, limit: 5000 }));
  add('事件日志不泄漏明文 key', !eventJson.includes(REAL_KEY_A) && !eventJson.includes(REAL_KEY_B), 'ok');
  add('事件日志不泄漏掩码 key', !eventJson.includes('sk-****'), 'ok');
  rtE2E.finishRun({ runId: parent.run.id, outcome: 'succeeded', summary: 'F2 测试收尾' }); // 释放并发槽位

  /* ────────── 5. 跨接入点委派：args.profileId 指定另一连接 ────────── */
  parent = rtE2E.createTask({
    title: 'F2 跨接入点父任务', input: '跨连接委派', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'f2-parent-2',
  }).data;
  seenChildCfg = null;
  const d2 = proposeDelegation(rtE2E, parent.run.id, {
    agentId: target.id,
    profileId: 'prof-b',
    model: 'glm-5.3',
    objective: '验证子代理使用指定连接。',
    expectedOutput: '返回连接与模型确认。',
  });
  approveIfNeeded(rtE2E, d2.proposal);
  const exec2 = await rtE2E.executeTool({ toolCallId: d2.proposal.data.toolCallId, providerConfig: maskedProvider, profile: 'full' });
  add('跨接入点委派成功', exec2.ok && exec2.data.ok === true, JSON.stringify(exec2.data?.code || exec2.data?.status));
  add('子请求发往指定 profile 的 baseUrl（mock-b）', seenChildCfg && seenChildCfg.baseUrl === 'http://mock-b.local/v1', seenChildCfg && seenChildCfg.baseUrl);
  add('子请求使用指定 profile 的 key', seenChildCfg && seenChildCfg.key === REAL_KEY_B, seenChildCfg && String(seenChildCfg.key).slice(0, 10) + '…');
  add('子请求模型取 args.model', seenChildCfg && seenChildCfg.model === 'glm-5.3', seenChildCfg && seenChildCfg.model);
  const del2 = rtE2E.listDelegations({ parentRunId: parent.run.id }).data.delegations.find((d) => d.profileId === 'prof-b');
  add('委派记录保存 profileId', !!del2, del2?.profileId || 'missing');
  add('委派记录 model = args.model', del2 && del2.model === 'glm-5.3', del2 && del2.model);
  add('跨接入点委派记录同样不落明文 key', del2 && !JSON.stringify(del2).includes(REAL_KEY_B), 'ok');
  rtE2E.finishRun({ runId: parent.run.id, outcome: 'succeeded', summary: 'F2 测试收尾' });

  /* 仅靠 profileId（父会话无 providerConfig）也能委派 */
  parent = rtE2E.createTask({
    title: 'F2 仅 profileId 委派', input: '无父配置委派', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'f2-parent-3',
  }).data;
  seenChildCfg = null;
  const d3 = proposeDelegation(rtE2E, parent.run.id, {
    agentId: target.id, profileId: 'prof-b', model: 'glm-5.3-flash',
    objective: '验证仅凭 profileId 委派。', expectedOutput: '返回确认。',
  });
  approveIfNeeded(rtE2E, d3.proposal);
  const exec3 = await rtE2E.executeTool({ toolCallId: d3.proposal.data.toolCallId, providerConfig: undefined, profile: 'full' });
  add('无父 providerConfig 时仅凭 profileId 委派成功', exec3.ok && exec3.data.ok === true, JSON.stringify(exec3.data?.code || exec3.data?.status));
  add('此时子请求仍发往指定 profile', seenChildCfg && seenChildCfg.baseUrl === 'http://mock-b.local/v1' && seenChildCfg.key === REAL_KEY_B, JSON.stringify(seenChildCfg && { b: seenChildCfg.baseUrl, m: seenChildCfg.model }));
  rtE2E.finishRun({ runId: parent.run.id, outcome: 'succeeded', summary: 'F2 测试收尾' });

  /* 不可解析的 profileId → 明确失败，不用父会话 key 打错端点 */
  parent = rtE2E.createTask({
    title: 'F2 未知 profile', input: '未知连接委派', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'f2-parent-4',
  }).data;
  const d4 = proposeDelegation(rtE2E, parent.run.id, {
    agentId: target.id, profileId: 'prof-ghost', model: 'glm-5.3',
    objective: '验证未知连接拒绝。', expectedOutput: '应失败。',
  });
  approveIfNeeded(rtE2E, d4.proposal);
  const exec4 = await rtE2E.executeTool({ toolCallId: d4.proposal.data.toolCallId, providerConfig: maskedProvider, profile: 'full' });
  add('未知 profileId → 委派被拒绝（PROFILE_UNRESOLVED）', exec4.ok && exec4.data.ok === false && exec4.data.code === 'PROFILE_UNRESOLVED', JSON.stringify(exec4.data?.code || exec4.data?.status));
  add('未知 profileId → 子请求未发出（不会拿父 key 打错端点）', seenChildCfg && seenChildCfg.baseUrl !== 'http://mock-ghost.local/v1', 'ok');
  rtE2E.finishRun({ runId: parent.run.id, outcome: 'failed', summary: 'F2 测试收尾' });

  /* ────────── 6. 不传 profileId → 现状（当前连接）不变 ────────── */
  parent = rtE2E.createTask({
    title: 'F2 兼容现状', input: '普通委派', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'f2-parent-5',
  }).data;
  seenChildCfg = null;
  const d5 = proposeDelegation(rtE2E, parent.run.id, { agentId: target.id, objective: '兼容性验证', expectedOutput: '返回确认。' });
  approveIfNeeded(rtE2E, d5.proposal);
  const exec5 = await rtE2E.executeTool({ toolCallId: d5.proposal.data.toolCallId, providerConfig: { baseUrl: 'http://mock.local/v1', key: 'plain-key-xyz', model: 'mock-model' }, profile: 'full' });
  add('不传 profileId → 沿用当前连接（现状不变）', exec5.ok && exec5.data.ok === true && seenChildCfg && seenChildCfg.baseUrl === 'http://mock.local/v1' && seenChildCfg.key === 'plain-key-xyz', JSON.stringify(seenChildCfg && seenChildCfg.baseUrl));

  for (const rtInst of [rt0, rt, rtThrow, rtLegacy, rtE2E]) rtInst.close();
  rtE2E.close();

  /* ────────── 汇总 ────────── */
  const failed = checks.filter((c) => !c.pass);
  console.log(`\nF2 自检：${checks.length - failed.length}/${checks.length} 通过`);
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'} · ${c.name}${c.pass ? '' : ' —— ' + c.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('F2 自检异常：', err);
  process.exit(1);
});
