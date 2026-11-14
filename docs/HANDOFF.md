# DSH Desktop 任务交接提示词（新会话直接粘贴本文件全文即可续跑）

> 更新于 2026-11-15。此前版本的「git 两线合并」与「九个缺失提交」描述已过时——实际为单线，全部提交在线上且已推送。

## 一、项目与路径
- 应用：E:\dsh-desktop（Electron 纯 JS，零 npm 运行时依赖，中文 AI agent 桌面应用「DSH Desktop」）
- 远端：https://github.com/w2855/agent（main 已推送，最新 dc95bd5 + README；GitHub 访问走本机代理 127.0.0.1:7877）
- 启动：`npx electron .`（开发）/ 桌面快捷方式 → release\DSH-Desktop-0.1.0.exe（打包，00:18 新包含全部修复）
- 验收：`node tools/run-all.js`（五段聚合：语法 59 + runtime 回归 339 + lib 自检 6 套 + Electron 探针 + e2e 74）——最近一次全绿
- 打包：`node tools/release.js`（无参数=构建+字节校验；**--verify 只校验不构建**，别误用）
- 文档：docs/WORKFLOW.md（R0-R11 轮次）、docs/e2e-guide.md、docs/feature-gap-analysis.md、docs/pet-paused.md、tools/RELEASE.md、README.md

## 二、git 状态（干净）
- 单线 main，工作树 0 未提交，全部历史已推送（密钥终扫全历史干净）
- git 身份：仓库级 user.name=dsh-workflow / user.email=workflow@local（之前丢过一次，丢失时按此重设）

## 三、R13 已交付（本轮，全部在 GitHub）
1. **文件存储后端**（根治「换构建方式聊天记录全丢」第一层根因）：真值源 userData/dsh-storage.json，persist-store 纯 Node 键值库（原子写/去抖/退出 flush/损坏自愈），preload sendSync 快照 + renderer 内存镜像 + localStorage 双写 + legacy 独有键自动迁移
2. **TDZ 重大修复**（第二层根因，用户质疑复验发现）：启动恢复 loadSavedSessions 调用 registerMsg，而它是 const 声明在其后 → ReferenceError 被 catch 静默吞掉 → 空会话覆盖历史。msgStore/msgSeq/registerMsg 三件套已移到 loadSavedSessions 之前
3. **架构会话隔离**（真实根因）：架构页打开时 ensure 只传 workspace 不传 sessionId → 建出共享项目全会话可见。ensure 带 activeId + loadProject 缓存键加会话维度
4. **工具卡片上面说话（分段渲染）**：多步回合 DOM 从「全部卡片堆上+文字沉底」改为「说明段→卡片→说明段→卡片」交替（bodySegments 按 bodyAtStart 快照切段，流式只画最后段）；liveTurn 用 handler.draft 引用精确判定；FIND_SKIP 用 :not(.seg-box)（分段后 prose 嵌在 .tools 内被查找误拒的坑）；收尾 4 路径适配
5. **每步开口结构性保证**：工具结果回传后动态注入 system nudge（__nudge 防累积，稳定 ≤1 条），配合系统提示「每步先说明再调用」
6. **模型思考强度**：连接表单选择（关闭/低/中/高 = reasoning_effort），随接入点存储，主聊天+子代理委派双请求注入（off 不发参数）
7. **README.md** 已写入并推送

## 四、专项探针（tools/，均绿）
- persist-write/read（双实例持久化铁证）、storage-check 8/8、storage-probe 20/20
- arch-iso 7/7（架构隔离）、narrate-live 4/4（工具说话实时性，[[narrslow]] 慢速多步场景）、narrate-gap 5/5
- f1 17/17、g5 29/29、g3 44/44、dyn 36/36、tool-e2e 74/74、effort-probe 3/3
- 已适配：abort-check 11/11（G5 后语义：pendingTurns/pendingQueue 会话级 Map、mock 连接自备、[[slow]] 触发词）

## 五、当前待办（按优先级）
1. **用户实测复验**（新 exe 00:18 构建已交付）：①架构会话隔离 ②工具卡片上面说话（交替+间隙呼吸态）③思考强度设置 ④聊天记录保留（重启/换构建）。**等用户反馈，不符则按现象修**
2. **桌宠恢复**（用户暂停中）：恢复手册 docs/pet-paused.md；条件=6780 网关生图配额刷新；网关已支持原生动画参数（frame_count/frame_duration_ms/output_format=gif 一次直出）
3. runtime-ipc-check 探针需 Electron --script 通道（run-all 里跳过项），可补入 Electron 段
4. G5 审批串行化边界（withApprovalLock 全局串行）——冻结项已知限制，不动

## 六、约束（不可违反）
- 全程中文交流；委派/审批机制冻结（只读消费事件）；桌宠暂停
- 密钥安全：sk-chatgpt2api-admin-… 与 zk2-… 绝不入库（字面量引用也不行，文档里写「<管理密钥字面量>」）；提交前 `git grep <字面量> $(git rev-list --all)` 必须为空；密钥走环境变量或主进程 safeStorage
- 动效遵循 Motion Tokens（styles.css 尾部）+ reduced-motion 全兜底
- 多代理并行改 renderer 时用锚点式补丁脚本（tools/patches/apply-*.py 模式）

## 七、已知坑（全踩过，勿重蹈）
1. **JSON/Python 转义**：bash heredoc 里 `\\n` 经多层转义会变真实换行破坏 JS 字符串 → 用 chr(92) 构造 + repr 验字节 + 行级 splice
2. **打包锁**：输出 exe 被运行中的应用锁住（virus scanner waiting）→ 构建超时。打包前确认 DSH 进程已关闭
3. **mock 网关残留**：跑探针前按 docs/e2e-guide.md 杀净旧 mock-gateway 再起，验证唯一性
4. **探针时序竞态**：mock 秒回会让「生成中/中断」断言全踩空 → 用 [[slow]]/[[narrslow]] 慢流触发词；插话新回合用 busy 细捕捉+summaries 判定（工具回合步骤间 activeTurnId 会清空）
5. **探针盲区**：--script 在 did-finish-load 后跑，模块顶层 TDZ/启动路径问题测不到 → 双实例跨重启探针（persist-write/read 模式）才是铁证
6. **GPU 驱动间歇崩溃**：测试模式（--shot/--script）已禁硬件加速；用户真实启动偶发卡加载属环境问题
7. **console.log 不透传 stdout**（--shot 模式）：启动期诊断改存 window 全局变量由探针读取

## 八、验收命令速查
```bash
node tools/run-all.js                    # 全量门禁
node tools/release.js                    # 打包+字节校验（先关应用）
npx electron . --user-data-dir=.s-x --shot --script=tools/xxx-probe.js   # 单探针（mock 网关先起）
node tools/mock-gateway.js               # mock 网关 127.0.0.1:57321（触发词 [[slow]] [[narrslow]] [[narr]] [[many]] [[write]] [[read]] [[arch]] [[force]] [[tamper]]）
git -c http.proxy=http://127.0.0.1:7877 push origin main   # 推送（走代理）
```
