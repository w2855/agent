#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""apply-anim.py · Emil 动效重做包一键应用脚本
================================================
用法：
  python apply-anim.py --dry-run          # 只校验锚点命中现状 + 冲突/语法自检，不写盘
  python apply-anim.py                    # 应用 CSS 全量重做 + JS 编排补丁
  python apply-anim.py --skip-js          # 只应用 CSS（G5 未落地时用这个更稳）
  python apply-anim.py --skip-css         # 只应用 JS 编排补丁
  python apply-anim.py --restore <备份目录>  # 回滚（备份在 tools/patches/backup/<ts>/）

做三件事：
  ① 整段删除 styles.css 中所有旧动画段（@keyframes / animation 规则 /
     reduced-motion 块 / 旧 Motion Tokens 段），锚点均为注释头或独立块；
  ② 与 G5（会话级并行）可能重叠的区（.session / .running-pill /
     #runningMenu / .msg.is-enter / .chat+composer 过渡）用逐行锚点补丁处理，
     绝不整段替换结构；
  ③ 追加 motion-system.css（新动效体系唯一事实源）到文件末尾（壁纸覆写之后，
     依赖 CSS 顺序规则：同名选择器后来居上）；
  ④ 应用 js-orchestration-patches.py（Enter/Exit 配对 / 打断处理 /
     origin-aware openMenu），随后 node --check renderer/app.js；
  ⑤ 自检：CSS 括号配平、@keyframes 重名检查、animation 引用解析
     （所有 animation: 引用的名字必须有对应 @keyframes 定义）。

