# ZCode → DSH 功能差距分析（2026-11-14，深度调研代理产出）

> 全量对照表 + TOP 15 排名，按「用户感知价值 × plain-JS 可实现性」排序。
> 参考：ZCode-3.17.2 源码 docs/ 334 篇设计文档 + packages/ui；DSH 现状以 11 个提交为准。

## TOP 15 排名

| # | 功能 | 工作量 | 分组 | ZCode 依据 | 状态（2026-11-14） |
|---|---|---|---|---|---|
| 1 | Markdown 表格渲染 + 长表吸底滚动条 | 中 | A | docs/markdown-table-scroll-mode-toggle.md | ✅ 已完成（`3035fea` R9-p1：流式不解析防半表 + 吸底滚动条 + sticky 表头） |
| 2 | 代码块语法高亮（流式关/完成开） | 小-中 | A | docs/streaming-markdown-reveal.md | ✅ 已完成（`3035fea`：零依赖单遍 tokenizer 七语言，流式纯文本完成染色） |
| 3 | OS 系统通知（完成/失败/等审批，点击聚焦） | 小 | A | docs/chat/human-intervention-notifications.md | 已完成（`7dd6fb2` R7-sysint：tag 去重 30s + 点击聚焦 + document.hidden 才发） |
| 4 | 自动上下文压缩（阈值预检查 + divider） | 小-中 | A | auto-compact-output-reserve-design.md | ✅ 已完成（`3035fea`：90% 阈值 + 时间线提示 + 设置开关） |
| 5 | 用户消息编辑重发 | 小 | A | docs/ui/chat-user-message-retry.md | 未做 |
| 6 | 会话导出 md/JSON（本地，ZCode 仅云端） | 小 | A | — | 已完成（`7dd6fb2` R7-sysint：md/json 对话框，序列化抽 lib/session-export） |
| 7 | 主题跟随系统（System/Light/Dark） | 小 | A | docs/ui/settings-appearance.md | ✅ 已完成（`3035fea`：三态 seg + 实时监听 + 默认迁移） |
| 8 | Reasoning 流式摘要 + 思考 N 秒 | 中 | B | docs/chat/reasoning-streaming-auto-collapse.md | 未做 |
| 9 | 上下文用量徽标（字符÷3 + 明细） | 小-中 | B | docs/ui/chat-input-context.md | ✅ 已完成（`dbad4ec` Statusline：模型/agent 数/上下文%/token，`d2fe3ac` 上下文窗口设置跟随） |
| 10 | 会话 fork（从某条消息分叉新会话） | 小-中 | B | docs/rewind-button-any-message.md | 未做 |
| 11 | Windows 托盘 + 关闭到托盘 | 小-中 | B | docs/windows-tray.md | 已完成（`7dd6fb2` R7-sysint：托盘 + 关闭到托盘开关 + 右键菜单/新对话） |
| 12 | 快捷键速查面板 + 固定新增绑定 | 小 | B | docs/desktop/shortcut-settings-spec.md | 未做（仅 Ctrl+F `97354c5`） |
| 13 | AskUserQuestion 自动继续（60s 静默+240s 胶囊） | 小 | B | docs/ask-user-question-auto-resolution.md | 未做 |
| 14 | 文件级撤销（单轮写文件回滚） | 中-大 | C | docs/file-summary-safe-rewind.md | ✅ 已完成（`b196658` R10-undo：写前+写后双快照 + changed-since 预检 + 环形 20 原子写回） |
| 15 | @ 文件引用面板（简化版） | 中 | C | docs/ui/mention-panel-layout.md | 未做 |

> 状态依据 git log 实际提交核对（`7dd6fb2` = R7-sysint，`97354c5` = R7-g3），非口头推断。

## ruflo 移植 TOP 12（R9–R11 批次）

| # | 功能 | 状态（2026-11-14） |
|---|---|---|
| 1 | 验证门学习闭环（污点检测 + 退出码真判定 + caution 三态） | ✅ 已完成（`084a25c` R9-q1） |
| 2 | Doctor 体检面板（10 项 HealthCheck + 配置评分 + 修复建议） | ✅ 已完成（`dbad4ec` R9-g4） |
| 3 | PII 四档脱敏管线 + 三处接线 | ✅ 已完成（`e0f39a1` R9-q2 + `53a679d` X1） |
| 4 | 成本预算硬停阶梯（三窗口滚动 + hard-stop + fallback 降级） | ✅ 已完成（`4098804` R9-r2） |
| 5 | 有界读取委托（intent/depth 系数三档策略） | ✅ 已完成（`0e0cd4d` R9-r1） |
| 6 | Hybrid 检索（BM25 bigram + 字符余弦 + MMR，含经验库接入） | ✅ 已完成（`0e0cd4d` + `038311e` X2） |
| 7 | Autopilot 无人值守循环（核心：状态机 + 失败自动停 + 安全边界） | ✅ 已完成核心（`00b1764` R9-r5） |
| 8 | 发版字节校验（sha256 清单 + 篡改精确定位 + release.js 后验） | ✅ 已完成（`a428706` R9-r4） |
| 9 | 经验库轮换备份（keep-7/WAL 伴随/损坏跳过） | ✅ 已完成（`4098804` R9-r2） |
| 10 | context-plan 上下文规划（自动压缩 90% 阈值 + 上下文窗口设置 50 万–200 万） | ✅ 已完成（`3035fea` + `d2fe3ac`） |
| 11 | （待对照 ruflo 原清单补齐编号与名称） | 未盘点 |
| 12 | （待对照 ruflo 原清单补齐编号与名称） | 未盘点 |

> 编号 1/2/4/6/7/9/10 以核对清单为准；3/5/8 为按已落地批次推断占位，11/12 待对照原清单。

## 实施分组（区段不冲突可并行）

- **A 组**：H1 = app.js 渲染段（#1 表格 + #2 高亮）；H2 = app.js 交互段（#5 编辑重发 + #6 导出入口 + #7 主题跟随 + #4 自动压缩）；H3 = main.js（#3 通知 + #11 托盘 + 导出 dialog）→ H1/H2 串行（同 app.js），H3 并行
- **B 组**：#8 reasoning 摘要（渲染折叠区）、#9 用量徽标（composer）、#10 fork（消息 actions，复用 A5 截断逻辑）、#12 快捷键速查、#13 问答自动继续
- **C 组**：#14 文件撤销（main+renderer 工具链）、#15 @ 面板（composer）

## 明确不移植
消息级 cascade rewind（ZCode 已下线）、Mermaid（重依赖）、虚拟滚动、Cmd+K 全量、自动更新、深链接、i18n、分屏、定时任务、Prompt Enhance、UI Plugin、Bots、CUA、Usage 全量面板（可后置简化版）。

## 已确认 DSH 已实现/更优
流式渲染（stable/live 双路径优于 ZCode 单一 streamdown）、drafts、输入历史、jump-to-bottom、retry、copy、MCP、Skills、审批、委派+预算+检查点、架构页、检查器、设置页、Ctrl+F（CSS Highlight API）、OS 系统通知、Windows 托盘+关闭到托盘、会话导出 md/json、API Key 主进程保管（渲染层零明文）、桌宠系统、表格渲染+吸底滚动、语法高亮、自动上下文压缩、主题跟随、Statusline、Doctor、验证门、PII 脱敏、Hybrid 检索、成本硬停、轮换备份、autopilot、字节校验、文件级撤销、会话级并行、会话右键菜单+ID 识别、统一 userData、启动画面、动效重做。
