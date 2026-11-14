/* 场景探针 chat-content：注入一条含 GFM 表格 + 代码块 + 列表/行内样式的示例消息
   （r3-shot 方式），验证 P1 表格渲染与语法高亮的实际视觉效果。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const s = active();
  const body = [
    '验收样例：表格与代码块渲染。',
    '',
    '| 模块 | 状态 | 说明 |',
    '| --- | --- | --- |',
    '| 表格渲染 | 已完成 | 流式不解析防半表 |',
    '| 语法高亮 | 已完成 | 单遍 tokenizer 七语言 |',
    '| 上下文压缩 | 已完成 | 90% 阈值自动触发 |',
    '',
    '```js',
    'function greet(name) {',
    "  const msg = `你好，${name}`;",
    '  console.log(msg); // 行内注释',
    '  return { ok: true, msg };',
    '}',
    'greet("shot-suite");',
    '```',
    '',
    '- 列表项目一',
    '- 列表项目二',
    '',
    '**加粗**、*斜体*、`行内代码` 与 [链接](https://example.com)。',
  ].join('\n');
  s.messages.push({
    role: 'assistant',
    summary: { label: '已完成', tools: 0, messages: 1 },
    tools: [], files: [], approval: null,
    body,
    startedAt: Date.now(), finishedAt: Date.now(),
    metrics: '0.1 秒 · 320 字 · 0 次工具',
  });
  renderChat();
  scrollToBottom(true);
  // 视图守卫：并行 GUI 误触可能打开设置/菜单——截图窗口期内保持聊天视图
  const guard = setInterval(() => {
    if (!$('#settingsPage').hidden) closeSettings();
    hideMenus();
  }, 300);
  setTimeout(() => clearInterval(guard), 3000);
  await sleep(200);
  return {
    ok: true,
    note: '示例消息：表格 + 代码块 + 列表',
    msgs: s.messages.length,
    tableRendered: !!document.querySelector('.md-table'),
    codeRendered: !!document.querySelector('pre code, .hljs, [class*="hl-"]'),
  };
})();
