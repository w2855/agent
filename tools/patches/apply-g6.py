# -*- coding: utf-8 -*-
"""G6 批次程序化补丁脚本（预写版：G5 落地后一键执行）。

背景：
    renderer/app.js 正由另一代理编辑，本任务不直接改源码，而是把 G6 的四个功能
    预写成精确字符串补丁；等 G5 变更合入后运行本脚本一次性落地。

用法：
    python -X utf8 tools/patches/apply-g6.py            # 实际应用补丁
    python -X utf8 tools/patches/apply-g6.py --dry-run  # 只预览锚点命中/未命中，不写盘

设计：
    每个补丁 = { id, file, mode, anchor/old, new }：
      - mode='replace'       ：old（唯一）→ new
      - mode='insert-before' ：在 anchor（唯一）之前插入 new
      - mode='insert-after'  ：在 anchor（唯一）之后插入 new
      - mode='verify'        ：只校验 anchor 存在（依赖检查/复用确认），不改内容
    - 锚点优先选函数签名行等最稳定文本；anchor 允许给多个候选（依次尝试，取唯一命中者）。
    - 锚点找不到 / 命中多处 → 该补丁跳过并在报告里写明原因，不盲目打补丁
      （防止 G5 改动导致锚点失效时把代码插到错误位置）。
    - 每个补丁独立 try/except；结束后报告「应用 N / 跳过 M（原因）」。
    - 对 app.js 的组合结果会先用 `node --check` 做语法校验，校验失败则整体回滚不写盘。

四个功能对应关系：
    补丁 1（P1-a/P1-b/P1-c）：会话右键菜单（复制会话 ID / 重命名 / 删除）
        - 会话行 HTML 已有 data-id → 按指令直接复用，同时补 data-sid 双保险 + hover title 提示
        - bind() 区追加 contextmenu 委托；菜单 DOM 动态构建（单例 #sessionCtxMenu），
          样式复用既有 .menu/.menu-item，定位照 openMenu 的视口钳制逻辑手工计算
    补丁 2（P2）：send() 入口自动识别会话 ID（复用 T1 的 handleLoadSession；不注册菜单，/load 仍可用）
    补丁 3（P3-a/P3-b1/P3-b2/P3-c）：架构 per-session
        - project_architecture 工具 args 注入 sessionId（R3 runtime 已支持按 workspace+sessionId 隔离）
        - refreshArchitecture 数据获取按「会话专属优先、共享兜底」过滤 listProjects 结果
        - /load 在占位消息 body 追加架构提示
    补丁 4（P4）：CSS 零新增（复用 .menu）；右键 hover 提示用 title 属性（随 P1-a 落地），本条仅校验 .menu 存在

注意：
    - index.html 无需改动（菜单 DOM 动态创建）。
    - 运行前请确保工作区干净（脚本不处理半应用状态；重跑前先 git checkout 恢复）。
"""

import subprocess
import sys
import tempfile
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # tools/patches/apply-g6.py → 仓库根

# ────────────────────────── 补丁内容（JS 片段全部内联给出） ──────────────────────────

