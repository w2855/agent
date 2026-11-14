'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  HARD_DENY_COMMANDS,
  normCase,
  isWithinWorkspace,
  isSystemPath,
  hardDenyCommand,
  realish,
} = require('../lib/safety');
const { getManifest } = require('./tool-registry');
const { isPrivateHostname } = require('../lib/net-safety');

/* Policy Engine v1：三档预设 + 硬拒绝 + 工作区边界 + action_hash。
   规则以 docs/security/policy-model.md 为准。 */

const RISK_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function actionHash(parts) {
  return 'sha256:' + sha256(canonicalJson({
    v: 1,
    workspaceId: parts.workspaceId,
    agentId: parts.agentId,
    tool: parts.tool,
    version: parts.version,
    args: parts.args,
    resourceKey: parts.resourceKey,
  }));
}

const PATH_TOOLS = new Set(['list_dir', 'read_file', 'write_file', 'edit_file', 'search_files', 'find_files']);

/* 下载后执行检测：三条均为线性正则（无嵌套量词），匹配前做与 hardDenyCommand
   一致的空白归一化（\s+ → 单空格），避免 tab/换行变体绕过。
   1) DOWNLOAD_EXEC_PIPE：curl/wget/iwr 等直连管道交给 shell（含 sudo、iex 变体）；
   2) DOWNLOAD_OUT_TO_EXEC：curl -o/--output、wget -O/--output-document 把网络内容
      写成可执行文件（后续执行是必然动作，写入即视为下载执行）；
   3) POWERSHELL_DOWNLOAD_EXEC：iex/Invoke-Expression 与下载源同现。 */
const DOWNLOAD_EXEC_PIPE = /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod|irm)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ash|powershell|pwsh|cmd|iex|invoke-expression)\b/i;
const DOWNLOAD_OUT_TO_EXEC = /\b(?:curl|wget)\b[^\n]*\s-{1,2}(?:output-document|output|remote-name|O|o)(?:=|\s|(?=[^\s-]))["']?[^\s"'|;&<>]*?\.(?:exe|bat|cmd|ps1|sh|dll|msi|scr|vbs)(?=[\s"'|;&<>]|$)/i;
const POWERSHELL_DOWNLOAD_EXEC = /\b(?:iex|invoke-expression)\b[^\n]*\b(?:iwr|invoke-webrequest|invoke-restmethod|irm|webclient|downloadstring|downloadfile|curl|wget)\b/i;

function isDownloadExecCommand(command) {
  const cmd = String(command || '').replace(/\s+/g, ' ').trim();
  if (!cmd) return false;
  return DOWNLOAD_EXEC_PIPE.test(cmd) || DOWNLOAD_OUT_TO_EXEC.test(cmd) || POWERSHELL_DOWNLOAD_EXEC.test(cmd);
}
const SECRET_FILE = /(^|[\\/])(\.env(\.\w+)?|id_rsa|id_ed25519|credentials(\.json)?|\.npmrc|\.pypirc|[^\\/]+\.(pem|key|p12))$/i;
const EXECUTABLE_FILE = /\.(exe|bat|cmd|ps1|sh|dll|msi|scr|vbs)$/i;

function resolvePath(input, workspace) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new Error('缺少路径参数');
  if (raw.includes('\0')) throw new Error('路径包含非法字符');
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workspace, raw);
  return realish(abs);
}

function isSecretPath(abs) {
  return SECRET_FILE.test(String(abs || ''));
}

function normalizeCommand(command) {
  return String(command || '').trim();
}

function normalizeUrl(input) {
  const url = new URL(String(input || ''));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https URL');
  if (isPrivateUrlHost(url.hostname)) throw new Error('禁止访问本机与内网地址（SSRF 防护）');
  return { href: url.href, key: `url:${url.host.toLowerCase()}${url.pathname}` };
}

/* 与 lib/net-safety 同一套判定：策略层只能做同步的「语法 + 字面量 IP」检查，
   DNS 解析与逐跳重定向校验在执行层（lib/net-safety.safeFetch）完成。
   两层都拦，避免策略放行、执行层单独承担全部风险。 */
function isPrivateUrlHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  // isPrivateHostname 内部已覆盖「字面量 IP → 私有段判定」，域名只做语法/后缀拦截
  return isPrivateHostname(host);
}

function elevateRisk(base, extra) {
  return (RISK_RANK[extra] || 0) > (RISK_RANK[base] || 0) ? extra : base;
}

function makeDecision(input, fields) {
  return {
    decision: fields.decision,
    ruleIds: fields.ruleIds,
    riskLevel: fields.riskLevel,
    reason: fields.reason,
    resourceKey: fields.resourceKey,
    actionHash: fields.actionHash,
    sideEffect: fields.sideEffect,
    toolVersion: fields.toolVersion,
    approvalScope: fields.decision === 'require_approval' ? 'once' : undefined,
  };
}

