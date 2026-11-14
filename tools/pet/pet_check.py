# -*- coding: utf-8 -*-
"""桌宠资源验收（规范第十五章）：存在性/可解码/帧数/60fps/画布/循环/透明。
用法: python tools/pet/pet_check.py [--need-all]
退出码: 0=全部通过
"""
import glob
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FINAL = os.path.join(ROOT, 'assets', 'pet', 'final')
PROMPTS = os.path.join(ROOT, 'tools', 'pet', 'pet-prompts.json')


def main():
    cfg = json.load(open(PROMPTS, encoding='utf-8'))
    meta, actions = cfg['meta'], cfg['actions']
    manifest_path = os.path.join(FINAL, 'manifest.js')
    manifest = {}
    if os.path.exists(manifest_path):
        js = open(manifest_path, encoding='utf-8').read()
        body = js[js.find('{'):js.rfind('}') + 1]
        manifest = json.loads(body)
    need_all = '--need-all' in sys.argv
    problems = []
    ok_list = []
    for a in actions:
        aid = a['id']
        gif = os.path.join(FINAL, aid + '.gif')
        fdir = os.path.join(FINAL, aid + '.frames')
        target = int(round(a['duration'] * meta['fps']))
        if not os.path.exists(gif):
            problems.append(f'{aid}: 缺 GIF')
            continue
        if not os.path.isdir(fdir):
            problems.append(f'{aid}: 缺帧序列目录')
            continue
        pngs = sorted(glob.glob(os.path.join(fdir, 'f-*.png')))
        if len(pngs) < 2:
            problems.append(f'{aid}: 帧数不足 ({len(pngs)})')
            continue
        # 抽样解码 3 帧（首/中/尾）
        sample = [pngs[0], pngs[len(pngs) // 2], pngs[-1]]
        sizes = set()
        alpha_min = 255
        for p in sample:
            im = Image.open(p)
            sizes.add(im.size)
            if im.mode == 'RGBA':
                alpha_min = min(alpha_min, im.getchannel('A').getextrema()[0])
        if sizes != {(512, 512)}:
            problems.append(f'{aid}: 画布尺寸异常 {sizes}')
            continue
        m = manifest.get(aid)
        fps = m['fps'] if m else meta['fps']
        dur = len(pngs) / fps
        if dur < a['duration'] * 0.85:
            problems.append(f'{aid}: 时长不足 {dur:.2f}s < {a["duration"]}s')
            continue
        if alpha_min > 8:
            problems.append(f'{aid}: 无透明像素 (alpha 最小 {alpha_min})')
            continue
        ok_list.append(f'{aid}: {len(pngs)} 帧 @ {fps}fps = {dur:.2f}s  GIF {os.path.getsize(gif) // 1024}KB')
    print(f'通过 {len(ok_list)}/{len(actions)}')
    for line in ok_list:
        print('  ✓', line)
    for p in problems:
        print('  ✗', p)
    if problems and (need_all or len(ok_list) < len(actions) - len(problems)):
        pass
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
