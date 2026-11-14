# DSH Desktop 持续完善工作流

> 建立于 2026-11-14。本文件定义长期迭代循环，每轮执行后更新「轮次记录」。
> 状态标记：`[ ]` 待办 · `[~]` 进行中 · `[x]` 已完成 · `[!]` 受阻

## 1. 最终目标

把 DSH Desktop 打磨为体验对标一线开源 agent（opencode / Cline / aider）的桌面 AI agent：
- 遗留 P2 问题全部清零（性能 + 架构）
- UX 达到「用户可感知的顺滑」：流式渲染不卡顿、操作有反馈、错误可恢复
- 回归基线 339/339 恒绿 + lessons-check 101/101，tool-e2e 74/74

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
- [x] 子任务预算不预留、父 usage 不累计子消耗（`62fa051` R6-budget，用户授权解冻：幂等并入父 usage + 在途预留 + 跨重启只计一次）
- [x] 密钥回传渲染层（`18532b8` R7-secrets，用户授权：API Key 主进程保管 + 掩码视图 + profileId 注入，渲染层不再收到明文）
- [x] delegate_task 声明 workspaceOnly 但 policy 层不校验参数（`e5fe8b1` R5-runtime：workspaceOnly 参数校验）
- [x] download-exec 只查 curl/wget 直连管道（`e5fe8b1` R5-runtime：3 正则 + 空白归一化覆盖 `curl -o evil.exe … & evil.exe` 变体）
- [x] `_prune` 可删仍被子任务引用的父任务（`e5fe8b1` R5-runtime：被引用父任务跳过保护）
- [x] graph.js 不抑制 end 后事件（`e5fe8b1` R5-runtime：end 后事件抑制，保留断点续跑重开）
- [x] electron-builder 打包实测：R4 产出 release/DSH-Desktop-0.1.0.exe 105.7MB；设置页/MCP/通知之后的新版重出归入 R9 P5 打包流水线
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

R3 候选 → 已全部落地（见 R3 轮次记录）：
- [x] 代码块复制按钮（hover 注入，打勾反馈）
- [x] 会话删除（两段确认 + 运行保护；顺带修复逐行监听重复注册）
- [x] 工具调用行：运行中扫光进度条
- [x] 输入草稿按会话持久化

R4 候选（剩余，按价值排序）：
- [x] markdown 斜体中文标点边界（R4 已修，截图验证）
- [x] 重试状态内嵌卡片增强（`244fdd7` R5-renderer：重试原因呼吸）
- [x] 思考/工具折叠区：正文到达后自动收起，用户点过不再自动动（`244fdd7` R5-renderer）
- [x] 会话内查找（Ctrl+F，CSS Highlight API，命中计数环绕跳转）（`97354c5` R7-g3）
- [x] 选区浮动操作菜单（复制/追问预填）（`97354c5` R7-g3）
- [x] electron-builder 打包实测（R4 完成；新版重出归入 R9 P5）

### R9–R11 能力落地（ruflo 移植 + 并行批次，均已验证）
- [x] 验证门学习闭环（污点检测 + 退出码真判定，`084a25c`）
- [x] Doctor 体检面板 + Statusline 状态条 + Pair 协作模式 + 任务清单三态（`dbad4ec`）
- [x] PII 脱敏管线 + 三处接线（`e0f39a1`/`53a679d`）
- [x] Hybrid 检索（检索引擎 `0e0cd4d` + 经验库接入 `038311e`）
- [x] 成本预算硬停阶梯（`4098804`）
- [x] 经验库轮换备份（`4098804`）
- [x] Autopilot 无人值守（`00b1764`）
- [x] 发版字节校验（`a428706`）
- [x] 文件级撤销（`b196658`）
- [x] 会话级并行聊天（`676000d`）
- [x] 会话右键菜单 + ID 识别（`6c76269`）
- [x] 统一 userData + 保存加固 + 上下文窗口设置（`74f5f98`/`d2fe3ac`）
- [x] 架构按会话隔离（`e411e91`）
- [x] 表格渲染/语法高亮/自动上下文压缩/主题跟随（`3035fea`）
- [x] 启动画面 + 启动提速 + 说话强化 + 任务清单常驻（`5821f6c`）
- [x] 全应用动效重做（`d3f2617`）

