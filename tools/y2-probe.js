'use strict';

/* Y2 启动提速探针（渲染层视角，经 preload 桥只读探测 main 侧改造结果）。
 * 运行：npx electron . --user-data-dir=.s-y2 --shot --script=tools/y2-probe.js
 * main 侧的阶段毫秒明细从主进程 stdout 的 [boot-stages] 行读取（writeBootStages 会同步打印）。
 * 只断言 main 侧：窗口立即可见 / boot-stages 已落盘；splash 由渲染层代理负责，此处不断言。
 */

(async () => {
  const add = (name, pass, detail) => ({ name, pass: !!pass, detail: String(detail ?? '') });
  const checks = [];

  // ① 窗口立即显示：did-finish-load 时 document 应已 visible
  //    （改造前 show:false + ready-to-show，加载完成瞬间可能还是 hidden；改为立即 show 后必然 visible）
  checks.push(add('窗口在加载完成时已可见（立即 show）',
    document.visibilityState === 'visible',
    `visibilityState=${document.visibilityState}`));

  // ② boot-stages 已落盘：guard:state → crash-log 概要（did-finish-load 后 setImmediate 写入部分记录）
  const gs = await window.dsh.guard.getState();
  const cl = gs && gs.crashLog;
  checks.push(add('guard:state 返回正常', gs && gs.ok === true, `ok=${gs && gs.ok}`));
  checks.push(add('crash-log.jsonl 已存在', !!(cl && cl.exists), `exists=${cl && cl.exists}`));
  checks.push(add('boot-stages 记录已写入（lastType）',
    !!(cl && cl.lastType === 'boot-stages'),
    `lastType=${cl && cl.lastType}, lines=${cl && cl.lines}`));

  // ③ preload 桥可用性（渲染层代理调 boot:renderer-ready 的前提）
  checks.push(add('preload 桥 window.dsh 可用',
    !!window.dsh && typeof window.dsh.guard?.getState === 'function',
    'typeof window.dsh.guard.getState'));

  return { checks, allPass: checks.every((c) => c.pass) };
})()
