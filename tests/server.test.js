import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';
import { DEMO_ORDERS } from '../lib/demo.js';

function fakeClient(orderPayload = DEMO_ORDERS, extraPayloads = {}) {
  let configured = false;
  let connected = false;
  return {
    setToken(token) { configured = Boolean(token); connected = false; },
    disconnect() { configured = false; connected = false; },
    getStatus() { return { configured, connected, tools: [], message: 'test' }; },
    async connect() { connected = configured; return this.getStatus(); },
    async sync() { return { orderPayload, accountPayload: { name: 'private-name', phone: '13812345678', points: 42 }, ownedCouponsPayload: { list: [{ name: '咖啡券', phone: '13812345678' }] }, warnings: [], ...extraPayloads }; },
  };
}

async function withServer(fn, options = {}) {
  const server = createApp({ client: fakeClient(), now: () => new Date('2026-10-24T08:00:00Z'), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try { await fn({ base, post }); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('demo report, orders, and downloadable SVG/Markdown work without credentials', async () => {
  await withServer(async ({ base }) => {
    const orders = await (await fetch(`${base}/api/orders`)).json();
    assert.equal(orders.source, 'demo');
    assert.ok(orders.orders.length > 0);
    const report = await fetch(`${base}/api/report?source=demo&days=30&budget=600`);
    assert.equal(report.status, 200);
    assert.equal((await report.json()).source, 'demo');
    const svg = await fetch(`${base}/api/export.svg`);
    assert.equal(svg.status, 200);
    assert.ok((await svg.text()).includes('<svg'));
    const markdown = await fetch(`${base}/api/export.md`);
    assert.equal(markdown.status, 200);
    assert.ok((await markdown.text()).length > 100);
  });
});

test('live endpoints require a completed sync and never substitute demo data', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/report?source=live`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'SYNC_REQUIRED');
  });
});

test('import analysis and exports use the supplied data', async () => {
  await withServer(async ({ post }) => {
    const response = await post('/api/analyze', { orders: DEMO_ORDERS, asOf: '2026-10-24', days: 30 });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source, 'import');
    assert.equal((await post('/api/export.svg', { orders: DEMO_ORDERS, asOf: '2026-10-24' })).status, 200);
    assert.equal((await post('/api/analyze', { orders: [], asOf: '2026-10-24' })).status, 422);
    assert.equal((await post('/api/analyze', { orders: DEMO_ORDERS, asOf: '2026-02-30' })).status, 400);
  });
});

test('report retains warnings from records discarded during initial normalization', async () => {
  await withServer(async ({ post }) => {
    const response = await post('/api/analyze', { orders: [...DEMO_ORDERS, DEMO_ORDERS[0]], asOf: '2026-10-24' });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.ok(report.warnings.some(warning => warning.includes('订单号重复')));
  });
});

test('connect, sync, and disconnect retain only normalized orders and safe summaries', async () => {
  await withServer(async ({ base, post }) => {
    const connected = await post('/api/connect', { token: 'secret-local-token' });
    assert.equal(connected.status, 200);
    assert.equal((await connected.text()).includes('secret-local-token'), false);
    const synced = await post('/api/sync', { arguments: {} });
    assert.equal(synced.status, 200);
    const text = await synced.text();
    assert.equal(text.includes('private-name'), false);
    assert.equal(text.includes('13812345678'), false);
    const result = JSON.parse(text);
    assert.equal(result.source, 'live');
    assert.equal(result.account.points, 42);
    assert.equal(result.coupons.ownedCount, 1);
    assert.equal((await fetch(`${base}/api/orders?source=live`)).status, 200);
    // Reopening an existing/environment-configured connection must not discard its report.
    await post('/api/connect', {});
    assert.equal((await fetch(`${base}/api/orders?source=live`)).status, 200);
    await post('/api/disconnect', {});
    assert.equal((await fetch(`${base}/api/orders?source=live`)).status, 409);
  });
});

test('unparseable official payloads produce a mapping error', async () => {
  await withServer(async ({ post }) => {
    const response = await post('/api/sync', {});
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'ORDER_MAPPING_REQUIRED');
  }, { client: fakeClient({ unexpected: 'not-order-data' }) });
});

test('a recognized official empty order list is a successful empty live report', async () => {
  await withServer(async ({ base, post }) => {
    const response = await post('/api/sync', {});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.source, 'live');
    assert.deepEqual(result.orders, []);
    assert.equal(result.report.kpis.orderCount, 0);
    assert.equal(result.report.kpis.totalSpend, 0);
    const report = await (await fetch(`${base}/api/report?source=live`)).json();
    assert.equal(report.source, 'live');
    assert.equal(report.kpis.orderCount, 0);
    assert.deepEqual((await (await fetch(`${base}/api/orders?source=live`)).json()).orders, []);
  }, { client: fakeClient({ success: true, code: 200, data: { orders: [] } }) });
});

test('invalid records and explicit business failures cannot become empty live reports', async () => {
  const payloads = [
    { success: true, data: { orders: [{ id: 'synthetic-invalid', orderedAt: '2026-10-24' }] } },
    { success: false, data: { orders: [] } },
    { success: true, data: { success: false, orders: [] } },
    { success: false, orders: DEMO_ORDERS },
  ];
  for (const orderPayload of payloads) {
    await withServer(async ({ base, post }) => {
      const response = await post('/api/sync', {});
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error.code, 'ORDER_MAPPING_REQUIRED');
      assert.equal((await fetch(`${base}/api/connection`).then(response => response.json())).hasLiveData, false);
    }, { client: fakeClient(orderPayload) });
  }
});

test('official account and paginated coupon summaries expose safe fields and confirmed totals', async () => {
  const accountPayload = { success: true, code: 200, data: { availablePoint: '1234', accountId: 'synthetic-private-account', accumulativePoint: '9876', memberLevel: '测试会员' } };
  const ownedCouponsPayload = { success: true, data: { coupons: [
    { title: '测试早餐券', tradeEndDateTime: '2026-11-01 23:59:59', accountId: 'synthetic-private-account', totalCount: 999 },
    { title: '测试饮品券', tradeEndDate: '2026-11-02' },
  ], totalCount: 6, currentPage: 1, pageSize: 2, totalPages: 3 } };
  await withServer(async ({ post }) => {
    const response = await post('/api/sync', {});
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes('synthetic-private-account'), false);
    assert.equal(text.includes('accumulativePoint'), false);
    const { account, coupons } = JSON.parse(text);
    assert.deepEqual(account, { available: true, memberTier: '测试会员', points: 1234 });
    assert.equal(coupons.ownedAvailable, true);
    assert.equal(coupons.claimableAvailable, true);
    assert.equal(coupons.ownedCount, 6);
    assert.equal(coupons.ownedReturnedCount, 2);
    assert.equal(coupons.ownedTotalKnown, true);
    assert.equal(coupons.ownedCurrentPage, 1);
    assert.equal(coupons.ownedTotalPages, 3);
    assert.equal(coupons.availableCount, 3);
    assert.deepEqual(coupons.items, [{ title: '测试早餐券', expiresAt: '2026-11-01 23:59:59' }, { title: '测试饮品券', expiresAt: '2026-11-02' }]);
  }, { client: fakeClient(DEMO_ORDERS, { accountPayload, ownedCouponsPayload, availableCouponsPayload: { data: [{ title: '测试可领取券一' }, { title: '测试可领取券二' }, { title: '测试可领取券三' }] } }) });
});

test('account point aliases accept safe nonnegative numbers and strict decimal strings', async () => {
  const cases = [
    [{ availablePoint: '0' }, 0],
    [{ availablePoint: '123.5' }, 123.5],
    [{ availablePoint: 123.5 }, 123.5],
    [{ availablePoint: '0.0' }, 0],
    [{ points: '42' }, 42],
    [{ points: '42.5' }, 42.5],
    [{ availablePoints: 42 }, 42],
    [{ pointBalance: '42' }, 42],
    [{ availablePoint: 'invalid', points: '42' }, 42],
    [{ availablePoint: '9007199254740991' }, Number.MAX_SAFE_INTEGER],
    ...['', '-1', '-1.5', '1e3', '0x10', 'NaN', 'Infinity', '1,234', ' 42 ', '.5', '1.', '9007199254740992', -1, Number.MAX_SAFE_INTEGER + 1, null, true, {}, []].map(value => [{ availablePoint: value }, undefined]),
  ];
  for (const [data, expected] of cases) {
    await withServer(async ({ post }) => {
      const response = await post('/api/sync', {});
      assert.equal(response.status, 200);
      const { account } = await response.json();
      assert.equal(account.points, expected);
      assert.equal(Object.hasOwn(account, 'points'), expected !== undefined);
    }, { client: fakeClient(DEMO_ORDERS, { accountPayload: { success: true, data } }) });
  }
});

test('coupon totals require safe metadata on a recognized list container', async () => {
  const cases = [
    [{ data: [{ title: '测试券', totalCount: 900 }] }, 1, false],
    [{ totalCount: 900, data: { coupons: [{ title: '测试券' }] } }, 1, false],
    [{ data: { coupons: [], totalCount: '0', currentPage: 1, totalPages: 0 } }, 0, true],
    ...[-1, 1.5, 'invalid', '1e3', Number.MAX_SAFE_INTEGER + 1, true].map(totalCount => [{ data: { coupons: [{ title: '测试券' }], totalCount } }, 1, false]),
  ];
  for (const [ownedCouponsPayload, expectedCount, expectedKnown] of cases) {
    await withServer(async ({ post }) => {
      const response = await post('/api/sync', {});
      assert.equal(response.status, 200);
      const { coupons } = await response.json();
      assert.equal(coupons.ownedAvailable, true);
      assert.equal(coupons.ownedCount, expectedCount);
      assert.equal(coupons.ownedTotalKnown, expectedKnown);
      assert.equal(coupons.ownedReturnedCount, expectedCount === 0 ? 0 : 1);
    }, { client: fakeClient(DEMO_ORDERS, { ownedCouponsPayload }) });
  }
});

test('unavailable coupon queries stay distinguishable from confirmed empty results', async () => {
  const cases = [
    [{ ownedCouponsPayload: undefined, availableCouponsPayload: undefined }, false, false],
    [{ ownedCouponsPayload: undefined, availableCouponsPayload: { data: [] } }, false, true],
    [{ ownedCouponsPayload: { data: { coupons: [] } }, availableCouponsPayload: undefined }, true, false],
    [{ ownedCouponsPayload: { success: false, data: { coupons: [] } }, availableCouponsPayload: { unexpected: [] } }, false, false],
  ];
  for (const [extraPayloads, ownedAvailable, claimableAvailable] of cases) {
    await withServer(async ({ post }) => {
      const response = await post('/api/sync', {});
      assert.equal(response.status, 200);
      const { coupons } = await response.json();
      assert.equal(coupons.ownedAvailable, ownedAvailable);
      assert.equal(coupons.claimableAvailable, claimableAvailable);
      assert.equal(coupons.available, ownedAvailable || claimableAvailable);
    }, { client: fakeClient(DEMO_ORDERS, extraPayloads) });
  }
});

test('connection status and live assets restore the current snapshot and clear on disconnect', async () => {
  await withServer(async ({ base, post }) => {
    assert.equal((await (await fetch(`${base}/api/connection`)).json()).hasLiveData, false);
    const before = await fetch(`${base}/api/assets?source=live`);
    assert.equal(before.status, 409);
    assert.equal((await before.json()).error.code, 'SYNC_REQUIRED');
    assert.equal((await fetch(`${base}/api/assets?source=demo`)).status, 400);
    const synced = await (await post('/api/sync', {})).json();
    assert.equal((await (await fetch(`${base}/api/connection`)).json()).hasLiveData, true);
    const assets = await (await fetch(`${base}/api/assets?source=live`)).json();
    assert.equal(assets.source, 'live');
    assert.deepEqual(assets.account, synced.account);
    assert.deepEqual(assets.coupons, synced.coupons);
    assert.deepEqual(assets.warnings, synced.warnings);
    assert.equal(Object.hasOwn(assets, 'orders'), false);
    await post('/api/disconnect', {});
    assert.equal((await (await fetch(`${base}/api/connection`)).json()).hasLiveData, false);
    assert.equal((await fetch(`${base}/api/assets?source=live`)).status, 409);
  });
});

test('disconnect during synchronization cannot restore the previous private cache', async () => {
  let finish;
  let announce;
  const started = new Promise(resolve => { announce = resolve; });
  const client = fakeClient();
  client.sync = () => new Promise(resolve => { finish = resolve; announce(); });
  await withServer(async ({ base, post }) => {
    const synchronization = post('/api/sync', {});
    await started;
    await post('/api/disconnect', {});
    finish({ orderPayload: DEMO_ORDERS, warnings: [] });
    assert.equal((await synchronization).status, 409);
    assert.equal((await fetch(`${base}/api/orders?source=live`)).status, 409);
  }, { client });
});

test('invalid sync report options are rejected before querying the official service', async () => {
  let called = false;
  const client = fakeClient();
  client.sync = async () => { called = true; return { orderPayload: DEMO_ORDERS, warnings: [] }; };
  await withServer(async ({ post }) => {
    assert.equal((await post('/api/sync', { days: 0 })).status, 400);
    assert.equal(called, false);
  }, { client });
});

test('rejects cross-origin writes, non-JSON bodies, oversized input, and invalid query values', async () => {
  await withServer(async ({ base, post }) => {
    const origin = await post('/api/connect', { token: 'secret' }, { Origin: 'https://evil.example' });
    assert.equal(origin.status, 403);
    const text = await fetch(`${base}/api/connect`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(text.status, 415);
    const oversized = await post('/api/analyze', { orders: 'x'.repeat(2 * 1024 * 1024) });
    assert.equal(oversized.status, 413);
    assert.equal((await fetch(`${base}/api/report?days=0`)).status, 400);
    assert.equal((await fetch(`${base}/api/report?source=unknown`)).status, 400);
    assert.equal((await fetch(`${base}/api/report?budget=NaN`)).status, 400);
  });
});

test('does not serve secrets or files outside public', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/server.js`)).status, 404);
    assert.equal((await fetch(`${base}/lib/mcp.js`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e%5cserver.js`)).status, 400);
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(`${base}/api/connection`, { headers: { Host: 'evil.example' } }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
  });
});
