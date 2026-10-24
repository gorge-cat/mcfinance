/** Entirely synthetic fixtures. These are not real menu prices, offers, or personal orders. */
export const DEMO_AS_OF = '2026-10-24';
const menu = [
  { name: '巨无霸套餐', original: 42, paid: 29.9 },
  { name: '麦辣鸡腿堡套餐', original: 39, paid: 25.9 },
  { name: '麦香鱼', original: 22, paid: 15.9 },
  { name: '板烧鸡腿堡套餐', original: 41, paid: 28.9 },
  { name: '薯条（大）', original: 15, paid: 10.5 },
  { name: '麦乐鸡 5 块', original: 15.5, paid: 10 },
  { name: '美式咖啡', original: 15, paid: 9.9 },
  { name: '吉士蛋麦满分套餐', original: 25, paid: 18.9 },
];
let state = 20261024;
const random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
};
const orders = [];
const end = Date.parse(`${DEMO_AS_OF}T00:00:00Z`);
for (let offset = 89; offset >= 0; offset -= 1) {
  const date = new Date(end - offset * 86_400_000).toISOString().slice(0, 10);
  const count = random() < 0.2 ? 0 : random() < 0.18 ? 2 : 1;
  for (let sequence = 0; sequence < count; sequence += 1) {
    const item = menu[Math.floor(random() * menu.length)];
    const addSide = random() < 0.28;
    const side = menu[4 + Math.floor(random() * 3)];
    const night = random() < (offset < 30 ? 0.32 : 0.13);
    const hour = night ? (random() < 0.65 ? 22 : 0) : [8, 11, 12, 13, 18, 19][Math.floor(random() * 6)];
    const minute = Math.floor(random() * 60);
    const index = orders.length + 1;
    const paid = Math.round((item.paid + (addSide ? side.paid : 0)) * 100) / 100;
    const original = Math.round((item.original + (addSide ? side.original : 0)) * 100) / 100;
    orders.push({
      id: `DEMO-${date.replaceAll('-', '')}-${sequence + 1}`,
      orderedAt: `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
      paid, original: index % 13 === 0 ? null : original,
      items: [{ name: item.name, quantity: 1 }, ...(addSide ? [{ name: side.name, quantity: 1 }] : [])],
      channel: random() < 0.36 ? '麦乐送' : '到店取餐',
      status: index % 19 === 0 ? 'cancelled' : index % 29 === 0 ? 'refunded' : 'completed',
    });
  }
}
export const DEMO_ORDERS = Object.freeze(orders.map(order => Object.freeze({ ...order, items: Object.freeze(order.items.map(item => Object.freeze(item))) })));
