'use strict';
// 把截图局部放大：electron tools/zoom.js <src> <x> <y> <w> <h> <scale> <out>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [src, xs, ys, ws, hs, scaleS, out] = process.argv.slice(2);
const x = +xs, y = +ys, w = +ws, h = +hs, scale = +scaleS;
const SRC = path.resolve(process.cwd(), src);
const OUT = path.resolve(process.cwd(), out);

app.whenReady().then(async () => {
  const b64 = fs.readFileSync(SRC).toString('base64');
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL('data:text/html,<canvas id="c"></canvas>');
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${b64}';
    await img.decode();
    const c = document.getElementById('c');
    c.width = ${w * scale}; c.height = ${h * scale};
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, ${x}, ${y}, ${w}, ${h}, 0, 0, ${w * scale}, ${h * scale});
    return c.toDataURL('image/png');
  })()`);
  fs.writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('written', OUT);
  app.quit();
});
