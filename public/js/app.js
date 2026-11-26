// Orderize diner app. Plain DOM — never innerHTML with data, so restaurant/menu content
// cannot inject markup or scripts.
import { api } from './api.js';
import { STR, detectLang, saveLang } from './i18n.js';
import { formatMoney, parseMajor, quote, remainingOf, BillingError } from '../shared/billing.js';
import { createMenu } from './menu.js';

const root = document.getElementById('app');
const S = {
  lang: detectLang(),
  token: null,
  data: null,
  view: 'home',
  split: { mode: 'full' },
  tip: null,
  offerId: null,
  promo: null, // { code, quote }
  coupon: null, // { id, quote }
  auth: { country: null, phone: '', challenge: null, hint: '', devCode: null, sentAt: 0, code: '', profile: { name: '', gender: '', birth_date: '', marketing_consent: false } },
  account: null,
  consent: false,
  showItems: false,
  sheet: null,
  draft: null,
  busy: false,
  toast: null,
  idem: { body: '', key: '' },
};

// ---------- tiny DOM helper
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const t = (k) => STR[S.lang][k] ?? k;
const errText = (code) => STR[S.lang].errors[code] ?? STR[S.lang].errors.DEFAULT;
const money = (m) => formatMoney(m, S.data.restaurant.currency, S.lang);
const nm = (o) => (S.lang === 'ar' ? o.name_ar : o.name_en);
const ttl = (o) => (S.lang === 'ar' ? o.title_ar : o.title_en);
const icon = (d, size = 20) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
};
const I = {
  back: 'M15 18l-6-6 6-6', chev: 'M9 18l6-6-6-6', globe: 'M12 2a10 10 0 100 20 10 10 0 000-20zM2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20',
  receipt: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6', menu: 'M4 3v8a3 3 0 003 3v7M10 3v8M7 3v8M17 3c-2 2-2 6 0 8v10',
  users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  tag: 'M20.6 13.4L13.4 20.6a2 2 0 01-2.8 0L2 12V2h10l8.6 8.6a2 2 0 010 2.8zM7 7h.01', lock: 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  check: 'M20 6L9 17l-5-5', user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z', star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z', gift: 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z', x: 'M18 6L6 18M6 6l12 12', bell: 'M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0', search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
};

// ---------- money logic (display only — the server recomputes everything)
function billForCalc() {
  const b = S.data.bill;
  return { currency: S.data.restaurant.currency, total_minor: b.total_minor, settled_minor: b.settled_minor, items: b.items };
}
function payBody() {
  return {
    split: S.split,
    tip: S.tip ?? { type: 'none' },
    ...(S.offerId ? { offer_id: S.offerId } : {}),
    ...(S.promo ? { promo_code: S.promo.code } : {}),
    ...(S.coupon ? { coupon_id: S.coupon.id } : {}),
    marketing_consent: S.consent,
  };
}
function currentQuote() {
  const offer = S.offerId ? S.data.offers.find((o) => o.id === S.offerId) : null;
  try {
    const q = quote(billForCalc(), payBody(), S.data.policy, offer);
    const sq = S.promo?.quote || S.coupon?.quote;
    if (sq) {
      // Promo / coupon discounts come from the server; recompute fee/total around them.
      const d = Math.min(sq.discount_minor, q.share_minor - 1);
      const fee = sq.share_minor === q.share_minor ? sq.fee_minor : q.fee_minor;
      return { ...q, discount_minor: d, fee_minor: fee, total_minor: q.share_minor - d + fee + q.tip_minor };
    }
    return q;
  } catch (e) {
    if (e instanceof BillingError) return { error: e.code };
    throw e;
  }
}

async function refreshPromo() {
  const holder = S.promo || S.coupon;
  if (!holder) return;
  try {
    holder.quote = await api.quote(S.token, payBody());
  } catch (e) {
    S.promo = null;
    S.coupon = null;
    toast(errText(e.code));
  }
  render();
}

const toastEl = h('div', { class: 'toast', role: 'status' });
function toast(msg) {
  S.toast = msg;
  toastEl.textContent = msg;
  if (!toastEl.isConnected) root.append(toastEl);
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { S.toast = null; toastEl.remove(); }, 3200);
}

// ---------- shared chrome
function topBar({ back } = {}) {
  return h('header', { class: 'top' },
    back ? h('button', { class: 'icon-btn', 'aria-label': t('back'), onclick: back }, icon(I.back)) : h('span'),
    back ? h('div', { class: 'top-title' }, nm(S.data.restaurant)) : h('span'),
    h('div', { class: 'row gap' },
      S.data?.me ? h('button', { class: 'pill', 'aria-label': t('myAccount'), onclick: () => openAccount() }, icon(I.user, 16),
        S.data.restaurant && S.data.loyalty?.enabled ? `${S.data.me.points} ${t('points')}` : t('myAccount')) : null,
      h('button', { class: 'pill', onclick: () => { S.lang = S.lang === 'ar' ? 'en' : 'ar'; saveLang(S.lang); render(); } },
        icon(I.globe, 16), S.lang === 'ar' ? 'EN' : 'ع')),
  );
}

