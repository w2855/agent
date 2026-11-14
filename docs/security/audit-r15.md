# DSH Desktop 第三轮安全与架构审计（R15）

> 审计日期：2026-11-15
> 范围：Context Engine / Model Adapter / Delegation 深层 / Renderer XSS-IPC / Backup，另含仓库卫生
> 方法：静态代码走读（无动态污点分析）+ 关键路径逐行复核 + 现有探针覆盖度对照
> 基线：R14 交付后（HEAD aad5a61），门禁 23 项全绿
>
> **状态：A1–A13 与 A17 已全部修复（R15 交付）。** 逐条修复落点见第九节；回归断言见 `tools/r15-check.js`（48 项）。
> A14–A16（P3）留待后续。

## 零、结论摘要

R14 修好了「治理链的入口」（审批），但**同一条链上的两个环节仍是调用方自报**：
权限档位由渲染层传入（A1）、备份漏掉了全部关键状态源（A7）。
Context Engine 的三处问题（A4/A5/A6）会导致**长会话在真实模型上必然撞上下文上限**，
且撞墙前的自动压缩阈值因量纲错误几乎永不触发——这是本轮影响面最大的一条。

安全问题按可利用性排序：A1/A2 需要「渲染层被注入」作为前提，当前未发现可用 XSS（见第五节），
属于纵深防御缺口；A3/A4/A5/A6/A7 是**无需攻击即可发生**的功能性缺陷。

| 编号 | 等级 | 一句话 | 触发条件 |
|---|---|---|---|
| A1 | P0 | 权限档位由渲染层自报，可自升 full 绕过审批 | 渲染层注入 |
| A2 | P1 | 「打开技能目录」硬编码 full 执行 run_command | 用户点按钮 |
| A3 | P1 | 委派失败泄漏孤儿 Agent（创建早于校验） | 任一委派校验失败 |
| A4 | P1 | 上下文压缩是机械截断，且覆盖旧摘要 | 长会话压缩 2 次以上 |
| A5 | P1 | 上下文预算量纲错误（字符冒充 token），压缩阈值永不触发 | 默认配置下长会话 |
| A6 | P1 | 子代理消息无上下文预算，检查点全量写盘 | 子代理多轮工具循环 |
| A7 | P1 | 备份漏掉 state/events/audit/dsh-storage | 每次退出 |
| A8 | P2 | SSE 行缓冲无上限，异常网关可撑爆内存 | 恶意/故障网关 |
| A9 | P2 | `lib/context-plan.js` 零生产调用（孤岛模块） | — |
| A10 | P2 | token 估算用 `length/4`，中文低估 4-8 倍 | 全链路 |
| A11 | ~~P2~~ 误判 | 子代理审批已有 `#delegApprovals` 完整机制（复核确认，无缺陷） | — |
| A12 | P2 | 子代理重试 sleep 不可中断 | 取消时 |
| A13 | P2 | `tools/patches/__pycache__`、旧 app.js 副本入库 | — |
| A14 | P3 | `.gitignore` 重复条目 | — |
| A15 | P3 | `dataset.segHtml` 存整段 HTML | 长消息 |
| A16 | P3 | 工具描述无长度上限（MCP 外部来源） | 异常 MCP server |
| A17 | P1 | 门禁隔离目录清不干净，`dsh.perm` 跨轮泄漏（收尾验证时发现） | 任意一次上一轮失败

---

## 一、P0：权限档位的权威归属错误（A1）

### 证据

```
renderer/app.js:3179   window.dsh.tools.exec(name, args, { workspace, permission: state.permission })
renderer/app.js:2096   state.permission 来自 readStorage('dsh.perm', 'full')   ← 只在渲染层
lib/tool-gateway.js:126 const permission = ['full','ask','readonly'].includes(opts.permission) ? opts.permission : 'ask'
runtime/index.js:168   evaluateTool({ profile: input.profile })  ← 直接透传，无 agent 档位收敛
runtime/executor.js:342 const userProfile = ... input.profile ...  ← 仅此一处做 stricterProfile
```

主进程**没有任何地方持有权威档位**（`grep permission main.js` 零命中）。

### 影响

R14 已经做到「渲染层不能伪造审批」（`approved:true` 失效、审批绑定 actionHash + toolCallId + runId）。
但等价缺口留在上游一步：**渲染层可以选择用哪个档位去申请策略判定**。

