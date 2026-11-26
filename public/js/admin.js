// Restaurant dashboard. Same no-innerHTML rule as the diner app.
import { formatMoney, parseMajor } from '../shared/billing.js';

const root = document.getElementById('admin');
let me = null;
let summary = null;
let tab = 'tables';

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
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'ERROR'), { code: data.error, status: res.status });
  return data;
}

const cur = () => summary?.restaurant?.currency ?? 'AED';
const fm = (m) => formatMoney(Number(m), cur(), 'en');
const msg = (el, text, ok = false) => { el.textContent = text; el.className = ok ? 'note ok' : 'note err'; };

// ---------- login
function viewLogin(needTotp = false, prev = {}) {
  const out = h('p', { class: 'note' });
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, value: prev.email ?? '' });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true, value: prev.password ?? '' });
  const totp = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '\\d{6}', maxlength: 6 });
  const form = h('form', { class: 'login card', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/admin/login', { email: email.value, password: password.value, ...(needTotp ? { totp: totp.value } : {}) });
      boot();
    } catch (err) {
      if (err.code === 'TOTP_REQUIRED') return viewLogin(true, { email: email.value, password: password.value });
      msg(out, err.code === 'RATE_LIMITED' ? 'Too many attempts. Wait a minute.' : 'Invalid credentials.');
    }
  } },
  h('h1', null, 'Sufra · Restaurant'),
  h('label', null, 'Email', email),
  h('label', null, 'Password', password),
  needTotp ? h('label', null, 'Authenticator code', totp) : null,
  h('button', { class: 'btn primary' }, 'Sign in'), out);
  root.replaceChildren(h('div', { class: 'center' }, form));
  (needTotp ? totp : email).focus();
}

// ---------- 2FA
async function view2fa(forced) {
  const s = await api('POST', '/api/admin/2fa/setup', {});
  const code = h('input', { inputmode: 'numeric', maxlength: 6 });
  const out = h('p', { class: 'note' });
  const qr = h('div', { class: 'qr' });
  // SVG comes from our own server-side QR generator, parsed as an image (no script execution).
  qr.append(h('img', { alt: 'QR', src: `data:image/svg+xml;base64,${btoa(s.qr_svg)}` }));
  root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card login' },
    h('h1', null, 'Two-factor authentication'),
    forced ? h('p', null, 'Your organisation requires 2FA before you continue.') : null,
    h('p', null, 'Scan with Google Authenticator, Microsoft Authenticator or 1Password, then enter the 6-digit code.'),
    qr, h('code', { class: 'secret' }, s.secret),
    h('label', null, 'Code', code),
    h('button', { class: 'btn primary', onclick: async () => {
      try { await api('POST', '/api/admin/2fa/enable', { code: code.value }); boot(); } catch { msg(out, 'Wrong code, try again.'); }
    } }, 'Enable 2FA'), out)));
}

// ---------- shell
function shell(content) {
  const tabs = [['tables', 'Tables & bills'], ['payments', 'Payments'], ['offers', 'Offers'], ['settings', 'Security & POS']];
  return h('div', { class: 'shell' },
    h('header', { class: 'bar' },
      h('strong', null, summary.restaurant.name_en),
      h('span', { class: 'muted' }, `${me.email} · ${me.role}`),
      h('button', { class: 'btn soft sm', onclick: async () => { await api('POST', '/api/admin/logout', {}); boot(); } }, 'Sign out')),
    h('section', { class: 'kpis' },
      kpi('Sales today', fm(summary.today.sales)), kpi('Tips today', fm(summary.today.tips)),
      kpi('Payments', summary.today.payments), kpi('Open bills', summary.open_bills)),
    h('nav', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; render(); } }, l))),
    content);
}
const kpi = (l, v) => h('div', { class: 'kpi' }, h('small', null, l), h('strong', null, v));

async function render() {
  summary = await api('GET', '/api/admin/summary');
  const views = { tables: viewTables, payments: viewPayments, offers: viewOffers, settings: viewSettings };
  root.replaceChildren(shell(await views[tab]()));
}

