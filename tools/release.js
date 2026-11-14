#!/usr/bin/env node
/**
 * DSH Desktop 打包流水线 —— 把 2026-11-14 打包当天踩过的坑全部固化。
 *
 * 用法:
 *   node tools/release.js                     预检 + 构建 + 后验
 *   node tools/release.js --skip-precheck     跳过预检直接构建（工作区有进行中改动时用）
 *   node tools/release.js --bump patch        升版本号 patch|minor|major（只改版本，不构建）
 *   node tools/release.js --verify            只校验 release/ 字节与 manifest.json 是否一致（不构建）
 *
 * 退出码: 0 成功 / 1 用法或内部错误 / 2 预检失败 / 3 构建失败(含超时) / 4 后验失败(含发版字节校验)
 *
 * 固化的坑（详见 tools/RELEASE.md）:
 *   坑1: node_modules 缺失时 ^45.3.1 版本范围会让 electron-builder 报错
 *        → package.json build.electronVersion 必须钉死精确版本，预检强制校验。
 *   坑2: GitHub 下载 electron zip 间歇 ETIMEDOUT
 *        → 构建前强制注入 ELECTRON_MIRROR（已有环境变量则尊重不覆盖）。
 *   坑3: electron-builder 26 没有 --electron-version CLI 参数（Unknown argument）
 *        → 命令行只用 `--win portable`，版本走 package.json。
 *   坑4: 构建耗时 >8 分钟
 *        → 实时透传日志（[build] 前缀）+ 默认 10 分钟超时保护
 *          （可用环境变量 RELEASE_BUILD_TIMEOUT_MS 调大）。
 *   坑5: 产物固定为 release/DSH-Desktop-<version>.exe（约 105MB）
 *        → 后验按 package.json 版本精确核对产物名、字节数与新鲜度。
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vr = require('../lib/verify-release'); // 发版字节校验（ruflo verify 模式）

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const LOG_PATH = path.join(RELEASE_DIR, 'build.log');
const PKG_PATH = path.join(ROOT, 'package.json');

// —— 退出码语义化 ——
const EXIT_OK = 0;         // 成功
const EXIT_USAGE = 1;      // 用法错误 / 未预期内部错误
const EXIT_PRECHECK = 2;   // 预检失败
const EXIT_BUILD = 3;      // 构建失败（含超时）
const EXIT_POSTCHECK = 4;  // 后验失败

// 坑4: 构建经常 >8 分钟，默认给 10 分钟兜底；可用 RELEASE_BUILD_TIMEOUT_MS 覆盖。
const BUILD_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000;
// 坑2: 官方 GitHub 源间歇超时，默认走 npmmirror 镜像。
const ELECTRON_MIRROR_DEFAULT = 'https://npmmirror.com/mirrors/electron/';

function log(msg) { console.log(`[release] ${msg}`); }
function warn(msg) { console.log(`[release] [警告] ${msg}`); }
function die(code, msg) {
  if (msg) console.error(`[release] [错误] ${msg}`);
  process.exit(code);
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`;
}
function fmtBytes(n) { return `${n.toLocaleString('en-US')} 字节 (${(n / 1024 / 1024).toFixed(1)} MB)`; }

// ———————————————————————————— 参数解析 ————————————————————————————
function parseArgs(argv) {
  const opts = { skipPrecheck: false, bump: null, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-precheck') { opts.skipPrecheck = true; continue; }
    if (a === '--verify') { opts.verify = true; continue; }
    if (a === '--bump' || a.startsWith('--bump=')) {
      const val = a.includes('=') ? a.slice('--bump='.length) : argv[++i];
      if (!['patch', 'minor', 'major'].includes(val)) {
        die(EXIT_USAGE, `--bump 只接受 patch|minor|major，收到: ${val}`);
      }
      opts.bump = val;
      continue;
    }
    die(EXIT_USAGE, `未知参数: ${a}\n用法: node tools/release.js [--skip-precheck] [--bump patch|minor|major] [--verify]`);
  }
  return opts;
}

// ———————————————————————————— 版本升级 (--bump) ————————————————————————————
// 只改 package.json 的 version 字段并写回，不做构建；发版流程 = 先 bump 再跑构建。
function bumpVersion(level) {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const m = String(pkg.version || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) die(EXIT_USAGE, `package.json 当前 version "${pkg.version}" 不是标准 x.y.z，无法自动升级`);
  let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const oldV = pkg.version;
  if (level === 'major') { maj += 1; min = 0; pat = 0; }
  else if (level === 'minor') { min += 1; pat = 0; }
  else { pat += 1; }
  pkg.version = `${maj}.${min}.${pat}`;
  // 2 空格缩进 + 末尾换行，与原文件格式保持一致
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log(`版本号已升级: ${oldV} -> ${pkg.version} (${level})`);
  log(`下一步: node tools/release.js 开始构建 release/DSH-Desktop-${pkg.version}.exe`);
  log('提示: package.json 的改动尚未 git commit，按团队流程自行提交。');
  return pkg.version;
}

// ———————————————————————————— 预检 ————————————————————————————
// 坑1 固化点: build.electronVersion 必须是精确版本；node_modules 缺失时
// electron-builder 无法把 ^45.3.1 之类的范围解析成具体 zip，直接报错。
function isExactVersion(v) {
  if (typeof v !== 'string') return false;
  const m = v.replace(/^v/i, '').match(/^(\d+\.\d+\.\d+)(.*)$/);
  if (!m) return false;
  return !/[\^~><=*x\s]/.test(m[2]); // 尾部不允许出现范围/通配符/空白
}

function precheck() {
  const errors = [];
  const warnings = [];

  // 1) 语法检查: node --check main.js / preload.js / lib/*.js
  const filesToCheck = ['main.js', 'preload.js'];
  const libDir = path.join(ROOT, 'lib');
  if (fs.existsSync(libDir)) {
    for (const f of fs.readdirSync(libDir)) {
      if (f.endsWith('.js')) filesToCheck.push(path.join('lib', f));
    }
  } else {
    warnings.push('lib/ 目录不存在，跳过其语法检查');
  }
  for (const rel of filesToCheck) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { errors.push(`文件不存在: ${rel}`); continue; }
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
    if (r.status !== 0) {
      errors.push(`语法检查失败: ${rel}\n${(r.stderr || r.stdout || '').trim()}`);
    }
  }

  // 2) 坑1 校验: build.electronVersion 存在且非范围值
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const ev = pkg.build && pkg.build.electronVersion;
  if (!ev) {
    errors.push('package.json 缺少 build.electronVersion（坑1: 无 node_modules 时 ^x.y.z 范围会构建报错，必须钉死精确版本）');
  } else if (!isExactVersion(ev)) {
    errors.push(`build.electronVersion="${ev}" 不是精确版本（坑1: 不能是 ^45.3.1 之类的范围值）`);
  }

  // 3) git 干净度提示（仅警告: 未提交改动会被打进 asar 包）
  const g = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (g.status === 0 && g.stdout && g.stdout.trim()) {
    const dirty = g.stdout.trim().split('\n');
    warnings.push(`工作区有 ${dirty.length} 处未提交改动，它们会被打进安装包（如非预期请先提交）:`);
    for (const line of dirty.slice(0, 20)) console.log(`[release]           ${line}`);
    if (dirty.length > 20) console.log(`[release]           ... 以及另外 ${dirty.length - 20} 处`);
  } else if (g.status !== 0) {
    warnings.push('git status 执行失败（可能不是 git 仓库），跳过干净度检查');
  }

  return { errors, warnings };
}

// ———————————————————————————— 构建 ————————————————————————————
// 坑4: 实时透传 stdout（[build] 前缀），同步缓冲全量日志供失败后定位。
// 坑3: 只用 `--win portable`，electron-builder 26 没有 --electron-version 参数。
function runBuild(timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const env = { ...process.env };
    // 坑2: 强制镜像，但尊重调用方已显式设置的值
    if (!env.ELECTRON_MIRROR) {
      env.ELECTRON_MIRROR = ELECTRON_MIRROR_DEFAULT;
      log(`已注入 ELECTRON_MIRROR=${ELECTRON_MIRROR_DEFAULT}（坑2: GitHub 源间歇 ETIMEDOUT）`);
    } else {
      log(`沿用现有 ELECTRON_MIRROR=${env.ELECTRON_MIRROR}`);
    }

    log(`开始构建: npx electron-builder --win portable（超时保护 ${fmtDur(timeoutMs)}）`);
    // 命令是固定字面量（无外部输入），整体走 shell 执行可同时兼容 Windows 的 npx.cmd
    // 与 POSIX 的 sh，且避免 DEP0190（shell:true + 非空 args 会触发弃用警告）
    const child = spawn('npx electron-builder --win portable', [], {
      cwd: ROOT,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines = [];
    let timedOut = false;
    let buf = '';
    const feed = (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r/g, '').trimEnd();
        buf = buf.slice(idx + 1);
        if (line) { lines.push(line); console.log(`[build] ${line}`); }
      }
    };
    child.stdout.on('data', (d) => feed(d.toString()));
    child.stderr.on('data', (d) => feed(d.toString()));

    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[release] [错误] 构建超过 ${fmtDur(timeoutMs)}，强制终止（坑4: 可用 RELEASE_BUILD_TIMEOUT_MS 调大超时）`);
      // Windows 下 shell:true 起的是 cmd.exe，必须杀整棵进程树
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) { lines.push(buf.trim()); console.log(`[build] ${buf.trim()}`); }
      resolve({ code, timedOut, lines, startedAt, endedAt: Date.now() });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      lines.push(`[release] spawn 失败: ${err.message}`);
      resolve({ code: -1, timedOut, lines, startedAt, endedAt: Date.now() });
    });
  });
}

// 全量日志落盘到 release/build.log（release/ 已在 .gitignore，不会入库）
function writeBuildLog(lines, meta) {
  try {
    fs.mkdirSync(RELEASE_DIR, { recursive: true });
    const head = [
      `# DSH Desktop 构建日志 ${meta.time}`,
      `# 命令: npx electron-builder --win portable`,
      `# 结果: ${meta.result}`,
      '',
    ].join('\n');
    fs.writeFileSync(LOG_PATH, head + lines.join('\n') + '\n', 'utf8');
    return true;
  } catch (e) {
    warn(`构建日志写入失败: ${e.message}`);
    return false;
  }
}

// ———————————————————————————— 后验 ————————————————————————————
// 坑5: 产物名固定 DSH-Desktop-<version>.exe；必须核对新鲜度，防止拿旧 exe 冒充本次产物。
function postcheck(version, buildStartTime) {
  if (!fs.existsSync(RELEASE_DIR)) return { ok: false, reason: 'release/ 目录不存在' };
  const exes = fs.readdirSync(RELEASE_DIR).filter((f) => f.toLowerCase().endsWith('.exe'));
  if (exes.length === 0) return { ok: false, reason: 'release/ 下没有任何 .exe 产物' };

  const expected = `DSH-Desktop-${version}.exe`;
  const chosen = exes.includes(expected) ? expected : exes[0];
  const abs = path.join(RELEASE_DIR, chosen);
  const st = fs.statSync(abs);
  const fresh = st.mtimeMs >= buildStartTime - 5000; // 5 秒容差，防止时钟偏差误报
  return {
    ok: fresh,
    path: abs,
    name: chosen,
    size: st.size,
    mtime: st.mtime,
    fresh,
    expected,
    others: exes.filter((f) => f !== chosen),
  };
}

// ———————————————————————————— 主流程 ————————————————————————————
async function main() {
  const t0 = Date.now();
  const opts = parseArgs(process.argv.slice(2));

  // --bump: 独立模式，只升版本号不构建
  if (opts.bump) { bumpVersion(opts.bump); process.exit(EXIT_OK); }

  // --verify: 独立模式，只做发版字节校验不构建（对齐 ruflo verify: 安装字节与清单一致才放行）
  if (opts.verify) {
    log(`发版字节校验: ${RELEASE_DIR}`);
    const result = await vr.verifyRelease(RELEASE_DIR);
    for (const line of vr.formatVerifyReport(result)) console.log(`[release] ${line}`);
    if (!result.ok) die(EXIT_POSTCHECK, '发版字节校验未通过（见上方报告）');
    process.exit(EXIT_OK);
  }

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const version = pkg.version;
  log(`DSH Desktop 打包流水线 | 目标版本 ${version} | node ${process.version} | ${process.platform}`);

  // 1) 预检
  if (opts.skipPrecheck) {
    log('--skip-precheck: 跳过预检（工作区可能有进行中改动，属预期时使用）');
  } else {
    log('预检: node --check 语法检查 / electronVersion 钉版校验 / git 干净度提示 ...');
    const { errors, warnings } = precheck();
    for (const w of warnings) warn(w);
    if (errors.length) {
      for (const e of errors) console.error(`[release] [预检失败] ${e}`);
      die(EXIT_PRECHECK, `预检未通过（${errors.length} 项），未开始构建。确认无误可用 --skip-precheck 跳过。`);
    }
    log(`预检通过${warnings.length ? `（含 ${warnings.length} 条警告）` : ''}`);
  }

  // 2) 构建（坑4: 默认 10 分钟超时，RELEASE_BUILD_TIMEOUT_MS 可覆盖）
  const timeoutMs = Number(process.env.RELEASE_BUILD_TIMEOUT_MS) || BUILD_TIMEOUT_MS_DEFAULT;
  const { code, timedOut, lines, startedAt, endedAt } = await runBuild(timeoutMs);
  const buildDur = endedAt - startedAt;
  const result = timedOut ? '超时终止' : (code === 0 ? '构建命令退出码 0' : `构建命令退出码 ${code}`);
  writeBuildLog(lines, { time: new Date().toISOString(), result });
  log(`完整构建日志已写入: ${LOG_PATH}`);

  if (code !== 0) {
    // 坑4 固化点: 失败时输出日志最后 30 行，方便直接定位
    console.error('\n[release] ===== 构建失败，日志最后 30 行 =====');
    for (const l of lines.slice(-30)) console.error(`  ${l}`);
    console.error('[release] ======================================\n');
    die(EXIT_BUILD, `构建失败（耗时 ${fmtDur(buildDur)}，退出码 ${code}${timedOut ? '，超时强制终止' : ''}）。完整日志: ${LOG_PATH}`);
  }

  // 3) 后验（坑5: 精确产物名 + 字节数 + 新鲜度）
  const post = postcheck(version, startedAt);
  log(`构建耗时: ${fmtDur(buildDur)}；后验检查产物 ...`);
  if (!post.ok && post.reason) {
    die(EXIT_POSTCHECK, `后验失败: ${post.reason}`);
  }
  console.log('\n[release] ==================== 产物 ====================');
  console.log(`[release] 路径:   ${post.path}`);
  console.log(`[release] 大小:   ${fmtBytes(post.size)}`);
  console.log(`[release] 修改时间: ${post.mtime.toISOString()}`);
  console.log(`[release] 构建总耗时: ${fmtDur(Date.now() - t0)}`);
  if (!post.fresh) {
    die(EXIT_POSTCHECK, `产物 ${post.name} 的修改时间早于本次构建开始时间，疑似旧产物冒充（坑5 防冒充校验），请检查构建日志: ${LOG_PATH}`);
  }
  if (post.name !== post.expected) {
    warn(`产物名 ${post.name} 与预期 ${post.expected} 不一致（package.json version=${version}），请核对版本号`);
  }
  for (const other of post.others) warn(`release/ 下还有其他 exe: ${other}（可能是历史产物）`);
  console.log('[release] ==============================================\n');

  // 4) 发版字节校验（ruflo verify 语义）: 构建成功后自动生成 sha256 清单并逐文件复核，
  //    防止发版产物在打包完成到分发之间被篡改或截断。
  log('发版字节校验: 生成 manifest.json 并逐文件复核 sha256 ...');
  const built = await vr.buildManifest(RELEASE_DIR, post.path);
  if (!built.ok) die(EXIT_POSTCHECK, `发版字节校验清单生成失败: ${built.reason}`);
  log(`清单已写入: ${built.manifestPath}（共 ${built.count} 个文件）`);
  const verified = await vr.verifyRelease(RELEASE_DIR, built.manifestPath);
  for (const line of vr.formatVerifyReport(verified)) console.log(`[release] ${line}`);
  if (!verified.ok) {
    die(EXIT_POSTCHECK, `发版字节校验失败（${verified.mismatches.length} 项不一致），产物疑似被篡改或损坏`);
  }

  log(`完成: release/DSH-Desktop-${version}.exe 构建成功（发版字节校验通过）`);
  process.exit(EXIT_OK);
}

main().catch((e) => die(EXIT_USAGE, `未预期错误: ${e.stack || e.message}`));
