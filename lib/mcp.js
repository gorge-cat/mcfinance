/** Read-only client for the official McDonald's Streamable HTTP MCP service. */
export const MCP_ENDPOINT = 'https://mcp.mcd.cn';
export const READ_ONLY_TOOLS = Object.freeze(['order-list', 'query-my-account', 'query-my-coupons', 'available-coupons']);
const ALLOWED = new Set(READ_ONLY_TOOLS);
const PROTOCOL_VERSION = '2025-03-26';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class MCPError extends Error {
  constructor(message, { code = 'MCP_ERROR', status = 502, details } = {}) {
    super(message);
    this.name = 'MCPError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => JSON.parse(JSON.stringify(value));

function schemaTypeMatches(value, type) {
  if (Array.isArray(type)) return type.some(item => schemaTypeMatches(value, item));
  if (type === 'object') return isObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

/** Fill only published defaults, and require the caller to supply every other required value. */
export function prepareArguments(tool, input = {}) {
  if (!isObject(input)) throw new MCPError('工具参数必须是 JSON 对象。', { code: 'INVALID_ARGUMENTS', status: 400 });
  const missing = [];
  const invalid = [];
  const visit = (value, schema, path) => {
    if (!isObject(schema)) return value;
    if (schema.type && !schemaTypeMatches(value, schema.type)) {
      invalid.push(`${path || '参数'} 类型不符合 ${[].concat(schema.type).join('/')}`);
      return value;
    }
    if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) invalid.push(`${path} 不在允许值中`);
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) invalid.push(`${path} 小于最小值`);
      if (typeof schema.maximum === 'number' && value > schema.maximum) invalid.push(`${path} 大于最大值`);
    }
    if (typeof value === 'string') {
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) invalid.push(`${path} 太短`);
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) invalid.push(`${path} 太长`);
    }
    if (Array.isArray(value)) {
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) invalid.push(`${path} 项目过多`);
      return value.map((item, index) => visit(item, schema.items, `${path}[${index}]`));
    }
    if (!isObject(value)) return value;
    const output = Object.create(null);
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        invalid.push('参数包含不允许的属性');
        continue;
      }
      if (schema.additionalProperties === false && !has(properties, key)) invalid.push(`${path ? `${path}.` : ''}${key} 不是已公布的参数`);
      output[key] = visit(value[key], properties[key], path ? `${path}.${key}` : key);
    }
    for (const [key, property] of Object.entries(properties)) {
      if (!has(output, key) && isObject(property) && has(property, 'default')) output[key] = visit(clone(property.default), property, path ? `${path}.${key}` : key);
    }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!has(output, key)) missing.push(path ? `${path}.${key}` : key);
    }
    return output;
  };
  const result = visit(input, tool.inputSchema || { type: 'object' }, '');
  if (missing.length || invalid.length) {
    throw new MCPError(missing.length ? `请按官方工具定义填写必填参数：${missing.join('、')}。` : `工具参数无效：${invalid.join('；')}。`, {
      code: missing.length ? 'REQUIRED_TOOL_ARGUMENTS' : 'INVALID_ARGUMENTS', status: 422,
      details: { tool: tool.name, missing, invalid, inputSchema: tool.inputSchema || { type: 'object' } },
    });
  }
  return result;
}

export function extractMcpPayload(result) {
  if (isObject(result?.structuredContent) || Array.isArray(result?.structuredContent)) return result.structuredContent;
  const parsed = [];
  for (const block of result?.content || []) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    const text = block.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { parsed.push(JSON.parse(text)); } catch { /* Free-form prose is not reliable order data. */ }
  }
  if (!parsed.length) return null;
  return parsed.length === 1 ? parsed[0] : parsed;
}

async function readLimitedResponse(response, id) {
  if (!response.body?.getReader) {
    const result = await response.text();
    if (Buffer.byteLength(result) > MAX_RESPONSE_BYTES) throw new MCPError('官方服务响应过大。', { code: 'RESPONSE_TOO_LARGE' });
    return result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MCPError('官方服务响应过大。', { code: 'RESPONSE_TOO_LARGE' });
      }
      text += decoder.decode(value, { stream: true });
      if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
        const normalized = text.replace(/\r\n/g, '\n');
        const complete = normalized.slice(0, normalized.lastIndexOf('\n\n') + 2);
        if (complete) {
          try {
            parseRpcResponse(complete, 'text/event-stream', id);
            await reader.cancel();
            return complete;
          } catch (error) {
            if (error.code === 'MCP_RPC_ERROR') { await reader.cancel(); throw error; }
            // The matching response may arrive after server notifications.
          }
        }
      }
    }
  } finally { reader.releaseLock(); }
}