/**
 * @param {{
 *  profile: 'full'|'ask'|'readonly',
 *  tool: string,
 *  args: object,
 *  workspace: string,
 *  workspaceId?: string,
 *  agentId?: string,
 *  runId?: string,
 *  context?: { priorSensitiveRead?: boolean }
 * }} input
 */
function evaluatePolicy(input) {
  const profile = ['full', 'ask', 'readonly'].includes(input?.profile) ? input.profile : 'ask';
  const tool = String(input?.tool || '');
  const args = input?.args && typeof input.args === 'object' ? input.args : {};
  const workspace = realish(path.resolve(input?.workspace || process.cwd()));
  const workspaceId = input?.workspaceId || 'ws_unknown';
  const agentId = input?.agentId || 'agent_local';
  const runId = input?.runId;

  const manifest = getManifest(tool);
  if (!manifest) {
    const resourceKey = 'unknown';
    return makeDecision(input, {
      decision: 'deny', ruleIds: ['unknown-tool'], riskLevel: 'high',
      reason: `未注册的工具：${tool}`, resourceKey,
      actionHash: actionHash({ workspaceId, agentId, tool, version: '0', args, resourceKey }),
      sideEffect: 'external', toolVersion: '0',
    });
  }

  let normalizedArgs = args;
  let resourceKey = 'none';
  let targetPath = null;
  let risk = manifest.risk;
  let ruleIds = [];
  let reason = '';
  const baseRules = [];

  try {
    if (PATH_TOOLS.has(tool)) {
      const rawPath = args.path ?? (tool === 'list_dir' || tool === 'search_files' || tool === 'find_files' ? '.' : '');
      targetPath = resolvePath(rawPath, workspace);
      normalizedArgs = { ...args, path: targetPath };
      const rel = path.relative(workspace, targetPath);
      resourceKey = isWithinWorkspace(workspace, targetPath)
        ? `path:${rel ? rel.split(path.sep).join('/') : '.'}`
        : `path:out:${sha256(targetPath)}`;
      if (tool === 'read_file' && SECRET_FILE.test(targetPath)) risk = elevateRisk(risk, 'high');
      if ((tool === 'write_file' || tool === 'edit_file') && EXECUTABLE_FILE.test(targetPath)) risk = elevateRisk(risk, 'high');
      if (manifest.sideEffect === 'read' && !isWithinWorkspace(workspace, targetPath)) {
        baseRules.push('out-of-workspace-read');
        risk = elevateRisk(risk, 'medium');
      }
    } else if (tool === 'run_command') {
      const command = normalizeCommand(args.command);
      normalizedArgs = { ...args, command };
      resourceKey = `cmd:${sha256(command)}`;
      if (isDownloadExecCommand(command)) risk = elevateRisk(risk, 'critical');
    } else if (tool === 'fetch_url') {
      const url = normalizeUrl(args.url);
      normalizedArgs = { ...args, url: url.href };
      resourceKey = url.key;
    } else if (tool === 'todo_write') {
      resourceKey = `run:${runId || 'unknown'}:tasks`;
    } else if (tool === 'delegate_task') {
      resourceKey = `agent:${String(args.agentId || '').slice(0, 80)}`;
      /* workspaceOnly 声明：workspace 相关参数（contextRefs 共享文件路径）必须落在
         工作区内。delegation.js 只在执行时校验，这里在策略层提前拒绝越界共享。 */
      if (manifest.resource.workspaceOnly && Array.isArray(args.contextRefs)) {
        for (const raw of args.contextRefs) {
          const value = String(raw || '').trim();
          if (!value) continue;
          if (!isWithinWorkspace(workspace, resolvePath(value, workspace))) {
            throw new Error(`共享文件必须位于工作区内：${value}`);
          }
        }
      }
    } else if (tool === 'project_architecture') {
      resourceKey = `project:${sha256(workspace).slice(0, 16)}`;
    }
  } catch (err) {
    const key = 'invalid-resource';
    return makeDecision(input, {
      decision: 'deny', ruleIds: ['invalid-resource'], riskLevel: 'high',
      reason: `资源参数不合法：${err.message}`, resourceKey: key,
      actionHash: actionHash({ workspaceId, agentId, tool, version: manifest.version, args, resourceKey: key }),
      sideEffect: manifest.sideEffect, toolVersion: manifest.version,
    });
  }

  const hash = actionHash({
    workspaceId, agentId, tool, version: manifest.version,
    args: normalizedArgs, resourceKey,
  });

  const deny = (rule, why, level = risk) => makeDecision(input, {
    decision: 'deny', ruleIds: [...baseRules, rule], riskLevel: level, reason: why,
    resourceKey, actionHash: hash, sideEffect: manifest.sideEffect, toolVersion: manifest.version,
  });
  const ask = (rule, why, level = risk) => makeDecision(input, {
    decision: 'require_approval', ruleIds: [...baseRules, rule], riskLevel: level, reason: why,
    resourceKey, actionHash: hash, sideEffect: manifest.sideEffect, toolVersion: manifest.version,
  });
  const allow = (rule, why, level = risk) => makeDecision(input, {
    decision: 'allow', ruleIds: [...baseRules, rule], riskLevel: level, reason: why,
    resourceKey, actionHash: hash, sideEffect: manifest.sideEffect, toolVersion: manifest.version,
  });

  /* 1. 硬拒绝（任何档位） */
  if (manifest.sideEffect === 'process_exec' && hardDenyCommand(normalizedArgs.command)) {
    return deny('hard-deny-command', '该命令属于灾难性操作，任何权限档位都不允许执行', 'critical');
  }
  if (manifest.sideEffect === 'local_write' && targetPath && isSystemPath(targetPath)) {
    return deny('hard-deny-system-path', '禁止写入系统目录', 'critical');
  }
  if (manifest.sideEffect === 'local_write' && targetPath && !isWithinWorkspace(workspace, targetPath)) {
    return deny('workspace-boundary', '写操作必须位于工作区内', 'high');
  }

  /* 2. 敏感读取后的联网调用 */
  if (manifest.sideEffect === 'network' && input?.context?.priorSensitiveRead) {
    ruleIds = ['exfil-combination'];
    reason = '本轮刚读取过敏感文件，联网请求需要额外确认';
    if (profile === 'readonly') return deny('exfil-combination', '只读模式下禁止敏感读取后联网', 'critical');
    if (profile === 'ask') return ask('exfil-combination', reason, 'high');
    return allow('exfil-combination', '完全权限下允许，但风险已提升', 'critical');
  }

  /* 3. 委派：本身高风险，只读档禁止，其余档位都要显式确认 */
  if (tool === 'delegate_task') {
    if (profile === 'readonly') {
      return deny('readonly-delegation', '只读模式不允许委派子 Agent', 'high');
    }
    return ask('delegation-approval', '委派子 Agent 会启动一段独立的自主执行，需要确认', 'high');
  }

  /* 项目架构会持久化项目元数据，只读档不允许修改 */
  if (tool === 'project_architecture' && profile === 'readonly') {
    return deny('readonly-project', '只读模式不允许修改项目整体架构', 'medium');
  }

  /* 4. 档位预设 */
  const gated = manifest.sideEffect === 'local_write' || manifest.sideEffect === 'process_exec';
  if (profile === 'readonly') {
    if (gated) return deny('readonly-deny', `只读模式不允许 ${tool}`, 'high');
    return allow('readonly-allow', '只读模式允许读取、搜索与联网');
  }
  if (profile === 'ask') {
    if (gated) return ask('ask-approval', `每次询问模式：执行 ${tool} 前需要确认`, risk);
    return allow('ask-allow', '读取、搜索与联网在每次询问模式下直接允许');
  }
  return allow('full-allow', '完全权限：允许执行注册工具');
}

