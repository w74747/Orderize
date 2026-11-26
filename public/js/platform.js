// Platform console (platform administrators only). Same no-innerHTML rule as everywhere.
import { formatMoney, parseMajor, CURRENCIES } from '../shared/billing.js';

const root = document.getElementById('admin');
let tab = 'restaurants';
let plans = [];

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
async function api(method, url, body) {
  const res = await fetch(url, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error), { code: data.error, status: res.status });
  return data;
}
const fm = (m, c) => formatMoney(Number(m), c, 'en');
const msg = (el, text, ok) => { el.textContent = text; el.className = ok ? 'note ok' : 'note err'; };
const kpi = (l, v) => h('div', { class: 'kpi' }, h('small', null, l), h('strong', null, v));
const field = (label, input) => h('label', null, label, input);

async function render() {
  const o = await api('GET', '/api/platform/overview');
  plans = (await api('GET', '/api/platform/plans')).plans;
  const tabs = [['restaurants', 'Restaurants & subscriptions'], ['offers', 'Bank offers'], ['plans', 'Plans']];
  const views = { restaurants: viewRestaurants, offers: viewOffers, plans: viewPlans };
  root.replaceChildren(h('div', { class: 'shell' },
    h('header', { class: 'bar' }, h('strong', null, 'Orderize · Platform console'),
      h('button', { class: 'btn soft sm', onclick: async () => { await api('POST', '/api/admin/logout', {}); location.assign('/admin'); } }, 'Sign out')),
    h('section', { class: 'kpis' },
      kpi('Restaurants', `${o.active_restaurants} / ${o.restaurants} active`), kpi('Past due', o.past_due), kpi('Invoices due', o.invoices_due),
      kpi('Diners', o.customers), kpi('Payments (30d)', o.payments_30d),
      ...o.gmv_30d.map((g) => kpi(`GMV 30d · ${g.currency}`, `${fm(g.gmv_minor, g.currency)} (fees ${fm(g.fees_minor, g.currency)})`))),
    h('nav', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; render(); } }, l))),
    await views[tab]()));
}

// ---------- restaurants & subscriptions
async function viewRestaurants() {
  const { restaurants } = await api('GET', '/api/platform/restaurants');
  const f = {
    name_en: h('input', { placeholder: 'Name (English)' }), name_ar: h('input', { placeholder: 'الاسم بالعربي', dir: 'rtl' }),
    slug: h('input', { placeholder: 'slug (e.g. luban-house)' }),
    country: h('select', null, ['AE', 'SA', 'QA', 'KW', 'BH', 'OM'].map((c) => h('option', { value: c }, c))),
    currency: h('select', null, Object.keys(CURRENCIES).map((c) => h('option', { value: c }, c))),
    owner_email: h('input', { type: 'email', placeholder: 'Owner email' }),
    plan_id: h('select', null, h('option', { value: '' }, 'No plan yet'), plans.filter((p) => p.active).map((p) => h('option', { value: p.id }, `${p.name} · ${fm(p.price_minor, p.currency)}/${p.interval}`))),
    trial_days: h('input', { inputmode: 'numeric', placeholder: 'Trial days (default 14)' }),
  };
  const out = h('pre', { class: 'secret' });
  const statusChip = (s) => h('span', { class: `chip ${s === 'active' ? 'captured' : s === 'trial' ? '' : s === 'past_due' ? 'warn' : 'bad'}` }, s ?? '—');
  return h('div', { class: 'grid' },
    h('div', { class: 'card wide' }, h('h3', null, 'Restaurants'),
      h('table', null,
        h('thead', null, h('tr', null, ['Restaurant', 'Country', 'Owner', 'Plan', 'Status', 'Paid until', 'GMV 30d', 'POS', ''].map((c) => h('th', null, c)))),
        h('tbody', null, restaurants.map((r) => h('tr', null,
          h('td', null, h('strong', null, r.name_en), h('small', { class: 'muted' }, ` ${r.slug}`)), h('td', null, r.country),
          h('td', null, r.owner_email ?? '—'), h('td', null, r.plan_name ?? '—'), h('td', null, statusChip(r.sub_status), r.active ? '' : ' (QR off)'),
          h('td', null, r.current_period_end ?? '—'), h('td', null, fm(r.gmv_30d, r.currency)), h('td', null, r.pos ?? '—'),
          h('td', null, h('button', { class: 'btn soft sm', onclick: () => manage(r) }, 'Manage'))))))),
    h('div', { class: 'card form' }, h('h3', null, 'Add restaurant'), Object.values(f),
      h('button', { class: 'btn primary sm', onclick: async () => {
        try {
          const r = await api('POST', '/api/platform/restaurants', {
            name_en: f.name_en.value, name_ar: f.name_ar.value, slug: f.slug.value.trim().toLowerCase(), country: f.country.value,
            currency: f.currency.value, owner_email: f.owner_email.value.trim(),
            ...(f.plan_id.value ? { plan_id: f.plan_id.value } : {}), ...(f.trial_days.value ? { trial_days: Number(f.trial_days.value) } : {}),
          });
          out.textContent = `Created.\nOwner: ${r.owner_email}\nTemporary password: ${r.temporary_password}\n\nShown once — send it securely. The owner sets up 2FA at first sign-in.`;
        } catch (e) { out.textContent = e.code || 'Error'; }
      } }, 'Create restaurant'), out));
}

