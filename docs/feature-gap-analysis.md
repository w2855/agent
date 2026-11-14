# ZCode → DSH 功能差距分析（2026-11-14，深度调研代理产出）

> 全量对照表 + TOP 15 排名，按「用户感知价值 × plain-JS 可实现性」排序。
> 参考：ZCode-3.17.2 源码 docs/ 334 篇设计文档 + packages/ui；DSH 现状以 11 个提交为准。

## TOP 15 排名

| # | 功能 | 工作量 | 分组 | ZCode 依据 | 状态（2026-11-14） |
|---|---|---|---|---|---|
| 1 | Markdown 表格渲染 + 长表吸底滚动条 | 中 | A | docs/markdown-table-scroll-mode-toggle.md | 未做 |
| 2 | 代码块语法高亮（流式关/完成开） | 小-中 | A | docs/streaming-markdown-reveal.md | 未做 |
| 3 | OS 系统通知（完成/失败/等审批，点击聚焦） | 小 | A | docs/chat/human-intervention-notifications.md | 已完成（`7dd6fb2` R7-sysint：tag 去重 30s + 点击聚焦 + document.hidden 才发） |
| 4 | 自动上下文压缩（阈值预检查 + divider） | 小-中 | A | auto-compact-output-reserve-design.md | 未做 |
| 5 | 用户消息编辑重发 | 小 | A | docs/ui/chat-user-message-retry.md | 未做 |
| 6 | 会话导出 md/JSON（本地，ZCode 仅云端） | 小 | A | — | 已完成（`7dd6fb2` R7-sysint：md/json 对话框，序列化抽 lib/session-export） |
| 7 | 主题跟随系统（System/Light/Dark） | 小 | A | docs/ui/settings-appearance.md | 进行中（R9 P1 A组） |
| 8 | Reasoning 流式摘要 + 思考 N 秒 | 中 | B | docs/chat/reasoning-streaming-auto-collapse.md | 未做 |
| 9 | 上下文用量徽标（字符÷3 + 明细） | 小-中 | B | docs/ui/chat-input-context.md | 未做 |
| 10 | 会话 fork（从某条消息分叉新会话） | 小-中 | B | docs/rewind-button-any-message.md | 未做 |
| 11 | Windows 托盘 + 关闭到托盘 | 小-中 | B | docs/windows-tray.md | 已完成（`7dd6fb2` R7-sysint：托盘 + 关闭到托盘开关 + 右键菜单/新对话） |
| 12 | 快捷键速查面板 + 固定新增绑定 | 小 | B | docs/desktop/shortcut-settings-spec.md | 未做（仅 Ctrl+F `97354c5`） |
| 13 | AskUserQuestion 自动继续（60s 静默+240s 胶囊） | 小 | B | docs/ask-user-question-auto-resolution.md | 未做 |
| 14 | 文件级撤销（单轮写文件回滚） | 中-大 | C | docs/file-summary-safe-rewind.md | 未做 |
| 15 | @ 文件引用面板（简化版） | 中 | C | docs/ui/mention-panel-layout.md | 未做 |

> 状态依据 git log 实际提交核对（`7dd6fb2` = R7-sysint，`97354c5` = R7-g3），非口头推断。

## 实施分组（区段不冲突可并行）

- **A 组**：H1 = app.js 渲染段（#1 表格 + #2 高亮）；H2 = app.js 交互段（#5 编辑重发 + #6 导出入口 + #7 主题跟随 + #4 自动压缩）；H3 = main.js（#3 通知 + #11 托盘 + 导出 dialog）→ H1/H2 串行（同 app.js），H3 并行
- **B 组**：#8 reasoning 摘要（渲染折叠区）、#9 用量徽标（composer）、#10 fork（消息 actions，复用 A5 截断逻辑）、#12 快捷键速查、#13 问答自动继续
- **C 组**：#14 文件撤销（main+renderer 工具链）、#15 @ 面板（composer）

## 明确不移植
消息级 cascade rewind（ZCode 已下线）、Mermaid（重依赖）、虚拟滚动、Cmd+K 全量、自动更新、深链接、i18n、分屏、定时任务、Prompt Enhance、UI Plugin、Bots、CUA、Usage 全量面板（可后置简化版）。

## 已确认 DSH 已实现/更优
流式渲染（stable/live 双路径优于 ZCode 单一 streamdown）、drafts、输入历史、jump-to-bottom、retry、copy、MCP、Skills、审批、委派+预算+检查点、架构页、检查器、设置页、Ctrl+F（CSS Highlight API）、OS 系统通知、Windows 托盘+关闭到托盘、会话导出 md/json、API Key 主进程保管（渲染层零明文）、桌宠系统。
