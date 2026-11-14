'use strict';

/* ─────────────────────────────────────────────
   lib/skills.js 自检：node tools/skills-selfcheck.js 直跑。

   临时目录里造标准/非标准技能，断言：
   扫描结果（含 frontmatter 解析、无 frontmatter 兜底、去重）
   + 单篇读取 + 越界路径拒绝。临时目录建在项目 .tmp/ 下，结束即清理。
   ───────────────────────────────────────────── */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const skills = require('../lib/skills');

let pass = 0;
let failCount = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('OK  ' + name);
  } catch (e) {
    failCount++;
    console.log('XX  ' + name + ' | ' + (e?.message || e));
  }
};

(async () => {
  /* ── 造测试数据 ── */
  const tmpParent = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(tmpParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(tmpParent, 'skills-check-'));
  const userDir = path.join(root, 'user-skills');
  const projDir = path.join(root, 'proj', '.dsh', 'skills');

  try {
    fs.mkdirSync(path.join(userDir, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'alpha', 'SKILL.md'),
      '---\nname: 代码审查\ndescription: 按清单审查代码质量\n---\n\n# 审查步骤\n\n1. 先看命名。\n2. 再看边界。\n');
    fs.writeFileSync(path.join(userDir, 'beta.md'), '# 无 frontmatter 技能\n\n正文内容在这里。\n');
    fs.writeFileSync(path.join(userDir, 'note.txt'), '不是技能文件');
    fs.mkdirSync(path.join(userDir, 'empty-dir'), { recursive: true });  // 没有 SKILL.md，应被忽略
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'alpha.md'),
      '---\nname: 代码审查\ndescription: 项目级同名技能\n---\n\n项目级正文。');
    fs.writeFileSync(path.join(root, 'secret.md'), '扫描目录之外的机密');
  } catch (err) {
    console.error('[selfcheck] 造测试数据失败：', err);
    process.exit(1);
  }

  const DIRS = [
    { source: 'user', dir: userDir },
    { source: 'project', dir: projDir },
  ];

  /* ── 扫描 ── */
  let scanned = [];
  t('scanSkills 返回 3 个技能（txt/空目录被忽略）', () => {
    scanned = skills.scanSkills(DIRS);
    assert.equal(scanned.length, 3, `实际：${scanned.map((s) => s.id).join(',')}`);
  });
  t('frontmatter 解析：name/description/body 都对', () => {
    const alpha = scanned.find((s) => s.source === 'user');
    assert.equal(alpha.name, '代码审查');
    assert.equal(alpha.description, '按清单审查代码质量');
    assert.match(alpha.body, /审查步骤/);
    assert.match(alpha.body, /再看边界/);
    assert.ok(!alpha.body.includes('---'), 'body 不应包含 frontmatter 分隔线');
    assert.equal(alpha.path, path.join(userDir, 'alpha', 'SKILL.md'));
    assert.equal(alpha.dir, userDir);
    assert.equal(alpha.id, '代码审查');
  });
  t('无 frontmatter：用文件名兜底', () => {
    const beta = scanned.find((s) => s.id === 'beta');
    assert.equal(beta.name, 'beta');
    assert.equal(beta.description, '');
    assert.match(beta.body, /正文内容在这里/);
    assert.equal(beta.source, 'user');
  });
  t('不同目录同名技能：id 追加序号去重', () => {
    const dup = scanned.filter((s) => s.name === '代码审查');
    assert.equal(dup.length, 2);
    assert.deepEqual(dup.map((s) => s.id).sort(), ['代码审查', '代码审查-2']);
    assert.equal(dup.find((s) => s.id === '代码审查-2').source, 'project');
  });
  t('目录不存在 → 该来源贡献为空，不抛错', () => {
    const r = skills.scanSkills([{ source: 'user', dir: path.join(root, 'not-exist') }]);
    assert.deepEqual(r, []);
  });
  t('入参不是数组/为空 → 返回空数组', () => {
    assert.deepEqual(skills.scanSkills(null), []);
    assert.deepEqual(skills.scanSkills('x'), []);
  });
  t('字符串目录 → source 记为 custom', () => {
    const r = skills.scanSkills([userDir]);
    assert.equal(r.length, 2);
    assert.ok(r.every((s) => s.source === 'custom'));
  });

  /* ── 读取 ── */
  const ok = await skills.readSkillFile(DIRS, path.join(userDir, 'alpha', 'SKILL.md'));
  t('readSkillFile 读到全文与元信息', () => {
    assert.equal(ok.ok, true, ok.error || '');
    assert.equal(ok.skill.name, '代码审查');
    assert.match(ok.skill.body, /审查步骤/);
    assert.equal(ok.skill.source, 'user');
    assert.equal(ok.skill.path, path.join(userDir, 'alpha', 'SKILL.md'));
  });

  const cases = [
    ['越界（扫描目录之外）被拒绝', path.join(root, 'secret.md'), 'OUT_OF_SCOPE'],
    ['越界（.. 穿越出扫描目录）被拒绝', path.join(userDir, '..', 'secret.md'), 'OUT_OF_SCOPE'],
    ['目录内不存在的文件报 NOT_FOUND', path.join(userDir, 'ghost.md'), 'NOT_FOUND'],
    ['非 .md 文件被拒绝', path.join(userDir, 'note.txt'), 'BAD_PATH'],
    ['空路径被拒绝', '', 'BAD_ARGS'],
    ['目录路径（不是文件）被拒绝', userDir, 'BAD_PATH'],
  ];
  for (const [name, p, code] of cases) {
    const r = await skills.readSkillFile(DIRS, p);
    t(name, () => {
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.code, code, `实际 code=${r.code}`);
    });
  }

  /* ── 清理 ── */
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
  process.exit(failCount ? 1 : 0);
})().catch((err) => {
  console.error('[selfcheck] 意外失败：', err);
  process.exit(1);
});