async function manage(r) {
  const { invoices } = await api('GET', `/api/platform/restaurants/${r.id}/invoices`);
  const status = h('select', null, ['trial', 'active', 'past_due', 'suspended', 'cancelled'].map((s) => h('option', { value: s, selected: s === r.sub_status }, s)));
  const plan = h('select', null, h('option', { value: '' }, 'No plan'), plans.map((p) => h('option', { value: p.id, selected: p.id === r.plan_id }, `${p.name} · ${fm(p.price_minor, p.currency)}/${p.interval}`)));
  const until = h('input', { type: 'date', value: r.current_period_end ?? '' });
  const notes = h('input', { placeholder: 'Notes', value: r.notes ?? '' });
  const amt = h('input', { placeholder: `Amount (${r.currency})`, inputmode: 'decimal' });
  const from = h('input', { type: 'date' }), to = h('input', { type: 'date' });
  const out = h('p', { class: 'note' });
  const dlg = h('div', { class: 'scrim' }, h('div', { class: 'card modal' },
    h('h2', null, `${r.name_en} · subscription`),
    h('p', { class: 'muted' }, 'Suspended or cancelled restaurants have their QR codes switched off and staff signed out.'),
    field('Plan', plan), field('Status', status), field('Paid until', until), field('Notes', notes),
    h('button', { class: 'btn primary sm', onclick: async () => {
      try {
        await api('PUT', `/api/platform/restaurants/${r.id}/subscription`, { plan_id: plan.value || null, status: status.value, current_period_end: until.value || null, notes: notes.value || null });
        dlg.remove(); render();
      } catch (e) { msg(out, e.code); }
    } }, 'Save subscription'),
    h('h3', null, 'Invoices'),
    invoices.length ? h('table', null, h('tbody', null, invoices.map((i) => h('tr', null,
      h('td', null, `${i.period_start} → ${i.period_end}`), h('td', null, fm(i.amount_minor, i.currency)),
      h('td', null, h('span', { class: `chip ${i.status === 'paid' ? 'captured' : 'warn'}` }, i.status)),
      h('td', null, i.status === 'due' ? h('button', { class: 'btn soft sm', onclick: async () => {
        const ref = prompt('Payment reference (bank transfer / receipt no.)') ?? undefined;
        await api('POST', `/api/platform/invoices/${i.id}/paid`, { reference: ref || undefined }); dlg.remove(); manage({ ...r });
      } }, 'Mark paid') : i.reference ?? '')))))
      : h('p', { class: 'muted' }, 'No invoices.'),
    h('div', { class: 'line' }, amt, from, to,
      h('button', { class: 'btn soft sm', onclick: async () => {
        try {
          await api('POST', `/api/platform/restaurants/${r.id}/invoices`, { amount_minor: parseMajor(amt.value, r.currency), period_start: from.value, period_end: to.value });
          dlg.remove(); manage(r);
        } catch (e) { msg(out, e.code || 'Check amount and dates'); }
      } }, 'Add invoice')),
    h('button', { class: 'btn ghost sm', onclick: () => dlg.remove() }, 'Close'), out));
  document.body.append(dlg);
}

