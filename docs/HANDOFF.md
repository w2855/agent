# DSH Desktop 任务交接提示词（新会话直接粘贴本文件全文即可续跑）

> 更新于 2026-11-15（R15 完成）。R13「文件存储/会话隔离/分段渲染」、R14「安全审计整改 16 项」、R15「第三轮审计 A1–A13」均已提交。

## 一、项目与路径
- 应用：E:\dsh-desktop（Electron 纯 JS，零 npm 运行时依赖，中文 AI agent 桌面应用「DSH Desktop」）
- 远端：https://github.com/w2855/agent（main；GitHub 访问走本机代理 127.0.0.1:7877）
- 启动：`npx electron .`（开发）/ 桌面快捷方式 → release\DSH-Desktop-0.1.0.exe（打包版为 R13 构建，R14/R15 改动需重新打包）
- 验收：`node tools/run-all.js`（五段聚合：语法 + runtime + lib 自检 7 套（含 r15-check 47）+ Electron 探针 + e2e 74）——最近一次全绿
- 打包：`node tools/release.js`（无参数=构建+字节校验；**--verify 只校验不构建**，别误用）
- 文档：docs/WORKFLOW.md（R0-R15 轮次 + 回归基线）、docs/security/policy-model.md（治理模型契约）、docs/security/audit-r15.md（第三轮审计报告与修复落点）、docs/e2e-guide.md、docs/feature-gap-analysis.md、docs/pet-paused.md、tools/RELEASE.md、README.md

## 二、git 状态（干净）
- 单线 main，工作树 0 未提交，全部历史已推送（密钥终扫全历史干净）
- git 身份：仓库级 user.name=dsh-workflow / user.email=workflow@local（之前丢过一次，丢失时按此重设）

## 三、R15 已交付（第三轮审计整改 A1–A13，本轮核心）
> 审计报告：`docs/security/audit-r15.md`（含证据、影响、修法）；回归断言：`tools/r15-check.js` 52 项。
> 审计方向：Context Engine / Model Adapter / Delegation 深层 / Renderer XSS-IPC / Backup。

1. **A1 档位权威收归主进程**（P0）：新增 `lib/permission-authority.js`（纯函数裁定）。
   渲染层传的 `permission` / `profile` 只是「请求」，只能比权威值（`dsh.perm`）更严格；
   提升到 full 需主进程原生确认框（`--shot`/`--script` 一律拒绝）；`dsh.perm` 禁止走通用
   storage 通道（set / set-many / remove 三处挡住，否则删键即等于提权）。
   `runtime.evaluateTool` 补 Agent 档位收敛，与 `executor.execute` 同源。
2. **A2 技能目录专用通道**：`skills:open-dir`（realpath 归一 + `shell.openPath`），
   删除「`run_command` + 硬编码 `permission:'full'`」的越权路径。
3. **A3 委派失败回滚**：配额判定前置到自动创建 Agent 之前；autoCreate 之后的失败统一
   `rejectAfterCreate` → `state.deleteAgent`（有引用则归档）+ `delegation.rollback` 事件。
   修掉「单 Run 委派满 5 次后每次越界都留一个 active 孤儿 Agent」。
4. **A4 上下文压缩重做**：`set` 覆盖 → 追加语义（早期摘要在第二次压缩后不再丢）；
   单条 120→400 字符；摘要池 24000 上限（头 30% + 尾）；保留工具名与目标锚点。
5. **A5 预算口径修正**：默认 700000→120000 字符（≈12 万 token，对 128k 窗口安全）、
   上限 2000000→400000、旧超大值回落默认；自动压缩阈值 90%→75%。
   （R16 再放宽：上限 400000→1000000；旧数值保留作为当时轮次记录。）
6. **A6 子代理上下文预算**：`trimChildMessages`（120000 字符）+ `repairToolPairs`
   （裁剪后修 tool_calls/tool 配对，避免上游 400）+ 检查点只存最近 40 条（消除 O(n²) 写盘）；
   无 `usage` 时用字符估算兜底计入 `maxTokens`（兼容网关不返回 usage 时预算才真正生效）。
