import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOrders, normalizeOrders, renderReportSvg, renderReportMarkdown } from '../lib/analytics.js';
import { DEMO_AS_OF, DEMO_ORDERS } from '../lib/demo.js';

const order = (id, date, paid, extras = {}) => ({ id, orderedAt: date, paid, original: null, items: [], channel: '到店取餐', status: 'completed', ...extras });

test('normalization requires explicit valid paid money, preserves zero and never guesses cents', () => {
  const result = normalizeOrders({ data: { orderList: [
    { orderNo: 'one', orderTime: '2026-10-24 13:00:00', actualPayAmount: '￥12.30', originalAmount: '15', products: [{ productName: '麦香鱼', qty: 2 }], orderStatus: '交易成功', orderChannel: 'delivery' },
    { id: 'free', orderedAt: '2026-10-24', paid: 0 },
    { id: 'cents-not-guessed', orderedAt: '2026-10-24', paid: 1230 },
    { id: 'absent', orderedAt: '2026-10-24', items: [{ name: '套餐', price: 20 }] },
    { id: 'boolean', orderedAt: '2026-10-24', paid: true },
    { id: 'bad-date', orderedAt: '2026-02-30', paid: 20 },
    { id: 'negative', orderedAt: '2026-10-24', paid: -1 },
  ] } });
  assert.equal(result.orders.length, 3);
  assert.deepEqual(result.orders[0], { id: 'one', orderedAt: '2026-10-24T05:00:00.000Z', timeKnown: true, paid: 12.3, original: 15, items: [{ name: '麦香鱼', quantity: 2 }], channel: '麦乐送', status: 'completed' });
  assert.equal(result.orders[1].paid, 0);
  assert.equal(result.orders[2].paid, 1230);
  assert.equal(result.warnings.length, 4);
});

test('normalization distinguishes recognized empty lists from unmapped or discarded records', () => {
  for (const input of [[], { data: { list: [] } }, { orders: [] }]) {
    const result = normalizeOrders(input);
    assert.equal(result.recognized, true);
    assert.equal(result.rawCount, 0);
    assert.deepEqual(result.orders, []);
    assert.deepEqual(result.warnings, []);
  }
  const unmapped = normalizeOrders({ unexpected: [] });
  assert.equal(unmapped.recognized, false);
  assert.equal(unmapped.rawCount, 0);
  assert.equal(unmapped.warnings.length, 1);
  const discarded = normalizeOrders({ data: { list: [null, { id: 'synthetic-invalid' }] } });
  assert.equal(discarded.recognized, true);
  assert.equal(discarded.rawCount, 2);
  assert.deepEqual(discarded.orders, []);
  assert.equal(discarded.warnings.length, 2);
});

test('official order fields use explicit money and top-level products without guessing numeric channels', () => {
  const input = { success: true, code: 200, data: { list: [{
    orderId: 'synthetic-official-order', orderType: '1', createTime: '2026-10-23 23:15:00',
    orderStatus: '订单已完成', realTotalAmount: '19.90',
    orderProductList: [{
      productCode: 'synthetic-combo', productName: '测试套餐', quantity: 2,
      comboItemList: [{ name: '测试套餐子项', productCode: 'synthetic-child', quantity: 3 }],
    }],
  }] } };
  const normalized = normalizeOrders(input);
  assert.equal(normalized.recognized, true);
  assert.equal(normalized.rawCount, 1);
  assert.deepEqual(normalized.warnings, []);
  assert.deepEqual(normalized.orders[0], {
    id: 'synthetic-official-order', orderedAt: '2026-10-23T15:15:00.000Z', timeKnown: true,
    paid: 19.9, original: null, items: [{ name: '测试套餐', quantity: 2 }],
    channel: '未提供渠道', status: 'completed',
  });
  const report = analyzeOrders(input, { asOf: '2026-10-24', source: 'live' });
  assert.equal(report.kpis.totalSpend, 19.9);
  assert.equal(report.kpis.savingsOrderCount, 0);
  assert.deepEqual(report.topItems, [{ name: '测试套餐', count: 2, share: 1 }]);
  assert.ok(!report.warnings.some(warning => warning.includes('完成状态')));
  for (const orderType of [1, 2, '2', ' 3 ']) {
    assert.equal(normalizeOrders([{ id: 'synthetic-channel', createTime: '2026-10-24 12:00:00', realTotalAmount: '10', orderType }]).orders[0].channel, '未提供渠道');
  }
});

test('report uses exact China calendar bounds and excludes canceled, refunded and pending money', () => {
  const result = analyzeOrders([
    order('before', '2026-09-24T15:59:59Z', 100),
    order('first', '2026-09-24T16:00:00Z', 0.1),
    order('last', '2026-10-24T15:59:59Z', 0.2),
    order('after', '2026-10-24T16:00:00Z', 200),
    order('cancel', '2026-10-24T13:00:00+08:00', 300, { status: '已取消' }),
    order('refund', '2026-10-24T13:00:00+08:00', 400, { status: '退款成功' }),
    order('pending', '2026-10-24T13:00:00+08:00', 500, { status: '待支付' }),
  ], { days: 30, asOf: '2026-10-24', source: 'import' });
  assert.deepEqual(result.period, { days: 30, from: '2026-09-25', to: '2026-10-24', asOf: '2026-10-24' });
  assert.equal(result.kpis.totalSpend, 0.3);
  assert.equal(result.kpis.orderCount, 2);
  assert.equal(result.kpis.averageOrder, 0.15);
  assert.equal(result.trend.length, 30);
  assert.equal(result.trend[0].amount, 0.1);
  assert.equal(result.trend.at(-1).amount, 0.2);
  assert.equal(result.kpis.previousSpend, 100);
});

