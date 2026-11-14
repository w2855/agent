'use strict';

/* ─────────────────────────────────────────────
   文件级撤销快照（Cline checkpoints 语义的单文件简化版）

   目标：write_file 每次写入前后各留一个「检查点」，用户/模型可撤销到
   其中任意一点；restore 带安全预检，绝不盲目覆盖。

   存储布局（目录由调用方传入，约定 userData/file-snapshots）：
     <dir>/<ulid>/<basename>   快照体（文件不存在时只有目录、无体文件）
     <dir>/index.jsonl         元数据行，每行一条 JSON，追加写

   元数据行：{ id, file, base, ts, time, size, sha, existed }
     sha = 快照当时内容的 sha256；文件不存在时 existed=false、sha=null、size=0

   防抖：同一文件 60s 内的「重复快照」跳过——「重复」指内容 sha 未变
   （含文件出现/消失之间的状态变化，即使落在窗口内也捕获，否则撤销点
   缺失）。只按时间窗跳过会让写入后的新状态漏记，restore 预检随之失效。

   restore 安全预检（changed-since-snapshot）：当前文件 sha ≠ 该文件
   「最后一次快照记录的当时 sha」→ 快照之后文件又被外部改过 → 拒绝恢复；
   一致才写回。因此 write_file 必须在写入成功后再补拍一张，把「改后」
   状态记为最新检查点，预检才能在「未被外部改动」时放行撤销。恢复成功
   后同样补拍一张，维持不变量，连续多步撤销才不会被误拒。

   完整性：restore 前重新哈希快照体与记录比对，损坏快照拒绝恢复（返回
   ok:false，不抛错）；写回用 tmp+rename 原子替换，失败不留半截。损坏的
   index 行、缺失或哈希不符的快照体在读取时跳过，不抛错。
   ───────────────────────────────────────────── */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const INDEX_FILE = 'index.jsonl';
const DEBOUNCE_MS_DEFAULT = 60 * 1000;
const MAX_PER_FILE_DEFAULT = 20;