### 待办下一批（R12 候选）
- [~] 叙述重复根因修复（进行中）：会话并行批引入的叙述行重复，先定位根因再修
- [~] 壁纸修复（进行中）
- [~] 401 修复（进行中）
- [ ] 桌宠恢复：条件 = 生成配额恢复后重生成 idle 大幅度姿势并重新启用打包加载（R9-final 起打包排除 assets/pet，git 保留资产）

### 观察项
- [ ] runtime-ipc-check.js 只能在 Electron 内跑（`--script` 方式），文档化

## 6. 回归基线（每轮必跑）

```bash
cd /e/dsh-desktop
node tools/run-all.js [--quick]                                        # 一键聚合：语法门禁 + 回归 + lib 自检 (+ Electron 探针/e2e)
for f in tools/runtime-*-check.js; do node "$f" 2>&1 | tail -5; done   # 9 脚本（runtime-ipc-check 需 Electron）
npx electron . --user-data-dir="E:/dsh-desktop/.e2e-userdata" --script=tools/tool-e2e.js   # 渲染层 e2e
```

基线数字（2026-11-15 实测，全绿）：
foundation 62 / orchestrator 58 / delegation 83 / project 43 / queue 29 / graph 24 / audit 17 / validation 23 / **governance 36** = **375/375**
lessons-check = **109/109**
最终门禁 = **26 项 25✓ 0✗ 1 跳**（2026-11-15 实测；runtime-ipc-check.js 需 Electron 上下文（`--script` 通道），node 直跑报 `window is not defined` 属预期，计为跳过）
（并发代理扩容会改变各脚本计数，以聚合器当场实测为准；lib 自检另含 mcp 26 / skills 14 / ipc-mcp 18 / secret-mask 37 / h3 31 / lessons 109）

> 聚合器环境注意：宿主 IDE/agent 可能设置 `ELECTRON_RUN_AS_NODE=1`，会让 electron.exe
> 退化成纯 Node（`app` undefined → 启动即崩 → 全部 Electron 探针假失败）。聚合器已统一剥离
> 该变量再 spawn；手工跑探针时用 `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron ...`。
（run-all 五段汇总：语法门禁 → runtime 回归 → lib 自检 → Electron 探针 → tool-e2e，任一失败退出码 1；`--quick` 跳过探针/e2e，聚合器只跑现状不重试修复）

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

### R2 · 2026-11-14 · UX 第一批（commit `8c05b52`，来源：本地定位 11 条 + ZCode 挖掘 16 项）
- [x] toast 队列（不再互相覆盖）
- [x] markdown 渲染错误降级为纯文本（ZCode 错误边界模式）
- [x] 建议 chips 点击直接发送
- [x] 失败回合「重试」按钮
- [x] 输入长度计数（接近上限才出现，超限变红）
- [x] 回到底部悬浮按钮
- [x] 助手消息复制按钮（打勾 1.2s 还原，ZCode CopyRowAction 模式）
- [x] 输入历史 ↑/↓ 翻阅（30 条，ZCode promptHistory 模式）
- 验证：tool-e2e 74/74 ✓ · 296 回归 ✓
- 插曲：`.e2e-userdata`（e2e 隔离测试目录，含测试 secrets）误入提交，已 gitignore + 移出跟踪 + amend 清理

### R3 · 2026-11-14 · UX 第二批（commit `958da5a`）
- [x] 会话删除：hover 出 ×，两段确认（3 秒内再点一次），运行中/生成中不可删，全删光兜底新会话；顺带把逐行监听改为事件委托（修一处重复注册）
- [x] 代码块复制：悬停注入角落按钮，打勾反馈（流式重绘会冲掉按钮，悬停即补）
- [x] 草稿按会话持久化：localStorage `dsh.drafts`，400ms 防抖，发送即清，切会话/重启恢复
- [x] 工具行运行中扫光进度条（indeterminate，reduced-motion 下关闭）
- [x] 新增 tools/r3-shot.js 渲染检查脚本
- 验证：e2e 74/74 ✓ · 回归 296/296 ✓ · 截图 ✓（代码块/列表/链接渲染正常）
- 发现既有小瑕疵：中文标点后 `*斜体*` 不生效（inline() 边界类不认中文标点）→ 转 R4

