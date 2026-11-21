/**
 * Local smoke test for the worker (no wrangler needed).
 * Run: node test-local.mjs
 */
import worker from './src/index.js';

const env = {
  SENDER_TOKEN: 'test-sender-token',
  BOT_TOKEN: 'test-bot-token',
  DEFAULT_CHAT_ID: '-1001234567890',
};

// Mock Telegram API so we can inspect what the worker sends.
const sentToTelegram = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  sentToTelegram.push({ url, body });
  return new Response(
    JSON.stringify({ ok: true, result: { message_id: 42 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.error(`FAIL  ${name}`, extra ?? ''); }
}

async function rpc(method, params, id = 1, headers = {}) {
  const res = await worker.fetch(
    new Request('https://example.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-sender-token', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }),
    env,
    {}
  );
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, json, text };
}

// 1. Health-check still works
{
  const res = await worker.fetch(new Request('https://example.com/'), env, {});
  check('GET / health-check', res.status === 200);
}

// 2. /message still works
{
  const res = await worker.fetch(
    new Request('https://example.com/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-sender-token' },
      body: JSON.stringify({ text: 'hello from n8n' }),
    }),
    env,
    {}
  );
  const j = await res.json();
  check('POST /message ok', res.status === 200 && j.ok === true, j);
}

// 3. MCP without token -> 401
{
  const res = await worker.fetch(
    new Request('https://example.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    }),
    env,
    {}
  );
  check('MCP unauthorized -> 401', res.status === 401);
}

// 4. initialize
{
  const r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  check('MCP initialize', r.status === 200 && r.json?.result?.serverInfo?.name === 'telegram-webhook-forwarder', r.text);
}

// 5. tools/list exposes send_message
{
  const r = await rpc('tools/list');
  const tool = r.json?.result?.tools?.[0];
  check('MCP tools/list has send_message', tool?.name === 'send_message', r.text);
  check('MCP tool schema requires text', tool?.inputSchema?.required?.includes('text'), r.text);
}

// 6. tools/call send_message -> payload to Telegram contains parse_mode MarkdownV2
{
  sentToTelegram.length = 0;
  const r = await rpc('tools/call', { name: 'send_message', arguments: { text: '*bold* text' } });
  const ok = r.status === 200 && r.json?.result?.isError === false;
  check('MCP tools/call success', ok, r.text);
  const tg = sentToTelegram[sentToTelegram.length - 1];
  check('TG payload text', tg?.body?.text === '*bold* text', tg?.body);
  check('TG payload parse_mode=MarkdownV2', tg?.body?.parse_mode === 'MarkdownV2', tg?.body);
  check('TG payload chat_id', tg?.body?.chat_id === env.DEFAULT_CHAT_ID, tg?.body);
}

// 7. tools/call missing text -> isError
{
  const r = await rpc('tools/call', { name: 'send_message', arguments: {} });
  check('MCP missing text -> isError', r.json?.result?.isError === true, r.text);
}

// 8. unknown tool -> isError
{
  const r = await rpc('tools/call', { name: 'nope', arguments: { text: 'x' } });
  check('MCP unknown tool -> isError', r.json?.result?.isError === true, r.text);
}

// 9. unknown method -> JSON-RPC error -32601
{
  const r = await rpc('resources/list');
  check('MCP unknown method -> -32601', r.json?.error?.code === -32601, r.text);
}

// 10. notification -> 202, no body
{
  const res = await worker.fetch(
    new Request('https://example.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-sender-token' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }),
    env,
    {}
  );
  check('MCP notification -> 202', res.status === 202);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