7. **A7 备份补全**：源从「经验库 + 水位」扩到 `dsh-storage.json` / `state.json` / `audit/`
   （目录递归，`cpSync`）/ 最近 3 天事件分片；新增 `backup:list` / `backup:open`（防穿越）；
   设置页「数据备份」卡片显示最近一份并可打开目录。
8. **A8 SSE 缓冲上限**：4MB，超限按 `STREAM_ERROR` 收尾（此前只保护已解析正文）。
9. **A9 规划器接线**：`lib/context-plan.js` 经 preload 透传，接入 `forModel` 的超预算提示
   （不再是自己拍脑袋截断 + 一句「已截断」）。
10. **A10 token 估算统一**：新增 `lib/token-estimate.js`（中文 1 字≈1 token，其它 4 字符≈1 token），
    替换渲染层与子代理的 `length/4`（中文场景此前低估 4–6 倍）。
11. **A11 误判（复核后撤回）**：原报告称「子代理审批无 UI 入口」，实际 `#delegApprovals` 早已是
    事件驱动的一条完整链路（容器 + 卡片 + `decideDelegationApproval` 回传 + 过期清理）。
    本轮曾加了一套轮询投影，与既有机制双写并打断 e2e 时序，已全部撤回；`r15-check` 改为守护既有实现。
12. **A12 退避可中断**：子代理重试改用 `retry.sleep(ms, signal)`，取消时不再多等 2.4 秒。
13. **A13 仓库清理**：取消跟踪 `tools/patches/__pycache__` 与旧 `app.js` 副本；
    `.gitignore` 去掉重复项并补 `__pycache__/`、`*.pyc`、`tools/patches/backup/`。
14. **A17 门禁隔离失效**（收尾验证时发现）：`.runall-probe` 清不干净，上一轮 `dsh.perm` 会漏进下一轮。
    网关日志改写到 `os.tmpdir()`；清理改为「回读校验 + 清不掉就整目录改名让开」；
    并把「隔离 userData 已清空」作为一条门禁行暴露（全量由 24 项变 25 项）。

### 工具集补全（审计收尾后追加，v1 工具从 9 个到 14 个）
用户实测反馈「工具不全，比如读任务输出」——对照 ZCode 3.17.2（内置 33 个，本机实跑发 35 个 + 250 个 MCP）
补了三类最缺的：

| 新增 | 为什么必须有 |
|---|---|
| `edit_file` | 改一行不用整篇重写。以前只能 `write_file` 全量覆盖 3000 行文件：贵、且记错内容就静默改坏 |
| `find_files` | `search_files` 搜内容、`list_dir` 只看一层，「项目里所有 *.test.js 在哪」无法回答 |
| `run_command` `background:true` | 同步上限 180 秒，dev server / watch / 长测试只能超时被杀、输出丢失 |
| `task_output` / `task_stop` / `task_list` | 后台任务的读输出（游标续读）、停止、列表——即用户说的「读任务输出」 |

实现要点：
- `lib/tasks.js` 新模块：绝对偏移记账（环形裁剪后 offset 仍有效）、每任务 200KB 上限、结束保留 30 分钟、
  最多 16 个、2 小时生命上限、`before-quit` 统一 `stopAll`（否则关窗留孤儿进程）。
- `edit_file` 三条硬规则：找不到 → 报错不动文件；多处匹配 → 报错要求扩大上下文或 `replace_all`；
  换行风格跟随文件（CRLF 文件里不混入孤立 LF）。
- 权限分层：`edit_file` 需审批（同 write_file）；`task_output`/`task_list` 属只读；
  `task_stop` 只读模式拒绝、ask 模式不弹框（只能停本应用起的任务）。
- 治理元数据两处都要补：`TOOL_META`（UI 显示）+ `runtime/tool-registry.js`（策略层）。
  漏了后者会退化成 risk=high + defaultApproval=ask —— 读工具也会莫名弹审批。
- 自检：`tools/tools-check.js`（36 断言，含真实文件与真实后台进程）；
  `runtime-foundation-check` 的「注册表含 9 个工具」改为「覆盖全部内置工具」，新增工具不该靠改数字过门禁。