### R4 · 2026-11-14 · 收尾轮
- [x] italic 中文标点边界修复（inline() 边界类补中文标点，截图验证）
- [x] 打包实测：release/DSH-Desktop-0.1.0.exe 105.7MB（ELECTRON_MIRROR=npmmirror 绕过 GitHub 下载超时）
- [x] e2e 挂起诊断四层根因（详见 R6 记录 + docs/e2e-guide.md）
- [x] 诊断工具沉淀：tools/diag.js（启动状态 + 主进程网络 + 渲染层 fetch 一次查清）
- [x] C 子代理：重试原因呼吸 + 工具折叠自动收起（用户手动优先）
- [x] R5 渲染批次：工具调用前模型开口（系统提示）+ 运行中文字呼吸 + 思考三点波浪 + 全局差异化开合动效 + 主题切换过渡 + 输入历史/消息复制等

### R6 · 2026-11-14 · 三路并行（全部已提交）
- **E 委派预算**（`62fa051`，用户授权解冻）：子消耗幂等并入父 usage（差值 + usageMerged 标记）、在途子消耗计入预留、跨重启并入新父 Run 只计一次；回归 314→339 全绿
- **D 设置页**（`40a37d9`）：ZCode 式左导航 6 分类 + 右内容区，53 个 ID 零丢失迁移；openConnect/openAgentSheet 改路由；e2e 适配（#paneConnect + 动画竞态改 waitUntil）；关闭按钮升级
- **F MCP + Skills 后端**（`8020305`）：零依赖 stdio MCP 客户端（JSON-RPC/握手/超时/崩溃恢复/进程树清理，26 项自检）+ 技能扫描（frontmatter/防越界，14 项）+ IPC 合流（18 项）；MCP 工具 `mcp_<server>_<tool>` 命名走既有审批路径；测试模式禁用硬件加速
- **e2e 之谜全部解密**：①GPU 驱动间歇崩溃 → 渲染进程启动即死 → did-finish-load 不触发 →「无输出挂起」（测试模式已禁硬件加速）；②网关「零日志」= stdout 重定向错位假象；③npx 从错误目录拉错 electron 版本；④并发改码使结果无效（对齐 e2e-guide.md）
- **工具行闪烁修复**：renderTools 全量重建 → 增量更新（签名对比，未变行零 DOM 写入）
- 验证：回归 339/339 ✓ · e2e 74/74 ✓（全量树）

### R7 · 2026-11-14 · MCP UI + 密钥主进程化 + 系统集成 + 查找/选区（全部已提交）
- **R7-mcp-skills-ui**（`34823ef`，G1）：设置页新增 MCP服务器/技能 两 pane（启动停止/两段删除/错误行内展示/工具汇总/技能注入）+ `/skills` 斜杠 + 工具行 MCP 标签容错（--tone-mcp 蓝系）+ 状态轮询签名比对防重建闪烁
- **R7-secrets**（`18532b8`，G2a，用户授权）：API Key 迁移主进程保管（掩码视图 + profileId 解析 + 掩码反查防迁移 401 + set 侧还原防凭据覆盖，37 项自检）；渲染层不再收到明文
- **R7-sysint**（`7dd6fb2`，H3）：OS 系统通知（tag 去重 30s + 点击聚焦 + document.hidden 才发）+ Windows 托盘（关闭到托盘开关/右键菜单/新对话）+ 会话导出（md/json 对话框，序列化抽 lib/session-export）；31 项自检 + Electron 探针全过；MCP 与密钥链路原样保留
- **R7-g3**（`97354c5`，G3）：密钥接线（apiCfg 带 profileId、掩码不回写守卫、localStorage 脱敏）+ Ctrl+F 会话查找（CSS Highlight API，命中计数环绕跳转）+ 选区浮动菜单（复制打勾/追问预填）；含 H3 渲染层触发点（OS 通知/托盘开关/导出按钮）；探针 44/44