所有删除/替换均要求锚点精确命中；dry-run 报告每个操作的命中现状，miss 不落盘。
"""

import argparse
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent          # tools/patches
ROOT = HERE.parents[1]                          # dsh-desktop
CSS_PATH = ROOT / "renderer" / "styles.css"
JS_PATH = ROOT / "renderer" / "app.js"
MOTION_PATH = HERE / "motion-system.css"
BACKUP_DIR = HERE / "backup"

sys.path.insert(0, str(HERE))


# ─────────────────────────── 基础工具 ───────────────────────────

def brace_end(text: str, open_idx: int) -> int:
    """从 '{' 下标做括号配平，返回配平 '}' 的下标（含）。"""
    depth = 0
    for i in range(open_idx, len(text)):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
    raise ValueError("括号不配平：找不到闭合 '}'")


def find_marker(text: str, marker: str, label: str) -> int:
    idx = text.find(marker)
    if idx < 0:
        raise LookupError(f"锚点未命中: {label}")
    return idx


def remove_range(text: str, start: int, end: int) -> str:
    return text[:start] + text[end:]


def remove_media_reduce_blocks(text: str):
    """删除所有 prefers-reduced-motion 块（括号配平，支持任意嵌套）。返回 (新文本, 删除数)。"""
    marker = "@media (prefers-reduced-motion: reduce)"
    count = 0
    while True:
        idx = text.find(marker)
        if idx < 0:
            break
        open_idx = text.find("{", idx)
        close_idx = brace_end(text, open_idx)
        # 顺带吃掉块后的换行
        end = close_idx + 1
        while end < len(text) and text[end] in "\r\n":
            end += 1
        # 吃掉块前的缩进/换行
        start = idx
        while start > 0 and text[start - 1] in " \t":
            start -= 1
        text = remove_range(text, start, end)
        count += 1
    return text, count


def remove_keyframes(text: str, name: str):
    """按名删除一个 @keyframes 块。返回 (新文本, 是否命中)。"""
    m = re.search(r"@keyframes\s+" + re.escape(name) + r"\s*\{", text)
    if not m:
        return text, False
    open_idx = m.end() - 1
    close_idx = brace_end(text, open_idx)
    end = close_idx + 1
    while end < len(text) and text[end] in "\r\n":
        end += 1
    return remove_range(text, m.start(), end), True


def replace_once(text: str, old: str, new: str, label: str, expect: int = 1):
    """精确子串替换；命中数必须等于 expect，否则抛错（dry-run 不会走到写盘）。"""
    n = text.count(old)
    if n != expect:
        raise LookupError(f"锚点命中 {n} 次（期望 {expect}）: {label}")
    return text.replace(old, new)


def delete_line(text: str, line_body: str, label: str):
    """删除一整行（含行首缩进与换行），line_body 不含缩进。"""
    return replace_once(text, "\n  " + line_body, "", label)


# ───────────────────── CSS 操作清单 ─────────────────────

# 整段删除：start 锚点（含）→ end 锚点（不含）。全部为注释头或独立块，不触结构。
BLOCK_DELETES = [
    ("D1-全局动效层+keyframes", "/* ───────── 全局动效层（入场 · 悬停 · 状态） ───────── */",
     "/* ───────── 子代理与列表入场（2026-11 增补） ─────────"),
    ("D2-子代理列表入场增补", "/* ───────── 子代理与列表入场（2026-11 增补） ─────────",
     "/* 个性化提示词指示 */"),
    ("D3-基础keyframes块(rise/pop等)", "/* ───────── 动画 ───────── */",
     "@media (max-width: 980px) {"),
    ("D5-架构图keyframes", "@keyframes archPulse {", ".arch-legend {"),
    ("D6-全局开合退场段", "/* ───────── 全局开合动效：所有浮层/面板/页面关闭都有出场动画（open 已有入场） ───────── */",
     "/* 思考指示：首 token 前的三点波浪，给「正在想」的心理反馈 */"),
    ("D9-附件/模型stagger旧链", "/* 附件 chips 逐个入场 */",
     "/* 会话行 hover 位移反馈（幅度 1px，克制） */"),
    ("D10-会话行hover位移", "/* 会话行 hover 位移反馈（幅度 1px，克制） */",
     "/* ───────── 动效差异化"),
    ("D7-动效差异化段(todo/stamp/slide)", "/* ───────── 动效差异化：每个面有自己的动势，不搞一刀切 ─────────",
     "/* ───────── 设置页：ZCode 式左导航 + 右内容（全屏覆盖页，.arch-page 同范式） ─────────"),
    ("D8-设置页动效段", "/* ── 设置页动效：与弹窗/架构页/检查器都不同轴 ── */",
     "/* 设置页关闭按钮：从裸 × 升级为明确的描边按钮，一眼可见可点 */"),
    ("D11-旧MotionTokens段", "/* ═════════ Motion Tokens（Emil 体系：曲线按用途分层，进场弹簧/退场收束/微交互利落）═════════",
     None),  # None = 到文件末尾
]

# 独立 @keyframes 按名删除（其余旧 keyframes 都在上述整段里）
KEYFRAMES_DELETES = [
    "rp-breathe", "inspPulse", "archBadgeBreathe", "todoPop", "todoEditGlow",
    "retryPulse", "toolPulse", "findIn", "findOut", "selMenuIn",
    "mcpPulse", "doctorIn", "doctorPulse",
]

# 逐行锚点补丁（G5 重叠区 / 散点规则）——只动动画相关声明，不动结构
LINE_EDITS = [
    # G5 重叠区：.app / .sidebar 收展曲线统一（布局重排类正当例外，保留过渡本身）
    ("E1-侧栏grid过渡曲线",
     "transition: grid-template-columns 260ms cubic-bezier(.3, .8, .3, 1);",
     "transition: grid-template-columns 260ms var(--ease-inout-strong); /* 布局重排类正当例外（侧栏收展） */", 1),
    ("E2-侧栏透明度/位移过渡",
     "transition: opacity 180ms ease, transform 260ms cubic-bezier(.3, .8, .3, 1);",
     "transition: opacity var(--dur-fast) ease, transform 260ms var(--ease-inout-strong);", 1),
    # G5 重叠区：运行轻提示呼吸点（只改动画引用，结构不动）
    ("E3-运行pill/runningMenu呼吸点→softPulse",
     "animation: rp-breathe 2.6s ease-in-out infinite;",
     "animation: softPulse 2.6s ease-in-out infinite;", 2),
    ("E4-会话s-spin补easing",
     "animation: pulse 1.7s infinite;",
     "animation: pulse 1.7s ease-in-out infinite;", 1),
    # 基础 .tool/.tool-detail/.retry/.approval/.queue 的 base 入场删除：
    # innerHTML 重建（切会话）会整批重放造成闪烁；入场由 is-enter/容器承载
    ("E5-.tool基础rise删除", "\n  animation: rise 220ms cubic-bezier(.2,.8,.3,1);", "", 1),
    ("E6-.tool-detail基础rise删除", "\n  animation: rise 160ms ease;", "", 1),
    ("E7-.retry基础rise删除", "\n  animation: rise 180ms ease;", "", 1),
    ("E8-.approval基础rise删除", "\n  animation: rise 240ms cubic-bezier(.2,.8,.3,1);", "", 1),
    ("E9-.queue基础rise删除", "\n  animation: rise 200ms ease;", "", 1),
    # scrim：170ms 与 app.js animateOut(scrim, 170) 对齐
    ("E10-scrim fade对齐JS",
     "z-index: 50;\n  animation: fade 160ms ease;",
     "z-index: 50;\n  animation: fade 170ms ease both;", 1),
    ("E11-.menu旧menuIn删除(新体系接管)", "\n  animation: menuIn 130ms cubic-bezier(.2,.9,.3,1);", "", 1),
    ("E12-.sheet死规则pop删除", "\n  animation: pop 180ms cubic-bezier(.2,.9,.3,1);", "", 1),
    # toast：transition 可打断（Sonner 模式），keyframes 版本已废
    ("E13-toast过渡补全",
     "transition: opacity 180ms, transform 180ms;",
     "transition: opacity 180ms ease, transform 200ms var(--ease-out-strong);", 1),
    ("E14-架构页fade删除(新体系接管)",
     "background: linear-gradient(180deg, var(--page-top) 0%, var(--page-bottom) 100%);\n  animation: fade 160ms ease;\n}",
     "background: linear-gradient(180deg, var(--page-top) 0%, var(--page-bottom) 100%);\n}", 1),
    # SVG 架构图：hover 位移删除 + 曲线/时长收敛
    ("E15-SVG节点hover过渡删除", "\n  transition: transform 200ms cubic-bezier(.2, .9, .3, 1.2);", "", 1),
    ("E16-SVG节点hover lift删除", "\n.arch-svg-node:hover { transform: translateY(-2px); }", "", 1),
    ("E17-archNodeIn曲线",
     "animation: archNodeIn 520ms cubic-bezier(.22, 1.18, .36, 1) both;",
     "animation: archNodeIn var(--dur-slow) var(--ease-out-strong) both;", 1),
    ("E18-hub主节点时长",
     ".arch-svg-hub.is-main .arch-hub-body { animation-duration: 640ms; }",
     ".arch-svg-hub.is-main .arch-hub-body { animation-duration: 300ms; }", 1),
    ("E19-arch-live-dot→softPulse",
     ".arch-live-dot { animation: archPulse 1.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }",
     ".arch-live-dot { animation: softPulse 1.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }", 1),
    ("E20-arch-live-halo→archAura",
     ".arch-live-halo { animation: archHaloPulse 1.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }",
     ".arch-live-halo { animation: archAura 1.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }", 1),
    ("E21-archFlash→stroke脉冲",
     ".arch-svg-node.is-flash .arch-node-card { animation: archFlash 1.25s ease; }",
     ".arch-svg-node.is-flash .arch-node-card { animation: archFlash 500ms var(--ease-out-strong); }", 1),
    ("E22-edgeFade时长",
     ".arch-edge.is-enter { animation: archEdgeFade 720ms ease both; }",
     ".arch-edge.is-enter { animation: archEdgeFade 400ms ease both; }", 1),
    ("E23-edgeDraw曲线时长",
     "animation: archEdgeDraw 900ms cubic-bezier(.4, 0, .2, 1) 120ms both;",
     "animation: archEdgeDraw 500ms var(--ease-out-strong) 80ms both;", 1),
    ("E24-dep边fade时长",
     ", archEdgeFade 800ms ease 200ms both;",
     ", archEdgeFade 400ms ease 120ms both;", 1),
    ("E25-archRing→softPulse",
     ".arch-node-ring { animation: archRing 2.4s ease-in-out infinite; }",
     ".arch-node-ring { animation: softPulse 2.4s ease-in-out infinite; }", 1),
    ("E26-arch-chip-live→haloPulse",
     "animation: dotPulse 1.8s ease-in-out infinite;",
     "animation: haloPulse 1.8s ease-in-out infinite;", 1),
    # 任务清单：hover 放大删除 + todoPop 去过冲
    ("E27-todo圆点hover放大删除", "\n.todo-dot-btn:hover .todo-dot { transform: scale(1.35); }", "", 1),
    ("E28-todoPop去弹簧",
     "animation: todoPop 320ms var(--ease-lively);",
     "animation: todoPop 260ms var(--ease-out-strong);", 1),
    # 呼吸文字统一 softPulse
    ("E29-retry原因→softPulse",
     ".retry b { animation: retryPulse 1.2s ease-in-out infinite; }",
     ".retry b { animation: softPulse 1.2s ease-in-out infinite; }", 1),
    ("E30-工具行呼吸→softPulse",
     ".tool.is-running .t-target { animation: toolPulse 1.2s ease-in-out infinite; }",
     ".tool.is-running .t-target { animation: softPulse 1.2s ease-in-out infinite; }", 1),
    # MCP 状态点 → haloPulse（颜色沿用 --mcp-dot-c）
    ("E31-mcp-dot→haloPulse",
     "animation: mcpPulse 2.4s ease-in-out infinite;",
     "animation: haloPulse 2.4s ease-in-out infinite;", 1),
    ("E31b-mcp-dot-starting→haloPulse",
     "animation: mcpPulse 1.1s ease-in-out infinite;",
     "animation: haloPulse 1.1s ease-in-out infinite;", 1),
    # 检查器实时点 / 架构页实时徽标：统一新循环体系
    ("E35-insp实时点→softPulse",
     "animation: inspPulse 1.4s ease-in-out infinite;",
     "animation: softPulse 1.4s ease-in-out infinite;", 1),
    ("E36-arch实时徽标→haloPulse",
     "animation: archBadgeBreathe 1.8s ease-in-out infinite;",
     "animation: haloPulse 1.8s ease-in-out infinite;", 1),
    # hover 位移 lifts 源头清除（motion-system 已有 transform:none 覆盖，此处删源头避免歧义）
    ("E37-new-chat lift删除",
     ".new-chat:hover { transform: translateY(-1px); filter: brightness(1.06); }",
     ".new-chat:hover { filter: brightness(1.06); }", 1),
    ("E38-suggest lift删除",
     ".suggest:hover { background: var(--fill-hover); color: var(--text); transform: translateY(-1px); }",
     ".suggest:hover { background: var(--fill-hover); color: var(--text); }", 1),
    ("E39-send lift删除",
     ".send:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.06); }",
     ".send:hover:not(:disabled) { filter: brightness(1.06); }", 1),
    # stagger 封顶（旧长链收敛）
    ("E32-doctor行stagger封顶",
     """.doctor-item:nth-child(2) { animation-delay: 20ms; }
