# DSH Desktop 任务交接提示词（新会话直接粘贴本文件全文即可续跑）

> 更新于 2026-11-15（R14 完成）。R13 的「文件存储 / 会话隔离 / 分段渲染」与 R14 的「安全审计整改 16 项」均已提交。

## 一、项目与路径
- 应用：E:\dsh-desktop（Electron 纯 JS，零 npm 运行时依赖，中文 AI agent 桌面应用「DSH Desktop」）
- 远端：https://github.com/w2855/agent（main；GitHub 访问走本机代理 127.0.0.1:7877）
- 启动：`npx electron .`（开发）/ 桌面快捷方式 → release\DSH-Desktop-0.1.0.exe（打包版为 R13 构建，R14 改动需重新打包）
- 验收：`node tools/run-all.js`（五段聚合：语法 61 + runtime 375 + lib 自检 6 套 + Electron 探针 + e2e 74）——最近一次全绿
- 打包：`node tools/release.js`（无参数=构建+字节校验；**--verify 只校验不构建**，别误用）
- 文档：docs/WORKFLOW.md（R0-R14 轮次 + 回归基线）、docs/security/policy-model.md（治理模型契约）、docs/e2e-guide.md、docs/feature-gap-analysis.md、docs/pet-paused.md、tools/RELEASE.md、README.md

## 二、git 状态（干净）
- 单线 main，工作树 0 未提交，全部历史已推送（密钥终扫全历史干净）
- git 身份：仓库级 user.name=dsh-workflow / user.email=workflow@local（之前丢过一次，丢失时按此重设）

## 三、R14 已交付（安全审计整改，本轮核心）
> 审计结论：问题不是缺功能，而是「旧执行系统与新 Runtime 并存」导致治理不一致。逐条对应：

1. **P0 统一治理内核**（`lib/tool-gateway.js`）：`tool:exec` 与 `mcp:tool:call` 不再有独立审批通道，统一走 policy（复用 `runtime.evaluateTool`，同一 workspaceId）+ 主进程原生确认框 + 审计链（事件 `tool.gateway`）。**渲染层传 `approved:true` 已完全无效**（自检含伪造用例）
2. **P0 取消即中断**：`Runtime` 按 runId 持 AbortController → 执行器注入 signal → `run_command` 杀进程树 / `fetch_url` 断请求 / `write_file` 原子写；`cancelTask` 先 abort 任务树再改状态；取消后新信号「出生即中止」
3. **P0 副作用不假设**：取消/崩溃时仍 `executing` 的有副作用工具落 `unknown`（`CANCELED_IN_FLIGHT` / `UNKNOWN_OUTCOME`），只能 reconcile 成 succeeded/failed，不再记 failed 或 canceled
4. **P0 重启对账**：`StateStore._reconcileFromEvents()` 以事件链为真值补齐快照 → 消除了「同一 toolCall 两个终态 / 状态漂移」；新增 `runtime.reconciled` 事件
5. **P1 SSRF 完整化**（`lib/net-safety.js`）：逐跳 DNS 全地址校验 + 手动重定向（≤5 跳，opaqueredirect 拒绝）+ IPv4/IPv6 全段覆盖；策略层与执行层同源判定
6. **P1 进程边界**：`run_command` / MCP 子进程改环境变量白名单（不再继承主进程密钥）；MCP 并发 ≤4、参数 ≤256KB、server ≤12
7. **P1 路径边界**：workspace realpath 归一；写文件原子替换
8. **P1 审批一致性**：凭证绑定 toolCallId + runId + actionHash + TTL；过期就地清扫（不再永久卡 waiting_approval）
9. **P1 事件分页**：`EventStore.read` 修游标缺陷 + 新增 `readAll`；架构图 / 收尾校验 / 子代理产物不再被 5000 截断
10. **P1 并发与调度**：队列按 priority + 等待老化排序（此前 priority 存了不用，低优先级会饿死）
11. **P2 存储容量**：persist-store 整库 64MB + 4000 键上限，超限拒绝并暴露 usageRatio
12. **P2 Autopilot 可恢复**：iteration / consecutiveFailures / lastAdvanced 落盘，重启恢复（不自动开跑）
13. **P2 经验库**：关联检索额外过滤 tainted 记录
14. 新增自检 `tools/runtime-governance-check.js`（36 断言）+ `docs/security/policy-model.md`