// ---------- bank offers
async function viewOffers() {
  const { offers } = await api('GET', '/api/platform/bank-offers');
  const { restaurants } = await api('GET', '/api/platform/restaurants');
  const f = {
    bank_name: h('input', { placeholder: 'Bank name' }),
    title_en: h('input', { placeholder: 'Title (EN), e.g. 10% off · up to 20' }), title_ar: h('input', { placeholder: 'العنوان', dir: 'rtl' }),
    kind: h('select', null, h('option', { value: 'percent' }, '% off'), h('option', { value: 'fixed' }, 'Fixed amount')),
    value: h('input', { placeholder: 'Value (15 = 15% or 15.00)', inputmode: 'decimal' }),
    currency: h('select', null, Object.keys(CURRENCIES).map((c) => h('option', { value: c }, c))),
    max: h('input', { placeholder: 'Max discount (optional)', inputmode: 'decimal' }),
    min: h('input', { placeholder: 'Minimum spend (optional)', inputmode: 'decimal' }),
    bins: h('input', { placeholder: 'Card BINs, comma separated (6–8 digits)', inputmode: 'numeric' }),
    theme: h('select', null, ['dark', 'blue', 'green', 'purple'].map((t) => h('option', { value: t }, t))),
    restaurant: h('select', null, h('option', { value: '' }, 'All restaurants (same currency)'), restaurants.map((r) => h('option', { value: r.id }, r.name_en))),
    ends: h('input', { type: 'date' }),
    maxUses: h('input', { placeholder: 'Max redemptions (optional)', inputmode: 'numeric' }),
  };
  const out = h('p', { class: 'note' });
  return h('div', { class: 'grid' },
    h('div', { class: 'card wide' }, h('h3', null, 'Bank offers'),
      h('table', null,
        h('thead', null, h('tr', null, ['Bank', 'Offer', 'Currency', 'BINs', 'Scope', 'Used', 'Status', ''].map((c) => h('th', null, c)))),
        h('tbody', null, offers.map((o) => h('tr', null,
          h('td', null, o.bank_name), h('td', null, o.title_en), h('td', null, o.currency), h('td', null, (o.bin_prefixes ?? []).join(', ')),
          h('td', null, o.restaurant_name ?? 'All'), h('td', null, `${o.redemptions}${o.max_redemptions ? `/${o.max_redemptions}` : ''}`),
          h('td', null, h('span', { class: `chip ${o.active ? 'captured' : ''}` }, o.active ? 'active' : 'off')),
          h('td', null, h('button', { class: 'btn ghost sm', onclick: async () => { await api('POST', `/api/platform/bank-offers/${o.id}/toggle`, {}); render(); } }, o.active ? 'Pause' : 'Activate'))))))),
    h('div', { class: 'card form' }, h('h3', null, 'New bank offer'),
      h('p', { class: 'muted' }, 'Only cards whose number starts with these BINs can use the offer; it is enforced on the payment page and re-checked after payment.'),
      Object.values(f),
      h('button', { class: 'btn primary sm', onclick: async () => {
        try {
          const c = f.currency.value, kind = f.kind.value;
          await api('POST', '/api/platform/bank-offers', {
            bank_name: f.bank_name.value, title_en: f.title_en.value, title_ar: f.title_ar.value, kind, currency: c, theme: f.theme.value,
            value: kind === 'percent' ? Number(f.value.value) : parseMajor(f.value.value, c),
            bin_prefixes: f.bins.value.split(/[\s,]+/).filter(Boolean),
            ...(f.max.value ? { max_minor: parseMajor(f.max.value, c) } : {}), ...(f.min.value ? { min_spend_minor: parseMajor(f.min.value, c) } : {}),
            ...(f.restaurant.value ? { restaurant_id: f.restaurant.value } : {}),
            ...(f.ends.value ? { ends_at: new Date(`${f.ends.value}T23:59:59Z`).toISOString() } : {}),
            ...(f.maxUses.value ? { max_redemptions: Number(f.maxUses.value) } : {}),
          });
          render();
        } catch (e) { msg(out, e.code || 'Check the values'); }
      } }, 'Create offer'), out));
}

// ---------- plans
async function viewPlans() {
  const f = {
    name: h('input', { placeholder: 'Plan name' }),
    price: h('input', { placeholder: 'Price', inputmode: 'decimal' }),
    currency: h('select', null, Object.keys(CURRENCIES).map((c) => h('option', { value: c }, c))),
    interval: h('select', null, h('option', { value: 'month' }, 'Monthly'), h('option', { value: 'year' }, 'Yearly')),
    features: h('input', { placeholder: 'Features, comma separated' }),
  };
  const out = h('p', { class: 'note' });
  return h('div', { class: 'grid' },
    h('div', { class: 'card wide' }, h('h3', null, 'Plans'),
      plans.length ? h('table', null, h('tbody', null, plans.map((p) => h('tr', null,
        h('td', null, h('strong', null, p.name)), h('td', null, `${fm(p.price_minor, p.currency)} / ${p.interval}`), h('td', null, (p.features ?? []).join(' · '))))))
        : h('p', { class: 'muted' }, 'No plans yet.')),
    h('div', { class: 'card form' }, h('h3', null, 'New plan'), Object.values(f),
      h('button', { class: 'btn primary sm', onclick: async () => {
        try {
          await api('POST', '/api/platform/plans', {
            name: f.name.value, price_minor: parseMajor(f.price.value, f.currency.value), currency: f.currency.value, interval: f.interval.value,
            features: f.features.value.split(',').map((x) => x.trim()).filter(Boolean),
          });
          render();
        } catch (e) { msg(out, e.code || 'Check the values'); }
      } }, 'Create plan'), out));
}

(async () => {
  try {
    const r = await api('GET', '/api/admin/me');
    if (r.user.role !== 'platform_admin' || r.mfa_required) return location.assign('/admin');
    await render();
  } catch (e) {
    if (e.code === 'MFA_SETUP_REQUIRED' || e.status === 401 || e.status === 403) return location.assign('/admin');
    root.replaceChildren(h('p', { class: 'center' }, `Error: ${e.code ?? 'unknown'}`));
  }
})();
