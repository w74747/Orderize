// Sufra diner app. Plain DOM — never innerHTML with data, so restaurant/menu content
// cannot inject markup or scripts.
import { api } from './api.js';
import { STR, detectLang, saveLang } from './i18n.js';
import { formatMoney, parseMajor, quote, remainingOf, BillingError } from '../shared/billing.js';

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
  check: 'M20 6L9 17l-5-5', x: 'M18 6L6 18M6 6l12 12', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
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
    marketing_consent: S.consent,
  };
}
function currentQuote() {
  const offer = S.offerId ? S.data.offers.find((o) => o.id === S.offerId) : null;
  try {
    const q = quote(billForCalc(), payBody(), S.data.policy, offer);
    if (S.promo?.quote) {
      // Promo discount comes from the server; recompute fee/total around it.
      const d = Math.min(S.promo.quote.discount_minor, q.share_minor - 1);
      const fee = S.promo.quote.share_minor === q.share_minor ? S.promo.quote.fee_minor : q.fee_minor;
      return { ...q, discount_minor: d, fee_minor: fee, total_minor: q.share_minor - d + fee + q.tip_minor };
    }
    return q;
  } catch (e) {
    if (e instanceof BillingError) return { error: e.code };
    throw e;
  }
}

async function refreshPromo() {
  if (!S.promo) return;
  try {
    S.promo.quote = await api.quote(S.token, payBody());
  } catch (e) {
    S.promo = null;
    toast(errText(e.code));
  }
  render();
}

function toast(msg) {
  S.toast = msg;
  render();
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { S.toast = null; render(); }, 3200);
}

// ---------- shared chrome
function topBar({ back } = {}) {
  return h('header', { class: 'top' },
    back ? h('button', { class: 'icon-btn', 'aria-label': t('back'), onclick: back }, icon(I.back)) : h('span'),
    back ? h('div', { class: 'top-title' }, nm(S.data.restaurant)) : h('span'),
    h('button', { class: 'pill', onclick: () => { S.lang = S.lang === 'ar' ? 'en' : 'ar'; saveLang(S.lang); render(); } },
      icon(I.globe, 16), S.lang === 'ar' ? 'EN' : 'ع'),
  );
}

function offerCard(o, { compact } = {}) {
  const on = S.offerId === o.id;
  return h('button', {
    class: `offer theme-${o.theme} ${on ? 'on' : ''} ${compact ? 'compact' : ''}`,
    onclick: () => {
      S.offerId = on ? null : o.id;
      S.promo = null;
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
      safeImg(r.cover_url, 'cover-img'),
      topBar(),
      h('div', { class: 'hero' },
        h('div', { class: 'logo', style: { background: r.brand_color } }, safeImg(r.logo_url) || initials),
        h('p', { class: 'eyebrow' }, t('welcome')),
        h('h1', null, nm(r)),
      ),
    ),
    h('section', { class: 'sheet' },
      S.data.offers.length ? h('div', { class: 'carousel' }, S.data.offers.map((o) => offerCard(o, { compact: true }))) : null,
      b && remainingOf({ ...b }) > 0
        ? h('button', { class: 'btn primary big', onclick: () => go('pay') }, icon(I.receipt), `${t('payNow')} · ${money(b.remaining_minor)}`)
        : statusBox(),
      r.menu?.length ? h('button', { class: 'btn soft big', onclick: () => go('menu') }, icon(I.menu), t('viewMenu')) : null,
      h('p', { class: 'powered' }, 'Sufra', h('small', null, t('terms'))),
    ),
  );
}

function statusBox() {
  const b = S.data.bill;
  if (b) return h('div', { class: 'status ok' }, h('strong', null, t('paid')), h('p', null, t('paidSub')));
  return h('div', { class: 'status' }, h('strong', null, t('noBill')), h('p', null, t('noBillSub')));
}

function safeImg(url, cls) {
  if (!url || !/^https:\/\//.test(url)) return null;
  return h('img', { src: url, alt: '', class: cls, referrerpolicy: 'no-referrer', loading: 'lazy' });
}

function viewMenu() {
  return h('div', { class: 'page' },
    topBar({ back: () => go('home') }),
    h('div', { class: 'menu' },
      S.data.restaurant.menu.map((cat) => h('section', { class: 'card' },
        h('h2', null, nm(cat)),
        cat.items.map((it) => h('div', { class: 'row' }, h('span', null, nm(it)), h('span', { class: 'num' }, money(it.price_minor)))),
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
      S.promo = { code: d.code.toUpperCase() };
      closeSheet();
      await refreshPromo();
    } }, t('apply'))];
}

function afterChange() {
  render();
  if (S.promo) refreshPromo();
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
    ) : null,
    p?.public_token ? h('button', { class: 'btn primary big', onclick: () => { if (!api.demo) history.replaceState(null, '', `/t/${p.public_token}`); boot(); } },
      ok ? t('backToBill') : t('tryAgain')) : null,
  ));
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
  const view = { home: viewHome, menu: viewMenu, pay: viewPay }[S.view]();
  const kids = [view];
  if (api.demo) kids.unshift(h('button', { class: 'demo-flag', onclick: () => { api.reset(); boot(); } },
    S.lang === 'ar' ? 'نسخة تجريبية — لا يتم خصم أموال حقيقية · اضغط لإعادة الضبط' : 'Demo — no real money is charged · tap to reset'));
  if (S.sheet) {
    const content = { split: sheetSplit, tip: sheetTip, promo: sheetPromo }[S.sheet]();
    kids.push(h('div', { class: 'scrim', onclick: (e) => { if (e.target === e.currentTarget) closeSheet(); } },
      h('div', { class: 'bottom-sheet', role: 'dialog', 'aria-modal': 'true' },
        h('button', { class: 'icon-btn close', 'aria-label': 'close', onclick: closeSheet }, icon(I.x)), content)));
  }
  if (S.toast) kids.push(h('div', { class: 'toast', role: 'status' }, S.toast));
  root.replaceChildren(...kids);
}

async function load() {
  S.data = await api.getTable(S.token);
  // Drop selections that no longer make sense after a refresh.
  if (S.split.mode === 'items') S.split = { mode: 'full' };
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
  S.busy = false;
  S.sheet = null;
  S.idem = { body: '', key: '' };
  try {
    await load();
  } catch (e) {
    root.replaceChildren(h('div', { class: 'center' }, h('p', null, e.status === 404 ? 'QR code not recognised.' : errText(e.code))));
  }
}

window.addEventListener('sufra:return', (e) => viewReturn(e.detail));
boot();