- 用户把档位设为「每次询问」（ask），危险工具应弹确认框；
- 渲染层传 `permission: 'full'` → `evaluatePolicy` 按 full 判定 → `decision === 'allow'` → 不弹框、直接执行；
- 用户在设置页看到的仍是 ask，界面上不会有任何异常。

即：**ask 档在这条路径上不是「每次询问」，而是「本次不询问」**。

同样地 `runtime:tools:execute` 的 `profile` 参数（preload:137）也由调用方决定，
`executor.execute` 虽然做了 `stricterProfile(userProfile, agentProfile)`，
但它的作用只是「不超过 Agent 自身档位」——当 Agent 档位是 full（默认新建 Agent 就是继承父档位，
自动创建时父档位可能是 full），渲染层传 full 就完全放行。

### 为什么是 P0

`contextIsolation: true` + `nodeIntegration: false` 阻断了直接 RCE，
但 preload 暴露的 `tools.exec` / `runtime.tools.execute` 本身就能执行 `run_command`。
一旦渲染层出现任何注入（第三方改包、未来功能引入 `innerHTML` 漏洞、devtools 手动调用、
损坏的 demo 数据），攻击链是**一步到位**的：注入 → 传 `permission:'full'` → 执行任意命令。

### 修法（建议）

让主进程持有权威档位，调用方传入值只作为「降级请求」：

1. 渲染层切换档位时走专用 IPC（`permission:set`）写主进程内存 + `dsh.perm`；
2. `tool-gateway.execLocal` / `runtime.executeTool` 不读调用方 `permission`，
   改读主进程权威值；若调用方传了更严格的档位，取 `stricterProfile(传值, 权威值)`；
3. `runtime.evaluateTool` 补 `stricterProfile(input.profile, agentVersion.permissionProfileId)`，
   与 `executor.execute` 保持一致（当前二者不一致本身就是缺陷）。

---

## 二、P1：硬编码 full 的越权执行（A2）

```
renderer/app.js:4993  window.dsh.tools.exec('run_command', { command: `explorer "${dir}"` }, {
renderer/app.js:4996    workspace: state.workspace,
renderer/app.js:4997    permission: 'full',        ← 硬编码，无视用户档位
renderer/app.js:4998    approved: true,           ← 已失效，但说明当时的设计意图是「直接放行」
```

用户把全局档位设为 readonly（只读），点「打开技能目录」按钮仍会以 full 执行 `run_command`。
虽然命令内容是固定的 `explorer "<工作区>\.dsh\skills"`，风险有限，
但它证明「档位可被调用点覆盖」这条路径是活的，且 `approved:true` 残留会误导后续维护者。

**修法**：删除该调用，改为专用 IPC `skills:open-dir`（主进程校验路径必须位于工作区内，
再 `shell.openPath`）。这样既不经过通用工具执行，也不需要伪造档位。

---

## 三、P1：委派失败泄漏孤儿 Agent（A3）

### 证据

`runtime/delegation.js` 的执行顺序：

```
192  if (autoCreate) { autoCreated = this._autoCreateAgent(...) }   ← 先创建 Agent
224  if (!target)  return this._reject(...)                          ← 之后才做各种校验
228  TARGET_ARCHIVED / TARGET_VERSION_MISSING
236  AGENT_LOOP
245  DEPTH_EXCEEDED
268  if (parentInactive) return { ok:false, RUN_NOT_ACTIVE }          ← 父 Run 已结束
271  DELEGATION_LIMIT（单 Run 最多 5 次）
276  DELEGATION_BUSY（每 Agent 最多 2 个子任务）
283  BUDGET_INVALID / BUDGET_EXHAUSTED
287  DELEGATION_CAPACITY（并发满）
295  CONTEXT_REF_*（最多 10 个、必须在工作区内、必须存在）
337  TOOL_SCOPE_EMPTY
343  CHILD_TASK_FAILED
```

`_reject` 只写一条 `delegation.rejected` 事件，**不回滚 `autoCreated`**。

### 影响

- 最常见的复现：模型在「单 Run 已委派 5 次」后继续调 `delegate_task` →
  第 6 次会先建一个 Agent，再被 `DELEGATION_LIMIT` 拒绝 → 孤儿 Agent，状态 `active`。
