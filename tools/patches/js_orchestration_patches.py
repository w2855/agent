# -*- coding: utf-8 -*-
"""JS 编排补丁（app.js 锚点式）· Emil 动效重做包第 4 项
由 apply-anim.py 读取并按锚点应用；每个补丁 = 精确旧文本 + 新文本。
旧文本必须与 app.js 逐字节匹配（缩进/反引号一致），否则报 miss 不落盘。

⚠ 依赖标注（G5 = 会话级并行改造，另一代理正在编辑 renderer/app.js）：
  - P2/P3/P4 触及 deleteSession / renderSessions / paint —— G5 并行改造区，
    请在 G5 落地之后应用；apply-anim.py 会先校验锚点存在，锚点漂移即拒绝。
  - P1/P5 为纯新增/局部插入，与 G5 无结构性冲突。
"""

PATCHES = [
    # ── P1 · 列表项删除的 Enter/Exit 配对：退场幽灵辅助函数 ──
    # 插入在 hideMenus 之前（animateOut 同族工具函数区）。
    # 用途：prevent jarring change + spatial consistency —— 原件立即离开
    # 布局（兄弟元素先合拢，不用 height 动画），克隆体 fixed 定位在原位
    # 只播 160ms 收束淡出。与 motion-system.css 的 .list-exit-ghost 配套。
    {
        "name": "P1-spawnListGhost-helper",
        "depends_g5": False,
        "anchor": "function hideMenus() { $$('.menu').forEach((m) => animateOut(m, 130)); }",
        "replacement": (
            "/* 列表项删除的退场幽灵（Enter/Exit 配对）：原件立即离开布局，兄弟元素先合拢；\n"
            "   克隆体 fixed 在原位只播淡出 —— 不用 height 动画，不触发二次重排链 */\n"
            "function spawnListGhost(el, ms = 160) {\n"
            "  if (!el || !el.isConnected) return;\n"
            "  const r = el.getBoundingClientRect();\n"
            "  if (!r.width || !r.height) return;\n"
            "  const ghost = el.cloneNode(true);\n"
            "  ghost.classList.add('list-exit-ghost');\n"
            "  ghost.classList.remove('is-enter', 'is-new', 'is-dragging');\n"
            "  ghost.style.left = r.left + 'px';\n"
            "  ghost.style.top = r.top + 'px';\n"
            "  ghost.style.width = r.width + 'px';\n"
            "  ghost.style.height = r.height + 'px';\n"
            "  document.body.appendChild(ghost);\n"
            "  setTimeout(() => ghost.remove(), ms);\n"
            "}\n\n"
            "function hideMenus() { $$('.menu').forEach((m) => animateOut(m, 130)); }"
        ),
    },
    # ── P2 · todo 删除：重渲染前捕获行 → 重渲染后播退场幽灵 ──
    {
        "name": "P2-todoDelete-exit-pairing",
        "depends_g5": False,
        "anchor": (
            "  clearTimeout(todoUi.armedTimer);\n"
            "  todoUi.armed = -1;\n"
            "  todoUi.armedRef = null;\n"
            "  const removed = tasks.splice(i, 1)[0];"
        ),
        "replacement": (
            "  clearTimeout(todoUi.armedTimer);\n"
            "  todoUi.armed = -1;\n"
            "  todoUi.armedRef = null;\n"
            "  const rowEl = $('#todoPanelBody .todo-item[data-idx=\"' + i + '\"]');\n"
            "  const removed = tasks.splice(i, 1)[0];"
        ),
    },
    {
        "name": "P2-todoDelete-spawn-ghost",
        "depends_g5": False,
        "anchor": (
            "  const removed = tasks.splice(i, 1)[0];\n"
            "  noteTodoChange(`删除任务「${todoCut(removed?.content)}」`);\n"
            "  saveSessions();\n"
            "  renderTodoPanel();\n"
            "}"
        ),
        "replacement": (
            "  const removed = tasks.splice(i, 1)[0];\n"
            "  noteTodoChange(`删除任务「${todoCut(removed?.content)}」`);\n"
            "  saveSessions();\n"
            "  renderTodoPanel();\n"
            "  spawnListGhost(rowEl); // 退场幽灵：兄弟行合拢的同时旧行淡出\n"
            "}"
        ),
    },
    # ── P3 · 会话删除：同款 Enter/Exit 配对 ──
    # ⚠ G5 依赖：deleteSession/renderSessions 属会话并行改造区。
    {
        "name": "P3-deleteSession-capture-row",
        "depends_g5": True,
        "anchor": (
            "  deleteArmed.delete(id);\n"
            "  state.sessions = state.sessions.filter((x) => x.id !== id);"
        ),
        "replacement": (
            "  deleteArmed.delete(id);\n"
            "  const rowEl = $('#sessions .session[data-id=\"' + CSS.escape(String(id)) + '\"]');\n"
            "  state.sessions = state.sessions.filter((x) => x.id !== id);"
        ),
    },
    {
        "name": "P3-deleteSession-spawn-ghost",
        "depends_g5": True,
        "anchor": (
            "  pruneMsgStore();\n"
            "  saveSessions();\n"
            "  renderSessions();\n"
            "  if (wasActive) {"
        ),
        "replacement": (
            "  pruneMsgStore();\n"
            "  saveSessions();\n"
            "  renderSessions();\n"
            "  spawnListGhost(rowEl); // 退场幽灵：侧栏列表合拢的同时旧会话行淡出\n"
            "  if (wasActive) {"
        ),
    },
    # ── P4 · painter 重挂时打断入场动画 ──
    # 用途：interruption —— 流式重挂（painter.mount 整棵替换 prose 子树）时，
    # 消息节点可能还挂着 is-enter 的入场动画；正文正在流出的消息不该
    # 继续飞入，立即移除动画类让其落定。
    # ⚠ G5 依赖：paint 闭包属会话并行改造区。
    {
        "name": "P4-paint-cancel-enter",
        "depends_g5": True,
        "anchor": (
            "    if (liveNode) {\n"
            "      painter.mount($('.prose', liveNode));\n"
            "      painter.paint(body);\n"
            "      if (stickBottom) scrollToBottom();\n"
            "    }"
        ),
        "replacement": (
            "    if (liveNode) {\n"
            "      // 打断处理：重挂时若入场动画还在播，立即取消 —— 流式正文不该边写边飞\n"
            "      node.classList.remove('is-enter');\n"
            "      painter.mount($('.prose', liveNode));\n"
            "      painter.paint(body);\n"
            "      if (stickBottom) scrollToBottom();\n"
            "    }"
        ),
    },
    # ── P5 · origin-aware openMenu ──
    # 用途：spatial consistency —— 菜单从锚点方向长出来：
    #   下方展开 = 顶边为锚（transform-origin: top left）；
    #   上翻 = 底边为锚（bottom left）；
    #   水平被夹持（贴右边）= 右侧为锚（top right / bottom right）。
    # 与 motion-system.css 的 .menu 静态兜底 origin（top left）配套；
    # 锚点带上 openMenu 特有的翻转判定行以保证唯一（会话右键菜单由 P6 单独处理）。
    # ⚠ G5 依赖：openMenu 同时服务 runningMenu（G5 新面）。
    {
        "name": "P5-openMenu-origin-aware",
        "depends_g5": True,
        "anchor": (
            "  const h = menu.offsetHeight;\n"
            "  const top = r.bottom + 7 + h <= window.innerHeight - 10\n"
            "    ? r.bottom + 7 : Math.max(10, r.top - h - 14);\n"
            "  menu.style.left = left + 'px';\n"
            "  menu.style.top = top + 'px';\n"
            "}"
        ),
        "replacement": (
            "  const h = menu.offsetHeight;\n"
            "  const top = r.bottom + 7 + h <= window.innerHeight - 10\n"
            "    ? r.bottom + 7 : Math.max(10, r.top - h - 14);\n"
            "  menu.style.left = left + 'px';\n"
            "  menu.style.top = top + 'px';\n"
            "  // origin-aware：按锚点相对方向写入 transform-origin（从锚点长出来，而不是中心）\n"
            "  const flippedY = top < r.bottom; // 上翻（锚点下方放不下）\n"
            "  const flippedX = left > r.left;  // 水平被夹持，右缘对齐\n"
            "  menu.style.transformOrigin = (flippedY ? 'bottom' : 'top') + ' ' + (flippedX ? 'right' : 'left');\n"
            "}"
        ),
    },
    # ── P6 · 会话右键菜单 origin-aware（与 openMenu 同一套边界规则的手工定位版） ──
    # ⚠ G5 依赖：会话右键菜单属会话列表区。
    {
        "name": "P6-contextMenu-origin-aware",
        "depends_g5": True,
        "anchor": (
            "  const left = Math.max(10, Math.min(x, window.innerWidth - w - 10));\n"
            "  const top = (y + 6 + h <= window.innerHeight - 10) ? y + 6 : Math.max(10, y - h - 8);\n"
            "  menu.style.left = left + 'px';\n"
            "  menu.style.top = top + 'px';\n"
            "}"
        ),
        "replacement": (
            "  const left = Math.max(10, Math.min(x, window.innerWidth - w - 10));\n"
            "  const top = (y + 6 + h <= window.innerHeight - 10) ? y + 6 : Math.max(10, y - h - 8);\n"
            "  menu.style.left = left + 'px';\n"
            "  menu.style.top = top + 'px';\n"
            "  // origin-aware：跟随点击点方向（上翻=底部为锚，贴右=右侧为锚）\n"
            "  const flippedY = top < y;\n"
            "  const flippedX = left > x;\n"
            "  menu.style.transformOrigin = (flippedY ? 'bottom' : 'top') + ' ' + (flippedX ? 'right' : 'left');\n"
            "}"
        ),
    },
]