test('savings only includes known valid original amounts and records coverage', () => {
  const result = analyzeOrders([
    order('valid', '2026-10-24T12:00:00+08:00', 20, { original: 30 }),
    order('unknown', '2026-10-24T12:30:00+08:00', 18),
    order('invalid', '2026-10-24T13:00:00+08:00', 12, { original: 10 }),
    order('free', '2026-10-24T13:30:00+08:00', 0, { original: 10 }),
  ], { asOf: '2026-10-24' });
  assert.equal(result.kpis.totalSpend, 50);
  assert.equal(result.kpis.savings, 20);
  assert.equal(result.kpis.savingsRate, 0.5);
  assert.equal(result.kpis.savingsOrderCount, 2);
  assert.ok(result.warnings.some(warning => warning.includes('2/4')));
  assert.ok(result.warnings.some(warning => warning.includes('原价无效')));
});

test('night share follows China hours and item quantity shares describe item counts', () => {
  const dates = ['2026-10-24T21:59:00+08:00', '2026-10-24T22:00:00+08:00', '2026-10-24T05:59:00+08:00', '2026-10-24T06:00:00+08:00'];
  const result = analyzeOrders(dates.map((date, index) => order(String(index), date, 10, { items: [{ name: index ? '鱼堡' : '薯条', quantity: index ? 1 : 3 }], channel: index ? '麦乐送' : '到店取餐' })), { asOf: '2026-10-24' });
  assert.equal(result.kpis.nightCount, 2);
  assert.equal(result.kpis.nightTimeKnownCount, 4);
  assert.equal(result.kpis.nightRate, 0.5);
  assert.equal(result.channels[0].share, 0.75);
  assert.equal(result.topItems[0].count, 3);
  assert.equal(result.topItems[0].share, 0.5);
});

test('date-only records retain unknown clock precision after normalization and do not invent night activity', () => {
  const records = [
    order('synthetic-date-only', '2026-10-24', 10),
    order('synthetic-date-only-slashes', '2026/10/24', 10),
    order('synthetic-midnight', '2026-10-24T00:00:00+08:00', 10),
    order('synthetic-daytime', '2026-10-24 12:30', 10),
    order('synthetic-unknown-clock', '2026-10-24T00:00:00+08:00', 10, { timeKnown: false }),
  ];
  const once = normalizeOrders(records);
  const twice = normalizeOrders(once.orders);
  assert.deepEqual(once.orders.map(item => item.timeKnown), [false, false, true, true, false]);
  assert.deepEqual(twice.orders, once.orders);
  const report = analyzeOrders(twice.orders, { asOf: '2026-10-24' });
  assert.equal(report.kpis.totalSpend, 50);
  assert.equal(report.kpis.orderCount, 5);
  assert.equal(report.kpis.nightCount, 1);
  assert.equal(report.kpis.nightTimeKnownCount, 2);
  assert.equal(report.kpis.nightRate, 0.5);
  assert.ok(report.warnings.some(warning => warning.includes('夜间统计仅覆盖 2/5')));
  const night = report.insights.find(insight => insight.id === 'night');
  assert.equal(night.evidence.nightTimeKnownCount, 2);
  assert.ok(night.body.includes('占已知时刻订单的 50.0%'));
  assert.ok(renderReportSvg(report).includes('已知时刻 2/5 单为分母'));
  assert.ok(renderReportMarkdown(report).includes('1/2 单 / 50.0%（以已知时刻订单为分母）'));
  const dateOnly = analyzeOrders([records[0]], { asOf: '2026-10-24' });
  assert.equal(dateOnly.kpis.nightCount, 0);
  assert.equal(dateOnly.kpis.nightTimeKnownCount, 0);
  assert.equal(dateOnly.kpis.nightRate, 0);
  assert.ok(dateOnly.insights.find(insight => insight.id === 'night').title.includes('暂不判断'));
});

test('empty records and zero paid orders are finite; invalid period fails explicitly', () => {
  for (const records of [[], [order('free', '2026-10-24', 0, { original: 0 })]]) {
    const result = analyzeOrders(records, { asOf: '2026-10-24', budget: 0 });
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(result)));
    for (const value of Object.values(result.kpis)) assert.ok(value === null || Number.isFinite(value));
    assert.equal(result.kpis.savingsRate, 0);
    assert.equal(result.kpis.spendChange, null);
    assert.equal(result.trend.length, 30);
  }
  assert.throws(() => analyzeOrders([], { asOf: '2026-02-30' }), RangeError);
  assert.throws(() => analyzeOrders([], { days: 0 }), RangeError);
});

