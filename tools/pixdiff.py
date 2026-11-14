# -*- coding: utf-8 -*-
"""pixdiff.py — 像素级截图对比（shot-suite 引擎的对比后端，零第三方 CLI 依赖，仅用 PIL）。

用法：python -X utf8 pixdiff.py <基线图> <当前图> <差异输出图> [通道容差，默认 8]

输出（stdout，最后一行 JSON）：
  {"changed": bool, "ratio": 0.00123, "diffPixels": 912, "totalPixels": 768000,
   "sizeMismatch": false, "width": 1280, "height": 600}

规则：
  - 逐像素比较 RGB 三通道；任一通道差 > 容差（默认 8，抗 PNG 压缩/抗锯齿噪声）记为差异像素。
  - 尺寸不同 = 必然 CHANGED：按较大画布拼齐后全量比较（补齐区域全部算差异）。
  - 差异高亮图：在当前图上把差异像素涂红后写到 <差异输出图>。
  - ratio = diffPixels / totalPixels；阈值判定由引擎（shot-suite.js）负责，这里只报事实。
"""
import sys
import json

from PIL import Image, ImageChops


def build_mask(diff_rgb, tol):
    """三通道差值图 → 差异掩码（任一通道 > tol 即 255）。"""
    bands = diff_rgb.split()
    thr = bands[0].point(lambda v: 255 if v > tol else 0)
    for band in bands[1:]:
        thr = ImageChops.lighter(thr, band.point(lambda v: 255 if v > tol else 0))
    return thr


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "usage: pixdiff.py <base> <current> <diffout> [tolerance]"}))
        return 2
    base_path, cur_path, diff_out = sys.argv[1], sys.argv[2], sys.argv[3]
    tol = int(sys.argv[4]) if len(sys.argv) > 4 else 8

    base = Image.open(base_path).convert("RGB")
    cur = Image.open(cur_path).convert("RGB")
    bw, bh = base.size
    cw, ch = cur.size
    size_mismatch = (bw, bh) != (cw, ch)

    if size_mismatch:
        # 尺寸不同：补齐到较大画布再比（黑底补齐区域与对方像素必然不同 → 全标差异）
        w, h = max(bw, cw), max(bh, ch)
        ca = Image.new("RGB", (w, h), (0, 0, 0))
        ca.paste(base, (0, 0))
        cb = Image.new("RGB", (w, h), (0, 0, 0))
        cb.paste(cur, (0, 0))
    else:
        w, h = bw, bh
        ca, cb = base, cur

    diff_rgb = ImageChops.difference(ca, cb)
    mask = build_mask(diff_rgb, tol)
    hist = mask.histogram()
    diff_pixels = sum(hist[1:])
    total = w * h
    ratio = diff_pixels / total if total else 0.0

    # 差异高亮图：当前图上差异像素涂红
    highlight = cb.copy()
    red = Image.new("RGB", (w, h), (255, 0, 0))
    highlight.paste(red, (0, 0), mask)
    highlight.save(diff_out)

    print(json.dumps({
        "changed": diff_pixels > 0,
        "ratio": round(ratio, 8),
        "diffPixels": diff_pixels,
        "totalPixels": total,
        "sizeMismatch": size_mismatch,
        "width": w,
        "height": h,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
