'use strict';

/* 叙述行三段规则探针（修复「工具调用中途不说话」）：
 *   a) 工具执行中模型沉默 → 「正在 …」显示
 *   b) 工具落定+回合进行中+模型未出声 → 「模型正在思考下一步…」is-thinking（间隙思考期，旧规则此处空白）
 *   c) 模型出声（body 变长）→ 叙述行让位
 *   d) 回合结束 → 叙述行退场
 * 运行：npx electron . --user-data-dir=<隔离目录> --shot --script=tools/narrate-gap-probe.js */
(async () => {
  const mkNode = () => {
    const node = document.createElement('div');
    node.innerHTML = '<div class="slot-narrate"></div>';
    document.body.appendChild(node);
    return node;
  };
  const mkTool = (over = {}) => ({
    id: 't1', name: 'read_file', verb: '读取', target: 'a.txt',
    status: 'pending', bodyAtStart: 0, ...over,
  });
  const narrateHtml = (node) => {
    renderNarrate(node, msg);
    const el = $('.tool-narrate:not(.is-leaving)', node.querySelector('.slot-narrate'));
    return el ? el.textContent : '';
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let msg = { body: '', summary: { label: '进行中' }, tools: [] };
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 100) });

  /* a) 工具 pending→running，模型沉默 */
  let node = mkNode();
  msg.tools.push(mkTool({ status: 'running' }));
  const a = narrateHtml(node);
  check('a.runningShown', a.includes('正在 读取') && a.includes('a.txt'), a);

  /* b) 工具落定（status=ok），回合仍进行中，模型没出声 → 间隙思考期必须有字 */
  msg.tools[0].status = 'ok';
  const b = narrateHtml(node);
  check('b.thinkingGapShown', b.includes('模型正在思考下一步'), `text="${b}"`);

  /* c) 模型出声：body 变长 → 让位 */
  msg.body = '已读完文件，接下来搜索用法。';
  await sleep(20);
  const c = narrateHtml(node);
  check('c.yieldsToModel', c === '', c);

  /* d) 回合结束（label 已完成）→ 退场 */
  msg.summary.label = '已完成';
  const d = narrateHtml(node);
  check('d.doneExits', d === '', d);
  node.remove();

  /* e) 旧数据无 bodyAtStart：有正文即让位（兼容不回归） */
  node = mkNode();
  msg = { body: '先看目录。', summary: { label: '进行中' }, tools: [mkTool({ status: 'running' })] };
  delete msg.tools[0].bodyAtStart;
  const e = narrateHtml(node);
  check('e.legacyYields', e === '', e);
  node.remove();

  return { task: 'narrate-gap-probe', results, passed: results.filter((r) => r.ok).length, total: results.length };
})();