仍未对齐 ZCode 的能力（未做，按价值排序）：`AskUserQuestion`（agent 无法在回合中提问，只能猜）、
`WebSearch`（只有 `fetch_url`，无法发现 URL）、`TodoRead`（清单只能写不能读）、
`LSP` / `NotebookEdit` / 计划模式（`EnterPlanMode` / `ExitPlanMode`）/ `Cron*`。

### R15 行为变化（交付说明）
- 切到「完全权限」会弹一次主进程原生确认框；无头模式提权一律被拒（v2-check 已按新语义断言）。
- 上下文窗口默认 120000 字符，可设 4000–1000000（设置页有 1 万/6 万/12 万/40 万/100 万预设）；存过超大旧值的用户会回落新默认（避免继续撞上限）。主进程 `MAX_INPUT_CHARS` 同步抬到 1100000，否则设置里允许 100 万、发请求时仍被旧上限拒收。
- 备份体积变大（多备会话存储/任务状态/审计目录/3 天事件），保留仍 7 份。
- 子代理需要审批时会出现时间线卡片（既有实现，本轮未改）。
- 探针规范：需要「更严档位」时只改渲染层请求值（`requestPerm`），不要再动主进程权威值——
  无头模式不能提权，先把权威值降下去就升不回来。

## 四、R14 已交付（安全审计整改 16 项）
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

## 五、R13 已交付
1. 文件存储后端（真值源 `userData/dsh-storage.json`，persist-store 原子写/去抖/损坏自愈）
2. TDZ 重大修复（`msgStore/msgSeq/registerMsg` 前移到 `loadSavedSessions` 之前）
3. 架构会话隔离（ensure 带 sessionId + 缓存键加会话维度）
4. 工具卡片分段渲染（说明段→卡片→说明段，bodySegments 快照）
5. 叙述行三段规则（工具执行中「正在 …」/ 间隙「模型正在思考下一步…」/ 出声即让位），已降级为 `data-role="ui-status"` 的防空白占位，不算模型发言
   R16-b：【边做边同步】规范进主聊天提示 + 子代理 `buildMessages`（自定义 systemPrompt 也不能绕过）；
   连续 3 步零正文才注入一条一次性提醒（请求读完即撤、不落历史/正文），模型开口即清零。
6. 模型思考强度（reasoning_effort，主聊天 + 子代理双注入，off 不发）
7. README.md

## 六、专项探针（tools/，均绿）
- 新增 governance 36/36（治理/取消/对账/分页/容量/Autopilot/SSRF/环境变量/队列）
- 新增 tools-check 36/36（工具清单/元信息/edit_file/find_files/后台任务全链路）
- f1 17/17、g5 29/29、g3 44/44、dyn 36/36（两相位：arch 14 + todo 22）、tool-e2e 75/75、effort-probe 3/3
- arch-iso 7/7、narrate-live 11/11、narrate-gap 5/5、persist-write/read、storage-check 8/8、storage-probe 20/20、abort-check 11/11
- R16 新增：autonomy 12/12（说话自主判断 / 无 nudge / 多步自动连跑）、ctx-budget 8/8（100 万上限 / 96 条消息不再报「82 > 80」/ 预算裁历史）、tool-args 16/16（工具参数带 fences/dup/对象、缺参可重试、Windows 无 head 时改用 find_files 提示）、upstream-error 14/14
- R16 新增 `tools/with-mock.js`：自动起停 mock 网关跑单个探针，跑完即退，不留后台进程
- R16-b 新增：sync-narration-probe 23/23（连续静默轨迹 `0,0,0,1,0,0,1`、开口后 `0,0,0,1,0,0,0`、提醒不落历史/正文）、sync-child-check 16/16（主聊天/子代理提示一致、提醒不进检查点、占位降级）

## 七、当前待办（按优先级）
1. **用户实测复验**：①架构会话隔离 ②工具卡片上面说话 ③思考强度 ④聊天记录保留（R14 已重新打包后复验）⑤**新增：ask 档工具现在弹主进程原生确认框**（降级通道），主路径仍在应用内卡片
2. **桌宠恢复**（用户暂停中）：恢复手册 docs/pet-paused.md；条件=6780 网关生图配额刷新
3. runtime-ipc-check 探针需 Electron `--script` 通道（run-all 跳过项），可补入 Electron 段
4. G5 审批串行化边界（withApprovalLock 全局串行）——冻结项已知限制，不动
5. 下一轮审计建议（未做）：Context Engine（上下文丢失/Token 预算）、Model Adapter（超时/重试/流式中断）、Delegation 深层与循环、Renderer XSS/IPC 边界

