# DSH Desktop · 动效体系重做包（Emil 动画方法论）

> 产出日期 2026-11-14 · 依据：review-animations / find-animation-opportunities / animate /
> animation-performance / choreograph / animation-vocabulary 六项技能（Emil Kowalski 方法论）。
> 本包**不直接改动 renderer 任何文件**：全部产出为新文件 + 锚点式一键应用脚本。
> ⚠ app.js 正被 G5（会话级并行）并行改造 —— JS 编排补丁标注 G5 依赖，请在 G5 落地后应用。

## 包内容

| 文件 | 说明 |
| --- | --- |
| `motion-system.css` | 新动效体系唯一事实源（令牌 + 全部 keyframes + 全部动画规则 + reduced-motion 兜底），应用时追加到 styles.css 末尾 |
| `apply-anim.py` | 一键应用脚本（`--dry-run` / `--skip-js` / `--skip-css` / `--restore`），锚点全部精确匹配，miss 不落盘 |
| `js_orchestration_patches.py` | JS 编排补丁数据（P1–P6，锚点式，含 G5 依赖标注） |
| `backup/<时间戳>/` | 应用时自动备份 styles.css + app.js（回滚用） |

## 一、审计结论总览

旧 styles.css 共 **63 个 @keyframes**、**18 个分散的 reduced-motion 块**、**两套并行令牌**
（`--ease-lively` 弹簧全场景混用 + 文末未完成的 Motion Tokens 段）。

| 统计 | 数量 | 明细 |
| --- | --- | --- |
| **保留并重做**（语义成立，重写曲线/时长/性能） | **39** | fade, fadeOut, rowIn, cardIn, pulse, blink, spin, float, thinkWave, toolScan, menuIn, menuOut, sheetIn, sheetOut, inspectorIn, inspectorOut, todoIn, todoOut, stampIn, slideLeftIn, settingsIn, settingsOut, settingsPaneIn, findIn, findOut, selMenuIn, emptyIn, suggestIn, doctorIn, doctorPulse, todoPop, todoEditGlow, approvalGlow, archNodeIn, archFlash, archEdgeFade, archEdgeDraw, archDashFlow, msgIn→rowIn 系列 |
| **删除**（该不该动 = 不该 / 死代码 / 重复实现） | **24** | rise, pop, msgIn, summaryIn, toolIn, btnSheen, toastIn, inspPulse, archBadgeBreathe, archPulse, archHaloPulse, archHalo, archRing, archAuraBreathe, dotPulse, mcpPulse, retryPulse, toolPulse, rp-breathe, archTopIn, archCanvasIn, archCardIn, archPageIn, archDetailIn |
| **新增**（合并/配对产生） | **4** | softPulse, haloPulse, archAura, listExit |

## 二、逐项审计表（旧动效 → Emil 标准评判 → 新方案）

评判维度：①该不该动（frequency/purpose）②曲线（进出场是否混用弹簧）③时长层级 ④打断 ⑤性能。

### 对话流

| 旧动效 | 评判 | 新方案 |
| --- | --- | --- |
| `msgIn 420ms` 弹簧 + `summaryIn 360ms 40ms` 延迟 | ✗ 420ms 超预算近一倍；聊天消息 100+/日属高频面；弹簧过冲用错场景；summary 二次入场违反「一容器一次入场」 | `rowIn 200ms` 强 ease-out；summary 随容器整体出现（删除 summaryIn） |
| `toolIn 360ms` 弹簧左滑 | ✗ 流式工具行高频；360ms 弹簧拖慢每轮输出感 | `rowIn 200ms`，行入场统一语言 |
| `.tool/.approval/.retry/.queue/.tool-detail` base 入场动画 | ✗ innerHTML 重建式渲染导致**切会话整批重放**（打断/重放缺陷） | 删除 base 动画；入场由 `is-enter`（enteredMessages/enteredTools 门控）承载 |
| `retryPulse` + `toolPulse` + `archPulse` + `inspPulse` + `rp-breathe` | ✗ 五个同语义（低对比呼吸）异名实现，无断点收敛 | 合并为 `softPulse`（opacity .85↔.5），各上下文只设时长 |
| `approvalGlow 3.2s` 盒阴影逐帧重绘 | △ 用途成立（待审批状态指示），性能不成立 | `::before` 静态光环 + opacity 脉冲（合成层） |
| 列表行 hover `translateX(2px)` / 按钮 hover `translateY(-1px)` | ✗ tens/day 面 + 功能数据阅读区，位移 gimmick 违反「装饰不 hinder」；且 `.session:hover` 存在 3 条互相覆盖的冲突规则 | 全部删除，只留底色/描边反馈；按压 `scale(.97)` 保留（feedback 用途） |
| `btnSheen 700ms` hover 扫光 | ✗ 功能按钮上的装饰性 hover 动效，marketing 级位移错位 | 删除 |
| `caret blink` / `toolScan` / `thinkWave` / `spin` | ✓ canonical（输入光标/运行扫光/思考三点/加载），transform/opacity 轴 | 原样保留 |

