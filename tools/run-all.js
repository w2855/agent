'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   一键验收聚合器：node tools/run-all.js [--quick]

   串行跑全部验收并汇总成一张表；任一失败退出码 1。
   1. 语法门禁   node --check（main/preload/lib/runtime/renderer/app.js + 关键 tools 脚本）
   2. runtime 回归  tools/runtime-*-check.js（runtime-ipc-check 需 Electron，跳过标注）
   3. lib 自检   mcp-selfcheck / skills-selfcheck / ipc-mcp-check / secret-mask-check /
                 h3-check / lessons-check（存在才跑）
   4. Electron 探针（--quick 跳过）settings-probe / dyn-probe（两阶段）/ g3-probe /
                 mcp-ui-probe，隔离 userData .runall-probe，跑完删；
                 统一捕获 main.js 的 [script] 行解析 passed/failed
   5. tool-e2e（--quick 跳过）同上方式跑，前置 mock-gateway（端口 57321 复用或新起）

   注意：并发代理可能正在改代码——聚合器只跑现状，结果异常属预期，不重试不修复。
   ───────────────────────────────────────────────────────────────────────────── */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const QUICK = process.argv.includes('--quick');
const PROBE_DIR = path.join(ROOT, '.runall-probe');
const GW_PORT = 57321;

/* ── 清单（与 docs/WORKFLOW.md §6 回归基线一致） ── */
const RUNTIME_CHECKS = fs.readdirSync(path.join(ROOT, 'tools'))
  .filter((f) => /^runtime-[\w]+-check\.js$/.test(f)).sort();
const LIB_CHECKS = [
  'lessons-check.js', 'mcp-selfcheck.js', 'skills-selfcheck.js',
  'ipc-mcp-check.js', 'secret-mask-check.js', 'h3-check.js',
];
const PROBES = ['settings-probe.js', 'dyn-probe.js', 'g3-probe.js', 'mcp-ui-probe.js'];
const SYNTAX_CORE = [
  'main.js', 'preload.js', 'renderer/app.js',
  ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).sort()
    .map((f) => 'lib/' + f),
  ...fs.readdirSync(path.join(ROOT, 'runtime')).filter((f) => f.endsWith('.js')).sort()
    .map((f) => 'runtime/' + f),
];
/* 关键 tools 脚本 = 聚合器链路本身依赖的脚本 */
const SYNTAX_TOOLS = [...new Set([
  ...RUNTIME_CHECKS, ...LIB_CHECKS, ...PROBES, 'tool-e2e.js', 'mock-gateway.js',
])].filter((f) => fs.existsSync(path.join(ROOT, 'tools', f))).sort();

let electronPath = null;
try { electronPath = require('electron'); } catch { /* 回退 npx */ }

/* ── 结果收集 ── */
const rows = []; // {cat, name, verdict: '✓'|'✗'|'—', counts, note}
let failCount = 0, skipCount = 0, passCount = 0;

function add(cat, name, verdict, counts = null, note = '') {
  rows.push({ cat, name, verdict, counts, note });
  if (verdict === '✗') failCount++;
  else if (verdict === '—') skipCount++;
  else passCount++;
  const mark = verdict === '✓' ? '通过' : verdict === '✗' ? '失败' : '跳过';
  process.stdout.write(`  [${verdict}] ${name}  ${counts || ''} ${note ? '· ' + note : ''} (${mark})\n`);
}

/* ── 基础工具 ── */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) >= 0x2e80 ? 2 : 1; // CJK/全角按 2 列
  return w;
}
function pad(s, w) {
  s = String(s ?? '');
  return s + ' '.repeat(Math.max(0, w - displayWidth(s)));
}

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

/* 宿主环境可能设置 ELECTRON_RUN_AS_NODE=1（部分 agent/IDE 运行时如此），
   会让 electron.exe 退化成纯 Node 进程：main.js 里 require('electron').app 为 undefined
   → 启动即崩 → 全部 Electron 探针假失败（"无 [script] 输出"）。统一剥离后再spawn。 */
const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.ELECTRON_RUN_AS_NODE;

/** 跑一个命令并限时；返回 {code, stdout, stderr, timedOut} */
function run(cmd, args, { timeoutMs = 60000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: CLEAN_ENV });
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

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 被占用则留给下次 */ } }

