import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MCDClient, MCPError } from './lib/mcp.js';
import { normalizeOrders, analyzeOrders, renderReportSvg, renderReportMarkdown } from './lib/analytics.js';
import { DEMO_ORDERS, DEMO_AS_OF } from './lib/demo.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const BODY_LIMIT = 2 * 1024 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

class APIError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST', details) { super(message); this.status = status; this.code = code; this.details = details; }
}

function shanghaiDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function reportOptions(input, defaults = {}) {
  const days = input.days === undefined || input.days === null || input.days === '' ? 30 : Number(input.days);
  const budget = input.budget === undefined || input.budget === null || input.budget === '' ? 600 : Number(input.budget);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new APIError('统计天数须为 1 至 366 的整数。');
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1000000) throw new APIError('预算须为大于 0 且不超过 1000000 的数字。');
  const asOf = input.asOf ?? defaults.asOf;
  if (asOf !== undefined && (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(Date.parse(`${asOf}T00:00:00Z`)) || new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf)) throw new APIError('统计日期须为有效的 YYYY-MM-DD 日期。');
  return { days, budget, ...defaults, ...(asOf ? { asOf } : {}) };
}

function send(response, status, data, type = 'application/json; charset=utf-8', extra = {}) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  response.end(type.includes('application/json') ? JSON.stringify(data) : data);
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new APIError('请求必须使用 application/json。', 415, 'JSON_REQUIRED');
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_LIMIT) throw new APIError('导入内容过大，请将 JSON 控制在 2 MB 以内。', 413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new APIError('JSON 格式无效。'); }
  if (!isObject(body)) throw new APIError('请求内容必须是 JSON 对象。');
  return body;
}

function verifyLocalRequest(request) {
  const host = request.headers.host;
  if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) throw new APIError('只接受本机访问。', 403, 'LOCAL_ONLY');
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) throw new APIError('拒绝跨来源请求。', 403, 'ORIGIN_REJECTED');
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new APIError('拒绝跨来源请求。', 403, 'ORIGIN_REJECTED');
}

function safeText(value, max = 100) {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\b1[3-9]\d{9}\b/g, '[已隐藏]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[已隐藏]').replace(/[\x00-\x1f]/g, ' ').slice(0, max);
}

function nestedObject(input, depth = 0) {
  if (!isObject(input) || depth > 8) return {};
  for (const key of ['data', 'result', 'account', 'memberInfo', 'member']) if (isObject(input[key])) return nestedObject(input[key], depth + 1);
  return input;
}

function payloadFailed(input, depth = 0) {
  if (!isObject(input) || depth > 8) return false;
  if (input.success === false) return true;
  return ['data', 'result'].some(key => payloadFailed(input[key], depth + 1));
}

function safeCount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function safePoints(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : undefined;
}

function summarizeAccount(payload) {
  if (!payload || payloadFailed(payload)) return { available: false };
  const data = nestedObject(payload);
  const summary = { available: true };
  const tier = safeText(data.memberLevel ?? data.membershipLevel ?? data.memberTier ?? data.levelName);
  if (tier) summary.memberTier = tier;
  const points = ['availablePoint', 'points', 'availablePoints', 'pointBalance'].map(key => safePoints(data[key])).find(value => value !== undefined);
  if (points !== undefined) summary.points = points;
  return summary;
}

function findList(payload, depth = 0) {
  if (depth > 5) return null;
  if (Array.isArray(payload)) return { items: payload, metadata: null };
  if (!isObject(payload)) return null;
  for (const key of ['coupons', 'couponList', 'list', 'items', 'records', 'data', 'result']) {
    if (Array.isArray(payload[key])) return { items: payload[key], metadata: payload };
    if (isObject(payload[key])) {
      const list = findList(payload[key], depth + 1);
      if (list) return list;
    }
  }
  return null;
}