### 浮层

| 旧动效 | 评判 | 新方案 |
| --- | --- | --- |
| `menuIn 130ms→180ms`（两条规则互相覆盖）+ menu 中心 origin | ✗ 菜单高频面 + 缺 origin-aware（transform-origin 静态 top left，上翻时反向） | `menuIn 130ms` scale(.97)；JS `openMenu`/右键菜单按锚点方向写 transform-origin（P5/P6） |
| `pop`（sheet 死代码，被 280ms 规则覆盖） | ✗ 死规则 | 删除 |
| `sheetIn 280ms` 弹簧 | △ 模态时长合规，弹簧曲线不该用于功能型 dashboard 的入场 | `sheetIn 280ms` 强 ease-out，scale .96 起；`sheetOut 190ms var(--ease-exit)`（与 JS 对齐） |
| `toastIn 280ms` keyframes + base transition 双轨 | ✗ Emil：toast 必须可打断 → transition 不用 keyframes；keyframes 每次重播从零开始 | 删 toastIn；`transition: opacity 180ms ease, transform 200ms ease-out`，进出同轴（底部升起/沉回） |
| `inspectorIn 320ms` | △ 超 300ms 无理由 | 200ms，位移 24→18px；退场 220ms ease-exit（JS 对齐） |
| `findIn/findOut/selMenuIn/todoIn/todoOut/stampIn(.82)/slideLeftIn` | △ 方向与轴差异化是对的，时长未分层、stampIn .82 过猛 | 全部归入 `--dur-fast 130ms` 一档（高频面），stampIn scale .96 起，todoOut 150ms（JS 对齐） |
| `settingsIn/Out/PaneIn` | △ 页级 260ms→280ms(slow 档)，pane 180→130(fast 档)；曲线统一 | 重写为令牌引用 |
| `scrim fade 160ms` | ✗ 与 JS `animateOut(scrim,170)` 不对齐（入场未完即被隐藏） | 170ms 对齐 |

### 编排（choreograph）

| 旧动效 | 评判 | 新方案 |
| --- | --- | --- |
| 架构页入场四层叠加（pageIn + TopIn + CanvasIn + CardIn + 侧栏 40..290ms stagger） | ✗ 一容器多次入场 + 290ms 队列（用户等界面演完才能用） | 页面整体 `fade 200ms`；顶栏/画布/侧栏静态到达；删除 4 个 keyframes |
| `.agent-row/.arch-agent-row` stagger 40..200ms 线性队列 | ✗ 均匀 delay = 节拍器（choreograph 禁令） | 封顶 120ms：0/40/80，第 4 行起同到 |
| `.doctor-item` stagger 20..180ms 十级 | ✗ 同上 | 0/25/50，第 4 行起 75ms |
| `.mcp-row/.skill-row` 40..120ms | △ 低频面可留轻编排 | 0/40/80 封顶 |
| `.model-item` 22ms×7 队列、`.attach-chip` 30ms×5 | △ 封顶 | 0/25/50 → 75ms / 0/30/60 → 90ms |
| `.empty` 520ms + `.suggest` 420ms + 60/120/180ms | △ 空状态属 Rare 档（愉悦预算成立），但整体过慢 | 容器 280ms，建议项 200ms，stagger 50/100/150ms |

