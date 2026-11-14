/* R3 渲染检查：向当前会话注入一条含代码块/列表/加粗的消息并渲染，供 --shot 截图 */
(async () => {
  const s = active();
  s.messages.push({
    role: 'assistant',
    summary: { label: '已完成', tools: 0, messages: 1 },
    tools: [], files: [], approval: null,
    body: '渲染检查：代码块、列表与行内样式。\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\n- 列表项目一\n- 列表项目二\n\n**加粗文本**、*斜体*、`行内代码` 与 [链接](https://example.com)。',
    startedAt: Date.now(), finishedAt: Date.now(),
    metrics: '0.1 秒 · 100 字 · 0 次工具',
  });
  renderChat();
  scrollToBottom(true);
  return { msgs: active().messages.length, lastBodyLen: active().messages.at(-1).body.length };
})();