test('duplicate identifiers do not double count, malformed originals do not create negative savings', () => {
  const result = normalizeOrders([
    order('same', '2026-10-24', 20, { original: -1 }),
    order('same', '2026-10-24', 30),
  ]);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].original, null);
  assert.ok(result.warnings.some(warning => warning.includes('重复')));
});

test('explicit foreign currency and cents units require mapping rather than silent yuan totals', () => {
  const result = normalizeOrders([
    { ...order('foreign', '2026-10-24', 30), currency: 'USD' },
    { ...order('fen', '2026-10-24', 3000), amountUnit: 'fen' },
    { ...order('yuan', '2026-10-24', 30), currency: 'CNY', amountUnit: 'yuan' },
    { orderedAt: '2026-10-24', paid: 10 },
  ]);
  assert.deepEqual(result.orders.map(item => item.paid), [30, 10]);
  assert.equal(result.warnings.filter(warning => warning.includes('金额单位不是人民币元')).length, 2);
  assert.ok(result.warnings.some(warning => warning.includes('无法可靠识别')));
});

test('exported SVG and Markdown safely escape untrusted item names and do not add external assets', () => {
  const name = '</text><script>alert("x")</script>|[link](https://example.com)';
  const result = analyzeOrders([order('x', '2026-10-24', 20, { items: [{ name, quantity: 1 }] })], { asOf: '2026-10-24', source: 'live' });
  const svg = renderReportSvg(result);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('&lt;/text&gt;&lt;script&gt;'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(!svg.includes('foreignObject'));
  assert.ok(svg.includes('MCP 实际返回订单'));
  const markdown = renderReportMarkdown(result);
  assert.ok(markdown.includes('\\|\\[link\\]'));
  assert.ok(markdown.includes('不代表完整消费历史'));
});

test('long SVG reports aggregate consecutive days without dropping spending', () => {
  const orders = Array.from({ length: 366 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 9, 24) + index * 86_400_000).toISOString().slice(0, 10);
    return order(`day-${index}`, date, 0.1);
  });
  const report = analyzeOrders(orders, { days: 366, asOf: '2026-10-24' });
  const svg = renderReportSvg(report);
  assert.equal(report.kpis.totalSpend, 36.6);
  assert.ok(svg.includes('每 5 天汇总'));
  assert.ok(svg.includes('2025-10-24 — 2025-10-28 ¥0.50 · 5 单'));
  const amounts = [...svg.matchAll(/<title>[^<]*¥([\d.]+) · \d+ 单<\/title>/g)].map(match => Math.round(Number(match[1]) * 100));
  assert.equal(amounts.length, 74);
  assert.equal(amounts.reduce((sum, amount) => sum + amount, 0), 3660);
});

test('SVG artwork accepts bounded PNG data only and never embeds URLs or markup', () => {
  const report = analyzeOrders([], { asOf: '2026-10-24' });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLioAAAAASUVORK5CYII=';
  assert.ok(renderReportSvg({ ...report, artwork: png }).includes(`href="${png}"`));
  for (const artwork of [
    'https://example.com/food.png',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,AAAA" onload="alert(1)',
    'data:image/png;base64,AAAA\n',
    `data:image/png;base64,${'A'.repeat(4_000_000)}`,
    { toString: () => png },
  ]) {
    const svg = renderReportSvg({ ...report, artwork });
    assert.ok(!svg.includes('<image'));
    assert.ok(!svg.includes('onload='));
    assert.ok(!svg.includes('foreignObject'));
  }
});

test('SVG distinguishes missing original prices from verified zero savings', () => {
  const missing = analyzeOrders([order('synthetic-missing-original', '2026-10-24', 10)], { asOf: '2026-10-24' });
  assert.ok(renderReportSvg(missing).includes('待补原价'));
  assert.ok(renderReportSvg(missing).includes('原价有效 0/1 单'));
  const known = analyzeOrders([order('synthetic-zero-savings', '2026-10-24', 10, { original: 10 })], { asOf: '2026-10-24' });
  assert.ok(!renderReportSvg(known).includes('待补原价'));
  assert.ok(renderReportSvg(known).includes('¥0.00'));
});

test('deterministic demo contains 70+ days, 50+ orders and contrasting statuses', () => {
  assert.ok(DEMO_ORDERS.length >= 50);
  const dates = DEMO_ORDERS.map(item => item.orderedAt.slice(0, 10));
  assert.ok((Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86_400_000 >= 70);
  assert.ok(DEMO_ORDERS.some(item => item.status === 'cancelled'));
  assert.ok(DEMO_ORDERS.some(item => item.status === 'refunded'));
  const first = analyzeOrders(DEMO_ORDERS, { asOf: DEMO_AS_OF });
  const second = analyzeOrders(DEMO_ORDERS, { asOf: DEMO_AS_OF });
  assert.deepEqual(first.kpis, second.kpis);
  assert.equal(first.period.asOf, DEMO_AS_OF);
  assert.ok(first.kpis.totalSpend > 0);
});
