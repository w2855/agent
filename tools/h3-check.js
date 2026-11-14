'use strict';

/* 自检：系统通知去重（lib/notify-dedupe.js）与会话导出序列化（lib/session-export.js）纯函数。
   运行：node tools/h3-check.js */

const notifyDedupe = require('../lib/notify-dedupe');
const sessionExport = require('../lib/session-export');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

(async () => {
  /* ───────── 1. 通知去重键（tag） ───────── */
  const dd = notifyDedupe.createNotifyDedupe();
  add('窗口常量为 30 秒', notifyDedupe.NOTIFY_DEDUPE_WINDOW_MS === 30 * 1000, notifyDedupe.NOTIFY_DEDUPE_WINDOW_MS);
  add('相同 tag 首次应发', dd.shouldSend('turn-m1', 0) === true, 'ok');
  add('相同 tag 窗口内第二次被吞', dd.shouldSend('turn-m1', 1000) === false && dd.shouldSend('turn-m1', 29999) === false, 'ok');
  add('相同 tag 过窗口后再次应发', dd.shouldSend('turn-m1', 30000) === true, 'ok');
  const t0 = 1000;
  add('不同 tag 互不影响', dd.shouldSend('turn-m2', t0) === true && dd.shouldSend('approval-m1', t0) === true, 'ok');
  add('去重器记录的是发送时刻（窗口自首次发送起算）', dd.shouldSend('turn-m2', t0 + notifyDedupe.NOTIFY_DEDUPE_WINDOW_MS - 1) === false, 'ok');
  add('tag 去首尾空白后仍算同一键', dd.reset() === undefined && dd.shouldSend(' turn-m3 ', t0) === true && dd.shouldSend('turn-m3', t0 + 1) === false, 'ok');
  add('空 tag 不去重（每次都发）', dd.shouldSend('', t0) === true && dd.shouldSend('', t0 + 1) === true, 'ok');
  add('非字符串 tag 不去重不抛错', dd.shouldSend(null, t0) === true && dd.shouldSend(42, t0) === true, 'ok');
  add('非法时间戳视为不在窗口内', (() => {
    const d = notifyDedupe.createNotifyDedupe();
    return d.shouldSend('k', NaN) === true && d.shouldSend('k', 'not-a-number') === true;
  })(), 'ok');
  add('withinWindow 边界：恰好等于窗口长不算在内', notifyDedupe.withinWindow(1000, 1000 + notifyDedupe.NOTIFY_DEDUPE_WINDOW_MS, notifyDedupe.NOTIFY_DEDUPE_WINDOW_MS) === false
    && notifyDedupe.withinWindow(1000, 1000 + notifyDedupe.NOTIFY_DEDUPE_WINDOW_MS - 1, notifyDedupe.NOTIFY_DEDUPE_WINDOW_MS) === true
    && notifyDedupe.withinWindow(1000, 999, notifyDedupe.NOTIFY_DEDUPE_WINDOW_MS) === false, 'ok');
  add('自定义窗口宽度生效', (() => {
    const d = notifyDedupe.createNotifyDedupe(5000);
    return d.shouldSend('k', 0) === true && d.shouldSend('k', 4000) === false && d.shouldSend('k', 5000) === true;
  })(), 'ok');

  /* ───────── 2. 会话导出：Markdown ───────── */
  const session = {
    id: 'm-1', title: '排查构建失败', group: '今天', state: 'idle', filter: [],
    messages: [
      { role: 'user', text: '构建为什么失败？', attachments: [{ name: 'log.txt', error: '' }] },
      {
        role: 'assistant',
        summary: { label: '已完成', tools: 2, messages: 1 },
        body: '缺了一行 `npm ci`，补上即可。\n\n详见下表。',
        tools: [
          { id: 't1', name: 'run_command', verb: '命令', target: 'npm test', status: 'ok', result: '3 passed (300 chars of output…)' },
          { id: 't2', name: 'read_file', verb: '读取', target: 'package.json', status: 'denied', error: '用户拒绝执行' },
        ],
        approval: { title: '需要你确认这一步', text: '模型请求执行', command: 'npm test', outcome: 'once', label: '已允许一次' },
        startedAt: 1700000000000, finishedAt: 1700000006500, error: '', usage: { total_tokens: 512 },
      },
    ],
  };
  const md = sessionExport.serializeSessionMd(session);
  add('md 以 `# 标题` 开头', md.startsWith('# 排查构建失败'), md.slice(0, 24));
  add('md 含 `## 用户` 段与正文', md.includes('## 用户') && md.includes('构建为什么失败？'), 'ok');
  add('md 含 `## 助手` 段与正文', md.includes('## 助手') && md.includes('npm ci'), 'ok');
  add('md 含工具调用简表（次数 + 名称 + 目标）', md.includes('**工具调用（2 次）**') && md.includes('run_command · npm test') && md.includes('read_file · package.json'), md.match(/\*\*工具调用.*\n[\s\S]*$/)?.[0] ?? '');
  add('md 带结果摘要与状态', md.includes('3 passed') && md.includes('（denied）') && md.includes('用户拒绝执行'), 'ok');
  add('md 不含 JSON 内部字段（如 summary/usage 原样对象）', !md.includes('"total_tokens"'), 'ok');
  add('md 结尾有换行', md.endsWith('\n'), JSON.stringify(md.slice(-6)));

  /* md 边界：空会话 / 非法输入 */
  add('空会话只产出标题', sessionExport.serializeSessionMd({ title: '新对话', messages: [] }) === '# 新对话\n', JSON.stringify(sessionExport.serializeSessionMd({ title: '新对话', messages: [] })));
  add('messages 缺失返回空串', sessionExport.serializeSessionMd({ title: 'x' }) === '' && sessionExport.serializeSessionMd(null) === '' && sessionExport.serializeSessionMd(undefined) === '', 'ok');
  add('标题为空回退「会话」', sessionExport.serializeSessionMd({ messages: [] }).startsWith('# 会话'), 'ok');
  add('未知角色跳过不抛错', !sessionExport.serializeSessionMd({ title: 'x', messages: [{ role: 'system', content: '内部指令' }] }).includes('内部指令'), 'ok');
  add('无标题消息（user.content 回退）正常导出', sessionExport.serializeSessionMd({ title: 't', messages: [{ role: 'user', content: '按 content 字段导出' }] }).includes('按 content 字段导出'), 'ok');

  /* ───────── 3. 会话导出：JSON ───────── */
  const json = sessionExport.serializeSessionJson(session);
  let parsed = null;
  try { parsed = JSON.parse(json); } catch { parsed = null; }
  add('json 可被 JSON.parse 解析', parsed !== null, 'ok');
  add('json 顶层为 { title, createdAt, messages }', !!parsed && parsed.title === '排查构建失败' && Array.isArray(parsed.messages) && Object.keys(parsed).length === 3, JSON.stringify(parsed && Object.keys(parsed)));
  add('createdAt 取首条消息 startedAt', parsed && parsed.createdAt === 1700000000000, parsed && parsed.createdAt);
  add('messages 字段原样保留（tools/approval/usage）', !!parsed
    && parsed.messages[1].tools.length === 2
    && parsed.messages[1].approval.command === 'npm test'
    && parsed.messages[1].usage.total_tokens === 512, 'ok');
  add('user 消息 text 原样保留', !!parsed && parsed.messages[0].text === '构建为什么失败？' && Array.isArray(parsed.messages[0].attachments), 'ok');
  add('createdAt 缺失时为 null', JSON.parse(sessionExport.serializeSessionJson({ title: 't', messages: [{ role: 'user', text: 'hi' }] })).createdAt === null, 'ok');
  add('非法输入返回空串', sessionExport.serializeSessionJson(null) === '' && sessionExport.serializeSessionJson({}) === '', 'ok');

  const result = { checks, total: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.failed ? 1 : 0);
})().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