### 状态循环收敛（17 个循环 keyframes → 9 个）

| 旧 | 新 | 说明 |
| --- | --- | --- |
| pulse（1 处定义，5 处使用） | `pulse` 保留 | 纯 opacity 心跳 |
| retryPulse/toolPulse/archPulse/inspPulse/rp-breathe | `softPulse` | 低对比呼吸合并 |
| dotPulse/mcpPulse/archBadgeBreathe | `haloPulse` | 光环脉冲合并，颜色走 `--halo-c`（mcp 沿用 `--mcp-dot-c`） |
| archHaloPulse/archAuraBreathe | `archAura` | SVG 光环 opacity+scale 合并；archHalo（无引用死代码）删除 |
| doctorPulse | 保留 | scale 轴语义独立 |
| archRing（stroke-opacity） | `softPulse` | 元素 opacity 等效，走合成层 |
| archFlash（drop-shadow+brightness 逐帧重绘） | `archFlash` 重写 | stroke 描边脉冲 500ms 一次（性能修复） |
| archNodeIn 520ms 弹簧 | `archNodeIn 280ms` | scale .965 起，说明性动效上限收敛 |
| archEdgeDraw 900ms/.4,0,.2,1 | 500ms 强 ease-out | 说明性动效允许长时长，但去弹簧 |

### 布局过渡（正当例外，保留并统一曲线）

| 位置 | 说明 |
| --- | --- |
| `.app` grid-template-columns 260ms | 侧栏收展（内容重排），曲线统一 `--ease-inout-strong` |
| `.tools` max-height/margin 240ms | 工具折叠（accordion 类文档例外） |
| `.chat/.composer-area` margin-right 260ms | inspector 让位（内容跟手） |
| `.doctor-bar-fill` width 260ms | 评分条（documented exception） |

### 主题过渡

`background-color/color/border-color 260ms ease`（12 个容器）：✓ 保留 —— 状态指示用途，非位移不属 reduced-motion 排除项。

## 三、新体系说明

### 令牌（唯一事实源，motion-system.css §A）

```
曲线：--ease-out-strong cubic-bezier(.23,1,.32,1)   进场/微交互/默认（强 ease-out）
     --ease-inout-strong cubic-bezier(.77,0,.175,1) 屏内移动/布局重排
     --ease-exit cubic-bezier(.4,0,1,1)             退场收束（不弹跳）
时长：--dur-fast 130ms（菜单/按压/焦点/行内）
     --dur-base 200ms（行/卡/面板/消息）
     --dur-slow 280ms（sheet/全屏页/图节点）
兼容别名：--ease-lively / --ease-spring / --ease-out-soft → 全部指向强 ease-out
（散落在未迁移规则里的旧引用不炸，且旧弹簧的过冲全部消失）
```

弹簧使用裁决：本应用是功能型 dashboard（cohesion 判据），**入场一律去弹簧**；
弹跳只保留给一次性游戏化反馈（todoPop 上限 1.15，旧 .4→1.5 已收敛）。

### 退场时长 ↔ app.js `animateOut` 常量对齐表（入场用令牌，退场跟 JS）

| 浮层 | CSS 退场 | JS animateOut |
| --- | --- | --- |
| menu / find-bar | 130ms ease-exit | 130 |
| todo 面板 | 150ms | 150 |
| scrim | 170ms | 170 |
| sheet | 190ms | 190 |
| settings / inspector / arch 页 | 200–220ms | 200/220 |

### 编排规则（choreograph 落地）

- 一容器一次入场：msg 入场时 summary 不再二次入场；架构页整体 fade。
- stagger 一律**非均匀封顶**（40/80/120、25/50/75 档），第 N 行起同到，绝不线性队列。
- 编排不阻塞交互：全部为 transform/opacity 合成层动画，无 pointer 锁。
- 退场同时收束、不反向 stagger（`is-closing` 统一 ease-exit）。

### 性能（animation-performance 落地）

