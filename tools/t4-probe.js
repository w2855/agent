'use strict';

/* T4 探针：起 Electron（--user-data-dir=<项目>/.s-t4 --shot），断言隔离参数仍优先于统一路径。
   断言目标 = main.js 启动日志 `[boot] userData = ...`，该行打印的是 setPath 之后的
   app.getPath('userData')（生效路径本身），因此等价于直接断言 getPath。
   node tools/t4-probe.js 直跑；结束自动清理 .s-t4（照 docs/e2e-guide.md 坑 2 的约定）。 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const ISO_DIR = path.join(ROOT, '.s-t4');

// Windows 下路径大小写与分隔符都归一后再比较
const norm = (p) => path.resolve(String(p)).toLowerCase().replace(/\//g, path.sep);
const expected = norm(ISO_DIR);

const child = spawn('npx', ['electron', '.', `--user-data-dir=${ISO_DIR}`, '--shot'], {
  cwd: ROOT,
  shell: true,
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const killTimer = setTimeout(() => {
  console.log('t4-probe: FAIL — electron 60s 内未退出（超时强杀）');
  child.kill('SIGKILL');
}, 60000);

child.on('close', (code) => {
  clearTimeout(killTimer);
  fs.rmSync(ISO_DIR, { recursive: true, force: true });
  const line = out.split(/\r?\n/).find((l) => l.includes('[boot] userData ='));
  const actual = line ? line.split('[boot] userData =')[1].trim() : null;
  const pass = actual != null && norm(actual) === expected;
  if (pass) {
    console.log('t4-probe: PASS — 隔离参数优先:', actual);
  } else {
    console.log('t4-probe: FAIL');
    console.log('  期望 userData =', ISO_DIR);
    console.log('  实际 boot 行 =', line || '(日志中无 [boot] userData 行)');
    console.log('  electron 退出码 =', code);
    console.log('  --- 原始日志（前后 30 行）---');
    const lines = out.split(/\r?\n/).filter(Boolean);
    console.log(lines.slice(-30).join('\n'));
  }
  process.exit(pass ? 0 : 1);
});
