# ⏸ 桌宠功能暂停归档（2026-11-14）

> **状态：暂停中（用户决定）。** 代码与资产完好，可随时恢复。
> 暂停直接原因：图片生成网关配额耗尽（`insufficient_quota`），剩余 29 个动作的关键帧无法继续生成。
> 相关提交：`690ac84`（第一阶段：35 动作姿势表 + 生成器 + 渲染器 + 验收脚本）、`b3d7a9b`（渲染升级 + 批 1 六动作验收通过）、`890e3cd`（直出模式，废弃光流插帧；同轮宣布暂停）。

---

## 一、当前状态

### 1.1 管线已验证清单（全部实测通过）

| 环节 | 状态 | 说明 |
| --- | --- | --- |
| 参考图一致性 | ✅ 已验证 | `pet_generate.py` 走 `/v1/images/edits` 端点，multipart 携带 `assets/pet/reference/character_master.png`，提示词锁定角色特征（发型/猫爪卫衣/百褶裙等），690ac84 批 1 六动作验收通过 |
| 透明背景 | ✅ 已验证 | 网关 `background=transparent` + `pet_check.py` 校验 alpha 最小值 ≤ 8 |
| 直出模式 | ✅ 已验证 | 890e3cd 起：只播真实关键帧，60fps 时钟上均匀直切，零添加帧。GIF 逐帧延迟取整到 10ms；播放器端用 PNG 帧序列 + rAF 累计时间实现真 60fps |
| 验收脚本 | ✅ 已验证 | `pet_check.py`：存在性 / 可解码 / 帧数 / 时长 / 512 画布 / 透明 / manifest 一致，退出码 0 = 全过 |
| 光流插帧 | ❌ 已否决 | 用户反馈产生"过渡动画感"，890e3cd 废弃。`pet_render.py` 中 `inbetween()` / `warp_by_flow()` 仅留档不再调用，**恢复时不要走回插帧路线** |

验收时点：b3d7a9b 批 1 六动作（idle/wave/happy/sleepy/confused/shy）验收全过；890e3cd 直出化后保留 5 个 GIF，idle 因姿势幅度不足已删除待重生成 → **现存 5/35（wave、happy、sleepy、confused、shy）**。

### 1.2 渲染层三个文件（未接线，保持原样）

- `renderer/pet.js` — PNG 帧序列播放器（rAF 累计时间 60fps）+ 35 动作状态机（优先级 / 一次性动画保护 / 过期 turn 事件丢弃）+ 桥绑定 + 交互（单击 / 双击摸头 / 拖动）+ 待机 90s 转 sleepy。
  - 回退链：帧序列缺失 → 同名 GIF `<img>` 层 → 参考图静态（`character_master.png`）。
  - 桥探测顺序：`window.petBridge || window.dsh?.petBridge`；500ms 重试 20 次后进入演示模式。
- `renderer/pet.html` — 512×512 canvas + CSP（`img-src file:`）+ `<script>` 加载 `manifest.js`（file:// 下 fetch 被禁，必须用 script 标签）。
- `renderer/pet.css` — 透明无边框整窗可拖拽，右下角迷你按钮（happy/dance 手动触发）。

**目检途径（无需主进程）**：浏览器直接打开 `renderer/pet.html?demo=1`，演示模式自动轮播 8 个动作。
**接线状态**：`main.js` / `preload.js` / `app.js` / `index.html` 均无任何 pet 引用（grep 为零），三个文件自包含可独立运行。

---

## 二、已完成资产清单

### 2.1 `assets/pet/` 目录结构

```
assets/pet/
├── reference/
│   ├── character_master.png    # 角色主参考图（生成器每次请求都携带）
│   └── _test_ref.png           # 早期测试参考图（可清理）
├── generated/                  # 关键帧原图（edits 端点 1024×1024 输出），112 个文件
│   ├── answering|processing|reading|searching|thinking|typing|waiting|working/  # 各 8 张
│   ├── confused|happy|shy|sleepy|wave/                                          # 各 8 张（已直出）
│   ├── clicked/               # 6 张（缺 pose-5、pose-7）
│   ├── patted/                # 1 张（缺 pose-2~8）
│   └── _test_idle.png         # 测试产物（可清理）
├── metadata/                   # 35 个 <action>.json 姿势表备份 + _generate-last.json（最近一次生成汇总）
├── frames/                     # 空目录（历史遗留）
├── final/                      # 渲染产物
│   ├── wave|happy|sleepy|confused|shy.gif     # 5 个直出 GIF（约 250~320KB）
│   ├── wave|happy|sleepy|confused|shy.frames/ # 8 帧 PNG 帧序列（被 .gitignore 忽略，pet_render.py 可确定性再生）
│   ├── wave|happy|sleepy|confused|shy.meta.json # fps/frames/holdTicks/poseMs/mode
│   ├── manifest.js             # window.PET_MANIFEST = { <action>: { frames, fps } }，pet.js 按此加载帧
│   ├── idle-contact.png / idle-gif-decode.png / master-sprite.png  # 调试图（可清理）
│   └── (idle.gif 已删，待重生成)
└── preview.html                # 动画预览页（内容过期：仍写 6/35 且引用已删的 idle.gif，恢复时顺手更新）
```

