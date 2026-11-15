'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   跑一个 Electron 探针，自动起停 mock 网关（跑完即退，不残留后台进程）。

   用法：
     node tools/with-mock.js --shot --script=tools/narrate-live-probe.js [--user-data-dir=...]
   行为：
     1. 端口 57321 已被占用则复用（不接管、不杀）；
     2. 否则 spawn tools/mock-gateway.js 子进程，就绪后运行探针；
     3. 探针退出后杀掉自己起的那个子进程（Windows 用 taskkill /T 连子孙一起收）。
   探针自身仍按 --shot 输出 `[script] {...}` 行，本脚本原样透传 stdout。
   ───────────────────────────────────────────────────────────────────────────── */

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 57321;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/v1/models', timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function electronBin() {
  try {
    const p = require('electron');
    return typeof p === 'string' ? p : null;
  } catch { return null; }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
  }
}

(async () => {
  const args = process.argv.slice(2);
  const alreadyUp = await ping();
  let gw = null;

  if (!alreadyUp) {
    gw = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-gateway.js')], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true,
    });
    let up = false;
    for (let i = 0; i < 40; i++) {
      if (await ping()) { up = true; break; }
      await sleep(250);
    }
    if (!up) {
      console.error('[with-mock] mock 网关启动失败');
      killTree(gw.pid);
      process.exit(2);
    }
  }

  const bin = electronBin();
  const cmd = bin || 'npx';
  const cmdArgs = bin ? ['.', ...args] : ['electron', '.', ...args];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(cmd, cmdArgs, { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });

  const cleanup = () => { if (gw) killTree(gw.pid); };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  child.on('exit', (code) => {
    cleanup();
    process.exit(code == null ? 1 : code);
  });
})();