# [G6-P1-b] 右键菜单构建函数（插入到 renderSessions 定义之前，顶层作用域）
P1B_MENU_FN = """\
/* [G6-P1] 会话右键菜单：菜单 DOM 动态构建（单例 #sessionCtxMenu），样式复用既有 .menu/.menu-item；
   定位照 openMenu 的视口钳制逻辑手工计算。菜单项：复制会话 ID / 重命名（简化为 toast 提示走设置页）/
   删除（复用 deleteSession 的两段确认逻辑）。 */
function openSessionContextMenu(x, y, sid) {
  const s = state.sessions.find((n) => n.id === sid);
  if (!s || !sid) return;
  let menu = document.getElementById('sessionCtxMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'sessionCtxMenu';
    menu.className = 'menu';
    menu.hidden = true;
    document.body.appendChild(menu);
    // 菜单项事件委托：元素只创建一次，之后每次仅重绘内容
    menu.addEventListener('click', (ev) => {
      const item = ev.target.closest('.menu-item');
      if (!item) return;
      ev.stopPropagation();
      const target = item.dataset.sid || '';
      if (item.dataset.act === 'copy') {
        navigator.clipboard?.writeText(target).then(() => {
          const small = item.querySelector('small');
          if (small) small.textContent = '已复制 ✓'; // 打勾反馈
          toast('会话 ID 已复制');
          setTimeout(() => { menu.hidden = true; }, 900);
        }).catch(() => toast('复制失败：剪贴板不可用'));
      } else if (item.dataset.act === 'rename') {
        menu.hidden = true;
        // 简化版：不弹 inline 编辑框，toast 提示去设置页改（避免再引入一套编辑 UI）
        toast('重命名请到设置中修改该会话标题');
      } else if (item.dataset.act === 'del') {
        menu.hidden = true;
        deleteSession(target); // 复用两段确认（armed）；运行中的会话会被 deleteSession 拒绝
      }
    });
  }
  menu.innerHTML = `
    <div class="menu-title">${esc(s.title || '会话')}</div>
    <button class="menu-item" data-act="copy" data-sid="${esc(sid)}">复制会话 ID<small>${esc(sid)}</small></button>
    <button class="menu-item" data-act="rename" data-sid="${esc(sid)}">重命名<small>前往设置</small></button>
    <button class="menu-item" data-act="del" data-sid="${esc(sid)}">删除会话</button>`;
  menu.classList.remove('is-closing'); // 可能正播出场动画，取消它
  menu.hidden = false;
  // 手工定位：右键点在屏幕边缘时把菜单钳回视口内（与 openMenu 同一套边界规则）
  const w = menu.offsetWidth || 210;
  const h = menu.offsetHeight;
  const left = Math.max(10, Math.min(x, window.innerWidth - w - 10));
  const top = (y + 6 + h <= window.innerHeight - 10) ? y + 6 : Math.max(10, y - h - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

"""

# [G6-P1-c] bind() 区的 contextmenu 容器委托（插入到「代码块复制」注释之前）
P1C_LISTENER = """\
  /* [G6-P1] 会话右键菜单：容器级事件委托（renderSessions 每次重建 DOM，监听挂容器上只需挂一次）。
     会话行已有 data-id（G6 补丁又补了 data-sid 双保险），两者任取其一作为会话 ID。 */
  $('#sessions').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.session');
    if (!row) return;
    if (typeof openSessionContextMenu !== 'function') return; // P1-b 未落地时静默降级，不报错
    e.preventDefault();
    openSessionContextMenu(e.clientX, e.clientY, row.dataset.sid || row.dataset.id || '');
  });

"""

# [G6-P2] send() 入口的会话 ID 自动识别（插入到 function send() { 之后、
# 不依赖局部变量 input/text，用自带查询，锚点只需函数签名行）
P2_SNIPPET = """
  /* [G6-P2] 发送自动识别会话 ID：输入恰好是一个已存在的会话 ID（形如 m-/p-时间戳-随机码）时，
     直接载入该会话上下文（复用 T1 的 handleLoadSession；/load 命令保持可用），不再当作普通消息发送。 */
  {
    const g6raw = ($('#input')?.value || '').trim();
    if (/^(m|p)-\\d{10,}-[a-z0-9]{4,}$/.test(g6raw) && state.sessions.some((n) => n.id === g6raw)) {
      handleLoadSession(g6raw);
      const g6input = $('#input');
      if (g6input) { g6input.value = ''; autoGrow(); updateSendState(); }
      hideMenus();
      return;
    }
  }

"""

# [G6-P3-a] project_architecture 工具 args 注入 sessionId
#（插入到 runToolCall 内 if (parseError) { 之前：args 已解析完成、尚未构造 tool 对象，
#  此后 runtime propose 与本地 tools.exec 两条路径用的都是同一个 args）
P3A_SNIPPET = """\
    /* [G6-P3] project_architecture 按会话归档：args 注入 sessionId
       （R3 runtime 已支持按 workspace+sessionId 隔离架构）。本回合所属会话优先
       （s 是本回合的会话，后台并行时不误挂到正在浏览的会话），取不到再退回活跃会话。 */
    if (name === 'project_architecture' && args && typeof args === 'object' && !Array.isArray(args) && !args.sessionId) {
      const g6sid = (typeof s !== 'undefined' && s && s.id) ? s.id : ((active() && active().id) || '');
      if (g6sid) args.sessionId = g6sid;
    }

"""

