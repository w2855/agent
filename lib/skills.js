'use strict';

/* ─────────────────────────────────────────────
   Skills（技能）扫描与读取

   技能是一个目录（内含 SKILL.md）或一个单独的 .md 文件：
   可选的 frontmatter（--- 包裹的 name / description）+ Markdown 正文。
   解析从简：只认 name / description 两个键，其余键忽略；
   没有 frontmatter 就用文件名（目录形式用目录名）。

   读取单篇时按扫描目录做边界校验（复用 lib/safety.js 的判定风格，
   先按路径字面判一次，再解析真实路径防软链/穿越逃逸），
   防止把 skills:read 当任意文件读取口子。
   ───────────────────────────────────────────── */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { isWithinWorkspace, realish } = require('./safety');

const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_BODY_CHARS = 60000;
const MAX_SKILLS = 100;
const MAX_FRONTMATTER_LINES = 32;

/** 统一目录入参：字符串 → { source: 'custom', dir }；对象取 source/label + dir。 */
function normalizeDirs(dirs) {
  return (Array.isArray(dirs) ? dirs : [])
    .map((d) => {
      if (typeof d === 'string') return { source: 'custom', dir: d };
      if (d && typeof d === 'object') {
        return { source: String(d.source || d.label || 'custom'), dir: String(d.dir || '') };
      }
      return null;
    })
    .filter((d) => d && d.dir);
}

function slug(value) {
  const s = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'skill';
}

/** 解析 frontmatter：--- 包裹的首段里只挑 name / description，其余进 body。 */
function parseFrontmatter(raw) {
  const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return { data: null, body: text.trim() };
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length && i <= MAX_FRONTMATTER_LINES; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return { data: null, body: text.trim() };  // 只有开头没有结尾，当普通正文
  const data = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'name' || key === 'description') {
      data[key] = String(m[2]).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return { data, body: lines.slice(end + 1).join('\n').replace(/^\s*\n/, '').trim() };
}

function truncateBody(body) {
  return body.length > MAX_BODY_CHARS
    ? body.slice(0, MAX_BODY_CHARS) + '\n…（正文过长已截断）'
    : body;
}

/** 读单个技能文件并解析；不满足技能形态（不存在/过大）返回 null。 */
function parseSkillFile(file, fallbackName) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || st.size === 0 || st.size > MAX_SKILL_FILE_BYTES) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { data, body } = parseFrontmatter(text);
  const name = String(data?.name || fallbackName).trim() || fallbackName;
  return {
    name: name.slice(0, 80),
    description: String(data?.description || '').trim().slice(0, 300),
    body: truncateBody(body),
  };
}

/**
 * 扫描技能目录。
 * @param {Array<string|{source?:string, label?:string, dir:string}>} dirs
 * @returns {Array<{id,name,description,source,dir,path,body}>}
 */
function scanSkills(dirs) {
  const seenIds = new Set();
  const out = [];
  for (const { source, dir } of normalizeDirs(dirs)) {
    let st;
    try { st = fs.statSync(dir); } catch { continue; }   // 目录不存在 → 该来源贡献为空
    if (!st.isDirectory()) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

    for (const ent of entries) {
      const item = readSkillEntry(dir, ent, source);
      if (!item) continue;
      // id 冲突（不同目录同名技能）：追加序号，保证 id 唯一
      const base = slug(item.name);
      let id = base;
      let n = 2;
      while (seenIds.has(id)) id = `${base}-${n++}`;
      seenIds.add(id);
      out.push({ ...item, id });
      if (out.length >= MAX_SKILLS) return out;
    }
  }
  return out;
}

function readSkillEntry(root, ent, source) {
  if (ent.isDirectory()) {
    // 子目录形态：<dir>/<name>/SKILL.md；没有 SKILL.md 的子目录跳过
    const file = path.join(root, ent.name, 'SKILL.md');
    const parsed = parseSkillFile(file, ent.name);
    return parsed ? { ...parsed, source, dir: root, path: file } : null;
  }
  if (!ent.isFile() || !/\.md$/i.test(ent.name)) return null;
  const file = path.join(root, ent.name);
  if (ent.name.toLowerCase() === 'skill.md') {
    // 根目录直接放 SKILL.md：技能名取 frontmatter 或目录名
    const parsed = parseSkillFile(file, path.basename(root));
    return parsed ? { ...parsed, source, dir: root, path: file } : null;
  }
  const parsed = parseSkillFile(file, ent.name.replace(/\.md$/i, ''));
  return parsed ? { ...parsed, source, dir: root, path: file } : null;
}

/**
 * 读取单个技能全文。路径必须落在某个扫描目录内（复用 safety 的边界判定），
 * 且只能是 .md 文件，防任意读。
 * @returns {Promise<{ok:boolean, skill?:object, code?:string, error?:string}>}
 */
async function readSkillFile(dirs, filePath) {
  const raw = String(filePath == null ? '' : filePath).trim();
  if (!raw) return { ok: false, code: 'BAD_ARGS', error: '缺少 path 参数' };
  if (raw.includes('\0')) return { ok: false, code: 'BAD_PATH', error: '路径包含非法字符' };

  let abs;
  try { abs = path.resolve(raw); } catch { return { ok: false, code: 'BAD_PATH', error: '路径不合法' }; }

  const roots = normalizeDirs(dirs);
  const root = roots.find((r) => isWithinWorkspace(r.dir, abs));
  if (!root) return { ok: false, code: 'OUT_OF_SCOPE', error: '路径不在技能目录内' };

  // 目录/软链解析后再校验一次，防穿越逃逸（与 lib/tools.js 的 realish 思路一致）
  const real = realish(abs);
  if (!isWithinWorkspace(root.dir, real)) return { ok: false, code: 'OUT_OF_SCOPE', error: '路径不在技能目录内' };
  if (!/\.md$/i.test(real)) return { ok: false, code: 'BAD_PATH', error: '只支持读取 .md 技能文件' };

  let st;
  try { st = await fsp.stat(real); } catch {
    return { ok: false, code: 'NOT_FOUND', error: '技能文件不存在' };
  }
  if (!st.isFile()) return { ok: false, code: 'BAD_PATH', error: '不是普通文件' };
  if (st.size > MAX_SKILL_FILE_BYTES) {
    return { ok: false, code: 'TOO_LARGE', error: `技能文件过大（超过 ${Math.round(MAX_SKILL_FILE_BYTES / 1024)} KB）` };
  }

  let text;
  try { text = await fsp.readFile(real, 'utf8'); } catch (err) {
    return { ok: false, code: 'READ_FAILED', error: err?.message || String(err) };
  }
  const { data, body } = parseFrontmatter(text);
  const fallbackName = path.basename(real, path.extname(real));
  const name = String(data?.name || fallbackName).trim() || fallbackName;

  return {
    ok: true,
    skill: {
      id: slug(name),
      name: name.slice(0, 80),
      description: String(data?.description || '').trim().slice(0, 300),
      source: root.source,
      dir: root.dir,
      path: real,
      body: truncateBody(body),
    },
  };
}

module.exports = {
  scanSkills,
  readSkillFile,
  parseFrontmatter,
  slug,
};
