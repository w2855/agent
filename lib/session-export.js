'use strict';

/* ─────────────────────────────────────────────
   会话导出序列化（纯函数，不依赖 Electron，可单独跑 node 测试）

   渲染层把当前会话（state.sessions 里的对象）交给本模块序列化：
   1) serializeSessionMd：Markdown 文本 —— `# 标题` + 每条消息
      `## 用户` / `## 助手` + 正文 + 工具调用清单简表（含结果摘要）。
   2) serializeSessionJson：JSON 文本 —— { title, createdAt, messages }，
      messages 里 tools / approval / usage 等字段原样保留，方便程序化回放。

   输入不合法时返回空串，调用方据此提示「序列化失败」，绝不抛错。
   ───────────────────────────────────────────── */

/** 工具调用简表里每个结果最多带这么多字符，防止几十 KB 的命令输出撑爆文档。 */
const TOOL_RESULT_PREVIEW_CHARS = 300;

/** 单条工具调用 → 一行简表；没有结果的调用只列名字与目标。 */
function toolLine(t) {
  if (!t || typeof t !== 'object') return null;
  const name = typeof t.name === 'string' && t.name ? t.name : '未知工具';
  const target = typeof t.target === 'string' ? t.target.replace(/\s+/g, ' ').trim() : '';
  const parts = [name];
  if (target && target !== '（无参数）') parts.push(target);
  const status = typeof t.status === 'string' && t.status && t.status !== 'ok' ? `（${t.status}）` : '';
  const result = typeof t.result === 'string' && t.result.trim()
    ? t.result.replace(/\s+/g, ' ').trim().slice(0, TOOL_RESULT_PREVIEW_CHARS)
    : (typeof t.error === 'string' && t.error.trim() ? t.error.replace(/\s+/g, ' ').trim().slice(0, TOOL_RESULT_PREVIEW_CHARS) : '');
  const head = `- ${parts.join(' · ')}${status}`;
  return result ? `${head}：${result}` : head;
}

/** 单条消息 → Markdown 段落；识别不了的角色返回 null（跳过不写）。 */
function messageToMd(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.role === 'user') {
    const text = typeof m.text === 'string' && m.text ? m.text
      : (typeof m.content === 'string' ? m.content : '');
    return `## 用户\n\n${text.trim() || '（无正文）'}`;
  }
  if (m.role === 'assistant') {
    const body = typeof m.body === 'string' && m.body.trim() ? m.body.trim()
      : (typeof m.content === 'string' && m.content.trim() ? m.content.trim() : '（无正文）');
    const segments = [`## 助手\n\n${body}`];
    const tools = Array.isArray(m.tools) ? m.tools.map(toolLine).filter(Boolean) : [];
    if (tools.length) segments.push(`**工具调用（${tools.length} 次）**\n\n${tools.join('\n')}`);
    if (typeof m.error === 'string' && m.error.trim()) segments.push(`**调用失败**：${m.error.trim().slice(0, 200)}`);
    return segments.join('\n\n');
  }
  return null;
}

/** 会话 → Markdown 文本；非法输入返回空串。 */
function serializeSessionMd(session) {
  if (!session || typeof session !== 'object' || !Array.isArray(session.messages)) return '';
  const title = typeof session.title === 'string' && session.title.trim() ? session.title.trim() : '会话';
  const blocks = [`# ${title}`, ''];
  for (const m of session.messages) {
    const seg = messageToMd(m);
    if (seg) blocks.push(seg, '');
  }
  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** 会话第一条消息上的 startedAt（毫秒时间戳），取不到返回 null。 */
function sessionCreatedAt(session) {
  if (!session || typeof session !== 'object') return null;
  for (const m of Array.isArray(session.messages) ? session.messages : []) {
    const at = Number(m && m.startedAt);
    if (Number.isFinite(at) && at > 0) return at;
    const created = Number(m && m.createdAt);
    if (Number.isFinite(created) && created > 0) return created;
  }
  return null;
}

/** 会话 → JSON 文本（{ title, createdAt, messages }，消息字段原样保留）；非法输入返回空串。 */
function serializeSessionJson(session) {
  if (!session || typeof session !== 'object' || !Array.isArray(session.messages)) return '';
  const title = typeof session.title === 'string' && session.title.trim() ? session.title.trim() : '会话';
  const payload = {
    title,
    createdAt: sessionCreatedAt(session),
    messages: session.messages.filter((m) => m && typeof m === 'object'),
  };
  try { return JSON.stringify(payload, null, 2) + '\n'; } catch { return ''; }
}

module.exports = {
  TOOL_RESULT_PREVIEW_CHARS,
  messageToMd,
  sessionCreatedAt,
  serializeSessionMd,
  serializeSessionJson,
};
