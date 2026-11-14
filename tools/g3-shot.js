/* G3 视觉检查：向会话注入两条消息，打开查找条并显示选区菜单，供 --shot 截图目检样式 */
(async () => {
  const s = active();
  s.messages = [{
    role: 'user',
    text: '萤火虫为什么会发光？',
  }, {
    role: 'assistant',
    summary: { label: '已完成', tools: 0, messages: 1 },
    tools: [], files: [], approval: null,
    body: '萤火虫通过荧光素发光。\n\n- 萤火虫的发光是冷光\n- 每只萤火虫的节奏不同\n\n```js\nconst x = 1;\n```\n\n**萤火虫**在夏夜成群飞舞。',
    startedAt: Date.now(), finishedAt: Date.now(),
    metrics: '0.1 秒 · 60 字 · 0 次工具',
  }];
  renderChat();
  scrollToBottom(true);

  // 打开查找条并命中关键词：验证查找条浮层与 ::highlight 正文高亮
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
  $('#findInput').value = '萤火虫';
  $('#findInput').dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));

  // 选区菜单：直接程序化选区走真实 selectionchange 路径
  const bubble = $('#chat .msg.user .bubble');
  const range = document.createRange();
  range.selectNodeContents(bubble);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  await new Promise((r) => setTimeout(r, 300));
  return { msgs: active().messages.length, count: $('#findCount')?.textContent, menuShown: !$('#selectionMenu').hidden };
})();