## 八、约束（不可违反）
- 全程中文交流；委派/审批机制冻结（只读消费事件）；桌宠暂停
- 密钥安全：`<管理密钥字面量>` 与 `zk2-…` 绝不入库（字面量引用也不行）；提交前 `git grep <字面量> $(git rev-list --all)` 必须为空；密钥走环境变量或主进程 safeStorage
- 动效遵循 Motion Tokens（styles.css 尾部）+ reduced-motion 全兜底
- 渲染层不再拥有审批权：任何「加个 approved 参数就放行」的改动都视为回归
- **渲染层也不再拥有档位权（R15）**：任何「让渲染层直接决定 policy profile」的改动都视为回归；
  `dsh.perm` 只能经 `permission:set` 写，通用 storage 通道必须继续拦住这个键

## 九、已知坑（全踩过，勿重蹈）
1. **ELECTRON_RUN_AS_NODE**（R14 新坑，坑掉一整轮门禁）：宿主 IDE/agent 会设 `ELECTRON_RUN_AS_NODE=1`，electron 退化成纯 Node → `app` undefined → 5 个探针全假失败。聚合器已剥离；手工跑用 `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron ...`
2. **JSON/Python 转义**：bash heredoc 里 `\\n` 多层转义会变真实换行 → 用 chr(92) 构造 + repr 验字节 + 行级 splice
3. **打包锁**：输出 exe 被运行中的应用锁住 → 构建超时。打包前确认 DSH 进程已关闭
4. **mock 网关残留**：跑探针前杀净旧 mock-gateway 再起
5. **探针时序竞态**：mock 秒回会让「生成中/中断」断言踩空 → 用 `[[slow]]`/`[[narrslow]]`
6. **探针盲区**：`--script` 在 did-finish-load 后跑，模块顶层 TDZ / 启动路径测不到 → 双实例跨重启探针才是铁证
7. **GPU 驱动间歇崩溃**：测试模式已禁硬件加速；用户真实启动偶发卡加载属环境问题
8. **`console.log` 不透传 stdout**（`--shot`）：启动期诊断存 window 全局变量
9. **事件游标**：分页必须先判「页满」再推进游标，否则跨页丢事件（R14 修过一次，改 read 时注意）

## 十、验收命令速查
```bash
node tools/run-all.js                    # 全量门禁（含 tool-call-guard / no-reason / upstream-error / narrate / autonomy / ctx-budget / tool-args 探针）
node tools/run-all.js --quick            # 快速门禁（跳过 Electron 探针）
node tools/with-mock.js --shot --user-data-dir=.verify-x --script=tools/xxx-probe.js   # 自动起停 mock 网关跑单个探针，跑完即退
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe tools/key-diag.js   # 凭据诊断：解密 profiles.bin + 逐档案打真实网关（401 排查第一步）
node tools/runtime-governance-check.js   # 只跑治理/一致性 36 断言
node tools/r15-check.js                  # 只跑 R15 整改 52 断言
node tools/tools-check.js                # 只跑工具集 36 断言（含真实后台进程）
node tools/release.js                    # 打包+字节校验（先关应用）
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --user-data-dir=.s-x --shot --script=tools/xxx-probe.js
node tools/mock-gateway.js               # mock 网关 127.0.0.1:57321（[[slow]] [[narrslow]] [[narr]] [[many]] [[write]] [[read]] [[arch]] [[force]] [[tamper]] [[noaccounts]] [[badkey]] [[http403]] [[nudgecount]] [[argsfence]] [[argsdup]] [[argsobj]] [[argsnone]] [[argsjunk]] [[winbash]] [[silentN]] [[speakN]]）
git -c http.proxy= -c https.proxy= push origin main   # 推送（直连；7877 代理已不可用）
```
