# DSH Desktop 打包发布指南

本文档固化 2026-11-14 打包当天踩过的全部坑。打包入口统一为 `tools/release.js`，不要手敲 `npx electron-builder`。

## 一键命令

```bash
# 标准打包（预检 + 构建 + 后验）
node tools/release.js

# 工作区有进行中的改动（如另一条流水线在改 renderer/）且确认要打进包里时
node tools/release.js --skip-precheck

# 发版升版本号（只改 package.json 的 version，不构建）
node tools/release.js --bump patch    # 0.1.0 -> 0.1.1
node tools/release.js --bump minor    # 0.1.0 -> 0.2.0
node tools/release.js --bump major    # 0.1.0 -> 1.0.0
```

退出码语义（CI / 脚本判断用）：

| 退出码 | 含义 |
|--------|------|
| 0 | 成功 |
| 1 | 用法错误 / 未预期内部错误 |
| 2 | 预检失败（语法错误、electronVersion 未钉版等） |
| 3 | 构建失败（含超时强制终止） |
| 4 | 后验失败（产物缺失 / 旧产物冒充 / 产物名不符） |

## 前置条件

- Node.js 已安装（脚本本身用 `process.execPath` 做语法检查）。
- `node_modules/` 已安装（`npm install`）——electron-builder 在本地依赖里。
- `package.json` 的 `build.electronVersion` 是精确版本（如 `45.3.1`），不能是 `^45.3.1` 之类的范围值；预检会强制校验。
- 可选环境变量：
  - `ELECTRON_MIRROR`：electron zip 下载镜像。脚本默认注入 `https://npmmirror.com/mirrors/electron/`，已有值则尊重不覆盖。
  - `RELEASE_BUILD_TIMEOUT_MS`：构建超时保护，默认 `600000`（10 分钟）。机器慢或首次冷缓存时建议调到 `1200000`。

## 坑对照表（2026-11-14 实录 → 固化措施）

| # | 坑 | 现象 | 固化措施 |
|---|----|------|----------|
| 1 | 版本范围解析失败 | `node_modules` 缺失时，`^45.3.1` 范围值让 electron-builder 无法定位具体 electron zip，直接报错 | `package.json build.electronVersion` 已钉死 `45.3.1`；脚本预检强制校验"存在且非范围值"，不合规直接退出码 2 |
| 2 | GitHub 下载间歇超时 | electron-builder 从官方 GitHub Release 拉 electron zip 时间歇 `ETIMEDOUT` | 构建前自动注入 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（已有环境变量则不覆盖） |
| 3 | CLI 参数不存在 | electron-builder 26 没有 `--electron-version` CLI 参数，传了报 `Unknown argument` | 脚本只跑 `npx electron-builder --win portable`，版本一律走 `package.json` |
| 4 | 构建耗时长 | 完整构建 >8 分钟，前台跑容易误判卡死 | 实时透传构建日志（行前缀 `[build]`）、默认 10 分钟超时保护（超时杀整棵进程树）、全量日志落盘 `release/build.log`、失败时自动打印最后 30 行定位 |
| 5 | 产物核对 | 产物固定为 `release/DSH-Desktop-<version>.exe`（约 105 MB / 约 110,000,000 字节） | 后验按 `package.json` 版本核对精确产物名、输出精确字节数与路径、校验 mtime 新鲜度（防止旧 exe 冒充本次产物） |

## 产物位置

- 单文件便携版：`release/DSH-Desktop-<version>.exe`（portable x64，约 105 MB）
- 解包调试目录：`release/win-unpacked/`
- 构建日志：`release/build.log`
- `release/` 整个目录已在 `.gitignore`，不会入库。

## 版本升级流程（发版）

1. 升版本号并同步产物名（`artifactName` 用的是 `${version}` 模板，无需改其他文件）：

   ```bash
   node tools/release.js --bump patch
   ```

2. 提交 `package.json` 的版本改动（脚本不代 commit）：

   ```bash
   git add package.json
   git commit -m "chore: bump version to x.y.z"
   ```

3. 打包并核对产物：

   ```bash
   node tools/release.js
   ```

4. 产物在 `release/DSH-Desktop-<新版本>.exe`，脚本会打印精确字节与耗时。

## 常见问题

- **预检报"未提交改动会进包"**：这是警告不是失败。若那些改动本来就该打包（如进行中的功能），用 `--skip-precheck` 语义化跳过；脚本仍会列出改动清单。
- **构建超时（退出码 3）**：先确认不是网络问题（看 `release/build.log` 末尾）；冷缓存机器可 `RELEASE_BUILD_TIMEOUT_MS=1200000 node tools/release.js` 放宽到 20 分钟。
- **产物名与版本不符（退出码 4 或警告）**：多半是 `--bump` 后忘了重新构建，或 `package.json` 版本没提交导致两边版本不一致。