function offerCard(o, { compact } = {}) {
  const on = S.offerId === o.id;
  return h('button', {
    class: `offer theme-${o.theme} ${on ? 'on' : ''} ${compact ? 'compact' : ''}`,
    onclick: () => {
      S.offerId = on ? null : o.id;
      S.promo = null;
      S.coupon = null;
      if (S.view === 'home') S.view = 'pay';
      render();
    },
  },
  h('span', { class: 'offer-bank' }, o.bank_name),
  h('span', { class: 'offer-title' }, ttl(o)),
  h('span', { class: 'offer-cta' }, on ? [icon(I.check, 14), t('applied')] : [t('apply'), icon(I.chev, 14)]),
  );
}

// ---------- views
function viewHome() {
  const r = S.data.restaurant;
  const b = S.data.bill;
  const initials = (r.name_en.match(/\b\w/g) || []).slice(0, 2).join('');
  return h('div', { class: 'home' },
    h('div', { class: 'cover', style: { background: `linear-gradient(160deg, ${r.brand_color}, #111)` } },
      mediaImg(r.menu?.cover, 'cover-img') || safeImg(r.cover_url, 'cover-img'),
      topBar(),
      h('div', { class: 'hero' },
        h('div', { class: 'logo', style: { background: r.brand_color } }, mediaImg(r.menu?.logo) || safeImg(r.logo_url) || initials),
        h('p', { class: 'eyebrow' }, t('welcome')),
        h('h1', null, nm(r)),
      ),
    ),
    h('section', { class: 'sheet' },
      S.data.offers.length ? h('div', { class: 'carousel' }, S.data.offers.map((o) => offerCard(o, { compact: true }))) : null,
      b && remainingOf({ ...b }) > 0
        ? h('button', { class: 'btn primary big', onclick: () => go('pay') }, icon(I.receipt), `${t('payNow')} · ${money(b.remaining_minor)}`)
        : statusBox(),
      hasMenu(r.menu) ? h('button', { class: 'btn soft big', onclick: () => go('menu') }, icon(I.menu), t('viewMenu')) : null,
      M.hasOrders() ? h('button', { class: 'btn soft big', onclick: () => M.openSheet('orders') }, icon(I.receipt), t('yourOrders')) : null,
      r.menu?.waiter_call ? h('button', { class: 'btn ghost', onclick: () => M.openSheet('help') }, icon(I.bell, 18), t('callWaiter')) : null,
      h('p', { class: 'powered' }, 'Orderize', h('small', null, t('terms'))),
    ),
  );
}

function statusBox() {
  const b = S.data.bill;
  if (b) return h('div', { class: 'status ok' }, h('strong', null, t('paid')), h('p', null, t('paidSub')));
  return h('div', { class: 'status' }, h('strong', null, t('noBill')), h('p', null, t('noBillSub')));
}

function mediaImg(url, cls) {
  if (typeof url !== 'string' || !/^\/media\/[0-9a-f-]{36}$/i.test(url)) return null;
  return h('img', { src: url, alt: '', class: cls });
}

