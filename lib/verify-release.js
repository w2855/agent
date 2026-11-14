'use strict';

/* ─────────────────────────────────────────────
   发版字节校验（ruflo verify 模式）—— 纯 Node，无 Electron 依赖，可单独跑
   （自检见 tools/verify-check.js）。

   语义: 「安装字节与清单一致」——发版目录里的产物（exe + build.log）逐文件
   重算 sha256，与 manifest.json 记录比对；任何 1 字节差异都会被抓住。

   1. buildManifest(releaseDir, exePath)：扫描 release 目录产物，生成
      {file, bytes, sha256, mtime} 清单并原子写入 release/manifest.json。
   2. verifyRelease(releaseDir, manifestPath?)：读清单 → 逐文件重算 sha256 比对
      → {ok, checked, mismatches}。清单缺失时提示先跑 buildManifest。
   3. verifyExe(exePath)：单文件快速校验（算 sha256；所在目录有清单则顺带比对）。
   4. CLI: node lib/verify-release.js verify <releaseDir>    输出中文校验报告
           node lib/verify-release.js manifest <releaseDir>  只生成清单
   ───────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 清单文件名（固定放在 release 目录下）。 */
const MANIFEST_NAME = 'manifest.json';
/** 清单结构版本，未来字段变更时递增。 */
const MANIFEST_VERSION = 1;

/** 小缓冲的 sha256（hex）。 */
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 流式计算文件 sha256（exe 可达 100MB+，不能整读进内存）。
 * @param {string} filePath
 * @returns {Promise<string>} 64 位 hex 摘要；文件不存在时 reject。
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 参与清单的产物：顶层所有 .exe（大小写不敏感）+ build.log；manifest.json 自身与子目录排除。 */
function isManifestTarget(name, isDir) {
  if (isDir) return false;
  if (name === MANIFEST_NAME) return false;
  return name.toLowerCase().endsWith('.exe') || name === 'build.log';
}

/** 扫描 release 目录，返回参与清单的文件名列表（仅顶层，按名字排序保证清单稳定）。 */
function scanReleaseFiles(releaseDir) {
  if (!fs.existsSync(releaseDir)) return [];
  return fs.readdirSync(releaseDir, { withFileTypes: true })
    .filter((d) => isManifestTarget(d.name, d.isDirectory()))
    .map((d) => d.name)
    .sort();
}

/** 原子写 JSON：先写同目录临时文件再 rename，避免半截清单被并发读到。 */
function atomicWriteJson(targetPath, obj) {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, targetPath);
}

/**
 * 生成发版字节清单并原子写入 release/manifest.json。
 * @param {string} releaseDir release 目录
 * @param {string} [exePath] 主产物 exe 路径（可选；命中扫描结果时该条目标记 primary:true）
 * @returns {Promise<{ok: boolean, reason?: string, manifestPath?: string, count?: number}>}
 */
async function buildManifest(releaseDir, exePath) {
  if (!fs.existsSync(releaseDir)) {
    return { ok: false, reason: `release 目录不存在: ${releaseDir}` };
  }
  const names = scanReleaseFiles(releaseDir);
  if (names.length === 0) {
    return { ok: false, reason: 'release 目录下没有 .exe 或 build.log，请先完成构建' };
  }
  const primaryBase = exePath ? path.basename(exePath) : null;
  const files = [];
  for (const name of names) {
    const abs = path.join(releaseDir, name);
    const st = fs.statSync(abs);
    files.push({
      file: name,
      bytes: st.size,
      sha256: await sha256File(abs),
      mtime: st.mtime.toISOString(),
      ...(name === primaryBase ? { primary: true } : {}),
    });
  }
  const manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    releaseDir: path.basename(releaseDir),
    ...(primaryBase ? { primary: primaryBase } : {}),
    files,
  };
  const manifestPath = path.join(releaseDir, MANIFEST_NAME);
  atomicWriteJson(manifestPath, manifest);
  return { ok: true, manifestPath, count: files.length };
}

/**
 * 逐文件复核 release 目录字节与清单是否一致。
 * @param {string} releaseDir release 目录
 * @param {string} [manifestPath] 清单路径（默认 releaseDir/manifest.json）
 * @returns {Promise<{ok: boolean, manifestPath: string, missingManifest?: boolean, hint?: string,
 *                     reason?: string, checked: Array<{file: string, pass: boolean}>,
 *                     mismatches: Array<{file: string, reason: string, expected?: *, actual?: *}>,
 *                     total?: number}>}
 *   ok=true 表示全部文件 sha256 与清单一致；清单缺失时 ok=false 并带 hint 提示先跑 buildManifest。
 */