- 并发满（`DELEGATION_CAPACITY`）、父 Run 已结束、contextRefs 不存在，都会留下孤儿。
- 后果：Agent 列表被垃圾条目污染（名字形如「父名-目标-12345」）、`state.json` 持续膨胀、
  孤儿 Agent 权限档位继承父级，仍可被再次委派。

### 修法

两件事同时做：

1. **把不依赖 target 的校验前置到 autoCreate 之前**：
   `parentInactive`、`childDepth > MAX_DEPTH`、`DELEGATION_LIMIT`、`DELEGATION_BUSY`、
   `BUDGET_INVALID`、`computeChildBudget`、`DELEGATION_CAPACITY`、`contextRefs` 校验。
   这些只依赖 parentRun / parentTask / args，完全可以在建 Agent 前判定。
2. **autoCreate 之后的 `_reject` 统一走回滚**：`_rejectAndRollback(autoCreated, ...)`
   → `state.archiveAgent(id)` 或直接删除，并记 `delegation.rollback` 事件。

---

## 四、上下文引擎（A4 / A5 / A6 / A9 / A10）

### A5（P1）预算量纲错误——影响最大的一条

```
renderer/app.js:135  const CTX_LIMIT_DEFAULT = 700000;
renderer/app.js:136  const CTX_LIMIT_MIN = 50000;
renderer/app.js:137  const CTX_LIMIT_MAX = 2000000;
renderer/app.js:150  上下文预算（字符）：发给上游的历史总量上限
renderer/app.js:3901 if (used <= LIMITS.maxContextChars * 0.9) return false;   ← 自动压缩阈值
```

单位是**字符**，UI 上叫「上下文窗口」，用户读到 700000 会当成 token。

按中文 ~1.5 字/token 折算：700000 字符 ≈ **46 万 token**，
是主流 200k 窗口的 2.3 倍；上限 2000000 字符 ≈ 133 万 token，是 6.6 倍。

后果链：
1. 默认配置下，`buildApiMessages` 的裁剪几乎永不触发（700k 字符的历史很难攒到）；
2. 自动压缩要等到 630k 字符（90%）才触发——**在这之前上游早已 400**；
3. 400（`context_length_exceeded`）在 `classifyHttp` 里不可重试，用户只看到一条错误，
   会话就此卡死，只能手动 `/compact`（而 `/compact` 正是 A4 那个机械截断）。

**修法**：把预算单位改成 token 估算，默认值按模型上下文窗口的 70% 算。
最小改动：保留字符口径，但默认值降到 240000（≈16 万 token 中文），
上限降到 600000；同时把自动压缩阈值从 90% 降到 75%，给压缩后的请求留余量。
更好的做法是引入 `estimateTokens()`（中文按 1.5 字/token、ASCII 按 4 字符/token 混合估算），
让预算、状态栏、自动压缩、modelStart 的 `approxInputTokens` 共用同一个函数。

### A4（P1）压缩是机械截断，且覆盖旧摘要

```
renderer/app.js:3863 const lines = usable.map((m) => {
renderer/app.js:3864   const content = m.role === 'user' ? m.text : (m.body || '');
renderer/app.js:3865   const flat = String(content).replace(/\s+/g, ' ').slice(0, 120);   ← 每条只留 120 字
renderer/app.js:3866   return `- ${role}：${flat}`;
renderer/app.js:3868 state.compacted.set(s.id, lines.join('\n'));                          ← set 覆盖
renderer/app.js:3869 s.messages = [{ ... }];                                               ← 历史硬删
```

三个问题：

1. **不是摘要，是截断拼贴**。助手正文被压到 120 字，长任务里的文件路径、决策理由、
   已确认的约束全部消失。压缩后模型会「忘记」自己刚做过什么，重复读文件、重复试错。
2. **`set` 覆盖**。第二次压缩把第一次的摘要整段替换 → 早期上下文**永久丢失**。
   对比 `/compact` 命令路径（3824 行）是追加语义，两条路径行为不一致。
3. **摘要本身无预算上限**。`lines` 长度 = 消息条数 × ~130 字符。
   300 条历史 → 39k 字符注入 system；5000 条 → 65 万字符，反而把上下文撑爆，
   而 `sessionContextChars` 跳过 compacted 消息，状态栏显示占用骤降到接近 0，
   用户看不出真实占用。