# [G6-P3-b1] refreshArchitecture 里 loadProject 之后追加会话过滤
P3B1_SNIPPET = """
  await applyArchSessionFilter(); // [G6-P3] 会话专属优先、共享兜底（实现见 applyArchSessionFilter）

"""

# [G6-P3-b2] 会话过滤函数定义（插入到 refreshArchitecture 定义之前）
P3B2_FN = """\
/* [G6-P3] 架构页会话过滤：listProjects 结果里优先展示 sessionId === 当前活跃会话的项目；
   没有会话专属项目时回退到共享项目（!sessionId，兼容老数据）。
   注意 runtime 的 list/get 都返回 { project, live } 包装（与 ensure 一致），sessionId 在 project 里。 */
async function applyArchSessionFilter() {
  try {
    const api = window.dsh?.runtime?.projects;
    if (!api?.list || !state.projectOpen) return;
    const r = await api.list();
    const rows = (r?.ok && Array.isArray(r.data?.projects)) ? r.data.projects : [];
    if (!rows.length) return;
    const aid = (active() && active().id) || '';
    const sidOf = (p) => (p?.project?.sessionId ?? p?.sessionId) || '';
    const mine = rows.find((p) => aid && sidOf(p) === aid);
    const shared = rows.find((p) => !sidOf(p));
    const pick = mine || shared;
    if (pick && pick.project && state.project?.project?.id !== pick.project.id) {
      state.project = pick;
      state.projectWorkspace = state.workspace;
    }
  } catch { /* list 不可用时保持 loadProject（ensure）的结果，等价于共享兜底 */ }
}

"""

# [G6-P3-c] /load 占位消息追加架构提示（插入到 handleLoadSession 末尾 toast 之后；
# list 是异步，不阻塞 /load 主流程，就绪后补写正文并重绘）
P3C_SNIPPET = """

  /* [G6-P3] /load 附带架构提示：目标会话在 Runtime 里有专属项目架构时，
     在占位消息 body 追加提示（此处异步执行，不阻塞 /load 主体）。 */
  (async () => {
    try {
      const api = window.dsh?.runtime?.projects;
      if (!api?.list) return;
      const r = await api.list();
      const rows = (r?.ok && Array.isArray(r.data?.projects)) ? r.data.projects : [];
      const arch = rows.find((p) => (p?.project?.sessionId ?? p?.sessionId) === target.id);
      if (!arch) return;
      const nodeCount = (arch.live?.stats?.nodes
        ?? (Array.isArray(arch.live?.nodes) ? arch.live.nodes.length : 0)) || 0;
      loadedMsg.body += `\\n\\n🏗️ 该会话包含项目架构（${nodeCount} 节点），切到架构页查看`;
      renderChat(); // 占位消息已在时间线上，补写正文后重绘即可
    } catch { /* 架构查询失败不影响 /load 主体 */ }
  })();"""

# ────────────────────────── 补丁清单 ──────────────────────────