function summarizeCoupons(ownedPayload, availablePayload) {
  const ownedResult = payloadFailed(ownedPayload) ? null : findList(ownedPayload);
  const availableResult = payloadFailed(availablePayload) ? null : findList(availablePayload);
  const owned = ownedResult?.items ?? [];
  const available = availableResult?.items ?? [];
  const totalCount = safeCount(ownedResult?.metadata?.totalCount);
  const currentPage = safeCount(ownedResult?.metadata?.currentPage);
  const totalPages = safeCount(ownedResult?.metadata?.totalPages);
  const items = owned.slice(0, 50).filter(isObject).map(item => {
    const coupon = {};
    const title = safeText(item.title ?? item.name ?? item.couponName);
    const expiresAt = safeText(item.expiresAt ?? item.expireTime ?? item.endTime ?? item.tradeEndDateTime ?? item.tradeEndDate, 40);
    if (title) coupon.title = title;
    if (expiresAt) coupon.expiresAt = expiresAt;
    for (const key of ['value', 'minimumSpend']) if (typeof item[key] === 'number' && Number.isFinite(item[key])) coupon[key] = item[key];
    return coupon;
  }).filter(item => item.title);
  return { available: Boolean(ownedResult || availableResult), ownedAvailable: Boolean(ownedResult), claimableAvailable: Boolean(availableResult), ownedCount: totalCount ?? owned.length, ownedReturnedCount: owned.length, ownedTotalKnown: totalCount !== undefined, ...(currentPage !== undefined && currentPage > 0 ? { ownedCurrentPage: currentPage } : {}), ...(totalPages !== undefined ? { ownedTotalPages: totalPages } : {}), availableCount: available.length, items };
}

function normalized(input, { live = false } = {}) {
  const result = normalizeOrders(input);
  if (!result || !Array.isArray(result.orders)) throw new APIError('订单格式无法识别，请检查导入文件或官方工具返回的数据结构。', 422, 'ORDER_MAPPING_REQUIRED');
  if (live && (payloadFailed(input) || !result.recognized || (!result.orders.length && result.rawCount !== 0))) throw new APIError('官方工具未返回可识别的订单。请确认查询范围及订单字段；不会自动替换为演示数据。', 422, 'ORDER_MAPPING_REQUIRED');
  return { orders: result.orders, warnings: Array.isArray(result.warnings) ? result.warnings : [] };
}