**修法**：
- 压缩改追加：`state.compacted.set(s.id, prev ? prev + '\n\n' + lines.join('\n') : lines.join('\n'))`；
- 摘要加总量上限（如 24000 字符），超出时只保留最近的 N 条 + 更早的「一句话主题」；
- 每条摘要从 120 字符提高到 400 字符，并保留工具调用名与关键产物路径；
- 更彻底：压缩时调一次模型做真摘要（成本可控，一次请求），失败再回落机械截断。

### A6（P1）子代理无上下文预算

```
runtime/agent-runner.js:331 messages.push({ role:'assistant', content:text, tool_calls })
runtime/agent-runner.js:343 messages.push({ role:'tool', content: clipToolResult(r.content) })  ← 单条 12000 字符
runtime/agent-runner.js:333 state.saveDelegationCheckpoint(delegation.id, { messages, ... })   ← 每步全量写盘
```

子代理只有 `maxModelCalls`（默认 12）和 `maxTokens`（默认 60000）两个预算，
**没有消息总量上限**。12 轮 × 每轮 24 个工具 × 12000 字符 = 理论 345 万字符
（≈230 万 token），远超任何模型上限；且 `maxTokens` 依赖上游返回 `usage`，
兼容网关普遍不返回 → 这个预算实际不生效（`tokens` 一直是 0）。

`saveDelegationCheckpoint` 每步把整个 `messages` 全量序列化写 `state.json`，
消息越多写盘越慢，是 O(n²) 的写放大。

**修法**：
- 给 `messages` 加总量预算（复用主聊天同一套 `estimateTokens` + 裁剪），
  裁剪时保留 system 与最近 N 轮，中间的旧工具结果替换为一行占位；
- `maxTokens` 不可用时用「字符数 × 0.7」兜底计入；
- 检查点改为增量（只存最近 20 条 + 摘要），或写独立文件避免拖慢 `state.json`。

### A9（P2）`lib/context-plan.js` 是孤岛

```
$ grep -rn "require.*context-plan" → 只有 tools/context-plan-check.js
```

117 行、40 个断言、注释写着「maxBytes 默认 120000，对齐 renderer/app.js 的 TOOL_CONTEXT_BUDGET」，
但**生产代码零调用**。渲染层实际用的是自己那套 120000 字符的 `forModel()` 截断。
这会给维护者「上下文已做预算治理」的错觉——实际治理逻辑有两份，其中一份不生效。

**修法**：二选一。要么把 `planContextRead` 接进 `forModel`（单轮工具结果预算 + 拆分建议），
要么在文件头显式标注「规划器，尚未接线」并从自检清单里降级，避免误判覆盖率。

### A10（P2）token 估算低估

三处都用 `length / 4`：
```
renderer/app.js:3277  approxInputTokens: Math.round(messages.reduce(...) / 4)
runtime/agent-runner.js:301  同上
```
`length` 是 UTF-16 code unit。英文 ~4 字符/token 成立，中文 ~1.5 字/token
→ 中文场景低估 6 倍以上。这直接影响 Runtime 里记录的 token 用量与成本估算。

---

## 五、Model Adapter（A8 / A12 / A16）与已验证无问题项

### A8（P2）SSE 行缓冲无上限

```
main.js:1638 const feed = (chunk) => {
main.js:1642   buf += decoder.decode(chunk, { stream: true });
main.js:1643   const sep = /\r?\n\r?\n/;
main.js:1645   while ((idx = buf.search(sep)) >= 0) { ... }
```

`buf` 只有在匹配到空行时才缩短。异常网关持续发送不含 `\n\n` 的数据（例如一条超长单行、
或永不结束的注释流）→ `buf` 无限增长。`emitDelta` 的 `MAX_OUTPUT_CHARS` 只保护已解析的正文，
保护不到未解析的缓冲。

**修法**：`if (buf.length > 4 * 1024 * 1024) throw new ChatError('STREAM_ERROR', '上游单块数据超限', false)`。

### A12（P2）子代理重试 sleep 不可中断

```
runtime/agent-runner.js:120 await sleep(MODEL_RETRY_DELAY_MS * attempt);   ← 不接 signal
```
取消时最多多等 2.4 秒。`lib/retry.js` 已有可中断的 `sleep(ms, signal)`，直接复用即可。

### A16（P3）工具描述无长度上限