/** 解析 stdout 里的 {total,passed,failed} 计数（JSON 整体 / 尾部 JSON / 中文「N 通过 / M 失败」/ OK/XX 行） */
function parseCounts(text) {
  const tryJson = (s) => {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object') {
        if (typeof j.passed === 'number' || typeof j.failed === 'number' || typeof j.total === 'number') {
          return { passed: j.passed ?? 0, failed: j.failed ?? 0, total: j.total ?? ((j.passed ?? 0) + (j.failed ?? 0)) };
        }
      }
    } catch { /* 不是 JSON */ }
    return null;
  };
  let m = tryJson(text.trim());
  if (m) return m;
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    m = tryJson(text.slice(i));
    if (m) return m;
  }
  const cn = text.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
  if (cn) return { passed: +cn[1], failed: +cn[2], total: +cn[1] + +cn[2] };
  const okLines = text.match(/^OK {2}/gm), xxLines = text.match(/^XX {2}/gm);
  if (okLines || xxLines) {
    return { passed: okLines ? okLines.length : 0, failed: xxLines ? xxLines.length : 0, total: (okLines?.length || 0) + (xxLines?.length || 0) };
  }
  return null;
}

/** 结构探针（返回值无 passed/failed 计数）的通用失败信号 */
function structuralIssue(obj) {
  if (!obj || typeof obj !== 'object') return '返回值不是对象';
  if (Array.isArray(obj.errors) && obj.errors.length) return 'errors: ' + obj.errors.slice(0, 3).join('; ');
  if (Array.isArray(obj.missingIds) && obj.missingIds.length) return 'missingIds: ' + obj.missingIds.slice(0, 5).join(', ');
  if (obj.ok === false) return typeof obj.error === 'string' ? obj.error : 'ok=false';
  return null;
}

/* ── Electron 探针：跑 --shot --script，捕获 [script] 行 ──
   fresh=true 先清空隔离 userData；fresh=false 保留（dyn-probe 两相位靠 localStorage 翻转复用同一目录）；
   cleanup=true 跑完即删；需要跨跑保留状态时传 false、由调用方统一清理 */
async function runElectronProbe(script, { timeoutMs = 120000, fresh = true, cleanup = true } = {}) {
  if (fresh) rmrf(PROBE_DIR);
  const args = ['.', `--user-data-dir=${PROBE_DIR}`, '--shot', `--script=tools/${script}`];
  const cmd = electronPath || 'npx';
  const argv = electronPath ? args : ['electron', '.', ...args.slice(1)];
  const r = await run(cmd, argv, { timeoutMs, cwd: ROOT });
  if (cleanup) rmrf(PROBE_DIR);
  if (r.timedOut) return { fail: `超时（>${Math.round(timeoutMs / 1000)}s）已终止`, raw: r };
  const errLine = r.stdout.split(/\r?\n/).find((l) => l.startsWith('[script-error]'));
  if (errLine) return { fail: errLine.slice('[script-error] '.length).slice(0, 300), raw: r };
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('[script] '));
  if (!line) {
    const blob = (r.stdout || '') + (r.stderr || '');
    if (/disableHardwareAcceleration|ELECTRON_RUN_AS_NODE/.test(blob)) {
      return { fail: 'electron 被当成纯 Node 运行（ELECTRON_RUN_AS_NODE 污染），非代码问题：用 env -u ELECTRON_RUN_AS_NODE 重跑', raw: r };
    }
    return { fail: '无 [script] 输出（页面未加载完或脚本 promise 未决，见 docs/e2e-guide.md）', raw: r };
  }
  let obj;
  try { obj = JSON.parse(line.slice('[script] '.length)); } catch (e) {
    return { fail: '[script] JSON 解析失败: ' + e.message, raw: r };
  }
  return { obj, raw: r };
}

/** mock-gateway：端口活着就复用（可能属于并发代理），否则新起、用完回收 */
async function ensureGateway() {
  const alive = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: GW_PORT, path: '/v1/models', timeout: 2000 }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
  if (alive) return { reused: true, child: null };
  rmrf(PROBE_DIR);
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const log = fs.openSync(path.join(PROBE_DIR, 'mock-gw.log'), 'a');
  const child = spawn(process.execPath, ['tools/mock-gateway.js'], { cwd: ROOT, stdio: ['ignore', log, log], windowsHide: true });
  const up = await new Promise((resolve) => {
    const t0 = Date.now();
    const poll = () => {
      const req = http.get({ host: '127.0.0.1', port: GW_PORT, path: '/v1/models', timeout: 1000 }, (res) => {
        res.resume(); resolve(res.statusCode === 200);
      });
      req.on('error', () => {
        if (Date.now() - t0 > 8000) resolve(false); else setTimeout(poll, 300);
      });
    };
    poll();
  });
  return { reused: false, child, up };
}

