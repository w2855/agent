# DSH Desktop 持续完善工作流

> 建立于 2026-11-14。本文件定义长期迭代循环，每轮执行后更新「轮次记录」。
> 状态标记：`[ ]` 待办 · `[~]` 进行中 · `[x]` 已完成 · `[!]` 受阻

## 1. 最终目标

把 DSH Desktop 打磨为体验对标一线开源 agent（opencode / Cline / aider）的桌面 AI agent：
- 遗留 P2 问题全部清零（性能 + 架构）
- UX 达到「用户可感知的顺滑」：流式渲染不卡顿、操作有反馈、错误可恢复
- 回归基线 296/296 恒绿，tool-e2e 拿到完整数字

## 2. 每轮循环（不可跳步）

1. **差距分析**：对照 §1 目标 + §5 backlog，找出当前最大差距
2. **制定计划**：本轮改哪些点，预计动哪些文件（文件冲突时按区段分工）
3. **执行修改**：优先并行子代理提效；每处修改最小化 diff
4. **验证**：改动点专项验证 + 全量回归（§6 命令），数字必须与基线持平或更好
5. **检查效果**：能截图的截图（`--shot`），不能只凭代码判断
6. **落盘**：更新本文件轮次记录 + 相关文档，然后自动进入下一轮
7. **结束条件**：§1 验收标准全部满足且回归全绿，否则不许停

## 3. 参考源码（按优先级）

| 项目 | 位置 | 看什么 |
|---|---|---|
| **ZCode 3.17.2（最高优先）** | `C:\Users\Administrator\Downloads\ZCode-3.17.2\ZCode-3.17.2`（完整源码） | packages/stream-animate（流式动画）、packages/ui（聊天组件）、docs/ 334 篇设计文档（agent-tool-call-renderer、markdown-type-scale、conversation-session-* 等） |
| **opencode** | 本地克隆 `F:\tmp-opencode-research\opencode`（sst/opencode dev 分支） | paced-text-machine（流式节奏）、markdown-phase-machine、markdown-cache（分块 LRU）、compaction.ts、permission dock、session-retry 卡片 |
| Cline / aider / goose | 远程（GitHub 访问走代理，如 127.0.0.1:7890） | aider mdstream.py（已借鉴）；Cline ChatRow / checkpoints |
| ZCode 桌面版构建产物 | `F:\work\zcode-ref\asar-extract`（已解包） | 打包后的实现细节对照 |

研究结论沉淀在本文档与轮次记录；GitHub 访问一律走代理。

## 4. 约束（不可动项，违反即返工）

- 委派/审批机制**不动**（用户明确要求）
- 会话持久化与个性化提示词**必须保留**，改动需实测跨重启
- 配色蓝色系（#2F6BAE 系），不用紫色
- 所有动画尊重 `prefers-reduced-motion`
- 全程中文交流，回复简洁
- E:\dsh-desktop 是唯一软件目录（旧 E:\ds 已废弃）

## 5. 问题 Backlog

### P2 遗留（来自交接文档 + code-review-2026-11-13.md 交叉核对）
- [x] 流式 O(n²) 渲染：改稳定块+活动尾增量渲染（R1 完成，aider mdstream 模式，两路径接入）
- [x] msgStore 永不清理：压缩后 pruneMsgStore（R1 完成）
- [ ] 子任务预算不预留、父 usage 不累计子消耗（delegation.js:35-59 + state.js:954-958）⚠️ 冻结区，需用户点头
- [ ] 密钥回传渲染层（main.js:269-284, preload.js:40-43，架构取舍，需用户点头才动）
- [ ] delegate_task 声明 workspaceOnly 但 policy 层不校验参数（tool-registry.js:60）——安全向可做
- [ ] download-exec 只查 curl/wget 直连管道，`curl -o evil.exe … & evil.exe` 不命中（policy.js:65）——安全向可做
- [ ] `_prune` 可删仍被子任务引用的父任务（state.js:1336）
- [ ] graph.js 不抑制 end 后事件（state.js:1249-1334 相关）
- [ ] electron-builder 打包实测（DSH-Desktop-${version}.exe）
- [x] tool-e2e 完整端到端数字：**74/74 全通过**（卡点是 userData 缓存锁，`--user-data-dir` 隔离即解，已验证两次）