```
main.js:1337 function sanitizeTools(list) { ... description: String(tool.function.description || '') }
```
MCP server 返回的 tool description 直接进请求体，无截断。异常 server 可让请求体膨胀到 MB 级。

### 已验证无问题（本轮未发现缺陷，记录以备复查）

- **XSS（Renderer）**：`markdown()` 先 `lines.map(esc)` 再解析（`app.js:852`），
  `inline()` 的链接只接受 `https?:`，属性值已被 esc（`"` → `&quot;`）不可突破；
  工具结果走 `toolDetail()` 的 `esc(cut)`（1141）；审批卡片三处全 esc（1339-1341）；
  架构 SVG 文本节点全 esc（含 `archCut` 后）；附件 chips、任务卡片、模型列表均 esc。
  遍历 20 处模板字符串 `innerHTML =`，未发现未转义的外部数据插值。
- **导航与窗口**：`setWindowOpenHandler` 一律 deny + `shell.openExternal`；
  `will-navigate` 只允许本地 entry；`will-redirect` 全拦（`main.js:429-443`）。
  `contextIsolation: true`、`nodeIntegration: false`。
- **Model Adapter 重试/中断**：`produced === 0` 门控保证「已输出的流不重试」（避免正文重复）；
  `Retry-After` 秒/HTTP-date/`retry-after-ms` 三种形态；Chromium `net::ERR_*` 单独一份可重试名单
  且有 `FATAL_CHROMIUM_CODES` 反向保护；连接/空闲/硬超时三层计时互不覆盖；
  `decoder.decode(chunk, {stream:true})` 正确处理多字节 UTF-8 跨 chunk。
- **IPC 入参校验**：`validateChatArgs` 对 role 白名单、tool_call_id 必填、
  tool_calls 上限 24、工具名正则校验，`sanitizeMessages` 二次清洗。

---

## 六、Backup（A7）

```
main.js:603 backup.rotateBackup([
             userData/runtime/lessons.jsonl,
             userData/runtime/runtime.json,
           ], userData/backups, { keep: 7 })
```

`lib/backup.js` 本身的实现是扎实的（WAL 伴随文件、只删 STAMP_RE 形态目录、
同时间戳幂等、单源失败不中断、keep 非法回落）。问题在**接线漏了 4 个关键源**：

| 文件 | 内容 | 是否备份 |
|---|---|---|
| `userData/dsh-storage.json` | 会话历史、设置、连接配置（真值源） | ❌ |
| `userData/runtime/state.json` | 任务/Run/审批/委派全量快照 | ❌ |
| `userData/runtime/events/*.jsonl` | 事件链（审计真值，`readAll` 的数据源） | ❌ |
| `userData/runtime/audit/*` | 哈希链审计记录 | ❌ |
| `userData/runtime/lessons.jsonl` | 经验库 | ✅ |
| `userData/runtime/runtime.json` | 事件游标元数据 | ✅ |

即：备份了「索引」和「经验库」，漏了「用户数据」和「真值链」。
且没有 restore 路径——`rotateBackup` 只写不读，用户无法从备份恢复（需手工拷贝）。

**修法**：
- 源列表加上 `dsh-storage.json`、`state.json`、`audit/`（目录需支持）、`events/` 最近一个文件；
- `rotateBackup` 支持目录递归复制（或单独对 `audit/` `events/` 做 `cpSync recursive`）；
- 在设置页「关于/Doctor」加一个「从备份恢复」入口（列出时间戳目录，选中后关闭应用并覆盖）。

---

## 七、仓库卫生（A13 / A14）

```
$ git ls-files tools/patches
tools/patches/__pycache__/js_orchestration_patches.cpython-315.pyc     ← Python 字节码
tools/patches/backup/20261114-191230/app.js                            ← 7281 行旧副本
```

`.gitignore` 里 `.runall-probe/` 出现两次（第 12、18 行）。

**修法**：`git rm -r --cached tools/patches/__pycache__ tools/patches/backup`，
`.gitignore` 补 `__pycache__/`、`tools/patches/backup/`，删重复行。

---

## 八、建议修复顺序

