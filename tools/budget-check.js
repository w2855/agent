'use strict';

/* 验证持久成本预算层（lib/budget-file.js + runtime/delegation.js 接线）：
   三窗口滚动边界 / 超限动作硬停阶梯 / hard-stop 拒绝路径 / fallback 模型替换
   / 持久化往返 / 预算层异常不影响委派主链路（与单次父子预算两层正交）。
   运行：node tools/budget-check.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const budgetFile = require('../lib/budget-file');
const runtimeModule = require('../runtime');
const localTools = require('../lib/tools');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-budget-${tag}-`));
}

/* 固定时刻（UTC）：T1=周三 2026-01-28，T2=周四 01-29（跨日、同周同月），
   T3=周一 2026-02-02（跨日 + 跨周（周一新一周起点）+ 跨月（1 号新月初点）） */
const T1 = Date.UTC(2026, 0, 28, 10, 0, 0);
const T2 = Date.UTC(2026, 0, 29, 10, 0, 0);
const T3 = Date.UTC(2026, 1, 2, 10, 0, 0);

/* 委派接线测试用的最小 runtime（与 runtime-delegation-check 同款配方） */
const PROVIDER = { baseUrl: 'http://mock.local/v1', key: 'test-key', model: 'mock-model' };
function makeRuntime(dir, workspace, modelHandler) {
  const rt = runtimeModule.createRuntime({
    dir,
    workspacePath: workspace,
    executeTool: (name, args, opts) => localTools.executeTool(name, args, opts),
    modelRequest: (ctx) => modelHandler(ctx),
  });
  rt.init();
  return rt;
}
function proposeDelegation(rt, runId, args, profile = 'full') {
  const step = rt.beginStep({ runId, kind: 'tool_call' }).data.step;
  const proposal = rt.proposeTool({ runId, stepId: step.id, name: 'delegate_task', args, profile });
  return { step, proposal };
}
function approveIfNeeded(rt, proposal) {
  if (proposal?.data?.status !== 'waiting_approval') return false;
  rt.decideApproval({
    approvalId: proposal.data.approval.id,
    decision: 'approved',
    scope: 'once',
    reason: '预算测试批准',
  });
  return true;
}
function okReply(content) {
  return { content, toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, finishReason: 'stop' };
}

