'use strict';

/* 治理与一致性自检（R14）：把「双执行通道 / 取消不落地 / 重启状态漂移 / SSRF / 容量」这些
   靠人眼看不出来的问题变成可执行断言。纯 Node，不需要 Electron。
   运行：node tools/runtime-governance-check.js
   输出最后一行 JSON {passed,failed,total}，供 tools/run-all.js 汇总。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns');

const runtimeModule = require('../runtime');
const { createToolGateway } = require('../lib/tool-gateway');
const { createPersistStore } = require('../lib/persist-store');
const { createAutopilot } = require('../lib/autopilot');
const { buildChildEnv } = require('../lib/safety');
const netSafety = require('../lib/net-safety');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`));

function makeRuntime(root, executeTool) {
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const rt = runtimeModule.createRuntime({
    dir: path.join(root, 'store'),
    workspacePath: ws,
    executeTool: executeTool || (async () => ({ ok: true, content: 'ok', meta: { label: 'ok' } })),
  });
  rt.init();
  return rt;
}

(async () => {
  /* ── 1. 治理内核：策略 / 审批 / 审计 ───────────────────────────── */
  {
    const audits = [];
    let confirmAnswer = true;
    const asked = [];
    const executed = [];
    const localTools = {
      executeTool: async (name, args, opts) => {
        executed.push({ name, opts });
        return { ok: true, content: 'done', meta: { label: 'ok' } };
      },
    };
    const gw = createToolGateway({
      localTools,
      confirm: async (req) => { asked.push(req); return confirmAnswer; },
      auditSink: (r) => audits.push(r),
    });

    const readRun = await gw.execLocal({ name: 'read_file', args: { path: 'a.txt' }, opts: { permission: 'ask' } });
    add('治理：只读工具在 ask 档不弹确认', readRun.ok === true && asked.length === 0, `asked=${asked.length}`);

    const writeOk = await gw.execLocal({ name: 'write_file', args: { path: 'x.txt', content: 'hi' }, opts: { permission: 'ask' } });
    add('治理：写工具在 ask 档必须主进程确认后才执行', writeOk.ok === true && asked.length === 1, `asked=${asked.length}`);

    confirmAnswer = false;
    const writeDenied = await gw.execLocal({ name: 'write_file', args: { path: 'y.txt', content: 'hi' }, opts: { permission: 'ask' } });
    add('治理：主进程确认被拒 → APPROVAL_DENIED 且不执行', writeDenied.ok === false && writeDenied.code === 'APPROVAL_DENIED' && executed.length === 2, writeDenied.code);

    const readonlyDenied = await gw.execLocal({ name: 'write_file', args: { path: 'z.txt', content: 'hi' }, opts: { permission: 'readonly' } });
    add('治理：只读档写操作被策略拒绝', readonlyDenied.ok === false && readonlyDenied.code === 'POLICY_DENIED', readonlyDenied.code);

    const hardDeny = await gw.execLocal({ name: 'run_command', args: { command: 'format c:' }, opts: { permission: 'full' } });
    add('治理：完全权限下灾难命令仍被硬拒绝', hardDeny.ok === false && hardDeny.code === 'POLICY_DENIED', hardDeny.code);

    // 伪造 approved 不再生效：payload 里塞 approved=true 也走同一判定
    confirmAnswer = false;
    const forged = await gw.execLocal({ name: 'write_file', args: { path: 'f.txt', content: 'x' }, opts: { permission: 'ask', approved: true } });
    add('治理：渲染层伪造 approved 不再放行', forged.ok === false && forged.code === 'APPROVAL_DENIED', forged.code);

    const phases = audits.map((a) => a.phase);
    add('治理：每次判定/审批/结果都进审计', phases.includes('approval') && phases.includes('result') && phases.includes('deny'), phases.join(','));
  }

  /* ── 2. 治理内核接入 Runtime 审计链 ───────────────────────────── */
  {
    const root = tempDir('gw-audit');
    const rt = makeRuntime(root);
    const gw = createToolGateway({
      localTools: { executeTool: async () => ({ ok: true, content: 'ok', meta: { label: 'ok' } }) },
      getRuntime: () => rt,
      confirm: async () => true,
    });
    await gw.execLocal({ name: 'read_file', args: { path: 'a.txt' }, opts: { permission: 'ask', workspace: rt.workspacePath } });
    const events = rt.read({ limit: 5000 }).events.filter((e) => e.type === 'tool.gateway');
    add('治理：网关事件写入 Runtime 事件链（同一份审计真值）', events.length >= 1, `events=${events.length}`);
    const audit = rt.auditRead({ limit: 200 });
    const hit = (audit.data?.records || []).some((r) => r.action === 'tool.gateway');
    add('治理：审计链可取到 tool.gateway 记录', hit, 'action=tool.gateway');
    rt.close();
  }

  /* ── 3. 取消 → 真正中断在跑的工具，并标记未知副作用 ────────────── */
  {
    const root = tempDir('abort');
    let sawSignal = false;
    const rt = makeRuntime(root, (name, args, opts) => new Promise((resolve) => {
      if (!opts.signal) { setTimeout(() => resolve({ ok: true, content: 'late', meta: {} }), 2000); return; }
      sawSignal = true;
      opts.signal.addEventListener('abort', () => resolve({ ok: false, code: 'ABORTED', error: '已取消', meta: { aborted: true } }), { once: true });
    }));
    const t = rt.createTask({ title: '取消测试' }).data;
    const p = rt.proposeTool({ runId: t.run.id, name: 'run_command', args: { command: 'node -e 1' }, profile: 'full' });
    const execP = rt.executeTool({ toolCallId: p.data.toolCallId, profile: 'full' });
    await new Promise((r) => setTimeout(r, 120));
    rt.cancelTask({ taskId: t.task.id });
    const res = await execP;
    const detail = rt.getRun(t.run.id).data;
    add('取消：AbortSignal 已注入执行层', sawSignal === true, `signal=${sawSignal}`);
    add('取消：执行立刻返回 ABORTED（不再等命令跑完）', res.data?.ok === false && res.data?.code === 'ABORTED', res.data?.code);
    add('取消：任务/运行进入 canceled', detail.task.status === 'canceled' && detail.run.status === 'canceled', `${detail.task.status}/${detail.run.status}`);
    add('取消：在跑的有副作用工具落 unknown（不假设没跑）', detail.toolCalls[0].status === 'unknown' && detail.toolCalls[0].failureCode === 'CANCELED_IN_FLIGHT', `${detail.toolCalls[0].status}/${detail.toolCalls[0].failureCode}`);
    rt.close();
  }

  /* ── 4. 重启对账：事件已终态、快照落后 → 以事件为准且不重复终态事件 ── */
  {
    const root = tempDir('reconcile');
    const mk = () => makeRuntime(root);
    const rt = mk();
    const t = rt.createTask({ title: '对账' }).data;
    const p = rt.proposeTool({ runId: t.run.id, name: 'write_file', args: { path: 'a.txt', content: 'x' }, profile: 'full' });
    await rt.executeTool({ toolCallId: p.data.toolCallId, profile: 'full' });
    rt.close();

    // 人为制造崩溃现场：事件有 tool.completed，快照却回到 executing
    const stateFile = path.join(root, 'store', 'state.json');
    const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const cid = Object.keys(snap.toolCalls)[0];
    snap.toolCalls[cid].status = 'executing';
    snap.runs[t.run.id].status = 'running';
    snap.tasks[t.task.id].status = 'running';
    fs.writeFileSync(stateFile, JSON.stringify(snap));

    const rt2 = mk();
    const d = rt2.getRun(t.run.id).data;
    add('对账：工具按事件恢复为 succeeded', d.toolCalls[0].status === 'succeeded', d.toolCalls[0].status);
    add('对账：Run 无终态事件 → interrupted', d.run.status === 'interrupted', d.run.status);
    const evs = rt2.read({ limit: 5000 }).events.map((e) => e.type);
    add('对账：不产生第二个终态事件', evs.filter((x) => x === 'tool.completed').length === 1, evs.filter((x) => x === 'tool.completed').length);
    add('对账：写入 runtime.reconciled 事件', evs.includes('runtime.reconciled'), evs.includes('runtime.reconciled'));
    rt2.close();
  }

  /* ── 5. 事件分页：readAll 不受单页 5000 上限影响 ────────────────── */
  {
    const root = tempDir('page');
    const rt = makeRuntime(root);
    const total = 1200;
    for (let i = 0; i < total; i++) rt.append({ type: 'probe.tick', payload: { i } });
    const all = rt.store.readAll({ batch: 200 }).filter((e) => e.type === 'probe.tick');
    add('分页：readAll 读全量（1200 条，单页 200）', all.length === total, `got=${all.length}`);
    const first = rt.read({ afterSeq: 0, limit: 200 });
    const more = rt.read({ afterSeq: first.nextSeq, limit: 200 });
    add('分页：游标在过滤场景也能前进', more.events.length === 200 && more.nextSeq > first.nextSeq, `${first.nextSeq}->${more.nextSeq}`);
    rt.close();
  }

  /* ── 6. 持久化容量：整库上限与键数上限 ───────────────────────── */
  {
    const dir = tempDir('persist');
    const st = createPersistStore({ filePath: path.join(dir, 's.json'), debounceMs: 0, maxTotalBytes: 1500, maxKeys: 3 });
    st.set('a', 'x'.repeat(800));
    const over = st.set('b', 'y'.repeat(800));
    add('容量：整库超限写入被拒（STORAGE_FULL）', over.ok === false && over.error === 'STORAGE_FULL', over.error);
    st.set('c', 'z');
    st.set('d', 'w');
    const tooMany = st.set('e', 'v');
    add('容量：键数量超限被拒（KEYS_FULL）', tooMany.ok === false && tooMany.error === 'KEYS_FULL', tooMany.error);
    st.remove('a');
    const after = st.set('b', 'y'.repeat(800));
    add('容量：删除后可继续写入', after.ok === true, JSON.stringify(after));
    add('容量：stats 暴露上限与占用比', st.stats().maxTotalBytes === 1500 && st.stats().usageRatio > 0, JSON.stringify(st.stats().usageRatio));
  }

  /* ── 7. Autopilot 进度跨重启恢复 ─────────────────────────────── */
  {
    let saved = null;
    const ap = createAutopilot({
      taskApi: {
        listTasks: () => ({ tasks: [{ id: 'tk1', status: 'paused', createdAt: 1 }] }),
        resumeTask: () => ({ task: { id: 'tk1' } }),
      },
      maxIterations: 20,
      saveState: (s) => { saved = s; },
    });
    ap.start();
    await ap._tick();
    add('Autopilot：推进后进度写盘', saved && saved.iteration === 1, JSON.stringify(saved && saved.iteration));

    const ap2 = createAutopilot({
      taskApi: {
        listTasks: () => ({ tasks: [{ id: 'tk1', status: 'paused', createdAt: 1 }] }),
        resumeTask: () => ({ task: { id: 'tk1' } }),
      },
      maxIterations: 20,
      loadState: () => saved,
      saveState: () => {},
    });
    add('Autopilot：重启后恢复 iteration', ap2.state().iteration === 1, ap2.state().iteration);
    ap2.start();
    add('Autopilot：启动不清零已有进度', ap2.state().iteration === 1, ap2.state().iteration);
    ap2.stop();
  }

  /* ── 8. SSRF：IP 段 + 逐跳重定向 ─────────────────────────────── */
  {
    const cases = [
      ['127.0.0.1', true], ['10.1.2.3', true], ['192.168.0.5', true], ['169.254.169.254', true],
      ['100.64.0.1', true], ['172.31.0.1', true], ['::1', true], ['fe80::1', true], ['fc00::1', true],
      ['::ffff:127.0.0.1', true], ['8.8.8.8', false], ['1.1.1.1', false], ['2001:4860:4860::8888', false],
      ['::ffff:8.8.8.8', false],
    ];
    const bad = cases.filter(([ip, want]) => netSafety.isPrivateAddress(ip) !== want);
    add('SSRF：内网/保留地址判定', bad.length === 0, bad.map(([ip]) => ip).join(','));

    const origLookup = dns.promises.lookup;
    dns.promises.lookup = async (host) => {
      if (host === 'public.test') return [{ address: '93.184.216.34', family: 4 }];
      if (host === 'internal.test') return [{ address: '10.0.0.5', family: 4 }];
      if (host === 'rebind.test') return [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    netSafety.clearDnsCache();
    const mkRes = (status, headers = {}) => ({
      status,
      type: 'basic',
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      body: { cancel: async () => {} },
    });
    try {
      let blocked = '';
      try {
        await netSafety.safeFetch('https://public.test/a', {
          doFetch: async () => mkRes(302, { location: 'http://internal.test/b' }),
        });
      } catch (err) { blocked = err.message; }
      add('SSRF：跳转到内网被拦', /内网|保留/.test(blocked), blocked.slice(0, 60));

      let okFinal = '';
      const r = await netSafety.safeFetch('https://public.test/a', {
        doFetch: async (url) => (url.endsWith('/a') ? mkRes(302, { location: 'https://public.test/b' }) : mkRes(200)),
      });
      okFinal = r.finalUrl;
      add('SSRF：公网内跳转可正常跟随', okFinal === 'https://public.test/b', okFinal);

      let rebind = '';
      try {
        await netSafety.safeFetch('https://rebind.test/x', { doFetch: async () => mkRes(200) });
      } catch (err) { rebind = err.message; }
      add('SSRF：域名解析含内网地址即拒绝', /内网|保留/.test(rebind), rebind.slice(0, 60));

      let opaque = '';
      try {
        await netSafety.safeFetch('https://public.test/c', { doFetch: async () => ({ status: 0, type: 'opaqueredirect', headers: { get: () => null }, body: null }) });
      } catch (err) { opaque = err.message; }
      add('SSRF：不可验证的跳转被拒', /不可验证/.test(opaque), opaque.slice(0, 60));
    } finally {
      dns.promises.lookup = origLookup;
      netSafety.clearDnsCache();
    }
  }

  /* ── 9. 子进程环境变量白名单 ─────────────────────────────────── */
  {
    process.env.DSH_TEST_SECRET = 'sk-should-not-leak';
    const env = buildChildEnv({ EXTRA_OK: '1' });
    add('环境变量：主进程密钥不继承给子进程', !('DSH_TEST_SECRET' in env), Object.keys(env).length);
    add('环境变量：显式覆盖生效', env.EXTRA_OK === '1', env.EXTRA_OK);
    add('环境变量：PATH 保留（命令能跑）', !!env.PATH || !!env.Path, env.PATH ? 'PATH' : '');
    delete process.env.DSH_TEST_SECRET;
  }

  /* ── 10. 队列优先级 + 老化 ───────────────────────────────────── */
  {
    const root = tempDir('queue-prio');
    const rt = makeRuntime(root);
    rt.setSettings({ maxConcurrentRuns: 1 });
    const running = rt.createTask({ title: '占位' }).data;
    const low = rt.createTask({ title: '低', priority: 'low' }).data;
    const high = rt.createTask({ title: '高', priority: 'high' }).data;
    const highPos = rt.getTask(high.task.id).data.task.queuePosition;
    const lowPos = rt.getTask(low.task.id).data.task.queuePosition;
    add('队列：高优先级排队位置更靠前', highPos === 1 && lowPos === 2, `${highPos}/${lowPos}`);
    rt.cancelTask({ taskId: running.task.id });
    add('队列：释放并发后按优先级出队', rt.getTask(high.task.id).data.task.status === 'running', rt.getTask(high.task.id).data.task.status);
    rt.close();
  }

  /* ── 汇总 ───────────────────────────────────────────────────── */
  for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'XX  '}${c.name}${c.pass ? '' : ' · ' + c.detail}`);
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;
  console.log(`\n治理自检：${passed}/${checks.length} 通过${failed ? `，${failed} 失败` : ''}`);
  console.log(JSON.stringify({ passed, failed, total: checks.length }));
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(`XX  自检异常中断 · ${err?.message || err}`);
  console.log(JSON.stringify({ passed: 0, failed: 1, total: 1 }));
  process.exitCode = 1;
});