1. **A5 + A4**（上下文）：影响长会话可用性，且两者强耦合——先定预算口径，再改压缩。
2. **A1 + A2**（档位权威）：治理链闭环，改动集中在 main.js + gateway + evaluateTool。
3. **A3**（委派回滚）：局部改动，风险低。
4. **A7**（备份）：数据安全，改动小但要加恢复入口。
5. **A6 + A8 + A12**（预算与缓冲）：防御性加固。
6. **A9/A10/A13-A16**：清理与一致性（A11 复核为误判，不作为整改项）。
7. **A17**（门禁隔离）：验证阶段才暴露，已在 R15 一并修掉——不修的话，之后每一轮回归都可能
   带着上一轮的 `dsh.perm` 跑，失败会伪装成业务回归。

A1/A2 建议与 R14 的 `docs/security/policy-model.md` 合并成一份「治理不变量」文档：
**审批权、档位权、审计权都必须在主进程**，渲染层只能「请求」，不能「裁定」。


---

## 九、修复落点（R15 交付，2026-11-15）

| 编号 | 修复 | 落点 | 断言 |
|---|---|---|---|
| A1 | 档位权威收归主进程；渲染层只能「请求」，提升到 full 需原生确认框；`dsh.perm` 禁止走通用 storage 通道（set/remove/set-many 三处挡住）；`evaluateTool` 补 agent 档位收敛 | `lib/permission-authority.js`（新）、`main.js`（permission:set / STORAGE_GUARDED_KEYS / withAuthority*）、`runtime/index.js:evaluateTool`、`preload.js`、`renderer/app.js:setPermission` | r15-check §1/§2、v2-check「无头模式拒绝提权」 |
| A2 | 「打开技能目录」改专用 IPC，主进程 realpath 归一后 `shell.openPath` | `main.js:skills:open-dir`、`renderer/app.js:openSkillsDir`、`preload.js` | r15-check §3 |
| A3 | 配额前置到 autoCreate 之前；autoCreate 之后的失败统一 `rejectAfterCreate` 回滚（删 Agent，有引用则归档） | `runtime/delegation.js`、`runtime/state.js:deleteAgent`、`runtime/audit.js` | r15-check §4（agents 数量不变 + delegation.rollback 事件） |
| A4 | 压缩改追加语义；单条 120→400 字符；摘要池 24000 上限（头 30% + 尾）；保留工具名与目标锚点 | `renderer/app.js:performCompact` | r15-check §5 |
| A5 | 预算默认 700000→120000、上限 2000000→400000、旧超大值回落默认；自动压缩阈值 90%→75% | `renderer/app.js`（CTX_LIMIT_*、maybeAutoCompact） | r15-check §6 |
| A6 | 子代理历史按 120000 字符预算裁剪 + tool 配对修复；无 usage 时字符估算兜底计入 maxTokens；检查点只存最近 40 条 | `runtime/agent-runner.js`（trimChildMessages / repairToolPairs / checkpointMessages） | r15-check §7 |
| A7 | 备份源补 `dsh-storage.json` / `state.json` / `audit/`（目录递归）/ 最近 3 天事件分片；新增 backup:list / backup:open（防穿越）；设置页加备份入口 | `main.js`、`lib/backup.js`（cpSync 目录支持）、`preload.js`、`renderer/index.html` | backup-check 32/32、r15-check §8 |
| A8 | SSE 行缓冲 4MB 上限，超限按流错误收尾 | `main.js:feed` | r15-check §9 |
| A9 | `planContextRead` 经 preload 透传，接入 `forModel` 的截断提示 | `preload.js`、`renderer/app.js:forModel` | r15-check §9 |
| A10 | 新增 `lib/token-estimate.js`（中文 1 字≈1 token、其它 4 字符≈1 token），替换渲染层与子代理的 `length/4` | `lib/token-estimate.js`（新）、`preload.js`、`renderer/app.js`、`runtime/agent-runner.js` | r15-check §7 |
| A11 | **误判，撤回实现**。原报告称「子代理审批无 UI 入口」，实际 `#delegApprovals` 已有事件驱动容器 + 卡片 + `decideDelegationApproval` 回传 + 过期清理（`handleDelegationApprovalEvent` / `isInlineRun` 区分主聊天与子任务）。本轮曾错误地加了一套轮询投影，导致与既有机制双写并打断 e2e 时序，已全部撤回 | `renderer/app.js`（既有实现，未改动） | r15-check §9 改为守护既有机制 |
| A12 | 子代理退避改用可中断 `retry.sleep(ms, signal)` | `runtime/agent-runner.js:requestModel` | r15-check §9 |
| A13 | 取消跟踪 `tools/patches/__pycache__` 与 `tools/patches/backup/`；`.gitignore` 去重并补规则 | `.gitignore`、git index | git status 干净 |
| A17 | **门禁隔离失效（收尾验证时发现）**：`.runall-probe` 依赖 `fs.rmSync` 静默清空，但网关日志句柄与 Chromium 缓存锁让删除失败，上一轮的 `dsh-storage.json`（尤其 `dsh.perm`）跨轮泄漏。修法：网关日志移出隔离目录（`os.tmpdir()`）；清理改为「清完回读校验 → 清不掉则整目录改名让开」，并把可清空性作为一条门禁行暴露出来 | `tools/run-all.js`（resetProbeDir / 隔离行）、`.gitignore` | run-all 新增「隔离 userData 已清空」行；tool-e2e 75/75、g3-probe 44/44 |

