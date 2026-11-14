'use strict';

/**
 * 发版字节校验自检 —— node tools/verify-check.js
 *
 * 覆盖（26 条断言）:
 *   清单生成字段完整性 / sha256 正确性（预构造样本 "hello" 向量）/ 篡改 1 字节后 verify 失败 /
 *   manifest 缺失提示 / 中文路径 / CLI 退出码与中文报告。
 * 全程在 os.tmpdir() 下的临时目录进行，不碰真实 release/。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vr = require('../lib/verify-release');

const LIB_PATH = path.join(__dirname, '..', 'lib', 'verify-release.js');
/** 预构造样本: sha256("hello") 的已知向量，用于校验哈希实现正确性。 */
const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

let passed = 0;
let failed = 0;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-check-'));

function ok(cond, name) {
  if (cond) { passed++; console.log(`  [通过] ${name}`); }
  else { failed++; console.log(`  [失败] ${name}`); }
}

/** 造一个最小假发版目录: 小 exe（内容 "hello"，命中预构造向量）+ build.log。 */
function makeRelease(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'DSH-Desktop-9.9.9.exe'), Buffer.from('hello', 'utf8'));
  fs.writeFileSync(path.join(dir, 'build.log'), `构建日志样例\n${'x'.repeat(4096)}\n`, 'utf8');
}

async function main() {
  console.log('[verify-check] 1) buildManifest 清单生成');
  const rel = path.join(tmpRoot, 'release');
  makeRelease(rel);

  const exePath = path.join(rel, 'DSH-Desktop-9.9.9.exe');
  const bm = await vr.buildManifest(rel, exePath);
  ok(bm.ok === true, 'buildManifest 返回 ok=true');
  ok(bm.count === 2, `清单收录 exe + build.log 两个文件（实际 ${bm.count}）`);
  const manifestPath = path.join(rel, 'manifest.json');
  ok(fs.existsSync(manifestPath), 'manifest.json 已写入 release 目录');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const exeEntry = manifest.files.find((f) => f.file === 'DSH-Desktop-9.9.9.exe');
  const logEntry = manifest.files.find((f) => f.file === 'build.log');
  ok(!!exeEntry && !!logEntry, '清单含 exe 与 build.log 两条记录');
  ok(!!exeEntry && typeof exeEntry.bytes === 'number' && typeof exeEntry.sha256 === 'string'
    && exeEntry.sha256.length === 64 && typeof exeEntry.mtime === 'string'
    && !Number.isNaN(Date.parse(exeEntry.mtime)),
    '记录字段完整: file/bytes/sha256(64位hex)/mtime(可解析)');
  ok(!!exeEntry && exeEntry.sha256 === HELLO_SHA256, 'sha256 正确性: "hello" 样本命中预构造向量');
  ok(!manifest.files.some((f) => f.file === 'manifest.json'), 'manifest.json 自身不进清单');
  ok(!!logEntry && logEntry.bytes === fs.statSync(path.join(rel, 'build.log')).size,
    'build.log 字节数与实际一致');
  ok(!!exeEntry && exeEntry.primary === true, '主产物 exe 标记 primary:true');
  ok(!fs.readdirSync(rel).some((f) => f.includes('.tmp-')), '原子写无残留临时文件');

  console.log('[verify-check] 2) verifyRelease 正向校验');
  const good = await vr.verifyRelease(rel);
  ok(good.ok === true, '未篡改目录 verify ok=true');
  ok(Array.isArray(good.checked) && good.checked.length === 2
    && good.checked.every((c) => c.pass === true), 'checked 逐文件 pass=true');

  console.log('[verify-check] 3) 篡改 1 字节后必须失败');
  const relTamper = path.join(tmpRoot, 'release-tampered');
  fs.cpSync(rel, relTamper, { recursive: true }); // 连清单一起复制
  const tamperExe = path.join(relTamper, 'DSH-Desktop-9.9.9.exe');
  const buf = fs.readFileSync(tamperExe);
  buf[0] ^= 0x01; // 翻转 1 个字节
  fs.writeFileSync(tamperExe, buf);
  const bad = await vr.verifyRelease(relTamper);
  ok(bad.ok === false, '篡改 1 字节后 verify ok=false');
  ok(bad.mismatches.length === 1 && bad.mismatches[0].file === 'DSH-Desktop-9.9.9.exe',
    'mismatches 精确指向被篡改文件');
  const tamperChecked = bad.checked.find((c) => c.file === 'DSH-Desktop-9.9.9.exe');
  ok(!!tamperChecked && tamperChecked.pass === false, 'checked 中被篡改文件 pass=false');
  ok(bad.checked.some((c) => c.file === 'build.log' && c.pass === true), '未篡改的 build.log 仍 pass=true');

  console.log('[verify-check] 4) manifest 缺失提示');
  const relNoManifest = path.join(tmpRoot, 'release-nomanifest');
  makeRelease(relNoManifest);
  const noM = await vr.verifyRelease(relNoManifest);
  ok(noM.ok === false && noM.missingManifest === true, '清单缺失 ok=false 且 missingManifest=true');
  ok(typeof noM.hint === 'string' && noM.hint.includes('buildManifest'), 'hint 提示先运行 buildManifest');

  console.log('[verify-check] 5) verifyExe 单文件快速校验');
  const exeGood = await vr.verifyExe(exePath);
  ok(exeGood.ok === true && exeGood.manifestMatched === true && exeGood.sha256 === HELLO_SHA256,
    'verifyExe 命中清单记录且 sha256 一致（pass=true）');
  const exeBad = await vr.verifyExe(tamperExe);
  ok(exeBad.ok === false && exeBad.manifestMatched === true && exeBad.pass === false,
    'verifyExe 对篡改文件 pass=false');

  console.log('[verify-check] 6) 中文路径');
  const relCn = path.join(tmpRoot, '发版目录-中文测试');
  makeRelease(relCn);
  const bmCn = await vr.buildManifest(relCn, path.join(relCn, 'DSH-Desktop-9.9.9.exe'));
  const vfCn = await vr.verifyRelease(relCn);
  ok(bmCn.ok === true && vfCn.ok === true, '中文目录 buildManifest + verify 全通过');

  console.log('[verify-check] 7) CLI（node lib/verify-release.js verify）');
  const cliGood = spawnSync(process.execPath, [LIB_PATH, 'verify', rel], { encoding: 'utf8' });
  ok(cliGood.status === 0, `CLI verify 正常目录退出码 0（实际 ${cliGood.status}）`);
  ok((cliGood.stdout || '').includes('安装字节与清单一致'), 'CLI 报告含「安装字节与清单一致」');
  const cliBad = spawnSync(process.execPath, [LIB_PATH, 'verify', relTamper], { encoding: 'utf8' });
  ok(cliBad.status !== 0, `CLI verify 篡改目录退出码非 0（实际 ${cliBad.status}）`);
  ok((cliBad.stdout || '').includes('不一致'), 'CLI 失败报告含不一致说明');
  const cliMissing = spawnSync(process.execPath, [LIB_PATH, 'verify', relNoManifest], { encoding: 'utf8' });
  ok(cliMissing.status !== 0 && (cliMissing.stdout || '').includes('buildManifest'),
    'CLI 清单缺失时非 0 退出并提示 buildManifest');

  console.log(`[verify-check] 结果: ${passed} 通过 / ${failed} 失败`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`[verify-check] [错误] ${e.stack || e.message}`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清理失败不影响报错 */ }
  process.exit(1);
});