const PROFILE_RULES = {
  full: ['full-allow', 'hard-deny-command', 'hard-deny-system-path', 'workspace-boundary'],
  ask: ['ask-allow', 'ask-approval', 'hard-deny-command', 'hard-deny-system-path', 'workspace-boundary'],
  readonly: ['readonly-allow', 'readonly-deny', 'hard-deny-command', 'hard-deny-system-path', 'workspace-boundary'],
};

const PROFILE_RANK = { full: 0, ask: 1, readonly: 2 };

/** Agent 配置只能收紧用户权限，不能放大。 */
function stricterProfile(userProfile, agentProfile) {
  const a = ['full', 'ask', 'readonly'].includes(userProfile) ? userProfile : 'ask';
  const b = ['full', 'ask', 'readonly'].includes(agentProfile) ? agentProfile : 'full';
  return PROFILE_RANK[a] >= PROFILE_RANK[b] ? a : b;
}

module.exports = {
  RISK_RANK,
  PROFILE_RULES,
  PROFILE_RANK,
  stricterProfile,
  HARD_DENY_COMMANDS,
  canonicalJson,
  actionHash,
  evaluatePolicy,
  resolvePath,
  isWithinWorkspace,
  isSystemPath,
  hardDenyCommand,
  isSecretPath,
  normalizeUrl,
  sha256,
};