> A17 的成因值得记一笔：它先伪装成业务回归——`tool-e2e` 因档位被降级而拿不到任务卡，
> 又在 `.tasks-head span` 上空指针崩溃，把前面那条「请求没带上 tools」的解释性断言一起吞掉。
> 同一份残留也让 `g3-probe` 的 `sel.askNotSent` 假失败。修复后同一台机器连跑两轮均全绿。
>
> 它还让门禁数字虚高了一档：残留的 `dsh.dynProbePhase='todo'` 使 `dyn-probe` 第一阶段直接进 todo，
> 同一套 22 条断言跑了两遍，写成「44/44」；正确基线是 `arch 14 + todo 22 = 36`。
> 数字变好看本身就是个信号——基线应当由断言设计决定，而不是由残留状态决定。

### 行为变化（需要知会使用者）

1. **切换权限到「完全权限」会弹一次主进程原生确认框**（正常使用多一次点击；这是 A1 的核心防线）。
   `--shot` / `--script` 无头模式下提权一律被拒，探针需按「拒绝」断言。
2. **上下文窗口默认值从 700000 降到 120000**：老用户存过 700000 的会被识别为历史默认值并回落新默认；
   显式设置的 50000–400000 之间值保留。
3. **备份内容变大**：多备了会话存储、任务状态、审计目录与 3 天事件，保留仍为 7 份。
4. **子代理需要审批时会出现时间线卡片**（以前完全没有提示，只能等超时失败）。
5. **`tool-e2e` 不再自己降级再求升权**：无头模式拒绝提权是 A1 的防线，探针若需要「更严的请求」，
   只改渲染层请求值（主进程照旧收敛并走审批流），不再动主进程权威值——否则末尾清理的
   `run_command` 会被降级拦下，表现成「测试目录已清理·用户拒绝执行」。
6. **门禁比上一轮多一行**（`隔离 userData 已清空`），全量为 25 项。

---

## 十、审计方法复盘（本轮踩到的坑）

1. **搜索关键词要覆盖同义实现**：A11 误判的直接原因是只搜了 `approvals.list` / `pendingApprovals`，
   而实现用的是 `delegApprovals` + `handleDelegationApprovalEvent`（事件驱动，不轮询）。
   教训：判定「某能力不存在」之前，至少要搜「容器 id / 事件名 / decide 调用」三类线索。
2. **重复实现比不实现更糟**：两套 UI 同时响同一个审批，会互相打断 DOM 时序——
   e2e 的 19 项失败就是这么来的（点击落空 → 子任务超时 → 后续断言连锁失败）。
3. **修复必须跑全量门禁**：`r15-check` 全过，但 tool-e2e 挂 19 项——
   单测覆盖的是「新代码自洽」，只有端到端才能发现「与既有机制冲突」。
4. **断言里的空指针会掩盖根因**：`.tasks-head span` 一处未加保护，让 74 条断言只剩一行
   `Cannot read properties of null`，真正的「网关没起来 / 档位被降级」全被吞掉。
   探针里凡是「等待 UI 出现」的断言，都要用可选链让失败自己说话，而不是整段崩掉。
5. **测试环境的「隔离」要能自证**：声明隔离 ≠ 真的隔离。清完必须回读校验，
   并把可清空性纳入门禁——否则上一轮的状态会以「业务回归」的面目出现在下一轮。