### UX 优化
R2 已落地（2026-11-14，来源：本地定位 11 条 + ZCode 挖掘 16 项 + opencode 机制）：
- [x] toast 队列（不再互相覆盖）
- [x] markdown 渲染错误降级为纯文本（ZCode 错误边界模式）
- [x] 建议 chips 点击直接发送（少一次点击）
- [x] 失败回合「重试」按钮（原来只有中断态有按钮）
- [x] 输入长度计数（接近 12 万上限才出现，超限变红）
- [x] 回到底部悬浮按钮（上滚离开底部时出现）
- [x] 助手消息复制按钮（成功打勾 1.2s 还原，ZCode CopyRowAction 模式）
- [x] 输入历史 ↑/↓ 翻阅（30 条，localStorage，ZCode promptHistory 模式）

R3 候选（按 ZCode 清单价值排序，待下一轮）：
- [ ] 代码块复制按钮（hover pre 显示）
- [ ] 会话右键删除 + 确认（当前无法删会话，存储只增不减）
- [ ] 工具调用行：运行中扫光进度条（ZCode ToolCallProgressIndicator 的 indeterminate keyframe）
- [ ] 输入草稿按会话持久化（切会话/重启不丢）
- [ ] 重试状态内嵌卡片增强（倒计时已有，加低对比 shimmer）
- [ ] 思考/工具折叠区：正文到达后自动收起，用户点过不再自动动
- [ ] 会话内查找（Ctrl+F，CSS Highlight API）
- [ ] 选区浮动操作菜单（复制/追问）
- [ ] 发送键四态状态机（canSend/发送中/运行中空草稿→停止/队列）

### 观察项
- [ ] runtime-ipc-check.js 只能在 Electron 内跑（`--script` 方式），文档化

## 6. 回归基线（每轮必跑）

```bash
cd /e/dsh-desktop
for f in tools/runtime-*-check.js; do node "$f" 2>&1 | tail -5; done   # 8 脚本 296 项
npx electron . --script=tools/tool-e2e.js                              # 渲染层 e2e
```

基线数字（2026-11-14 实测，与交接文档一致，全绿）：
foundation 43 / orchestrator 58 / delegation 63 / project 43 / queue 29 / graph 20 / audit 17 / validation 23 = **296/296**
（runtime-ipc-check.js 需 Electron 上下文，node 直跑报 `window is not defined` 属预期）

## 7. 轮次记录

### R0 · 2026-11-14 · 建立工作流
- [x] 项目现状验证（结构与 package.json 无异常）
- [x] 回归基线 296/296 全绿
- [x] git 仓库初始化 + 基线提交 `7efb0e6`（158 文件，含 .gitignore 排除日志/截图/node_modules）
- [x] 本文件建立
- [x] 四路并行研究：本地定位 / 高星 agent（Cline 71.6k、aider 50.1k 等）/ opencode（源码已克隆到 F:\tmp-opencode-research\opencode）/ ZCode 3.17.2 源码挖掘
- [x] tool-e2e 补跑：**74/74 全通过**（历史卡点=userData 缓存锁，`--user-data-dir` 隔离解决）

### R1 · 2026-11-14 · 流式渲染性能 + 内存泄漏（commit `0cd6ff9`）
- [x] 流式渲染改增量更新：`stableBoundary()` 切稳定块 + `createStreamPainter()` 活动尾局部重绘，API 与离线预览两路径接入（参考 aider mdstream.py 滑动窗口 + opencode markdown 分块缓存思想）；光标改为常驻节点不再每帧重建
- [x] msgStore 泄漏：新增 `pruneMsgStore()`，上下文压缩后清理不再被引用的消息
- [x] 存储写入失败告警（原静默吞掉，只提示一次防刷屏）
- 验证：语法 ✓ · 296/296 ✓ · tool-e2e 74/74 ✓（新代码上）· 截图 ✓

### R2 · 2026-11-14 · UX 第一批（来源：本地定位 11 条 + ZCode 挖掘 16 项）
- [x] toast 队列 / markdown 错误降级 / 建议直发 / 失败重试按钮 / 输入计数 / 回到底部 / 消息复制（打勾反馈）/ 输入历史 ↑/↓
- 验证：语法 ✓ · tool-e2e 74/74 ✓ · 296 回归（见下）
- 下一轮 R3：代码块复制、会话删除、工具行扫光、草稿持久化（清单见 backlog）