// ---------- tables
async function viewTables() {
  const { tables } = await api('GET', '/api/admin/tables');
  const label = h('input', { placeholder: 'e.g. Terrace 4', maxlength: 40 });
  const out = h('p', { class: 'note' });
  return h('div', { class: 'grid' },
    tables.map((t) => h('article', { class: 'card table' },
      h('div', { class: 'row' }, h('h3', null, t.label),
        t.bill_id ? h('span', { class: 'chip warn' }, `Open · ${fm(t.total_minor - t.paid_minor)} left`) : h('span', { class: 'chip' }, 'Free')),
      h('img', { class: 'qr', alt: `QR for ${t.label}`, src: `/api/admin/tables/${t.id}/qr.svg`, loading: 'lazy' }),
      h('div', { class: 'row gap' },
        h('a', { class: 'btn soft sm', href: `/api/admin/tables/${t.id}/qr.svg`, download: `qr-${t.label}.svg` }, 'Download QR'),
        t.bill_id ? h('button', { class: 'btn soft sm', onclick: () => voidBill(t) }, 'Void bill') : h('button', { class: 'btn primary sm', onclick: () => billForm(t) }, 'New bill'),
        h('button', { class: 'btn ghost sm', title: 'Invalidates the printed QR', onclick: () => rotate(t) }, 'Rotate QR')),
    )),
    me.role !== 'staff' ? h('article', { class: 'card' }, h('h3', null, 'Add table'), label,
      h('button', { class: 'btn primary sm', onclick: async () => {
        try { await api('POST', '/api/admin/tables', { label: label.value }); render(); } catch (e) { msg(out, e.code); }
      } }, 'Add'), out) : null);
}

async function rotate(t) {
  if (!confirm(`Rotate the QR for ${t.label}? The printed sticker will stop working.`)) return;
  await api('POST', `/api/admin/tables/${t.id}/rotate`, {});
  render();
}
async function voidBill(t) {
  if (!confirm(`Void the open bill on ${t.label}?`)) return;
  try { await api('POST', `/api/admin/bills/${t.bill_id}/void`, {}); } catch (e) { alert(e.code); }
  render();
}

function billForm(t) {
  const rows = h('div', { class: 'lines' });
  const out = h('p', { class: 'note' });
  const addLine = () => rows.append(h('div', { class: 'line' },
    h('input', { placeholder: 'Item (English)', class: 'en' }), h('input', { placeholder: 'الصنف (عربي)', class: 'ar', dir: 'rtl' }),
    h('input', { placeholder: 'Price', inputmode: 'decimal', class: 'price' }), h('input', { value: '1', inputmode: 'numeric', class: 'qty' })));
  addLine();
  const dlg = h('div', { class: 'scrim' }, h('div', { class: 'card modal' },
    h('h2', null, `New bill · ${t.label}`),
    h('p', { class: 'muted' }, 'Prices include VAT. Usually bills arrive automatically from your POS.'),
    rows,
    h('div', { class: 'row gap' },
      h('button', { class: 'btn soft sm', onclick: addLine }, '+ Line'),
      h('button', { class: 'btn ghost sm', onclick: () => dlg.remove() }, 'Cancel'),
      h('button', { class: 'btn primary sm', onclick: async () => {
        try {
          const items = [...rows.children].map((l) => ({
            name_en: l.querySelector('.en').value, name_ar: l.querySelector('.ar').value || l.querySelector('.en').value,
            unit_price_minor: parseMajor(l.querySelector('.price').value, cur()), qty: Number(l.querySelector('.qty').value),
          }));
          await api('POST', '/api/admin/bills', { table_id: t.id, items });
          dlg.remove();
          render();
        } catch (e) { msg(out, e.code || 'Check the lines (price like 12.50)'); }
      } }, 'Open bill')), out));
  document.body.append(dlg);
}

// ---------- payments
async function viewPayments() {
  const { payments } = await api('GET', '/api/admin/payments');
  return h('div', { class: 'card' }, h('table', null,
    h('thead', null, h('tr', null, ['Time', 'Table', 'Status', 'Share', 'Tip', 'Discount', 'Total', 'Card', 'Flags'].map((c) => h('th', null, c)))),
    h('tbody', null, payments.map((p) => h('tr', null,
      h('td', null, new Date(p.created_at).toLocaleString()), h('td', null, p.table_label),
      h('td', null, h('span', { class: `chip ${p.status}` }, p.status)),
      h('td', null, fm(p.share_minor)), h('td', null, fm(p.tip_minor)), h('td', null, fm(p.discount_minor)), h('td', null, fm(p.total_minor)),
      h('td', null, p.card_last4 ? `${p.card_brand ?? ''} ••${p.card_last4}` : '—'),
      h('td', null, p.flag ? h('span', { class: 'chip bad' }, p.flag) : ''))))));
}