function safeImg(url, cls) {
  if (!url || !/^https:\/\//.test(url)) return null;
  return h('img', { src: url, alt: '', class: cls, referrerpolicy: 'no-referrer', loading: 'lazy' });
}

const hasMenu = (m) => Boolean(m && (m.categories?.length || m.pdf || m.images?.length));

function viewUploadedMenu(m) {
  const pages = m.images ?? [];
  return h('div', { class: 'page menu-doc' },
    topBar({ back: () => go(S.data.require_phone && !S.data.me ? 'login' : 'home') }),
    m.pdf ? h('a', { class: 'menu-pdf', href: `/media/${m.pdf}`, target: '_blank', rel: 'noopener' },
      h('span', { class: 'menu-pdf-ic' }, icon(I.menu)),
      h('span', null, h('strong', null, t('openPdf')), h('small', null, t('pdfHint'))),
      h('span', { class: 'menu-pdf-go' }, '›')) : null,
    pages.length ? h('div', { class: 'menu-pages' },
      pages.map((id, i) => h('figure', { class: 'menu-sheet' },
        h('a', { href: `/media/${id}`, target: '_blank', rel: 'noopener' },
          h('img', { src: `/media/${id}`, alt: `${t('menu')} ${i + 1}`, loading: i ? 'lazy' : 'eager', decoding: 'async' })),
        pages.length > 1 ? h('figcaption', null, `${i + 1} / ${pages.length}`) : null))) : null,
    S.data.bill?.remaining_minor > 0 ? h('div', { class: 'dock' }, h('button', { class: 'btn primary big', onclick: () => go('pay') }, t('payNow'))) : null,
  );
}

function viewMenu() {
  const m = S.data.restaurant.menu;
  if (m.mode === 'file' || (!m.categories?.length && (m.pdf || m.images?.length))) return viewUploadedMenu(m);
  if (m.categories?.length) return M.view();
  const desc = (it) => (S.lang === 'ar' ? it.description_ar || it.description_en : it.description_en || it.description_ar);
  return h('div', { class: 'page' },
    topBar({ back: () => go(S.data.require_phone && !S.data.me ? 'login' : 'home') }),
    h('div', { class: 'menu' },
      m.categories.map((cat) => h('section', { class: 'card' },
        h('h2', null, nm(cat)),
        cat.items.map((it) => h('div', { class: 'menu-item' },
          h('div', { class: 'row' }, h('strong', null, nm(it)), h('span', { class: 'num' }, money(it.price_minor))),
          desc(it) ? h('small', { class: 'muted' }, desc(it)) : null)),
      )),
    ),
    S.data.bill?.remaining_minor > 0 ? h('div', { class: 'dock' }, h('button', { class: 'btn primary big', onclick: () => go('pay') }, t('payNow'))) : null,
  );
}

function viewPay() {
  const r = S.data.restaurant;
  const b = S.data.bill;
  if (!b || b.remaining_minor <= 0) return h('div', { class: 'page' }, topBar({ back: () => go('home') }), h('div', { class: 'pad' }, statusBox()));
  const q = currentQuote();
  const policy = S.data.policy;

  const items = h('div', { class: `items ${S.showItems ? 'open' : ''}` },
    b.items.map((i) => h('div', { class: 'row item' },
      h('span', { class: 'qty' }, `${i.qty}×`),
      h('span', { class: 'grow' }, nm(i), i.settled_qty ? h('small', { class: 'muted' }, ` · ${t('alreadyPaid')} ${i.settled_qty}`) : null),
      h('span', { class: 'num' }, money(i.unit_price_minor * i.qty)),
    )),
    b.vat_minor ? h('div', { class: 'row muted' }, h('span', null, t('vat')), h('span', { class: 'num' }, money(b.vat_minor))) : null,
    b.settled_minor ? h('div', { class: 'row muted' }, h('span', null, t('alreadyPaid')), h('span', { class: 'num' }, `− ${money(b.settled_minor)}`)) : null,
  );

  const splitLabel = {
    full: t('payFull'),
    equal: S.split.mode === 'equal' ? `${S.split.pay}/${S.split.parts} · ${t('splitEqual')}` : '',
    items: t('payItems'),
    custom: t('custom'),
  }[S.split.mode];

  const tipBtns = policy.tip_percents.map((p) => {
    const on = S.tip?.type === 'percent' && S.tip.value === p;
    const amt = q.share_minor ? Math.floor((q.share_minor * p) / 100 + 0.5) : 0;
    return h('button', { class: `tip ${on ? 'on' : ''}`, onclick: () => { S.tip = on ? { type: 'none' } : { type: 'percent', value: p }; afterChange(); } },
      h('strong', null, `${p}%`), h('small', null, money(amt)),
      p === policy.default_tip_percent ? h('em', null, t('mostPopular')) : null,
      on ? h('span', { class: 'tip-x', 'aria-label': t('remove') }, icon(I.x, 12)) : null,
    );
  });

  return h('div', { class: 'page' },
    topBar({ back: () => go('home') }),
    h('section', { class: 'card head' },
      h('div', { class: 'row' },
        h('div', null, h('div', { class: 'label' }, `${t('table')}: ${S.data.table.label}`), h('div', { class: 'muted' }, nm(r))),
      ),
      h('div', { class: 'row big' }, h('div', null, h('strong', null, t('payable')), h('small', { class: 'muted block' }, t('inclusive'))),
        h('strong', { class: 'num' }, money(b.remaining_minor))),
      h('button', { class: 'split-row', onclick: () => openSheet('split') },
        h('span', { class: 'avatars' }, icon(I.users)),
        h('span', { class: 'grow' }, h('strong', null, t('splitBill')), h('small', { class: 'muted block' }, S.split.mode === 'full' ? t('splitSub') : splitLabel)),
        icon(I.chev, 18)),
      h('button', { class: 'link', onclick: () => { S.showItems = !S.showItems; render(); } }, S.showItems ? t('hideBill') : t('viewBill')),
      items,
    ),

    h('section', { class: 'card' },
      h('h2', null, t('tipTitle')),
      h('p', { class: 'muted' }, t('tipSub')),
      h('div', { class: 'tips' }, tipBtns),
      h('div', { class: 'or' }, h('span', null, t('or'))),
      h('button', { class: 'row-btn', onclick: () => openSheet('tip') }, icon(I.edit, 18),
        h('span', { class: 'grow' }, S.tip?.type === 'amount' ? `${t('customTip')}: ${money(S.tip.amount_minor)}` : t('customTip')), icon(I.plus, 18)),
    ),

    S.data.me?.coupons?.length ? h('section', { class: 'card' },
      h('h2', null, t('yourCoupons')),
      h('div', { class: 'carousel' }, S.data.me.coupons.map((k) => couponCard(k))),
    ) : null,

    S.data.offers.length ? h('section', { class: 'card' },
      h('h2', null, t('bankOffers')),
      h('div', { class: 'carousel' }, S.data.offers.map((o) => offerCard(o))),
    ) : null,

    h('section', { class: 'card' },
      S.promo
        ? h('div', { class: 'row-btn on' }, icon(I.tag, 18), h('span', { class: 'grow' }, `${S.promo.code} · ${t('applied')}`),
          h('button', { class: 'link', onclick: () => { S.promo = null; render(); } }, t('remove')))
        : h('button', { class: 'row-btn', onclick: () => openSheet('promo') }, icon(I.tag, 18), h('span', { class: 'grow' }, t('promo')), icon(I.chev, 18)),
    ),

    h('section', { class: 'card summary' },
      q.error
        ? h('p', { class: 'err' }, errText(q.error))
        : [
          h('div', { class: 'row' }, h('span', null, t('yourShare')), h('span', { class: 'num' }, money(q.share_minor))),
          q.discount_minor ? h('div', { class: 'row good' }, h('span', null, t('discount')), h('span', { class: 'num' }, `− ${money(q.discount_minor)}`)) : null,
          q.fee_minor ? h('div', { class: 'row muted' }, h('span', null, t('serviceFee')), h('span', { class: 'num' }, money(q.fee_minor))) : null,
          h('div', { class: 'row muted' }, h('span', null, t('tip')), h('span', { class: 'num' }, money(q.tip_minor))),
          h('div', { class: 'row total' }, h('strong', null, t('youPay')), h('strong', { class: 'num' }, money(q.total_minor))),
          h('small', { class: 'muted' }, t('includes')),
        ],
      h('label', { class: 'consent' },
        h('input', { type: 'checkbox', checked: S.consent, onchange: (e) => { S.consent = e.target.checked; } }),
        h('span', null, t('consent'))),
    ),

    h('div', { class: 'dock' },
      h('button', { class: 'btn primary big', disabled: S.busy || !!q.error, onclick: () => submit(q) },
        icon(I.lock, 18), S.busy ? '…' : `${t('pay')} · ${q.error ? '' : money(q.total_minor)}`),
      h('small', { class: 'secure' }, t('secure')),
    ),
  );
}

// ---------- bottom sheets
function openSheet(kind) {
  S.sheet = kind;
  if (kind === 'split') S.draft = structuredClone(S.split.mode === 'full' ? { mode: 'equal', parts: 2, pay: 1 } : S.split);
  if (kind === 'tip') S.draft = { value: S.tip?.type === 'amount' ? String(S.tip.amount_minor / 10 ** decimals()) : '' };
  if (kind === 'promo') S.draft = { code: '' };
  render();
}
const decimals = () => ({ KWD: 3, BHD: 3, OMR: 3 })[S.data.restaurant.currency] ?? 2;
const closeSheet = () => { S.sheet = null; S.draft = null; render(); };

function stepper(value, min, max, set) {
  return h('div', { class: 'stepper' },
    h('button', { 'aria-label': '−', disabled: value <= min, onclick: () => set(value - 1) }, icon(I.minus, 16)),
    h('span', { class: 'num' }, value),
    h('button', { 'aria-label': '+', disabled: value >= max, onclick: () => set(value + 1) }, icon(I.plus, 16)),
  );
}

function sheetSplit() {
  const d = S.draft;
  const tabs = [['full', t('payFull')], ['equal', t('splitEqual')], ['items', t('payItems')], ['custom', t('custom')]];
  const setMode = (m) => {
    S.draft = m === 'equal' ? { mode: 'equal', parts: 2, pay: 1 } : m === 'items' ? { mode: 'items', items: [] } : m === 'custom' ? { mode: 'custom', raw: '' } : { mode: 'full' };
    render();
  };
  let body;
  if (d.mode === 'equal') {
    body = [
      h('div', { class: 'row' }, h('span', null, t('people')), stepper(d.parts, 2, 30, (v) => { d.parts = v; d.pay = Math.min(d.pay, v); render(); })),
      h('div', { class: 'row' }, h('span', null, t('iPayFor')), stepper(d.pay, 1, d.parts, (v) => { d.pay = v; render(); })),
    ];
  } else if (d.mode === 'items') {
    body = S.data.bill.items.map((i) => {
      const avail = i.qty - i.settled_qty;
      const sel = d.items.find((x) => x.id === i.id);
      const q = sel?.qty ?? 0;
      return h('div', { class: `row ${avail <= 0 ? 'muted' : ''}` },
        h('span', { class: 'grow' }, nm(i), h('small', { class: 'muted block' }, money(i.unit_price_minor))),
        avail > 0 ? stepper(q, 0, avail, (v) => {
          d.items = d.items.filter((x) => x.id !== i.id);
          if (v > 0) d.items.push({ id: i.id, qty: v });
          render();
        }) : h('small', null, t('alreadyPaid')));
    });
  } else if (d.mode === 'custom') {
    body = h('label', { class: 'field' }, t('amount'),
      h('input', { inputmode: 'decimal', value: d.raw, placeholder: (0).toFixed(decimals()), oninput: (e) => { d.raw = e.target.value; } }));
  } else body = h('p', { class: 'muted' }, money(S.data.bill.remaining_minor));

  const confirm = () => {
    let sel = d;
    if (d.mode === 'custom') {
      try { sel = { mode: 'custom', amount_minor: parseMajor(d.raw, S.data.restaurant.currency) }; } catch { return toast(errText('INVALID_AMOUNT')); }
    }
    if (d.mode === 'items' && !d.items.length) return;
    S.split = sel.mode === 'items' ? { mode: 'items', items: sel.items.map(({ id, qty }) => ({ id, qty })) } : sel;
    closeSheet();
    afterChange();
  };
  return [h('h2', null, t('splitBill')),
    h('div', { class: 'tabs' }, tabs.map(([m, l]) => h('button', { class: d.mode === m ? 'on' : '', onclick: () => setMode(m) }, l))),
    h('div', { class: 'sheet-body' }, body),
    h('button', { class: 'btn primary big', onclick: confirm }, t('confirm'))];
}

function sheetTip() {
  const d = S.draft;
  return [h('h2', null, t('customTip')),
    h('label', { class: 'field' }, t('amount'),
      h('input', { inputmode: 'decimal', value: d.value, placeholder: (0).toFixed(decimals()), oninput: (e) => { d.value = e.target.value; } })),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn soft', onclick: () => { S.tip = { type: 'none' }; closeSheet(); afterChange(); } }, t('noTip')),
      h('button', { class: 'btn primary grow', onclick: () => {
        try { S.tip = { type: 'amount', amount_minor: parseMajor(d.value || '0', S.data.restaurant.currency) }; } catch { return toast(errText('INVALID_AMOUNT')); }
        closeSheet(); afterChange();
      } }, t('confirm')))];
}

