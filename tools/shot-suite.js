#!/usr/bin/env node
/* shot-suite.js — 截图驱动验收系统 · 通用引擎（项目无关的视觉回归编排器，零 npm 依赖）。
   引擎只做四件事：跑截图 → 管基线 → 像素对比 → 出报告；不知道任何具体应用的存在。

   ══ 两种通用用法 ══
   ① Electron 应用（档案模式）：
        node tools/shot-suite.js --profile dsh [--update] [--threshold=0.5] [--no-open]
      档案 tools/shot-profiles/<name>.json 定义场景清单 / 探针脚本 / 前置命令（见 shot-profiles/README.md）。
   ② 任意网页（单页模式，不依赖任何探针脚本）：
        node tools/shot-suite.js --url http://127.0.0.1:3000 --name mysite [--update] [--wait=1500]
      electron 直接 loadURL 截图，适合对本地服务/已部署页面做纯视觉回归。

   ══ 模式 ══
   --update      把本轮截图写入 tools/shot-baselines/ 作为新基线（首跑必用）；
   默认（对比）  与基线逐场景像素对比：ratio > 阈值(默认 0.5%) → CHANGED，否则 SAME；基线缺失 → NEW。

   ══ 产物 ══
   shots-output/<id>.png（本轮截图）、<id>.diff.png（差异高亮）、gallery.html（网格报告，自动开浏览器）；
   退出码：对比模式出现 CHANGED/截图失败 → 1，否则 0（NEW 不算失败）。 */

'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

/* ── 路径约定：引擎的一切可移植资产都在自己的 tools/ 里，输出放项目根 ── */
const HERE = __dirname;                                // 引擎所在 tools/ 目录
const ROOT = path.dirname(HERE);                       // 项目根（shots-output / .shot-run 放这里）
const OUT_DIR = path.join(ROOT, 'shots-output');       // 本轮截图 / diff / gallery
const RUN_DIR = path.join(ROOT, '.shot-run');          // 每场景隔离 user-data-dir
const BASELINE_DIR = path.join(HERE, 'shot-baselines');
const PROFILE_DIR = path.join(HERE, 'shot-profiles');
const PIXDIFF = path.join(HERE, 'pixdiff.py');
const WEB_CAPTURE = path.join(HERE, 'shot-web-capture.js');
const TEMP_LAUNCHER = 'shot-run-current.js';           // 应用模式下临时探针中转文件名（放 <appPath>/tools/）
const DEFAULT_THRESHOLD = 0.5;                         // 判定阈值：像素差异率百分比

/* ═══════════════ 基础工具 ═══════════════ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCli(argv) {
  const get = (name) => {
    const eq = argv.find((a) => a.startsWith('--' + name + '='));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  const has = (name) => argv.includes('--' + name);
  return {
    update: has('update'),
    noOpen: has('no-open'),
    profile: get('profile'),
    url: get('url'),
    name: get('name'),
    threshold: get('threshold') != null ? Number(get('threshold')) : undefined,
    wait: get('wait') != null ? Number(get('wait')) : undefined,
    width: get('width') != null ? Number(get('width')) : undefined,
    height: get('height') != null ? Number(get('height')) : undefined,
  };
}

function resolvePath(p, base) {
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

/* CJK/全角按 2 列宽度对齐（汇总表用） */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) >= 0x2e80 ? 2 : 1;
  return w;
}
function pad(s, w) {
  s = String(s ?? '');
  return s + ' '.repeat(Math.max(0, w - displayWidth(s)));
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 被占用留给下次 */ } }

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 进程可能已退出 */ }
}

/** 跑一个子进程并限时；返回 {code, stdout, stderr, timedOut} */
function run(cmd, args, { timeoutMs = 90000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: process.env });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

/** 探测 127.0.0.1:port 是否可连（mock 网关等前置服务的就绪判断） */
function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

/** 清扫本套件遗留的僵尸 electron：套件进程被杀时其在飞的截图实例不会跟着死，
    它们会在任意时刻写出 shot.png 污染后续场景的搬运窗口——按 .shot-run 命令行标记精准收割。 */
