# DSH 桌宠资产目录

> **⏸ 状态：暂停中（用户决定，2026-11-14）。**
> 完整恢复手册见 [docs/pet-paused.md](../../docs/pet-paused.md)；现存 5/35 GIF（wave、happy、sleepy、confused、shy），其余动作关键帧待网关配额恢复后补生成。

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `reference/` | `character_master.png` 角色主参考图（生成一致性锚点） |
| `generated/` | 关键帧原图：15/35 动作共 112 张（clicked 缺 2、patted 缺 7，20 个动作未生成） |
| `metadata/` | 35 个动作姿势表 JSON + 最近一次生成汇总 `_generate-last.json` |
| `final/` | 渲染产物：5 个直出 GIF + `.frames/` 帧序列（gitignore，可再生）+ `.meta.json` + `manifest.js`（idle.gif 已删待重生成） |
| `frames/` | 空目录（历史遗留） |
| `preview.html` | 动画预览页（内容已过期，恢复时更新） |

## 三条命令

```bash
# 1. 生成关键帧（断点续跑：已有 pose 自动跳过；限流期用 --concurrency 2）
python tools/pet/pet_generate.py

# 2. 渲染：关键帧对齐 → 512 画布直出 → GIF + 帧序列 + manifest.js
python tools/pet/pet_render.py

# 3. 验收（存在性/可解码/帧数/时长/512画布/透明/manifest，退出码 0 = 全过）
python tools/pet/pet_check.py
```

目检：浏览器打开 `renderer/pet.html?demo=1`（演示模式，无需主进程接线）。
