/* P1 探针（--shot 模式渲染层执行）：四个新功能逐一验证，返回 JSON。
   运行：npx electron . --user-data-dir=.s-p1 --shot --script=tools/p1-probe.js
   ① markdown 表格：完整表 → table/th/td 结构 + 转义正确；未闭合表/live 尾 → 纯文本不成表；
   ② highlightCode：js/py/bash 样例断言 token 类，且无原始 <script> 注入；未知 lang 纯文本；
   ③ 自动压缩：构造超阈值会话 → 断言折叠触发、时间线提示、API 侧摘要注入；小会话/关开关不触发；
   ④ 主题：system 档 → mock matchMedia 变化 → 断言实时切换与 seg 高亮；默认迁移 system。
   末尾按 dsh.p1shot 标志布置「表格 / 高亮代码块」两种画面，配合 --shot 连跑两次各出一张截图。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(400);
  const out = { table: {}, highlight: {}, autocompact: {}, theme: {}, visual: {} };
  const firstRun = readStorage('dsh.p1shot', 'table') === 'table';

  /* ───────── ① markdown 表格 ───────── */
  try {
    const t = markdown('| 名称 | 值 | 说明 |\n| --- | :---: | --- |\n| **加粗** | `<b>` | a \\| b |\n| 普通行 | 2 | x |\n\n后续段落');
    const thCount = (t.match(/<th>/g) || []).length + (t.match(/<th /g) || []).length;
    const tdCount = (t.match(/<td>/g) || []).length + (t.match(/<td /g) || []).length;
    out.table = {
      ok: true,
      hasWrap: t.includes('<div class="md-table-wrap"><table class="md-table">'),
      hasTheadBody: t.includes('<thead>') && t.includes('<tbody>'),
      thCount: thCount === 3,
      tdCount: tdCount === 6,
      alignCenter: t.includes('text-align:center'),
      boldRendered: t.includes('<strong>加粗</strong>'),
      inlineCodeEscaped: t.includes('<code>&lt;b&gt;</code>'), // 单元格走既有 inline()（已 esc）
      pipeEscaped: t.includes('<td>a | b</td>'),                // 单元格里的 \| 不切错列
      noRawTag: !t.includes('<b>'),
      textAfterKept: t.includes('后续段落'),
      /* 未闭合表（缺分隔行）在 stable 全量渲染下不成表 */
      incompletePlain: !markdown('| a | b |\n| 1 | 2 |').includes('<table'),
      /* live 尾一律不解析表格（稳定区推进才成表，防半表闪烁） */
      livePlain: !markdown('| a | b |\n|---|---|\n| 1 | 2 |', { live: true }).includes('<table'),
      liveTextKept: markdown('| a | b |', { live: true }).includes('| a | b |'),
    };
    out.table.ok = Object.keys(out.table).every((k) => k === 'ok' || out.table[k] === true);
  } catch (err) {
    out.table = { ok: false, error: String(err && err.message || err) };
  }

  /* ───────── ② highlightCode ───────── */
  try {
    const js = highlightCode('const n = "<script>alert(1)</script>"; // 注释\nfoo(42);', 'js');
    const py = highlightCode('def calc(n):\n    """说明"""\n    return n + 1  # 注释', 'py');
    const sh = highlightCode('echo "hi" # 注释\nif [ -n "$x" ]; then exit 0; fi', 'bash');
    const plain = highlightCode('<b>&x</b>', 'notalang');
    out.highlight = {
      ok: true,
      jsKey: js.includes('tok-key') && js.includes('>const<'),
      jsStr: js.includes('tok-str'),
      jsCom: js.includes('tok-com'),
      jsNum: js.includes('tok-num'),
      jsFn: js.includes('tok-fn') && js.includes('>foo<'),
      noScriptInject: !/<script/i.test(js),
      scriptEscaped: js.includes('&lt;script&gt;'),
      jsSingleEscape: !js.includes('&amp;'), // 只 esc 一次：不该出现 &amp;quot; 这类二次转义
      pyKey: py.includes('>def<') && py.includes('>return<'),
      pyStr: py.includes('tok-str') && py.includes('&quot;&quot;&quot;'), // esc 后三引号是 &quot; 序列
      pyCom: py.includes('tok-com'),
      pyNum: py.includes('tok-num'),
      pyFn: py.includes('>calc<'),
      shKey: sh.includes('>if<') && sh.includes('>exit<'),
      shStr: sh.includes('tok-str') && sh.includes('&quot;hi&quot;'),
      shCom: sh.includes('tok-com'),
      unknownPlain: !plain.includes('<span'),
      unknownEscaped: plain.includes('&lt;b&gt;'),
    };
    out.highlight.ok = Object.keys(out.highlight).every((k) => k === 'ok' || out.highlight[k] === true);
  } catch (err) {
    out.highlight = { ok: false, error: String(err && err.message || err) };
  }

  /* ───────── ③ 自动压缩 ───────── */
  try {
    /* 超阈值会话（不入 sessions 列表，不污染界面与持久化）：3 条 × 40 万字符 > 700000 × 90% */
    const big = { id: 'p1-compact-big', title: '压缩探针', goal: '', messages: [] };
    const chunk = 'x'.repeat(400000);
    big.messages.push({ role: 'user', text: chunk }, { role: 'assistant', body: chunk }, { role: 'user', text: chunk });
    const before = big.messages.length;
    const triggered = maybeAutoCompact(big);
    const apiMsgs = triggered ? buildApiMessages(big, '继续', null, null) : [];
    const summaryInjected = apiMsgs.some((m) => m.role === 'system' && m.content.includes('压缩摘要'));
    const note = big.messages[big.messages.length - 1];
    out.autocompact = {
      ok: true,
      triggered,
      collapsed: before === 3 && big.messages.length === 2, // 占位 + 系统提示
      placeholder: big.messages[0]?.compacted === true,
      noteText: /^上下文已自动压缩（占用 \d+%）。$/.test(note?.body || ''),
      noteIsSystemHint: note?.compacted === true, // 提示消息不回传模型
      summaryInjected,
      noPlaceholderInApi: apiMsgs.every((m) => !(m.content || '').includes('上下文已自动压缩（占用')),
      smallSkipped: maybeAutoCompact({ id: 'p1-compact-small', title: '小会话', goal: '', messages: [{ role: 'user', text: '你好' }] }) === false,
    };
    /* 开关关闭不触发（对话页 dsh.autocompact） */
    writeStorage('dsh.autocompact', 'off');
    const big2 = { id: 'p1-compact-off', title: '关开关', goal: '', messages: [{ role: 'user', text: chunk }, { role: 'assistant', body: chunk }] };
    out.autocompact.offSkipped = maybeAutoCompact(big2) === false && big2.messages.length === 2;
    writeStorage('dsh.autocompact', 'on');
    out.autocompact.ok = Object.keys(out.autocompact).every((k) => k === 'ok' || out.autocompact[k] === true);
    state.compacted.delete('p1-compact-big');
    state.compacted.delete('p1-compact-off');
  } catch (err) {
    out.autocompact = { ok: false, error: String(err && err.message || err) };
  }

  /* ───────── ④ 主题跟随系统 ───────── */
  try {
    /* 默认迁移：全新 profile 无 dsh.theme2 → 应为 system（仅首次运行断言，二跑时存储已被首跑改写） */
    const stored = localStorage.getItem('dsh.theme2');
    out.theme = {
      segButtons: [...document.querySelectorAll('#themeSeg button')].map((b) => b.dataset.theme).join(','),
      defaultMigrated: firstRun ? stored === 'system' : ['system', 'dark', 'light'].includes(stored),
      initialResolved: ['dark', 'light'].includes(document.documentElement.dataset.theme),
      storedNow: stored,
    };
    /* mock matchMedia：接管 prefersDark 的读取；change 事件派发给 boot 绑定的同一 MQL 实例
       （Chromium 每次 matchMedia() 都返回新对象，必须用 systemSchemeMql 这个实例才能命中监听） */
    const realMatchMedia = window.matchMedia.bind(window);
    if (!systemSchemeMql) throw new Error('boot 未绑定 systemSchemeMql');
    let mockDark = true;
    window.matchMedia = (q) => ({
      matches: mockDark, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    });
    applyTheme('system');
    out.theme.systemActive = state.theme === 'system'
      && document.documentElement.dataset.theme === 'dark' // mock：系统深色
      && $('#themeSeg button[data-theme="system"]').classList.contains('is-active')
      && !$('#themeSeg button[data-theme="dark"]').classList.contains('is-active');
    /* 监听实时切换：向 boot 绑定的 mql 派发 change，applyTheme 从 mock 读到新值 */
    mockDark = false;
    systemSchemeMql.dispatchEvent(new Event('change'));
    const switchToLight = document.documentElement.dataset.theme === 'light';
    mockDark = true;
    systemSchemeMql.dispatchEvent(new Event('change'));
    const switchBackDark = document.documentElement.dataset.theme === 'dark';
    out.theme.liveSwitch = switchToLight && switchBackDark;
    /* 顶栏快捷键按「生效主题」取反：dark → light */
    $('#themeBtn').click();
    out.theme.btnToggle = state.theme === 'light' && document.documentElement.dataset.theme === 'light';
    /* 三态 seg 直点：浅色 / 深色 */
    applyTheme('light');
    const lightOk = state.theme === 'light' && $('#themeSeg button[data-theme="light"]').classList.contains('is-active');
    applyTheme('dark');
    const darkOk = document.documentElement.dataset.theme === 'dark';
    out.theme.segPick = lightOk && darkOk;
    /* 还原：释放 mock，回到跟随系统 */
    window.matchMedia = realMatchMedia;
    applyTheme('system');
    out.theme.restored = state.theme === 'system' && localStorage.getItem('dsh.theme2') === 'system';
    out.theme.ok = ['defaultMigrated', 'initialResolved', 'systemActive', 'liveSwitch', 'btnToggle', 'segPick', 'restored']
      .every((k) => out.theme[k] === true);
  } catch (err) {
    out.theme = { ok: false, error: String(err && err.message || err) };
  }

  /* ───────── 画面布置：首跑出「表格消息」截图并翻页标志，次跑出「高亮代码块」截图 ───────── */
  try {
    const codeMode = !firstRun;
    const tableMsg = '| 接口 | 方法 | 说明 | 状态 |\n| --- | :---: | --- | --- |\n'
      + [...Array(24).keys()].map((i) => `| \`/api/items/${i}\` | **GET** | 获取第 ${i} 项 · 分页列表 \`<id>\` | ✅ |`).join('\n');
    const codeMsg = '下面是一个示例：\n\n```js\n// 计算斐波那契（记忆化）\nconst memo = new Map();\nfunction fib(n) {\n  if (n <= 1) return n;\n  if (memo.has(n)) return memo.get(n);\n  const v = fib(n - 1) + fib(n - 2);\n  memo.set(n, v);\n  return v;\n}\nconsole.log("fib(30) =", fib(30)); // 832040\n```\n\nBash 版本：\n\n```bash\n#!/usr/bin/env bash\n# 逐行统计\ncount=$(wc -l < "input.txt")\nif [ "$count" -gt 0 ]; then\n  echo "lines: $count"\nfi\n```';
    const s = active();
    s.title = codeMode ? 'P1 · 代码高亮' : 'P1 · 表格滚动';
    s.messages = [{ role: 'user', text: codeMode ? '给这段代码上色' : '给我一份接口清单' }];
    s.messages.push({
      role: 'assistant',
      summary: { label: '已完成', tools: 0, messages: 0 },
      tools: [], files: [], approval: null, metrics: '', compacted: false,
      body: codeMode ? codeMsg : tableMsg,
      startedAt: Date.now(), finishedAt: Date.now(),
    });
    renderChat();
    applyTheme('dark'); // 截图统一深色，便于目检 token 色与表格斑马纹
    scrollToBottom(true);
    out.visual = {
      mode: codeMode ? 'code' : 'table',
      tableInDom: codeMode ? null : {
        wraps: document.querySelectorAll('.md-table-wrap').length,
        ths: document.querySelectorAll('.md-table th').length,
        scrollable: (() => { const w = document.querySelector('.md-table-wrap'); return !!w && (w.scrollHeight > w.clientHeight || w.scrollWidth > w.clientWidth); })(),
      },
      highlightInDom: codeMode ? {
        pre: document.querySelectorAll('.prose pre').length,
        tokens: document.querySelectorAll('.prose .tok-key, .prose .tok-str, .prose .tok-com, .prose .tok-num, .prose .tok-fn').length,
      } : null,
    };
    writeStorage('dsh.p1shot', codeMode ? 'table' : 'code'); // 跑完一轮翻回，两轮可重复
  } catch (err) {
    out.visual = { error: String(err && err.message || err) };
  }

  out.allOk = out.table.ok && out.highlight.ok && out.autocompact.ok && out.theme.ok && !out.visual.error;
  return out;
})();