function sheetPromo() {
  const d = S.draft;
  return [h('h2', null, t('promo')),
    h('label', { class: 'field' }, t('promoPh'),
      h('input', { value: d.code, autocapitalize: 'characters', maxlength: 32, oninput: (e) => { d.code = e.target.value.trim(); } })),
    h('button', { class: 'btn primary big', onclick: async () => {
      if (!/^[A-Za-z0-9-]{3,32}$/.test(d.code)) return toast(errText('OFFER_INVALID'));
      S.offerId = null;
      S.coupon = null;
      S.promo = { code: d.code.toUpperCase() };
      closeSheet();
      await refreshPromo();
    } }, t('apply'))];
}

function afterChange() {
  render();
  if (S.promo || S.coupon) refreshPromo();
}

// ---------- payment
async function submit(q) {
  if (S.busy || q.error) return;
  const body = payBody();
  const sig = JSON.stringify(body);
  // Same body => same idempotency key, so a double-tap or retry can never charge twice.
  if (S.idem.body !== sig) S.idem = { body: sig, key: crypto.randomUUID().replace(/-/g, '') };
  S.busy = true;
  render();
  try {
    const p = await api.pay(S.token, body, S.idem.key);
    api.go(p.redirect_url);
  } catch (e) {
    S.busy = false;
    toast(errText(e.code));
    if (['ITEM_UNAVAILABLE', 'AMOUNT_EXCEEDS_REMAINING', 'BILL_ALREADY_PAID'].includes(e.code)) await load();
  }
}

