/* shot-web-capture.js — 通用网页截图入口（shot-suite 引擎的 --url 模式承载进程，项目无关）。
   用法：electron tools/shot-web-capture.js --url=<网址> --out=<png 路径> [--wait=毫秒] [--width=N] [--height=N] [--user-data-dir=X]
   流程：加载 URL → 等待 wait 毫秒 → capturePage → 写 PNG → 退出。
   约定：成功时 stdout 打 [web-capture] saved <out>；失败打 [web-capture-error]，退出码 3。 */

'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : dflt;
};

app.whenReady().then(async () => {
  const url = arg('url', '');
  const out = arg('out', '');
  const wait = Number(arg('wait', '1500')) || 1500;
  const width = Number(arg('width', '1280')) || 1280;
  const height = Number(arg('height', '800')) || 800;

  if (!url || !out) {
    console.log('[web-capture-error] 缺少 --url 或 --out 参数');
    app.exit(3);
    return;
  }

  const win = new BrowserWindow({
    width, height,
    show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  // 外部跳转一律交给系统浏览器，截图窗口只停留在本页
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, target) => { if (target !== url) e.preventDefault(); });

  try {
    await win.loadURL(url);
  } catch (err) {
    console.log('[web-capture-error]', err && err.message ? err.message : String(err));
    app.exit(3);
    return;
  }

  await new Promise((r) => setTimeout(r, wait));
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log('[web-capture] saved ' + out);
  app.exit(0);
});
