'use strict';

/* T4 检查：resolveUserDataDir 纯函数断言 + main.js 时序静态检查。
   node tools/t4-check.js 直跑，不依赖 Electron。 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { resolveUserDataDir, UNIFIED_DIR_NAME, LEGACY_DIR_NAME } = require('../lib/user-data');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-t4-'));
try {
  const appData = tmpRoot; // 临时目录当作 %APPDATA% 用
  const unified = path.join(appData, UNIFIED_DIR_NAME);
  const legacyDir = path.join(appData, LEGACY_DIR_NAME);

  // 1) 显式 --user-data-dir= 优先级最高：原样返回（相对值也 resolve 成绝对）
  let r = resolveUserDataDir(['node', 'main.js', '--user-data-dir=E:/tmp/iso-x'], appData);
  assert.strictEqual(r.dir, path.resolve('E:/tmp/iso-x'));
  assert.strictEqual(r.source, 'flag');

  // 2) 无参数 → 统一路径 %APPDATA%/dsh-desktop
  r = resolveUserDataDir(['node', 'main.js'], appData);
  assert.strictEqual(r.dir, unified);
  assert.strictEqual(r.source, 'unified');

  // 3) 统一目录不存在 + 旧打包目录带 Local Storage → dir 仍是统一目录，source=legacy（只提示迁移）
  fs.mkdirSync(path.join(legacyDir, 'Local Storage'), { recursive: true });
  r = resolveUserDataDir([], appData);
  assert.strictEqual(r.dir, unified);
  assert.strictEqual(r.source, 'legacy');
  assert.strictEqual(r.legacyDir, legacyDir);

  // 4) 统一目录已存在（哪怕旧目录还在）→ 正常 unified，不再提示
  fs.mkdirSync(unified, { recursive: true });
  r = resolveUserDataDir([], appData);
  assert.strictEqual(r.dir, unified);
  assert.strictEqual(r.source, 'unified');

  // 5) 旧打包目录存在但没有 Local Storage → 不算旧数据（换个干净 appData 验证）
  const appData2 = path.join(tmpRoot, 'appdata2');
  fs.mkdirSync(appData2, { recursive: true });
  fs.mkdirSync(path.join(appData2, LEGACY_DIR_NAME), { recursive: true });
  r = resolveUserDataDir([], appData2);
  assert.strictEqual(r.dir, path.join(appData2, UNIFIED_DIR_NAME));
  assert.strictEqual(r.source, 'unified');

  // 6) main.js 时序静态断言：setPath 决策块必须在 requestSingleInstanceLock 之前，
  //    且 flag 分支（隔离测试逻辑）保留、boot 日志接入。
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const flagIdx = mainSrc.indexOf("userDataDecision.source === 'flag'");
  const setPathIdx = mainSrc.indexOf("app.setPath('userData', userDataDecision.dir)");
  const lockIdx = mainSrc.indexOf('app.requestSingleInstanceLock()');
  assert.ok(lockIdx > 0, 'main.js 缺少 requestSingleInstanceLock');
  assert.ok(flagIdx > 0 && setPathIdx > flagIdx, 'main.js 缺少 --user-data-dir 隔离分支');
  assert.ok(setPathIdx > 0 && setPathIdx < lockIdx, 'main.js: setPath 必须先于 requestSingleInstanceLock');
  assert.ok(mainSrc.includes("require('./lib/user-data')"), 'main.js 未接入 resolveUserDataDir');
  assert.ok(mainSrc.includes("'[boot] userData ='"), 'main.js 缺少 [boot] userData 日志');

  console.log('t4-check: 全部断言通过 (6 组)');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
