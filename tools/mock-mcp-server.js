'use strict';

/* ─────────────────────────────────────────────
   最小 MCP stdio server（仅供自检 tools/mcp-selfcheck.js 使用）

   每行一个 JSON-RPC 2.0 消息；支持 initialize / notifications/initialized /
   tools/list / tools/call / ping。

   可选参数（测异常路径）：
     --delay-ms=N        每个响应延迟 N 毫秒（测客户端超时）
     --crash-on-tool=X   收到对工具 X 的 tools/call 时不回复并退出（测崩溃）
     --exit-immediately  启动后立即退出（测握手失败）
   ───────────────────────────────────────────── */

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const delayMs = Math.max(0, Number(arg('delay-ms')) || 0);
const crashOnTool = arg('crash-on-tool');
const exitImmediately = process.argv.includes('--exit-immediately');

const TOOLS = [
  {
    name: 'echo',
    description: '原样返回 message',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: '要回显的文本' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'add',
    description: '计算 a + b',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  {
    name: 'fail',
    description: '总是返回 isError=true（测结果规范化）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function write(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch { /* 管道已关 */ }
}

function reply(msg, result) {
  write({ jsonrpc: '2.0', id: msg.id, result });
}

function replyError(msg, code, message) {
  write({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
}

function handle(msg) {
  // 通知（无 id）不回包；请求逐个分发
  if (!msg || msg.id == null || !msg.method) return;
  switch (msg.method) {
    case 'initialize':
      reply(msg, {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '0.1.0' },
      });
      break;
    case 'tools/list':
      reply(msg, { tools: TOOLS });
      break;
    case 'tools/call': {
      const name = msg.params?.name;
      if (crashOnTool && name === crashOnTool) process.exit(3);
      const args = msg.params?.arguments || {};
      if (name === 'fail') {
        reply(msg, { content: [{ type: 'text', text: '故意失败' }], isError: true });
        break;
      }
      const text = name === 'echo' ? `echo: ${String(args.message ?? '')}`
        : name === 'add' ? `sum = ${Number(args.a) + Number(args.b)}`
          : null;
      if (text == null) reply(msg, { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true });
      else reply(msg, { content: [{ type: 'text', text }], isError: false });
      break;
    }
    case 'ping':
      reply(msg, {});
      break;
    default:
      replyError(msg, -32601, `Method not found: ${msg.method}`);
  }
}

if (exitImmediately) process.exit(7);

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (delayMs > 0) setTimeout(() => handle(msg), delayMs);
    else handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
