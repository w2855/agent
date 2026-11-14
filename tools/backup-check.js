'use strict';

/* 验证经验库轮换备份（lib/backup.js）：keep 轮换删最旧 / WAL 侧车（-wal/-shm）
   伴随复制 / 损坏源跳过不中断 / 同时间戳目录去重 / main.js before-quit 接线冒烟。
   运行：node tools/backup-check.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backup = require('../lib/backup');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-backup-${tag}-`));
}
function stampOf(ms) {
  return backup.fileStamp(ms);
}

(async () => {
  const tmp = tempDir('unit');
  const dataDir = path.join(tmp, 'data');
  const backupDir = path.join(tmp, 'backups');
  fs.mkdirSync(dataDir, { recursive: true });

  /* 1. 基本复制：两个源 → 时间戳目录，内容一致 */
  const lessonsPath = path.join(dataDir, 'lessons.jsonl');
  const runtimeJsonPath = path.join(dataDir, 'runtime.json');
  fs.writeFileSync(lessonsPath, '{"taskId":"task_1","kind":"outcome"}\n{"taskId":"task_2","kind":"lesson"}\n', 'utf8');
  fs.writeFileSync(runtimeJsonPath, '{"lastSeq":42}\n', 'utf8');
  const stampMs = Date.UTC(2026, 0, 15, 8, 30, 12, 345);
  const r1 = backup.rotateBackup([lessonsPath, runtimeJsonPath], backupDir, { keep: 7, stamp: stampMs });
  const stamp1 = stampOf(stampMs);
  const dst1 = path.join(backupDir, stamp1, 'lessons.jsonl');
  const dst2 = path.join(backupDir, stamp1, 'runtime.json');
  add('两个源都备份且 dst 指向时间戳目录', r1.backedUp.length === 2 && r1.backedUp[0].src === lessonsPath && r1.backedUp[0].dst === dst1
    && r1.backedUp.some((b) => b.dst === dst2), JSON.stringify(r1.backedUp.map((b) => path.basename(b.dst))));
  add('备份内容与源一致', fs.readFileSync(dst1, 'utf8') === fs.readFileSync(lessonsPath, 'utf8')
    && fs.readFileSync(dst2, 'utf8') === '{"lastSeq":42}\n', 'content equal');
  add('备份目录名是安全 ISO 时间戳', backup.STAMP_RE.test(stamp1) && !stamp1.includes(':') && !stamp1.includes('.'), stamp1);
  add('返回结构 shape：backedUp/skipped/removedOld 都是数组', Array.isArray(r1.backedUp) && Array.isArray(r1.skipped) && Array.isArray(r1.removedOld), 'arrays');
  add('首次备份无 skipped/removedOld', r1.skipped.length === 0 && r1.removedOld.length === 0, 'clean');

  /* 2. WAL 侧车伴随：-wal / -shm 存在则一并快照 */
  fs.writeFileSync(`${lessonsPath}-wal`, 'WAL-FRAMES', 'utf8');
  fs.writeFileSync(`${lessonsPath}-shm`, 'SHM-INDEX', 'utf8');
  const r2 = backup.rotateBackup([lessonsPath], backupDir, { keep: 7, stamp: stampMs + 1000 });
  const stamp2 = stampOf(stampMs + 1000);
  const walDst = path.join(backupDir, stamp2, 'lessons.jsonl-wal');
  const shmDst = path.join(backupDir, stamp2, 'lessons.jsonl-shm');
  add('-wal/-shm 侧车一并复制', r2.backedUp.some((b) => b.dst === walDst && b.src === `${lessonsPath}-wal`)
    && r2.backedUp.some((b) => b.dst === shmDst), JSON.stringify(r2.backedUp.map((b) => path.basename(b.dst))));
  add('侧车内容一致', fs.readFileSync(walDst, 'utf8') === 'WAL-FRAMES' && fs.readFileSync(shmDst, 'utf8') === 'SHM-INDEX', 'wal content');
  const r2b = backup.rotateBackup([runtimeJsonPath], backupDir, { keep: 7, stamp: stampMs + 2000 });
  add('无侧车文件时只备份主文件', r2b.backedUp.length === 1 && r2b.backedUp[0].dst.endsWith('runtime.json'), JSON.stringify(r2b.backedUp));

  /* 3. 损坏/缺失源：跳过并记录，不中断其他源 */
  const missingPath = path.join(dataDir, 'missing.json');
  const dirAsSrc = path.join(dataDir, 'a-directory');
  fs.mkdirSync(dirAsSrc, { recursive: true });
  const r3 = backup.rotateBackup([missingPath, dirAsSrc, lessonsPath], backupDir, { keep: 7, stamp: stampMs + 3000 });
  add('缺失源跳过并注明原因', r3.skipped.some((s) => s.src === missingPath && /源不存在/.test(s.reason)), JSON.stringify(r3.skipped));
  /* R15/A7：目录源不再跳过，改为整目录递归复制（audit/ 这类快照需要） */
  add('目录源整目录复制', r3.backedUp.some((b) => b.src === dirAsSrc)
    && fs.existsSync(path.join(backupDir, stampOf(stampMs + 3000), 'a-directory')),
    JSON.stringify(r3.backedUp.map((b) => path.basename(b.src))));
  add('同一次调用中缺失源不影响其余源入账', r3.backedUp.length === 4 /* 目录 + 主文件 + -wal/-shm 侧车 */
    && r3.backedUp.every((b) => b.src !== missingPath), JSON.stringify(r3.backedUp.map((b) => path.basename(b.src))));

  /* 4. 同时间戳去重：目录已存在 → 全部跳过（幂等） */
  const r4 = backup.rotateBackup([lessonsPath, runtimeJsonPath], backupDir, { keep: 7, stamp: stampMs });
  add('同时间戳目录已存在 → 全部 skipped', r4.backedUp.length === 0 && r4.skipped.length === 2
    && r4.skipped.every((s) => /同时间戳/.test(s.reason)), JSON.stringify(r4.skipped));
  add('去重后已有快照内容未被覆盖', fs.readFileSync(dst1, 'utf8') === fs.readFileSync(lessonsPath, 'utf8'), 'unchanged');

  /* 5. stamp 注入形态 */
  const r5 = backup.rotateBackup([lessonsPath], backupDir, { keep: 7, stamp: '1970-01-01T00-00-09-000Z' });
  add('stamp 可注入安全文件名字符串', r5.backedUp[0]?.dst.includes('1970-01-01T00-00-09-000Z'), 'string stamp');
  const r5b = backup.rotateBackup([lessonsPath], backupDir, { keep: 7, stamp: '../escape/attack' });
  const r5bMain = r5b.backedUp.find((b) => b.dst.endsWith('lessons.jsonl'));
  add('非法 stamp 注入回落当前时刻', !!r5bMain && backup.STAMP_RE.test(path.basename(path.dirname(r5bMain.dst))), 'fallback now');

  /* 6. keep 轮换：超过 keep 从最旧开始删（时间戳名字典序 = 时间序） */
  const rotDir = path.join(tmp, 'rotate');
  const srcA = path.join(tmp, 'a.jsonl');
  fs.writeFileSync(srcA, 'A', 'utf8');
  for (let i = 1; i <= 4; i++) {
    backup.rotateBackup([srcA], rotDir, { keep: 3, stamp: stampOf(stampMs + i * 1000) });
  }
  const dirsAfter4 = fs.readdirSync(rotDir).filter((n) => backup.STAMP_RE.test(n)).sort();
  add('keep=3 时第 4 次备份删掉最旧目录', dirsAfter4.length === 3 && !dirsAfter4.includes(stampOf(stampMs + 1000)), JSON.stringify(dirsAfter4));
  const rotReceipt = backup.rotateBackup([srcA], rotDir, { keep: 3, stamp: stampOf(stampMs + 5000) });
  add('removedOld 记录被删目录名', rotReceipt.removedOld.length === 1 && rotReceipt.removedOld[0] === stampOf(stampMs + 2000), JSON.stringify(rotReceipt.removedOld));
  add('轮换后保留的正好是最新的 keep 份', fs.readdirSync(rotDir).filter((n) => backup.STAMP_RE.test(n)).sort()
    .join(',') === [3, 4, 5].map((d) => stampOf(stampMs + d * 1000)).join(','), 'newest kept');

  /* 7. keep 边界与非法定义 */
  const edgeDir = path.join(tmp, 'edge');
  for (let i = 1; i <= 3; i++) backup.rotateBackup([srcA], edgeDir, { keep: 3, stamp: stampOf(stampMs + i * 1000) });
  add('正好 keep 份时不删任何目录', fs.readdirSync(edgeDir).filter((n) => backup.STAMP_RE.test(n)).length === 3, 'boundary');
  const invalidDir = path.join(tmp, 'invalid-keep');
  for (let i = 1; i <= 8; i++) backup.rotateBackup([srcA], invalidDir, { keep: 0, stamp: stampOf(stampMs + i * 1000) });
  add('keep 非法（0/负数/非整数）回退默认 7', fs.readdirSync(invalidDir).filter((n) => backup.STAMP_RE.test(n)).length === 7, 'default 7');
  backup.rotateBackup([srcA], invalidDir, { keep: -2, stamp: stampOf(stampMs + 9000) });
  backup.rotateBackup([srcA], invalidDir, { keep: 1.5, stamp: stampOf(stampMs + 10000) });
  add('多次非法 keep 仍按默认 7 轮换', fs.readdirSync(invalidDir).filter((n) => backup.STAMP_RE.test(n)).length === 7, 'still 7');

  /* 8. 轮换只动时间戳目录，不碰用户自放文件 */
  const mixedDir = path.join(tmp, 'mixed');
  fs.mkdirSync(path.join(mixedDir, 'keepme'), { recursive: true });
  fs.writeFileSync(path.join(mixedDir, 'notes.txt'), 'user file', 'utf8');
  for (let i = 1; i <= 5; i++) backup.rotateBackup([srcA], mixedDir, { keep: 2, stamp: stampOf(stampMs + i * 1000) });
  add('非时间戳目录/文件不被轮换删除', fs.existsSync(path.join(mixedDir, 'keepme')) && fs.existsSync(path.join(mixedDir, 'notes.txt')), 'user files kept');

  /* 9. 边界输入 */
  const r9 = backup.rotateBackup([], path.join(tmp, 'empty'), { keep: 7, stamp: stampMs });
  add('空源列表 → 空结果不崩溃', r9.backedUp.length === 0 && r9.skipped.length === 0 && fs.existsSync(path.join(tmp, 'empty', stampOf(stampMs))), 'empty ok');
  const r9b = backup.rotateBackup('not-an-array', path.join(tmp, 'empty2'), { stamp: stampMs });
  add('非数组源 → 空结果不崩溃', r9b.backedUp.length === 0 && r9b.skipped.length === 0, 'non-array ok');
  const r9c = backup.rotateBackup([missingPath], path.join(tmp, 'never-made'), { stamp: stampMs + 999 });
  add('只有坏源时也自动建备份根目录并轮换安全', fs.existsSync(path.join(tmp, 'never-made', stampOf(stampMs + 999))), 'dir created');

  /* 10. main.js before-quit 接线冒烟：一行 try/catch 触发轮换备份 */
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const quitIdx = mainSrc.indexOf("app.on('before-quit'");
  const wiring = quitIdx >= 0 ? mainSrc.slice(quitIdx, quitIdx + 3600) : '';
  add('before-quit 里调用 rotateBackup', /rotateBackup\(/.test(wiring), 'wiring present');
  /* R15/A7：源扩到「用户真正在乎的状态」——会话存储、任务状态、审计链、事件分片 */
  add('接线源含会话存储与任务状态', /dsh-storage\.json/.test(wiring) && /state\.json/.test(wiring), 'sources');
  add('接线源含审计目录与事件分片', /'audit'/.test(wiring) && /events/.test(wiring), 'audit + events');
  add('接线源仍含经验库与运行时水位', /lessons\.jsonl/.test(wiring) && /runtime\.json/.test(wiring), 'legacy sources');
  add('接线目标为 userData/backups 且 keep=7', /['"]backups['"]/.test(wiring) && /keep:\s*7/.test(wiring), 'dest + keep');
  add('接线被 try/catch 包裹（备份失败不阻塞退出）',
    /try\s*\{[\s\S]{0,700}rotateBackup[\s\S]{0,400}catch/.test(wiring) && /备份失败不阻塞退出/.test(wiring), 'try/catch');
  add('提供备份浏览通道（list + open）', /backup:list/.test(mainSrc) && /backup:open/.test(mainSrc), 'ipc');

  /* 清理 */
  fs.rmSync(tmp, { recursive: true, force: true });

  const total = checks.length;
  const passed = checks.filter((c) => c.pass).length;
  const out = { checks, total, passed, failed: total - passed };
  console.log(JSON.stringify(out, null, 2));
  if (out.failed) process.exitCode = 1;
})().catch((err) => {
  console.error('[backup-check] 未捕获错误：', err);
  process.exitCode = 1;
});
