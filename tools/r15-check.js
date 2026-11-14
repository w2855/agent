'use strict';

/* R15 修复自检：把第三轮审计（docs/security/audit-r15.md）的 13 项修复变成可执行断言。
   一部分是真单测（纯函数 / StateStore / 委派回滚），一部分是接线断言（源码特征）。
   纯 Node，不需要 Electron。
   运行：node tools/r15-check.js
   输出最后一行 JSON {passed,failed,total}，供 tools/run-all.js 汇总。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const authority = require('../lib/permission-authority');
const tokenEstimate = require('../lib/token-estimate');
const agentRunner = require('../runtime/agent-runner');
const runtimeModule = require('../runtime');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-r15-${tag}-`));
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function makeRuntime(root) {
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const rt = runtimeModule.createRuntime({
    dir: path.join(root, 'store'),
    workspacePath: ws,
    executeTool: async () => ({ ok: true, content: 'ok', meta: { label: 'ok' } }),
  });
  rt.init();
  return rt;
}

(async () => {
  /* ── 1. A1：权限档位裁定（请求 vs 权威值） ───────────────────── */
  {
    add('A1 渲染层传 full 不能越过 ask 权威值',
      authority.resolvePermission('full', 'ask') === 'ask', authority.resolvePermission('full', 'ask'));
    add('A1 渲染层传 full 不能越过 readonly 权威值',
      authority.resolvePermission('full', 'readonly') === 'readonly');
    add('A1 请求更严格时采纳请求（ask 权威 + readonly 请求）',
      authority.resolvePermission('readonly', 'ask') === 'readonly');
    add('A1 非法请求值回落权威值',
      authority.resolvePermission('superuser', 'ask') === 'ask'
      && authority.resolvePermission(null, 'readonly') === 'readonly');
    add('A1 权威值非法时按 full 处理（不误伤默认档）',
      authority.resolvePermission('ask', 'bogus') === 'ask');
    add('A1 提升判定：full←ask/readonly 为提升，收紧为否',
      authority.isElevation('ask', 'full') === true
      && authority.isElevation('readonly', 'full') === true
      && authority.isElevation('full', 'ask') === false
      && authority.isElevation('ask', 'ask') === false);
  }

  /* ── 2. A1：主进程接线（权威值持久化 + 通用通道挡住 dsh.perm） ── */
  {
    const mainSrc = read('main.js');
    add('A1 主进程有 permission:set / permission:get 通道',
      /ipcMain\.handle\('permission:set'/.test(mainSrc) && /ipcMain\.handle\('permission:get'/.test(mainSrc));
    add('A1 提权走主进程原生确认框（无头模式一律拒绝）',
      /confirmPermissionElevation/.test(mainSrc) && /--shot|--script/.test(mainSrc)
      && /提权未获确认/.test(mainSrc));
    add('A1 通用 storage 通道挡住 dsh.perm（set/remove/set-many 三处）',
      /STORAGE_GUARDED_KEYS/.test(mainSrc)
      && (mainSrc.match(/STORAGE_GUARDED_KEYS\.has/g) || []).length >= 3);
    add('A1 tool:exec 与 runtime 两通道都做权威收敛',
      /withAuthorityToolPayload\(payload\)/.test(mainSrc)
      && /withAuthorityProfile\(input\)/.test(mainSrc));
    const rtSrc = read('runtime/index.js');
    add('A1 evaluateTool 与 executor 同源收敛 Agent 档位',
      /stricterProfile\(input\.profile, agentProfile\)/.test(rtSrc));
  }

  /* ── 3. A2：技能目录走专用通道，不再借 run_command ────────────── */
  {
    const mainSrc = read('main.js');
    const appSrc = read('renderer/app.js');
    add('A2 新增 skills:open-dir 通道且做 realpath 归一',
      /ipcMain\.handle\('skills:open-dir'/.test(mainSrc) && /realpathSync\(raw\)/.test(mainSrc));
    add('A2 渲染层不再用 run_command + permission:full 打开目录',
      !/explorer "\$\{dir\}"[\s\S]{0,80}permission: 'full'/.test(appSrc)
      && /skills\?\.openDir/.test(appSrc));
  }

  /* ── 4. A3：委派失败回滚（不泄漏孤儿 Agent） ──────────────────── */
  {
    const root = tempDir('deleg');
    const rt = makeRuntime(root);
    const ws = rt.workspacePath;
    const created = rt.createTask({ title: '父任务', input: 'x', workspace: ws });
    const runId = created.data.run.id;
    const stepId = rt.beginStep({ runId, kind: 'tool_call' }).data.step.id;
    const propose = () => rt.proposeTool({
      runId,
      stepId,
      name: 'delegate_task',
      args: { objective: '做点事', expectedOutput: '完成', agentId: 'auto' },
      profile: 'full',
    }).data.toolCallId;

    const before = rt.stateStore.listAgents().length;
    // contextRefs 指向工作区外 → 走到 autoCreate 之后的 CONTEXT_REF_OUTSIDE
    const bad = rt.delegations.create({
      parentRunId: runId,
      toolCallId: propose(),
      args: { objective: '做点事', expectedOutput: '完成', agentId: 'auto', contextRefs: ['../nope.txt'] },
    });
    const after = rt.stateStore.listAgents().length;
    add('A3 委派被拒后不留下孤儿 Agent', bad.ok === false && before === after, `${before} -> ${after} (${bad.code})`);
    add('A3 拒绝码为 CONTEXT_REF_OUTSIDE（校验点在 autoCreate 之后）', bad.code === 'CONTEXT_REF_OUTSIDE', bad.code);

    const rollbacks = rt.store.readAll({ runId }).filter((e) => e.type === 'delegation.rollback');
    add('A3 回滚写 delegation.rollback 事件且标记成功',
      rollbacks.length === 1 && rollbacks[0].payload?.rolledBack === true,
      JSON.stringify(rollbacks.map((r) => r.payload)));

    const del = rt.stateStore.deleteAgent(rt.stateStore.defaultAgentId);
    add('A3 deleteAgent 拒绝删除默认 Agent', del.ok === false && del.code === 'DEFAULT_AGENT', del.code);

    const temp = rt.stateStore.createAgent({ name: '临时', description: 'x', permissionProfileId: 'ask', model: { providerId: '', model: '' } });
    const del2 = rt.stateStore.deleteAgent(temp.agent.id);
    add('A3 deleteAgent 删除无引用 Agent 并记录事件', del2.ok === true
      && !rt.stateStore.listAgents().some((a) => a.id === temp.agent.id));
    rt.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* ── 5. A4：压缩改为追加语义 + 信息密度提升 ───────────────────── */
  {
    const appSrc = read('renderer/app.js');
    add('A4 压缩用追加而不是覆盖旧摘要',
      /const prev = state\.compacted\.get\(s\.id\)/.test(appSrc) && /--- 后续对话 ---/.test(appSrc));
    add('A4 单条摘要 400 字符（不再是 120）',
      /COMPACT_LINE_CHARS = 400/.test(appSrc) && !/slice\(0, 120\)/.test(appSrc));
    add('A4 摘要池有总量上限并保留头尾',
      /COMPACT_MAX_CHARS = 24000/.test(appSrc) && /clampCompacted/.test(appSrc));
    add('A4 压缩摘要保留工具名与目标锚点',
      /compactAnchors/.test(appSrc) && /工具 \$\{names\.join/.test(appSrc));
    /* A18：压缩不得把界面历史一起删掉（长会话压缩后「token 花了、字没了」的实际故障） */
    const compactFn = (appSrc.split('function performCompact')[1] || '').split('\nfunction ')[0];
    add('A4/A18 压缩只标记 compacted，不重置消息表',
      /m\.compacted = true/.test(compactFn) && !/s\.messages\s*=\s*\[/.test(compactFn));
    add('A4/A18 摘要池随会话持久化（重启不截断）',
      /function setCompacted/.test(appSrc) && /session\.compactSummary = text/.test(appSrc)
      && /s\.compactSummary && !state\.compacted\.has/.test(appSrc));
  }

  /* ── 6. A5：上下文预算口径修正 ────────────────────────────────── */
  {
    const appSrc = read('renderer/app.js');
    add('A5 默认上下文 120000 字符（旧 700000 已移除）',
      /CTX_LIMIT_DEFAULT = 120000/.test(appSrc) && !/CTX_LIMIT_DEFAULT = 700000/.test(appSrc));
    add('A5 上限收敛到 400000 且旧超大值回落默认',
      /CTX_LIMIT_MAX = 400000/.test(appSrc) && /n > CTX_LIMIT_MAX\) return CTX_LIMIT_DEFAULT/.test(appSrc));
    add('A5 自动压缩阈值 75%（不再 90%）',
      /maxContextChars \* 0\.75/.test(appSrc) && !/maxContextChars \* 0\.9/.test(appSrc));
  }

  /* ── 7. A6 + A10：子代理上下文预算与 token 估算 ───────────────── */
  {
    const { trimChildMessages, repairToolPairs, checkpointMessages, MAX_CHILD_CONTEXT_CHARS } = agentRunner;
    add('A6 子代理有字符预算常量', Number.isFinite(MAX_CHILD_CONTEXT_CHARS) && MAX_CHILD_CONTEXT_CHARS > 0, MAX_CHILD_CONTEXT_CHARS);

    const big = [{ role: 'system', content: 'S' }];
    for (let i = 0; i < 60; i++) {
      big.push({ role: 'assistant', content: 'A'.repeat(4000), tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      big.push({ role: 'tool', tool_call_id: `c${i}`, content: 'R'.repeat(4000) });
    }
    const trimmed = trimChildMessages(big);
    const chars = trimmed.reduce((n, m) => n + String(m.content || '').length, 0);
    add('A6 超限历史被裁剪到预算内', chars <= MAX_CHILD_CONTEXT_CHARS, `${chars} <= ${MAX_CHILD_CONTEXT_CHARS}`);
    add('A6 裁剪后首条 system 保留', trimmed[0]?.role === 'system' && trimmed[0].content === 'S');

    // 配对修复：孤儿 tool / 无结果 tool_calls 都要清掉
    const broken = [
      { role: 'system', content: 'S' },
      { role: 'tool', tool_call_id: 'ghost', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'n1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ];
    const repaired = repairToolPairs(broken);
    add('A6 孤儿 tool 消息被丢弃', !repaired.some((m) => m.role === 'tool' && m.tool_call_id === 'ghost'));
    add('A6 无结果的 tool_calls 声明被清除',
      !repaired.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.id === 'n1')));

    const many = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    many.unshift({ role: 'system', content: 'S' });
    const ck = checkpointMessages(many);
    add('A6 检查点只保留最近 40 条（避免全量写盘）', ck.length <= 43, String(ck.length));

    add('A10 中文估算 1 字≈1 token', tokenEstimate.estimateTokens('你好世界') === 4, tokenEstimate.estimateTokens('你好世界'));
    add('A10 英文按 4 字符≈1 token', tokenEstimate.estimateTokens('abcdefgh') === 2, tokenEstimate.estimateTokens('abcdefgh'));
    add('A10 空串为 0、null 为 0',
      tokenEstimate.estimateTokens('') === 0 && tokenEstimate.estimateTokens(null) === 0);
    add('A10 消息估算含每条 overhead',
      tokenEstimate.estimateMessagesTokens([{ content: '你好' }, { content: 'hi' }]) === 2 + 4 + 1 + 4,
      tokenEstimate.estimateMessagesTokens([{ content: '你好' }, { content: 'hi' }]));

    const runnerSrc = read('runtime/agent-runner.js');
    const appSrc = read('renderer/app.js');
    add('A10 三处 /4 估算已替换为统一函数',
      !/\/ 4\)\)/.test(runnerSrc) && /estimateMessagesTokens\(messages\)/.test(runnerSrc)
      && /estimateMessagesTokens\(messages\)/.test(appSrc));
    add('A10 preload 把估算函数透传给渲染层',
      /estimateMessagesTokens/.test(read('preload.js')));
  }

  /* ── 8. A7：备份源补全 + 浏览通道 ─────────────────────────────── */
  {
    const mainSrc = read('main.js');
    const backupSrc = read('lib/backup.js');
    add('A7 备份源含会话存储与任务状态', /dsh-storage\.json/.test(mainSrc) && /'state\.json'/.test(mainSrc));
    add('A7 备份源含审计目录（目录递归复制）',
      /'audit'/.test(mainSrc) && /cpSync\(src, dstDir, \{ recursive: true/.test(backupSrc));
    add('A7 事件分片只备最近 3 天', /slice\(-3\)/.test(mainSrc) && /\\d\{4\}-\\d\{2\}-\\d\{2\}\\\.jsonl/.test(mainSrc));
    add('A7 提供 backup:list / backup:open 且做路径防穿越',
      /ipcMain\.handle\('backup:list'/.test(mainSrc) && /ipcMain\.handle\('backup:open'/.test(mainSrc)
      && /startsWith\(resolvedRoot \+ path\.sep\)/.test(mainSrc));
    add('A7 设置页有备份入口', /id="backupOpen"/.test(read('renderer/index.html')));
  }

  /* ── 9. A8 / A9 / A11 / A12：加固项 ───────────────────────────── */
  {
    const mainSrc = read('main.js');
    const appSrc = read('renderer/app.js');
    add('A8 SSE 行缓冲有上限且按流错误收尾',
      /SSE_BUFFER_LIMIT/.test(mainSrc) && /buf\.length > SSE_BUFFER_LIMIT/.test(mainSrc)
      && /仍未出现事件分隔/.test(mainSrc));
    add('A9 渲染层接入有界读取规划器',
      /planContextRead/.test(appSrc) && /planContextRead/.test(read('preload.js')));
    /* A11 复核：子代理审批**原本已有完整机制**（#delegApprovals 事件驱动 + decide 回传 +
       过期清理），审计报告写的「没有任何 UI 入口」是误判——当时只搜了 approvals.list，
       没搜 deleg。这里改为守护既有机制，防止未来被「优化」掉。 */
    add('A11 子代理审批有独立容器与事件驱动渲染',
      /delegApprovals/.test(appSrc) && /handleDelegationApprovalEvent/.test(appSrc)
      && /approval\.requested/.test(appSrc));
    add('A11 委派审批按钮回传主进程且处理过期',
      /decideDelegationApproval/.test(appSrc) && /runtime\?\.approvals\?\.decide/.test(appSrc)
      && /approval\.expired/.test(appSrc));
    add('A12 子代理退避使用可中断 sleep',
      /abortableSleep\(MODEL_RETRY_DELAY_MS \* attempt, signal\)/.test(read('runtime/agent-runner.js')));
  }

  /* ── 10. 审计事件映射（新事件能进哈希链） ─────────────────────── */
  {
    const auditSrc = read('runtime/audit.js');
    add('审计链认识 permission.changed / delegation.rollback / agent.deleted',
      /permission\.changed/.test(auditSrc) && /delegation\.rollback/.test(auditSrc) && /agent\.deleted/.test(auditSrc));
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.pass ? '' : `  → ${c.detail}`}`);
  }
  console.log(`\nR15 修复自检：${checks.length - failed.length}/${checks.length} 通过`);
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, total: checks.length }));
  process.exitCode = failed.length ? 1 : 0;
})().catch((err) => {
  console.error('[r15-check] 未捕获错误：', err);
  console.log(JSON.stringify({ passed: 0, failed: 1, total: 1, error: String(err && err.message) }));
  process.exitCode = 1;
});
