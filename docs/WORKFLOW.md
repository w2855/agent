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

## 3. 参考源码（按 star 优先级）

| 项目 | 看什么 |
|---|---|
| **opencode** (sst/opencode) | 流式渲染机制、会话存储、工具调用 UX、上下文压缩、错误重试 UX |
| **Cline** (cline/cline) | 检查点/回滚、工具调用折叠展示、成本显示、审批卡片 |
| **aider** (Aider-AI/aider) | /undo、增量 diff 展示、repo-map、精简交互 |
| **goose** (block/goose) | 扩展机制、会话恢复 |
| **Open Interpreter / OpenHands / continue** | 按需 |

研究结论落在本文件 §7 各轮记录内，可执行项转 backlog。

## 4. 约束（不可动项，违反即返工）

- 委派/审批机制**不动**（用户明确要求）
- 会话持久化与个性化提示词**必须保留**，改动需实测跨重启
- 配色蓝色系（#2F6BAE 系），不用紫色
- 所有动画尊重 `prefers-reduced-motion`
- 全程中文交流，回复简洁
- E:\dsh-desktop 是唯一软件目录（旧 E:\ds 已废弃）

## 5. 问题 Backlog

### P2 遗留（来自交接文档）
- [~] 流式 O(n²) 渲染 → 改增量/节流更新（第一轮）
- [ ] msgStore 不清理 → 会话消息上限 + 冷会话裁剪（第一轮）
- [ ] 密钥回传渲染层（架构取舍，暂缓，需用户点头才动）
- [ ] electron-builder 打包实测（DSH-Desktop-${version}.exe）
- [ ] tool-e2e 完整端到端数字

### UX 优化（研究子代理产出后补充）
- [ ] 待研究结论落地…

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
- [x] 本文件建立
- [~] 并行研究：opencode 源码模式 / 高星 agent 源码模式 / 本地问题定位
- 下一轮：按定位结果修流式渲染 + msgStore
