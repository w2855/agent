/* 无依赖 PNG 采样：解 zlib + 反滤波，输出指定区域的均色。
   用法：node tools/png-sample.js shot.png 330,220 990,220 ...
   输出每点 9x9 邻域均色（hex + rgb），并给出两点间色差。 */
'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8, ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('缺 IHDR');
  if (ihdr.depth !== 8) throw new Error('只支持 8bit，实际 ' + ihdr.depth);
  if (ihdr.interlace) throw new Error('不支持隔行');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error('不支持的颜色类型 ' + ihdr.color);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width: w, height: h } = ihdr;
  const stride = w * channels;
  const out = Buffer.alloc(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width: w, height: h, channels, data: out };
}

function avg(img, cx, cy, r = 4) {
  const { width: w, height: h, channels, data } = img;
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const i = (y * w + x) * channels;
      R += data[i]; G += data[i + 1]; B += data[i + 2]; n++;
    }
  }
  return [Math.round(R / n), Math.round(G / n), Math.round(B / n)];
}

const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
const dist = (p, q) => Math.round(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));

const file = process.argv[2];
const pts = process.argv.slice(3).map((s) => {
  const [x, y, label] = s.split(':');
  return { x: Number(x), y: Number(y), label: label || `${x},${y}` };
});
const img = decodePng(fs.readFileSync(file));
console.log(`size=${img.width}x${img.height} channels=${img.channels}`);
const res = pts.map((p) => ({ ...p, rgb: avg(img, p.x, p.y) }));
res.forEach((p) => console.log(`${p.label.padEnd(14)} (${p.x},${p.y})  ${hex(p.rgb)}  rgb(${p.rgb.join(',')})`));
if (res.length > 1) {
  console.log('--- 两两色差 ---');
  for (let i = 0; i < res.length; i++) {
    for (let j = i + 1; j < res.length; j++) {
      console.log(`${res[i].label} ↔ ${res[j].label}: ΔRGB=${dist(res[i].rgb, res[j].rgb)}`);
    }
  }
}
