'use strict';

/* 验证文件级撤销快照（lib/file-snapshots.js）与 write_file 接线（lib/tools.js）
   及 runtime 门面（runtime/undo.js）：快照创建/元数据/60s 防抖/列表新→旧/
   环形裁剪/restore 回写与安全预检（changed-since-snapshot）/null 快照与
   恢复创建/损坏 index 行与损坏快照体跳过/原子写失败不留半截/未注入 store
   时 write_file 向后兼容。运行：node tools/undo-check.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const snaps = require('../lib/file-snapshots');
const tools = require('../lib/tools');
const undo = require('../runtime/undo');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });

const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const sha = (s) => snaps.sha256(Buffer.from(s, 'utf8'));

/* 临时根目录：realpath 归一（Windows 下 mkdtemp 可能给 8.3 短名，
   必须与 realish 解析结果一致，路径键才能对上） */
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-undo-')));

(async () => {
  /* ── 1. 快照创建与元数据 ───────────────────────── */
  const d1 = path.join(root, 's1');
  const store1 = snaps.createSnapshotStore(d1);
  const f1 = path.join(root, 'a.txt');
  fs.writeFileSync(f1, 'hello 世界', 'utf8');
  const r1 = await store1.snapshot(f1);
  const m1 = r1.snapshot;
  add('snapshot 返回 ok 且未跳过', r1.ok === true && r1.skipped === false, JSON.stringify(r1));
  add('快照 id 是 26 位 Crockford Base32（ULID）', ULID_RE.test(m1.id), m1.id);
  add('快照体内容与源文件一致', fs.readFileSync(path.join(d1, m1.id, m1.base), 'utf8') === 'hello 世界', 'body equal');
  add('元数据：file 为绝对路径且 base 正确', m1.file === f1 && m1.base === 'a.txt', `${m1.file}|${m1.base}`);
  add('元数据：size/sha/existed/time 正确', m1.size === Buffer.byteLength('hello 世界', 'utf8')
    && m1.sha === sha('hello 世界') && m1.existed === true && m1.time === new Date(m1.ts).toISOString(),
  JSON.stringify({ size: m1.size, sha: m1.sha, time: m1.time }));
  const indexLine = fs.readFileSync(path.join(d1, 'index.jsonl'), 'utf8').trim().split('\n');
  add('index.jsonl 追加一行合法元数据', indexLine.length === 1 && JSON.parse(indexLine[0]).id === m1.id, `lines=${indexLine.length}`);
  const rec0 = JSON.parse(indexLine[0]);
  add('元数据行含 路径/时间/大小/sha256 字段', typeof rec0.file === 'string' && typeof rec0.time === 'string'
    && Number.isFinite(rec0.size) && typeof rec0.sha === 'string', Object.keys(rec0).join(','));

  /* ── 2. 60s 防抖（注入时钟） ───────────────────── */
  let clock = 1_700_000_000_000;
  const d2 = path.join(root, 's2');
  const store2 = snaps.createSnapshotStore(d2, { now: () => clock });
  const f2 = path.join(root, 'b.txt');
  fs.writeFileSync(f2, 'A', 'utf8');
  const t1 = await store2.snapshot(f2);
  clock += 30_000;
  const t2 = await store2.snapshot(f2);
  clock += 29_000; /* 累计 59s，仍在窗口内 */
  const t3 = await store2.snapshot(f2);
  clock += 2_000; /* 累计 61s，出窗 */
  const t4 = await store2.snapshot(f2);
  add('窗口内同内容重复快照跳过（30s）', t2.ok && t2.skipped === true && t2.reason === 'debounced' && t2.snapshot.id === t1.snapshot.id, JSON.stringify(t2));
  add('窗口内同内容重复快照跳过（59s）', t3.skipped === true, JSON.stringify(t3));
  add('出窗后（61s）正常新快照', t4.ok && t4.skipped === false && t4.snapshot.id !== t1.snapshot.id, JSON.stringify(t4));
  clock += 10_000;
  fs.writeFileSync(f2, 'B', 'utf8');
  const t5 = await store2.snapshot(f2);
  add('60s 内内容变化仍捕获（变化不是「重复」）', t5.ok && t5.skipped === false && t5.snapshot.sha === sha('B'), JSON.stringify(t5));

  /* ── 3. 列表新→旧 + 跨文件隔离 ─────────────────── */
  const listB = await store2.listSnapshots(f2);
  add('列表按新→旧排序', listB.length === 3 && listB[0].id === t5.snapshot.id && listB[1].id === t4.snapshot.id && listB[2].id === t1.snapshot.id,
    listB.map((r) => r.id).join(','));
  const listOther = await store2.listSnapshots(path.join(root, 'not-this.txt'));
  add('列表按文件过滤（其他文件为空）', listOther.length === 0, `len=${listOther.length}`);

  /* ── 4. 环形裁剪（maxPerFile=3） ───────────────── */
  const d4 = path.join(root, 's4');
  const store4 = snaps.createSnapshotStore(d4, { maxPerFile: 3 });
  const f4 = path.join(root, 'c.txt');
  const ids4 = [];
  for (const v of ['v1', 'v2', 'v3', 'v4']) {
    fs.writeFileSync(f4, v, 'utf8');
    const r = await store4.snapshot(f4);
    ids4.push(r.snapshot.id);
  }
  const list4 = await store4.listSnapshots(f4);
  add('超过上限后列表只剩 maxPerFile 条', list4.length === 3, `len=${list4.length}`);
  add('裁剪保留的是最新 3 份', list4[0].id === ids4[3] && list4[2].id === ids4[1], list4.map((r) => r.id).join(','));
  add('最旧快照目录已被删除', !fs.existsSync(path.join(d4, ids4[0])), ids4[0]);

  /* ── 5. restore 正常回写 + 连续多步撤销 ────────── */
  const d5 = path.join(root, 's5');
  const store5 = snaps.createSnapshotStore(d5);
  const f5 = path.join(root, 'd.txt');
  fs.writeFileSync(f5, 'C0', 'utf8');
  const s1 = await store5.snapshot(f5);
  fs.writeFileSync(f5, 'C1', 'utf8');
  const s2 = await store5.snapshot(f5);
  fs.writeFileSync(f5, 'C2', 'utf8');
  const s3 = await store5.snapshot(f5);
  const u1 = await store5.restore(f5, s2.snapshot.id);
  add('restore 回写到检查点内容且返回 restoredSha', u1.ok === true && u1.restoredSha === sha('C1')
    && fs.readFileSync(f5, 'utf8') === 'C1' && u1.id === s2.snapshot.id, JSON.stringify(u1));
  const u2 = await store5.restore(f5, s1.snapshot.id);
  add('连续第二步撤销不被预检误拒（恢复后补拍维持不变量）', u2.ok === true && fs.readFileSync(f5, 'utf8') === 'C0', JSON.stringify(u2));

  /* ── 6. 外部篡改后拒绝恢复 ─────────────────────── */
  const d6 = path.join(root, 's6');
  const store6 = snaps.createSnapshotStore(d6);
  const f6 = path.join(root, 'e.txt');
  fs.writeFileSync(f6, 'C0', 'utf8');
  await store6.snapshot(f6);
  fs.writeFileSync(f6, 'C1', 'utf8');
  const s6b = await store6.snapshot(f6);
  fs.writeFileSync(f6, 'CX', 'utf8'); /* 外部改动 */
  const u3 = await store6.restore(f6, s6b.snapshot.id);
  add('篡改后返回 changed-since-snapshot 且带 currentSha', u3.ok === false && u3.reason === 'changed-since-snapshot'
    && u3.currentSha === sha('CX') && u3.expectedSha === sha('C1'), JSON.stringify(u3));
  add('拒绝恢复时不盲目覆盖（文件内容未被改动）', fs.readFileSync(f6, 'utf8') === 'CX', 'content intact');
  const u3b = await store6.restore(f6, '01AAAAAAAAAAAAAAAAAAAAAAAA');
  add('未知 snapshotId 返回 not-found', u3b.ok === false && u3b.reason === 'not-found', JSON.stringify(u3b));

  /* ── 7. 文件不存在：null 快照 + 恢复可创建/可删除 ─ */
  const d7 = path.join(root, 's7');
  const store7 = snaps.createSnapshotStore(d7);
  const f7 = path.join(root, 'f.txt');
  const n1 = await store7.snapshot(f7);
  add('文件不存在时快照记 null（existed/sha/size）', n1.ok && n1.snapshot.existed === false
    && n1.snapshot.sha === null && n1.snapshot.size === 0, JSON.stringify(n1.snapshot));
  add('null 快照无体文件', !fs.existsSync(path.join(d7, n1.snapshot.id, n1.snapshot.base)), 'no body');
  fs.writeFileSync(f7, 'C0', 'utf8');
  const c1 = await store7.snapshot(f7);
  fs.unlinkSync(f7); /* 外部删除 */
  const n2 = await store7.snapshot(f7);
  const u4 = await store7.restore(f7, c1.snapshot.id);
  add('删除后恢复旧内容快照可重建文件（restore 可创建）', u4.ok === true && fs.existsSync(f7)
    && fs.readFileSync(f7, 'utf8') === 'C0' && u4.restoredSha === sha('C0'), JSON.stringify(u4));
  const u5 = await store7.restore(f7, n2.snapshot.id);
  add('恢复到 null 快照 = 撤销创建（文件被删除，removed）', u5.ok === true && u5.removed === true
    && u5.restoredSha === null && !fs.existsSync(f7), JSON.stringify(u5));

  /* ── 8. 损坏 index 行 / 损坏快照体跳过 ─────────── */
  const list7a = (await store7.listSnapshots(f7)).map((r) => r.id);
  fs.appendFileSync(path.join(d7, 'index.jsonl'), 'not-json{{{\n{"id": "trunc\n', 'utf8');
  const list7b = await store7.listSnapshots(f7);
  add('index.jsonl 损坏行跳过不抛错且列表不变', list7b.map((r) => r.id).join(',') === list7a.join(','), `len=${list7b.length}`);
  const n3 = await store7.snapshot(f7);
  add('损坏行之后快照仍可用', n3.ok === true, JSON.stringify({ ok: n3.ok, skipped: n3.skipped }));
  const victim = list7b.find((r) => r.existed);
  fs.writeFileSync(path.join(d7, victim.id, victim.base), 'garbage', 'utf8');
  const list7c = await store7.listSnapshots(f7);
  add('快照体哈希不符时列表跳过该条', list7c.length === list7b.length - 1 && !list7c.some((r) => r.id === victim.id), `len=${list7c.length}`);
  fs.writeFileSync(f7, 'C0', 'utf8'); /* 补拍当前态：让预检通过，只考快照体损坏分支 */
  await store7.snapshot(f7);
  const u6 = await store7.restore(f7, victim.id);
  add('restore 损坏快照拒绝（snapshot-corrupted）且内容未动', u6.ok === false && u6.reason === 'snapshot-corrupted'
    && fs.readFileSync(f7, 'utf8') === 'C0', JSON.stringify(u6));

  /* ── 9. 原子写失败不留半截（只读目标 → rename 失败） ─ */
  const d9 = path.join(root, 's9');
  const store9 = snaps.createSnapshotStore(d9);
  const f9 = path.join(root, 'g.txt');
  fs.writeFileSync(f9, 'K1', 'utf8');
  const a1 = await store9.snapshot(f9);
  fs.writeFileSync(f9, 'K2', 'utf8');
  await store9.snapshot(f9);
  fs.chmodSync(f9, 0o444); /* 只读：Windows 下 rename 替换会失败 */
  const u7 = await store9.restore(f9, a1.snapshot.id);
  const tmpLeft = fs.readdirSync(root).filter((n) => n.endsWith('.tmp'));
  add('写回失败返回 restore-failed', u7.ok === false && u7.reason === 'restore-failed', JSON.stringify(u7));
  add('失败不留半截：原内容未变且无 tmp 残留', fs.readFileSync(f9, 'utf8') === 'K2' && tmpLeft.length === 0, `tmp=${tmpLeft.length}`);
  fs.chmodSync(f9, 0o644);

  /* ── 10. 空文件 / 相对路径 / 空参数 ─────────────── */
  const d10 = path.join(root, 's10');
  const store10 = snaps.createSnapshotStore(d10);
  const f10 = path.join(root, 'empty.txt');
  fs.writeFileSync(f10, '', 'utf8');
  const e1 = await store10.snapshot(f10);
  add('空文件快照：size=0、sha 为空串哈希', e1.ok && e1.snapshot.size === 0 && e1.snapshot.sha === sha(''), e1.snapshot.sha);
  const prevCwd = process.cwd();
  try {
    process.chdir(root);
    fs.writeFileSync('rel.txt', 'R', 'utf8');
    const e2 = await store10.snapshot('rel.txt');
    add('相对路径快照按绝对路径入账', e2.ok && e2.snapshot.file === path.join(root, 'rel.txt'), e2.snapshot?.file);
  } finally {
    process.chdir(prevCwd);
  }
  const e3 = await store10.snapshot('');
  add('空路径返回 ok:false 不抛错', e3.ok === false && typeof e3.error === 'string', JSON.stringify(e3));
  const storeLazy = snaps.createSnapshotStore(path.join(root, 's-lazy'));
  const e4 = await storeLazy.snapshot(f10);
  add('快照目录不存在时首次快照自动创建', e4.ok === true && fs.existsSync(path.join(root, 's-lazy', 'index.jsonl')), 'auto mkdir');

  /* ── 11. tools.js 接线：未注入 store 向后兼容 ──── */
  tools.setSnapshotStore(null);
  const w1 = await tools.executeTool('write_file', { path: 'w1.txt', content: 'hi' }, { workspace: root, permission: 'full' });
  add('未注入 store 时 write_file 正常工作', w1.ok === true && fs.readFileSync(path.join(root, 'w1.txt'), 'utf8') === 'hi', JSON.stringify(w1.error || w1.content).slice(0, 80));

  /* ── 12. 注入 store 后 write_file 自动产生快照 ─── */
  const storeW = snaps.createSnapshotStore(path.join(root, 's-wiring'));
  tools.setSnapshotStore(storeW);
  const w2abs = path.join(root, 'w2.txt');
  const w2 = await tools.executeTool('write_file', { path: 'w2.txt', content: 'v1' }, { workspace: root, permission: 'full' });
  const lw2a = await storeW.listSnapshots(w2abs);
  add('注入后 write_file 产生写前+写后两张快照', w2.ok === true && lw2a.length === 2
    && lw2a[0].sha === sha('v1') && lw2a[1].existed === false, `len=${lw2a.length}`);
  const undoCreate = await storeW.restore(w2abs, lw2a[1].id);
  add('经 write_file 接线撤销创建：文件回退到不存在', undoCreate.ok === true && undoCreate.removed === true && !fs.existsSync(w2abs), JSON.stringify(undoCreate));
  await tools.executeTool('write_file', { path: 'w2.txt', content: 'v2' }, { workspace: root, permission: 'full' });
  const lw2b = await storeW.listSnapshots(w2abs);
  add('第二次写入：写前快照被防抖跳过，写后快照入账', lw2b.length === 4 && lw2b[0].sha === sha('v2'), `len=${lw2b.length}`);
  const undoOne = await storeW.restore(w2abs, lw2b[2].id); /* 撤销「v2 这次写入」→ 回到 v1 */
  add('接线撤销写入：内容回到上一版', undoOne.ok === true && fs.readFileSync(w2abs, 'utf8') === 'v1', JSON.stringify(undoOne));

  /* ── 13. 快照失败不阻断写入 ────────────────────── */
  tools.setSnapshotStore({ snapshot: async () => { throw new Error('boom'); } });
  const w3 = await tools.executeTool('write_file', { path: 'w3.txt', content: 'w3-content' }, { workspace: root, permission: 'full' });
  add('注入故意抛错的 store 时 write_file 仍成功', w3.ok === true && fs.readFileSync(path.join(root, 'w3.txt'), 'utf8') === 'w3-content', JSON.stringify(w3.error || w3.content).slice(0, 80));
  tools.setSnapshotStore(null);
  const w4 = await tools.executeTool('write_file', { path: 'w4.txt', content: 'w4' }, { workspace: root, permission: 'full' });
  add('setSnapshotStore(null) 复位后回归 no-op', w4.ok === true && fs.existsSync(path.join(root, 'w4.txt')), 'reset ok');

  /* ── 14. runtime/undo 门面 ─────────────────────── */
  undo.resetFileSnapshots();
  const l0 = await undo.listUndoSnapshots(f1);
  const u0 = await undo.undoFile(f1, 'whatever');
  add('未初始化时 list 返回空、undo 返回 no-store', Array.isArray(l0) && l0.length === 0 && u0.ok === false && u0.reason === 'no-store', JSON.stringify(u0));
  const storeF = undo.initFileSnapshots(path.join(root, 'userdata'));
  add('init 绑定 userData/file-snapshots 且实例共享', storeF.dir === path.join(root, 'userdata', 'file-snapshots')
    && undo.getFileSnapshotStore() === storeF, storeF.dir);
  tools.setSnapshotStore(storeF);
  const u1abs = path.join(root, 'u1.txt');
  await tools.executeTool('write_file', { path: 'u1.txt', content: 'U1' }, { workspace: root, permission: 'full' });
  const lf = await undo.listUndoSnapshots(u1abs);
  add('门面 listUndoSnapshots 能看到 write_file 检查点', lf.length === 2, `len=${lf.length}`);
  const uf = await undo.undoFile(u1abs, lf[lf.length - 1].id);
  add('门面 undoFile 撤销创建成功', uf.ok === true && uf.removed === true && !fs.existsSync(u1abs), JSON.stringify(uf));
  undo.resetFileSnapshots();
  tools.setSnapshotStore(null);

  /* 清理 */
  fs.chmodSync(f9, 0o644); /* 双保险，避免只读文件阻塞 rmSync */
  fs.rmSync(root, { recursive: true, force: true });

  const total = checks.length;
  const passed = checks.filter((c) => c.pass).length;
  const out = { checks, total, passed, failed: total - passed };
  console.log(JSON.stringify(out, null, 2));
  if (out.failed) process.exitCode = 1;
})().catch((err) => {
  console.error('[undo-check] 未捕获错误：', err);
  process.exitCode = 1;
});
