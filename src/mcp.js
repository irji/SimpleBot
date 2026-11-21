/**
 * Minimal MCP (Model Context Protocol) server over the Streamable HTTP transport.
 *
 * Implements JSON-RPC 2.0 directly on the Worker (no SDK needed — Cloudflare
 * Workers can't run stdio-based MCP servers). Supported methods:
 *   - initialize
 *   - notifications/initialized (notification -> no response)
 *   - ping
 *   - tools/list      -> exposes the "send_message" tool
 *   - tools/call      -> executes "send_message"
 *
 * send_message(text): forwards a message to Telegram as JSON:
 *   { "text": <text argument>, "parse_mode": "MarkdownV2" }
 */

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'telegram-webhook-forwarder', version: '1.0.0' };

/**
 * Escape special MarkdownV2 characters so arbitrary plain text can be sent
 * safely with parse_mode: "MarkdownV2" without Telegram rejecting it.
 * Reference: https://core.telegram.org/api/entities#entity-types
 */
export function escapeMarkdownV2(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

const TOOLS = [
  {
    name: 'send_message',
    description:
      'Send a text message to the configured Telegram chat. The message is forwarded with parse_mode "MarkdownV2". ' +
      'Special characters are escaped automatically, so plain text always renders as typed.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Message text. MarkdownV2 special characters are auto-escaped.',
        },
      },
      required: ['text'],
    },
  },
];

export async function handleMcp(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method !== 'POST') {
    return new Response(
      'MCP endpoint expects POST (JSON-RPC 2.0). Try method "initialize" or "tools/list".\n',
      { status: 200, headers: { ...corsHeaders(), 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  let msg;
  try {
    msg = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify(rpcError(null, -32700, 'Parse error: invalid JSON')),
      { status: 200, headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  // Batch requests are allowed by JSON-RPC — handle arrays too.
  if (Array.isArray(msg)) {
    const responses = [];
    for (const m of msg) {
      const res = await processMessage(m, env);
      if (res) responses.push(res);
    }
    return new Response(JSON.stringify(responses), {
      status: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const result = await processMessage(msg, env);

  // Notifications get no response body (HTTP 202 Accepted).
  if (!result) {
    return new Response(null, { status: 202, headers: corsHeaders() });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function processMessage(msg, env) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  const method = msg && msg.method;

  if (!method) {
    // Probably a response from a client — nothing to do.
    return null;
  }

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
    case 'initialized':
      return null; // notification, no reply

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });

    case 'tools/call':
      return handleToolCall(id, msg.params || {}, env);

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleToolCall(id, params, env) {
  const toolName = params.name;
  const args = params.arguments || {};

  if (toolName !== 'send_message') {
    return rpcResult(id, toolTextError(`Unknown tool: ${toolName}. Available tools: send_message`));
  }

  const text = args.text;
  if (typeof text !== 'string' || text.length === 0) {
    return rpcResult(id, toolTextError('Missing required argument: text (non-empty string)'));
  }

  const chatId = args.chat_id || env.DEFAULT_CHAT_ID;
  if (!chatId) {
    return rpcResult(id, toolTextError('chat_id is not provided and DEFAULT_CHAT_ID is not configured'));
  }

  if (!env.BOT_TOKEN) {
    return rpcResult(id, toolTextError('Server configuration error: BOT_TOKEN secret is not set'));
  }

  // Payload exactly as requested:
  // { "text": <text argument>, "parse_mode": "MarkdownV2" }
  // Special MarkdownV2 characters are escaped automatically so the user
  // doesn't have to think about it — plain text always renders as typed.
  const tgPayload = {
    text: escapeMarkdownV2(text),
    parse_mode: 'MarkdownV2',
    chat_id: chatId,
    disable_web_page_preview: true,
  };

  try {
    const tgResponse = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tgPayload),
    });

    const tgData = await tgResponse.json().catch(() => null);

    if (!tgData || !tgData.ok) {
      const desc = tgData ? tgData.description : `Non-JSON response (HTTP ${tgResponse.status})`;
      return rpcResult(id, toolTextError(`Telegram API error: ${desc}`));
    }

    return rpcResult(id, {
      content: [
        {
          type: 'text',
          text: `Message sent successfully. message_id=${tgData.result.message_id}`,
        },
      ],
      isError: false,
    });
  } catch (err) {
    return rpcResult(id, toolTextError(`Failed to contact Telegram: ${String(err && err.message ? err.message : err)}`));
  }
}

function toolTextError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token, MCP-Session-Id, MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  };
}
