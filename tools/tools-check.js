'use strict';

/* 工具集自检：内置工具的数量、元信息完整性、以及新增工具的真实行为。
   为什么单独一份：r15-check 盯的是「治理整改」，这份盯的是「模型手里到底有什么工具、
   这些工具在边界上是否按约定拒绝」。新增工具时先让这里红，再让它绿。
   纯 Node，不需要 Electron。
   运行：node tools/tools-check.js
   输出最后一行 JSON {passed,failed,total}，供 tools/run-all.js 汇总。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tools = require('../lib/tools');
const { listManifests, getManifest } = require('../runtime/tool-registry');

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECTED = [
  'list_dir', 'read_file', 'write_file', 'edit_file', 'search_files', 'find_files',
  'run_command', 'task_output', 'task_stop', 'task_list',
  'fetch_url', 'todo_write', 'project_architecture', 'delegate_task',
];

const names = tools.TOOL_SPECS.map((s) => s.function.name);
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-'));
const exec = (name, args, opts = {}) => tools.executeTool(name, args, { workspace: ws, permission: 'full', ...opts });

(async () => {
  /* ── 1. 清单与元信息 ───────────────────────────────────────────── */
  add('工具数量与清单一致', names.length === EXPECTED.length && EXPECTED.every((n) => names.includes(n)),
    `${names.length} 个：${names.join(',')}`);
  add('工具名无重复', new Set(names).size === names.length);
  add('每个工具都有说明与 JSON Schema', tools.TOOL_SPECS.every((s) => {
    const f = s.function;
    return s.type === 'function' && f && typeof f.description === 'string' && f.description.length >= 12
      && f.parameters && f.parameters.type === 'object' && f.parameters.properties;
  }));

  add('只读集合与需审批集合不重叠',
    [...tools.READ_ONLY].every((n) => !tools.NEEDS_APPROVAL.has(n)),
    [...tools.READ_ONLY].filter((n) => tools.NEEDS_APPROVAL.has(n)).join(',') || '无重叠');

  add('edit_file 需要审批且不属于只读', tools.NEEDS_APPROVAL.has('edit_file') && !tools.READ_ONLY.has('edit_file'));
  add('读输出/列表属于只读，不需要审批',
    tools.READ_ONLY.has('task_output') && tools.READ_ONLY.has('task_list')
    && !tools.NEEDS_APPROVAL.has('task_output') && !tools.NEEDS_APPROVAL.has('task_list'));
  add('task_stop 在只读模式下被拒绝（不属于只读集合）', !tools.READ_ONLY.has('task_stop'));

  add('每个工具都有显示元信息（verb/icon/tone）',
    names.every((n) => tools.TOOL_META[n] && tools.TOOL_META[n].verb && tools.TOOL_META[n].icon && tools.TOOL_META[n].tone),
    names.filter((n) => !tools.TOOL_META[n]).join(',') || '全部具备');

  {
    const html = read('renderer/index.html');
    const icons = names.map((n) => tools.TOOL_META[n].icon);
    const missing = icons.filter((icon) => !html.includes(`id="${icon}"`));
    add('工具图标都在 index.html 的 sprite 里', missing.length === 0, missing.join(',') || `${icons.length} 个图标齐备`);
  }

  /* 运行时清单缺失会退化成 risk=high + 默认需审批：读工具会莫名其妙弹审批，必须挡住。
     fetch_url 是唯一例外——联网读取按设计是 medium 风险，但仍不该每次弹审批。 */
  {
    const manifests = new Map(listManifests().map((m) => [m.name, m]));
    const missing = names.filter((n) => !manifests.has(n));
    const gatedReadTools = names.filter((n) => tools.READ_ONLY.has(n) && n !== 'fetch_url');
    const wronglyGated = gatedReadTools.filter((n) => {
      const m = getManifest(n);
      return m.risk !== 'low' || m.defaultApproval !== 'never';
    });
    add('运行时清单覆盖全部工具', missing.length === 0, missing.join(',') || `${manifests.size} 条`);
    add('本地读工具在策略层是 low + never（不会被误弹审批）', wronglyGated.length === 0, wronglyGated.join(',') || '全部符合');
    add('联网读取按 medium 风险但不默认弹审批',
      getManifest('fetch_url').risk === 'medium' && getManifest('fetch_url').defaultApproval === 'never');
  }

  /* ── 2. edit_file 真实行为 ─────────────────────────────────────── */
  const dupPath = path.join(ws, 'dup.js');
  fs.writeFileSync(dupPath, 'const a = 1;\nconst b = 2;\nconst a = 3;\n', 'utf8');

  {
    const r = await exec('edit_file', { path: 'dup.js', old_string: 'const b = 2;', new_string: 'const b = 42;' });
    const after = fs.readFileSync(dupPath, 'utf8');
    add('edit_file 唯一匹配可替换', r.ok && after.includes('const b = 42;') && !after.includes('const b = 2;'),
      r.ok ? after.split('\n')[1] : r.error);
  }
  {
    const before = fs.readFileSync(dupPath, 'utf8');
    const r = await exec('edit_file', { path: 'dup.js', old_string: 'const a', new_string: 'const z' });
    add('edit_file 多处匹配时拒绝且不改文件',
      !r.ok && /出现了 2 次/.test(String(r.error)) && fs.readFileSync(dupPath, 'utf8') === before,
      String(r.error).slice(0, 40));
  }
  {
    const before = fs.readFileSync(dupPath, 'utf8');
    const r = await exec('edit_file', { path: 'dup.js', old_string: 'const nope = 9;', new_string: 'x' });
    add('edit_file 找不到原文时拒绝且不改文件',
      !r.ok && /没有找到 old_string/.test(String(r.error)) && fs.readFileSync(dupPath, 'utf8') === before,
      String(r.error).slice(0, 40));
  }
  {
    const r = await exec('edit_file', { path: 'dup.js', old_string: 'const a', new_string: 'let a', replace_all: true });
    const after = fs.readFileSync(dupPath, 'utf8');
    add('edit_file replace_all 替换全部出现', r.ok && (after.match(/let a/g) || []).length === 2, r.ok ? '2 处' : r.error);
  }
  {
    const crlf = path.join(ws, 'crlf.txt');
    fs.writeFileSync(crlf, 'line1\r\nline2\r\nline3\r\n', 'utf8');
    const r = await exec('edit_file', { path: 'crlf.txt', old_string: 'line2\n', new_string: 'A\nB\n' });
    const buf = fs.readFileSync(crlf, 'utf8');
    const strayLf = (buf.match(/(?<!\r)\n/g) || []).length;
    add('edit_file 在 CRLF 文件里不混入孤立 LF',
      r.ok && strayLf === 0 && buf.includes('line1\r\nA\r\nB\r\nline3'), `${strayLf} 个孤立 LF`);
  }
  {
    const r = await exec('edit_file', { path: 'dup.js', old_string: 'x', new_string: 'y' }, { permission: 'readonly' });
    add('只读模式拒绝 edit_file', !r.ok && r.code === 'DENIED', r.code);
  }

  /* ── 3. find_files ─────────────────────────────────────────────── */
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'sub', 'm.test.js'), 'export const x = 1;\n', 'utf8');
  fs.writeFileSync(path.join(ws, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(path.join(ws, 'README.md'), '# demo\n', 'utf8');

  {
    const r = await exec('find_files', { pattern: '*.js' });
    const text = String(r.content || '');
    add('find_files 不带斜杠时按文件名匹配', r.ok && text.includes('dup.js') && text.includes('sub/m.test.js'), text.split('\n')[0]);
    add('find_files 跳过 node_modules', r.ok && !text.includes('node_modules'), '已跳过');
  }
  {
    const r = await exec('find_files', { pattern: '**/*.test.js' });
    add('find_files 支持跨目录通配', r.ok && String(r.content).includes('sub/m.test.js')
      && !String(r.content).includes('README.md'), String(r.content).split('\n')[0]);
  }
  {
    const r = await exec('find_files', { pattern: '*.md', path: 'sub' });
    add('find_files 起始目录内无匹配时如实返回空', r.ok && /没有找到/.test(String(r.content)), String(r.content).slice(0, 30));
  }

  /* ── 4. 后台任务全链路 ─────────────────────────────────────────── */
  const ticker = 'node -e "let i=0;setInterval(()=>console.log(\'tick \'+ ++i), 180)"';
  const started = await exec('run_command', { command: ticker, background: true, label: 'ticker-check' });
  const taskId = started.meta?.taskId;

  add('后台命令立刻返回任务 ID', started.ok && /^bg-\d+$/.test(String(taskId)), String(taskId));
  add('后台启动结果带首屏输出与使用提示',
    started.ok && /首屏输出/.test(String(started.content)) && /task_output/.test(String(started.content)),
    String(started.content).split('\n')[0]);

  await sleep(700);
  const read1 = await exec('task_output', { task_id: taskId });
  await sleep(600);
  const read2 = await exec('task_output', { task_id: taskId });

  add('task_output 能读到输出', read1.ok && /tick 1/.test(String(read1.content)), String(read1.content).split('\n')[0]);
  add('task_output 默认续读（第二次不重复上次内容）', read2.ok && !/tick 1\b/.test(String(read2.content)),
    String(read2.content).split('\n').slice(0, 2).join(' / ').slice(0, 40));

  const listed = await exec('task_list', {});
  add('task_list 列出运行中的任务', listed.ok && String(listed.content).includes(String(taskId)),
    String(listed.content).split('\n')[0]);

  const stopped = await exec('task_stop', { task_id: taskId });
  const after = tools.backgroundTasks.getTask(taskId);
  add('task_stop 终止任务', stopped.ok && after && after.status !== 'running', after ? after.status : '任务丢失');

  const afterStop = await exec('task_output', { task_id: taskId });
  add('任务被主动停止后读取不算失败', afterStop.ok === true, `ok=${afterStop.ok}`);

  const ghost = await exec('task_output', { task_id: 'bg-999' });
  add('未知任务 ID 明确报错', !ghost.ok && /没有这个后台任务/.test(String(ghost.error)), String(ghost.error).slice(0, 30));

  add('后台输出缓冲有上限（防止内存无界增长）',
    typeof tools.backgroundTasks.MAX_BUFFER_CHARS === 'number' && tools.backgroundTasks.MAX_BUFFER_CHARS <= 1024 * 1024,
    `${tools.backgroundTasks.MAX_BUFFER_CHARS} 字符`);

  /* 正常退出的后台命令：退出码要如实上报 */
  {
    const quick = await exec('run_command', { command: 'node -e "process.exit(3)"', background: true });
    await sleep(900);
    const out = await exec('task_output', { task_id: quick.meta.taskId });
    add('后台任务非零退出如实上报为失败', out.ok === false && /退出码 3/.test(String(out.content)),
      String(out.content).split('\n')[0]);
  }

  /* ── 5. 接线断言 ───────────────────────────────────────────────── */
  {
    const mainSrc = read('main.js');
    const quitIdx = mainSrc.indexOf("app.on('before-quit'");
    const quitBlock = quitIdx >= 0 ? mainSrc.slice(quitIdx, quitIdx + 2600) : '';
    add('退出时统一停止后台任务（不留孤儿进程）',
      /backgroundTasks\.stopAll\(\)/.test(quitBlock), quitBlock ? 'before-quit 内已接线' : 'before-quit 未找到');
  }
  {
    const appSrc = read('renderer/app.js');
    add('系统提示引导优先用 edit_file 精确替换',
      /改已有文件优先用 edit_file/.test(appSrc) && /只有新建文件或整篇重写才用 write_file/.test(appSrc));
    add('系统提示引导长跑命令走 background',
      /background:true/.test(appSrc) && /task_output/.test(appSrc) && /task_stop/.test(appSrc));
  }
  {
    const policySrc = read('runtime/policy.js');
    add('策略层把 edit_file / find_files 纳入路径工具',
      /PATH_TOOLS = new Set\(\[[^\]]*'edit_file'[^\]]*'find_files'/.test(policySrc)
      || (/PATH_TOOLS = new Set/.test(policySrc) && /edit_file/.test(policySrc) && /find_files/.test(policySrc)));
  }

  /* ── 汇总 ─────────────────────────────────────────────────────── */
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;
  for (const c of checks) console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(JSON.stringify({ passed, failed, total: checks.length }));
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log(`✗ 自检异常 — ${err && err.message ? err.message : err}`);
  console.log(JSON.stringify({ passed: 0, failed: 1, total: 1, error: String(err && err.message || err) }));
  process.exit(1);
});