PATCHES = [
    {
        'id': 'P1-a',
        'title': '补丁1·会话行 data-sid 双保险 + hover 右键提示 title',
        'file': 'renderer/app.js',
        'mode': 'replace',
        # data-id 已存在 → 按指令「复用」；补 data-sid 只是双保险，失败不阻塞（optional）
        'old': '<div class="session ${s.id === state.activeId ? \'is-active\' : \'\'}" data-id="${esc(s.id)}">',
        'new': '<div class="session ${s.id === state.activeId ? \'is-active\' : \'\'}" data-id="${esc(s.id)}" data-sid="${esc(s.id)}" title="右键：复制会话 ID · 重命名 · 删除">',
        'optional': True,
    },
    {
        'id': 'P1-b',
        'title': '补丁1·右键菜单构建函数 openSessionContextMenu',
        'file': 'renderer/app.js',
        'mode': 'insert-before',
        # 锚点宽容：函数签名行是最稳定文本
        'anchor': ['function renderSessions() {'],
        'new': P1B_MENU_FN,
    },
    {
        'id': 'P1-c',
        'title': '补丁1·bind() 区 contextmenu 容器委托',
        'file': 'renderer/app.js',
        'mode': 'insert-before',
        'anchor': [
            '  // 代码块复制：悬停时注入角落按钮（流式重绘会冲掉按钮，悬停即补）',
            "  $('#jumpBottom')?.addEventListener('click', () => scrollToBottom(true));",
        ],
        'new': P1C_LISTENER,
    },
    {
        'id': 'P2',
        'title': '补丁2·send() 入口自动识别会话 ID',
        'file': 'renderer/app.js',
        'mode': 'insert-after',
        # 锚点宽容：只要函数签名行还在就打得上；注入代码自带输入查询，不依赖函数体内部变量
        'anchor': ['function send() {'],
        'new': P2_SNIPPET,
    },
    {
        'id': 'P3-a',
        'title': '补丁3·project_architecture args 注入 sessionId',
        'file': 'renderer/app.js',
        'mode': 'insert-before',
        'anchor': ['    if (parseError) {'],
        'new': P3A_SNIPPET,
    },
    {
        'id': 'P3-b1',
        'title': '补丁3·refreshArchitecture 追加会话过滤调用',
        'file': 'renderer/app.js',
        'mode': 'insert-after',
        'anchor': ['  await loadProject(force);'],
        'new': P3B1_SNIPPET,
    },
    {
        'id': 'P3-b2',
        'title': '补丁3·applyArchSessionFilter 过滤函数定义',
        'file': 'renderer/app.js',
        'mode': 'insert-before',
        'anchor': ['async function refreshArchitecture(force = true) {'],
        'new': P3B2_FN,
    },
    {
        'id': 'P3-c',
        'title': '补丁3·/load 占位消息追加架构提示',
        'file': 'renderer/app.js',
        'mode': 'insert-after',
        'anchor': ["  toast(`已载入「${target.title || '未命名'}」的上下文（${msgs.length} 条消息）`);"],
        'new': P3C_SNIPPET,
    },
    {
        'id': 'P4',
        'title': '补丁4·CSS 零新增（复用 .menu）+ 依赖校验',
        'file': 'renderer/styles.css',
        'mode': 'verify',
        'anchor': ['.menu {'],
    },
    {
        'id': 'DEP-1',
        'title': '依赖校验·handleLoadSession（T1）已实现',
        'file': 'renderer/app.js',
        'mode': 'verify',
        'anchor': ['function handleLoadSession(idArg) {'],
    },
]


# ────────────────────────── 引擎 ──────────────────────────

class PatchSkip(Exception):
    """单个补丁跳过（锚点未命中/命中多处/可选依赖缺失等）。"""


def _pick_anchor(content: str, candidates):
    """在候选锚点里找「全文唯一命中」的那个；返回 (anchor, reason)。
    所有候选都未命中或命中多处 → 抛 PatchSkip（原因写入报告）。"""
    miss, multi = [], []
    for cand in candidates:
        n = content.count(cand)
        if n == 1:
            return cand, ''
        if n > 1:
            multi.append(f'{cand[:40]}…(x{n})' if len(cand) > 40 else f'{cand}(x{n})')
        else:
            miss.append(cand[:40])
    if multi:
        raise PatchSkip(f'锚点命中多处，拒绝盲打：{multi}')
    raise PatchSkip(f'锚点未命中（G5 可能已改动周边代码）：{miss}')


def _match_eol(content: str, text: str) -> str:
    """文件是 CRLF 时把插入片段的 \\n 统一成 \\r\\n，避免行尾混用。"""
    crlf = content.count('\r\n')
    lf = content.count('\n') - crlf
    if crlf > lf and '\r\n' not in text:
        return text.replace('\n', '\r\n')
    return text


def apply_patch(content: str, patch: dict):
    """对单个文件内容应用一个补丁，返回新内容。失败抛 PatchSkip。"""
    mode = patch['mode']
    if mode == 'verify':
        # 校验模式只做「存在性」检查：命中 ≥1 处即通过（不要求唯一，也不修改内容）
        cands = patch['anchor'] if isinstance(patch['anchor'], list) else [patch['anchor']]
        hits = sum(content.count(c) for c in cands)
        if hits == 0:
            raise PatchSkip('校验目标未命中：依赖的样式/函数不存在')
        patch['_hits'] = hits  # 报告里展示命中处数
        return content
    if mode == 'replace':
        old = patch['old']
        n = content.count(old)
        if n == 0:
            raise PatchSkip('替换目标未命中（G5 可能已改动该行）')
        if n > 1:
            raise PatchSkip(f'替换目标命中 {n} 处，拒绝盲打')
        return content.replace(old, _match_eol(content, patch['new']), 1)
    # insert-before / insert-after
    anchor, _ = _pick_anchor(content, patch['anchor'] if isinstance(patch['anchor'], list) else [patch['anchor']])
    new = _match_eol(content, patch['new'])
    if mode == 'insert-before':
        return content.replace(anchor, new + anchor, 1)
    if mode == 'insert-after':
        return content.replace(anchor, anchor + new, 1)
    raise PatchSkip(f'未知补丁模式：{mode}')


