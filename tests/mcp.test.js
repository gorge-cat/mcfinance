import test from 'node:test';
import assert from 'node:assert/strict';
import { MCDClient, MCPError, prepareArguments, extractMcpPayload } from '../lib/mcp.js';

const orderTool = { name: 'order-list', description: '订单', inputSchema: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 } }, additionalProperties: false } };

function mockClient({ tools = [orderTool], handler = () => ({ structuredContent: { orders: [] } }), listHandler } = {}) {
  const calls = [];
  const fetch = async (endpoint, options) => {
    const rpc = JSON.parse(options.body);
    calls.push({ endpoint, options, rpc });
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {} }
      : rpc.method === 'tools/list' ? (listHandler ? listHandler(rpc.params) : { tools })
        : await handler(rpc.params, rpc);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'local-test-session' } });
  };
  return { client: new MCDClient({ token: 'private-test-token', endpoint: 'https://test.invalid/mcp', fetch }), calls };
}

test('initializes MCP, sends session headers, and exposes only read-only tools', async () => {
  const { client, calls } = mockClient({ tools: [orderTool, { name: 'create-order' }, { name: 'lottery-draw' }] });
  const status = await client.connect();
  assert.equal(status.connected, true);
  assert.deepEqual(status.tools.map(tool => tool.name), ['order-list']);
  assert.equal(calls[0].rpc.method, 'initialize');
  assert.equal(calls[1].rpc.method, 'notifications/initialized');
  assert.equal(calls[1].rpc.id, undefined);
  assert.equal(calls[2].options.headers['Mcp-Session-Id'], 'local-test-session');
  assert.equal(calls[2].options.headers['MCP-Protocol-Version'], '2025-03-26');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-test-token');
  assert.equal(JSON.stringify(status).includes('private-test-token'), false);
});

test('follows tools/list pagination without exposing mutation tools', async () => {
  const { client } = mockClient({ listHandler: ({ cursor }) => cursor ? { tools: [{ name: 'query-my-account', inputSchema: { type: 'object' } }] } : { tools: [orderTool], nextCursor: 'second' } });
  assert.deepEqual((await client.connect()).tools.map(tool => tool.name), ['order-list', 'query-my-account']);
});

test('rejects all non-allowlisted tools before making a network request', async () => {
  const { client, calls } = mockClient();
  for (const name of ['create-order', 'cancel-order', 'claim-coupon', 'lottery-draw', 'fetch']) {
    await assert.rejects(client.callTool(name), error => error.code === 'TOOL_NOT_ALLOWED');
  }
  assert.equal(calls.length, 0);
});

test('uses schema defaults but never invents required order parameters', async () => {
  const tool = { name: 'order-list', inputSchema: { type: 'object', required: ['startDate', 'page'], properties: { startDate: { type: 'string' }, page: { type: 'integer', default: 1 } } } };
  assert.throws(() => prepareArguments(tool, {}), error => error.code === 'REQUIRED_TOOL_ARGUMENTS' && error.details.missing.join() === 'startDate');
  assert.deepEqual({ ...prepareArguments(tool, { startDate: '2026-10-01' }) }, { startDate: '2026-10-01', page: 1 });
  assert.throws(() => prepareArguments(orderTool, { page: 0 }), error => error.code === 'INVALID_ARGUMENTS');
  assert.throws(() => prepareArguments(orderTool, { unknown: 'value' }), error => error.code === 'INVALID_ARGUMENTS');
});

test('validates nested required parameters and types', () => {
  const tool = { name: 'order-list', inputSchema: { type: 'object', properties: { filter: { type: 'object', required: ['limit'], properties: { limit: { type: 'integer' } } } } } };
  assert.throws(() => prepareArguments(tool, { filter: {} }), error => error.details.missing[0] === 'filter.limit');
  assert.throws(() => prepareArguments(tool, { filter: { limit: '20' } }), error => error.code === 'INVALID_ARGUMENTS');
});

test('SSE parser accepts fragmented multiline events and finishes before stream closes', async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const client = new MCDClient({ token: 'secret', timeoutMs: 1000, fetch: async (_url, options) => {
    const { id } = JSON.parse(options.body);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(': keep-alive\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\n'));
        controller.enqueue(encoder.encode(`data: "id":${id},"result":{"ok":true}}\r\n\r\n`));
      },
      cancel() { cancelled = true; },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  } });
  assert.deepEqual(await client.request('tools/list', {}), { ok: true });
  assert.equal(cancelled, true);
});

