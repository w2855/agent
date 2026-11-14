'use strict';

/* 本地 mock 网关：只用于自检工具调用链路。
   - GET  /v1/models            返回两个假模型
   - POST /v1/chat/completions  SSE；首轮按触发词回 tool_calls，带 tool 结果后回文本
   工具调用分三片下发，用来验证主进程按 index 合并参数片段。 */

const http = require('node:http');

const PORT = Number(process.env.MOCK_PORT || 57321);
const HOST = '127.0.0.1';

function sendJson(res, code, body) {
  const raw = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(raw) });
  res.end(raw);
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function streamToolCall(res, name, args) {
  const argStr = JSON.stringify(args);
  const cut1 = Math.max(1, Math.floor(argStr.length / 3));
  const cut2 = Math.max(cut1 + 1, Math.floor((argStr.length * 2) / 3));

  sse(res, {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        content: '',
        tool_calls: [{ index: 0, id: 'call_mock_' + Date.now(), type: 'function', function: { name, arguments: '' } }],
      },
    }],
  });
  sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(0, cut1) } }] } }] });
  sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(cut1, cut2) } }] } }] });
  sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(cut2) } }] } }] });
  sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

const TODO_INITIAL = [
  { content: '读取现有实现', status: 'completed' },
  { content: '补齐工具调用', status: 'in_progress' },
  { content: '回归验证', status: 'pending' },
];
const TODO_DONE = TODO_INITIAL.map((t) => ({ ...t, status: 'completed' }));

const ARCH_ARGS = {
  goal: '做一个可联机的像素风塔防游戏，先完成单机核心循环。',
  nodes: [
    { id: 'game-loop', label: '游戏主循环', layer: 'domain', kind: 'module', path: 'src/game', description: '固定步长循环、场景与状态机' },
    { id: 'render', label: '渲染层', layer: 'experience', kind: 'component', path: 'src/render', description: '地图、单位与特效绘制' },
    { id: 'input', label: '输入控制', layer: 'experience', kind: 'component', path: 'src/input', description: '键鼠与触控输入' },
    { id: 'tower-rules', label: '塔防规则', layer: 'domain', kind: 'service', path: 'src/rules', description: '寻路、伤害与波次' },
    { id: 'network', label: '联机同步', layer: 'application', kind: 'service', path: 'src/net', description: '房间与状态同步' },
    { id: 'save', label: '存档数据', layer: 'data', kind: 'data', path: 'src/save', description: '本地进度与配置' },
    { id: 'asset-pipeline', label: '资源管线', layer: 'platform', kind: 'asset', path: 'assets', description: '纹理、音频与打包' },
    { id: 'gateway', label: '游戏服务端', layer: 'external', kind: 'external', description: '联机对战服务' },
  ],
  edges: [
    { from: '游戏主循环', to: '渲染层', kind: 'calls' },
    { from: '游戏主循环', to: '塔防规则', kind: 'calls' },
    { from: '输入控制', to: '游戏主循环', kind: 'emits', label: '指令' },
    { from: '塔防规则', to: '存档数据', kind: 'writes' },
    { from: '联机同步', to: '游戏主循环', kind: 'emits', label: '帧输入' },
    { from: '联机同步', to: '游戏服务端', kind: 'calls' },
    { from: '渲染层', to: '资源管线', kind: 'reads' },
  ],
  milestones: [
    { label: '单机核心循环可玩', status: 'in_progress' },
    { label: '联机同步与房间', status: 'planned' },
  ],
};

/* 子 Agent 执行器使用非流式请求；mock 需要同时支持两种模式。 */
function handleNonStream(body, res) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const userText = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  const isChildWrite = String(userText).includes('[[child-write]]');
  const delegateMatch = String(userText).match(/\[\[delegate:([A-Za-z0-9_]+)\]\]/);
  let message = { role: 'assistant', content: '' };
  let finish = 'stop';
  if (!toolMsgs.length && isChildWrite) {
    message = {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_mock_ns_' + Date.now(),
        type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'delegated-e2e.txt', content: 'delegated-ok' }) },
      }],
    };
    finish = 'tool_calls';
  } else if (!toolMsgs.length && delegateMatch) {
    message = {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_mock_ns_' + Date.now(),
        type: 'function',
        function: {
          name: 'delegate_task',
          arguments: JSON.stringify({
            agentId: delegateMatch[1],
            objective: '[[child-write]] 在工作区写入 delegated-e2e.txt，内容为 delegated-ok。',
            expectedOutput: '文件存在且内容为 delegated-ok，返回写入结果。',
          }),
        },
      }],
    };
    finish = 'tool_calls';
  } else {
    const content = toolMsgs.map((m) => String(m.content || '')).join(' | ').slice(0, 300);
    message = { role: 'assistant', content: '已收到工具结果：' + content };
  }
  sendJson(res, 200, {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
  });
}

