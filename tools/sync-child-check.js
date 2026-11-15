'use strict';

/* 「边做边同步」静态自检（纯 Node，不需要 Electron）：覆盖主聊天与子代理两条提示链。
 *
 *   ① 子代理 buildMessages 必带同步规则，自定义 systemPrompt 也不能绕过
 *   ② 提醒是「请求时临时附加」：不写回 messages，检查点/委派结果都不含它
 *   ③ 主聊天与子代理阈值一致（同一套节奏），提醒都不进正文/历史
 *   ④ 占位叙述行降级为 ui-status，不算模型发言
 *
 * 运行：node tools/sync-child-check.js
 */
const fs = require('node:fs');
const path = require('node:path');
const runner = require('../runtime/agent-runner');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const checks = [];
const add = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail: String(detail) });

const appSrc = read('renderer/app.js');
const childSrc = read('runtime/agent-runner.js');
const cssSrc = read('renderer/styles.css');

/* ① 子代理提示 */
const baseDelegation = {
  objective: '核对目录结构',
  expectedOutput: '简短结论',
  contextRefPaths: [],
  effectiveProfile: 'read',
  workspace: ROOT,
};
const built = runner.buildMessages(baseDelegation, null, ROOT, 'read');
const builtText = built.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
add('child.hasSyncRule', /边做边同步|关键节点/.test(builtText) && /当前在做什么|刚完成什么/.test(builtText));
add('child.notMechanical', /不机械绑定每次工具调用/.test(builtText));
add('child.autoContinue', /步骤自动连续|不要长时间连续操作/.test(builtText));
add('child.concise', /精炼不重复|不闲聊/.test(builtText));

/* 自定义 systemPrompt 覆盖默认提示时，规则仍在（放在必带的第二条 system 里） */
const custom = runner.buildMessages({ ...baseDelegation }, { systemPrompt: '你是完全自定义的子 Agent，只做这一件事。' }, ROOT, 'read');
const customText = custom.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
add('child.customPromptKeepsRule', /关键节点/.test(customText) && /不机械绑定每次工具调用/.test(customText));
add('child.customPromptRespected', customText.includes('你是完全自定义的子 Agent'));

/* ② 提醒不写回常驻消息流 */
add('child.nudgeIsRequestOnly', /const requestMessages = silentSteps >= SILENT_NUDGE_AT/.test(childSrc)
  && /messages: requestMessages/.test(childSrc)
  && !/messages\.push\(\s*\{\s*role: 'system', content: CHILD_SYNC_NUDGE/.test(childSrc));
add('child.checkpointUsesOriginalMessages', /checkpointMessages\(messages\)/.test(childSrc)
  && !/checkpointMessages\(requestMessages\)/.test(childSrc));
add('child.nudgeNotInFinalText', !/finalText\s*=\s*CHILD_SYNC_NUDGE/.test(childSrc));

/* ③ 两处阈值一致、提醒一次性 */
const appAt = Number((appSrc.match(/const SILENT_NUDGE_AT = (\d+)/) || [])[1]);
const childAt = Number((childSrc.match(/const SILENT_NUDGE_AT = (\d+)/) || [])[1]);
add('threshold.consistent', appAt >= 2 && childAt >= 2 && appAt === childAt, `app=${appAt} child=${childAt}`);
add('app.nudgeDroppedEachStep', /dropSilentNudge\(\);/.test(appSrc)
  && /__silentNudge: true/.test(appSrc));
add('app.nudgeNotInHistory', /不写会话历史|不写 session\.messages/.test(appSrc));
add('app.nudgeNotInBody', !/body\s*\+=\s*.*进展同步提醒/.test(appSrc));

/* ④ 占位降级 */
add('ui.statusRole', /line\.dataset\.role = 'ui-status'/.test(appSrc)
  && /不是模型的发言/.test(appSrc));
add('ui.statusDeemphasized', /\.tool-narrate\s*\{[\s\S]{0,300}opacity:\s*\.8/.test(cssSrc)
  && /界面状态占位（非模型发言）/.test(cssSrc));
add('ui.yieldsToModel', /spokenAfterStart/.test(appSrc) && /silent/.test(appSrc));

const passed = checks.filter((c) => c.pass).length;
console.log(`边做边同步静态自检：${passed}/${checks.length} 通过`);
for (const c of checks) if (!c.pass) console.log('  FAIL', c.name, '::', c.detail);
console.log(JSON.stringify({ passed, failed: checks.length - passed, total: checks.length }));
process.exit(passed === checks.length ? 0 : 1);