test('tool failures never return upstream private error text', async () => {
  const { client } = mockClient({ handler: () => ({ isError: true, content: [{ type: 'text', text: 'secret-token user-phone=13812345678' }] }) });
  await assert.rejects(client.callTool('order-list'), error => error.code === 'TOOL_EXECUTION_ERROR' && !JSON.stringify(error).includes('13812345678') && !error.message.includes('secret-token'));
});

test('HTTP and JSON-RPC errors are sanitized', async () => {
  const client = new MCDClient({ token: 'secret', fetch: async () => new Response('private upstream message', { status: 401 }) });
  await assert.rejects(client.connect(), error => error.code === 'MCP_HTTP_ERROR' && error.status === 401 && !error.message.includes('private'));
  const rpc = new MCDClient({ token: 'secret', fetch: async (_url, options) => {
    const { id } = JSON.parse(options.body);
    return new Response(JSON.stringify({ id, error: { code: -32602, message: 'secret account id', data: 'secret' } }));
  } });
  await assert.rejects(rpc.connect(), error => error.code === 'MCP_RPC_ERROR' && error.details.rpcCode === -32602 && !error.message.includes('secret'));
});

test('business-level failure is rejected even with a successful MCP envelope', async () => {
  const { client } = mockClient({ handler: () => ({ structuredContent: { success: false, code: 400, message: 'private account detail', data: { list: [] } } }) });
  await assert.rejects(client.callTool('order-list'), error => error.code === 'TOOL_EXECUTION_ERROR' && !error.message.includes('private'));
});

test('optional tools with missing required arguments are skipped and documented', async () => {
  const { client, calls } = mockClient({ tools: [orderTool, { name: 'query-my-account', inputSchema: { type: 'object', required: ['memberId'], properties: { memberId: { type: 'string' } } } }] });
  const result = await client.sync();
  assert.equal(result.warnings.length, 3);
  assert.ok(result.warnings.some(warning => warning.includes('memberId')));
  assert.deepEqual(calls.filter(call => call.rpc.method === 'tools/call').map(call => call.rpc.params.name), ['order-list']);
});

test('extracts structured or JSON text payloads but refuses prose', () => {
  assert.deepEqual(extractMcpPayload({ structuredContent: { data: [] } }), { data: [] });
  assert.deepEqual(extractMcpPayload({ content: [{ type: 'text', text: '```json\n{"orders":[]}\n```' }] }), { orders: [] });
  assert.equal(extractMcpPayload({ content: [{ type: 'text', text: 'Here are your orders' }] }), null);
});

test('disconnect clears credentials, session state, and tool schemas', async () => {
  const { client } = mockClient();
  await client.connect();
  client.disconnect();
  assert.equal(client.getStatus().configured, false);
  assert.equal(client.getStatus().connected, false);
  assert.deepEqual(client.getStatus().tools, []);
  await assert.rejects(client.connect(), error => error instanceof MCPError && error.code === 'NOT_CONNECTED');
});

test('times out slow transports without leaking their underlying error', async () => {
  const client = new MCDClient({ token: 'secret', timeoutMs: 10, fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private transport detail')), { once: true });
  }) });
  await assert.rejects(client.connect(), error => error.code === 'MCP_TIMEOUT' && error.status === 504 && !error.message.includes('private'));
});

test('changing credentials cancels in-flight requests instead of completing the old connection', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const client = new MCDClient({ token: 'old-secret', fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    started();
  }) });
  const connection = client.connect();
  await ready;
  client.disconnect();
  await assert.rejects(connection, error => error.code === 'CONNECTION_CHANGED');
  assert.equal(client.getStatus().connected, false);
});

test('expired sessions are marked disconnected and can initialize a fresh session', async () => {
  const { client } = mockClient();
  await client.connect();
  const originalFetch = client.fetch;
  client.fetch = async () => new Response(null, { status: 404 });
  await assert.rejects(client.callTool('order-list'), error => error.code === 'MCP_SESSION_EXPIRED');
  assert.equal(client.getStatus().connected, false);
  let firstHeaders;
  client.fetch = (url, options) => {
    if (!firstHeaders) firstHeaders = options.headers;
    return originalFetch(url, options);
  };
  assert.equal((await client.connect()).connected, true);
  assert.equal(firstHeaders['Mcp-Session-Id'], undefined);
});
