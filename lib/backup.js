'use strict';

const fs = require('node:fs');
const path = require('node:path');

/* 经验库轮换备份（参考 ruflo memory-backup 的"时间戳快照 + 保留 N 份"模式）。
   把 lessons.jsonl / runtime.json 这类持久状态源复制到 backupDir/<ISO 时间戳>/，
   备份目录数超过 keep 时按时间戳从最旧开始删。
   Best-effort + 非破坏性：只读源、只写新目录，任何单源失败只记 skipped，
   不中断其他源，也不影响调用方主流程（main.js before-quit 里 try/catch 包裹）。

   WAL 说明（SQLite/WAL 概念）：WAL 模式下已提交但尚未 checkpoint 的数据页
   只存在于主文件旁的 -wal 侧车里，只复制主文件会静默丢掉最近提交。
   本项目部分状态文件同样可能带 -wal/-shm 伴随文件（历史上 tmp-ls.json-wal
   即为一例），因此对每个源都探测 `<源>-wal` / `<源>-shm`，存在就一并快照；
   正常退出时写冲突概率极低，属于尽力而为的一致性快照。 */

/* ISO 时间戳转安全文件名（':' 与 '.' 都不适合做 Windows 文件名，替换为 '-'；
   替换后的名字仍保持字典序 = 时间序，轮换按名字排序即可） */
function fileStamp(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/* 备份目录名必须是纯时间戳形态；轮换只动这类目录，避免误删用户放进去的其他文件 */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/**
 * 轮换备份。
 * @param {string[]} sourcePaths 源文件绝对路径列表（缺文件 / 损坏源跳过并记录）
 * @param {string} backupDir    备份根目录（不存在则自动创建）
 * @param {{keep?: number, stamp?: number|string}} opts keep=保留目录数（默认 7）；
 *        stamp=注入的时间戳（毫秒数或已是安全文件名的字符串），测试用，缺省取当前时刻
 * @returns {{backedUp: Array<{src:string,dst:string}>, skipped: Array<{src:string,reason:string}>, removedOld: string[]}}
 */
function rotateBackup(sourcePaths, backupDir, { keep = 7, stamp } = {}) {
  const result = { backedUp: [], skipped: [], removedOld: [] };
  const sources = Array.isArray(sourcePaths) ? sourcePaths.filter((s) => typeof s === 'string' && s) : [];
  /* keep 非法（0 / 负数 / 非整数）时回退默认 7，与 ruflo 的处理一致 */
  const keepN = Number.isInteger(keep) && keep > 0 ? keep : 7;

  /* 时间戳：测试可注入毫秒数或现成文件名；非法注入回退当前时刻 */
  let ts;
  if (typeof stamp === 'number' && Number.isFinite(stamp)) ts = fileStamp(stamp);
  else if (typeof stamp === 'string' && STAMP_RE.test(stamp)) ts = stamp;
  else ts = fileStamp(Date.now());

  const destDir = path.join(backupDir, ts);
  let dirExisted = false;
  try {
    dirExisted = fs.statSync(destDir).isDirectory();
  } catch { /* 不存在 */ }

  if (dirExisted) {
    /* 同时间戳目录已存在 → 全部跳过（幂等：同一时刻重复触发不覆盖已有快照） */
    for (const src of sources) result.skipped.push({ src, reason: '同时间戳备份目录已存在' });
  } else {
    try {
      fs.mkdirSync(destDir, { recursive: true });
    } catch (err) {
      /* 目录都建不出来（磁盘/权限问题）：记 skipped 后仍尝试轮换，尽力清理旧目录 */
      for (const src of sources) result.skipped.push({ src, reason: `备份目录创建失败：${(err && err.message) || err}` });
    }
    if (fs.existsSync(destDir)) {
      for (const src of sources) {
        let stat = null;
        try { stat = fs.statSync(src); } catch { /* 缺文件 */ }
        if (!stat || !stat.isFile()) {
          result.skipped.push({ src, reason: stat ? '源不是普通文件' : '源不存在' });
          continue;
        }
        /* WAL 伴随：主文件复制前先探测 -wal / -shm（概念说明见文件头注释） */
        const sidecars = [];
        for (const suffix of ['-wal', '-shm']) {
          const side = `${src}${suffix}`;
          try { if (fs.statSync(side).isFile()) sidecars.push(side); } catch { /* 无伴随文件 */ }
        }
        try {
          const dst = path.join(destDir, path.basename(src));
          fs.copyFileSync(src, dst);
          result.backedUp.push({ src, dst });
          /* 伴随文件尽力复制：失败只记 skipped，不影响主文件已成功的快照 */
          for (const side of sidecars) {
            const sideDst = path.join(destDir, path.basename(side));
            try {
              fs.copyFileSync(side, sideDst);
              result.backedUp.push({ src: side, dst: sideDst });
            } catch (err) {
              result.skipped.push({ src: side, reason: `伴随文件复制失败：${(err && err.message) || err}` });
            }
          }
        } catch (err) {
          /* 损坏 / 被锁 / 读取失败的源：跳过并记录，不中断其他源 */
          result.skipped.push({ src, reason: `复制失败：${(err && err.message) || err}` });
        }
      }
    }
  }

  /* 轮换：时间戳目录名字典序 = 时间序，超出 keep 从最旧开始删；
     只认 STAMP_RE 形态的目录，其他名字（用户自放文件）一律不碰。
     backupDir 不可读时放弃轮换（上面连复制都可能没成功，这里不再放大故障）。 */
  try {
    const dirs = fs.readdirSync(backupDir).filter((name) => STAMP_RE.test(name)).sort();
    while (dirs.length > keepN) {
      const oldest = dirs.shift();
      try {
        fs.rmSync(path.join(backupDir, oldest), { recursive: true, force: true });
        result.removedOld.push(oldest);
      } catch { /* 删不掉的旧目录留待下次轮换 */ }
    }
  } catch { /* backupDir 不可读 */ }

  return result;
}

module.exports = { rotateBackup, fileStamp, STAMP_RE };