function handleChat(body, res) {
  if (body && body.stream === false) return handleNonStream(body, res);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const userText = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  const toolDefs = Array.isArray(body.tools) ? body.tools : [];
  const nudges = msgs.filter((m) => m.role === 'system' && String(m.content || '').includes('流程提醒')).length;
  console.log('[mock] chat msgs=%d tools=%d toolMsgs=%d nudges=%d effort=%s trigger=%s', msgs.length, toolDefs.length, toolMsgs.length, nudges, body.reasoning_effort || '-', String(userText).slice(0, 40));

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const isTodoUpdate = String(userText).includes('[[todo-update');
  const isMany = String(userText).includes('[[many');
  const isTamper = String(userText).includes('[[tamper');
  const isNarr = String(userText).includes('[[narr');
  const delegateMatch = String(userText).match(/\[\[delegate:([A-Za-z0-9_]+)\]\]/);
  const isDelegate = !!delegateMatch;
  const isChildWrite = String(userText).includes('[[child-write]]');

  if (toolMsgs.length) {
    // [[narrslow]] 多步慢速：工具落定后 3 秒间隙（模拟真实 API 首 token 延迟）再播报第二步——
    // 供「工具调用中途不说话」实时渲染探针逐帧抓 DOM：模型文字到达时界面必须同步出现
    if (String(userText).includes('[[narrslow]]')) {
      if (toolMsgs.length === 1) {
        setTimeout(() => {
          sse(res, { choices: [{ index: 0, delta: { content: '第二步：再核对文件内容。' } }] });
          streamToolCall(res, 'read_file', { path: 'dsh-tool-e2e.txt' });
        }, 3000);
        return; // 3 秒间隙：响应挂起，什么都不发
      }
      if (toolMsgs.length >= 2) {
        const content2 = toolMsgs.map((m) => String(m.content || '')).join(' | ').slice(0, 200);
        sse(res, { choices: [{ index: 0, delta: { content: '收尾：' + content2 } }] });
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse(res, { usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    }
    // 连续调用 20 次后再收尾，用于验证工具调用没有次数上限
    if (isMany && toolMsgs.length < 20) {
      return streamToolCall(res, 'list_dir', { path: '.' });
    }
    // 同一回合里第二次 todo_write：把清单全部置为已完成
    if (isTodoUpdate && toolMsgs.length === 1) {
      return streamToolCall(res, 'todo_write', { tasks: TODO_DONE });
    }
    // [[narr]] 第二步工具：也先播报一句再调用，供渲染层「正文去重/叙述行退让」断言
    if (isNarr && toolMsgs.length === 1) {
      sse(res, { choices: [{ index: 0, delta: { content: '再读一下文件内容。' } }] });
      return streamToolCall(res, 'read_file', { path: 'dsh-tool-e2e.txt' });
    }
    const content = toolMsgs.map((m) => String(m.content || '')).join(' | ').slice(0, 300);
    const finishTurn = () => {
      for (const part of ['已收到工具结果：', content]) {
        sse(res, { choices: [{ index: 0, delta: { content: part } }] });
      }
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      sse(res, { usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    // 给 E2E 留出篡改产物的时间，验证收尾时的后置校验
    if (isTamper) { setTimeout(finishTurn, 1800); return; }
    finishTurn();
    return;
  }

  const forceCalls = String(userText).includes('[[force');
  if (!toolDefs.length && !forceCalls) {
    // 请求里没带工具定义就回纯文本：用来证明「工具确实被下发」
    sse(res, { choices: [{ index: 0, delta: { content: '未收到工具定义，纯文本回答。' } }] });
    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // [[slow]] 分片慢流：纯文本、无工具调用，按 130ms 一片慢慢吐——
  // 供会话级并行探针（g5-probe.js）断言「后台会话的 draft.body 持续增长」。
  // 总时长 ≈ chunks × 130ms；不支持并发复用同一连接（每请求独立 setInterval）。
  if (String(userText).includes('[[slow')) {
    const chunks = 60;
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      sse(res, { choices: [{ index: 0, delta: { content: `后台分片 ${i}。` } }] });
      if (i >= chunks) {
        clearInterval(timer);
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse(res, { usage: { prompt_tokens: 12, completion_tokens: 260, total_tokens: 272 } });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, 130);
    // 客户端提前断开（超时/中断）时停表，避免句柄泄漏
    res.on('close', () => clearInterval(timer));
    return;
  }

  if (isTodoUpdate) {
    return streamToolCall(res, 'todo_write', { tasks: TODO_INITIAL });
  }

  // [[narr]] 第一步：先流式播报一句，再发起工具调用——模拟「调用工具前先说一句话」的模型行为
  if (isNarr) {
    sse(res, { choices: [{ index: 0, delta: { content: '先看一下目录结构。' } }] });
    return streamToolCall(res, 'list_dir', { path: '.' });
  }

  if (String(userText).includes('[[arch')) {
    return streamToolCall(res, 'project_architecture', ARCH_ARGS);
  }

  let name = 'list_dir';
  let args = { path: '.' };
  if (isDelegate) {
    return streamToolCall(res, 'delegate_task', {
      agentId: delegateMatch[1],
      objective: '[[child-write]] 在工作区写入 delegated-e2e.txt，内容为 delegated-ok。',
      expectedOutput: '文件存在且内容为 delegated-ok，返回写入结果。',
    });
  }
  if (isChildWrite) {
    name = 'write_file';
    args = { path: 'delegated-e2e.txt', content: 'delegated-ok' };
  } else if (isTamper) {
    name = 'write_file';
    args = { path: 'dsh-validate-e2e.txt', content: 'validated-content' };
  } else if (String(userText).includes('[[write')) {
    name = 'write_file';
    args = { path: 'dsh-tool-e2e.txt', content: 'tool-call-ok' };
  } else if (String(userText).includes('[[read')) {
    name = 'read_file';
    args = { path: 'dsh-tool-e2e.txt' };
  }
  return streamToolCall(res, name, args);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return sendJson(res, 200, {
      object: 'list',
      data: [
        { id: 'mock-tool-model', object: 'model', owned_by: 'mock' },
        { id: 'mock-alt-model', object: 'model', owned_by: 'mock' },
      ],
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 交给 mock 当空请求 */ }
      handleChat(body, res);
    });
    return;
  }
  sendJson(res, 404, { error: { message: `mock 不认识 ${req.method} ${url.pathname}` } });
});

server.listen(PORT, HOST, () => console.log('[mock] listening on http://' + HOST + ':' + PORT));
