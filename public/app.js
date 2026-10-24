import { normalizeOrders, renderReportSvg, renderReportMarkdown } from '/lib/analytics.js';

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = value => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = value => `${(Number(value || 0) * 100).toFixed(1)}%`;
const foodAssets = Object.freeze({ burger: '/assets/food/products/burger.png', fries: '/assets/food/products/fries.png', icecream: '/assets/food/products/icecream.png', coffee: '/assets/food/products/coffee.png' });
function foodForName(name) {
  if (/冰淇淋|圆筒|甜筒|新地|麦旋风|灰焰/i.test(name)) return { src: foodAssets.icecream, label: '甜品分类配图' };
  if (/咖啡|美式|拿铁|卡布|麦咖啡|McCaf/i.test(name)) return { src: foodAssets.coffee, label: '咖啡分类配图' };
  if (/薯条|薯饼/i.test(name) && !/汉堡|麦满分|套餐|双全盒/i.test(name)) return { src: foodAssets.fries, label: '小食分类配图' };
  return { src: foodAssets.burger, label: '餐品分类配图' };
}
const dateParts = value => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
const chinaDate = value => { const p = dateParts(value); return `${p.year}-${p.month}-${p.day}`; };
const state = { source: 'demo', days: 30, budget: 600, report: null, imported: null, asOf: null, importIsDemo: false, chart: 'amount', view: 'overview', page: 1, pageSize: 5, sortDesc: true, search: '', connection: null, assets: null, loading: false };
let committedOptions = null;
let heroArtwork = '';
let heroArtworkPromise;
function prepareHeroArtwork() {
  if (!heroArtworkPromise) heroArtworkPromise = (async () => {
    try {
      const response = await fetch('/assets/food/hero-feast.png');
      if (!response.ok) return;
      const blob = await response.blob();
      if (blob.type !== 'image/png' || blob.size > 3 * 1024 * 1024) return;
      heroArtwork = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
    } catch { /* The report remains readable if decorative artwork is unavailable. */ }
  })();
  return heroArtworkPromise;
}
const icons = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h3"/>',
  research: '<path d="M4 20V4h11l5 5v11zM15 4v5h5M8 14h8M8 17h5"/><path d="M8 8h3"/>',
  wallet: '<path d="M20 8V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15v12H5a2 2 0 0 1-2-2V6"/><path d="M20 12h-6v4h6M17 14h.01"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v2a6 6 0 0 1-12 0zM12 16v5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1-1.5 3M12 17h.01"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  spend: '<path d="M4 7h16v13H4zM4 11h16M8 16h4M7 4h10"/>',
  orders: '<path d="M7 3h10v18l-2-2-3 2-3-2-2 2zM10 7h4M10 11h4M10 15h2"/>',
  average: '<path d="M4 18V9m5 9V4m6 14v-7m5 7V6M3 21h19"/>',
  savings: '<path d="m3 12 9-9h8v8l-9 10z"/><circle cx="16" cy="7" r="1"/><path d="m8 12 5 5M9 16l4-4"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.research}</svg>`; }
