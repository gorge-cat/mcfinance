/** McFinance: dependency-free, browser-safe analysis of explicitly paid order data. */
const CHINA_ZONE = 'Asia/Shanghai';
const DAY_MS = 86_400_000;
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CHINA_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23',
});
const paidFields = ['paid', 'actualPaid', 'actualPay', 'actualPayAmount', 'actualAmount', 'payAmount', 'paidAmount', 'totalPaid', 'realPayAmount', 'realTotalAmount', 'paymentAmount', '实付金额'];
const originalFields = ['original', 'originalAmount', 'originalPrice', 'totalOriginalAmount', 'goodsOriginalAmount', 'listPrice', '原价金额'];
const dateFields = ['orderedAt', 'orderTime', 'orderDate', 'createdAt', 'createTime', 'payTime', 'paymentTime', '下单时间'];

function firstPresent(object, names) {
  for (const name of names) {
    if (Object.hasOwn(object, name) && object[name] !== null && object[name] !== undefined && object[name] !== '') return object[name];
  }
  return undefined;
}

function amountCents(value) {
  let amount = value;
  if (typeof value === 'string') {
    const match = value.trim().match(/^(?:[¥￥]\s*)?(\d+(?:\.\d+)?)(?:\s*(?:元|CNY|RMB))?$/i);
    if (!match) return null;
    amount = Number(match[1]);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round((amount + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function chinaParts(value) {
  const values = Object.fromEntries(dateFormatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
}

function validDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseOrderDate(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  let timeKnown = true;
  // Dates without an offset are explicitly interpreted as China local time.
  const local = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
  if (local) {
    timeKnown = local[4] !== undefined;
    const [, year, month, day, hour = '00', minute = '00', second = '00', fraction] = local;
    if (!validDateKey(`${year}-${month}-${day}`) || +hour > 23 || +minute > 59 || +second > 59) return null;
    text = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ? `.${fraction}` : ''}+08:00`;
  } else {
    // Require an explicit ISO timezone; never depend on the browser/server timezone.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
    if (!validDateKey(text.slice(0, 10))) return null;
    const hours = Number(text.slice(11, 13));
    const minutes = Number(text.slice(14, 16));
    const seconds = text[16] === ':' ? Number(text.slice(17, 19)) : 0;
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
  }
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? { orderedAt: date.toISOString(), timeKnown } : null;
}

function normalizedStatus(value) {
  if (value === null || value === undefined || value === '') return 'unknown';
  const status = String(value).trim();
  if (/refund|退款|退单|退货/i.test(status)) return 'refunded';
  if (/cancel|取消|关闭|作废/i.test(status)) return 'cancelled';
  if (/pending|unpaid|awaiting|待支付|待付款|未支付|未付款|支付失败|failed/i.test(status)) return 'pending';
  if (/^(completed|complete|finished|success|successful|paid|delivered|已完成|订单已完成|交易成功|支付成功|已支付|已付款|已送达|已取餐|完成)$/i.test(status)) return 'completed';
  return status;
}

function normalizedItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [{ name: item.trim().slice(0, 200), quantity: 1 }];
    if (!item || typeof item !== 'object') return [];
    const name = firstPresent(item, ['name', 'productName', 'itemName', 'goodsName', '商品名称']);
    if (typeof name !== 'string' || !name.trim()) return [];
    const rawQuantity = firstPresent(item, ['quantity', 'qty', 'count', 'num', '数量']);
    const quantity = rawQuantity === undefined ? 1 : Number(rawQuantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return [];
    return [{ name: name.trim().slice(0, 200), quantity }];
  });
}

function unwrapOrders(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') return null;
  for (const key of ['orders', 'orderList', 'order_list', 'list', 'records']) {
    if (Array.isArray(input[key])) return input[key];
  }
  if (input.data && input.data !== input) {
    if (Array.isArray(input.data)) return input.data;
    for (const key of ['orders', 'orderList', 'order_list', 'list', 'records']) {
      if (Array.isArray(input.data[key])) return input.data[key];
    }
  }
  return null;
}

/** Amount aliases are always interpreted as yuan; no heuristic conversion from cents. */
export function normalizeOrders(input) {
  const warnings = [];
  const rawOrders = unwrapOrders(input);
  if (!rawOrders) return { orders: [], warnings: ['未找到订单数组；支持数组或 orders、orderList、list、records、data 字段。'], recognized: false, rawCount: 0 };
  const orders = [];
  const ids = new Set();
  let missingIdCount = 0;
  for (const [index, raw] of rawOrders.entries()) {
    const location = `第 ${index + 1} 条订单`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push(`${location}格式无效，已跳过。`);
      continue;
    }
    const currency = firstPresent(raw, ['currency', 'currencyCode', '币种']);
    const unit = firstPresent(raw, ['currencyUnit', 'amountUnit', 'moneyUnit', '金额单位']);
    if ((currency !== undefined && !/^(CNY|RMB|人民币|元|[¥￥]|156)$/i.test(String(currency).trim())) ||
        (unit !== undefined && !/^(yuan|元|人民币元|CNY|RMB)$/i.test(String(unit).trim()))) {
      warnings.push(`${location}声明的币种或金额单位不是人民币元，已跳过；请确认单位后明确转换，不自动换算。`);
      continue;
    }
    const cents = amountCents(firstPresent(raw, paidFields));
    if (cents === null) {
      warnings.push(`${location}缺少有效的人民币实付金额，已跳过；不会根据商品或优惠券推算。`);
      continue;
    }
    const parsedDate = parseOrderDate(firstPresent(raw, dateFields));
    if (!parsedDate) {
      warnings.push(`${location}缺少有效下单时间，已跳过。`);
      continue;
    }
    const explicitId = firstPresent(raw, ['id', 'orderId', 'orderNo', 'orderNumber', '订单号']);
    if (explicitId === undefined) missingIdCount += 1;
    const id = explicitId === undefined ? `import-${String(index + 1).padStart(5, '0')}` : String(explicitId).slice(0, 200);
    if (ids.has(id)) {
      warnings.push(`${location}订单号重复，已跳过重复记录。`);
      continue;
    }
    ids.add(id);
    const originalRaw = firstPresent(raw, originalFields);
    let originalCents = amountCents(originalRaw);
    if (originalRaw !== undefined && (originalCents === null || originalCents < cents)) {
      warnings.push(`${location}原价无效或低于实付，不计入优惠统计。`);
      originalCents = null;
    }
    const rawChannel = firstPresent(raw, ['channel', 'orderChannel', 'deliveryType', 'orderType', '取餐方式']);
    const rawChannelText = rawChannel === undefined ? '' : String(rawChannel).trim();
    // Official numeric order types have no published channel meanings.
    const channelText = !rawChannelText || typeof rawChannel === 'number' || /^[+-]?\d+(?:\.\d+)?$/.test(rawChannelText) ? '未提供渠道' : rawChannelText.slice(0, 100);
    const channel = /麦乐送|delivery|外送|外卖/i.test(channelText) ? '麦乐送' : /到店|自取|pickup|pick-up|堂食/i.test(channelText) ? '到店取餐' : channelText || '未提供渠道';
    orders.push({
      id, orderedAt: parsedDate.orderedAt, timeKnown: parsedDate.timeKnown && raw.timeKnown !== false,
      paid: cents / 100, original: originalCents === null ? null : originalCents / 100,
      items: normalizedItems(firstPresent(raw, ['items', 'products', 'goods', 'orderItems', 'orderProductList', '商品'])),
      channel, status: normalizedStatus(firstPresent(raw, ['status', 'orderStatus', '订单状态'])),
    });
  }
  if (missingIdCount) warnings.push(`${missingIdCount} 条订单未提供订单号，已使用临时编号；无法可靠识别这些记录是否重复。`);
  return { orders, warnings, recognized: true, rawCount: rawOrders.length };
}

const money = value => `¥${value.toFixed(2)}`;
const percent = value => `${(value * 100).toFixed(1)}%`;
function shiftDay(date, delta) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}
function sourceLabel(source) {
  const labels = { demo: '演示数据 · 非个人订单', live: 'MCP 实际返回订单', import: '用户导入订单' };
  return Object.hasOwn(labels, source) ? labels[source] : '已提供的订单记录';
}

export function analyzeOrders(input, { days = 30, asOf = chinaParts(Date.now()).date, budget = 600, source = 'demo' } = {}) {
  const normalized = normalizeOrders(input);
  const warnings = [...normalized.warnings];
  const dayCount = Number(days);
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 3660) throw new RangeError('days 必须为 1 到 3660 的整数。');
  if (!validDateKey(asOf)) throw new RangeError('asOf 必须是有效的 YYYY-MM-DD 日期。');
  let budgetCents = amountCents(budget);
  if (budgetCents === null || budgetCents === 0) {
    budgetCents = 60000;
    warnings.push('预算需为大于 0 的人民币金额，本次使用默认预算 ¥600.00。');
  }
  const from = shiftDay(asOf, -(dayCount - 1));
  const previousFrom = shiftDay(from, -dayCount);
  const records = normalized.orders.filter(order => !['cancelled', 'refunded', 'pending'].includes(order.status));
  const excludedCount = normalized.orders.length - records.length;
  if (excludedCount) warnings.push(`已排除 ${excludedCount} 条取消、退款或待支付订单。`);
  const activeRecords = records.map(order => ({ order, ...chinaParts(order.orderedAt) }));
  const current = activeRecords.filter(record => record.date >= from && record.date <= asOf);
  const previous = activeRecords.filter(record => record.date >= previousFrom && record.date < from);
  const currentOrders = current.map(record => record.order).sort((a, b) => b.orderedAt.localeCompare(a.orderedAt));
  const totalCents = current.reduce((sum, { order }) => sum + amountCents(order.paid), 0);
  const previousCents = previous.reduce((sum, { order }) => sum + amountCents(order.paid), 0);
  const knownOriginal = current.filter(({ order }) => order.original !== null);
  const originalCents = knownOriginal.reduce((sum, { order }) => sum + amountCents(order.original), 0);
  const savingsCents = knownOriginal.reduce((sum, { order }) => sum + amountCents(order.original) - amountCents(order.paid), 0);
  const knownTime = current.filter(({ order }) => order.timeKnown);
  const nightTimeKnownCount = knownTime.length;
  const nightCount = knownTime.filter(({ hour }) => hour >= 22 || hour < 6).length;
  const orderCount = current.length;
  const totalSpend = totalCents / 100;
  const nightRate = nightTimeKnownCount ? nightCount / nightTimeKnownCount : 0;
  const budgetUsed = totalCents / budgetCents;
  const kpis = {
    totalSpend, orderCount, averageOrder: orderCount ? Math.round(totalCents / orderCount) / 100 : 0,
    savings: savingsCents / 100, savingsRate: originalCents ? savingsCents / originalCents : 0,
    nightCount, nightRate, nightTimeKnownCount, budget: budgetCents / 100, budgetUsed,
    savingsOrderCount: knownOriginal.length,
    previousSpend: previousCents / 100,
    spendChange: previousCents ? (totalCents - previousCents) / previousCents : null,
  };
  if (orderCount && knownOriginal.length < orderCount) warnings.push(`优惠仅统计 ${knownOriginal.length}/${orderCount} 条同时提供有效原价和实付的订单，其余订单不推算优惠。`);
  if (nightTimeKnownCount < orderCount) warnings.push(`夜间统计仅覆盖 ${nightTimeKnownCount}/${orderCount} 条提供具体下单时刻的订单；仅提供日期的记录不计入夜间数量或占比。`);
  if (current.some(({ order }) => order.status !== 'completed')) warnings.push('部分订单未提供可识别的完成状态，已按其明确提供的实付金额统计；取消、退款和待支付记录已排除。');
  warnings.push('统计仅覆盖本次提供的记录；分页、缺失订单与导入范围可能影响结果，不代表完整消费历史。');
  const trend = Array.from({ length: dayCount }, (_, index) => {
    const date = shiftDay(from, index);
    return { date, label: date.slice(5).replace('-', '/'), amount: 0, count: 0 };
  });
  const trendMap = new Map(trend.map(day => [day.date, day]));
  const channelMap = new Map();
  const itemMap = new Map();
  for (const { order, date } of current) {
    const day = trendMap.get(date);
    day.amount += amountCents(order.paid);
    day.count += 1;
    const channel = channelMap.get(order.channel) || { name: order.channel, amount: 0, count: 0 };
    channel.amount += amountCents(order.paid);
    channel.count += 1;
    channelMap.set(order.channel, channel);
    for (const item of order.items) itemMap.set(item.name, (itemMap.get(item.name) || 0) + item.quantity);
  }
  for (const day of trend) day.amount /= 100;
  const channels = [...channelMap.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'zh-CN')).map(channel => ({ ...channel, amount: channel.amount / 100, share: totalCents ? channel.amount / totalCents : 0 }));
  const itemCount = [...itemMap.values()].reduce((sum, count) => sum + count, 0);
  const topItems = [...itemMap.entries()].map(([name, count]) => ({ name, count, share: itemCount ? count / itemCount : 0 })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 10);
  const insights = [];
  if (!orderCount) {
    insights.push({ id: 'empty', title: '分析师正在等数据开盘', body: `${from} 至 ${asOf} 没有可统计的实付订单。请检查日期范围、金额字段与订单状态。`, tone: 'neutral', evidence: { orderCount: 0, from, to: asOf } });
  } else {
    insights.push({ id: 'budget', title: budgetUsed > 1 ? '预算线已被汉堡突破' : '餐饮持仓仍在预算线内', body: `本期记录实付 ${money(totalSpend)}，共 ${orderCount} 单，单均 ${money(kpis.averageOrder)}；使用所设预算 ${percent(budgetUsed)}。${budgetUsed > 1 ? `超出 ${money((totalCents - budgetCents) / 100)}，请审阅自己的预算。` : `预算余额 ${money((budgetCents - totalCents) / 100)}，余额不构成加餐建议。`}`, tone: budgetUsed > 1 ? 'warning' : 'positive', evidence: { totalSpend, orderCount, averageOrder: kpis.averageOrder, budget: kpis.budget, budgetUsed } });
    if (previous.length && previousCents > 0) {
      const change = kpis.spendChange;
      insights.push({ id: 'comparison', title: change > 0 ? '餐饮现金流环比抬头' : change < 0 ? '餐饮现金流环比回落' : '本期支出横盘整理', body: `与已提供记录中的前 ${dayCount} 天相比，实付${change >= 0 ? '增加' : '减少'} ${percent(Math.abs(change))}；上期记录 ${money(kpis.previousSpend)}。两个期间都可能存在未提供的订单。`, tone: change > 0 ? 'warning' : 'neutral', evidence: { previousFrom, previousTo: shiftDay(from, -1), previousSpend: kpis.previousSpend, spendChange: change, previousOrderCount: previous.length } });
    }
    insights.push({ id: 'night', title: nightCount ? '夜盘成交，证据确凿' : nightTimeKnownCount ? '已知时刻中没有夜盘成交' : '下单时刻不足，暂不判断夜盘', body: `按北京时间 22:00—次日 05:59 统计，夜间订单 ${nightCount}/${nightTimeKnownCount} 单，占已知时刻订单的 ${percent(nightRate)}；具体时刻覆盖 ${nightTimeKnownCount}/${orderCount} 单。仅提供日期的记录不参与夜间统计。`, tone: nightRate >= 0.3 ? 'warning' : 'neutral', evidence: { nightCount, orderCount, nightTimeKnownCount, nightRate, timezone: CHINA_ZONE, startHour: 22, endHourExclusive: 6 } });
    if (topItems.length) {
      const top = topItems[0];
      insights.push({ id: 'holding', title: '第一大重仓，已浮出水面', body: `「${top.name}」在商品记录中共 ${top.count} 件，占已记录商品件数的 ${percent(top.share)}。套餐按返回的商品条目统计，不拆分虚构配料。`, tone: 'neutral', evidence: { name: top.name, count: top.count, itemCount, share: top.share } });
    }
    insights.push({ id: 'savings', title: savingsCents ? '优惠兑现，只认已知价差' : '优惠数据暂未形成正收益', body: `可核实的原价与实付覆盖 ${knownOriginal.length}/${orderCount} 单，价差合计 ${money(kpis.savings)}，占这些订单原价的 ${percent(kpis.savingsRate)}。没有原价的订单不估算折扣。`, tone: savingsCents ? 'positive' : 'neutral', evidence: { savings: kpis.savings, savingsRate: kpis.savingsRate, knownOriginalOrderCount: knownOriginal.length, orderCount, knownOriginalTotal: originalCents / 100 } });
  }
  const score = orderCount ? Math.max(0, Math.min(100, Math.round(100 - budgetUsed * 40))) : 0;
  const rating = {
    label: !orderCount ? '等待建仓' : budgetUsed > 1 ? '预算承压' : budgetUsed > 0.8 ? '关注预算' : '预算可控',
    score,
    description: !orderCount ? '当前区间无可统计订单，暂不评价。' : `娱乐性预算评分：max(0, 100 − 预算使用率 × 40)，本期 ${score}/100；不评价健康、财富或投资能力。`,
  };
  return { source, period: { days: dayCount, from, to: asOf, asOf }, kpis, trend, channels, topItems, insights, rating, orders: currentOrders, warnings: [...new Set(warnings)], generatedAt: new Date().toISOString() };
}

const escapeXml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const shorten = (value, max) => [...String(value)].slice(0, max).join('') + ([...String(value)].length > max ? '…' : '');

/** Standalone SVG with no remote assets, scripts, user markup, or foreignObject. */
export function renderReportSvg(report) {
  const { kpis, period, rating, topItems } = report;
  const top = topItems[0];
  const line = (x, y, value, className = '') => `<text x="${x}" y="${y}" class="${className}">${escapeXml(value)}</text>`;
  // Only self-contained PNG data may enter the image element; URLs and markup cannot.
  const artwork = typeof report.artwork === 'string' && report.artwork.length <= 4_000_000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(report.artwork) ? report.artwork : null;
  const hero = artwork
    ? `<image x="500" y="32" width="245" height="245" preserveAspectRatio="xMidYMid meet" href="${escapeXml(artwork)}"/>`
    : `<rect x="552" y="64" width="154" height="128" rx="28" fill="#db241c"/>${line(576, 143, 'McF', 'brand-badge')}`;
  const savings = !kpis.savingsOrderCount && kpis.orderCount ? '待补原价' : money(kpis.savings);
  const chart = { x: 64, y: 438, width: 672, height: 114 };
  // Preserve every day's money when a long report needs fewer visual bars.
  const groupSize = Math.max(1, Math.ceil(report.trend.length / 90));
  const sampled = [];
  for (let offset = 0; offset < report.trend.length; offset += groupSize) {
    const group = report.trend.slice(offset, offset + groupSize);
    sampled.push({ date: group[0].date, endDate: group.at(-1).date, amount: group.reduce((sum, day) => sum + amountCents(day.amount), 0) / 100, count: group.reduce((sum, day) => sum + day.count, 0) });
  }
  const max = Math.max(1, ...sampled.map(day => day.amount));
  const barWidth = chart.width / Math.max(1, sampled.length);
  const bars = sampled.map((day, index) => {
    const height = (day.amount / max) * chart.height;
    const dates = day.date === day.endDate ? day.date : `${day.date} — ${day.endDate}`;
    return `<rect x="${(chart.x + index * barWidth).toFixed(2)}" y="${(chart.y + chart.height - height).toFixed(2)}" width="${Math.max(1, barWidth - 3).toFixed(2)}" height="${height.toFixed(2)}" rx="2" fill="#db241c"><title>${escapeXml(`${dates} ${money(day.amount)} · ${day.count} 单`)}</title></rect>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="900" viewBox="0 0 800 900" role="img" aria-labelledby="title desc">
<title id="title">McFinance 个人餐饮消费研报</title><desc id="desc">${escapeXml(sourceLabel(report.source))}，${escapeXml(period.from)} 至 ${escapeXml(period.to)}，共 ${kpis.orderCount} 单，实付 ${escapeXml(money(kpis.totalSpend))}。</desc>
<style>text{font-family:Arial,'Microsoft YaHei',sans-serif;fill:#33251f;font-size:18px}.muted{fill:#786b60;font-size:15px}.red{fill:#db241c}.eyebrow{font-size:13px;letter-spacing:1.4px;font-weight:700}.headline{font-size:40px;font-weight:800;letter-spacing:-1px}.big{font-size:64px;font-weight:800;letter-spacing:-2px}.metric{font-size:30px;font-weight:800}.small{font-size:14px}.caption{fill:#786b60;font-size:13px}.brand-badge{fill:#ffdc57;font-size:51px;font-weight:800;letter-spacing:-3px}</style>
<rect width="800" height="900" rx="28" fill="#fffaf1"/><rect x="24" y="24" width="752" height="852" rx="22" fill="none" stroke="#eee1cd"/>
<rect x="24" y="24" width="752" height="210" rx="22" fill="#ffdc57"/>
${line(64, 73, 'McFINANCE  /  PERSONAL RESEARCH', 'eyebrow red')}
${line(64, 126, '个人麦门消费研报', 'headline')}
${line(64, 163, `${period.from} — ${period.to}  ·  北京时间`, 'small')}
<rect x="64" y="185" width="420" height="30" rx="15" fill="#fff6cf"/>${line(80, 205, sourceLabel(report.source), 'small red')}
${hero}
${line(64, 270, '本期记录实付', 'muted')}${line(60, 336, money(kpis.totalSpend), 'big red')}
${line(64, 379, `${kpis.orderCount} 单  /  单均 ${money(kpis.averageOrder)}  /  预算使用 ${percent(kpis.budgetUsed)}`, 'small')}
${line(64, 419, groupSize === 1 ? '每日支出  CNY' : `支出分布  CNY · 每 ${groupSize} 天汇总`, 'eyebrow muted')}${bars}
<line x1="64" x2="736" y1="554" y2="554" stroke="#e7d7c3"/>${line(64, 579, period.from, 'caption')}${line(646, 579, period.to, 'caption')}
<rect x="64" y="607" width="322" height="116" rx="16" fill="#fff0b9"/><rect x="402" y="607" width="334" height="116" rx="16" fill="#ffebe3"/>
${line(84, 638, '可核实优惠价差', 'muted')}${line(84, 678, savings, 'metric red')}${line(84, 705, `原价有效 ${kpis.savingsOrderCount ?? 0}/${kpis.orderCount} 单`, 'small muted')}
${line(422, 638, '夜盘订单 · 22:00—05:59', 'muted')}${line(422, 678, `${kpis.nightCount} 单 / ${percent(kpis.nightRate)}`, 'metric red')}${line(422, 705, `已知时刻 ${kpis.nightTimeKnownCount}/${kpis.orderCount} 单为分母`, 'small muted')}
${line(64, 764, `第一大重仓：${top ? `${shorten(top.name, 20)} · ${top.count} 件` : '暂无商品记录'}`, 'small')}
${line(64, 799, `预算观察：${rating.label}  ·  娱乐评分 ${rating.score}/100`, 'small red')}
${line(64, 837, '仅分析已提供记录，不代表完整历史；演示数据不代表个人消费。', 'caption')}
${line(64, 858, '娱乐性消费分析，不提供营养、健康或投资建议。', 'caption')}
</svg>`;
}

const escapeMarkdown = value => String(value).replace(/[\\`*_{}\[\]<>|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
export function renderReportMarkdown(report) {
  const { kpis, period } = report;
  const rows = [
    '# McFinance 个人麦门消费研报', '',
    `数据来源：${sourceLabel(report.source)}`, '',
    `区间：${period.from} 至 ${period.to}（北京时间，连续 ${period.days} 天）`, '',
    '| 指标 | 数值 |', '| --- | ---: |',
    `| 记录实付 | ${money(kpis.totalSpend)} |`,
    `| 订单数 | ${kpis.orderCount} |`,
    `| 单均实付 | ${money(kpis.averageOrder)} |`,
    `| 可核实优惠价差 | ${money(kpis.savings)} |`,
    `| 原价有效覆盖 | ${kpis.savingsOrderCount ?? 0}/${kpis.orderCount} 单 |`,
    `| 夜间订单（22:00—05:59） | ${kpis.nightCount}/${kpis.nightTimeKnownCount} 单 / ${percent(kpis.nightRate)}（以已知时刻订单为分母） |`,
    `| 下单时刻有效覆盖 | ${kpis.nightTimeKnownCount}/${kpis.orderCount} 单 |`,
    `| 所设预算 / 使用率 | ${money(kpis.budget)} / ${percent(kpis.budgetUsed)} |`, '',
    `预算观察：${report.rating.label}（娱乐评分 ${report.rating.score}/100）`, '',
    ...report.insights.flatMap(insight => [`## ${escapeMarkdown(insight.title)}`, '', escapeMarkdown(insight.body), '']),
    '## 商品记录', '', '| 商品 | 件数 | 已记录件数占比 |', '| --- | ---: | ---: |',
    ...report.topItems.map(item => `| ${escapeMarkdown(item.name)} | ${item.count} | ${percent(item.share)} |`), '',
    '## 数据说明', '', ...report.warnings.map(warning => `- ${escapeMarkdown(warning)}`), '',
    '娱乐性消费分析，不提供营养、健康或投资建议。', '',
  ];
  return rows.join('\n');
}