async function verifyRelease(releaseDir, manifestPath) {
  const mPath = manifestPath || path.join(releaseDir, MANIFEST_NAME);
  const checked = [];
  const mismatches = [];
  if (!fs.existsSync(mPath)) {
    return {
      ok: false,
      manifestPath: mPath,
      missingManifest: true,
      hint: `清单缺失: ${mPath} 不存在，请先运行 buildManifest(releaseDir) 生成 manifest.json 再校验`,
      checked,
      mismatches,
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  } catch (e) {
    return { ok: false, manifestPath: mPath, reason: `清单解析失败: ${e.message}`, checked, mismatches };
  }
  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  if (entries.length === 0) {
    return {
      ok: false,
      manifestPath: mPath,
      reason: '清单为空（files 缺失或为空数组），请重新执行 buildManifest',
      checked,
      mismatches,
    };
  }
  for (const entry of entries) {
    const name = entry && entry.file;
    const abs = name ? path.join(releaseDir, name) : null;
    if (!abs || !fs.existsSync(abs)) {
      checked.push({ file: String(name), pass: false });
      mismatches.push({ file: String(name), reason: '文件缺失', expected: entry && entry.sha256, actual: null });
      continue;
    }
    const st = fs.statSync(abs);
    if (st.size !== entry.bytes) {
      checked.push({ file: name, pass: false });
      mismatches.push({ file: name, reason: '字节数不一致', expected: entry.bytes, actual: st.size });
      continue;
    }
    const hash = await sha256File(abs);
    if (hash !== entry.sha256) {
      checked.push({ file: name, pass: false });
      mismatches.push({ file: name, reason: 'sha256 不一致（字节被篡改或损坏）', expected: entry.sha256, actual: hash });
    } else {
      checked.push({ file: name, pass: true });
    }
  }
  return { ok: mismatches.length === 0, manifestPath: mPath, checked, mismatches, total: entries.length };
}

/**
 * 单文件快速校验：算 exe 的 sha256/bytes；若所在目录（或指定路径）有清单且记录了该文件，
 * 顺带比对。没有清单时只返回摘要（ok=true 仅表示"已计算"，不承诺与清单一致）。
 * @param {string} exePath
 * @param {string} [manifestPath] 清单路径（默认 exe 所在目录下的 manifest.json）
 * @returns {Promise<{ok: boolean, file: string, bytes?: number, sha256?: string, mtime?: string,
 *                     manifestMatched: boolean, pass?: boolean, reason?: string}>}
 */
async function verifyExe(exePath, manifestPath) {
  if (!exePath || !fs.existsSync(exePath)) {
    return { ok: false, file: exePath, manifestMatched: false, reason: `文件不存在: ${exePath}` };
  }
  const st = fs.statSync(exePath);
  const sha256 = await sha256File(exePath);
  const info = {
    ok: true,
    file: exePath,
    bytes: st.size,
    sha256,
    mtime: st.mtime.toISOString(),
    manifestMatched: false,
  };
  const mPath = manifestPath || path.join(path.dirname(exePath), MANIFEST_NAME);
  if (!fs.existsSync(mPath)) return info;
  try {
    const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    const entry = (Array.isArray(manifest.files) ? manifest.files : [])
      .find((f) => f && f.file === path.basename(exePath));
    if (!entry) return info;
    info.manifestMatched = true;
    info.pass = entry.sha256 === sha256 && entry.bytes === st.size;
    info.ok = info.pass;
    if (!info.pass) info.reason = '与清单记录不一致（sha256 或字节数）';
    return info;
  } catch (e) {
    info.reason = `清单解析失败: ${e.message}`;
    return info;
  }
}

/** 把校验结果渲染成中文报告行（CLI 与 release.js 后验共用，保证口径一致）。 */
function formatVerifyReport(result) {
  const lines = [];
  if (result.missingManifest) {
    lines.push(result.hint);
    lines.push('字节校验失败: 清单缺失');
    return lines;
  }
  if (result.reason && (result.checked || []).length === 0) {
    lines.push(result.reason);
    lines.push('字节校验失败');
    return lines;
  }
  const checked = result.checked || [];
  lines.push(`清单: ${result.manifestPath}`);
  lines.push(`逐文件 sha256 复核（共 ${result.total != null ? result.total : checked.length} 个文件）:`);
  for (const c of checked) {
    lines.push(`  ${c.pass ? '[通过]' : '[失败]'} ${c.file}`);
  }
  for (const m of result.mismatches || []) {
    lines.push(`  不一致: ${m.file} — ${m.reason}` +
      (m.expected != null ? `（清单 ${m.expected} / 实际 ${m.actual}）` : ''));
  }
  lines.push(result.ok
    ? '安装字节与清单一致'
    : `字节校验失败: ${(result.mismatches || []).length} 项不一致`);
  return lines;
}

// ———————————————————————————— CLI ————————————————————————————
async function cliMain(argv) {
  const [cmd, dir] = argv;
  if ((cmd === 'verify' || cmd === 'manifest') && dir) {
    if (cmd === 'manifest') {
      const built = await buildManifest(dir);
      if (!built.ok) {
        console.error(`[verify] [错误] ${built.reason}`);
        process.exit(1);
      }
      console.log(`[verify] 清单已生成: ${built.manifestPath}（共 ${built.count} 个文件）`);
      process.exit(0);
    }
    const result = await verifyRelease(dir);
    for (const line of formatVerifyReport(result)) console.log(`[verify] ${line}`);
    process.exit(result.ok ? 0 : 1);
  }
  console.error('用法: node lib/verify-release.js verify <releaseDir>    逐文件校验字节与清单是否一致');
  console.error('      node lib/verify-release.js manifest <releaseDir>  只生成 manifest.json');
  console.error('语义: 重算 sha256 与清单比对 —— 安装字节与清单一致才允许发版。');
  process.exit(1);
}

if (require.main === module) {
  cliMain(process.argv.slice(2)).catch((e) => {
    console.error(`[verify] [错误] 未预期错误: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = {
  MANIFEST_NAME,
  MANIFEST_VERSION,
  sha256Hex,
  sha256File,
  buildManifest,
  verifyRelease,
  verifyExe,
  formatVerifyReport,
};
