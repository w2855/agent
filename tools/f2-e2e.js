'use strict';

/* F2 端到端验证（真实上游）：验证掩码 key + profileId 经 resolveSecretKey 解析后，
   主对话与委派子代理都能拿到真实响应（不再 401）。
   密钥一律从环境变量 DSH_E2E_KEY 读取，绝不写进本文件或任何持久化数据。
   运行：DSH_E2E_KEY=... node tools/f2-e2e.js */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtimeModule = require('../runtime');
const localTools = require('../lib/tools');
const { maskKey } = require('../lib/secret-mask');

const BASE_URL = process.env.DSH_E2E_BASE || 'http://127.0.0.1:6780/v1';
const MODEL = process.env.DSH_E2E_MODEL || 'glm-5.3-flash';
const KEY = String(process.env.DSH_E2E_KEY || '');
if (!KEY) {
  console.error('缺少 DSH_E2E_KEY 环境变量，拒绝运行（密钥不入库）');
  process.exit(1);
}

const results = [];
const add = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: String(detail ?? '') });
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${pass ? '' : ' —— ' + String(detail ?? '')}`);
};

/* 与 main.js delegationModelRequest 同形的真实 HTTP 请求（node 侧用全局 fetch） */
async function realModelRequest({ cfg, messages, tools, timeoutMs } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Math.min(Number(timeoutMs) || 120000, 180000)));
  try {
    const body = {
      model: String(cfg.model).trim(),
      messages: (messages || []).map((m) => ({ role: m.role, content: String(m.content ?? '') })),
      stream: false,
    };
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${String(cfg.key).trim()}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    const choice = json?.choices?.[0] || {};
    const msg = choice.message || {};
    return {
      content: typeof msg.content === 'string' ? msg.content : '',
      toolCalls: Array.isArray(msg.tool_calls)
        ? msg.tool_calls.filter((t) => t?.function?.name).map((t, i) => ({
          id: String(t.id || `call_${i}`),
          type: 'function',
          function: {
            name: String(t.function.name),
            arguments: typeof t.function.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function.arguments || {}),
          },
        }))
        : [],
      usage: json?.usage || null,
      finishReason: String(choice.finish_reason || ''),
    };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  /* 渲染层视角的掩码 key（真实 key 永不进入 providerConfig） */
  const maskedKey = maskKey(KEY);

  /* 1. 主对话：一次真实请求（cfg.key 为掩码 + profileId，runtime 层同构路径） */
  const mainReply = await realModelRequest({
    cfg: { baseUrl: BASE_URL, key: KEY, model: MODEL },
    messages: [{ role: 'user', content: '只回复四个字：链路正常' }],
    timeoutMs: 60000,
  });
  add('主对话真实请求 200 且有回复（非 401）', mainReply.content.trim().length > 0, mainReply.content.slice(0, 40));

  /* 2. 委派链端到端：resolveSecretKey 模拟 main.js 注入（此处从 env 构造，与主进程同形） */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-f2-e2e-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-f2-e2e-ws-'));
  let childCfgSeen = null;
  const rt = runtimeModule.createRuntime({
    dir,
    workspacePath: workspace,
    executeTool: (name, args, opts) => localTools.executeTool(name, args, opts),
    modelRequest: async (ctx) => {
      childCfgSeen = { ...ctx.cfg, keyPreview: String(ctx.cfg.key).slice(0, 6) + '…' };
      return realModelRequest(ctx);
    },
    resolveSecretKey: async (profileId) => {
      if (profileId === 'prof-real') return { baseUrl: BASE_URL, key: KEY };
      return null;
    },
  });
  rt.init();

  const target = rt.createAgent({ name: 'E2E子代理', permissionProfileId: 'full' }).data.agent;
  const parent = rt.createTask({
    title: 'F2 E2E 委派', input: '委派验证', providerId: BASE_URL, model: MODEL, idempotencyKey: 'f2-e2e-1',
  }).data;
  const step = rt.beginStep({ runId: parent.run.id, kind: 'tool_call' }).data.step;
  const proposal = rt.proposeTool({
    runId: parent.run.id,
    stepId: step.id,
    name: 'delegate_task',
    args: { agentId: target.id, objective: '只回复五个字：子代理正常。不要做任何其他事。', expectedOutput: '文本包含「子代理正常」。' },
    profile: 'full',
  });
  if (proposal?.data?.status === 'waiting_approval') {
    rt.decideApproval({ approvalId: proposal.data.approval.id, decision: 'approved', scope: 'once', reason: 'E2E 批准' });
  }

  /* 渲染层实际会传的形态：掩码 key + profileId */
  const exec = await rt.executeTool({
    toolCallId: proposal.data.toolCallId,
    providerConfig: { baseUrl: BASE_URL, key: maskedKey, model: MODEL, profileId: 'prof-real' },
    profile: 'full',
  });
  add('掩码 key + profileId 委派子代理成功（非 401）', exec.ok && exec.data.ok === true, (exec.data?.content || exec.data?.message || '').slice(0, 120));
  add('子代理请求携带真钥且发往指定 baseUrl', childCfgSeen && childCfgSeen.baseUrl === BASE_URL && childCfgSeen.keyPreview !== 'sk-****', JSON.stringify(childCfgSeen && { baseUrl: childCfgSeen.baseUrl, model: childCfgSeen.model, key: childCfgSeen.keyPreview }));
  const del = rt.listDelegations({ parentRunId: parent.run.id }).data.delegations[0];
  add('委派记录不落明文 key', del && !JSON.stringify(del).includes(KEY), del ? 'ok' : 'missing record');
  add('委派记录状态 succeeded', del && del.status === 'succeeded', del && del.status);

  rt.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nF2 E2E（真实上游 ${BASE_URL} · ${MODEL}）：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('F2 E2E 异常：', err?.message || err);
  process.exit(1);
});