### R8 · 2026-11-14 · 桌宠系统 + 架构图实时化（全部已提交）
- **R8-pet 第一阶段**（`690ac84`）：35 动作姿势表 + 生成器（参考图一致性，edits 端点 + 透明）+ 渲染器（脚底锚定对齐 + Farneback 光流插帧到 60fps + GIF/manifest）+ 验收脚本；批 1 六动作 48 关键帧 + 120-144 帧 GIF 全过验收
- **R8-pet 渲染升级**（`b3d7a9b`）：alpha 覆盖率合成（修重叠区半透明）+ 光流灰度输入修复 + GIF 逐帧延迟 [20,20,10]ms 循环（均值 16.67ms = 真 60fps，数学精确解）；批 1 六动作 120-144 帧重刷验收全过
- **R8-pet 直出模式**（`890e3cd`，按用户反馈）：废弃光流插帧（即过渡动画感来源），改关键帧直出零添加帧（60fps 时钟均匀直切）；wave/happy/sleepy/confused/shy 已直出；idle 姿势已加大幅度待重生成（暂停）
- **R8-dynamic**（`d421370`，H4，用户硬需求）：架构图事件驱动实时刷新（150ms 去抖 + 实时徽标 + 运行节点呼吸光环 + diff 防闪烁，轮询降 3s 兜底）+ 任务清单全交互（行内编辑/状态循环/两段删除/拖拽排序/新增/同步模型开关）；探针 arch14 + todo22 全绿；顺手修面板点击误关与定位裁切两个既有 bug

### R9 · 2026-11-14 · 6 路并行 + ruflo 移植（全部收口，已提交）
- [x] 本轮并行子代理全部落地：P1 A组（TOP15 渲染/交互差距项）/ P2 稳定性（runtime 回归扩容至 339）/ P3 经验库（tools/lessons-check.js 自检）/ P5 打包流水线 / P6 桌宠归档；另 Q/R/G 系列见下
- [x] R9-p1（P1 A组，`3035fea`）：GFM 表格渲染（流式不解析防半表 + 吸底滚动条 + sticky 表头）+ 零依赖语法高亮（单遍 tokenizer 七语言，流式关/完成开）+ 自动上下文压缩（90% 阈值/时间线提示/设置开关）+ 主题跟随系统（三态/实时监听/默认迁移）；探针 28 全过
- [x] R9-q1（Q1，`084a25c`）：验证门学习闭环——改测试/改验证器判污点，test/build/typecheck 退出码真才 verified，caution 三态；污染记录永不参与统计；lessons-check 83/83
- [x] R9-r1（R1，`0e0cd4d`）：Hybrid 检索（BM25 中文 bigram + 字符余弦 + 精确命中 + MMR 去重）+ 有界读取委托（intent/depth 系数三档策略/块拆分），纯函数零依赖
- [x] R9-r2（R2，`4098804`）：成本预算硬停阶梯（持久 budget.json 三窗口滚动/hard-stop 拒绝/fallback 降级）+ 经验库轮换备份（keep-7/WAL 伴随/损坏跳过）；339 回归绿
- [x] R9-q2（Q2，`e0f39a1`）：PII 四档脱敏管线（私钥块/api_key/jwt/email/手机/身份证/凭据 KV 七类探测，BLOCK/REDACT/HASH/PASS，对象递归防循环引用）；55 断言
- [x] R9-g4（G4，`dbad4ec`）：Doctor 体检面板（10 项 HealthCheck + MetaHarness 配置评分 0-100 + 修复建议）+ Statusline 状态条（模型/agent 数/上下文%/token）+ Pair 协作模式 + 任务清单三态；探针 35/35
- [x] R9-final（`197ae80`/`1974dab`）：探针适配两处有意行为变化（dyn 4 态含 verifying；凭据掩码视图防明文泄漏）+ 打包排除整个 assets/pet（约 300MB 不入包）；最终门禁 22 项 21✓0✗1跳全绿
- [x] 新建 tools/run-all.js 一键验收聚合器（`node tools/run-all.js [--quick]`）：语法门禁（46 文件）+ runtime 回归 + lib 自检（存在才跑）+ Electron 探针（隔离 .runall-probe，--quick 跳过）+ tool-e2e（自动 mock-gateway 复用/新建回收）；统一解析 [script]/JSON/中文计数，汇总中文表格，任一失败退出码 1；聚合器只跑现状，并发改动导致的异常不重试不修复
- [x] 文档同步：本文件轮次记录补齐 R7（4 提交）/R8（4 提交）/R9 + backlog 勾选（P2 遗留 8 项全部关账）+ §6 基线更新为 339；feature-gap-analysis.md TOP15 状态列（#3 通知 / #6 导出 / #11 托盘 完成，#7 主题跟随 → P1 进行中）

