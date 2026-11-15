/* 只读诊断：解密真实 userData 的 profiles.bin，核对每个档案的 key 是否被对应网关接受。
   不建窗口、不写文件，仅 setPath(userData) 以便 app-bound 解密。
   用法：node_modules/electron/dist/electron.exe tools/tmp-key-diag.js */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const http = require('http');

const UD = 'C:/Users/Administrator/AppData/Roaming/dsh-desktop';
app.setPath('userData', UD);

function post(port, key, model) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: model || 'x',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      max_tokens: 8,
    });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: 'Bearer ' + key,
        },
        timeout: 15000,
      },
      (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => resolve({ status: res.statusCode, body: s.slice(0, 220).replace(/\s+/g, ' ') }));
      }
    );
    req.on('error', (e) => resolve({ status: 'ERR', body: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'TIMEOUT', body: '' });
    });
    req.end(body);
  });
}

app.whenReady().then(async () => {
  const out = { userData: app.getPath('userData'), enc: null, profiles: [], tests: [], error: '' };
  try {
    out.enc = await safeStorage.isAsyncEncryptionAvailable();
    const buf = fs.readFileSync(UD + '/secrets/profiles.bin');
    const { result } = await safeStorage.decryptStringAsync(buf);
    const vault = JSON.parse(result);
    out.active = vault.active || '';
    for (const p of vault.profiles || []) {
      const k = String(p.key || '');
      out.profiles.push({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
        keyLen: k.length,
        tail: k ? k.slice(-6) : '',
        ws: /\s/.test(k),
      });
    }
    for (const p of vault.profiles || []) {
      const k = String(p.key || '');
      const m = String(p.baseUrl || '').match(/127\.0\.0\.1:(\d+)/);
      if (!k || !m) continue;
      out.tests.push({ id: p.id, port: Number(m[1]), model: p.model, ...(await post(Number(m[1]), k, p.model)) });
    }
  } catch (e) {
    out.error = String((e && e.stack) || e).slice(0, 400);
  }
  console.log('[diag] ' + JSON.stringify(out, null, 1));
  app.exit(0);
});
