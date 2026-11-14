# E2E 测试指南（tools/tool-e2e.js）

一次完整回归 = 74 项检查，全部通过时日志里只有一行 `[script] {"checks":[...],"total":74,"passed":74,"failed":0}`。
本文记录 2026-11-14 排查连续挂起时踩过的三个坑，跑 e2e 前先按下面的标准流程走。

## 标准流程（Git Bash / Windows）

```bash
# 1) 杀掉所有残留 mock-gateway（含旧的、以及重启失败留下的半死进程）
powershell.exe -NoProfile -Command 'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "mock-gateway" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
powershell.exe -NoProfile -Command 'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "mock-gateway" } | Measure-Object | % Count'   # 必须输出 0

# 2) 起全新网关（后台 + 独立日志），确认端口 57321 只有一个进程、/v1/models 有响应
node tools/mock-gateway.js > mock-gw-fresh.log 2>&1 &
sleep 2
curl -s http://127.0.0.1:57321/v1/models        # 应返回 mock-tool-model / mock-alt-model

# 3) 隔离 userData 跑全套（280s 超时；EXIT=124 表示超时挂起）
rm -rf .e2e-userdata                             # 见坑 2：直接重建，不要复用脏目录
timeout 280 npx electron . --user-data-dir="E:/dsh-desktop/.e2e-userdata" --script=tools/tool-e2e.js > e2e.log 2>&1

# 4) 解析 [script] 行
node -e "const l=require('fs').readFileSync('e2e.log','utf8').split(/\r?\n/).find(x=>x.startsWith('[script]'));const j=JSON.parse(l.slice(9));console.log(j.total+'/'+j.total,'passed='+j.passed,'failed='+j.failed);console.log(j.checks.filter(c=>!c.pass).map(c=>c.name))"
```

- 成功基线：74/74（最后绿色记录：commit `958da5a`，2026-11-14 11:04，e2e-r3.log）。
- 日志格式：成功时**整个日志只有一行** `[script] {JSON}`；脚本抛异常会打 `[script-error] <msg>`。
- 网关只记录 `/chat/completions`（不记 /models 探测）。**网关日志零行 = 第一轮对话请求根本没发出**，挂起点在对话链路之前，别再盯着网关查。

## 坑 1：旧 mock-gateway 进程残留 + EADDRINUSE（当天首次诊断）

- **症状**：连续多次挂起在对话步骤；尝试重启网关报 `EADDRINUSE`（mock-gw-r4.log 只有 listening 一行 = 新进程根本没起来）；旧网关带着被 kill 会话的残留状态继续服务。
- **根因**：旧 node 进程一直活着（凌晨起一直在跑），"重启"实际失败了，后续所有 run 都打到了带旧状态的网关。
- **修法**：流程第 1 步按 CommandLine 用 CIM 精确查杀并计数验证为 0，再起新网关；验证 `curl /v1/models`。

## 坑 2：userData 缓存/锁污染（--user-data-dir 隔离）

- **症状**：换了新网关仍挂；`.e2e-userdata` 里留着被 SIGKILL 会话的脏状态（LevelDB、runtime、Session Storage）。
- **根因**：e2e 复用同一个 `--user-data-dir`，被强杀的 run 会把脏缓存留给下一次；`did-finish-load` 不触发时脚本一行都不会输出。
- **修法**：每次 e2e 都用独立 `--user-data-dir`（`.e2e-userdata`），且跑之前 `rm -rf` 重建；e2e 结束后再删掉。注意 `main.js` 只在 `--shot` 分支处理 `--script`（且仅允许 `tools/*.js`，防路径逃逸），脚本经 `executeJavaScript` 执行：无 `[script]` 也无 `[script-error]` = 脚本 promise 未决（页面没加载完或脚本卡在无限等待），此时先查 `tools/diag.js`（boot + 主进程网络探针）分层定位。

## 坑 3：源码被并发修改（2026-11-14 新发现，最隐蔽）

- **症状**：新网关 + 全新 userData 依然挂，且网关日志零行、runtime 审计无新事件、`[script]`/`[script-error]` 都没有。
- **根因**：工作区有**未提交的进行中改动**（当天 `renderer/app.js`、`runtime/{graph,policy,state}.js` 在 e2e 运行期间被另一会话连续修改），e2e 打包/加载的是半成品代码。`runtime/lib/renderer/main.js` 任何未预期的改动都会让 e2e 结果失效。
- **修法**：跑 e2e 前先 `git status --short` + `git log -1` 确认基线；如果存在非预期改动，先和改动方对齐（等它完成或基于最后一个绿色 commit 跑），**不要**在别人改代码时跑 e2e，也不要随意 `git checkout` 丢弃别人的进行中工作。

## 排错速查表

| 症状 | 原因 | 修法 |
|---|---|---|
| 挂起到 timeout（EXIT=124），`[script]`/`[script-error]` 都没有 | 页面未加载完或脚本卡在无限等待；常见于坑 1/2/3 | 按顺序排：杀残留网关 → 重建 userData → `git status` 查源码改动 |
| 网关日志零行（只有 listening） | 第一轮对话请求没发出，挂起点在对话链路之前 | 不是网关内容问题；查 boot（diag.js）与源码基线 |
| 重启网关报 `EADDRINUSE` | 旧网关进程还活着，"新"网关没起来 | CIM 按 CommandLine 查杀并计数=0 后再起 |
| 日志尾部出现 `Network service crashed ... exit_code=143` | timeout SIGTERM 的**结果**，不是挂起原因 | 忽略，先看 `[script]` 行是否存在 |
| `[script-error] <msg>` | 脚本在渲染进程抛异常 | 看 msg 定位检查段，别盲目重跑 |
| 有 `[script]` 行但 failed>0 | 功能回归 | 取 `checks` 里 `pass:false` 的 name 定位 |
| diag.js 通过但 tool-e2e 挂 | 挂点在 diag 覆盖不到的长链路（对话/工具/委派） | 用坑 3 的 git 基线法收敛 |

## 三层定位法（挂起时按序执行）

1. `tools/diag.js`（boot + 主进程网络）：通 → 渲染层与主进程正常，继续第 2 层。
2. 网关日志有没有 chat 请求：有 → 挂在对话之后的具体环节；没有 → 挂在对话之前（加载/脚本未执行）。
3. `git status` / 文件 mtime：源码是否在基线之后被改过 → 有并发改动就停跑 e2e。
