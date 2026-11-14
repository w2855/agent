'use strict';

/* 工具与策略共用的安全判定：避免两份 HARD_DENY / 工作区边界实现逐渐漂移。 */

const fs = require('node:fs');
const path = require('node:path');

const SYSTEM_PREFIXES = process.platform === 'win32'
  ? [
    path.join(process.env.SystemRoot || 'C:\\Windows'),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ]
  : ['/etc', '/bin', '/sbin', '/usr', '/boot', '/dev', '/proc', '/sys'];

const HARD_DENY_COMMANDS = [
  /(^|[&|;]\s*)format(\.com)?(\s|$)/i,
  /(^|[&|;]\s*)diskpart(\s|$)/i,
  /(^|[&|;]\s*)mkfs(\.\w+)?(\s|$)/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /(^|[&|;]\s*)(shutdown|reboot|poweroff|halt)(\s|$)/i,
  /(^|[&|;]\s*)bcdedit(\s|$)/i,
  /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+\/\*?(\s|$)/i,
  /(^|[&|;]\s*)(del|rd|rmdir)\s+(\/[a-z]\s+)+[a-z]:\\?\*?(\s|$)/i,
  /Remove-Item[^\n]*-Recurse[^\n]*([a-z]:\\|\\\\)/i,
];

function normCase(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

function isWithinWorkspace(workspace, target) {
  if (!workspace) return false;
  const rel = path.relative(normCase(workspace), normCase(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function isSystemPath(abs) {
  const target = normCase(abs);
  return SYSTEM_PREFIXES.some((prefix) => {
    const p = normCase(prefix);
    return target === p || target.startsWith(p + path.sep);
  });
}

function hardDenyCommand(command) {
  const cmd = String(command || '').replace(/\s+/g, ' ').trim();
  return HARD_DENY_COMMANDS.some((re) => re.test(cmd));
}

function realish(abs) {
  try { return fs.realpathSync.native(abs); } catch { /* 目标不存在，逐级向上解析 */ }
  let cur = abs;
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return path.join(real, ...[...rest].reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/* ── 子进程环境变量白名单 ──
 * 默认不继承主进程环境：主进程可能持有 API Key / 网关令牌（profileKeyById、MCP 密钥），
 * 一旦被 `env` 或 `echo %XXX%` 读到就等于泄漏。这里只放行「让命令能跑起来」的最小集合，
 * 需要额外变量的调用方（MCP 配置）必须显式在配置里写 env。 */

const ENV_ALLOW_WIN = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'LANG', 'LC_ALL',
];
const ENV_ALLOW_POSIX = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'USER', 'LOGNAME',
];

/**
 * 构造子进程环境：白名单 + 显式覆盖。
 * @param {object} [extra] 调用方显式提供的变量（MCP 配置 env / 测试钩子）
 */
function buildChildEnv(extra) {
  const allow = process.platform === 'win32' ? ENV_ALLOW_WIN : ENV_ALLOW_POSIX;
  const out = {};
  for (const key of allow) {
    if (process.env[key] != null) out[key] = process.env[key];
  }
  // Windows 上 PATH 可能只有 'Path' 拼写，统一兜底一份
  if (!out.PATH && out.Path) out.PATH = out.Path;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra)) {
      const name = String(k);
      if (!name || name.includes('=') || /[\0\r\n]/.test(name)) continue;
      out[name] = String(v);
    }
  }
  return out;
}

module.exports = {
  SYSTEM_PREFIXES,
  HARD_DENY_COMMANDS,
  ENV_ALLOW_WIN,
  ENV_ALLOW_POSIX,
  normCase,
  isWithinWorkspace,
  isSystemPath,
  hardDenyCommand,
  realish,
  buildChildEnv,
};