### R10 · 2026-11-14 · 存储统一 + 保存加固 + 会话体验（全部已提交）
- [x] T4 统一 userData（`74f5f98`）：打包版/开发版统一为 %APPDATA%/dsh-desktop，根治两套存储分裂导致的记录丢失感知；setPath 先于单实例锁（锁按 userData 隔离，时序修正）+ 旧打包目录迁移提示；6 组断言
- [x] T1 保存加固 + 会话 ID + /load + 上下文设置（`d2fe3ac`）：dirty 标记 + 30s 自动保存 + hidden/beforeunload 兜底 + 配额感知分级降级 L0-L3 + Doctor 存储用量第 11 项（根因：回合中被杀丢数据 + 配额满静默失败）；会话 ID 徽标点击复制 + /load 跨会话读取（compacted 双保险不污染历史）+ 上下文窗口设置（50 万–200 万/statusline 跟随/个性化确认保留）；探针 49/49
- [x] G6 会话右键菜单 + ID 识别 + 架构接线（`6c76269`）：复制 ID/重命名/删除 + 发送自动识别会话 ID 直接载入（无需 /load 命令）+ 架构 per-session 接线（工具 args 带 sessionId/架构页按会话过滤//load 挂载提示）
- [x] R3 架构按会话隔离（`e411e91`）：runtime 三分支向后兼容（带 sessionId=独立/不带=旧行为/旧数据命中不新建）+ listBySession/getProjectBySession（/load 挂载用）+ 修 createProject 按 workspace 误去重 bug；29 断言
- [x] chore（`b33ad6e`）：探针隔离目录 gitignore + 截图/shot 脚本与桌宠 metadata/preview 入库 + pet_generate 429 长退避参数

### R11 · 2026-11-14 · 会话并行 + 文件撤销 + 动效重做 + 启动体验（全部已提交）
> 注：R4/R5/X1/X2 提交前缀为 R9-r4/R9-r5/R10-x1/R10-x2（子代理系列沿用旧编号），按本轮批次归入 R11 记录。
- [x] G5 会话级并行聊天（`676000d`）：A 跑 B 聊——busy 降级为活跃会话派生值、stopRequested 按会话独立（中断 A 不误杀 B）、pendingTurns 队列 Map 隔离、流式 painter 支持 mount 重挂与 DOM 中转（切走数据照常累积切回恢复）、审批与 todo_write 按回合归属会话记账、侧栏 N 个会话运行中 pill；探针 29/29 + e2e 74/74 零适配
- [x] R6 文件级撤销（`b196658`）：写前+写后双快照 / sha 防抖 / changed-since 安全预检不盲覆 / 环形 20 / 损坏跳过 / 原子写回 + runtime.undo 门面 + tools.js 注入点（未注入 no-op 向后兼容）；46 断言
- [x] R7 补丁脚本：锚点式预写补丁（失败跳过不盲打 + dry-run 预检），随 G6 提交 `6c76269` 落地，10/10 应用成功
- [x] R8 全应用动效重做（`d3f2617`，emil 五技能方法论）：63 keyframes 审计（保留重做 39/删 24/新增 4）、三曲线三档时长统一、退场收束、origin-aware 菜单、按压态/焦点环/stagger 封顶、性能修复（阴影重绘与 drop-shadow 滤镜改 opacity 与 stroke）、18 个 reduce 块收敛为 1、打断与重放缺陷修复 + 一键应用脚本（备份/回滚/dry-run）；dry-run 全命中
- [x] R4 发版字节校验（`a428706`，ruflo verify 模式）：sha256 清单原子写 / 流式哈希 110MB 不整读 / 篡改 1 字节精确定位 / 中文路径 + release.js 后验自动 buildManifest+verify+--verify 子命令；26 断言 + 真实 exe 闭环
- [x] R5 autopilot 无人值守（`00b1764`，ruflo 移植）：循环状态机（queued/paused 推进/超时巡检/连续 2 失败自动停/maxIterations 停/环形决策 50/不虚构新任务安全边界）+ main.js 接线（autopilot:state IPC + before-quit stop）；37 断言
- [x] X1 PII 三处接线（`53a679d`）：通知 strict 凭据 BLOCK / 导出 standard 脱敏 + 计数 toast / 崩溃日志 standard + targetPath 程序化导出 + 经验库 IPC（lessons:summary/tail，Doctor⑨可达方案）；mock20 + 探针 12 全过
- [x] X2 经验 Hybrid 检索（`038311e`）：searchLessons 双路检索 + relatedLessonsForTask 双路关联（结构 taskId/前缀/tag + 语义关键词，去重取高分，verified/tainted 门槛照旧），空库/故障注入绝不抛错；lessons-check 101/101
- [x] Y1+Y2 启动画面 + 启动提速 + 说话强化 + 清单常驻（`5821f6c`）：纯 CSS 首帧可见 + 就绪渐隐 + 异常兜底；立即显示/boot-stages 阶段打点/非关键初始化延后；UI 叙述行兜底 + 系统提示硬约束；任务清单右上角常驻（默认展开/计数徽标/记忆收起）+ 工具行 mcp 前缀 fallback

