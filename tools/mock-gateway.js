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
  /* 主进程补答指令现在用 user 角色（比 system 更易被遵守），且最多两级。
     触发词匹配要跳过补答消息，否则 [[thinkonly]] 等脚本会被补答文本盖掉。 */
  const NUDGE_RE = /请立刻停止思考|不要思考、不要解释|只输出了内部思考过程/;
  const isNudgeMsg = (m) => NUDGE_RE.test(String(m?.content || ''));
  const userText = [...msgs].reverse().find((m) => m.role === 'user' && !isNudgeMsg(m))?.content
    || [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  const toolDefs = Array.isArray(body.tools) ? body.tools : [];
  const nudges = msgs.filter((m) => m.role === 'system' && String(m.content || '').includes('流程提醒')).length;
  // 主进程「只思考不出正文」的补答指令：命中说明它按预期换了一套问法
  const answerNudge = msgs.some((m) => (m.role === 'system' || m.role === 'user') && isNudgeMsg(m));
  console.log('[mock] chat msgs=%d tools=%d toolMsgs=%d nudges=%d effort=%s trigger=%s', msgs.length, toolDefs.length, toolMsgs.length, nudges, body.reasoning_effort || '-', String(userText).slice(0, 40));

  // [[effort400]] 模拟「不支持思考强度的网关」：仅当确实收到该参数时回 400。
  // 主进程应记住该接入点、去掉参数重试；不带参数的重试会走到下面的正常回复分支。
  if (String(userText).includes('[[effort400]]') && body.reasoning_effort) {
    sendJson(res, 400, { error: { message: 'unknown parameter: reasoning_effort' } });
    return;
  }

  // [[noaccounts]] 上游网关「自己」没配好：HTTP 400 但报文说的是没登录账号，与用户 key 无关。
  // [[badkey]] 对照组：真的 key 无效（401），提示应指向「地址与 key 是否同一网关」。
  if (String(userText).includes('[[noaccounts]]')) {
    sendJson(res, 400, {
      error: {
        message: 'No accounts configured. Add or sign in an account in the app first.',
        type: 'invalid_request_error',
        code: 'no_accounts',
      },
    });
    return;
  }
  if (String(userText).includes('[[badkey]]')) {
    sendJson(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });
    return;
  }
  // [[http403]] 与凭据无关的失败：验证提示不会张冠李戴。
  if (String(userText).includes('[[http403]]')) {
    sendJson(res, 403, { error: { message: 'forbidden by policy', type: 'invalid_request_error' } });
    return;
  }

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

  // 思考链边界样本：全部只给正文，不产生任何可用思考内容。
  const finishStream = (content) => {
    if (content) sse(res, { choices: [{ index: 0, delta: { content } }] });
    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse(res, { usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } });
    res.write('data: [DONE]\n\n');
    res.end();
  };
  // ① 网关完全不返回思考字段
  if (String(userText).includes('[[nothink]]')) { finishStream('这是没有思考链的正常回答。'); return; }
  // ② 思考字段为空 / null / 异常对象 / content 数组里的畸形 thinking —— 都不能被当成思考链
  if (String(userText).includes('[[emptythink]]')) {
    sse(res, { choices: [{ index: 0, delta: { reasoning_content: '', reasoning: null, thinking: {}, content: '这是空思考链下的正常回答。' } }] });
    sse(res, { choices: [{ index: 0, delta: { content: [{ type: 'thinking', thinking: { bad: 1 } }, { type: 'text', text: ' 追加正文。' }] } }] });
    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse(res, { usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  // ③ 完全无正文、也无思考链：验证兜底文案不谎称「只返回了思考过程」
  if (String(userText).includes('[[noanswer]]')) { finishStream(''); return; }
  // ④ effort 参数 400 降级后的正常回复
  if (String(userText).includes('[[effort400]]')) { finishStream('已去掉思考强度参数，正常回答。'); return; }
  // ⑤ 探针用来判断本轮是否真的下发了 reasoning_effort
  if (String(userText).includes('[[effortok]]')) {
    finishStream(body.reasoning_effort ? '收到思考强度参数' : '未收到思考强度参数');
    return;
  }

  // [[textcall]] 故障上游：不发 tool_calls，把调用写成正文并反复重写调用计划。
  // 用来验证「工具调用不再文本直出、改成卡片、本轮正常终止且不会无限刷屏」。
  if (String(userText).includes('[[textcall]]')) {
    sse(res, { choices: [{ index: 0, delta: { content: '我先看一下目录结构。' } }] });
    sse(res, { choices: [{ index: 0, delta: { content: '\n继续审计源码配置与日志。\nfunctions.read_file(path=F:/GameDev/Projects/KomorebiPass_Rebuild/Config/DefaultEngine.ini)\n' } }] });
    for (let i = 0; i < 8; i++) {
      sse(res, { choices: [{ index: 0, delta: { content: '继续审计源码配置与日志。\n' } }] });
    }
    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse(res, { usage: { prompt_tokens: 120, completion_tokens: 260, total_tokens: 380 } });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  if (toolMsgs.length) {
    // [[loop]] 故障上游：无论收到多少工具结果，都重复同一批 tool_calls。
    // 没有熔断时工具循环会永远打转；有熔断后应在连续重复时自动终止。
    if (String(userText).includes('[[loop]]')) {
      streamToolCall(res, 'read_file', { path: 'loop.txt' });
      return;
    }
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
  // 补答轮主进程会主动去掉 tools（防止模型又去调工具而不说话），这里不能误判成「工具没下发」
  if (!toolDefs.length && !forceCalls && !answerNudge) {
    // 请求里没带工具定义就回纯文本：用来证明「工具确实被下发」
    sse(res, { choices: [{ index: 0, delta: { content: '未收到工具定义，纯文本回答。' } }] });
    sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // [[think]] 推理模型：先吐 reasoning_content（若干片），再吐正文——
  // 用来验证「思考阶段的 token 不丢、正文照常出现」。
  if (String(userText).includes('[[think]]')) {
    sse(res, { choices: [{ index: 0, delta: { reasoning_content: '先拆解问题：① 读需求 ② 找文件 ③ 给结论。' } }] });
    setTimeout(() => {
      sse(res, { choices: [{ index: 0, delta: { reasoning_content: '确认没有隐含约束，可以作答。' } }] });
      sse(res, { choices: [{ index: 0, delta: { content: '这是正文回答。' } }] });
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      sse(res, { usage: { prompt_tokens: 4000, completion_tokens: 90, total_tokens: 4090, prompt_tokens_details: { cached_tokens: 3000 }, completion_tokens_details: { reasoning_tokens: 60 } } });
      res.write('data: [DONE]\n\n');
      res.end();
    }, 1500);
    return;
  }

  // [[noreply]] 无论补答几轮都只吐思考、一个正文字符都不给——
  // 验证主进程 finish() 的本机兜底答复：气泡必须有字，且不是「调用失败」。
  if (String(userText).includes('[[noreply]]')) {
    sse(res, { choices: [{ index: 0, delta: { reasoning_content: '先梳理题意，把已知条件逐条列出来……\n结论：缓存命中率等于命中 token 数除以提示 token 数。' } }] });
    setTimeout(() => {
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
      sse(res, { usage: { prompt_tokens: 800, completion_tokens: 2048, total_tokens: 2848, completion_tokens_details: { reasoning_tokens: 2048 } } });
      res.write('data: [DONE]\n\n');
      res.end();
    }, 120);
    return;
  }

  // [[thinkonly]] 推理把额度用光：只有 reasoning_content，正文为空且 finish_reason=length——
  // 复现「token 消耗了、聊天框却没字」。
  if (String(userText).includes('[[thinkonly]]')) {
    // 第二次请求带上了「直接作答」指令：这次给正文，验证主进程的补答链路真的让模型开口
    if (answerNudge) {
      sse(res, { choices: [{ index: 0, delta: { content: '这是补答的正文回答。' } }] });
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      sse(res, { usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    sse(res, { choices: [{ index: 0, delta: { reasoning_content: '这道题需要很长的推理，先把所有可能都推一遍……' } }] });
    setTimeout(() => {
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
      sse(res, { usage: { prompt_tokens: 120, completion_tokens: 4096, total_tokens: 4216, completion_tokens_details: { reasoning_tokens: 4096 } } });
      res.write('data: [DONE]\n\n');
      res.end();
    }, 250);
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