function fillIcons(root = document) { $$('[data-icon]', root).forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 4500); }
function sourceName() { return ({ demo: '演示数据', live: 'MCP 真实订单', import: state.importIsDemo ? '导入示例数据' : '导入订单' })[state.source]; }
async function api(path, body) {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error('本地服务返回异常，请确认服务仍在运行。'); }
  if (!response.ok) { const error = new Error(data.error?.message || `请求失败 (${response.status})`); error.details = data.error?.details; throw error; }
  return data;
}
function setBusy(busy) { state.loading = busy; $('#dashboard').setAttribute('aria-busy', String(busy)); $('#dashboard').classList.toggle('loading', busy); $('#refresh-button [data-icon]').classList.toggle('spinner', busy); $$('[data-days],#source-button,#export-button,#refresh-button,#sidebar-connect,#bottom-connect,#connect-mcp,#disconnect-mcp,#sync-mcp,#use-demo,#order-file,[data-source-tab],#mcp-token,#mcp-args,#budget-button').forEach(button => { button.disabled = busy; }); }
async function loadReport() {
  if (state.loading) return;
  setBusy(true); $('#error-banner').hidden = true;
  try {
    const report = state.source === 'import'
      ? await api('/api/analyze', { orders: state.imported, days: state.days, budget: state.budget, asOf: state.asOf })
      : await api(`/api/report?${new URLSearchParams({ source: state.source, days: state.days, budget: state.budget })}`);
    state.report = report; state.page = 1; render();
  } catch (error) { if (committedOptions) { Object.assign(state, committedOptions); render(); } $('#error-banner').textContent = error.message; $('#error-banner').hidden = false; toast(error.message, true); }
  finally { setBusy(false); }
}
function spark(values) { const max = Math.max(1, ...values); const points = values.map((v, i) => `${i * 64 / Math.max(1, values.length - 1)},${25 - v / max * 22}`).join(' '); return `<svg class="kpi-spark" viewBox="0 0 64 27" aria-hidden="true"><polyline points="${points}"/></svg>`; }
function renderKpis() {
  const { kpis: k, trend } = state.report;
  const change = k.spendChange == null ? '上期无可比数据' : `较上一等长区间 ${k.spendChange >= 0 ? '+' : ''}${pct(k.spendChange)}`;
  const cards = [
    { title: '区间消费总额', icon: 'spend', value: `<small>¥</small>${money(k.totalSpend)}`, foot: `${esc(change)}`, spark: trend.slice(-12).map(day => day.amount) },
    { title: '累计下单', icon: 'orders', value: `${k.orderCount}<span class="unit">单</span>`, foot: `日均 <strong>${(k.orderCount / state.days).toFixed(1)}</strong> 单 · 可见订单样本`, spark: trend.slice(-12).map(day => day.count) },
    { title: '平均每单', icon: 'average', value: `<small>¥</small>${money(k.averageOrder)}`, foot: `消费总额 ÷ <strong>${k.orderCount}</strong> 笔订单` },
    { title: '已核实优惠', icon: 'savings', value: k.orderCount && !k.savingsOrderCount ? '<span class="missing-value">待补原价</span>' : `<small>¥</small>${money(k.savings)}`, foot: `原价覆盖 <strong>${k.savingsOrderCount ?? 0}/${k.orderCount}</strong> 单 · 差额累计` },
  ];
  const photos = [foodAssets.burger, foodAssets.fries, foodAssets.coffee, foodAssets.icecream];
  $('#kpi-grid').innerHTML = cards.map((card, index) => `<article class="kpi-card"><div class="kpi-top"><span>${card.title}</span><span class="kpi-icon">${icon(card.icon)}</span></div><div class="kpi-value">${card.value}</div><img class="kpi-food" src="${photos[index]}" alt="" width="640" height="640" decoding="async"><div class="kpi-foot">${card.foot}</div></article>`).join('');
}
function renderChart() {
  const { trend, kpis: k } = state.report;
  const isMoney = state.chart === 'amount';
  const values = trend.map(day => isMoney ? day.amount : day.count);
  const rawMax = Math.max(1, ...values);
  const step = isMoney ? Math.max(10, Math.ceil(rawMax / 4 / 10) * 10) : Math.max(1, Math.ceil(rawMax / 4));
  const max = step * 4;
  const width = 700, height = 180, left = 33, right = 12, top = 12, bottom = 29;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const x = i => left + i * plotWidth / Math.max(1, trend.length - 1);
  const y = value => top + (1 - value / max) * plotHeight;
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  const area = `M${left},${y(0)} L${points.join(' L')} L${x(values.length - 1)},${y(0)} Z`;
  const lines = Array.from({ length: 5 }, (_, i) => `<line x1="${left}" x2="${width - right}" y1="${y(i * step)}" y2="${y(i * step)}" class="chart-grid"/><text x="${left - 9}" y="${y(i * step) + 3}" text-anchor="end" class="chart-axis">${i * step}</text>`).join('');
  const indices = [...new Set(Array.from({ length: Math.min(7, trend.length) }, (_, i) => Math.round(i * (trend.length - 1) / Math.min(6, trend.length - 1))))];
  const labels = indices.map(i => `<text x="${x(i)}" y="${height - 6}" text-anchor="${i === 0 ? 'start' : i === trend.length - 1 ? 'end' : 'middle'}" class="chart-axis">${trend[i].label}</text>`).join('');
  const peak = values.indexOf(Math.max(...values));
  const targets = trend.map((day, i) => `<rect class="chart-target" x="${x(i) - plotWidth / trend.length / 2}" y="0" width="${plotWidth / trend.length}" height="${height}" data-index="${i}"><title>${day.date}：${isMoney ? `¥${money(day.amount)}` : `${day.count} 单`}</title></rect>`).join('');
  $('#trend-chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${state.days}天每日${isMoney ? '消费金额' : '订单数'}折线图，区间${isMoney ? `消费${money(k.totalSpend)}元` : `${k.orderCount}单`}"><defs><linearGradient id="chart-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#e13237" stop-opacity=".16"/><stop offset="100%" stop-color="#e13237" stop-opacity="0"/></linearGradient></defs>${lines}<path d="${area}" class="chart-area"/><polyline points="${points.join(' ')}" class="chart-line" vector-effect="non-scaling-stroke"/><circle cx="${x(peak)}" cy="${y(values[peak])}" r="4" class="chart-dot"/>${labels}${targets}</svg><div class="chart-tooltip" hidden></div>`;
  const wrap = $('#trend-chart'); const tooltip = $('.chart-tooltip', wrap);
  $$('.chart-target', wrap).forEach(rect => { rect.addEventListener('pointerenter', () => { const i = Number(rect.dataset.index); const day = trend[i]; tooltip.innerHTML = `<small>${day.date}</small>${isMoney ? `¥${money(day.amount)}` : `${day.count} 单`}`; tooltip.style.left = `${Math.max(9, Math.min(91, x(i) / width * 100))}%`; tooltip.hidden = false; }); });
  wrap.onpointerleave = () => { tooltip.hidden = true; };
  $('#chart-total').textContent = isMoney ? `¥${money(k.totalSpend)}` : `${k.orderCount} 单`;
  $('#chart-caption').textContent = isMoney ? '区间累计消费 / CNY' : '区间累计订单 / ORDERS';
  $('.chart-legend').innerHTML = `<i></i>每日${isMoney ? '消费' : '下单'}`;
  $('#chart-average').textContent = `日均 ${isMoney ? `¥${money(k.totalSpend / state.days)}` : `${(k.orderCount / state.days).toFixed(1)} 单`} / ${state.days} 天`;
}
function renderRating() {
  const { rating: r, kpis: k } = state.report;
  $('#rating-content').innerHTML = `<div class="rating-score"><div class="rating-emblem"><strong>${Math.round(r.score)}</strong></div><div><div class="rating-name">${esc(r.label)}</div><div class="rating-subtitle">PERSONAL CONSUMPTION REVIEW</div></div></div><div class="rating-copy">${k.orderCount ? `这段时间的快乐账单是 ¥${money(k.totalSpend)}，占区间预算的 ${pct(k.budgetUsed)}。给每一笔日常消费，一点有数的仪式感。` : '当前统计区间没有有效订单。换个周期或补充数据，再开启这次消费观察。'}</div><div class="rating-meter" role="meter" aria-label="区间预算使用比例" aria-valuenow="${Math.round(k.budgetUsed * 100)}" aria-valuemin="0" aria-valuemax="${Math.max(100, Math.round(k.budgetUsed * 100))}"><span style="width:${Math.min(100, k.budgetUsed * 100)}%"></span></div><div class="rating-meter-caption"><span>预算使用 ${pct(k.budgetUsed)}</span><button class="text-button" id="budget-button" title="设置当前统计周期的消费预算">预算 ¥${money(k.budget)} ✎</button></div>`;
  $('#budget-button').addEventListener('click', showBudgetDialog);
}
function evidenceText(evidence) {
  if (Array.isArray(evidence)) return evidence.map(evidenceText).join(' · ');
  if (!evidence || typeof evidence !== 'object') return String(evidence || '依据当前可见订单');
  const labels = { totalSpend: '实付', orderCount: '订单', averageOrder: '客单价', budget: '预算', budgetUsed: '预算进度', previousSpend: '上期实付', previousOrderCount: '上期订单', spendChange: '区间变化', nightCount: '夜间订单', nightTimeKnownCount: '时刻已知', nightRate: '夜间占比', savings: '优惠差额', savingsOrderCount: '原价覆盖', savingsRate: '优惠比例', quantity: '数量', count: '份数', share: '占比', name: '餐品', topItem: '第一持仓', itemCount: '餐品总份数' };
  return Object.entries(evidence).filter(([key]) => key in labels).slice(0, 4).map(([key, value]) => `${labels[key]} ${['totalSpend', 'averageOrder', 'budget', 'previousSpend', 'savings'].includes(key) ? `¥${money(value)}` : ['budgetUsed', 'spendChange', 'nightRate', 'savingsRate', 'share'].includes(key) ? pct(value) : typeof value === 'object' ? evidenceText(value) : String(value)}`).join(' · ') || '依据本期可见订单，详见数据口径';
}
function renderInsights() {
  const insights = state.report.insights.slice(0, state.view === 'research' ? 12 : 3);
  $('#insight-grid').innerHTML = insights.map((item, i) => `<article class="insight-card"><div class="insight-kicker">研究手记 ${String(i + 1).padStart(2, '0')}<span>${['数据观察', '研报摘录', '消费笔记'][i % 3]}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.body)}</p><div class="evidence">依据 / ${esc(evidenceText(item.evidence))}</div></article>`).join('');
}
function renderOrders() {
  if (!state.report) return;
  let orders = state.report.orders.filter(order => `${order.id} ${order.items.map(item => item.name).join(' ')} ${order.channel}`.toLowerCase().includes(state.search.toLowerCase()));
  orders.sort((a, b) => (state.sortDesc ? -1 : 1) * a.orderedAt.localeCompare(b.orderedAt));
  const pageSize = state.view === 'orders' ? 12 : 5;
  const pages = Math.max(1, Math.ceil(orders.length / pageSize));
  state.page = Math.max(1, Math.min(state.page, pages));
  const start = (state.page - 1) * pageSize, shown = orders.slice(start, start + pageSize);
  $('#orders-count').textContent = state.report.orders.length;
  $('#orders-body').innerHTML = shown.length ? shown.map(order => {
    const p = dateParts(order.orderedAt); const title = order.items.map(item => `${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''}`).join(' + ') || '未提供餐品明细';
    const food = foodForName(title);
    return `<tr><td><div class="order-cell"><span class="order-symbol" title="${food.label}"><img class="order-food" src="${food.src}" alt="" width="640" height="640" loading="lazy" decoding="async"></span><div><div class="order-main">${esc(title)}</div><div class="order-id">${esc(order.id)}</div></div></div></td><td><div class="order-date">${p.month}.${p.day}</div><div class="order-time">${order.timeKnown === false ? '时间未提供' : `${p.hour}:${p.minute}`}</div></td><td><span class="channel-label ${order.channel === '麦乐送' ? 'delivery' : ''}">${esc(order.channel)}</span></td><td class="align-right order-amount">¥${money(order.paid)}</td></tr>`;
  }).join('') : '<tr><td colspan="4"><div class="empty-state"><strong>这里还没有订单</strong>试试其他关键词、统计周期，或导入新的订单数据。</div></td></tr>';
  $('#table-info').textContent = orders.length ? `显示 ${start + 1}–${Math.min(start + pageSize, orders.length)} 笔 / 共 ${orders.length} 笔${state.search ? '匹配订单' : '订单'}` : '没有匹配的订单';
  $('#page-number').textContent = `${state.page} / ${pages}`;
  $('#prev-page').disabled = state.page <= 1; $('#next-page').disabled = state.page >= pages;
  $('#sort-orders span').textContent = state.sortDesc ? '↓' : '↑';
}
function renderPreferences() {
  const items = state.report.topItems.slice(0, 5); const top = items[0]?.count || 1;
  $('#preference-content').innerHTML = items.length ? items.map((item, i) => `<div class="preference-item"><div class="preference-row"><span class="preference-rank">${String(i + 1).padStart(2, '0')}</span><img class="preference-portrait" src="${foodForName(item.name).src}" title="${foodForName(item.name).label}" alt="" width="640" height="640" loading="lazy" decoding="async"><span class="preference-name" title="${esc(item.name)}">${esc(item.name)}</span><strong>${item.count}<small>份 · ${pct(item.share)}</small></strong></div><div class="preference-track"><span style="width:${item.count / top * 100}%"></span></div></div>`).join('') : '<div class="empty-state">当前订单没有餐品明细。<br>补全 items 后，可分析口味偏好。</div>';
}
function renderAssets() {
  const data = state.source === 'live' ? state.assets : null;
  if (!data) { $('#assets-content').innerHTML = `<div class="empty-state"><strong>等一份真实的资产快照。</strong>连接官方 MCP 后，可只读查询账户积分与优惠券。<br>演示模式不展示虚构的个人积分或券资产。</div><div class="assets-intro">已核实优惠 <strong class="green">¥${money(state.report.kpis.savings)}</strong> 来自订单原价与实付差额。它不代表当前可领取的优惠券价值。</div>`; return; }
  const a = data.account || {}, c = data.coupons || {};
  const hasOwned = c.ownedAvailable ?? c.available, hasClaimable = c.claimableAvailable ?? c.available;
  $('#assets-content').innerHTML = `<div class="assets-grid"><article class="asset-card"><span>POINTS / ACCOUNT</span><h3>${typeof a.points === 'number' ? `${a.points.toLocaleString()} 积分` : '积分字段未返回'}</h3><p>${esc(a.memberTier || '仅展示官方本次返回的可识别字段')}</p></article><article class="asset-card"><span>COUPONS / OWNED</span><h3>${hasOwned ? `${c.ownedCount} 类持有券` : '本次未查询到券数据'}</h3><p>本次返回 ${c.ownedReturnedCount ?? c.ownedCount ?? 0} 类；${c.ownedTotalKnown ? '总数来自官方字段' : '未确认是否覆盖完整卡包'}</p></article><article class="asset-card"><span>COUPONS / AVAILABLE</span><h3>${hasClaimable ? `${c.availableCount} 项可领优惠` : '待官方工具返回'}</h3><p>查询结果仅供查看，不自动领券</p></article></div>${c.items?.length ? `<div class="assets-grid">${c.items.map(item => `<article class="asset-card"><span>OWNED COUPON</span><h3>${esc(item.title)}</h3><p>${item.expiresAt ? `有效期 / ${esc(item.expiresAt)}` : '有效期以官方渠道为准'}</p></article>`).join('')}</div>` : ''}<p class="assets-intro">${esc((data.warnings || []).join(' '))}</p>`;
}
function render() {
  const r = state.report, k = r.kpis;
  $('#dashboard').hidden = false;
  committedOptions = { source: state.source, days: state.days, budget: state.budget, asOf: state.asOf, importIsDemo: state.importIsDemo, imported: state.imported };
  $('#date-range').textContent = `${r.period.from.replaceAll('-', '.')} — ${r.period.to.replaceAll('-', '.')}`;
  $('#source-badge').innerHTML = `<span class="live-dot"></span>${sourceName()}`;
  $('#source-badge').classList.toggle('real', state.source === 'live');
  $('#source-note').innerHTML = state.source === 'demo' ? '<span>DEMO</span>当前为固定样本演示，不代表你的真实消费。连接 MCP 或导入订单，生成自己的研报。' : state.source === 'import' ? `<span>${state.importIsDemo ? 'SAMPLE' : 'IMPORT'}</span>${state.importIsDemo ? '这是导入的示例订单，不代表你的真实消费。' : '基于本次导入订单分析。'}截至 ${esc(r.period.asOf)}；不代表完整历史。` : '<span>LIVE</span>基于官方 MCP 本次返回的订单分析；工具分页与查询范围可能影响结果，不代表完整历史。';
  $('#ticker-content').innerHTML = `<span>McSPEND <strong>¥${money(k.totalSpend)}</strong><em>${k.spendChange == null ? '—' : `${k.spendChange >= 0 ? '↗ +' : '↘ '}${pct(k.spendChange)}`}</em></span><span>McORDERS <strong>${k.orderCount}</strong><em>单</em></span><span>McSAVED <strong>¥${money(k.savings)}</strong><em>已核实</em></span><span>NIGHT <strong>${pct(k.nightRate)}</strong></span>`;
  $$('[data-days]').forEach(button => { button.classList.toggle('active', Number(button.dataset.days) === state.days); button.setAttribute('aria-pressed', String(Number(button.dataset.days) === state.days)); });
  renderKpis(); renderChart(); renderRating(); renderInsights(); renderOrders(); renderPreferences(); renderAssets();
  $('#quality-count').textContent = ` / ${r.warnings.length} 条说明`;
  $('#quality-warnings').innerHTML = [...new Set(r.warnings)].map(warning => `<li>${esc(warning)}</li>`).join('');
  $('#report-stamp').textContent = `${sourceName()} · 北京时间 · 仅分析可见样本`;
  $('#report-bottom').hidden = state.source === 'live';
}
function setView(view) {
  state.view = view; state.page = 1; document.body.dataset.view = view;
  const names = { overview: '消费总览', orders: '订单账本', research: '研报中心', assets: '优惠资产' };
  const titles = { overview: '每一笔麦，<br>都有快乐回报', orders: '一笔一笔，<br>记下快乐', research: '让数据，<br>替快乐发言', assets: '优惠资产，<br>心中有数' };
  const subtitles = { overview: '汉堡、薯条、小确幸。把你的日常，写成一份快乐研报。', orders: '查找喜欢的餐品，回看属于你的每一个麦门时刻。', research: '认真看数据，快乐写研报。每个观点都有订单作证。', assets: '查账户、看优惠。把已经拥有的小快乐，认真收好。' };
  $('#breadcrumb-name').textContent = names[view]; $('#page-title').innerHTML = `${titles[view]}<span class="green">。</span>`; $('#page-subtitle').textContent = subtitles[view];
  $$('.nav-item').forEach(button => { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'); });
  if (state.report) { renderInsights(); renderOrders(); }
}
function setSourceTab(tab) { $$('[data-source-tab]').forEach(button => button.classList.toggle('active', button.dataset.sourceTab === tab)); ['demo', 'live', 'import'].forEach(value => { $(`#source-${value}`).hidden = value !== tab; }); $('#source-status').textContent = ''; }
function openSource(tab = state.source) { setSourceTab(tab); $('#source-dialog').showModal(); updateConnection(); }
function dialogStatus(message, error = false) { const el = $('#source-status'); el.textContent = message; el.classList.toggle('error', error); }
function connectionUI(status) {
  state.connection = status;
  $('#sidebar-connection').textContent = status.connected ? 'MCP 已连接 · 只读访问' : status.configured ? '服务端已配置 · 待连接' : '演示环境 · 未连接 MCP';
  $('.connection-light').classList.toggle('connected', !!status.connected);
  $('#mcp-arguments').hidden = !status.connected;
  const tool = status.tools?.find(tool => tool.name === 'order-list');
  $('#mcp-schema').textContent = tool ? JSON.stringify(tool.inputSchema, null, 2) : '未发现 order-list 工具。';
  $('#connection-message').textContent = status.connected ? `已连接官方 MCP，发现 ${status.tools?.length || 0} 个只读工具。${tool ? '可以同步订单。' : '当前未发现 order-list，请检查账号权限。'}` : status.message || '仅调用订单、积分、优惠券查询工具。';
  $('#connection-message').classList.remove('error');
}
async function updateConnection() { try { connectionUI(await api('/api/connection')); } catch { /* Dashboard remains usable without connection inspection. */ } }
async function initializeApp() {
  setBusy(true);
  try {
    const connection = await api('/api/connection'); connectionUI(connection);
    if (connection.connected && connection.hasLiveData) { state.source = 'live'; state.assets = await api('/api/assets?source=live'); }
  } catch { /* A connection inspection failure leaves the offline demo available. */ }
  finally { setBusy(false); }
  await loadReport();
}
async function connectMcp() {
  if (state.loading) return;
  setBusy(true); dialogStatus('正在连接官方 MCP，并发现工具参数…');
  const token = $('#mcp-token').value.trim();
  try { const status = await api('/api/connect', token ? { token } : {}); $('#mcp-token').value = ''; connectionUI(status); dialogStatus('连接完成。请检查参数后同步订单。'); }
  catch (error) { $('#mcp-token').value = ''; dialogStatus(error.message, true); $('#connection-message').textContent = error.message; $('#connection-message').classList.add('error'); await updateConnection(); }
  finally { if (token) { state.assets = null; if (state.source === 'live') { state.source = 'demo'; state.report = null; committedOptions = null; $('#dashboard').hidden = true; setBusy(false); await loadReport(); } } setBusy(false); }
}
async function syncMcp() {
  if (state.loading) return;
  setBusy(true); dialogStatus('正在只读查询订单、积分与优惠券…');
  try { let args; try { args = JSON.parse($('#mcp-args').value); } catch { throw new Error('调用参数不是有效 JSON，请检查格式。'); }
    const data = await api('/api/sync', { arguments: args, days: state.days, budget: state.budget });
    state.source = 'live'; state.imported = null; state.importIsDemo = false; state.report = data.report; state.assets = data; state.page = 1; render(); $('#source-dialog').close(); toast('真实订单已同步，研报已生成。');
  } catch (error) { if (error.details?.inputSchema) $('#mcp-schema').textContent = JSON.stringify(error.details.inputSchema, null, 2); dialogStatus(error.message, true); await updateConnection(); }
  finally { setBusy(false); }
}
async function importOrders(event) {
  const file = event.target.files?.[0]; if (!file) return;
  if (state.loading) return;
  setBusy(true);
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，请缩小订单范围。');
    let raw; try { raw = JSON.parse(await file.text()); } catch { throw new Error('文件不是有效的 JSON，请检查文件内容。'); }
    const parsed = normalizeOrders(raw); if (!parsed.orders.length) throw new Error(parsed.warnings.join(' ') || '没有可分析的订单。');
    const asOf = typeof raw.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.asOf) ? raw.asOf : parsed.orders.map(order => chinaDate(order.orderedAt)).sort().at(-1);
    const report = await api('/api/analyze', { orders: raw, days: state.days, asOf, budget: state.budget });
    state.source = 'import'; state.imported = raw; state.asOf = asOf; state.importIsDemo = raw.source === 'demo' || raw.isDemo === true || /demo|sample|示例|演示/i.test(file.name); state.report = report; state.page = 1;
    $('#import-filename').textContent = file.name; render(); $('#source-dialog').close(); toast(`已导入 ${parsed.orders.length} 条订单，以 ${asOf} 为统计截止日。`);
  } catch (error) { dialogStatus(error.message, true); }
  finally { event.target.value = ''; setBusy(false); }
}
function exportReport() {
  const report = { ...state.report, ...(state.importIsDemo ? { source: 'demo' } : {}), ...(heroArtwork ? { artwork: heroArtwork } : {}) };
  return report;
}
async function openExport() { if (!state.report) return; await prepareHeroArtwork(); $('#export-preview').innerHTML = renderReportSvg(exportReport()); $('#export-dialog').showModal(); }
function download(content, filename, type) { const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000); toast('研报已准备下载。'); }
function showBudgetDialog() {
  let dialog = $('#budget-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.id = 'budget-dialog'; dialog.className = 'modal';
    dialog.innerHTML = '<form id="budget-form"><div class="modal-heading"><div><span class="section-label">PERSONAL BUDGET</span><h2>给这段快乐，设个预算。</h2></div><button type="button" class="icon-button" id="close-budget" aria-label="关闭预算窗口">✕</button></div><p class="modal-description">预算对应当前所选统计周期，单位为人民币元。切换周期后可重新设置；预算只影响个人消费观察。</p><label class="field-label" for="budget-input">区间消费预算 / CNY</label><input id="budget-input" class="text-input" type="number" min="0.01" max="1000000" step="0.01" required><p class="field-help">保存在当前页面内存，刷新页面后恢复默认值。</p><button class="button primary full-width" type="submit">更新预算与评级 ↗</button></form>';
    document.body.append(dialog); $('#close-budget').addEventListener('click', () => dialog.close());
    $('#budget-form').addEventListener('submit', async event => { event.preventDefault(); state.budget = Number($('#budget-input').value); dialog.close(); await loadReport(); toast('区间预算已更新。'); });
  }
  $('#budget-input').value = state.budget; dialog.showModal();
}
function bindEvents() {
  $$('.nav-item').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('[data-open-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.openView)));
  $$('[data-days]').forEach(button => button.addEventListener('click', () => { state.days = Number(button.dataset.days); loadReport(); }));
  $$('[data-chart]').forEach(button => button.addEventListener('click', () => { state.chart = button.dataset.chart; $$('[data-chart]').forEach(b => b.classList.toggle('active', b === button)); renderChart(); }));
  ['#source-button', '#sidebar-connect', '#bottom-connect'].forEach(selector => $(selector).addEventListener('click', () => openSource(selector === '#bottom-connect' ? 'live' : state.source)));
  $$('[data-source-tab]').forEach(button => button.addEventListener('click', () => setSourceTab(button.dataset.sourceTab)));
  $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
  $('#use-demo').addEventListener('click', async () => { state.source = 'demo'; state.importIsDemo = false; state.imported = null; $('#source-dialog').close(); await loadReport(); });
  $('#connect-mcp').addEventListener('click', connectMcp); $('#sync-mcp').addEventListener('click', syncMcp);
  $('#disconnect-mcp').addEventListener('click', async () => { if (state.loading) return; setBusy(true); try { const status = await api('/api/disconnect', {}); connectionUI(status); state.assets = null; if (state.source === 'live') { state.source = 'demo'; state.report = null; committedOptions = null; $('#dashboard').hidden = true; setBusy(false); await loadReport(); } dialogStatus('已断开连接，并清除本次连接的内存凭证。'); } catch (error) { dialogStatus(error.message, true); } finally { setBusy(false); } });
  $('#order-file').addEventListener('change', importOrders);
  $('#refresh-button').addEventListener('click', async () => { await loadReport(); });
  $('#help-button').addEventListener('click', () => { $('#help-dialog').showModal(); });
  $('#export-button').addEventListener('click', openExport);
  $('#download-svg').addEventListener('click', () => download(renderReportSvg(exportReport()), `McFinance-${state.report.period.to}.svg`, 'image/svg+xml;charset=utf-8'));
  $('#download-markdown').addEventListener('click', () => download(renderReportMarkdown(exportReport()), `McFinance-${state.report.period.to}.md`, 'text/markdown;charset=utf-8'));
  $('#order-search').addEventListener('input', event => { state.search = event.target.value; state.page = 1; renderOrders(); });
  $('#sort-orders').addEventListener('click', () => { state.sortDesc = !state.sortDesc; renderOrders(); });
  $('#prev-page').addEventListener('click', () => { state.page--; renderOrders(); });
  $('#next-page').addEventListener('click', () => { state.page++; renderOrders(); });
  $('#import-example').textContent = JSON.stringify([{ id: 'my-order-001', orderedAt: '2026-10-24T12:10:00+08:00', paid: 18.9, original: 26, items: [{ name: '巨无霸', quantity: 1 }], channel: '到店取餐', status: 'completed' }], null, 2);
}

fillIcons(); bindEvents(); setView('overview'); prepareHeroArtwork(); initializeApp();