### R12 · 2026-11-14 · 截图驱动验收系统（未提交）
- [x] 视觉回归体系（`node tools/shot-suite.js`，通用引擎 + `tools/shot-profiles/dsh.json` 档案）：**需先 `--update` 建基线**（当前渲染 = 期望），此后每次改动跑对比，9 场景像素差异率 > 0.5% 即 CHANGED 并出 diff 图与 shots-output/gallery.html 报告

### R13 · 2026-11-14/15 · 文件存储 + 会话隔离 + 分段渲染（已提交）
- [x] 真值源迁到 `userData/dsh-storage.json`（persist-store：原子写/去抖/flush/损坏自愈），修掉「换构建方式聊天记录全丢」
- [x] TDZ 修复：`msgStore/msgSeq/registerMsg` 前移到 `loadSavedSessions` 之前
- [x] 架构会话隔离：`ensure` 带 `sessionId`，缓存键加会话维度
- [x] 工具卡片分段渲染（说明段→卡片→说明段）+ 每步开口 nudge + 思考强度（reasoning_effort）
- [x] README / docs/HANDOFF.md 同步

### R14 · 2026-11-15 · 安全审计整改（两轮审计 16 项）
> 审计结论：问题不是缺功能，而是「旧执行系统与新 Runtime 并存」导致的治理不一致。
- [x] **统一治理内核**（`lib/tool-gateway.js`）：`tool:exec` 与 `mcp:tool:call` 不再有独立审批通道，统一走 policy + 主进程原生确认框 + 审计链；移除对渲染层 `approved:true` 的信任
- [x] **取消即中断**：`Runtime` 按 runId 持有 AbortController → 执行器注入 signal → 命令杀进程树 / fetch 中断 / 写文件原子化；取消后工具落 `unknown` 而非假装没跑
- [x] **重启对账**：`StateStore._reconcileFromEvents()` 以事件链为真值补齐快照，消除「重复终态事件」与状态漂移；`readAll` 游标分页取代 `limit: 5000` 截断
- [x] **SSRF 完整化**（`lib/net-safety.js`）：DNS 解析结果校验 + 手动逐跳重定向 + IPv4/IPv6 全段覆盖，策略层与执行层同源判定
- [x] **边界加固**：workspace realpath 归一 + 写文件原子替换；`run_command`/MCP 子进程改环境变量白名单（不再继承主进程密钥）
- [x] **容量与调度**：persist-store 整库 64MB / 4000 键上限；队列按 priority + 老化排序；Autopilot 进度落盘可恢复；经验库关联检索排除污染记录
- [x] **审批一致性**：审批凭证绑定 toolCallId + runId + actionHash + TTL，过期就地清扫
- [x] 新增 `tools/runtime-governance-check.js`（36 断言）+ `docs/security/policy-model.md`
