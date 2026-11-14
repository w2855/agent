# -*- coding: utf-8 -*-
"""桌宠关键帧生成器：每动作 8 关键帧，edits 端点 + 参考图保证角色一致。
用法: python tools/pet/pet_generate.py [--actions idle,wave] [--concurrency 3]
输出: assets/pet/generated/<action>/pose-N.png  +  metadata/<action>.json
"""
import argparse
import base64
import concurrent.futures as cf
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REF = os.path.join(ROOT, 'assets', 'pet', 'reference', 'character_master.png')
OUT = os.path.join(ROOT, 'assets', 'pet', 'generated')
META = os.path.join(ROOT, 'assets', 'pet', 'metadata')
PROMPTS = os.path.join(ROOT, 'tools', 'pet', 'pet-prompts.json')
KEY = os.environ.get('DSH_PET_API_KEY', 'REDACTED-SECRET')


def load_cfg():
    cfg = json.load(open(PROMPTS, encoding='utf-8'))
    return cfg['meta'], cfg['actions']


def gen_keyframe(meta, action, idx, pose_text):
    """生成单个关键帧，返回 (ok, path_or_error)"""
    url = meta['api']['base'] + meta['api']['endpoint']
    prompt = (
        meta['character'] + ' ' + meta['style'] + ' ' + meta['global'] + ' '
        + f"Keyframe {idx + 1} of {meta['keyframes_per_action']} for the action \"{action['name']}\": {pose_text}"
    )
    boundary = '----dshpet' + str(time.time_ns())
    parts = []
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{meta["api"]["model"]}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="background"\r\n\r\n{meta["api"]["background"]}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n{meta["api"]["size"]}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n{prompt}\r\n'.encode())
    img_bytes = open(REF, 'rb').read()
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="reference.png"\r\n'
        f'Content-Type: image/png\r\n\r\n'.encode() + img_bytes + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    body = b''.join(parts)
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
    })
    for attempt in range(1 + meta['api']['retries']):
        try:
            with urllib.request.urlopen(req, timeout=meta['api']['timeout']) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            b64 = data['data'][0].get('b64_json')
            if not b64:
                return False, 'no b64_json in response'
            png = base64.b64decode(b64)
            adir = os.path.join(OUT, action['id'])
            os.makedirs(adir, exist_ok=True)
            path = os.path.join(adir, f'pose-{idx + 1}.png')
            tmp = path + '.part'
            open(tmp, 'wb').write(png)
            os.replace(tmp, path)
            return True, path
        except Exception as exc:  # noqa: BLE001
            err = f'{type(exc).__name__}: {exc}'
            if attempt < meta['api']['retries']:
                # 429 限流用长退避：20s 起步，逐次 +15s
                wait = 20 + attempt * 15 if '429' in err else 3 + attempt * 4
                time.sleep(wait)
    return False, err


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--actions', default='all', help='逗号分隔的动作 id，all=全部')
    ap.add_argument('--concurrency', type=int, default=None)
    args = ap.parse_args()

    meta, actions = load_cfg()
    if args.actions != 'all':
        want = set(args.actions.split(','))
        actions = [a for a in actions if a['id'] in want]
    conc = args.concurrency or meta['api']['concurrency']

    jobs = []
    for a in actions:
        for i, pose in enumerate(a['poses']):
            path = os.path.join(OUT, a['id'], f'pose-{i + 1}.png')
            if os.path.exists(path) and os.path.getsize(path) > 10000:
                continue  # 已生成的跳过（防重复消耗 API）
            jobs.append((a, i, pose))

    print(f'待生成关键帧: {len(jobs)} (并发 {conc})', flush=True)
    results = {}
    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=conc) as pool:
        futs = {pool.submit(gen_keyframe, meta, a, i, pose): (a['id'], i) for a, i, pose in jobs}
        done = 0
        for fut in cf.as_completed(futs):
            aid, i = futs[fut]
            ok, info = fut.result()
            results[f'{aid}#{i + 1}'] = {'ok': ok, 'info': str(info)[:200]}
            done += 1
            print(f'[{done}/{len(jobs)}] {aid}#{i + 1} {"OK" if ok else "FAIL " + str(info)[:80]}', flush=True)

    # 元数据落盘
    os.makedirs(META, exist_ok=True)
    summary = {
        'startedAt': t0, 'finishedAt': time.time(),
        'durationSec': round(time.time() - t0, 1),
        'jobs': len(jobs),
        'failed': {k: v for k, v in results.items() if not v['ok']},
        'ok': sum(1 for v in results.values() if v['ok']),
    }
    for a in actions:
        json.dump({'action': a['id'], 'poses': a['poses']},
                  open(os.path.join(META, a['id'] + '.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
    json.dump(summary, open(os.path.join(META, '_generate-last.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    fails = summary['failed']
    print(f'完成: {summary["ok"]}/{summary["jobs"]}  失败 {len(fails)}  耗时 {summary["durationSec"]}s', flush=True)
    if fails:
        print('失败项:', json.dumps(fails, ensure_ascii=False)[:800], flush=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