/** Create an isolated local app; tests can inject a read-only MCP client and clock. */
export function createApp({ client = new MCDClient({ token: process.env.MCD_MCP_TOKEN || '' }), now = () => new Date() } = {}) {
  let live = null;
  let syncing = false;
  let connectionGeneration = 0;
  const demo = () => normalized(DEMO_ORDERS);
  const dataset = source => {
    if (source !== 'demo' && source !== 'live') throw new APIError('数据来源须为 demo 或 live。');
    if (source === 'demo') return { ...demo(), source, asOf: DEMO_AS_OF };
    if (!live) throw new APIError('尚未同步真实订单，请先连接并同步官方 MCP。', 409, 'SYNC_REQUIRED');
    return { orders: live.orders, warnings: live.warnings, source, asOf: shanghaiDate(now()) };
  };
  const reportFor = (data, input) => {
    const report = analyzeOrders(data.orders, reportOptions(input, { source: data.source, asOf: data.asOf }));
    return { ...report, warnings: [...new Set([...(report.warnings || []), ...(data.warnings || [])])] };
  };
  return http.createServer(async (request, response) => {
    try {
      verifyLocalRequest(request);
      const url = new URL(request.url, `http://${request.headers.host}`);
      const method = request.method;
      const route = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      if (method === 'GET' && route === '/api/connection') return send(response, 200, { ...client.getStatus(), hasLiveData: Boolean(live) });
      if (method === 'GET' && route === '/api/assets') {
        if (query.source !== 'live') throw new APIError('资产数据来源须为 live。');
        if (!live) throw new APIError('尚未同步真实订单，请先连接并同步官方 MCP。', 409, 'SYNC_REQUIRED');
        return send(response, 200, { account: live.account, coupons: live.coupons, warnings: live.warnings, source: 'live' });
      }
      if (method === 'GET' && route === '/api/orders') {
        const data = dataset(query.source || 'demo');
        return send(response, 200, { orders: data.orders, source: data.source, warnings: data.warnings });
      }
      if (method === 'GET' && ['/api/report', '/api/export.svg', '/api/export.md'].includes(route)) {
        const data = dataset(query.source || 'demo');
        const report = reportFor(data, query);
        if (route === '/api/report') return send(response, 200, report);
        if (route.endsWith('.svg')) return send(response, 200, renderReportSvg(report), 'image/svg+xml; charset=utf-8', { 'Content-Disposition': 'attachment; filename="mcfinance-report.svg"' });
        return send(response, 200, renderReportMarkdown(report), 'text/markdown; charset=utf-8', { 'Content-Disposition': 'attachment; filename="mcfinance-report.md"' });
      }
      if (method === 'POST' && route.startsWith('/api/')) {
        const body = await readJson(request);
        if (route === '/api/connect') {
          if (Object.hasOwn(body, 'token')) {
            // Validate before discarding the existing snapshot; syntactically invalid tokens do not change the connection.
            client.setToken(body.token);
            connectionGeneration += 1;
            live = null;
          }
          return send(response, 200, await client.connect());
        }
        if (route === '/api/disconnect') {
          connectionGeneration += 1;
          client.disconnect();
          live = null;
          return send(response, 200, client.getStatus());
        }
        if (route === '/api/sync') {
          if (syncing) throw new APIError('正在同步，请等待当前查询完成。', 409, 'SYNC_IN_PROGRESS');
          if (body.arguments !== undefined && !isObject(body.arguments)) throw new APIError('订单查询参数必须是 JSON 对象。');
          if (body.optionalToolArguments !== undefined && !isObject(body.optionalToolArguments)) throw new APIError('可选工具参数必须是 JSON 对象。');
          reportOptions(body, { source: 'live', asOf: shanghaiDate(now()) });
          syncing = true;
          const generation = connectionGeneration;
          try {
            const raw = await client.sync(body);
            if (generation !== connectionGeneration) throw new APIError('连接已变更，请重新同步。', 409, 'CONNECTION_CHANGED');
            const parsed = normalized(raw.orderPayload, { live: true });
            const candidate = { orders: parsed.orders, warnings: [...parsed.warnings, ...(raw.warnings || []), '真实研报仅覆盖本次 order-list 返回并成功识别的订单；请按官方参数查询所需的完整时间范围。'], account: summarizeAccount(raw.accountPayload), coupons: summarizeCoupons(raw.ownedCouponsPayload, raw.availableCouponsPayload) };
            const report = reportFor({ ...candidate, source: 'live', asOf: shanghaiDate(now()) }, body);
            live = candidate;
            return send(response, 200, { ...live, report, source: 'live' });
          } finally { syncing = false; }
        }
        if (['/api/analyze', '/api/export.svg', '/api/export.md'].includes(route)) {
          if (!Object.hasOwn(body, 'orders')) throw new APIError('请提供 orders 数组或订单导出对象。');
          const parsed = normalized(body.orders);
          if (!parsed.orders.length) throw new APIError('未找到可识别的订单，请检查字段映射。', 422, 'ORDER_MAPPING_REQUIRED');
          const report = reportFor({ ...parsed, source: 'import', asOf: body.asOf || shanghaiDate(now()) }, body);
          if (route === '/api/analyze') return send(response, 200, report);
          if (route.endsWith('.svg')) return send(response, 200, renderReportSvg(report), 'image/svg+xml; charset=utf-8');
          return send(response, 200, renderReportMarkdown(report), 'text/markdown; charset=utf-8');
        }
        throw new APIError('接口不存在。', 404, 'NOT_FOUND');
      }
      if (route.startsWith('/api/')) throw new APIError('接口不存在或请求方法不支持。', 404, 'NOT_FOUND');
      if (method !== 'GET' && method !== 'HEAD') throw new APIError('请求方法不支持。', 405, 'METHOD_NOT_ALLOWED');
      let relative;
      try { relative = decodeURIComponent(route); } catch { throw new APIError('路径无效。'); }
      if (relative.includes('\0') || relative.includes('\\')) throw new APIError('路径无效。', 400);
      let file;
      if (relative === '/lib/analytics.js') file = path.join(ROOT, 'lib', 'analytics.js');
      else {
        file = path.resolve(PUBLIC, `.${relative === '/' ? '/index.html' : relative}`);
        if (!file.startsWith(`${PUBLIC}${path.sep}`)) throw new APIError('路径无效。', 403);
      }
      let content;
      try { content = await readFile(file); } catch { throw new APIError('文件不存在。', 404, 'NOT_FOUND'); }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
      response.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent) return response.end();
      const known = error instanceof APIError || error instanceof MCPError;
      return send(response, known ? error.status : 500, { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '本地服务处理失败，请检查输入后重试。', ...(known && error.details ? { details: error.details } : {}) } });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为有效端口。');
  const server = createApp();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请使用 PORT 指定其他端口。` : '本地服务启动失败。');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`McFinance 已启动：http://127.0.0.1:${port}`));
}