- 全部入场/循环走 `transform`/`opacity`（合成层）；
- 修复：approvalGlow 盒阴影重绘 → ::before opacity；archFlash drop-shadow 滤镜 → stroke 描边；
  archRing stroke-opacity → 元素 opacity；haloPulse 用静态盒阴影+透明度（不再逐帧扩张阴影半径）；
- `transition:all` 保持 0 处；布局过渡仅 4 处文档化例外；
- 无父级 CSS 变量驱动子 transform 的模式。

### 可访问性

- 18 个分散 reduced-motion 块 → **单一兜底块**（motion-system §L）：
  全局急停 1ms（fill both 保证终态落位）+ 循环逐元素钉静态（呼吸点/扫光/思考点/审批光环），
  保证静态呈现完整可读；按压反馈归零。
- 键盘焦点环 `:focus-visible` 统一；hover 反馈为底色（触屏无 hover 残留问题）。

## 四、JS 编排补丁（js_orchestration_patches.py，锚点式）

| # | 补丁 | 用途 | G5 依赖 |
| --- | --- | --- | --- |
| P1 | `spawnListGhost()` 辅助函数（插入 hideMenus 前） | 列表项删除的 Enter/Exit 配对：原件立即离开布局（兄弟先合拢，不用 height 动画），克隆体 fixed 原位 160ms 收束淡出 | 否 |
| P2 | todo 删除两处 | 同上（todoDelete 捕获行 → 重渲染后播幽灵） | 否 |
| P3 | 会话删除两处 | 同上（侧栏会话行删除配对） | **是** |
| P4 | `paint()` 重挂取消入场 | 打断处理：流式 painter.mount 重建时移除 `is-enter`，正文不边写边飞 | **是** |
| P5 | `openMenu` origin-aware | 菜单从锚点方向长出来：下方=顶部锚，上翻=底部锚，夹持=右侧锚 | **是** |
| P6 | 会话右键菜单 origin-aware | 同上（手工定位版） | **是** |

配套 CSS：`.list-exit-ghost` + `@keyframes listExit`（motion-system §K）。

## 五、应用与回滚

```bash
cd E:\dsh-desktop\tools\patches

# 1) 校验（不写盘）：报告每个锚点在当前树的命中现状 + 自检
python apply-anim.py --dry-run

# 2) 应用（推荐顺序：G5 落地前只动 CSS）
python apply-anim.py --skip-js     # 仅 CSS 重做
python apply-anim.py               # CSS + JS 编排补丁（建议 G5 之后）

# 3) 回滚（自动备份在 backup/<时间戳>/）
python apply-anim.py --restore backup/<时间戳>
```

脚本安全机制：
- 所有删除/替换要求锚点精确命中（块删除用注释头 + 括号配平）；任何 miss → 中止不落盘；
- 应用后自检：CSS 括号配平、`@keyframes` 重名检查、`animation:` 引用解析（引用名必须有定义）；
- JS 应用前先对补丁后文本跑 `node --check`（临时文件），语法不过不写盘。

## 六、验证记录（2026-11-14 实跑）

```
--dry-run：CSS 65 操作全命中 0 miss；JS 8 补丁全命中 0 miss
自检（应用后内容）：括号 { ×1110 } ×1110 ✓；@keyframes 43 个重名无 ✓；
animation 引用 95 处未解析无 ✓；旧 63 → 保留重定义 39 / 删除 24 / 新增 4
临时副本真实执行：CSS 变换 + JS 补丁落盘副本 → node --check PASS；
hover lift 残留 0；reduced-motion 块收敛为 1；transition:all 0；rise/msgIn/pop 无残留
```

## 七、需要人工 feel-check 的点（代码无法自判）

1. msg/tool 行 200ms 入场在真实流式节奏下是否仍嫌密（若密可降到 160ms，改 `--dur-base` 会全局联动，需谨慎）；
2. haloPulse 的 3px→6px 光环幅度在深色壁纸上是否可辨；
3. 菜单 origin-aware 在右下角锚点（window 边缘）时的手反转手感；
4. `.empty` 280ms 容器 + 50ms 三档 stagger 的首访愉悦感是否足够（Rare 档可放宽到 320ms）。