## 四、R13 已交付（上一轮，全部在 GitHub）
1. 文件存储后端（真值源 `userData/dsh-storage.json`，persist-store 原子写/去抖/损坏自愈）
2. TDZ 重大修复（`msgStore/msgSeq/registerMsg` 前移到 `loadSavedSessions` 之前）
3. 架构会话隔离（ensure 带 sessionId + 缓存键加会话维度）
4. 工具卡片分段渲染（说明段→卡片→说明段，bodySegments 快照）
5. 每步开口 nudge（工具结果回传后注入 system nudge，`__nudge` 防累积）
6. 模型思考强度（reasoning_effort，主聊天 + 子代理双注入，off 不发）
7. README.md

## 五、专项探针（tools/，均绿）
- 新增 governance 36/36（治理/取消/对账/分页/容量/Autopilot/SSRF/环境变量/队列）
- f1 17/17、g5 29/29、g3 44/44、dyn 44/44（两相位）、tool-e2e 74/74、effort-probe 3/3
- arch-iso 7/7、narrate-live 4/4、narrate-gap 5/5、persist-write/read、storage-check 8/8、storage-probe 20/20、abort-check 11/11

## 六、当前待办（按优先级）
1. **用户实测复验**：①架构会话隔离 ②工具卡片上面说话 ③思考强度 ④聊天记录保留（R14 已重新打包后复验）⑤**新增：ask 档工具现在弹主进程原生确认框**（降级通道），主路径仍在应用内卡片
2. **桌宠恢复**（用户暂停中）：恢复手册 docs/pet-paused.md；条件=6780 网关生图配额刷新
3. runtime-ipc-check 探针需 Electron `--script` 通道（run-all 跳过项），可补入 Electron 段
4. G5 审批串行化边界（withApprovalLock 全局串行）——冻结项已知限制，不动
5. 下一轮审计建议（未做）：Context Engine（上下文丢失/Token 预算）、Model Adapter（超时/重试/流式中断）、Delegation 深层与循环、Renderer XSS/IPC 边界

## 七、约束（不可违反）
- 全程中文交流；委派/审批机制冻结（只读消费事件）；桌宠暂停
- 密钥安全：`<管理密钥字面量>` 与 `zk2-…` 绝不入库（字面量引用也不行）；提交前 `git grep <字面量> $(git rev-list --all)` 必须为空；密钥走环境变量或主进程 safeStorage
- 动效遵循 Motion Tokens（styles.css 尾部）+ reduced-motion 全兜底
- 渲染层不再拥有审批权：任何「加个 approved 参数就放行」的改动都视为回归

## 八、已知坑（全踩过，勿重蹈）
1. **ELECTRON_RUN_AS_NODE**（R14 新坑，坑掉一整轮门禁）：宿主 IDE/agent 会设 `ELECTRON_RUN_AS_NODE=1`，electron 退化成纯 Node → `app` undefined → 5 个探针全假失败。聚合器已剥离；手工跑用 `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron ...`
2. **JSON/Python 转义**：bash heredoc 里 `\\n` 多层转义会变真实换行 → 用 chr(92) 构造 + repr 验字节 + 行级 splice
3. **打包锁**：输出 exe 被运行中的应用锁住 → 构建超时。打包前确认 DSH 进程已关闭
4. **mock 网关残留**：跑探针前杀净旧 mock-gateway 再起
5. **探针时序竞态**：mock 秒回会让「生成中/中断」断言踩空 → 用 `[[slow]]`/`[[narrslow]]`
6. **探针盲区**：`--script` 在 did-finish-load 后跑，模块顶层 TDZ / 启动路径测不到 → 双实例跨重启探针才是铁证
7. **GPU 驱动间歇崩溃**：测试模式已禁硬件加速；用户真实启动偶发卡加载属环境问题
8. **`console.log` 不透传 stdout**（`--shot`）：启动期诊断存 window 全局变量
9. **事件游标**：分页必须先判「页满」再推进游标，否则跨页丢事件（R14 修过一次，改 read 时注意）

## 九、验收命令速查
```bash
node tools/run-all.js                    # 全量门禁（23 项：22✓ + runtime-ipc 跳过）
node tools/runtime-governance-check.js   # 只跑治理/一致性 36 断言
node tools/release.js                    # 打包+字节校验（先关应用）
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --user-data-dir=.s-x --shot --script=tools/xxx-probe.js
node tools/mock-gateway.js               # mock 网关 127.0.0.1:57321（[[slow]] [[narrslow]] [[narr]] [[many]] [[write]] [[read]] [[arch]] [[force]] [[tamper]]）
git -c http.proxy=http://127.0.0.1:7877 push origin main   # 推送（走代理）
```