/* Crockford Base32（去掉易混淆的 I L O U），ULID 字母表 */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/* 单调 ULID：48bit 毫秒时间 + 80bit 随机；同毫秒内自增，字典序 = 时间序 */
let ulidLastTs = 0;
let ulidLastRand = 0n;
function ulid(now = Date.now()) {
  const ts = Math.max(0, Math.min(Number(now) || 0, 2 ** 48 - 1));
  const rand = ts === ulidLastTs
    ? (ulidLastRand + 1n) & ((1n << 80n) - 1n)
    : BigInt(`0x${crypto.randomBytes(10).toString('hex')}`);
  ulidLastTs = ts;
  ulidLastRand = rand;

  let t = BigInt(ts);
  let timePart = '';
  for (let i = 0; i < 10; i++) { timePart = B32[Number(t % 32n)] + timePart; t /= 32n; }
  let r = rand;
  let randPart = '';
  for (let i = 0; i < 16; i++) { randPart = B32[Number(r % 32n)] + randPart; r /= 32n; }
  return timePart + randPart;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* Windows 路径大小写不敏感，键统一小写比较；meta 里保留原始大小写 */
function pathKey(abs) {
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/* tmp + rename 原子写；失败时清理 tmp，原文件不动（all-or-nothing） */
async function atomicWrite(abs, buf) {
  const tmp = `${abs}.${ulid()}.tmp`;
  try {
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, abs);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

function isValidRecord(rec) {
  return !!rec && typeof rec === 'object'
    && typeof rec.id === 'string' && rec.id
    && typeof rec.file === 'string' && rec.file
    && typeof rec.base === 'string'
    && Number.isFinite(rec.ts)
    && (rec.sha === null || typeof rec.sha === 'string')
    && typeof rec.existed === 'boolean';
}

/**
 * 创建快照仓库。
 * @param {string} dir 快照根目录（不存在会在首次快照时自动创建）
 * @param {{ now?: () => number, debounceMs?: number, maxPerFile?: number }} opts
 *        now 可注入时钟（测试防抖窗口用）；maxPerFile 单文件保留上限（环形裁剪）
 */
function createSnapshotStore(dir, opts = {}) {
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : DEBOUNCE_MS_DEFAULT;
  const maxPerFile = Number.isInteger(opts.maxPerFile) && opts.maxPerFile > 0
    ? opts.maxPerFile
    : MAX_PER_FILE_DEFAULT;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const indexPath = path.join(dir, INDEX_FILE);

  /* index.jsonl 每次现读：损坏行跳过；也让防抖判断天然覆盖重启/多进程写入 */
  async function readIndex() {
    let text = '';
    try { text = await fsp.readFile(indexPath, 'utf8'); } catch { return []; }
    const records = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s);
        if (isValidRecord(rec)) records.push(rec);
      } catch { /* 损坏行跳过，不抛错 */ }
    }
    return records;
  }

  const byFile = (records, abs) => records.filter((r) => pathKey(r.file) === pathKey(abs));
  /* 新→旧排序：ts 降序，同 ts 按 id 降序（ULID 字典序=时间序） */
  const newestFirst = (a, b) => (b.ts - a.ts) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

  /* 环形裁剪：单文件超过 maxPerFile 时从最旧开始删（快照目录 + index 行）。
     只动最旧记录，最新检查点不受影响，restore 预检不变量保持成立 */
  async function trimFile(abs, records) {
    const mine = byFile(records, abs).sort(newestFirst);
    if (mine.length <= maxPerFile) return;
    const victims = new Set(mine.slice(maxPerFile).map((r) => r.id));
    for (const id of victims) {
      await fsp.rm(path.join(dir, id), { recursive: true, force: true }).catch(() => {});
    }
    const keep = records.filter((r) => !(pathKey(r.file) === pathKey(abs) && victims.has(r.id)));
    try {
      await atomicWrite(indexPath, Buffer.from(keep.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'));
    } catch { /* 裁剪失败留待下次，不影响主流程 */ }
  }

  /**
   * 给一个文件拍快照。文件不存在时记一条 existed=false 的空检查点。
   * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, snapshot?:object, error?:string}>}
   */
  async function snapshot(filePath) {
    try {
      const raw = String(filePath || '').trim();
      if (!raw) return { ok: false, error: '路径不合法' };
      const abs = path.resolve(raw);
      await fsp.mkdir(dir, { recursive: true });

      let st = null;
      try { st = await fsp.stat(abs); } catch { /* 不存在 */ }
      const existed = !!(st && st.isFile());
      let buf = null;
      if (existed) {
        try { buf = await fsp.readFile(abs); } catch (err) {
          return { ok: false, error: `读取失败：${err?.message || err}` };
        }
      }
      const sha = buf ? sha256(buf) : null;
      const ts = now();

      /* 防抖：窗口内同文件且 sha 未变 → 重复快照跳过 */
      const records = await readIndex();
      const mine = byFile(records, abs).sort(newestFirst);
      const last = mine[0];
      if (last && Number.isFinite(last.ts) && ts - last.ts >= 0
        && ts - last.ts < debounceMs && last.sha === sha) {
        return { ok: true, skipped: true, reason: 'debounced', snapshot: last };
      }

      const id = ulid(ts);
      await fsp.mkdir(path.join(dir, id), { recursive: true });
      if (buf) await atomicWrite(path.join(dir, id, path.basename(abs)), buf);
      const rec = {
        id,
        file: abs,
        base: path.basename(abs),
        ts,
        time: new Date(ts).toISOString(),
        size: buf ? buf.length : 0,
        sha,
        existed,
      };
      await fs.promises.appendFile(indexPath, JSON.stringify(rec) + '\n', 'utf8');
      await trimFile(abs, [...records, rec]).catch(() => {});
      return { ok: true, skipped: false, snapshot: rec };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * 某文件的快照列表（新→旧）。
   * 损坏快照（体缺失或哈希与记录不符）跳过，不抛错。
   */
  async function listSnapshots(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return [];
    const abs = path.resolve(raw);
    const records = await readIndex();
    const mine = byFile(records, abs).sort(newestFirst).slice(0, maxPerFile);
    const out = [];
    for (const rec of mine) {
      if (!rec.existed) { out.push(rec); continue; }
      try {
        const body = await fsp.readFile(path.join(dir, rec.id, rec.base));
        if (sha256(body) !== rec.sha) continue; /* 哈希不符 = 损坏 */
        out.push(rec);
      } catch { continue; /* 体缺失 = 损坏 */ }
    }
    return out;
  }

  /**
   * 恢复到指定快照。
   * 预检通过才写回；恢复成功后补拍一张「恢复后」检查点（尽力而为）。
   * @returns {Promise<{ok:boolean, reason?:string, currentSha?:string|null,
   *                     expectedSha?:string|null, restoredSha?:string|null,
   *                     removed?:boolean, id?:string, error?:string}>}
   */
  async function restore(filePath, snapshotId) {
    try {
      const raw = String(filePath || '').trim();
      if (!raw) return { ok: false, reason: 'not-found', error: '路径不合法' };
      const abs = path.resolve(raw);
      const wantId = String(snapshotId || '');

      const records = await readIndex();
      const mine = byFile(records, abs).sort(newestFirst);
      const target = mine.find((r) => r.id === wantId);
      if (!target) return { ok: false, reason: 'not-found', error: `找不到快照：${wantId}` };

      /* 安全预检：与最后一次快照记录的当时 sha 比对（用原始记录，
         即使最新快照体损坏也不影响预检——恢复目标本身会另行校验） */
      const expectedSha = mine[0].sha;
      let st = null;
      try { st = await fsp.stat(abs); } catch { /* 不存在 */ }
      const existedNow = !!(st && st.isFile());
      let currentBuf = null;
      if (existedNow) {
        try { currentBuf = await fsp.readFile(abs); } catch (err) {
          return { ok: false, reason: 'read-failed', error: `读取当前文件失败：${err?.message || err}` };
        }
      }
      const currentSha = currentBuf ? sha256(currentBuf) : null;
      if (currentSha !== expectedSha) {
        return { ok: false, reason: 'changed-since-snapshot', currentSha, expectedSha };
      }

      if (target.existed) {
        /* 先验证快照体完整性，再原子写回：失败不留半截 */
        let body = null;
        try { body = await fsp.readFile(path.join(dir, target.id, target.base)); } catch {
          return { ok: false, reason: 'snapshot-corrupted', error: '快照体缺失或不可读' };
        }
        if (sha256(body) !== target.sha) {
          return { ok: false, reason: 'snapshot-corrupted', error: '快照体哈希不符' };
        }
        try { await atomicWrite(abs, body); } catch (err) {
          return { ok: false, reason: 'restore-failed', error: err?.message || String(err) };
        }
        await snapshot(abs).catch(() => {});
        return { ok: true, id: target.id, restoredSha: target.sha };
      }

      /* 快照当时文件不存在 → 恢复 = 回到「不存在」状态 */
      if (existedNow) {
        try { await fsp.unlink(abs); } catch (err) {
          return { ok: false, reason: 'restore-failed', error: `删除失败：${err?.message || err}` };
        }
      }
      await snapshot(abs).catch(() => {});
      return { ok: true, id: target.id, restoredSha: null, removed: true };
    } catch (err) {
      return { ok: false, reason: 'error', error: err?.message || String(err) };
    }
  }

  return { dir, indexPath, snapshot, listSnapshots, restore, maxPerFile, debounceMs };
}

module.exports = {
  createSnapshotStore,
  ulid,
  sha256,
  INDEX_FILE,
  DEBOUNCE_MS_DEFAULT,
  MAX_PER_FILE_DEFAULT,
};