// ---------- offers
async function viewOffers() {
  if (me.role === 'staff') return h('p', { class: 'card' }, 'Managers only.');
  const { offers } = await api('GET', '/api/admin/offers');
  const f = {
    code: h('input', { placeholder: 'CODE', maxlength: 32 }), kind: h('select', null, h('option', { value: 'percent' }, '% off'), h('option', { value: 'fixed' }, 'Fixed amount')),
    value: h('input', { placeholder: 'Value (10 = 10% or 10.00)', inputmode: 'decimal' }), cap: h('input', { placeholder: 'Max discount (optional)', inputmode: 'decimal' }),
    en: h('input', { placeholder: 'Title (EN)' }), ar: h('input', { placeholder: 'العنوان', dir: 'rtl' }), max: h('input', { placeholder: 'Max uses (optional)', inputmode: 'numeric' }),
  };
  const out = h('p', { class: 'note' });
  return h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h3', null, 'Offers'), h('table', null,
      h('thead', null, h('tr', null, ['Title', 'Type', 'Bank / code', 'Used', 'Status'].map((c) => h('th', null, c)))),
      h('tbody', null, offers.map((o) => h('tr', null, h('td', null, o.title_en), h('td', null, o.kind === 'percent' ? `${o.value}%` : fm(o.value)),
        h('td', null, o.bank_name ?? o.promo_code), h('td', null, `${o.redemptions}${o.max_redemptions ? `/${o.max_redemptions}` : ''}`),
        h('td', null, o.platform ? 'Platform bank offer' : o.active ? 'Active' : 'Off')))))),
    h('div', { class: 'card form' }, h('h3', null, 'New promo code'), Object.values(f),
      h('button', { class: 'btn primary sm', onclick: async () => {
        try {
          const kind = f.kind.value;
          await api('POST', '/api/admin/offers', {
            promo_code: f.code.value, kind, title_en: f.en.value, title_ar: f.ar.value || f.en.value,
            value: kind === 'percent' ? Number(f.value.value) : parseMajor(f.value.value, cur()),
            ...(f.cap.value ? { max_minor: parseMajor(f.cap.value, cur()) } : {}),
            ...(f.max.value ? { max_redemptions: Number(f.max.value) } : {}),
          });
          render();
        } catch (e) { msg(out, e.code || 'Check the values'); }
      } }, 'Create'), out));
}

// ---------- security & POS
async function viewSettings() {
  const out = h('pre', { class: 'secret' });
  const cards = [
    h('div', { class: 'card' }, h('h3', null, 'Two-factor authentication'),
      h('p', null, me.totp_enabled ? 'Enabled on your account.' : 'Not enabled. Strongly recommended for every account.'),
      me.totp_enabled ? null : h('button', { class: 'btn primary sm', onclick: () => view2fa(false) }, 'Set up 2FA')),
  ];
  if (me.role === 'owner') {
    cards.push(h('div', { class: 'card' }, h('h3', null, 'POS integration'),
      h('p', null, 'Generate credentials for your POS to push bills (HMAC-signed). Generating new ones revokes the old ones immediately.'),
      h('button', { class: 'btn soft sm', onclick: async () => {
        if (!confirm('Generate new POS credentials? The current ones will stop working.')) return;
        const c = await api('POST', '/api/admin/pos-credentials', {});
        out.textContent = `POS key:    ${c.pos_key}\nPOS secret: ${c.pos_secret}\n\n${c.note}`;
      } }, 'Generate POS credentials'), out));
    const { events } = await api('GET', '/api/admin/audit');
    cards.push(h('div', { class: 'card wide' }, h('h3', null, 'Audit log (latest)'), h('table', null,
      h('tbody', null, events.slice(0, 40).map((e) => h('tr', null, h('td', null, new Date(e.at).toLocaleString()),
        h('td', null, e.actor_type), h('td', null, e.action), h('td', null, e.ip ?? '')))))));
  }
  return h('div', { class: 'grid' }, cards);
}

async function boot() {
  try {
    const r = await api('GET', '/api/admin/me');
    me = r.user;
    if (r.mfa_required) return view2fa(true);
    await render();
  } catch (e) {
    if (e.status === 401) return viewLogin();
    if (e.code === 'MFA_SETUP_REQUIRED') return view2fa(true);
    root.replaceChildren(h('p', { class: 'center' }, 'Error loading dashboard.'));
  }
}
boot();
