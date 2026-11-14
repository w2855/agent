# -*- coding: utf-8 -*-
"""桌宠渲染器：关键帧对齐 → 光流插帧到 60fps → GIF + PNG 帧序列。
用法: python tools/pet/pet_render.py [--actions idle,wave]
输出: assets/pet/final/<action>.gif + assets/pet/final/<action>.frames/f-0001.png...
"""
import argparse
import glob
import json
import os

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GEN = os.path.join(ROOT, 'assets', 'pet', 'generated')
FINAL = os.path.join(ROOT, 'assets', 'pet', 'final')
PROMPTS = os.path.join(ROOT, 'tools', 'pet', 'pet-prompts.json')
CANVAS = 512
BODY_RATIO = 0.78  # 角色身高占画布比例
GIF_DELAY = 2      # GIF 容器统一 20ms（GIF 无法表达 16.67ms，浏览器会钳制 10ms 帧）；真 60fps 由播放器 PNG 序列实现


def normalize_frame(img):
    """裁剪角色包围盒 → 统一身高 → 512 画布底部居中。返回 RGBA uint8。"""
    rgba = img.convert('RGBA')
    arr = np.array(rgba)
    alpha = arr[:, :, 3]
    ys, xs = np.where(alpha > 12)
    if len(ys) == 0:
        return None
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    crop = arr[y0:y1 + 1, x0:x1 + 1]
    h, w = crop.shape[:2]
    target_h = int(CANVAS * BODY_RATIO)
    scale = target_h / h
    new_w = max(1, int(round(w * scale)))
    resized = cv2.resize(crop, (new_w, target_h), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((CANVAS, CANVAS, 4), dtype=np.uint8)
    px = (CANVAS - new_w) // 2
    py = CANVAS - target_h - 10  # 脚底基准线统一
    canvas[py:py + target_h, px:px + new_w] = resized
    return canvas


def load_keyframes(action_id):
    files = sorted(glob.glob(os.path.join(GEN, action_id, 'pose-*.png')),
                   key=lambda p: int(''.join(c for c in os.path.basename(p) if c.isdigit())))
    frames = []
    for f in files:
        img = Image.open(f)
        norm = normalize_frame(img)
        if norm is not None:
            frames.append(norm)
    return frames


def warp_by_flow(img, flow):
    """后向映射：按光流场采样。img: HxWx4 float32, flow: HxWx2"""
    h, w = flow.shape[:2]
    grid_y, grid_x = np.mgrid[0:h, 0:w].astype(np.float32)
    map_x = grid_x + flow[:, :, 0]
    map_y = grid_y + flow[:, :, 1]
    return cv2.remap(img, map_x, map_y, cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))


def inbetween(a, b, steps):
    """A→B 之间光流插帧，返回 steps 张中间帧（不含 A、B 本身）。
    alpha 感知合成：各自 warp 后按「对方透明区归我、重叠区按覆盖率过渡」合成，
    避免线性 RGBA 混合产生的半透明重影。"""
    a_f = a.astype(np.float32)
    b_f = b.astype(np.float32)
    # Farneback 要求单通道灰度输入
    ga = cv2.cvtColor(a, cv2.COLOR_BGRA2GRAY) if a.shape[2] == 4 else cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
    gb = cv2.cvtColor(b, cv2.COLOR_BGRA2GRAY) if b.shape[2] == 4 else cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    flow = cv2.calcOpticalFlowFarneback(ga, gb, None, 0.5, 3, 15, 3, 5, 1.2, 0)
    out = []
    for i in range(1, steps + 1):
        t = i / (steps + 1)
        wa = warp_by_flow(a_f, flow * t)          # A 向 B 移动 t
        wb = warp_by_flow(b_f, flow * (t - 1.0))  # B 向 A 回退 (1-t)
        alpha_a = (wa[:, :, 3:4] / 255.0)
        alpha_b = (wb[:, :, 3:4] / 255.0)
        # 覆盖率权重：A 独占区→A，B 独占区→B，重叠区按 t 过渡
        w_a = alpha_a * (1 - alpha_b) + alpha_a * alpha_b * (1 - t)
        w_b = alpha_b * (1 - alpha_a) + alpha_a * alpha_b * t
        denom = w_a + w_b
        denom[denom < 1e-4] = 1.0
        rgb = (wa[:, :, :3] * (w_a / denom) + wb[:, :, :3] * (w_b / denom))
        # 透明度用覆盖率（任一来源不透明即为不透明），而不是混合权重——否则重叠区人物内部会半透明
        alpha = np.clip(np.maximum(alpha_a, alpha_b) * 255.0, 0, 255)
        frame = np.concatenate([rgb.astype(np.uint8), alpha.astype(np.uint8)], axis=2)
        out.append(frame)
    return out


