# shot-profiles · 截图回归档案

引擎 [tools/shot-suite.js](../shot-suite.js) 是项目无关的视觉回归编排器；**每个项目的场景清单写在一份档案 JSON 里**，引擎按 `--profile <name>` 加载。

## 档案 schema（tools/shot-profiles/<name>.json）

```jsonc
{
  "name": "dsh",                  // 档案名（--profile 用）
  "appPath": ".",                 // 被测 Electron 应用根目录（相对项目根；网页场景可省略）
  "shotOutput": "shot.png",       // 应用 --shot 产物位置（相对 appPath）
  "scriptPassthrough": false,     // true=直接把探针路径传给 --script（不写临时中转文件）
  "threshold": 0.5,               // 默认判定阈值：像素差异率百分比（场景级可覆盖）
  "userDataSetup": {              // 档案级 user-data 种子（注入每个场景的隔离目录，场景级可叠加）
    "files": [ { "src": "tools/shot-profiles/seeds/soft-render.flag", "dest": "soft-render.flag" } ]
  },
  "setupCommand": {               // 档案级前置命令（长驻服务，如 mock 网关；跑完全程后回收）
    "cmd": "node", "args": ["tools/mock-gateway.js"], "cwd": ".",
    "portProbe": 57321,           // 就绪探测端口；已被外部占用则复用不重启
    "label": "mock 网关"
  },
  "scenarios": [
    {
      "id": "chat-idle",          // 场景 ID（截图/基线/报告的文件名）
      "desc": "空会话 + 欢迎态",
      "script": "tools/shot-scenarios/chat-idle.js",  // Electron 应用模式：探针脚本（相对 appPath）
      "url": "http://127.0.0.1:3000",                 // 或网页模式：该场景直接 loadURL（二选一）
      "waitMs": 1500,             // 网页场景：loadURL 后等待毫秒
      "threshold": 0.5,           // 场景级阈值覆盖
      "setupCommand": { "cmd": "node", "args": ["server.js"], "portProbe": 3000 },  // 场景级前置（跑完即回收）
      "userDataSetup": { "files": [ { "src": "fixtures/localstorage.json", "dest": "Local Storage/seed.json" } ] }
    }
  ]
}
```

## 三步把整套系统用到别的项目

1. **复制**：把 `tools/shot-suite.js`、`tools/pixdiff.py`、`tools/shot-web-capture.js`、`tools/shot-profiles/`（空目录即可）复制到目标项目的 `tools/` 下（要求：Python 带 Pillow、目标应用可跑 `node_modules/electron`；纯网页项目无需探针）。
2. **写档案**：在 `tools/shot-profiles/<项目名>.json` 里按上面的 schema 列出场景——Electron 应用给每个场景一个探针脚本（`async () => { …操作页面…; return {ok, note} }`，仿 `tools/shot-scenarios/*.js`）；纯网页直接用 `--url` 模式，零探针。
3. **首跑建基线，此后回归**：`node tools/shot-suite.js --profile <项目名> --update`（当前渲染 = 期望），之后 `node tools/shot-suite.js --profile <项目名>` 每次改动后对比，出现 CHANGED 即视觉回归。

任意网页（不写档案）：
```bash
node tools/shot-suite.js --url http://127.0.0.1:3000 --name mysite --update   # 首跑建基线
node tools/shot-suite.js --url http://127.0.0.1:3000 --name mysite           # 对比回归
```

## 噪声与稳定性

- 引擎对每个场景自动重试 1 次（150s 超时兜底），启动前清扫带 `.shot-run` 标记的遗留 electron 进程（套件被强杀时的僵尸实例会乱写 shot.png 污染后续场景）。
- 共享机器上并行 GUI 操作可能偶发切换被测应用视图：DSH 探针内置 300ms 视图守卫；若对比仍报 CHANGED，先看 gallery 的 diff 图确认是否真回归，环境噪声场景重跑一次即可。
- 时钟/动态徽标类区域会产生少量像素噪声（实测 <0.2%），远低于默认 0.5% 阈值；动态区域特别多的场景可在档案里单独调 `threshold`。
