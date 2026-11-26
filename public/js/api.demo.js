// In-browser mock of the Sufra API for the shareable demo. Mirrors the server's rules
// (server-side amounts, idempotency, reservations, BIN-restricted bank offers).
import { quote, BillingError, formatMoney } from '../shared/billing.js';

const TOKEN = 'demo_table_token_S1T1_xxxxxx';
let db;

function fresh() {
  return {
    restaurant: {
      slug: 'sahab-cafe', name_en: 'Sahab Café', name_ar: 'مقهى سحاب', currency: 'AED', logo_url: null, cover_url: null,
      brand_color: '#0b4f7c',
      menu: [
        { name_en: 'Breakfast', name_ar: 'الفطور', items: [
          { name_en: 'Avo Toast With Poached Egg', name_ar: 'توست أفوكادو مع بيض مسلوق', price_minor: 5400 },
          { name_en: 'Shakshuka', name_ar: 'شكشوكة', price_minor: 4200 },
          { name_en: 'Za\'atar Croissant', name_ar: 'كرواسون زعتر', price_minor: 2600 }] },
        { name_en: 'Drinks', name_ar: 'المشروبات', items: [
          { name_en: 'Spanish Latte Hot', name_ar: 'سبانش لاتيه ساخن', price_minor: 3200 },
          { name_en: 'Berry Cloudy', name_ar: 'بيري كلاودي', price_minor: 4100 },
          { name_en: 'Karak Tea', name_ar: 'شاي كرك', price_minor: 1200 }] },
      ],
    },
    table: { label: 'S1 T1' },
    policy: { tip_percents: [5, 7, 10], default_tip_percent: 7, max_tip_percent: 50, fee_bps: 175, fee_fixed_minor: 0, fee_cap_minor: null },
    offers: [
      { id: 'o1', kind: 'percent', value: 10, max_minor: 2000, min_spend_minor: null, title_en: '10% off · up to 20', title_ar: 'خصم 10٪ · حتى 20', bank_name: 'Gulf Digital Bank', theme: 'dark', bins: ['424242', '555555'] },
      { id: 'o2', kind: 'fixed', value: 5000, max_minor: null, min_spend_minor: 20000, title_en: '50 off · min 200', title_ar: 'خصم 50 · بحد أدنى 200', bank_name: 'Desert Bank', theme: 'blue', bins: ['411111'] },
      { id: 'o3', kind: 'percent', value: 20, max_minor: 5000, min_spend_minor: null, title_en: '20% off · up to 50', title_ar: 'خصم 20٪ · حتى 50', bank_name: 'Oasis Islamic Bank', theme: 'purple', bins: ['520000'] },
    ],
    promos: { WELCOME10: { kind: 'percent', value: 10, max_minor: 3000 } },
    bill: {
      total_minor: 21300, vat_minor: 1014,
      items: [
        { id: 'i1', name_en: 'Avo Toast With Poached Egg', name_ar: 'توست أفوكادو مع بيض مسلوق', unit_price_minor: 5400, qty: 2 },
        { id: 'i2', name_en: 'Spanish Latte Hot', name_ar: 'سبانش لاتيه ساخن', unit_price_minor: 3200, qty: 2 },
        { id: 'i3', name_en: 'Berry Cloudy', name_ar: 'بيري كلاودي', unit_price_minor: 4100, qty: 1 },
      ],
    },
    payments: [],
    idem: new Map(),
  };
}
db = fresh();

const live = () => db.payments.filter((p) => p.status === 'captured' || (p.status === 'pending' && p.expires > Date.now()));
function billState() {
  const settled = live().reduce((s, p) => s + p.share_minor, 0);
  const sq = new Map();
  for (const p of live()) for (const it of p.items ?? []) sq.set(it.id, (sq.get(it.id) ?? 0) + it.qty);
  return {
    currency: 'AED', total_minor: db.bill.total_minor, vat_minor: db.bill.vat_minor, settled_minor: settled,
    remaining_minor: Math.max(0, db.bill.total_minor - settled),
    payments_count: db.payments.filter((p) => p.status === 'captured').length,
    items: db.bill.items.map((i) => ({ ...i, settled_qty: sq.get(i.id) ?? 0 })),
  };
}
const err = (code, status = 422) => Object.assign(new Error(code), { code, status });
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));

