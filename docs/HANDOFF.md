# DSH Desktop 任务交接提示词（新会话直接粘贴本文件全文即可续跑）

## 一、项目与路径
- 应用：E:\dsh-desktop（Electron 纯 JS，零 npm 依赖，中文 AI agent 桌面应用「DSH Desktop」）
- 启动：`npx electron .`（开发）/ 桌面快捷方式 → release\DSH-Desktop-0.1.0.exe（打包）
- 验收：`node tools/run-all.js`（聚合器：语法 52 文件 + runtime 回归 339 + lib 自检 6 套 + Electron 探针 5 个 + e2e 74 项）
- 文档：docs/WORKFLOW.md（R0-R11 全轮次）、docs/e2e-guide.md、docs/feature-gap-analysis.md、docs/pet-paused.md、tools/RELEASE.md、tools/patches/ANIMATION-REDESIGN.md

## 二、git 状态（⚠️ 本会话末尾发生过 rebase 中断+reset，必须先审计恢复）
- 当前 HEAD = 31aaa7e（R12-chore 429 参数），工作树含部分未提交内容
- **已知两条历史线**：
  - 线 A（当前 HEAD 祖先）：含全部功能提交至 R12-chore，但**缺**以下内容：R3 架构会话隔离 runtime 侧（e411e91）、R6 文件撤销（undo 三件套）、G6 补丁应用（6c76269）、R11 动画重做包应用（d3f2617）、X1 PII 接线（53a679d）、X2 经验检索（038311e）、X3 related 经验（d7c388f）、X4 文档（13c7fca）、Q2 PII 管线（e0f39a1）——这些提交在另一条线上
  - 线 B（清洗线，tip ≈ 9eae0a9 之后延续到 7f4dfa1/31aaa7e 附近，经 reflog 可达）：含密钥清洗（sk-chatgpt2api-admin-<截断，即管理密钥> 已全历史 REDACTED）+ X5 截图系统（7f4dfa1）
- **恢复步骤（第一步必做）**：
  1. `git reflog | head -30` 与 `git log --all --oneline | head -40` 盘点两线尖端
  2. 内容合并策略：以内容最全的工作树为准（当前树已含 G5/G6/R8/Y1Y2 的文件内容，直接 `git add -A && git commit` 快照），然后用 `git merge` 或孤儿分支归一历史
  3. **密钥终扫**：`git grep "<管理密钥字面量>" $(git rev-list --all)` 与 `-S` 扫描必须为空（字面量本身不得入库，见安全约束）（线 A 的 690ac84 曾含密钥，线 B 已清洗）
  4. 远端 origin = https://github.com/w2855/agent（已有占位 Initial commit）→ 内容确认后 `git push -u origin main --force-with-lease`（用户已明确授权上传此仓库）
- 探针隔离目录 .s-*/、.shot-run/、.diag-x/ 已 gitignore/可删；不要提交任何 userData 目录

## 三、已交付并验证的功能（回归全绿时这些都在）
- 核心修复：流式渲染增量更新（O(n²)→稳定块+活动尾）、msgStore 泄漏、GFM 表格渲染、零依赖语法高亮（七语言）、自动上下文压缩（90%阈值）、主题跟随系统、toast 队列、保存加固（立即落盘+dirty+30s+分级降级 L0-L3+beforeunload）
- 会话级并行聊天（G5）：A 跑 B 聊、busy 会话级、中断按会话隔离、流式 painter mount 重挂、侧栏运行中 pill
- 安全：密钥主进程化（掩码视图+profileId 解析）、PII 四档管线（BLOCK/REDACT/HASH/PASS）、单实例锁、崩溃恢复（软渲染自愈）、下载执行变体检测、workspaceOnly 校验、end 后事件抑制
- 系统集成：OS 通知（tag 去重）、托盘、会话导出 md/JSON、发版字节校验（release/manifest.json + verify）、Autopilot 无人值守循环（连续 2 失败自动停）、经验库 verified-lessons + Hybrid 检索 + related 注入、成本预算硬停三窗口、文件级撤销（写前快照+changed-since 预检）
- UX：ZCode 式设置页 9 pane（含 Doctor 体检 11 项+MetaHarness 配置评分）、Statusline 状态条、Pair 协作模式（TDD/评审/导师）、任务 verifying/blocked 三态、Ctrl+F 高亮查找、选区浮动菜单、右键会话菜单（复制 ID/重命名/删除）、粘贴会话 ID 自动载入、失败重试按钮、消息/代码块复制、差异化开合动效+Motion Tokens 体系、任务清单右上角常驻
- 401 修复（F2，真实端到端 5/5 过）：子代理密钥经 main 进程 resolveSecretKey 解析（掩码→真钥），跨接入点委派（delegate_task 可选 profileId 选任意连接的模型）
- 19 个 emil 动效技能已装（我的 %APPDATA% 同级 .agents/skills 与 DSH skills 目录）