/* ═══════════════ 主流程 ═══════════════ */
(async () => {
  let head = '';
  try { head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).stdout?.toString().trim() || '?'; } catch { /* 无 git */ }
  console.log(`\n== DSH 一键验收聚合器 ==  模式: ${QUICK ? '--quick（跳过 Electron 探针/e2e）' : '全量'}  基线: ${head}  时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log('   （并发代理可能正在改代码，本表只反映跑表那一刻的现状）\n');

  /* 1. 语法门禁 */
  console.log('── 1. 语法门禁 ──');
  const syntaxTargets = [...SYNTAX_CORE, ...SYNTAX_TOOLS.map((f) => 'tools/' + f)];
  const syntaxFailed = [];
  for (const f of syntaxTargets) {
    const r = await run(process.execPath, ['--check', f], { timeoutMs: 30000 });
    if (r.code !== 0) syntaxFailed.push(`${f}: ${(r.stderr || 'exit ' + r.code).trim().split(/\r?\n/)[0]}`);
  }
  add('语法门禁', `node --check × ${syntaxTargets.length}`,
    syntaxFailed.length ? '✗' : '✓',
    `${syntaxTargets.length - syntaxFailed.length}/${syntaxTargets.length}`,
    syntaxFailed.length ? '失败: ' + syntaxFailed.join(' | ') : 'main/preload/lib/runtime/app.js/tools 关键脚本');

  /* 2. runtime 回归 */
  console.log('── 2. runtime 回归 ──');
  let rtPassed = 0, rtTotal = 0, rtRows = [];
  for (const f of RUNTIME_CHECKS) {
    if (f === 'runtime-ipc-check.js') {
      add('runtime回归', f, '—', null, '需 Electron（--script 通道），跳过');
      continue;
    }
    const r = await run(process.execPath, ['tools/' + f], { timeoutMs: 120000 });
    const c = parseCounts(r.stdout);
    const failed = r.timedOut || r.code !== 0 || !c || c.failed > 0;
    if (!failed) { rtPassed += c.passed; rtTotal += c.total; }
    rtRows.push(`${f.replace('runtime-', '').replace('-check.js', '')} ${failed && !c ? '✗' : c ? `${c.passed}/${c.total}` : '✗无输出'}`);
    add('runtime回归', f, failed ? '✗' : '✓', c ? `${c.passed}/${c.total}` : null,
      failed ? (r.timedOut ? '超时' : !c ? '无法解析结果（exit ' + r.code + '）' : `${c.failed} 项失败`) : '');
  }
  const rtFailed = rows.some((x) => x.cat === 'runtime回归' && x.verdict === '✗');
  add('runtime回归', 'runtime 汇总', rtFailed ? '✗' : '✓',
    rtTotal ? `${rtPassed}/${rtTotal}` : null, rtRows.join(' · '));

  /* 3. lib 自检 */
  console.log('── 3. lib 自检 ──');
  for (const f of LIB_CHECKS) {
    if (!fs.existsSync(path.join(ROOT, 'tools', f))) {
      add('lib自检', f, '—', null, '文件不存在，跳过');
      continue;
    }
    const r = await run(process.execPath, ['tools/' + f], { timeoutMs: 120000 });
    const c = parseCounts(r.stdout);
    const failed = r.timedOut || r.code !== 0 || !c || c.failed > 0;
    add('lib自检', f, failed ? '✗' : '✓', c ? `${c.passed}/${c.total}` : null,
      failed ? (r.timedOut ? '超时' : !c ? '无法解析结果（exit ' + r.code + '）' : `${c.failed} 项失败`) : '');
  }

  /* 4/5. Electron 探针 + tool-e2e（--quick 跳过） */
  if (QUICK) {
    console.log('── 4. Electron 探针 / 5. tool-e2e ──');
    for (const f of PROBES) add('Electron探针', f, '—', null, '--quick 跳过');
    add('Electron探针', 'tool-e2e.js', '—', null, '--quick 跳过');
  } else {
    console.log('── 4. Electron 探针 ──');
    for (const f of PROBES) {
      if (f === 'dyn-probe.js') {
        /* dyn-probe 两阶段复用同一 userData（localStorage 翻转），两跑均不清理，结束后一起删 */
        const p1 = await runElectronProbe(f, { timeoutMs: 120000, fresh: true, cleanup: false });
        const p2 = p1.fail ? null : await runElectronProbe(f, { timeoutMs: 120000, fresh: false, cleanup: false }); // 同目录自动进 todo 相位
        rmrf(PROBE_DIR);
        if (p1.fail) { add('Electron探针', f, '✗', null, '相位1(arch): ' + p1.fail); continue; }
        if (!p2 || p2.fail) { add('Electron探针', f, '✗', null, '相位2(todo): ' + (p2 ? p2.fail : '未运行')); continue; }
        const count = (o) => {
          const vals = Object.values(o.checks || {});
          return { passed: vals.filter((v) => v && v.ok === true).length, failed: vals.filter((v) => v && v.ok === false).length + (o.errors?.length || 0) };
        };
        const c1 = count(p1.obj), c2 = count(p2.obj);
        const phases = `${p1.obj.phase || '?'}/${p2.obj.phase || '?'}`;
        const failed = c1.failed + c2.failed;
        add('Electron探针', f, failed ? '✗' : '✓',
          `${c1.passed + c2.passed}过/${failed}败`,
          `两相位 ${phases} · arch ${c1.passed}过${c1.failed}败 · todo ${c2.passed}过${c2.failed}败`);
        continue;
      }
      const { obj, fail, raw } = await runElectronProbe(f, { timeoutMs: 120000 });
      if (fail) { add('Electron探针', f, '✗', null, fail); continue; }
      if (typeof obj.passed === 'number' || typeof obj.failed === 'number') {
        const names = [obj.results, obj.checks].flat().filter(Boolean)
          .filter((r) => r && (r.ok === false || r.pass === false)).map((r) => r.name).slice(0, 5).join(', ');
        add('Electron探针', f, obj.failed ? '✗' : '✓', `${obj.passed}/${(obj.passed ?? 0) + (obj.failed ?? 0)}`,
          obj.failed ? `${obj.failed} 项失败${names ? ': ' + names : ''}` : '');
      } else {
        const issue = structuralIssue(obj);
        add('Electron探针', f, issue ? '✗' : '✓', null,
          issue ? issue : `结构探针完成（${Object.keys(obj).length} 个顶层键，无计数）exit=${raw.code}`);
      }
    }

    console.log('── 5. tool-e2e ──');
    const gw = await ensureGateway();
    if (gw.child && !gw.up) {
      killTree(gw.child); rmrf(PROBE_DIR);
      add('Electron探针', 'tool-e2e.js', '✗', null, 'mock-gateway 启动失败（端口 57321 无响应）');
    } else {
      const { obj, fail, raw } = await runElectronProbe('tool-e2e.js', { timeoutMs: 300000 });
      if (!gw.reused && gw.child) killTree(gw.child);
      if (fail) add('Electron探针', 'tool-e2e.js', '✗', null, fail);
      else add('Electron探针', 'tool-e2e.js', obj.failed ? '✗' : '✓',
        `${obj.passed}/${obj.total ?? ((obj.passed ?? 0) + (obj.failed ?? 0))}`,
        (gw.reused ? '复用现有网关 · ' : '新建网关已回收 · ') + (obj.failed ? `${obj.failed} 项失败: ` +
          (obj.checks || []).filter((c) => !c.pass).slice(0, 5).map((c) => c.name).join(', ') : 'exit=' + raw.code));
    }
    rmrf(PROBE_DIR);
  }

  /* 总表输出（中文列对齐，CJK 按 2 列宽） */
  const COL = { cat: 12, name: 26, verdict: 6, counts: 12, note: 46 };
  const line = '─'.repeat(COL.cat + COL.name + COL.verdict + COL.counts + COL.note + 8);
  console.log('\n' + line);
  console.log(` ${pad('分类', COL.cat)} ${pad('项目', COL.name)} ${pad('结果', COL.verdict)} ${pad('数字', COL.counts)} 备注`);
  console.log(line);
  for (const r of rows) {
    console.log(` ${pad(r.cat, COL.cat)} ${pad(r.name, COL.name)} ${pad(r.verdict, COL.verdict)} ${pad(r.counts || '—', COL.counts)} ${r.note || ''}`);
  }
  console.log(line);
  const total = passCount + failCount + skipCount;
  console.log(` 总计 ${total} 项：✓ ${passCount} · ✗ ${failCount} · — ${skipCount}　${failCount ? '→ 存在失败，退出码 1（不重试不修复，异常属并发改动预期）' : '→ 全部通过'}`);
  console.log('');
  process.exitCode = failCount ? 1 : 0;
})().catch((err) => {
  console.error('[run-all] 未捕获错误：', err);
  process.exitCode = 1;
});
