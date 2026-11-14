/* P2 探针（--shot 模式渲染层执行）：稳定性守护自检。
   断言：1) 单实例锁生效（首个实例 isPrimary=true）；
         2) render-process-gone 监听已挂（crashListenerAttached）；
         3) CrashTracker 已实例化（softRenderMarked 可读且初始为 false）；
         4) crash-log.jsonl 已写入本次启动的 boot 记录。
   注：无头环境主动注入渲染进程崩溃不可靠（会直接杀死页面脚本、did-finish-load 不再触发），
   按约定只断言监听注册与状态暴露，不真实触发 crash。
   运行：electron . --user-data-dir=.s-p2 --shot --script=tools/p2-probe.js */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);
  const out = { guard: {} };
  try {
    const s = await window.dsh.guard.getState();
    out.guard = {
      channelOk: s?.ok === true,
      isPrimary: s?.isPrimary === true,
      secondInstanceCount: s?.secondInstanceCount,
      crashListenerAttached: s?.crashListenerAttached === true,
      crashTrackerReady: typeof s?.softRenderMarked === 'boolean' && s?.softRenderMarked === false,
      hwAccelDisabledAtBoot: s?.hwAccelDisabledAtBoot,
      crashLogExists: s?.crashLog?.exists === true,
      crashLogLines: s?.crashLog?.lines,
      crashLogHasBoot: s?.crashLog?.lastType === 'boot',
      ok: s?.ok === true && s?.isPrimary === true && s?.crashListenerAttached === true
        && s?.softRenderMarked === false && s?.crashLog?.exists === true && s?.crashLog?.lastType === 'boot',
    };
  } catch (err) {
    out.guard = { ok: false, error: String(err && err.message || err) };
  }
  out.allOk = out.guard.ok === true;
  return out;
})();