## 四、已确认未修 bug（下一批首项）
1. **聊天记录不保存（深层根因未修完）**：表层（saveSessions 时序）已修，但**深层根因 = localStorage 按 origin 键控**——开发版 origin（file:///E:/dsh-desktop/renderer/index.html）与打包版 origin（app.asar 内路径）不同 → 两套 localStorage，换构建方式历史必丢。T4 只统一了 userData 目录（不够）。
   **修复方案（已设计待实施）**：关键数据迁移出 localStorage → 文件存储 userData/dsh-storage.json（IPC 读写，origin 无关）。实施：main.js 加 storage:get/set/keys IPC + 启动时读文件经 preload bootstrap 传入渲染层 → renderer 的 readStorage 改读内存镜像、writeStorage 走 IPC 异步写文件+同步更新内存镜像（保持 sync 读语义）→ 首次启动把现有 localStorage 全量迁移进文件后清除。注意 storage 含 dsh.sessions.model/preview、dsh.conn、dsh.apis（掩码）、dsh.theme2、dsh.customPrompt 等全部 dsh.* 键。
2. **叙述重复两遍**：F1 已修主体（streamed 标记+提示词收紧）——若用户仍复现，查多步回合 firstChunk 逻辑与 pair 模式叠加注入。
3. **视频壁纸报错**：F1 已加固（句柄释放/格式识别/自动降级）——若仍报错，查 main.js wallpaper IPC 的具体报错日志（crash-log.jsonl）。
4. **会话独立架构丢失恢复**：R3 runtime 侧已提交（e411e91，在另一条线上！）——恢复后 renderer 接线四步见 R3 报告：project_architecture args 带 sessionId、arch 页按 sessionId 过滤、/load 挂架构、项目名带短码。
5. **会话级并行聊天恢复**：G5 已提交（676000d，在另一条线上！）——恢复后回归 g5-probe 29 项。
6. **桌宠**：暂停归档（docs/pet-paused.md 五步恢复手册）；恢复条件 = 6780 网关生图配额刷新（当时报 insufficient_quota）；**网关已支持原生动画参数**（frame_count/frame_duration_ms/output_format=gif，一次请求直出动画，不再需要 280 关键帧方案）。

## 五、验证体系
- run-all 五段（语法/回归/自检/探针/e2e），--quick 跳过 Electron 段
- 截图驱动验收（X5，通用化）：`node tools/shot-suite.js --profile dsh`（8 场景）/ `--url http://... --name xxx`（任意网页）/ `--update` 建基线 / gallery.html 可视化；pixdiff 像素对比阈值 0.5%
- 单项探针：t1（保存/ID/上下文）、dyn（架构/任务两相位）、g3（密钥/查找/选区）、g4（Doctor/Statusline/Pair/三态）、g5（会话并行 29 项）、mcp-ui、f1-probe（三 bug 回归）、y2-probe（启动阶段）
- 已知环境坑（全部记录在 docs/e2e-guide.md）：GPU 驱动间歇崩溃→测试模式已禁硬件加速；GitHub 直连间歇超时→ELECTRON_MIRROR=npmmirror；10ms GIF 帧被浏览器钳制→统一 20ms；并发代理同文件编辑→锚点式补丁脚本模式

## 六、约束（不可违反）
- 全程中文交流；委派/审批机制冻结（只读消费事件）；桌宠暂停（恢复手册齐备）
- 密钥管理：所有 key 走环境变量或主进程保管，任何提交前跑密钥扫描（见二.3）
- 动效遵循 Motion Tokens（styles.css 尾部）+ reduced-motion 全兜底 + Emil 方法论（.agents/skills 五技能）
- 新功能走锚点式补丁脚本模式（tools/patches/apply-*.py）当 renderer 被并行占用时

## 七、下一批优先级
1. git 两线合并恢复（二.恢复步骤）→ 密钥终扫 → 推 GitHub
2. 文件存储后端实施（四.1 方案）→ 根治聊天记录不保存
3. 会话独立架构 renderer 接线（四.4）
4. F1 三 bug 用户复验（若已修不复现则关闭）
5. 桌宠恢复（等配额）