function resolveOffer(body) {
  if (body.offer_id) {
    const o = db.offers.find((x) => x.id === body.offer_id);
    if (!o) throw err('OFFER_INVALID');
    return o;
  }
  if (body.promo_code) {
    const o = db.promos[body.promo_code.toUpperCase()];
    if (!o) throw err('OFFER_INVALID');
    return o;
  }
  return null;
}
function serverQuote(body) {
  const b = billState();
  if (b.remaining_minor <= 0 && db.closed) throw err('BILL_ALREADY_PAID');
  try {
    return quote(b, body, db.policy, resolveOffer(body));
  } catch (e) {
    if (e instanceof BillingError) throw err(e.code);
    throw e;
  }
}

export const api = {
  demo: true,
  demoToken: TOKEN,
  async getTable() {
    await wait(150);
    const b = billState();
    return {
      restaurant: db.restaurant, table: db.table, policy: db.policy,
      offers: db.offers.map(({ bins, ...o }) => o),
      bill: db.closed ? null : b,
    };
  },
  async quote(_t, body) {
    await wait();
    return serverQuote(body);
  },
  async pay(_t, body, key) {
    await wait(400);
    const sig = JSON.stringify(body);
    const prev = db.idem.get(key);
    if (prev) {
      if (prev.sig !== sig) throw err('IDEMPOTENCY_KEY_REUSED', 409);
      return { payment_id: prev.id, redirect_url: `demo:${prev.id}` };
    }
    const q = serverQuote(body);
    const offer = body.offer_id ? db.offers.find((o) => o.id === body.offer_id) : null;
    const p = { id: crypto.randomUUID(), status: 'pending', ...q, bins: offer?.bins ?? null, expires: Date.now() + 15 * 60_000 };
    db.payments.push(p);
    db.idem.set(key, { sig, id: p.id });
    return { payment_id: p.id, redirect_url: `demo:${p.id}` };
  },
  async payment(id) {
    await wait(300);
    const p = db.payments.find((x) => x.id === id);
    if (!p) throw err('NOT_FOUND', 404);
    return { ...p, name_en: db.restaurant.name_en, name_ar: db.restaurant.name_ar, public_token: TOKEN };
  },
  reset() { db = fresh(); },
  go(url) {
    const id = url.slice(5);
    const p = db.payments.find((x) => x.id === id);
    hostedPage(p);
  },
};

// Simulated provider hosted payment page.
function hostedPage(p) {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const scrim = el('div', 'scrim');
  const box = el('div', 'bottom-sheet hosted');
  const input = el('input');
  input.inputMode = 'numeric';
  input.value = p.bins ? `${p.bins[0]}0000000000`.slice(0, 16) : '4242424242424242';
  input.maxLength = 19;
  const msg = el('p', 'err', '');
  const payBtn = el('button', 'btn primary big', `Pay ${formatMoney(p.total_minor, p.currency, 'en')}`);
  const cancel = el('button', 'btn soft big', 'Cancel');
  const label = el('label', 'field', 'Card number');
  label.append(input);
  box.append(
    el('div', 'demo-flag', 'Payment provider page (simulated) · Apple Pay · Google Pay · Cards'),
    el('h2', null, db.restaurant.name_en),
    el('p', 'hosted-amt', formatMoney(p.total_minor, p.currency, 'en')),
    p.bins ? el('p', 'muted', `Bank offer: card must start with ${p.bins.join(' or ')}`) : el('span'),
    label, msg, payBtn, cancel,
    el('small', 'muted', '4242 4242 4242 4242 = success · 4000 0000 0000 0002 = declined'),
  );
  scrim.append(box);
  document.body.append(scrim);
  const finish = (status, card) => {
    p.status = status;
    if (card) { p.card_brand = card.startsWith('5') ? 'MASTERCARD' : 'VISA'; p.card_last4 = card.slice(-4); }
    if (status === 'captured' && billState().remaining_minor <= 0) db.closed = true;
    scrim.remove();
    window.dispatchEvent(new CustomEvent('sufra:return', { detail: p.id }));
  };
  payBtn.addEventListener('click', () => {
    const card = input.value.replace(/\s/g, '');
    if (!/^\d{16}$/.test(card)) { msg.textContent = 'Enter a 16-digit test card'; return; }
    if (p.bins && !p.bins.some((b) => card.startsWith(b))) { msg.textContent = 'This offer is only valid with the participating bank card.'; return; }
    payBtn.disabled = true;
    payBtn.textContent = '…';
    setTimeout(() => finish(card === '4000000000000002' ? 'failed' : 'captured', card), 900);
  });
  cancel.addEventListener('click', () => finish('failed'));
}
