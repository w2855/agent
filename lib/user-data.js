'use strict';

/* ─────────────────────────────────────────────
   userData 路径统一决策（纯逻辑，不依赖 Electron，可 node 直测，见 tools/t4-check.js）

   背景：开发版（npx electron .）userData = %APPDATA%/dsh-desktop；打包版
   （productName "DSH Desktop"）默认 = %APPDATA%/DSH Desktop。两套存储分裂，
   打包版首次启动看不到开发版历史。resolveUserDataDir 把三种决策收敛成一张表：

     1. source='flag'    显式 --user-data-dir=X：测试/e2e 隔离，原样生效（优先级最高）
     2. source='unified' 无隔离参数：统一到 %APPDATA%/dsh-desktop（开发/打包共用一份）
     3. source='legacy'  同上，但检测到旧打包目录带 Local Storage → 主进程只打
                         「可手动迁移」日志，绝不自动复制（leveldb 运行时复制易损坏）

   时序契约：调用方必须在 app.requestSingleInstanceLock() 之前把返回的 dir
   setPath 进去——单实例锁按 userData 隔离，先统一路径再拿锁，两个版本才互斥。
   ───────────────────────────────────────────── */

const path = require('node:path');
const fs = require('node:fs');

/** 统一目录名：开发版默认值，打包版也强制对齐到这里。 */
const UNIFIED_DIR_NAME = 'dsh-desktop';
/** 旧打包版目录名：electron-builder productName "DSH Desktop" 的默认 userData。 */
const LEGACY_DIR_NAME = 'DSH Desktop';
/** 旧打包版「有用户数据」的标志目录（localStorage 持久化在 Local Storage/ 下）。 */
const LEGACY_STORAGE_SUBDIR = 'Local Storage';

const FLAG_PREFIX = '--user-data-dir=';

/**
 * 解析 userData 目录决策。
 * @param {string[]} argv 进程参数（process.argv 或其片段）
 * @param {string} appDataPath app.getPath('appData') 的值（通常为 %APPDATA%）
 * @param {{ existsSync(p: string): boolean }} [fsModule] fs 注入口，供测试使用临时目录
 * @returns {{ dir: string, source: 'flag'|'unified'|'legacy', legacyDir?: string }}
 *   dir 为最终应 setPath 的绝对路径；source 用于主进程日志分支：
 *   flag=测试隔离 / unified=统一路径 / legacy=统一路径+旧数据迁移提示。
 *   legacy 分支绝不回退到旧目录，dir 仍是统一目录。
 */
function resolveUserDataDir(argv, appDataPath, fsModule = fs) {
  // 1) 显式 --user-data-dir= 优先级最高：测试隔离路径原样返回（resolve 成绝对路径）
  const flagArg = Array.isArray(argv)
    ? argv.find((a) => typeof a === 'string' && a.startsWith(FLAG_PREFIX))
    : null;
  if (flagArg) {
    return { dir: path.resolve(flagArg.slice(FLAG_PREFIX.length)), source: 'flag' };
  }

  // 2) 无隔离参数：统一到 %APPDATA%/dsh-desktop（开发版与打包版共用）
  const unifiedDir = path.join(appDataPath, UNIFIED_DIR_NAME);

  // 3) 兼容检查：统一目录还不存在、而旧打包目录带 Local Storage → 提示可手动迁移。
  //    dir 仍指向统一目录；existsSync 抛错（权限等）按「无旧数据」处理，不阻塞启动。
  if (!fsModule.existsSync(unifiedDir)) {
    const legacyDir = path.join(appDataPath, LEGACY_DIR_NAME);
    const legacyStorage = path.join(legacyDir, LEGACY_STORAGE_SUBDIR);
    try {
      if (fsModule.existsSync(legacyStorage)) {
        return { dir: unifiedDir, source: 'legacy', legacyDir };
      }
    } catch { /* 读不到旧目录就当没有 */ }
  }
  return { dir: unifiedDir, source: 'unified' };
}

module.exports = {
  UNIFIED_DIR_NAME,
  LEGACY_DIR_NAME,
  LEGACY_STORAGE_SUBDIR,
  resolveUserDataDir,
};