(async () => {
  const tmp = tempDir('unit');

  /* ── 1. 窗口周期起点（UTC 边界）── */
  add('daily 起点 = UTC 当日 0 点', budgetFile.periodStart('daily', T1) === Date.UTC(2026, 0, 28), String(budgetFile.periodStart('daily', T1)));
  add('weekly 起点 = 本周一（周中）', budgetFile.periodStart('weekly', T1) === Date.UTC(2026, 0, 26), String(budgetFile.periodStart('weekly', T1)));
  add('weekly 起点：周日仍归本周一', budgetFile.periodStart('weekly', Date.UTC(2026, 1, 1, 23)) === Date.UTC(2026, 0, 26), '2026-02-01 是周日');
  add('monthly 起点 = 本月 1 号', budgetFile.periodStart('monthly', T1) === Date.UTC(2026, 0, 1), String(budgetFile.periodStart('monthly', T1)));
  add('未知窗口名抛错', (() => { try { budgetFile.periodStart('hourly', T1); return false; } catch { return true; } })(), 'throw');

  /* ── 2. loadBudget 缺省与容错 ── */
  const file = path.join(tmp, 'budget.json');
  const fresh = budgetFile.loadBudget(file);
  add('缺文件 → 全 0 无限制', fresh.windows.daily.limit === 0 && fresh.windows.daily.spent === 0
    && fresh.hardStop === false && fresh.fallbackModel === '', JSON.stringify(fresh.windows.daily));
  add('缺文件 → checkBudget 放行', (() => {
    const g = budgetFile.checkBudget(fresh, T1);
    return g.allowed === true && g.action === 'allow' && Array.isArray(g.exceededWindows) && g.exceededWindows.length === 0;
  })(), JSON.stringify(budgetFile.checkBudget(fresh, T1)));
  fs.writeFileSync(file, '这不是 JSON{{{', 'utf8');
  const corrupt = budgetFile.loadBudget(file);
  add('损坏 JSON → 回落默认无限制', corrupt.windows.daily.limit === 0 && corrupt.hardStop === false, 'not json');
  fs.writeFileSync(file, 'x'.repeat(budgetFile.MAX_FILE_BYTES + 1), 'utf8');
  const oversized = budgetFile.loadBudget(file);
  add('超尺寸文件 → 回落默认无限制', oversized.windows.daily.limit === 0, `${budgetFile.MAX_FILE_BYTES + 1} bytes`);
  fs.writeFileSync(file, JSON.stringify({
    windows: { daily: { limit: 'abc', spent: -5, windowStart: 'x' }, weekly: { limit: 20 } },
    hardStop: 'yes', fallbackModel: '  fb-model  ',
  }), 'utf8');
  const messy = budgetFile.loadBudget(file);
  add('非法字段归一化为安全默认值', messy.windows.daily.limit === 0 && messy.windows.daily.spent === 0, JSON.stringify(messy.windows.daily));
  add('fallbackModel 去首尾空白', messy.fallbackModel === 'fb-model', messy.fallbackModel);

  /* ── 3. 记账与持久化往返 ── */
  fs.rmSync(file, { force: true });
  budgetFile.spend(file, { tokens: 100, modelCalls: 2 }, T1);
  const afterSpend = budgetFile.loadBudget(file, T1);
  add('spend tokens 落入三窗口', ['daily', 'weekly', 'monthly'].every((k) => afterSpend.windows[k].spent === 100),
    JSON.stringify(Object.fromEntries(Object.entries(afterSpend.windows).map(([k, v]) => [k, v.spent]))));
  add('spend modelCalls 观测计数', ['daily', 'weekly', 'monthly'].every((k) => afterSpend.windows[k].modelCalls === 2), 'calls=2');
  budgetFile.spend(file, { tokens: 40, modelCalls: 1 }, T1);
  const afterSpend2 = budgetFile.loadBudget(file, T1);
  add('同窗口内再次 spend 累加', ['daily', 'weekly', 'monthly'].every((k) => afterSpend2.windows[k].spent === 140 && afterSpend2.windows[k].modelCalls === 3), '140/3');
  add('持久化往返：重读与写入一致', afterSpend2.windows.daily.spent === 140 && afterSpend2.windows.daily.windowStart === budgetFile.periodStart('daily', T1), 'roundtrip');
  add('spend 后无 .tmp 残留', fs.readdirSync(tmp).filter((f) => f.includes('.tmp-')).length === 0, 'atomic write');

  budgetFile.setLimit(file, 'daily', 100);
  const afterLimit = budgetFile.loadBudget(file, T1);
  add('setLimit 只改目标窗口', afterLimit.windows.daily.limit === 100 && afterLimit.windows.weekly.limit === 0 && afterLimit.windows.monthly.limit === 0, JSON.stringify({ d: afterLimit.windows.daily.limit, w: afterLimit.windows.weekly.limit }));
  add('setLimit 非法窗口名抛错', (() => { try { budgetFile.setLimit(file, 'hourly', 1); return false; } catch { return true; } })(), 'throw');
  add('setLimit 负数抛错', (() => { try { budgetFile.setLimit(file, 'daily', -1); return false; } catch { return true; } })(), 'throw');

  /* ── 4. 三窗口滚动边界（注入固定时刻）── */
  const rollFile = path.join(tmp, 'roll.json');
  budgetFile.spend(rollFile, { tokens: 100 }, T1);
  budgetFile.spend(rollFile, { tokens: 50 }, T2);
  const atT2 = budgetFile.loadBudget(rollFile, T2);
  add('跨日：daily 清零重计', atT2.windows.daily.spent === 50, String(atT2.windows.daily.spent));
  add('同周同月：weekly/monthly 继续累计', atT2.windows.weekly.spent === 150 && atT2.windows.monthly.spent === 150, `w=${atT2.windows.weekly.spent} m=${atT2.windows.monthly.spent}`);
  budgetFile.spend(rollFile, { tokens: 70 }, T3);
  const atT3 = budgetFile.loadBudget(rollFile, T3);
  add('跨日+跨周（周一）+跨月（1 号）：三窗口全部清零重计',
    atT3.windows.daily.spent === 70 && atT3.windows.weekly.spent === 70 && atT3.windows.monthly.spent === 70,
    JSON.stringify({ d: atT3.windows.daily.spent, w: atT3.windows.weekly.spent, m: atT3.windows.monthly.spent }));
  add('滚动后 windowStart 指向新周期', atT3.windows.weekly.windowStart === budgetFile.periodStart('weekly', T3)
    && atT3.windows.monthly.windowStart === Date.UTC(2026, 1, 1), 'new period');

  /* ── 5. checkBudget 硬停阶梯 ── */
  const cur = budgetFile.periodStart('daily', T1);
  const mk = (over) => ({
    windows: {
      daily: { limit: 10, spent: over, windowStart: cur },
      weekly: { limit: 0, spent: 0, windowStart: cur },
      monthly: { limit: 0, spent: 0, windowStart: cur },
    },
    hardStop: false,
    fallbackModel: '',
  });
  add('spent == limit 不算超限（等于放行）', budgetFile.checkBudget(mk(10), T1).action === 'allow', 'at limit');
  add('超限 + 无 hardStop/fallback → 只记录不拦截（action 仍 allow）', (() => {
    const g = budgetFile.checkBudget(mk(11), T1);
    return g.action === 'allow' && g.allowed === true && g.exceededWindows.length === 1;
  })(), JSON.stringify(budgetFile.checkBudget(mk(11), T1)));
  const hardB = { ...mk(11), hardStop: true };
  add('超限 + hardStop → hard-stop 且 allowed=false', (() => {
    const g = budgetFile.checkBudget(hardB, T1);
    return g.action === 'hard-stop' && g.allowed === false && g.exceededWindows[0] === 'daily';
  })(), JSON.stringify(budgetFile.checkBudget(hardB, T1)));
  const fbB = { ...mk(11), fallbackModel: 'fb-model' };
  add('超限 + fallbackModel → fallback 且 allowed=false', (() => {
    const g = budgetFile.checkBudget(fbB, T1);
    return g.action === 'fallback' && g.allowed === false;
  })(), JSON.stringify(budgetFile.checkBudget(fbB, T1)));
  add('fallbackModel 为空白不算设置 → 仍 allow', budgetFile.checkBudget({ ...mk(11), fallbackModel: '   ' }, T1).action === 'allow', 'blank fb');
  add('hardStop 优先于 fallback', budgetFile.checkBudget({ ...mk(11), hardStop: true, fallbackModel: 'fb' }, T1).action === 'hard-stop', 'hard first');
  const staleB = { windows: { daily: { limit: 10, spent: 999, windowStart: cur - 86400000 * 5 }, weekly: { limit: 0, spent: 0, windowStart: cur }, monthly: { limit: 0, spent: 0, windowStart: cur } }, hardStop: true };
  add('过期窗口视为已清零（旧周期超限不拦截新周期）', budgetFile.checkBudget(staleB, T1).action === 'allow', 'stale ignored');
  /* 各窗口的 windowStart 必须用各自周期的起点（混用 daily 起点会被判成过期窗口） */
  const mkWin = (kind, limit, spent) => ({ limit, spent, modelCalls: 0, windowStart: budgetFile.periodStart(kind, T1) });
  const weeklyOnly = {
    windows: { daily: mkWin('daily', 0, 0), weekly: mkWin('weekly', 5, 6), monthly: mkWin('monthly', 0, 0) },
    hardStop: true,
  };
  add('仅 weekly 超限 → exceededWindows=[weekly]', JSON.stringify(budgetFile.checkBudget(weeklyOnly, T1).exceededWindows) === '["weekly"]', 'weekly only');
  const allOver = {
    windows: { daily: mkWin('daily', 1, 2), weekly: mkWin('weekly', 1, 2), monthly: mkWin('monthly', 1, 2) },
    hardStop: true,
  };
  add('三窗口都超限 → 按顺序列出', JSON.stringify(budgetFile.checkBudget(allOver, T1).exceededWindows) === '["daily","weekly","monthly"]', 'all windows');
  add('checkBudget 是纯函数，不改入参', mk(11).windows.daily.spent === 11 && (() => { const b = mk(11); budgetFile.checkBudget(b, T1); return b.windows.daily.spent === 11; })(), 'no mutation');

  /* ── 6. delegation.js 接线：先持久总额门，再父子预算；成功后预扣记账 ── */
  const root = tempDir('wire');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  let modelHandler = async () => okReply('子任务完成');
  const rt = makeRuntime(path.join(root, 'store'), workspace, (ctx) => modelHandler(ctx));
  const target = rt.createAgent({ name: '预算目标', permissionProfileId: 'full' }).data.agent;
  const budgetPath = rt.delegations.budgetPath;

  add('接线：budgetPath 默认落在运行时目录', budgetPath === path.join(root, 'store', 'budget.json'), budgetPath);

  // 6.1 正常委派 → 预扣记账（tokens = 子任务预算 maxTokens，三窗口同记）
  const parent1 = rt.createTask({ title: '预算记账', input: '记账', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'budget-wire-1' }).data;
  const d1 = proposeDelegation(rt, parent1.run.id, { agentId: target.id, objective: '正常委派以验证预扣记账。', expectedOutput: '完成。' });
  approveIfNeeded(rt, d1.proposal);
  const exec1 = await rt.executeTool({ toolCallId: d1.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('无预算配置时委派不受影响（第一层默认放行）', exec1.ok && exec1.data.ok === true, JSON.stringify({ code: exec1.data?.code, status: exec1.data?.status }));
  const del1 = rt.listDelegations({ parentRunId: parent1.run.id }).data.delegations[0];
  const spentNow = budgetFile.loadBudget(budgetPath, Date.now()).windows.daily.spent;
  add('成功委派后按子任务预算预扣 tokens（三窗口）', spentNow === del1.budget.maxTokens
    && ['weekly', 'monthly'].every((k) => budgetFile.loadBudget(budgetPath, Date.now()).windows[k].spent === del1.budget.maxTokens),
    `spent=${spentNow} 预算=${del1.budget.maxTokens}`);
  add('预扣后默认无限额 → 仍 allow', budgetFile.checkBudget(budgetFile.loadBudget(budgetPath)).allowed === true, 'allow');

  // 6.2 hard-stop：总额超限 + hardStop → 入口拒绝，不建子任务、不记账
  const rt2dir = path.join(root, 'store2');
  const rt2 = makeRuntime(rt2dir, workspace, (ctx) => modelHandler(ctx));
  const target2 = rt2.createAgent({ name: '硬停目标', permissionProfileId: 'full' }).data.agent;
  const bp2 = rt2.delegations.budgetPath;
  budgetFile.setLimit(bp2, 'daily', 100);
  budgetFile.spend(bp2, { tokens: 150 }, Date.now());
  /* 阶梯语义：超限 + hardStop=true 才硬停；不设 hardStop 且无 fallbackModel 时只记账不拦截 */
  const b2 = budgetFile.loadBudget(bp2, Date.now());
  b2.hardStop = true;
  budgetFile.saveBudget(bp2, b2);
  const hardGate = budgetFile.checkBudget(budgetFile.loadBudget(bp2, Date.now()), Date.now());
  add('前置：预算文件此刻判定为 hard-stop', hardGate.action === 'hard-stop' && hardGate.exceededWindows.includes('daily'), JSON.stringify(hardGate));
  const parent2 = rt2.createTask({ title: '硬停测试', input: 'hardstop', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'budget-wire-2' }).data;
  const d2 = proposeDelegation(rt2, parent2.run.id, { agentId: target2.id, objective: '超限后的委派应被硬停拒绝。', expectedOutput: '不应到达。' });
  approveIfNeeded(rt2, d2.proposal);
  const exec2 = await rt2.executeTool({ toolCallId: d2.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('hard-stop 在 create 入口拒绝委派', exec2.ok && exec2.data.ok === false && exec2.data.code === 'BUDGET_HARD_STOP', JSON.stringify({ code: exec2.data?.code, msg: exec2.data?.message }));
  const rejEvt = rt2.read({ afterSeq: 0, limit: 5000 }).events.find((e) => e.type === 'delegation.rejected');
  add('拒绝走既有 delegation.rejected 事件且 reason 注明预算窗口', !!rejEvt && rejEvt.payload?.code === 'BUDGET_HARD_STOP' && /daily/.test(rejEvt.payload?.reason || ''), JSON.stringify(rejEvt?.payload || {}));
  add('hard-stop 路径不创建委派记录', rt2.listDelegations({ parentRunId: parent2.run.id }).data.delegations.length === 0, 'no record');
  add('hard-stop 路径不额外记账', budgetFile.loadBudget(bp2, Date.now()).windows.daily.spent === 150, 'spend unchanged');

  // 6.3 fallback：既有目标 Agent → 委派记录 model 可替换为 fallbackModel（子运行真实使用）
  const rt3dir = path.join(root, 'store3');
  const rt3 = makeRuntime(rt3dir, workspace, async (ctx) => okReply(ctx?.cfg?.model === 'fallback-model-x' ? '子任务完成：使用了降级模型' : `错误：模型为 ${ctx?.cfg?.model}`));
  const target3 = rt3.createAgent({ name: '降级目标', permissionProfileId: 'full' }).data.agent;
  const bp3 = rt3.delegations.budgetPath;
  budgetFile.setLimit(bp3, 'daily', 100);
  budgetFile.spend(bp3, { tokens: 150 }, Date.now());
  const b3 = budgetFile.loadBudget(bp3, Date.now());
  b3.fallbackModel = 'fallback-model-x';
  budgetFile.saveBudget(bp3, b3);
  const parent3 = rt3.createTask({ title: '降级测试', input: 'fallback', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'budget-wire-3' }).data;
  const d3 = proposeDelegation(rt3, parent3.run.id, { agentId: target3.id, objective: '降级后仍应委派成功。', expectedOutput: '完成。' });
  approveIfNeeded(rt3, d3.proposal);
  const exec3 = await rt3.executeTool({ toolCallId: d3.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('fallback 放行：委派创建成功且子运行真实使用降级模型', exec3.ok && exec3.data.ok === true && /降级模型/.test(exec3.data?.content || ''), JSON.stringify({ code: exec3.data?.code, content: (exec3.data?.content || '').slice(0, 60) }));
  const del3 = rt3.listDelegations({ parentRunId: parent3.run.id }).data.delegations[0];
  add('委派记录 model 已替换为 fallbackModel', del3?.model === 'fallback-model-x', del3?.model);
  add('返回值/委派记录附 budgetWarning 且注明超限窗口与降级', typeof del3?.budgetWarning === 'string' && /daily/.test(del3.budgetWarning) && /降级/.test(del3.budgetWarning), del3?.budgetWarning);
  add('delegation.requested 事件 payload 附 budgetWarning', rt3.read({ afterSeq: 0, limit: 5000 }).events.some((e) => e.type === 'delegation.requested' && /降级/.test(e.payload?.budgetWarning || '')), 'event payload');
  add('fallback 路径照常预扣记账', budgetFile.loadBudget(bp3, Date.now()).windows.daily.spent === 150 + del3.budget.maxTokens, 'charged after fallback');

  // 6.4 fallback 不可替换：fallbackModel 非法 → 保持原模型 + warning
  const rt4dir = path.join(root, 'store4');
  const rt4 = makeRuntime(rt4dir, workspace, async (ctx) => okReply(ctx?.cfg?.model === PROVIDER.model ? '子任务完成：原模型' : `错误：模型为 ${ctx?.cfg?.model}`));
  const target4 = rt4.createAgent({ name: '非法降级目标', permissionProfileId: 'full' }).data.agent;
  const bp4 = rt4.delegations.budgetPath;
  budgetFile.setLimit(bp4, 'daily', 100);
  budgetFile.spend(bp4, { tokens: 150 }, Date.now());
  const b4 = budgetFile.loadBudget(bp4, Date.now());
  b4.fallbackModel = 'bad model!';
  budgetFile.saveBudget(bp4, b4);
  const parent4 = rt4.createTask({ title: '非法降级', input: 'badfb', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'budget-wire-4' }).data;
  const d4 = proposeDelegation(rt4, parent4.run.id, { agentId: target4.id, objective: 'fallback 名非法时保持原模型。', expectedOutput: '完成。' });
  approveIfNeeded(rt4, d4.proposal);
  const exec4 = await rt4.executeTool({ toolCallId: d4.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  const del4 = rt4.listDelegations({ parentRunId: parent4.run.id }).data.delegations[0];
  add('fallback 名非法 → 保持原模型（子运行仍用原模型）', exec4.ok && exec4.data.ok === true && /原模型/.test(exec4.data?.content || '') && del4?.model === PROVIDER.model, JSON.stringify({ model: del4?.model, content: (exec4.data?.content || '').slice(0, 40) }));
  add('不可替换分支附 warning（注明保持原模型）', typeof del4?.budgetWarning === 'string' && /保持原模型/.test(del4.budgetWarning), del4?.budgetWarning);

  // 6.5 fallback + 自动创建子 Agent：模型可直接指定 → 用 fallbackModel
  const rt5dir = path.join(root, 'store5');
  const rt5 = makeRuntime(rt5dir, workspace, async (ctx) => okReply(ctx?.cfg?.model === 'fallback-model-x' ? '子任务完成：自动创建并用降级模型' : `错误：模型为 ${ctx?.cfg?.model}`));
  const bp5 = rt5.delegations.budgetPath;
  budgetFile.setLimit(bp5, 'daily', 100);
  budgetFile.spend(bp5, { tokens: 150 }, Date.now());
  const b5 = budgetFile.loadBudget(bp5, Date.now());
  b5.fallbackModel = 'fallback-model-x';
  budgetFile.saveBudget(bp5, b5);
  const parent5 = rt5.createTask({ title: '自动创建降级', input: 'autofb', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'budget-wire-5' }).data;
  const d5 = proposeDelegation(rt5, parent5.run.id, { objective: '自动创建并降级模型。', expectedOutput: '完成。', model: 'wanted-model' });
  approveIfNeeded(rt5, d5.proposal);
  const exec5 = await rt5.executeTool({ toolCallId: d5.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  const del5 = rt5.listDelegations({ parentRunId: parent5.run.id }).data.delegations[0];
  const autoAgent = rt5.listAgents().data.agents.find((a) => a.id === del5?.targetAgentId);
  add('fallback + 自动创建：新建 Agent 直接用 fallbackModel', exec5.ok && exec5.data.ok === true && /降级模型/.test(exec5.data?.content || '')
    && del5?.autoCreated === true && del5?.model === 'fallback-model-x' && autoAgent?.version?.model?.model === 'fallback-model-x',
  JSON.stringify({ model: del5?.model, agentModel: autoAgent?.version?.model?.model }));

  // 6.6 两层预算正交：第一层总额门不干涉第二层父子预算的裁剪与拒绝
  const rt6dir = path.join(root, 'store6');
  const rt6 = makeRuntime(rt6dir, workspace, (ctx) => modelHandler(ctx));
  const target6 = rt6.createAgent({ name: '两层目标', permissionProfileId: 'full' }).data.agent;
  const bp6 = rt6.delegations.budgetPath;
  budgetFile.setLimit(bp6, 'daily', 10 * 1000 * 1000); // 总额门宽裕 → 应放行
  const parent6 = rt6.createTask({ title: '两层正交', input: 'ortho', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'budget-wire-6', budget: { maxTokens: 1000 } }).data;
  const d6 = proposeDelegation(rt6, parent6.run.id, { agentId: target6.id, objective: '第二层父子预算独立生效。', expectedOutput: '完成。', budget: { maxTokens: 500 } });
  approveIfNeeded(rt6, d6.proposal);
  const exec6 = await rt6.executeTool({ toolCallId: d6.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  const del6 = rt6.listDelegations({ parentRunId: parent6.run.id }).data.delegations[0];
  add('两层正交：总额门宽裕时父子预算独立裁剪（500 落到父剩余一半）', exec6.ok && exec6.data.ok === true && del6?.budget?.maxTokens > 0 && del6.budget.maxTokens <= 500,
    JSON.stringify({ child: del6?.budget?.maxTokens }));

  // 6.7 预算层异常不影响主链路：budget.json 损坏 / 记账路径不可写 → 委派照常
  const rt7dir = path.join(root, 'store7');
  const rt7 = makeRuntime(rt7dir, workspace, (ctx) => modelHandler(ctx));
  const target7 = rt7.createAgent({ name: '容错目标', permissionProfileId: 'full' }).data.agent;
  fs.writeFileSync(rt7.delegations.budgetPath, '))))垃圾数据', 'utf8');
  const parent7 = rt7.createTask({ title: '损坏预算文件', input: 'corrupt', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'budget-wire-7' }).data;
  const d7 = proposeDelegation(rt7, parent7.run.id, { agentId: target7.id, objective: '损坏的 budget.json 不应阻塞委派。', expectedOutput: '完成。' });
  approveIfNeeded(rt7, d7.proposal);
  const exec7 = await rt7.executeTool({ toolCallId: d7.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('budget.json 损坏 → 委派仍成功（预算层回落无限制）', exec7.ok && exec7.data.ok === true && !exec7.data?.budgetWarning, JSON.stringify({ code: exec7.data?.code }));
  const blocker = path.join(rt7dir, 'blocker');
  fs.writeFileSync(blocker, '占位文件，让 budget.json 的父目录建不出来', 'utf8');
  rt7.delegations.budgetPath = path.join(blocker, 'budget.json'); // spend 的 mkdirSync 必然失败
  const parent7b = rt7.createTask({ title: '记账失败', input: 'spendfail', providerId: PROVIDER.baseUrl, model: PROVIDER.model, idempotencyKey: 'budget-wire-8' }).data;
  const d7b = proposeDelegation(rt7, parent7b.run.id, { agentId: target7.id, objective: '记账写失败不应影响已创建的委派。', expectedOutput: '完成。' });
  approveIfNeeded(rt7, d7b.proposal);
  const exec7b = await rt7.executeTool({ toolCallId: d7b.proposal.data.toolCallId, providerConfig: PROVIDER, profile: 'full' });
  add('记账写失败被吞掉 → 委派创建不受影响', exec7b.ok && exec7b.data.ok === true, JSON.stringify({ code: exec7b.data?.code }));

  /* 清理 */
  rt.close(); rt2.close(); rt3.close(); rt4.close(); rt5.close(); rt6.close(); rt7.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });

  const total = checks.length;
  const passed = checks.filter((c) => c.pass).length;
  const out = { checks, total, passed, failed: total - passed };
  console.log(JSON.stringify(out, null, 2));
  if (out.failed) process.exitCode = 1;
})().catch((err) => {
  console.error('[budget-check] 未捕获错误：', err);
  process.exitCode = 1;
});
