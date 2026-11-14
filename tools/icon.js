'use strict';
// 从品牌 tile.svg 生成应用图标：electron tools/icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'assets', 'tile.svg');
const OUT = path.join(__dirname, '..', 'assets', 'icon.png');
const SIZE = 256;

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SRC, 'utf8');
  const b64 = Buffer.from(svg).toString('base64');
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  await win.loadURL('data:text/html,<canvas id="c"></canvas>');

  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,${b64}';
    await img.decode();
    const c = document.getElementById('c');
    c.width = ${SIZE}; c.height = ${SIZE};
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, ${SIZE}, ${SIZE});
    return c.toDataURL('image/png');
  })()`);

  fs.writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('written', OUT);
  app.quit();
});