def node_syntax_check(js_text: str) -> str:
    """用 node --check 校验组合后的 app.js 语法。返回 'ok' / 'fail:…' / 'unavailable'。"""
    node = shutil.which('node')
    if not node:
        return 'unavailable'
    tmp = Path(tempfile.gettempdir()) / 'g6-patch-syntax-check.js'
    try:
        tmp.write_text(js_text, encoding='utf-8')
        proc = subprocess.run([node, '--check', str(tmp)], capture_output=True, text=True, timeout=60)
        if proc.returncode == 0:
            return 'ok'
        return 'fail: ' + (proc.stderr or proc.stdout or '').strip()[:400]
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def main(argv) -> int:
    dry = '--dry-run' in argv
    print(f'== G6 批次补丁 {"（DRY-RUN 预览，不写盘）" if dry else "（实际应用）"} ==')
    print(f'仓库根：{ROOT}\n')

    # 按文件分组应用；每个补丁独立 try/except，失败列出但继续其余补丁
    contents = {}
    touched = []
    results = []  # (id, title, status, detail)
    for patch in PATCHES:
        rel = patch['file']
        try:
            if rel not in contents:
                path = ROOT / rel
                if not path.exists():
                    raise PatchSkip(f'文件不存在：{rel}')
                contents[rel] = path.read_bytes().decode('utf-8')
            before = contents[rel]
            after = apply_patch(before, patch)
            if after != before:
                contents[rel] = after
                if rel not in touched:
                    touched.append(rel)
            results.append((patch['id'], patch['title'],
                            'applied' if after != before else 'verify-ok',
                            '' if after != before else f"命中 {patch.get('_hits', 1)} 处（存在性校验）"))
        except PatchSkip as e:
            reason = f'（可选补丁，可安全忽略）{e}' if patch.get('optional') else str(e)
            results.append((patch['id'], patch['title'], 'skipped', reason))
        except Exception as e:  # noqa: BLE001 单补丁异常不拖垮其余补丁
            results.append((patch['id'], patch['title'], 'error', f'{type(e).__name__}: {e}'))

    # 组合后的 app.js 先过 node --check；失败则回滚 app.js 全部改动，不写半成品
    check = 'skipped(no js change)'
    if 'renderer/app.js' in contents:
        check = node_syntax_check(contents['renderer/app.js'])
        if check.startswith('fail'):
            results.append(('SYNTAX', 'node --check 组合结果', 'error',
                            f'{check} → 已回滚 app.js 全部改动，未写盘'))
            contents.pop('renderer/app.js')
            touched = [t for t in touched if t != 'renderer/app.js']

    # 写盘（dry-run 跳过）
    written = []
    if not dry:
        for rel in touched:
            (ROOT / rel).write_bytes(contents[rel].encode('utf-8'))
            written.append(rel)

    # 报告
    for pid, title, status, detail in results:
        mark = {'applied': '✓ 应用', 'verify-ok': '✓ 校验通过', 'skipped': '○ 跳过', 'error': '✗ 失败'}[status]
        line = f'[{pid}] {mark}  {title}'
        if detail:
            line += f'\n        └ 原因：{detail}'
        print(line)
    ok = sum(1 for r in results if r[2] in ('applied', 'verify-ok'))
    skip = sum(1 for r in results if r[2] in ('skipped', 'error'))
    print(f'\n语法校验（node --check）：{check}')
    print(f'写盘文件：{", ".join(written) if written else "（无）"}')
    print(f'== 结束：应用/通过 {ok} / 跳过或失败 {skip} ==')
    if dry:
        print('（--dry-run：以上为预览，未修改任何文件）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