async function viewReturn(id) {
  root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' }), h('p', null, t('processing'))));
  let p;
  for (let i = 0; i < 20; i++) {
    try { p = await api.payment(id); } catch { break; }
    if (p.status === 'captured' || p.status === 'failed' || p.status === 'expired') break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const ok = p?.status === 'captured';
  const cur = p?.currency;
  const fm = (m) => formatMoney(m, cur, S.lang);
  document.documentElement.lang = S.lang;
  document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  root.replaceChildren(h('div', { class: 'center result' },
    h('div', { class: `badge ${ok ? 'ok' : 'bad'}` }, icon(ok ? I.check : I.x, 36)),
    h('h1', null, ok ? t('success') : t('failed')),
    ok ? null : h('p', { class: 'muted' }, t('failedSub')),
    ok ? h('section', { class: 'card receipt' },
      h('h2', null, `${t('receipt')} · ${S.lang === 'ar' ? p.name_ar : p.name_en}`),
      h('div', { class: 'row' }, h('span', null, t('yourShare')), h('span', { class: 'num' }, fm(p.share_minor))),
      p.discount_minor ? h('div', { class: 'row good' }, h('span', null, t('discount')), h('span', { class: 'num' }, `− ${fm(p.discount_minor)}`)) : null,
      p.fee_minor ? h('div', { class: 'row' }, h('span', null, t('serviceFee')), h('span', { class: 'num' }, fm(p.fee_minor))) : null,
      h('div', { class: 'row' }, h('span', null, t('tip')), h('span', { class: 'num' }, fm(p.tip_minor))),
      h('div', { class: 'row total' }, h('strong', null, t('youPay')), h('strong', { class: 'num' }, fm(p.total_minor))),
      p.card_last4 ? h('small', { class: 'muted' }, `${t('card')}: ${p.card_brand ?? ''} •••• ${p.card_last4}`) : null,
      p.points_earned ? h('div', { class: 'row good' }, h('span', null, t('pointsEarned')), h('strong', null, `+${p.points_earned}`)) : null,
    ) : null,
    ok ? ratingBlock(p) : null,
    p?.public_token ? h('button', { class: 'btn primary big', onclick: () => { if (!api.demo) history.replaceState(null, '', `/t/${p.public_token}`); boot(); } },
      ok ? t('backToBill') : t('tryAgain')) : null,
  ));
}


// ---------- diner identity (WhatsApp sign-in), coupons, account
const COUNTRY_BY_CURRENCY = { AED: '971', SAR: '966', QAR: '974', KWD: '965', BHD: '973', OMR: '968' };
const COUNTRIES = [['971', '🇦🇪 +971'], ['966', '🇸🇦 +966'], ['974', '🇶🇦 +974'], ['965', '🇰🇼 +965'], ['973', '🇧🇭 +973'], ['968', '🇴🇲 +968']];

function couponTitle(k) {
  const cur = S.data?.restaurant?.currency ?? k.currency;
  if (k.kind === 'free_item') return `${k.item_name} · ${t('free')}`;
  if (k.kind === 'percent') return `${k.value}% ${t('off')}${k.max_minor ? ` · ${t('upTo')} ${formatMoney(Number(k.max_minor), cur, S.lang)}` : ''}`;
  return `${formatMoney(Number(k.value), cur, S.lang)} ${t('off')}`;
}

function couponCard(k) {
  const on = S.coupon?.id === k.id;
  return h('button', {
    class: `offer theme-green ${on ? 'on' : ''}`,
    onclick: () => {
      S.coupon = on ? null : { id: k.id };
      S.offerId = null;
      S.promo = null;
      afterChange();
    },
  },
  h('span', { class: 'offer-bank' }, k.name),
  h('span', { class: 'offer-title' }, couponTitle(k)),
  h('span', { class: 'offer-cta' }, on ? [icon(I.check, 14), t('applied')] : [t('apply'), icon(I.chev, 14)]));
}

function authShell(title, sub, ...body) {
  return h('div', { class: 'page' },
    topBar(),
    h('section', { class: 'card auth' },
      h('div', { class: 'auth-icon' }, icon(I.lock, 26)),
      h('h1', null, title), sub ? h('p', { class: 'muted' }, sub) : null, ...body,
      h('small', { class: 'muted' }, t('privacy'))));
}

function viewLogin() {
  const a = S.auth;
  a.country ??= COUNTRY_BY_CURRENCY[S.data.restaurant.currency] ?? '971';
  const sel = h('select', { class: 'cc', 'aria-label': 'country', onchange: (e) => { a.country = e.target.value; } },
    COUNTRIES.map(([v, l]) => h('option', { value: v, selected: v === a.country }, l)));
  const inp = h('input', { inputmode: 'tel', autocomplete: 'tel-national', placeholder: '5x xxx xxxx', value: a.phone, dir: 'ltr', oninput: (e) => { a.phone = e.target.value; } });
  const send = async () => {
    if (S.busy) return;
    S.busy = true;
    try {
      const r = await api.otpRequest(a.country, a.phone);
      Object.assign(a, { challenge: r.challenge_id, hint: r.phone_hint, devCode: r.dev_code ?? null, sentAt: Date.now(), code: '' });
      S.view = 'otp';
    } catch (e) { toast(errText(e.code)); }
    S.busy = false;
    render();
  };
  return authShell(t('signInTitle'), t('signInSub'),
    h('label', { class: 'field' }, t('phone'), h('div', { class: 'phone-row', dir: 'ltr' }, sel, inp)),
    h('button', { class: 'btn primary big', disabled: S.busy, onclick: send }, t('sendCode')),
    hasMenu(S.data.restaurant.menu) ? h('button', { class: 'btn soft big', onclick: () => go('menu') }, icon(I.menu), t('viewMenu')) : null);
}

function viewOtp() {
  const a = S.auth;
  const wait = Math.max(0, 45 - Math.floor((Date.now() - a.sentAt) / 1000));
  if (wait > 0) { clearTimeout(viewOtp.t); viewOtp.t = setTimeout(() => S.view === 'otp' && render(), 1000); }
  const inp = h('input', {
    class: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, dir: 'ltr', value: a.code, placeholder: '••••••',
    oninput: (e) => { a.code = e.target.value.replace(/\D/g, '').slice(0, 6); e.target.value = a.code; if (a.code.length === 6) verify(); },
  });
  async function verify() {
    if (S.busy || a.code.length !== 6) return;
    S.busy = true;
    try {
      const r = await api.otpVerify(a.challenge, a.code);
      S.view = r.needs_profile ? 'profile' : (S.afterLogin ?? 'home');
      if (!r.needs_profile) S.afterLogin = null;
      await load();
    } catch (e) { toast(errText(e.code)); a.code = ''; }
    S.busy = false;
    render();
  }
  setTimeout(() => inp.focus(), 50);
  return authShell(t('codeTitle'), [t('codeSub'), ' ', h('bdi', { dir: 'ltr' }, a.hint)],
    a.devCode ? h('p', { class: 'demo-flag' }, `${t('demoCode')} ${a.devCode}`) : null,
    inp,
    h('button', { class: 'btn primary big', disabled: S.busy || a.code.length !== 6, onclick: verify }, t('verify')),
    h('div', { class: 'row' },
      h('button', { class: 'link', onclick: () => { S.view = 'login'; render(); } }, t('changeNumber')),
      h('button', { class: 'link', disabled: wait > 0, onclick: () => { S.view = 'login'; render(); } }, wait > 0 ? `${t('resendIn')} ${wait}s` : t('resend'))));
}

function viewProfile() {
  const p = S.auth.profile;
  const g = (v) => h('button', { class: `seg ${p.gender === v ? 'on' : ''}`, onclick: () => { p.gender = v; render(); } }, t(v));
  const save = async () => {
    try {
      await api.saveProfile({ name: p.name.trim(), gender: p.gender, birth_date: p.birth_date, marketing_consent: p.marketing_consent });
      S.view = S.afterLogin ?? 'home';
      S.afterLogin = null;
      await load();
    } catch (e) { toast(errText(e.code)); }
  };
  return authShell(t('profileTitle'), null,
    h('label', { class: 'field' }, t('name'), h('input', { value: p.name, autocomplete: 'given-name', maxlength: 60, oninput: (e) => { p.name = e.target.value; } })),
    h('div', { class: 'field' }, t('gender'), h('div', { class: 'segs' }, g('male'), g('female'))),
    h('label', { class: 'field' }, t('birthDate'), h('input', { type: 'date', value: p.birth_date, max: new Date(Date.now() - 13 * 365.25 * 864e5).toISOString().slice(0, 10), onchange: (e) => { p.birth_date = e.target.value; render(); } }),
      h('small', { class: 'muted' }, t('birthdayNote'))),
    h('label', { class: 'consent' }, h('input', { type: 'checkbox', checked: p.marketing_consent, onchange: (e) => { p.marketing_consent = e.target.checked; } }), h('span', null, t('marketing'))),
    h('button', { class: 'btn primary big', onclick: () => (p.name.trim().length >= 2 && p.gender && p.birth_date ? save() : toast(errText('VALIDATION_FAILED'))) }, t('continue')));
}

async function openAccount() {
  try {
    S.account = await api.me();
    S.view = 'account';
  } catch (e) { toast(errText(e.code)); }
  render();
  window.scrollTo(0, 0);
}

function viewAccount() {
  const a = S.account;
  const nm2 = (o) => (S.lang === 'ar' ? o.name_ar : o.name_en);
  const date = (d) => new Date(d).toLocaleDateString(S.lang === 'ar' ? 'ar' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return h('div', { class: 'page' },
    topBar({ back: () => { S.view = S.data.bill ? 'home' : 'home'; render(); } }),
    h('section', { class: 'card' }, h('h2', null, `${t('hi')} ${a.customer.name ?? ''}`), h('small', { class: 'muted', dir: 'ltr' }, a.customer.phone)),
    h('section', { class: 'card' }, h('h2', null, t('myPoints')),
      a.points.length ? a.points.map((x) => h('div', { class: 'row' }, h('span', null, nm2(x)), h('strong', { class: 'num' }, `${x.points} ${t('points')}`)))
        : h('p', { class: 'muted' }, '0')),
    h('section', { class: 'card' }, h('h2', null, t('myCoupons')),
      a.coupons.length ? a.coupons.map((k) => h('div', { class: 'coupon-row' },
        icon(I.gift, 20),
        h('div', { class: 'grow' }, h('strong', null, couponTitle(k)), h('small', { class: 'muted block' }, `${S.lang === 'ar' ? k.restaurant_ar : k.restaurant_en} · ${t('validUntil')} ${date(k.valid_until)}`))))
        : h('p', { class: 'muted' }, t('noCoupons'))),
    h('section', { class: 'card' }, h('h2', null, t('myOrders')),
      a.orders.length ? a.orders.map((o) => h('div', { class: 'row' },
        h('div', null, h('span', null, nm2(o)), h('small', { class: 'muted block' }, date(o.captured_at))),
        h('div', { class: 'num' }, formatMoney(Number(o.total_minor), o.currency, S.lang), o.points ? h('small', { class: 'muted block' }, `+${o.points} ${t('points')}`) : null)))
        : h('p', { class: 'muted' }, t('noOrders'))),
    h('section', { class: 'card' },
      h('button', { class: 'btn soft big', onclick: async () => { await api.logout(); S.account = null; S.view = 'login'; await load(); } }, t('signOut')),
      h('button', { class: 'link danger', onclick: async () => { if (!confirm(t('deleteConfirm'))) return; await api.deleteMe(); S.account = null; S.view = 'login'; await load(); } }, t('deleteAccount'))));
}

function ratingBlock(p) {
  if (p.rated) return null;
  const box = h('section', { class: 'card rating' });
  let stars = 0;
  const comment = h('textarea', { maxlength: 1000, rows: 2, placeholder: t('rateComment') });
  const draw = () => {
    box.replaceChildren(
      h('h2', null, t('rateTitle')),
      h('div', { class: 'stars', role: 'radiogroup' }, [1, 2, 3, 4, 5].map((n) =>
        h('button', { class: `star ${n <= stars ? 'on' : ''}`, 'aria-label': `${n}`, onclick: () => { stars = n; draw(); } }, icon(I.star, 32)))),
      stars ? comment : null,
      stars ? h('button', { class: 'btn primary', onclick: send }, t('send')) : null);
  };
  async function send() {
    try {
      const r = await api.rate(p.id, stars, comment.value.trim());
      // The Google invitation is shown to everyone, whatever the rating (Google forbids review gating).
      box.replaceChildren(h('h2', null, t('thanks')),
        r.google_review_url && /^https:\/\//.test(r.google_review_url)
          ? h('div', { class: 'google-ask' }, h('p', { class: 'muted' }, t('googleAsk')),
            h('a', { class: 'btn soft', href: r.google_review_url, target: '_blank', rel: 'noopener noreferrer' }, t('googleBtn')))
          : '');
    } catch (e) { toast(errText(e.code)); }
  }
  draw();
  return box;
}

// ---------- router / render
function go(view) {
  S.view = view;
  if (view === 'pay' && S.tip === null) {
    const d = S.data.policy.default_tip_percent;
    S.tip = d ? { type: 'percent', value: d } : { type: 'none' };
  }
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (!S.data) return;
  document.documentElement.lang = S.lang;
  document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.style.setProperty('--brand', S.data.restaurant.brand_color);
  const view = { home: viewHome, menu: viewMenu, pay: viewPay, login: viewLogin, otp: viewOtp, profile: viewProfile, account: viewAccount }[S.view]();
  const kids = [view];
  if (api.demo) kids.unshift(h('button', { class: 'demo-flag', onclick: () => { api.reset(); boot(); } },
    S.lang === 'ar' ? 'نسخة تجريبية — لا يتم خصم أموال حقيقية · اضغط لإعادة الضبط' : 'Demo — no real money is charged · tap to reset'));
  if (S.sheet) {
    const menuSheet = M.cachedSheets.has(S.sheet);
    const key = `${S.sheet}:${S.sheetV ?? 0}:${S.lang}`;
    if (!menuSheet || render.sheet?.key !== key) {
      const content = menuSheet ? M.sheets[S.sheet]() : { split: sheetSplit, tip: sheetTip, promo: sheetPromo }[S.sheet]();
      const close = menuSheet ? M.closeSheet : closeSheet;
      render.sheet = { key, el: h('div', { class: 'scrim', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
        h('div', { class: `bottom-sheet${menuSheet ? ' tall' : ''}`, role: 'dialog', 'aria-modal': 'true' },
          h('button', { class: 'icon-btn close', 'aria-label': 'close', onclick: close }, icon(I.x)), content)) };
    }
    kids.push(render.sheet.el);
  } else render.sheet = null;
  if (S.toast) kids.push(toastEl);
  // Keep nodes that did not change in place (preserves scroll positions and running carousels).
  kids.forEach((k, i) => { if (root.childNodes[i] !== k) root.insertBefore(k, root.childNodes[i] ?? null); });
  while (root.childNodes.length > kids.length) root.lastChild.remove();
}

async function load() {
  S.data = await api.getTable(S.token);
  // Drop selections that no longer make sense after a refresh.
  if (S.split.mode === 'items') S.split = { mode: 'full' };
  if (S.data.me?.needs_profile) S.view = 'profile';
  else if (S.data.require_phone && !S.data.me && !['otp', 'login', 'menu'].includes(S.view)) S.view = 'login';
  else if (S.data.me && ['login', 'otp', 'profile'].includes(S.view)) S.view = S.afterLogin ?? 'home';
  M.onLoad();
  render();
}

export async function boot() {
  const path = location.pathname;
  const ret = new URLSearchParams(location.search).get('payment');
  if (path.startsWith('/pay/return') && ret) return viewReturn(ret);
  const m = path.match(/^\/t\/([A-Za-z0-9_-]{22,64})$/) || (api.demo && [null, api.demoToken]);
  if (!m) {
    root.replaceChildren(h('div', { class: 'center' }, h('p', null, 'Scan the QR code on your table.')));
    return;
  }
  S.token = m[1];
  S.view = 'home';
  S.split = { mode: 'full' };
  S.tip = null;
  S.offerId = null;
  S.promo = null;
  S.coupon = null;
  S.busy = false;
  S.sheet = null;
  S.idem = { body: '', key: '' };
  try {
    await load();
  } catch (e) {
    root.replaceChildren(h('div', { class: 'center' }, h('p', null, e.status === 404 ? 'QR code not recognised.' : errText(e.code))));
  }
}

const M = createMenu({ S, h, t, money, icon, I, api, toast, render, go, errText, saveLang, reload: () => load() });

window.addEventListener('orderize:return', (e) => viewReturn(e.detail));
boot();