**关键帧覆盖度**：15/35 动作有关键帧（13 个全量 8 张 + clicked 6 + patted 1）；**20 个动作零关键帧**（idle、dragging、awakened、message、welcome、greeting、success、error、completed、issue_found、surprised、celebrating、encourage、drink、eat、phone、play_cat、stretch、sleeping、dance）。
`.gitignore` 第 16-17 行：`assets/pet/**/*.frames/` 不入库（帧序列由关键帧确定性再生），`generated/` 与 `final/*.gif` 已入库。

### 2.2 `tools/pet/` 四个文件

| 文件 | 用途 | 用法 |
| --- | --- | --- |
| `pet-prompts.json` | 35 动作姿势表（每动作 8 条英文姿势文本 + duration 秒）+ `meta.api` 配置（`http://127.0.0.1:3000/v1/images/edits`、模型 `gpt-image-2.6`、1024×1024、transparent、timeout 300s、retries 4、concurrency 3） | 被 generate/render/check 三脚本读取 |
| `pet_generate.py` | 关键帧生成器：multipart 调 edits 端点；已有 >10KB 的 pose 自动跳过（断点续跑）；429 长退避（20s 起步逐次 +15s）；元数据落 `metadata/` | `python tools/pet/pet_generate.py [--actions idle,wave] [--concurrency 2]`（密钥走环境变量 `DSH_PET_API_KEY`） |
| `pet_render.py` | 渲染器：`normalize_frame()` 包围盒裁剪 → 身高统一 0.78×512 → 512 画布底部居中（脚底锚定）→ `render_action()` 直出 → GIF + `.frames/` + `.meta.json`，`write_manifest()` 更新 manifest.js。依赖 cv2 / numpy / Pillow | `python tools/pet/pet_render.py [--actions ...]` |
| `pet_check.py` | 验收：GIF 存在 / 帧序列 ≥2 帧 / 抽样解码 512×512 / alpha ≤ 8 / 时长 ≥ 0.85×duration / manifest 一致，退出码 0 = 全过 | `python tools/pet/pet_check.py` |

---

## 三、恢复五步（每步含具体文件与关键函数）

### ① 主进程接线（main.js + preload.js，约 30 行）

- `main.js`：仿照现有 `createWindow()`（main.js:107 附近）新增 `createPetWindow()`，顶部 `win` 变量旁加 `petWin`：
  - BrowserWindow 参数：`width/height 512, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false`，`webPreferences` 与主窗口一致（`preload` + `contextIsolation: true` + `nodeIntegration: false`）；
  - `petWin.loadFile(path.join(__dirname, 'renderer', 'pet.html'))`；
  - 事件转发通道：`ipcMain.on('pet:events:dispatch', (_e, ev) => { if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:event', ev); })`（遵循现有 `win:` / `tray:` 前缀命名习惯，用 `pet:` 前缀）；
  - app 退出时关闭 petWin（参考托盘/窗口生命周期处理）。
- `preload.js`：在 `contextBridge.exposeInMainWorld('dsh', {...})` 内加（pet.js 两种探测都兼容）：
  ```js
  petBridge: {
    /* 渲染层 app.js → 主进程 → 桌宠窗口 */
    dispatch: (ev) => ipcRenderer.send('pet:events:dispatch', ev),
    /* 桌宠窗口接收事件；返回解绑函数（与 win.onMaximized 同款约定） */
    onEvent: (fn) => {
      const handler = (_e, ev) => fn(ev);
      ipcRenderer.on('pet:event', handler);
      return () => ipcRenderer.removeListener('pet:event', handler);
    },
  },
  ```

### ② app.js 事件适配器（约 15 行）

- 新增 `emitPetEvent(type, turnId)`：守卫 `window.dsh?.petBridge` 存在再 `dispatch({ type, turnId, ts: Date.now() })`；`type` 直接用 `pet.js` 里 `ACTIONS` 的 35 个命名（PetAnimationState）。
- 挂点两处：
  - 模型事件分发处 `window.dsh?.model?.onEvent(...)`（app.js:6096 附近）——把模型流事件映射到 `thinking` / `typing` / `working` / `answering` 等，`e.id` 作 `turnId`（pet.js 的过期回合丢弃逻辑靠它）；
  - runtime 事件分发处 `window.dsh?.runtime?.events?.onEvent(...)`（app.js:6104 附近）——映射 `success` / `error` / `completed` / `issue_found` 等结果类动作。

