/* 演示数据 —— 结构与 dsh_client 的 Transcript 投影对齐：
   user 气泡 / 回合摘要 / 工具行 / 正文 / 交付文件 / 统计。 */

window.DEMO = {
  sessions: [
    {
      id: 's1',
      title: '10 月花销表',
      group: '今天',
      model: 'V4 Pro',
      state: 'running',
      filter: ['running'],
      messages: [
        { role: 'user', text: '把这个月的花销做成表和图，按类别汇总。' },
        {
          role: 'assistant',
          summary: { label: '已完成', tools: 3, messages: 1 },
          tools: [
            { verb: '读取', target: '账单-10月.csv', tone: 'read', icon: 'i-read', meta: '218 行' },
            { verb: '运行', target: 'python3 summarize.py', tone: 'terminal', icon: 'i-terminal', meta: '0:06' },
            { verb: '运行', target: 'python3 make_chart.py', tone: 'terminal', icon: 'i-terminal', meta: '0:12' },
          ],
          body:
            '做好了。10 月一共花了 **¥6,842**：\n\n' +
            '- 房租 **¥3,200**，占 46.8%\n' +
            '- 餐饮 **¥1,486**，比 9 月多 12%\n' +
            '- 交通 **¥612**，以通勤为主\n\n' +
            '表格和每日趋势图都在下面，点开就能看。',
          files: [
            { name: '10月花销表.xlsx', meta: '按类别汇总 · 3 个工作表', kind: 'xlsx', icon: 'i-sheet' },
            { name: '10月花销趋势.png', meta: '每日累计花销', kind: 'png', icon: 'i-image' },
          ],
          metrics: '23 秒 · 4 步 · 3.4万 tokens',
        },
      ],
    },
    {
      id: 's2',
      title: '周末去杭州的两天行程',
      group: '今天',
      model: 'V4 Pro',
      state: 'idle',
      filter: [],
      messages: [
        { role: 'user', text: '周末去杭州两天，帮我把行程排一下，别太赶。' },
        {
          role: 'assistant',
          summary: { label: '已完成', tools: 2, messages: 1 },
          tools: [
            { verb: '联网', target: '杭州 周末 天气', tone: 'web', icon: 'i-globe', meta: '3 条' },
            { verb: '联网', target: '西湖 周边 步行路线', tone: 'web', icon: 'i-globe', meta: '5 条' },
          ],
          body:
            '按「一天一个片区、少折返」来排，周六晴 18–24℃，周日有小雨，把室内的放在第二天下午。\n\n' +
            '**Day 1 · 西湖西线**\n' +
            '- 09:30 龙井村喝茶，走一段茶园\n' +
            '- 12:00 茅家埠吃饭，人比断桥少很多\n' +
            '- 15:00 苏堤慢走到花港观鱼\n' +
            '- 晚上住南山路，散步到音乐喷泉\n\n' +
            '**Day 2 · 运河 + 室内**\n' +
            '- 09:30 小河直街早饭\n' +
            '- 11:00 桥西历史街区\n' +
            '- 14:00 浙江省博物馆（之江馆），下雨正好\n' +
            '- 17:30 返程',
          metrics: '18 秒 · 3 步 · 2.1万 tokens',
        },
      ],
    },
    {
      id: 's3',
      title: '帮我比较两个房贷方案',
      group: '今天',
      model: 'V4 Pro',
      state: 'idle',
      filter: [],
      messages: [
        { role: 'user', text: '帮我比较两个房贷方案：A 是 3.9% 30 年，B 是 3.4% 但要 20% 首付。' },
        {
          role: 'assistant',
          summary: { label: '已完成', tools: 1, messages: 1 },
          tools: [{ verb: '运行', target: 'python3 mortgage.py --a 3.9 --b 3.4', tone: 'terminal', icon: 'i-terminal', meta: '0:03' }],
          body:
            '按 300 万总价、等额本息算，差异主要不在月供，在首付门槛和总利息：\n\n' +
            '- **A（3.9%，30%）**：首付 90 万，月供约 ¥9,913，总利息约 ¥117 万\n' +
            '- **B（3.4%，20%）**：首付 60 万，月供约 ¥10,643，总利息约 ¥113 万\n\n' +
            'B 少掏 30 万首付、总利息反而少 4 万，但月供多 730 元。**现金流紧就选 B**，' +
            '前提是那 30 万没有被更高收益的用途占着。',
          metrics: '12 秒 · 2 步 · 1.6万 tokens',
        },
      ],
    },
    {
      id: 's4',
      title: '把会议录音整理成纪要',
      group: '昨天',
      model: 'V4 Flash',
      state: 'idle',
      filter: [],
      messages: [
        { role: 'user', text: '把会议录音整理成纪要，重点标一下谁负责什么。' },
        {
          role: 'assistant',
          summary: { label: '已完成', tools: 2, messages: 1 },
          tools: [
            { verb: '读取', target: '周会-1109.m4a', tone: 'read', icon: 'i-read', meta: '42 分钟' },
            { verb: '运行', target: 'python3 transcribe.py --diarize', tone: 'terminal', icon: 'i-terminal', meta: '1:08' },
          ],
          body:
            '**结论**：Q4 只保留两个主线，其余需求排到明年 1 月。\n\n' +
            '- 老张：11/15 前给出灰度名单\n' +
            '- 小林：11/12 前补完埋点，缺的那三个事件先手工对\n' +
            '- 我：11/20 前把预算表交上去\n\n' +
            '**待定**：是否砍掉社区板块，下周三再议。',
          files: [{ name: '周会纪要-1109.md', meta: '含发言人标注', kind: 'md', icon: 'i-file' }],
          metrics: '1 分 14 秒 · 2 步 · 5.8万 tokens',
        },
      ],
    },
    {
      id: 's5',
      title: '修复登录按钮重复提交',
      group: '昨天',
      model: 'V4 Pro',
      state: 'idle',
      filter: [],
      messages: [
        { role: 'user', text: '登录按钮连点会发两次请求，帮我修掉。' },
        {
          role: 'assistant',
          summary: { label: '已完成', tools: 3, messages: 1 },
          tools: [
            { verb: '搜索', target: 'grep -rn "onPressed" lib/auth', tone: 'search', icon: 'i-search', meta: '7 处' },
            { verb: '读取', target: 'auth/login_form.dart', tone: 'read', icon: 'i-read', meta: '164 行' },
            { verb: '编辑', target: 'auth/login_form.dart', tone: 'edit', icon: 'i-code', meta: '+9 −2' },
          ],
          body:
            '原因是 `onPressed` 里没有拦住重入，请求在 await 期间按钮仍然可点。\n\n' +
            '改成先置 `_submitting = true` 再 await，`finally` 里复位；同时在按钮上加 `onPressed: _submitting ? null : _submit`。' +
            '这样连点在 UI 层就被吞掉了，不依赖后端幂等。',
          metrics: '31 秒 · 4 步 · 4.2万 tokens',
        },
      ],
    },
    {
      id: 's6',
      title: '给周报加一页图表',
      group: '本周',
      model: 'V4 Pro',
      state: 'pending',
      filter: ['pending'],
      messages: [
        { role: 'user', text: '周报里加一页图表，把这三个月的活跃和留存放一起。' },
        {
          role: 'assistant',
          summary: { label: '等待确认', tools: 1, messages: 0 },
          tools: [{ verb: '运行', target: 'python3 build_deck.py --slide 4', tone: 'terminal', icon: 'i-terminal', meta: '待批准' }],
          approval: {
            title: '需要你确认这一步',
            text: '这会覆盖 周报-第38周.pptx 的第 4 页，原内容会被替换。',
            command: 'python3 build_deck.py --slide 4 --inplace',
          },
          body: '图表脚本已经写好了，但会原地改文件，先等你点头。',
          metrics: '6 秒 · 1 步 · 3,200 tokens',
        },
      ],
    },
    {
      id: 's7',
      title: '把 README 翻译成英文',
      group: '本周',
      model: 'V4 Flash',
      state: 'idle',
      filter: [],
      messages: [
        { role: 'user', text: '把 README 翻成英文，技术名词保留原文。' },
        {
          role: 'assistant',
          summary: { label: '已完成', tools: 2, messages: 1 },
          tools: [
            { verb: '读取', target: 'README.md', tone: 'read', icon: 'i-read', meta: '412 行' },
            { verb: '写入', target: 'README.en.md', tone: 'edit', icon: 'i-code', meta: '+418' },
          ],
          body: '翻好了，写在 `README.en.md`，原文件没动。代码块、命令、专有名词（proot / rootfs / mux）都保持原样。',
          files: [{ name: 'README.en.md', meta: '418 行 · 与中文版对齐', kind: 'md', icon: 'i-file' }],
          metrics: '48 秒 · 3 步 · 6.1万 tokens',
        },
      ],
    },
    {
      id: 's8',
      title: '整理这周的读书笔记',
      group: '更早',
      model: 'V4 Pro',
      state: 'idle',
      filter: [],
      messages: [
        { role: 'user', text: '把这周随手记的读书笔记归一下类，重复的合并。' },
        {
          role: 'assistant',
          summary: { label: '已完成', tools: 2, messages: 1 },
          tools: [
            { verb: '搜索', target: 'glob notes/**/*.md', tone: 'search', icon: 'i-search', meta: '23 篇' },
            { verb: '编辑', target: 'notes/索引.md', tone: 'edit', icon: 'i-code', meta: '+31 −4' },
          ],
          body:
            '归成四类：**产品**、**工程**、**组织**、**杂项**。合并了 6 条重复摘录，' +
            '其中 3 条其实是同一篇的两个版本，保留了后写的那个。索引在 `notes/索引.md`。',
          metrics: '27 秒 · 3 步 · 2.9万 tokens',
        },
      ],
    },
  ],

  /* 回复脚本：按关键词挑一条，演示流式输出、工具行、审批与交付 */
  scripts: [
    {
      match: /图|表|数据|报表|chart|excel/i,
      tools: [
        { verb: '读取', target: '账单-10月.csv', tone: 'read', icon: 'i-read', meta: '218 行' },
        { verb: '运行', target: 'python3 summarize.py', tone: 'terminal', icon: 'i-terminal', meta: '0:05' },
        { verb: '运行', target: 'python3 make_chart.py', tone: 'terminal', icon: 'i-terminal', meta: '0:11' },
      ],
      body:
        '做好了。这个月一共 **¥6,842**，比 9 月多 9%：\n\n' +
        '- 房租 **¥3,200**，占 46.8%\n' +
        '- 餐饮 **¥1,486**，涨幅主要在外卖\n' +
        '- 交通 **¥612**，以通勤为主\n\n' +
        '表格和图都在下面，点开可以直接看。',
      files: [
        { name: '本月汇总.xlsx', meta: '按类别 · 3 个工作表', kind: 'xlsx', icon: 'i-sheet' },
        { name: '本月趋势.png', meta: '每日累计', kind: 'png', icon: 'i-image' },
      ],
      metrics: '21 秒 · 4 步 · 3.1万 tokens',
    },
    {
      match: /删除|清理|rm |drop|覆盖/i,
      tools: [
        { verb: '搜索', target: 'glob build/**/*.tmp', tone: 'search', icon: 'i-search', meta: '184 个' },
      ],
      approval: {
        title: '这一步会删东西，先确认',
        text: '匹配到 184 个文件，共 2.3 GB，都在 build/ 下。删除后不进回收站。',
        command: 'find build -name "*.tmp" -delete',
      },
      body: '文件清单在上面，确认之后我再动手。也可以只删 30 天前的，你说一声。',
      metrics: '5 秒 · 1 步 · 1,800 tokens',
    },
    {
      match: /.*/,
      tools: [
        { verb: '搜索', target: 'grep -rn "相关上下文" .', tone: 'search', icon: 'i-search', meta: '12 处' },
        { verb: '读取', target: 'README.md', tone: 'read', icon: 'i-read', meta: '412 行' },
      ],
      body:
        '我看了下现有实现，先说结论：这件事可以拆成**三层**来做。\n\n' +
        '1. 协议层不动，沿用现在的 `session/watch` 双序列，断线补页的逻辑已经够用\n' +
        '2. 状态层把 `send()` 的四种语义收拢到一个入口，避免 now / steer 走岔\n' +
        '3. UI 层只做投影，不要在 widget 里算业务\n\n' +
        '需要我直接把第二层的改动写出来吗？',
      metrics: '14 秒 · 3 步 · 2.4万 tokens',
    },
  ],
};