function parseRpcResponse(text, contentType, id) {
  let messages;
  try {
    if (contentType.includes('text/event-stream')) {
      messages = text.replace(/\r\n/g, '\n').split(/\n\n/).flatMap(event => {
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
      });
    } else {
      const parsed = JSON.parse(text);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {
    throw new MCPError('官方 MCP 返回了无法解析的响应。', { code: 'INVALID_MCP_RESPONSE' });
  }
  const message = messages.find(item => isObject(item) && item.id === id);
  if (!message) throw new MCPError('官方 MCP 响应缺少对应的请求结果。', { code: 'INVALID_MCP_RESPONSE' });
  if (message.error) throw new MCPError('官方 MCP 拒绝了请求，请检查连接或工具参数。', { code: 'MCP_RPC_ERROR', details: { rpcCode: message.error.code } });
  if (!has(message, 'result')) throw new MCPError('官方 MCP 响应缺少结果。', { code: 'INVALID_MCP_RESPONSE' });
  return message.result;
}

export class MCDClient {
  /** endpoint/fetch injection is intended for isolated tests; the HTTP API never accepts an endpoint. */
  constructor({ token = '', endpoint = MCP_ENDPOINT, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    this.endpoint = endpoint;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.token = '';
    this.nextId = 1;
    this.tools = [];
    this.sessionId = '';
    this.protocolVersion = PROTOCOL_VERSION;
    this.connected = false;
    this.connecting = null;
    this.pending = new Set();
    this.generation = 0;
    this.setToken(token);
  }

  setToken(token) {
    if (typeof token !== 'string' || token.length > 8192 || /[\r\n]/.test(token)) throw new MCPError('令牌格式无效。', { code: 'INVALID_TOKEN', status: 400 });
    this.generation += 1;
    for (const controller of this.pending) controller.abort();
    this.connecting = null;
    this.token = token.trim();
    this.connected = false;
    this.tools = [];
    this.sessionId = '';
  }

  disconnect() { this.setToken(''); }

  getStatus() {
    return {
      connected: this.connected,
      configured: Boolean(this.token),
      tools: this.tools.map(tool => ({ name: tool.name, description: tool.description || '', inputSchema: clone(tool.inputSchema || { type: 'object' }) })),
      message: this.connected ? '已连接官方 MCP，只启用查询工具。' : this.token ? '已配置令牌，等待连接。' : '尚未配置官方 MCP 令牌。',
    };
  }

  async request(method, params, { notification = false } = {}) {
    if (!this.token) throw new MCPError('请先连接官方 MCP。', { code: 'NOT_CONNECTED', status: 401 });
    const id = notification ? undefined : this.nextId++;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${this.token}` };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = this.protocolVersion;
    const controller = new AbortController();
    const generation = this.generation;
    this.pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.endpoint, { method: 'POST', redirect: 'error', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }), signal: controller.signal });
      if (generation !== this.generation) throw new MCPError('连接已变更，请重新同步。', { code: 'CONNECTION_CHANGED', status: 409 });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) this.connected = false;
        if (response.status === 404 && this.sessionId) {
          this.connected = false;
          this.sessionId = '';
          throw new MCPError('官方 MCP 会话已失效，请重新连接。', { code: 'MCP_SESSION_EXPIRED', status: 409 });
        }
        throw new MCPError(response.status === 401 || response.status === 403 ? '官方 MCP 认证失败，请检查令牌。' : `官方 MCP 请求失败（HTTP ${response.status}）。`, { code: 'MCP_HTTP_ERROR', status: response.status === 401 || response.status === 403 ? 401 : 502 });
      }
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) this.sessionId = sessionId;
      if (notification) { await response.body?.cancel(); return undefined; }
      const text = await readLimitedResponse(response, id);
      if (generation !== this.generation) throw new MCPError('连接已变更，请重新同步。', { code: 'CONNECTION_CHANGED', status: 409 });
      return parseRpcResponse(text, response.headers.get('content-type') || '', id);
    } catch (error) {
      if (error instanceof MCPError) throw error;
      if (generation !== this.generation) throw new MCPError('连接已变更，请重新同步。', { code: 'CONNECTION_CHANGED', status: 409 });
      if (controller.signal.aborted) throw new MCPError('官方 MCP 请求超时，请稍后重试。', { code: 'MCP_TIMEOUT', status: 504 });
      throw new MCPError('无法连接官方 MCP，请检查网络后重试。', { code: 'MCP_NETWORK_ERROR' });
    } finally { clearTimeout(timeout); this.pending.delete(controller); }
  }

  async connect() {
    if (this.connected) return this.getStatus();
    if (this.connecting) return this.connecting;
    const connecting = this.initialize();
    this.connecting = connecting;
    try { return await connecting; } finally { if (this.connecting === connecting) this.connecting = null; }
  }

  async initialize() {
    const generation = this.generation;
    this.sessionId = '';
    this.tools = [];
    this.protocolVersion = PROTOCOL_VERSION;
    const result = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'mcfinance-local', version: '1.0.0' } });
    if (!isObject(result) || typeof result.protocolVersion !== 'string') throw new MCPError('官方 MCP 初始化结果无效。', { code: 'INVALID_MCP_RESPONSE' });
    this.protocolVersion = result.protocolVersion;
    await this.request('notifications/initialized', undefined, { notification: true });
    const tools = [];
    let cursor;
    const cursors = new Set();
    for (let page = 0; page < 20; page += 1) {
      const listed = await this.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(listed?.tools)) throw new MCPError('官方 MCP 未返回工具定义。', { code: 'INVALID_MCP_RESPONSE' });
      tools.push(...listed.tools.filter(tool => isObject(tool) && ALLOWED.has(tool.name)));
      if (!listed.nextCursor) break;
      if (typeof listed.nextCursor !== 'string' || cursors.has(listed.nextCursor) || page === 19) throw new MCPError('官方 MCP 工具分页异常。', { code: 'INVALID_MCP_RESPONSE' });
      cursor = listed.nextCursor;
      cursors.add(cursor);
    }
    if (generation !== this.generation) throw new MCPError('连接已变更，请重新同步。', { code: 'CONNECTION_CHANGED', status: 409 });
    this.tools = tools;
    this.connected = true;
    return this.getStatus();
  }

  async callTool(name, args = {}) {
    if (!ALLOWED.has(name)) throw new MCPError('本应用仅允许查询订单、账户和优惠券。', { code: 'TOOL_NOT_ALLOWED', status: 403 });
    await this.connect();
    const tool = this.tools.find(candidate => candidate.name === name);
    if (!tool) throw new MCPError('官方 MCP 当前未提供该查询工具。', { code: 'TOOL_UNAVAILABLE', status: 422, details: { tool: name } });
    const argumentsValue = prepareArguments(tool, args);
    const result = await this.request('tools/call', { name, arguments: argumentsValue });
    if (result?.isError) throw new MCPError('官方查询工具执行失败，请检查工具参数后重试。', { code: 'TOOL_EXECUTION_ERROR', details: { tool: name } });
    const payload = extractMcpPayload(result);
    if (isObject(payload) && payload.success === false) {
      throw new MCPError('官方查询未成功，请检查授权或稍后重试。', { code: 'TOOL_EXECUTION_ERROR', details: { tool: name } });
    }
    return payload;
  }

  async sync({ arguments: orderArguments = {}, optionalToolArguments = {} } = {}) {
    await this.connect();
    const orderPayload = await this.callTool('order-list', orderArguments);
    const warnings = [];
    const optional = {};
    for (const name of READ_ONLY_TOOLS.filter(item => item !== 'order-list')) {
      try {
        optional[name] = await this.callTool(name, optionalToolArguments[name] || {});
        if (optional[name] === null) warnings.push(`${name} 未返回可解析的 JSON，已跳过该项。`);
      } catch (error) {
        warnings.push(`${name} 未读取：${error instanceof MCPError ? error.message : '查询失败。'}`);
      }
    }
    return { orderPayload, accountPayload: optional['query-my-account'], ownedCouponsPayload: optional['query-my-coupons'], availableCouponsPayload: optional['available-coupons'], warnings };
  }
}
