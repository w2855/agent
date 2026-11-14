'use strict';

/* ─────────────────────────────────────────────
   x1 探针：PII 脱敏出口与经验库 IPC 的真实通道验证。

   双模式（同一文件）：
   1) node tools/x1-probe.js —— runner：拉起
      electron . --shot --script=tools/x1-probe.js --user-data-dir=E:\dsh-desktop\.s-x1
      （隔离 userData，不碰真实数据），解析 [script] JSON 后在 node 侧做
      existsSync / 内容残留断言，打印 PASS/FAIL。
   2) 渲染进程模式（--script 注入，window.dsh 存在）——经真实 IPC 往返：
      notify:show BLOCK / REDACT 两档、export:session 真实落盘到
      .s-x1/probe-out（显式 targetPath 跳过对话框）、lessons:summary/tail，
      返回结果 JSON 给 runner。

   手动验证清单（探针无法自动化，交互式对话框）：
   - 界面里点「导出会话」走系统保存对话框：确认另存后文件已脱敏、
     渲染层 toast 显示「已自动脱敏 N 处」。
   ───────────────────────────────────────────── */

const SK = 'sk-abcdef123456789012345'; // 21 位主体的假密钥（strict 档必 BLOCK / standard 档必替换）

if (typeof window !== 'undefined' && window.dsh) {
  /* ═══════ 渲染进程模式：真实 IPC 往返 ═══════ */
  (async () => {
    const out = { t0: Date.now() };
    // 项目根：file:///E:/dsh-desktop/renderer/index.html → '/E:/dsh-desktop' → 去掉 POSIX 前导斜杠 → 'E:/dsh-desktop'
    let root = decodeURIComponent(location.pathname).replace(/\/renderer\/index\.html$/, '');
    if (/^\/[A-Za-z]:\//.test(root)) root = root.slice(1);
    const exportPath = root + '/.s-x1/probe-out/probe-export-' + out.t0 + '.md';

    // ① BLOCK 场景：正文含密钥 → 通知不发、返回 blocked:true；紧接着再发一条 IPC
    //    验证主进程未崩溃（不崩溃即往返成功）
    out.block = await window.dsh.notify.show({ title: 'x1 探针', body: '密钥 ' + SK + ' 在正文里' });
    out.alive = await window.dsh.lessons.summary(); // BLOCK 之后仍能响应 → 无崩溃

    // ② REDACT 场景：邮箱类替换后照发（真实 toast 弹出）
    out.redact = await window.dsh.notify.show({ title: 'x1 探针', body: '联系 alice@example.com 查收结果' });

    // ③ export:session 真实落盘（对话框不可自动化 → 显式 targetPath 程序化导出）
    out.export = await window.dsh.export.session({
      format: 'md',
      content: '联系 alice@example.com，密钥 ' + SK,
      targetPath: exportPath,
    });
    out.exportPath = exportPath;

    // ④ 经验库：隔离 .s-x1 为全新 userData → 空库约定返回
    out.summary = await window.dsh.lessons.summary();
    out.tail = await window.dsh.lessons.tail();
    return out;
  })();
} else {
  /* ═══════ node runner 模式 ═══════ */
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');

  const projectRoot = path.resolve(__dirname, '..');
  const userDataDir = path.join(projectRoot, '.s-x1');
  const probeOut = path.join(userDataDir, 'probe-out');
  fs.mkdirSync(probeOut, { recursive: true }); // 导出目标目录先行创建

  const electronBin = require('electron'); // node 下 require('electron') = 可执行文件路径字符串
  const args = [projectRoot, '--shot', '--script=tools/x1-probe.js', '--user-data-dir=' + userDataDir];
  console.log('[x1-probe] 启动 electron:', args.join(' '));

  const child = spawn(electronBin, args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
  child.stderr.on('data', (d) => { stderr += d; });

  const killTimer = setTimeout(() => { console.log('[x1-probe] 超时，杀掉进程'); child.kill(); }, 120000);
  child.on('exit', (code) => {
    clearTimeout(killTimer);
    let results = null;
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith('[script] ')) {
        try { results = JSON.parse(line.slice('[script] '.length)); } catch { /* 非 JSON 行跳过 */ }
      }
    }

    let pass = 0;
    let fail = 0;
    const t = (name, ok, detail = '') => {
      if (ok) { pass++; console.log('PASS  ' + name); }
      else { fail++; console.log('FAIL  ' + name + (detail ? ' | ' + detail : '')); }
    };

    if (!results) {
      t('script.resultReceived', false, '渲染脚本未返回 JSON。stderr 尾部: ' + stderr.slice(-300));
    } else {
      t('script.resultReceived', true);
      t('notify.blockReturnsBlockedTrue', results.block && results.block.blocked === true,
        JSON.stringify(results.block));
      t('notify.blockNoCrashAliveAfter', results.alive !== undefined && typeof results.alive === 'object',
        JSON.stringify(results.alive));
      t('notify.redactSentOk', results.redact && results.redact.ok === true && results.redact.blocked === undefined,
        JSON.stringify(results.redact));
      const ex = results.export || {};
      t('export.okTrue', ex.ok === true, JSON.stringify(ex));
      t('export.redactedCount', typeof ex.redacted === 'number' && ex.redacted >= 2,
        'redacted=' + ex.redacted);
      // 函数化路径 existsSync 断言：导出文件必须真实存在
      const p = results.exportPath;
      t('export.fileExists', typeof p === 'string' && fs.existsSync(p), p || '(无路径)');
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch { /* 读失败按残留断言失败处理 */ }
      t('export.noSkResidue', !!text && !text.includes('sk-abcdef'), text.slice(0, 120));
      t('export.placeholderPresent', text.includes('[REDACTED:api_key]') && text.includes('[REDACTED:email]'));
      t('lessons.emptySummary', results.summary && results.summary.ok === false
        && results.summary.reason === 'empty', JSON.stringify(results.summary));
      t('lessons.emptyTail', results.tail && results.tail.ok === false
        && results.tail.reason === 'empty', JSON.stringify(results.tail));
      // 清理本次探针导出物（保留 .s-x1 目录本身）
      try { if (text) fs.unlinkSync(p); } catch { /* 清理失败不影响判定 */ }
    }

    t('electron.exitClean', code === 0, 'exit code=' + code + (stderr ? ' stderr: ' + stderr.slice(-200) : ''));
    console.log('\n[x1-probe] 结果: ' + pass + ' PASS / ' + fail + ' FAIL');
    console.log('[x1-probe] 手动验证：界面「导出会话」走保存对话框 + toast「已自动脱敏 N 处」（对话框不可自动化）');
    process.exit(fail > 0 ? 1 : 0);
  });
}
