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

module.exports = {
  SYSTEM_PREFIXES,
  HARD_DENY_COMMANDS,
  normCase,
  isWithinWorkspace,
  isSystemPath,
  hardDenyCommand,
  realish,
};