### ③ 设置页开关

- `renderer/index.html` 设置页（ZCode 式左导航 pane 结构）加开关；`renderer/app.js` 开关状态走 localStorage + `pet:state:set` IPC → `main.js` 控制 `petWin.show()/hide()`。参考托盘开关的实现（`tray:state:get/set`，main.js:349-358）。

### ④ 关键帧补漏（网关配额恢复后）

```bash
python tools/pet/pet_generate.py          # 全量；已有的 pose 自动跳过，直接续跑
```

- 补漏清单：20 个零关键帧动作 × 8 张 + clicked 缺 pose-5/7 + patted 缺 pose-2~8；
- **idle 特殊处理**：旧姿势幅度不足（890e3cd 注明），如 `generated/idle/` 有残留先删掉，改姿势文本（幅度加大）后重新生成；
- 生成完跑 `python tools/pet/pet_check.py` 确认无缺。

### ⑤ 渲染 35 GIF（直出模式）

```bash
python tools/pet/pet_render.py            # 全部 35 动作 → GIF + .frames/ + manifest.js
python tools/pet/pet_check.py             # 验收，退出码 0
```

- 渲染完更新 `assets/pet/preview.html`（当前内容过期：写 6/35 且引用已删的 idle.gif）；
- 目检：浏览器打开 `renderer/pet.html?demo=1`；
- 走完 ①②③ 后做一次 Electron 实机验收（主窗口对话驱动各状态 + 单击/双击/拖动交互 + 待机 90s 转 sleepy）。

---

## 四、已知坑（恢复前必读）

1. **429 限流**：网关并发上限低，批量生成极易触发。并发降到 2（`--concurrency 2`）；脚本已内置 429 长退避（20s 起步，逐次 +15s，最多 retries=4 次）；若整批连续 429，立即停手等配额窗口，不要硬刷（`metadata/_generate-last.json` 可查上次失败明细）。
2. **GIF 10ms 帧被浏览器钳制**：GIF 容器无法表达 16.67ms，10ms 帧会被浏览器钳制导致掉速。统一 20ms（`pet_render.py` 的 `GIF_DELAY = 2`）；真 60fps 由播放器端 PNG 帧序列 + rAF 累计时间实现（`pet.js` 的 `tick()`），这是双轨方案的分工，别只改一边。
3. **光流插帧已被用户否决**：视觉上产生"过渡动画感"。890e3cd 起废弃，`pet_render.py` 里 `inbetween()` / `warp_by_flow()` 仅留档。恢复时沿用直出模式（关键帧在 60fps 时间轴均匀直切），不要恢复插帧路线。
4. **file:// 环境限制**：桌宠窗口 `loadFile` 打开后 fetch 被禁 → `manifest.js` 必须用 `<script>` 标签加载（`window.PET_MANIFEST`），恢复时不要改成 fetch。
5. **过期回合事件**：`pet.js` 的 `setState()` 按 `turnId` 丢弃旧回合迟到事件（优先级 < 5 的循环态才丢弃）；适配器务必把 `e.id` 传成 `turnId`，否则旧回合事件会覆盖新回合状态。
6. **帧序列不入库**：`.gitignore` 忽略 `*.frames/`，换机器/清仓后先跑 `pet_render.py` 再生，不要手工补帧。

---

## 五、原生动画模式备忘（网关直出动画 API）

网关模型 `gpt-image-2.6` 的**生成端点支持动画参数** `frame_count` / `frame_duration_ms` / `output_format=gif`——配额恢复后可尝试一次请求直出动画 GIF，替代"关键帧生成 + 本地渲染"整条管线。实测样例（2026-11-14，当时返回 `insufficient_quota`，参数本身未被拒）：

```json
{
  "model": "gpt-image-2.6",
  "prompt": "The exact same chibi anime girl character (dark brown long wavy hair, white cat-print hoodie, black pleated skirt, black bow and cat hairpin, black platform shoes) happily waving her right hand beside her face then lowering it. 8-frame seamless loop animation. Fully transparent background, full body centered, no scene, no text.",
  "n": 1,
  "size": "1024x1024",
  "frame_count": 8,
  "frame_duration_ms": 125,
  "output_format": "gif",
  "background": "transparent"
}
```

（原样存档于仓库根 `tmp-anim-req.json`，返回体 `tmp-anim-res.json`。）

- `frame_duration_ms: 125` → 8 帧约 1s 循环；要更顺滑可加大 `frame_count`（16/24）。
- 直出 GIF 仍需过 `pet_check.py` 的透明 / 画布 / 时长校验；角色一致性需与 `character_master.png` 对比目检。
- 若该模式可用，可逐步替换直出管线（关键帧管线保留作回退）。
