'use strict';
// 把精灵图裁成单帧：electron tools/crop.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'assets', 'deepy-happy.png');
const OUT = path.join(__dirname, '..', 'assets', 'whale-happy.png');
const FRAME = 225; // 3380x900 → 15 × 4 帧

app.whenReady().then(async () => {
  const b64 = fs.readFileSync(SRC).toString('base64');
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  await win.loadURL('data:text/html,<canvas id="c"></canvas>');

  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${b64}';
    await img.decode();

    // 先只画第一帧，再按 alpha 求包围盒，裁掉四周空白
    const f = document.createElement('canvas');
    f.width = ${FRAME}; f.height = ${FRAME};
    const fg = f.getContext('2d');
    fg.drawImage(img, 0, 0, ${FRAME}, ${FRAME}, 0, 0, ${FRAME}, ${FRAME});

    const { data } = fg.getImageData(0, 0, ${FRAME}, ${FRAME});
    let minX = ${FRAME}, minY = ${FRAME}, maxX = 0, maxY = 0;
    for (let y = 0; y < ${FRAME}; y++) {
      for (let x = 0; x < ${FRAME}; x++) {
        if (data[(y * ${FRAME} + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    const pad = 8;
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const side = Math.max(w, h) + pad * 2;

    const c = document.getElementById('c');
    c.width = side; c.height = side;
    const g = c.getContext('2d');
    g.drawImage(f, minX, minY, w, h, (side - w) / 2, (side - h) / 2, w, h);
    return c.toDataURL('image/png');
  })()`);

  fs.writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('written', OUT);
  app.quit();
});
