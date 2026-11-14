# DSH Desktop

中文 AI Agent 桌面应用（Electron 纯 JavaScript，零 npm 运行时依赖）。像人一样边干边说：多步工具循环中每一步先说明再调用，工具卡片与说明文字交替呈现。

## 特性

### 对话与渲染
- **流式渲染**：稳定块 + 活动尾增量更新（O(n²) → 稳定边界），GFM 表格、零依赖语法高亮（七语言）、未闭合代码围栏降级
- **分段回合**：多步工具回合按「模型说明段 → 工具卡片 → 说明段 → 卡片」交替渲染（正文按工具入列快照切段）
- **会话级并行聊天**：A 会话跑任务的同时 B 会话正常聊天，中断按会话隔离，侧栏运行中徽标
- **自动上下文压缩**：超预算 90% 自动折叠并注入摘要
- **每步开口保证**：工具结果回传后动态注入流程提醒（结构性保证，不依赖模型自觉）

### 工具与能力
- 多步工具循环（并行执行委派）、文件级撤销（写前/写后双快照 + changed-since 预检）
- MCP stdio 客户端（JSON-RPC 2.0，零依赖）、技能扫描与注入
- 子代理委派（delegate_task）支持跨接入点选模型
- 无人值守 Autopilot 循环（连续失败自动停）
- verified-lessons 经验库（验证门 + 污点检测 + Hybrid 检索 + 相关经验注入）
- 成本预算三窗口硬停（日/周/月）

### 架构与体验
- 项目架构图按会话隔离（每会话独享架构，实时刷新 + 运行节点呼吸光环）
- 任务清单右上角常驻、行内编辑、三态（运行中/校验中/阻塞）
- ZCode 式设置页 9 pane（含 Doctor 体检 11 项 + 配置评分）
- 启动画面 + 启动提速（阶段打点）、Motion Tokens 动效体系（reduced-motion 全兜底）
- OS 通知、托盘、会话导出（md/JSON）、Ctrl+F 查找、选区菜单、失败重试

### 安全
- **密钥主进程化**：渲染层只见掩码，真实 key 由主进程 safeStorage 凭据库保管，委派时内存解析
- **PII 四档脱敏**：BLOCK / REDACT / HASH / PASS（通知/导出/崩溃日志分级接线）
- 单实例锁、渲染进程崩溃自愈、下载执行变体检测、workspaceOnly 校验
- 持久化真值源为文件（`userData/dsh-storage.json`）：换构建方式（开发版 ↔ 打包版）历史不丢

## 快速开始

```bash
# 开发运行
npx electron .

# 打包（Windows portable exe，含发版字节校验）
node tools/release.js          # 构建并写入 release/manifest.json
node tools/release.js --verify # 只校验产物字节
```

## 一键验收

```bash
node tools/run-all.js          # 五段聚合：语法 + runtime 回归 339 + lib 自检 + Electron 探针 + e2e 74
node tools/shot-suite.js --profile dsh   # 截图驱动验收（8 场景，任意 URL 模式可移植）
```

专项探针：`t1`（保存/上下文）、`dyn`（架构/任务）、`g3`（查找/选区）、`g5`（会话并行）、`arch-iso`（架构隔离）、`narrate-live`（工具说话实时性）、`effort-probe`（思考强度）等，见 `tools/`。

## 目录结构

```
main.js            主进程：窗口/IPC/模型流式请求/凭据库/存储/通知/托盘
preload.js         contextBridge 桥（快照同步取、IPC 转发）
renderer/          界面（app.js ~7000 行 + styles.css + index.html）
runtime/           会话编排：任务图/委派/审批/经验记录/预算
lib/               纯模块：tools/mcp/skills/lessons/redact/persist-store/budget/backup/undo…
tools/             验收体系：run-all 聚合器、专项探针、截图驱动、mock 网关、打包流水线
docs/              工作流轮次记录、e2e 指南、交接文档
```

## 思考强度

连接设置中选择 reasoning_effort（关闭/低/中/高），跟随接入点存储；主聊天与子代理委派请求均会注入，关闭则不发送该参数以兼容普通模型。

## 文档

- [docs/WORKFLOW.md](docs/WORKFLOW.md) — 开发工作流全轮次记录
- [docs/e2e-guide.md](docs/e2e-guide.md) — 端到端验收指南与环境坑清单
- [docs/HANDOFF.md](docs/HANDOFF.md) — 任务交接文档

## 许可

MIT