def render_action(meta, action):
    """直出模式：只播放真实生成的关键帧，不加任何插值/变形/特效。
    8 关键帧在 60fps 时间轴上均匀直切（anime on-8s 节奏），无缝循环。"""
    aid = action['id']
    frames = load_keyframes(aid)
    if len(frames) < 4:
        return False, f'关键帧不足: {len(frames)}'
    n = len(frames)
    total_ticks = int(round(action['duration'] * meta['fps']))   # 60fps 时间轴总格数
    hold = total_ticks // n                                      # 每张关键帧停留格数
    # GIF：8 张关键帧，逐帧延迟 = 停留时长（无任何添加帧）
    gif_path = os.path.join(FINAL, aid + '.gif')
    per_pose_ms = round(total_ticks / n * (1000 / meta['fps']) / 10) * 10  # 取整到 10ms
    durations = [per_pose_ms] * n
    pil_frames = [Image.fromarray(f) for f in frames]
    pal = [f.convert('P', palette=Image.ADAPTIVE, colors=255) for f in pil_frames]
    pal[0].save(gif_path, save_all=True, append_images=pal[1:], loop=0,
                duration=durations, transparency=255, disposal=2)
    # 播放器帧目录：直出关键帧（pet.js 按帧数在 60fps 时钟上均匀直切）
    fdir = os.path.join(FINAL, aid + '.frames')
    os.makedirs(fdir, exist_ok=True)
    for old_f in glob.glob(os.path.join(fdir, 'f-*.png')):
        os.remove(old_f)
    for i, fr in enumerate(frames):
        Image.fromarray(fr).save(os.path.join(fdir, f'f-{i + 1:04d}.png'), optimize=True)
    json.dump({'action': aid, 'fps': meta['fps'], 'frames': n,
               'holdTicks': hold, 'durationSec': round(total_ticks / meta['fps'], 2),
               'poseMs': per_pose_ms, 'mode': 'straight', 'canvas': CANVAS},
              open(os.path.join(FINAL, aid + '.meta.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    return True, (aid, n)


def write_manifest(results):
    """生成 assets/pet/final/manifest.js：pet.js 用脚本标签读取帧数（file:// 下 fetch 被禁）"""
    manifest = {}
    for ok, info in results:
        if ok:
            aid, frames = info
            manifest[aid] = {'frames': frames, 'fps': 60}
    js = 'window.PET_MANIFEST = ' + json.dumps(manifest, ensure_ascii=False, indent=1) + ';\n'
    open(os.path.join(FINAL, 'manifest.js'), 'w', encoding='utf-8').write(js)
    return len(manifest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--actions', default='all')
    args = ap.parse_args()
    cfg = json.load(open(PROMPTS, encoding='utf-8'))
    meta, actions = cfg['meta'], cfg['actions']
    if args.actions != 'all':
        want = set(args.actions.split(','))
        actions = [a for a in actions if a['id'] in want]
    os.makedirs(FINAL, exist_ok=True)
    ok_count = 0
    results = []
    for a in actions:
        ok, info = render_action(meta, a)
        results.append((ok, info) if ok else (False, None))
        print(('OK ' if ok else 'FAIL ') + str(info), flush=True)
        ok_count += ok
    written = write_manifest(results)
    print(f'渲染完成 {ok_count}/{len(actions)}，manifest 写入 {written} 个动作', flush=True)


if __name__ == '__main__':
    main()