function killStaleShotRunners(where) {
  try {
    if (process.platform === 'win32') {
      spawnSync('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*.shot-run*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, timeout: 20000 });
    } else {
      spawnSync('pkill', ['-f', '.shot-run'], { timeout: 10000 });
    }
  } catch { /* 清扫失败不阻塞主流程 */ }
}

/** 解析 electron 可执行文件路径：优先被测应用自己的 node_modules，其次引擎所在项目 */
function resolveElectron(appPath) {
  const cands = [];
  if (appPath) cands.push(path.join(appPath, 'node_modules', 'electron'));
  cands.push(path.join(ROOT, 'node_modules', 'electron'));
  for (const c of cands) {
    try {
      const p = require(c); // electron 包 index.js 导出可执行文件绝对路径
      if (typeof p === 'string' && fs.existsSync(p)) return p;
    } catch { /* 该目录无 electron，试下一个 */ }
  }
  return null;
}

/* ═══════════════ 计划加载（档案模式 / 网页模式） ═══════════════ */

function loadProfilePlan(cli) {
  const name = cli.profile || 'dsh'; // 不指定档案时默认 dsh（保持零参数可用）
  const file = path.join(PROFILE_DIR, name.endsWith('.json') ? name : name + '.json');
  if (!fs.existsSync(file)) {
    const all = fs.existsSync(PROFILE_DIR) ? fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.json')) : [];
    throw new Error(`档案不存在：${file}（可用：${all.join(', ') || '无'}）`);
  }
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  const appPath = profile.appPath ? resolvePath(profile.appPath, ROOT) : null;
  return {
    name: profile.name || name,
    appPath,
    shotOutput: profile.shotOutput || 'shot.png',   // 被测应用 --shot 产物相对 appPath 的位置
    scriptPassthrough: !!profile.scriptPassthrough, // true=直接传探针路径（不写临时中转文件）
    threshold: profile.threshold != null ? Number(profile.threshold) : undefined,
    setupCommand: profile.setupCommand || null,     // 档案级前置命令（长驻服务，如 mock 网关）
    userDataSetup: profile.userDataSetup || null,   // 档案级 user-data 种子（对所有场景生效）
    scenarios: (profile.scenarios || []).map((sc) => ({
      id: sc.id,
      desc: sc.desc || '',
      script: sc.script || null,   // 相对 appPath 的探针路径（Electron 应用模式）
      url: sc.url || null,         // 场景级网页模式（该场景直接 loadURL）
      waitMs: sc.waitMs != null ? Number(sc.waitMs) : undefined,
      threshold: sc.threshold != null ? Number(sc.threshold) : undefined,
      setupCommand: sc.setupCommand || null,     // 场景级前置命令（跑完即回收）
      userDataSetup: sc.userDataSetup || null,   // {files:[{src,dest}]}：截图前塞进隔离 user-data-dir
    })),
  };
}

function loadWebPlan(cli) {
  if (!/^https?:\/\//i.test(cli.url)) throw new Error(`--url 需要以 http(s):// 开头：${cli.url}`);
  let hostPort = '';
  try {
    const u = new URL(cli.url);
    hostPort = u.host.replace(/[^\w.-]+/g, '-');
  } catch { hostPort = 'web-page'; }
  const name = cli.name || hostPort || 'web-page';
  return {
    name,
    appPath: null,
    shotOutput: null,
    scriptPassthrough: false,
    threshold: cli.threshold,
    setupCommand: null,
    userDataSetup: null,
    scenarios: [{
      id: name,
      desc: `网页截图 ${cli.url}`,
      script: null,
      url: cli.url,
      waitMs: cli.wait,
      width: cli.width,
      height: cli.height,
      threshold: cli.threshold,
      setupCommand: null,
      userDataSetup: null,
    }],
  };
}

/* ═══════════════ 前置命令 ═══════════════ */

/** 启动一个前置命令（如 mock 网关）。端口已在监听则复用不重启。返回 {child, reused} 或 null */
async function startSetup(setup, cwdBase, label) {
  if (!setup || !setup.cmd) return null;
  if (setup.portProbe != null && (await portOpen(Number(setup.portProbe)))) {
    console.log(`  [前置] ${label}：端口 ${setup.portProbe} 已监听，复用现有服务`);
    return { child: null, reused: true };
  }
  const cwd = resolvePath(setup.cwd || '.', cwdBase);
  const child = spawn(setup.cmd, setup.args || [], { cwd, windowsHide: true, stdio: 'ignore', env: process.env });
  if (setup.portProbe != null) {
    const port = Number(setup.portProbe);
    for (let i = 0; i < 48; i++) {           // 最多等 12s 让服务就绪
      if (await portOpen(port)) { console.log(`  [前置] ${label}：端口 ${port} 就绪`); return { child, reused: false }; }
      await sleep(250);
    }
    killTree(child);
    throw new Error(`前置命令 ${label} 未在 12s 内监听端口 ${port}`);
  }
  await sleep(setup.readyMs != null ? Number(setup.readyMs) : 1200); // 无端口探测：固定等待
  return { child, reused: false };
}

/* ═══════════════ 单场景截图 ═══════════════ */

/** 场景/档案级 userDataSetup：把指定文件塞进隔离 user-data-dir（如预置 localStorage 种子、软渲染标记） */
function applyUserDataSetup(setup, runDir, base) {
  if (!setup || !Array.isArray(setup.files)) return;
  for (const f of setup.files) {
    const src = resolvePath(f.src, base);
    const dest = resolvePath(f.dest, runDir);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

async function captureScenario(sc, plan, electronExe, outPng, cli) {
  const runDir = path.join(RUN_DIR, sc.id);
  rmrf(runDir);
  fs.mkdirSync(runDir, { recursive: true });
  applyUserDataSetup(plan.userDataSetup, runDir, plan.appPath || ROOT); // 档案级种子先落，场景级可覆盖
  applyUserDataSetup(sc.userDataSetup, runDir, plan.appPath || ROOT);

  if (sc.url) {
    /* ── 网页模式：electron 直接 loadURL 截图，不依赖任何探针 ── */
    const args = [
      WEB_CAPTURE,
      `--url=${sc.url}`,
      `--out=${outPng}`,
      `--wait=${sc.waitMs ?? cli.wait ?? 1500}`,
      `--width=${sc.width ?? cli.width ?? 1280}`,
      `--height=${sc.height ?? cli.height ?? 800}`,
      `--user-data-dir=${runDir}`,
    ];
    const r = await run(electronExe, args, { cwd: ROOT, timeoutMs: 60000 });
    const ok = r.stdout.includes('[web-capture] saved') && fs.existsSync(outPng);
    return { ok, note: ok ? '' : `网页截图失败 ${r.timedOut ? '(超时)' : 'exit=' + r.code} ${r.stderr.slice(-200)}` };
  }

  /* ── Electron 应用模式：--user-data-dir 隔离 + --shot --script=探针 ── */
  if (!plan.appPath) throw new Error(`场景 ${sc.id} 没有 script 也没有 url，无法执行`);
  if (!electronExe) throw new Error('找不到 electron 可执行文件（确认被测应用安装了 devDependencies: electron）');

  const probeAbs = resolvePath(sc.script, plan.appPath);
  if (!fs.existsSync(probeAbs)) throw new Error(`探针不存在：${probeAbs}`);
  let scriptArg = sc.script.replace(/\\/g, '/');
  if (!plan.scriptPassthrough) {
    // 探针内容原样复制到 <appPath>/tools/ 下的中转文件再传给 --script
    //（兼容 main.js 对 --script 只放行 tools/ 单层路径的约束），跑完即删。
    const launcher = path.join(plan.appPath, 'tools', TEMP_LAUNCHER);
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.copyFileSync(probeAbs, launcher);
    scriptArg = 'tools/' + TEMP_LAUNCHER;
  }

  const shotFile = resolvePath(plan.shotOutput, plan.appPath);
  killStaleShotRunners(sc.id); // 先收割遗留僵尸，防止其在截图窗口内乱写 shot.png
  rmrf(shotFile); // 清掉上一轮的 shot.png，避免误移旧图
  const args = ['.', `--user-data-dir=${runDir}`, '--shot', `--script=${scriptArg}`];
  // 150s：覆盖并行负载下 boot 明显变慢的环境波动；卡死后由引擎 killTree + 重试兜底
  const r = await run(electronExe, args, { cwd: plan.appPath, timeoutMs: 150000 });

  if (!plan.scriptPassthrough) rmrf(path.join(plan.appPath, 'tools', TEMP_LAUNCHER));

  if (!fs.existsSync(shotFile)) {
    return { ok: false, note: `截图未产出 ${r.timedOut ? '(超时)' : 'exit=' + r.code}；stdout 尾部: ${r.stdout.slice(-160).replace(/\s+/g, ' ')}` };
  }
  fs.copyFileSync(shotFile, outPng);
  rmrf(shotFile);

  // 探针执行结果：main.js 会把返回值打在 [script] 行；[script-error] 表示探针抛错
  const scriptErr = r.stdout.includes('[script-error]');
  const scriptOk = r.stdout.includes('[script]');
  let note = '';
  if (!scriptOk || scriptErr) {
    const m = r.stdout.match(/\[script-error\][^\n]*/);
    note = scriptErr && m ? '探针报错: ' + m[0] : '探针无返回（未打印 [script] 行）';
    return { ok: false, note };
  }
  try {
    const m = r.stdout.match(/\[script\] (.*)/);
    if (m) { const j = JSON.parse(m[1]); note = j && j.note ? String(j.note) : ''; }
  } catch { /* 返回值不是 JSON 就不解析 */ }
  return { ok: true, note };
}

/* ═══════════════ 像素对比 ═══════════════ */

/** 调 pixdiff.py 对比；返回 {changed, ratio, diffPixels, sizeMismatch} 或 {error} */
async function pixdiff(base, cur, diffOut) {
  const r = await run('python', ['-X', 'utf8', PIXDIFF, base, cur, diffOut], { timeoutMs: 60000, cwd: ROOT });
  const m = r.stdout.match(/\{[\s\S]*\}/); // 取最后一段 JSON（忽略环境噪声）
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* 落到错误分支 */ }
  }
  return { error: `pixdiff 运行失败 exit=${r.code} ${r.stderr.slice(-200)}` };
}

/* ═══════════════ 汇总与报告 ═══════════════ */

const VERDICT_CN = { SAME: '一致', CHANGED: '变化', NEW: '新增', UPDATED: '已更新', FAIL: '失败' };

function printSummary(results, mode, threshold) {
  console.log('\n──────── 截图回归汇总（阈值 ' + threshold + '%，' + (mode === 'update' ? '更新基线' : '对比基线') + '）────────');
  console.log(pad('场景', 22) + '| ' + pad('基线状态', 8) + '| ' + pad('像素差异率', 10) + '| ' + pad('判定', 6) + '| 备注');
  for (const r of results) {
    const base = r.hasBaseline ? '已有' : (mode === 'update' ? '新建' : '缺失');
    const ratio = r.ratio != null ? (r.ratio * 100).toFixed(4) + '%' : '—';
    const verdict = r.ok ? VERDICT_CN[r.verdict] || r.verdict : '失败';
    console.log(pad(r.id, 22) + '| ' + pad(base, 8) + '| ' + pad(ratio, 10) + '| ' + pad(verdict, 6) + '| ' + (r.note || ''));
  }
}

function writeGallery(results, mode, threshold) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cls = (v) => ({ SAME: 'ok', CHANGED: 'bad', NEW: 'new', UPDATED: 'upd', FAIL: 'bad' }[v] || 'bad');
  const cards = results.map((r) => {
    const curImg = `<img src="./${esc(r.id)}.png" alt="${esc(r.id)}">`;
    const diffImg = r.diffFile ? `<figure><figcaption>差异高亮（红=不同像素）</figcaption><img src="./${esc(r.diffFile)}" alt="diff"></figure>` : '';
    const baseImg = r.hasBaseline ? `<figure><figcaption>基线</figcaption><img src="../tools/shot-baselines/${esc(r.id)}.png" alt="base"></figure>` : '<figure><figcaption>基线：无</figcaption></figure>';
    return `<div class="card ${cls(r.verdict)}">
      <div class="head"><b>${esc(r.id)}</b> <span class="badge">${esc(VERDICT_CN[r.verdict] || r.verdict)}</span>
        <span class="ratio">${r.ratio != null ? '差异率 ' + (r.ratio * 100).toFixed(4) + '%' : ''}</span></div>
      <p class="desc">${esc(r.desc)}${r.note ? ' · ' + esc(r.note) : ''}</p>
      <figure><figcaption>当前截图</figcaption>${curImg}</figure>
      ${diffImg}${baseImg}
    </div>`;
  }).join('\n');
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>截图回归报告</title>
<style>
  body{background:#141414;color:#ddd;font:14px/1.5 "Segoe UI",system-ui,sans-serif;margin:24px}
  h1{font-size:20px} .meta{color:#888;margin-bottom:16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px}
  .card{background:#1e1e1e;border:1px solid #333;border-radius:8px;padding:12px}
  .card.ok{border-color:#2e7d32}.card.bad{border-color:#c62828}.card.new{border-color:#1565c0}.card.upd{border-color:#6a1b9a}
  .badge{border-radius:4px;padding:1px 8px;font-size:12px;color:#fff}
  .ok .badge{background:#2e7d32}.bad .badge{background:#c62828}.new .badge{background:#1565c0}.upd .badge{background:#6a1b9a}
  .ratio{color:#999;font-size:12px;margin-left:8px}
  .desc{color:#aaa;font-size:12px;margin:6px 0}
  figure{margin:8px 0}figcaption{font-size:12px;color:#888;margin-bottom:4px}
  img{max-width:100%;border:1px solid #333;border-radius:4px;background:#000}
</style></head><body>
<h1>截图回归报告</h1>
<p class="meta">模式：${mode === 'update' ? '更新基线' : '对比基线'} · 阈值 ${threshold}% · 共 ${results.length} 个场景 · 生成于 ${new Date().toLocaleString('zh-CN')}</p>
<div class="grid">
${cards}
</div></body></html>`;
  const file = path.join(OUT_DIR, 'gallery.html');
  fs.writeFileSync(file, html);
  return file;
}

function openInBrowser(file) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', path.basename(file)], { cwd: path.dirname(file), windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打不开浏览器不影响结论 */ }
}

/* ═══════════════ 主流程 ═══════════════ */

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const plan = cli.url ? loadWebPlan(cli) : loadProfilePlan(cli);
  const mode = cli.update ? 'update' : 'compare';

  fs.mkdirSync(RUN_DIR, { recursive: true });
  rmrf(OUT_DIR);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (cli.update) fs.mkdirSync(BASELINE_DIR, { recursive: true });

  console.log(`[shot-suite] 项目: ${plan.name} · 模式: ${mode === 'update' ? '更新基线' : '对比基线'} · 场景 ${plan.scenarios.length} 个`);
  console.log(`[shot-suite] electron: ${plan.appPath || '(网页模式)'}`);

  /* 档案级前置命令（如 mock 网关）：起一次、全程复用、结束回收 */
  let globalSetup = null;
  if (plan.setupCommand) {
    globalSetup = await startSetup(plan.setupCommand, ROOT, plan.setupCommand.label || plan.name);
  }

  const results = [];
  try {
    const electronExe = plan.appPath ? resolveElectron(plan.appPath) : resolveElectron(null);

    for (const sc of plan.scenarios) {
      const t0 = Date.now();
      let ok = false, note = '', attempts = 0;
      let scSetup = null;
      try {
        scSetup = await startSetup(sc.setupCommand, plan.appPath || ROOT, sc.id);
        const outPng = path.join(OUT_DIR, sc.id + '.png');
        // 截图失败自动重试一次：GPU 驱动间歇崩溃 / 渲染进程恢复等偶发环境问题不直接判死
        for (let i = 1; i <= 2; i++) {
          attempts = i;
          try {
            const cap = await captureScenario(sc, plan, electronExe, outPng, cli);
            ok = cap.ok; note = cap.note;
          } catch (err) {
            note = err && err.message ? err.message : String(err);
          }
          if (ok) break;
          if (i < 2) await sleep(600); // 稍候再试，给崩溃恢复 / 进程退出留时间
        }
        if (!ok && attempts > 1) note += '（已重试 1 次）';
      } catch (err) {
        note = err && err.message ? err.message : String(err);
      } finally {
        if (scSetup && !scSetup.reused) killTree(scSetup.child);
      }
      const hasPng = fs.existsSync(path.join(OUT_DIR, sc.id + '.png'));
      const baseline = path.join(BASELINE_DIR, sc.id + '.png');
      results.push({
        id: sc.id, desc: sc.desc, ok: ok && hasPng, note,
        threshold: sc.threshold, // 场景级阈值优先于档案级 / CLI 级
        elapsedMs: Date.now() - t0,
        hasBaseline: fs.existsSync(baseline),
        verdict: null, ratio: null, diffPixels: null, diffFile: null,
      });
      console.log(`  [${ok && hasPng ? '✓' : '✗'}] ${sc.id}（${results.at(-1).elapsedMs}ms）${note ? '· ' + note : ''}`);
    }

    /* 第二阶段：对比 / 更新基线 */
    for (const r of results) {
      const baseline = path.join(BASELINE_DIR, r.id + '.png');
      const cur = path.join(OUT_DIR, r.id + '.png');
      if (!r.ok) { r.verdict = 'FAIL'; continue; }
      if (mode === 'update') {
        fs.copyFileSync(cur, baseline);
        r.verdict = 'UPDATED';
        continue;
      }
      if (!fs.existsSync(baseline)) { r.verdict = 'NEW'; continue; } // 基线缺失：提示先 --update 建基线
      const diffFile = path.join(OUT_DIR, r.id + '.diff.png');
      const d = await pixdiff(baseline, cur, diffFile);
      if (d.error) { r.verdict = 'FAIL'; r.note = d.error; continue; }
      r.ratio = d.ratio; r.diffPixels = d.diffPixels;
      const thresholdPct = r.threshold ?? plan.threshold ?? cli.threshold ?? DEFAULT_THRESHOLD;
      r.threshold = thresholdPct;
      if (d.diffPixels > 0 && d.ratio > thresholdPct / 100) {
        r.verdict = 'CHANGED';
        r.diffFile = r.id + '.diff.png'; // 差异图仅在 CHANGED 时保留进报告
      } else {
        r.verdict = 'SAME';
        rmrf(diffFile); // 一致的场景不需要展示空白 diff
      }
    }

    printSummary(results, mode, plan.threshold ?? cli.threshold ?? DEFAULT_THRESHOLD);
    const gallery = writeGallery(results, mode, plan.threshold ?? cli.threshold ?? DEFAULT_THRESHOLD);
    if (!cli.noOpen) openInBrowser(gallery);
    console.log(`[shot-suite] 报告: ${gallery}`);

    const failed = results.filter((r) => !r.ok || r.verdict === 'CHANGED' || r.verdict === 'FAIL').length;
    return { failed, total: results.length, mode };
  } finally {
    if (globalSetup && !globalSetup.reused) killTree(globalSetup.child);
    if (!plan.scriptPassthrough && plan.appPath) rmrf(path.join(plan.appPath, 'tools', TEMP_LAUNCHER));
  }
}

main().then(({ failed, total, mode }) => {
  if (mode === 'update') {
    console.log(`[shot-suite] 完成：${total} 个场景基线已写入 tools/shot-baselines/`);
    process.exit(failed ? 1 : 0);
  }
  if (failed) {
    console.log(`[shot-suite] 回归不通过：${failed}/${total} 个场景变化或失败`);
    process.exit(1);
  }
  console.log(`[shot-suite] 回归通过：${total}/${total} 全部一致或新增`);
  process.exit(0);
}).catch((err) => {
  console.error('[shot-suite] 引擎异常：', err && err.message ? err.message : err);
  process.exit(2);
});