.doctor-item:nth-child(3) { animation-delay: 40ms; }
.doctor-item:nth-child(4) { animation-delay: 60ms; }
.doctor-item:nth-child(5) { animation-delay: 80ms; }
.doctor-item:nth-child(6) { animation-delay: 100ms; }
.doctor-item:nth-child(7) { animation-delay: 120ms; }
.doctor-item:nth-child(8) { animation-delay: 140ms; }
.doctor-item:nth-child(9) { animation-delay: 160ms; }
.doctor-item:nth-child(10) { animation-delay: 180ms; }""",
     """.doctor-item:nth-child(2) { animation-delay: 25ms; }
.doctor-item:nth-child(3) { animation-delay: 50ms; }
.doctor-item:nth-child(n+4) { animation-delay: 75ms; }""", 1),
    ("E33-mcp行stagger封顶",
     ".mcp-row:nth-child(n+4) { animation-delay: 120ms; }",
     ".mcp-row:nth-child(n+4) { animation-delay: 80ms; }", 1),
    ("E34-skill行stagger封顶",
     ".skill-row:nth-child(n+4) { animation-delay: 120ms; }",
     ".skill-row:nth-child(n+4) { animation-delay: 80ms; }", 1),
]

SEP = "\n\n/* ═════════ 以下为 Emil 动效重做包（motion-system.css，唯一动效事实源；由 apply-anim.py 追加） ═════════ */\n\n"


# ─────────────────────── CSS 应用流程 ───────────────────────

def apply_css(text: str, dry: bool, log):
    ops_ok, ops_fail = 0, []

    def try_op(label, fn):
        nonlocal text, ops_ok
        try:
            text, detail = fn(text)
            ops_ok += 1
            log(f"  [OK]   {label}{(' · ' + detail) if detail else ''}")
        except LookupError as e:
            ops_fail.append((label, str(e)))
            log(f"  [MISS] {label} · {e}")

    # ① reduced-motion 全部旧块（括号配平删除）
    def op_media(t):
        t2, n = remove_media_reduce_blocks(t)
        return t2, f"删除 {n} 个旧 reduced-motion 块"
    try_op("①旧 reduced-motion 块（括号配平删除）", op_media)

    # ② 整段删除
    for label, start, end in BLOCK_DELETES:
        def op_block(t, s=start, e=end, lb=label):
            i = find_marker(t, s, lb)
            if e is None:
                j = len(t)
            else:
                j = find_marker(t, e, lb + " → end")
            return remove_range(t, i, j), ""
        try_op(f"②整段删除 {label}", op_block)

    # ③ 独立 keyframes 按名删除
    for name in KEYFRAMES_DELETES:
        def op_kf(t, n=name):
            t2, hit = remove_keyframes(t, n)
            if not hit:
                raise LookupError(f"@keyframes {n} 未找到")
            return t2, ""
        try_op(f"③keyframes删除 {name}", op_kf)

    # ④ 逐行锚点补丁
    for label, old, new, expect in LINE_EDITS:
        try_op(f"④行补丁 {label}", lambda t, o=old, nw=new, ex=expect, lb=label: (replace_once(t, o, nw, lb, ex), ""))

    # ⑤ 追加 motion-system.css
    def op_append(t):
        motion = MOTION_PATH.read_text(encoding="utf-8")
        return t.rstrip() + SEP + motion, f"追加 {len(motion.splitlines())} 行"
    try_op("⑤追加 motion-system.css", op_append)

    return text, ops_ok, ops_fail


# ─────────────────────── CSS 自检 ───────────────────────

def split_top_level(value: str):
    """按逗号切分，但跳过括号内的逗号（cubic-bezier / var 的参数不切）。"""
    parts, depth, buf = [], 0, []
    for ch in value:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append("".join(buf))
    return parts


def check_css(text: str, log):
    problems = []
    ob, cb = text.count("{"), text.count("}")
    log(f"  括号配平: {{ ×{ob}  }} ×{cb}  {'✓' if ob == cb else '✗ 不配平!'}")
    if ob != cb:
        problems.append("CSS 括号不配平")

    defined = re.findall(r"@keyframes\s+([A-Za-z][\w-]*)", text)
    dups = sorted({n for n in defined if defined.count(n) > 1})
    log(f"  @keyframes 定义 {len(defined)} 个，重名: {dups if dups else '无 ✓'}")
    if dups:
        problems.append(f"keyframes 重名: {dups}")

    # animation 引用解析：shorthand 首个非时间/曲线/填充 token 必须有定义
    # （逗号切分为括号感知，cubic-bezier/var 参数不会被误拆）
    drop = re.compile(
        r"^(?:[+-]?[\d.]+m?s|infinite|both|forwards|backwards|alternate|reverse|normal|"
        r"ease(?:-in|-out|-in-out)?|linear|steps?\([^)]*\)|cubic-bezier\([^)]*\)|var\([^)]*\)|none)$"
    )
    refs = []
    for m in re.finditer(r"animation\s*:\s*([^;}]+)", text):
        val = m.group(1).strip().replace("!important", "").strip()
        for part in split_top_level(val):
            tokens = [t for t in part.split() if not drop.match(t)]
            if tokens:
                refs.append(tokens[0])
    for m in re.finditer(r"animation-name\s*:\s*([^;}]+)", text):
        refs.append(m.group(1).strip())
    missing = sorted({r for r in refs if r != "none" and r not in defined})
    log(f"  animation 引用 {len(refs)} 处，未解析: {missing if missing else '无 ✓'}")
    if missing:
        problems.append(f"animation 引用了未定义的 keyframes: {missing}")
    return problems


def keyframes_inventory(text: str):
    """旧 CSS 的 keyframes 名单（用于冲突比对报告）。"""
    return re.findall(r"@keyframes\s+([A-Za-z][\w-]*)", text)


# ─────────────────────── JS 应用流程 ───────────────────────

def apply_js(js_text: str, dry: bool, log):
    import js_orchestration_patches as jp
    ok, fail = 0, []
    for patch in jp.PATCHES:
        name = patch["name"]
        anchor, repl = patch["anchor"], patch["replacement"]
        n = js_text.count(anchor)
        if n == 0:
            fail.append((name, "锚点未命中（可能 G5 改动已使锚点漂移，请重审）"))
            log(f"  [MISS] {name} · 锚点未命中（G5 依赖区请先落地 G5）")
            continue
        if n > 1:
            fail.append((name, f"锚点命中 {n} 次，不唯一"))
            log(f"  [MISS] {name} · 锚点命中 {n} 次")
            continue
        if dry:
            log(f"  [HIT ] {name} · 锚点命中 1 次" + ("（G5 依赖区）" if patch.get("depends_g5") else ""))
        else:
            js_text = js_text.replace(anchor, repl)
            log(f"  [OK]   {name} · 已应用" + ("（G5 依赖区）" if patch.get("depends_g5") else ""))
        ok += 1
    return js_text, ok, fail


def node_check(path, log):
    """对指定 js 文件跑 node --check；返回是否通过。"""
    try:
        p = subprocess.run(["node", "--check", str(path)],
                           capture_output=True, text=True, timeout=60)
        if p.returncode == 0:
            log(f"  node --check {path.name} ✓ 语法通过")
            return True
        log(f"  node --check ✗\n{p.stderr}")
        return False
    except FileNotFoundError:
        log("  node 不在 PATH，跳过语法检查")
        return True


# ─────────────────────────── 主流程 ───────────────────────────

def read_text(path: Path):
    raw = path.read_bytes().decode("utf-8")
    crlf = "\r\n" in raw
    return raw.replace("\r\n", "\n"), crlf


def write_text(path: Path, text: str, crlf: bool):
    if crlf:
        text = text.replace("\n", "\r\n")
    path.write_bytes(text.encode("utf-8"))


def main():
    ap = argparse.ArgumentParser(description="Emil 动效重做包一键应用")
    ap.add_argument("--dry-run", action="store_true", help="只校验，不写盘")
    ap.add_argument("--skip-js", action="store_true", help="跳过 JS 编排补丁")
    ap.add_argument("--skip-css", action="store_true", help="跳过 CSS 重做")
    ap.add_argument("--restore", metavar="BACKUP_DIR", help="从备份目录回滚")
    args = ap.parse_args()
    dry = args.dry_run

    lines = []

    def log(msg=""):
        lines.append(msg)
        print(msg)

    # 回滚模式
    if args.restore:
        src = Path(args.restore)
        for name in ("styles.css", "app.js"):
            f = src / name
            if f.exists():
                shutil.copy2(f, ROOT / "renderer" / name)
                log(f"已回滚 renderer/{name} ← {f}")
            else:
                log(f"备份中不存在 {name}，跳过")
        return

    css, css_crlf = read_text(CSS_PATH)
    js, js_crlf = read_text(JS_PATH)
    old_kf = keyframes_inventory(css)

    log("=" * 64)
    log(f"Emil 动效重做包 · {'DRY-RUN 校验' if dry else '应用'} · 目标 {CSS_PATH}")
    log(f"旧 @keyframes 共 {len(old_kf)} 个")
    log("=" * 64)

    new_css, css_ok, css_fail = css, 0, []
    if not args.skip_css:
        log("\n── CSS 流程 ──")
        new_css, css_ok, css_fail = apply_css(css, dry, log)

    new_js = js
    js_ok, js_fail = 0, []
    if not args.skip_js:
        log("\n── JS 编排补丁流程 ──")
        new_js, js_ok, js_fail = apply_js(js, dry, log)

    # 自检（dry-run 也基于"假如应用后"的内容做）
    log("\n── 自检（按应用后内容） ──")
    problems = []
    if not args.skip_css:
        problems += check_css(new_css, log)
        new_kf = keyframes_inventory(new_css)
        kept = sorted(set(old_kf) & set(new_kf))
        removed = sorted(set(old_kf) - set(new_kf))
        added = sorted(set(new_kf) - set(old_kf))
        log(f"  keyframes 比对: 保留重定义 {len(kept)} · 删除 {len(removed)} · 新增 {len(added)}")
        log(f"    新增: {added}")
        log(f"    删除: {removed}")

    if not dry:
        if args.skip_js and js_fail:
            pass
        # 备份
        ts = time.strftime("%Y%m%d-%H%M%S")
        bak = BACKUP_DIR / ts
        bak.mkdir(parents=True, exist_ok=True)
        if not args.skip_css:
            shutil.copy2(CSS_PATH, bak / "styles.css")
        if not args.skip_js:
            shutil.copy2(JS_PATH, bak / "app.js")
        log(f"\n备份 → {bak}")

    # JS 语法预检（对补丁后的文本写临时文件校验，避免语法坏文件落盘）
    if not dry and js_ok and not args.skip_js:
        tmp = HERE / "_app-check.tmp.js"
        tmp.write_text(new_js, encoding="utf-8")
        log("\nJS 语法预检:")
        js_syntax_ok = node_check(tmp, log)
        tmp.unlink(missing_ok=True)
        if not js_syntax_ok:
            log("\n[中止] node --check 未通过，未写盘")
            sys.exit(1)

    # 落盘（任何 miss / 自检问题先中止）
    blocking = css_fail or js_fail or problems
    if not dry and blocking:
        log("\n[中止] 存在 miss 或自检问题，未写盘：")
        for name, err in (css_fail + js_fail):
            log(f"  - {name}: {err}")
        for p in problems:
            log(f"  - {p}")
        sys.exit(1)

    if not dry:
        wrote = False
        if not args.skip_css:
            write_text(CSS_PATH, new_css, css_crlf)
            wrote = True
            log(f"已写入 {CSS_PATH}")
        if not args.skip_js and js_ok:
            write_text(JS_PATH, new_js, js_crlf)
            wrote = True
            log(f"已写入 {JS_PATH}")

    # 汇总
    log("\n── 汇总 ──")
    log(f"CSS 操作 {css_ok} 通过 / {len(css_fail)} miss；JS 补丁 {js_ok} 通过 / {len(js_fail)} miss")
    if css_fail:
        log("CSS miss 明细:")
        for name, err in css_fail:
            log(f"  - {name}: {err}")
    if js_fail:
        log("JS miss 明细:")
        for name, err in js_fail:
            log(f"  - {name}: {err}")
    if problems:
        log("自检问题:")
        for p in problems:
            log(f"  - {p}")

    if dry:
        log("\n[DRY-RUN] 未写盘。确认锚点命中现状后执行: python apply-anim.py")
    elif css_fail or js_fail or problems:
        log("\n[中止] 存在 miss 或自检问题，未写入失败项；已写入项见上方日志，可用 --restore 回滚")
        sys.exit(1)
    else:
        log("\n[完成] 全部应用成功。回滚: python apply-anim.py --restore " + str(bak))


if __name__ == "__main__":
    main()
