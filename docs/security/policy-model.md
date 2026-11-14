# 工具治理模型（Policy / Approval / Audit）

> 本文件是 `runtime/policy.js`、`runtime/executor.js`、`lib/tool-gateway.js` 的行为契约。
> 改动这三个文件时，先改这里，再改代码。

## 1. 只有一条治理链

```
                      ┌──────────────────────────────┐
渲染层 / 子 Agent ────▶│  Runtime 通道（主路径）        │
                      │  propose → policy → approval  │
                      │  → executor → event → audit   │
                      └──────────────────────────────┘
                                     ▲
                      ┌──────────────┴───────────────┐
主进程 IPC ───────────▶│  Tool Gateway（降级通道）      │
  tool:exec            │  policy（复用同一份模块）      │
  mcp:tool:call        │  → 主进程原生确认框 → 审计事件  │
                      └──────────────────────────────┘
```

两条通道**共用**：

| 维度 | 实现 |
| --- | --- |
| 策略判定 | `runtime/policy.evaluatePolicy`（Gateway 直接调用 `runtime.evaluateTool`，同一 workspaceId） |
| 审批语义 | actionHash 绑定（工具 + 版本 + 归一化参数 + 资源键）、一次性、TTL |
| 审计 | 都写入 `runtime/events` → `AuditStore` 哈希链（Gateway 记 `tool.gateway`） |
| 工具实现 | `lib/tools.executeTool`（同一份实现，不复制） |

**唯一差异**：Gateway 通道不建 Task/Run（不占并发预算、不产生 step/run 生命周期），
适用于「Runtime 未就绪」的降级场景。高风险工具的判定与审批仍然完整。

### 为什么渲染层不再能「自己批准」

旧实现里 `tool:exec` 直接把渲染层传入的 `approved: true` 转给工具层，等于把审批权
放在被治理对象手里。现在：

1. Gateway 先做策略判定；`deny` 一律拒绝，和传什么参数无关；
2. `require_approval` 时由**主进程**弹原生确认框（`dialog.showMessageBox`），
   返回值只存在于主进程内存；
3. 无头模式（`--shot` 探针）一律按拒绝处理，避免测试卡在模态框。

## 2. 三档权限

| 档位 | 读取/搜索/联网 | 写文件/执行命令 | 委派 | 修改架构 |
| --- | --- | --- | --- | --- |
| `readonly` | 允许 | 拒绝 | 拒绝 | 拒绝 |
| `ask`（默认） | 允许 | 每次确认 | 每次确认 | 允许 |
| `full` | 允许 | 允许（硬拒绝除外） | 允许 | 允许 |

硬拒绝（任何档位都不可执行）：灾难性命令（`format`/`diskpart`/`mkfs`/`shutdown` 等）、
写系统目录、写工作区之外、未注册工具、参数校验失败。

## 3. 副作用与「未知」状态

有副作用的工具（`write_file` / `run_command` / `delegate_task` / `project_architecture`）
在以下三种情况下**不能**标记为 `canceled` 或 `failed`，必须落 `unknown`：

1. 任务取消时工具仍在 `executing`；
2. 应用退出时工具仍在 `executing`（重启后由对账逻辑判定）；
3. 命令被超时/取消杀掉，无法确认是否已产生副作用。

`unknown` 只能通过 `reconcileToolCall({ outcome })` 人工/自动核对成
`succeeded | failed | canceled`，并写入 `tool.reconciled` 审计事件。

## 4. 取消传播

```
cancelTask(taskId)
  → 收集任务树（自己 + 全部后代）下的 runId
  → AbortController.abort()        // 先断执行
  → state.cancelTask()             // 再改状态
```

信号挂在 `Runtime.signalForRun(runId)`，向下传给：

- `lib/tools.runCommand`：`taskkill /T /F` 杀整棵进程树；
- `lib/tools.fetchUrl`：中断在途 HTTP 请求；
- `lib/tools.writeFile`：写临时文件阶段中断 → 删临时文件，目标文件保持原样；
- `agent-runner` 的模型请求：`delegationModelRequest` 收到 signal 即 abort。

取消后新发起的调用会拿到「出生即已中止」的信号（`abortedRuns` 集合），
不存在「取消后又有新工具跑起来」的空窗。

## 5. 网络边界（SSRF）

两层，缺一不可：

1. **策略层**（`policy.normalizeUrl`）：URL 语法、协议、主机名静态拦截
   （`localhost` / `*.local` / 单标签主机 / 字面量私有 IP）；
2. **执行层**（`lib/net-safety.safeFetch`）：
   - 每一跳都重新做 DNS 解析，任一条 A/AAAA 落在私有/保留段即拒绝；
   - `redirect: 'manual'` 手动跟随，最多 5 跳；
   - 读不出 Location 的 `opaqueredirect` 直接拒绝；
   - IPv4 覆盖 0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.168/16、
     198.18/15、组播、保留段；IPv6 覆盖 `::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`、
     IPv4-mapped、NAT64 内层地址。

残余风险（已知）：DNS rebinding —— 校验与连接之间有时间窗，fetch 无法把连接绑定到
已校验 IP；已用 60s 解析缓存 + 全地址取交集校验收敛风险面。

## 6. 进程边界

| 位置 | 策略 |
| --- | --- |
| `run_command` 子进程 | 环境变量白名单（PATH/SystemRoot/TEMP/USERPROFILE…），不继承主进程密钥 |
| MCP server 子进程 | 同上 + 配置里显式声明的 `env` |
| MCP 调用 | 单 server 并发 ≤4、参数 ≤256KB、超时 ≤600s、server 数 ≤12、结果 ≤200k 字符 |

## 7. 审计事件

| 事件 | 含义 |
| --- | --- |
| `policy.decided` | Runtime 通道的策略判定 |
| `approval.requested` / `approval.decided` / `approval.expired` | 审批生命周期 |
| `tool.started` / `tool.completed` / `tool.failed` / `tool.unknown` / `tool.denied` / `tool.canceled` | 工具终态（每个 toolCall 只允许一个终态） |
| `tool.reconciled` | 未知结果的核对结论 |
| `tool.gateway` | 降级通道（`tool:exec` / MCP）的判定、审批与结果 |
| `runtime.reconciled` | 启动时「快照 ↔ 事件链」对账摘要 |

审计链为哈希链（`runtime/audit`），`audit.verify()` 可检出篡改与断链。
