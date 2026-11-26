// Restaurant dashboard. Same no-innerHTML rule as the diner app.
import { formatMoney, parseMajor, CURRENCIES } from '../shared/billing.js';
const decimalsOf = (c) => CURRENCIES[c].decimals;

const root = document.getElementById('admin');
let me = null;
let summary = null;
let tab = 'tables';
let flash = '';

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM, allowed by our CSP (inline style attributes are not)
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
  h('h1', null, 'Orderize · Restaurant'),
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
  const tabs = [['tables', 'Tables & bills'], ['menu', 'Menu'], ['payments', 'Payments'], ['customers', 'Customers'], ['campaigns', 'Coupons & campaigns'], ['ratings', 'Ratings'], ['pos', 'POS integration'], ['offers', 'Promo codes'], ['settings', 'Settings & security']];
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
  const views = { tables: viewTables, menu: viewMenuAdmin, payments: viewPayments, customers: viewCustomers, campaigns: viewCampaigns, ratings: viewRatings, pos: viewPos, offers: viewOffers, settings: viewSettings };
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
      t.external_id || t.external_name ? h('small', { class: 'muted' }, `POS table: ${t.external_name ?? t.external_id}`) : null,
      t.bill_id && t.source !== 'manual' ? h('small', { class: 'muted' }, `Bill source: ${t.source}`) : null,
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
  const picker = h('div', { class: 'picker' }, h('small', { class: 'muted' }, 'Loading menu…'));
  api('GET', '/api/admin/menu').then(({ categories }) => {
    const all = categories.flatMap((c) => c.items.filter((i) => i.available).map((i) => ({ ...i, cat: c.name_en })));
    if (!all.length) return picker.replaceChildren(h('small', { class: 'muted' }, 'Tip: add your items in the Menu tab to pick them here with one tap.'));
    picker.replaceChildren(...categories.filter((c) => c.items.some((i) => i.available)).map((c) => h('div', null,
      h('small', { class: 'muted' }, c.name_en),
      h('div', { class: 'chips' }, c.items.filter((i) => i.available).map((i) => h('button', { class: 'chip-btn', onclick: () => addFromMenu(i) },
        `${i.name_en} · ${fm(i.price_minor)}`))))));
  }).catch(() => picker.replaceChildren());
  function addFromMenu(i) {
    // Same item again → increase its quantity instead of adding a new line.
    for (const l of rows.children) {
      if (l.dataset.menuId === i.id) { const q = l.querySelector('.qty'); q.value = String(Number(q.value || 0) + 1); return; }
    }
    const first = rows.children[0];
    if (rows.children.length === 1 && !first.querySelector('.en').value) first.remove();
    addLine();
    const l = rows.lastElementChild;
    l.dataset.menuId = i.id;
    l.querySelector('.en').value = i.name_en;
    l.querySelector('.ar').value = i.name_ar;
    l.querySelector('.price').value = (Number(i.price_minor) / 10 ** decimalsOf(cur())).toFixed(decimalsOf(cur()));
  }
  const dlg = h('div', { class: 'scrim' }, h('div', { class: 'card modal' },
    h('h2', null, `New bill · ${t.label}`),
    h('p', { class: 'muted' }, 'Tap items from your menu, or type lines manually. Prices include VAT.'),
    picker,
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
  if (me.role === 'owner') cards.unshift(await restaurantSettingsCard());
  if (me.role === 'owner') {
    cards.push(h('div', { class: 'card' }, h('h3', null, 'POS API (custom integration)'),
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
  const m = location.hash.match(/^#integrations=(.+)$/);
  if (m) {
    tab = 'pos';
    flash = m[1] === 'connected' ? 'Connected. Now choose your branch below.' : `Connection failed: ${decodeURIComponent(m[1])}`;
    history.replaceState(null, '', '/admin');
  }
  try {
    const r = await api('GET', '/api/admin/me');
    me = r.user;
    if (me.role === 'platform_admin' && !r.mfa_required) return location.assign('/platform');
    if (r.mfa_required) return view2fa(true);
    await render();
  } catch (e) {
    if (e.status === 401) return viewLogin();
    if (e.code === 'MFA_SETUP_REQUIRED') return view2fa(true);
    root.replaceChildren(h('p', { class: 'center' }, 'Error loading dashboard.'));
  }
}
boot();

// ---------- POS integration
async function viewPos() {
  const out = h('p', { class: flash.startsWith('Connection failed') ? 'note err' : 'note ok' }, flash);
  flash = '';
  const parts = [];
  const err = (e) => { out.className = 'note err'; out.textContent = e.code || 'Error'; };

  if (me.role !== 'staff') {
    const info = await api('GET', '/api/admin/integration');
    const c = info.connection;
    const prov = (n) => info.providers.find((p) => p.name === n);
    parts.push(h('div', { class: 'card wide' },
      h('h3', null, 'Connection'),
      c ? h('div', { class: 'row gap' },
        h('strong', null, prov(c.provider)?.label ?? c.provider),
        h('span', { class: `chip ${c.status === 'active' ? 'captured' : c.status === 'error' ? 'bad' : 'warn'}` }, c.status),
        c.last_sync_at ? h('small', { class: 'muted' }, `last sync ${new Date(c.last_sync_at).toLocaleString()}`) : null,
        me.role === 'owner' ? h('button', { class: 'btn ghost sm', onclick: async () => {
          if (!confirm('Disconnect the POS? Stored tokens will be deleted.')) return;
          await api('POST', '/api/admin/integration/disconnect', {}); render();
        } }, 'Disconnect') : null)
        : h('p', null, 'No POS connected. Bills are entered in this dashboard or sent through the signed POS API.'),
      c?.last_error ? h('p', { class: 'note err' }, `Last error: ${c.last_error}`) : null,
      out));

    if (c?.provider === 'foodics') {
      const sel = h('select', null, h('option', { value: '' }, 'Loading branches…'));
      api('GET', '/api/admin/integration/branches').then(({ branches }) => {
        sel.replaceChildren(h('option', { value: '' }, 'Choose branch'), ...branches.map((b) => h('option', { value: b.id, selected: b.id === c.config.branch_id }, `${b.name} · ${b.name_ar}`)));
      }).catch(err);
      parts.push(h('div', { class: 'card' }, h('h3', null, 'Foodics branch & tables'),
        h('p', null, 'Bills are read live from the open order on each table. Payments are queued below for the cashier to record in Foodics.'),
        sel,
        h('div', { class: 'row gap' },
          h('button', { class: 'btn primary sm', disabled: me.role !== 'owner', onclick: async () => {
            try { await api('POST', '/api/admin/integration/branch', { branch_id: sel.value }); flash = 'Branch saved.'; render(); } catch (e) { err(e); }
          } }, 'Save branch'),
          h('button', { class: 'btn soft sm', onclick: async () => {
            try { const r = await api('POST', '/api/admin/integration/sync-tables', {}); out.className = 'note ok'; out.textContent = `Tables: ${r.matched} matched, ${r.created} created (${r.total} in Foodics).`; } catch (e) { err(e); }
          } }, 'Import tables from Foodics'))));
    }

    if (c?.provider === 'simphony') parts.push(await simphonyMapping());

    if (me.role === 'owner') {
      const f = prov('foodics');
      parts.push(h('div', { class: 'card' }, h('h3', null, 'Foodics'),
        h('p', null, 'Live bills from Foodics via OAuth. You approve access inside Foodics; no password is shared.'),
        f.available ? h('button', { class: 'btn primary sm', onclick: async () => {
          try { const { url } = await api('POST', '/api/admin/integration/oauth/start', { provider: 'foodics' }); location.assign(url); } catch (e) { err(e); }
        } }, c?.provider === 'foodics' ? 'Reconnect Foodics' : 'Connect Foodics')
          : h('p', { class: 'note err' }, 'Not available yet: the platform needs its Foodics app credentials (FOODICS_CLIENT_ID / SECRET).')));

      const sf = {
        host: h('input', { placeholder: 'https://<your-sts-host>', value: c?.provider === 'simphony' ? c.config.host : '' }),
        org: h('input', { placeholder: 'Org short name' }), loc: h('input', { placeholder: 'Location ref' }),
        rvc: h('input', { placeholder: 'Revenue center ref', inputmode: 'numeric' }),
        tender_id: h('input', { placeholder: 'Tender id for Orderize payments', inputmode: 'numeric' }),
        employee_ref: h('input', { placeholder: 'Employee ref (API employee)', inputmode: 'numeric' }),
        client_id: h('input', { placeholder: 'API account client id', autocomplete: 'off' }),
        refresh_token: h('input', { placeholder: 'API account refresh token', type: 'password', autocomplete: 'off' }),
      };
      parts.push(h('div', { class: 'card form' }, h('h3', null, 'Oracle Simphony (STS Gen2)'),
        h('p', null, 'Live checks by table name, and every payment is posted back to the check automatically. Credentials are tested before saving and stored encrypted.'),
        Object.values(sf),
        h('button', { class: 'btn primary sm', onclick: async () => {
          try { await api('POST', '/api/admin/integration/simphony', Object.fromEntries(Object.entries(sf).map(([k, v]) => [k, v.value.trim()]))); flash = 'Simphony connected.'; render(); } catch (e) { err(e); }
        } }, 'Test & connect')));

      parts.push(h('div', { class: 'card' }, h('h3', null, 'Loyverse & other POS'),
        h('p', null, "Loyverse's API exposes only closed receipts, not open tickets, so bills can't be read live. Use this mode: bills come from this dashboard or the signed POS API, and every Orderize payment is listed below for staff to record in the POS."),
        h('button', { class: 'btn soft sm', onclick: async () => { await api('POST', '/api/admin/integration/manual', {}); flash = 'Manual reconciliation enabled.'; render(); } }, 'Use manual reconciliation')));
    }
  }

  parts.push(await writebacksCard());
  return h('div', { class: 'grid' }, parts);
}

async function simphonyMapping() {
  const { tables } = await api('GET', '/api/admin/tables');
  return h('div', { class: 'card wide' }, h('h3', null, 'Simphony table mapping'),
    h('p', { class: 'muted' }, 'Enter the table name/number exactly as it appears in Simphony, then use "Check" to see the live check.'),
    h('table', null, h('tbody', null, tables.map((t) => {
      const inp = h('input', { value: t.external_name ?? '', placeholder: 'e.g. 12' });
      const res = h('small', { class: 'muted' });
      return h('tr', null, h('td', null, t.label), h('td', null, inp),
        h('td', null, h('button', { class: 'btn soft sm', onclick: async () => {
          try { await api('POST', `/api/admin/tables/${t.id}/mapping`, { external_name: inp.value.trim() || null }); res.textContent = 'Saved'; } catch (e) { res.textContent = e.code; }
        } }, 'Save'), ' ',
        h('button', { class: 'btn ghost sm', onclick: async () => {
          try { const r = await api('POST', `/api/admin/tables/${t.id}/pos-sync`, {}); res.textContent = r.error ? `POS error: ${r.error}` : r.synced ? 'Synced — see Tables tab' : 'Not synced'; } catch (e) { res.textContent = e.code; }
        } }, 'Check')),
        h('td', null, res));
    }))));
}

async function writebacksCard() {
  const { writebacks } = await api('GET', '/api/admin/writebacks');
  const pending = writebacks.filter((w) => w.status !== 'done');
  return h('div', { class: 'card wide' },
    h('h3', null, `Payments to record in the POS (${pending.length})`),
    writebacks.length ? h('table', null,
      h('thead', null, h('tr', null, ['Table', 'Amount', 'Tip', 'Card', 'Mode', 'Status', ''].map((c) => h('th', null, c)))),
      h('tbody', null, writebacks.map((w) => h('tr', null,
        h('td', null, w.table_label), h('td', null, formatMoney(Number(w.share_minor), w.currency, 'en')),
        h('td', null, formatMoney(Number(w.tip_minor), w.currency, 'en')),
        h('td', null, w.card_last4 ? `${w.card_brand ?? ''} ••${w.card_last4}` : '—'),
        h('td', null, w.mode === 'auto' ? 'automatic' : 'staff'),
        h('td', null, h('span', { class: `chip ${w.status === 'done' ? 'captured' : w.status === 'failed' ? 'bad' : 'warn'}` }, w.status), w.last_error ? h('small', { class: 'muted' }, ` ${w.last_error}`) : null),
        h('td', null,
          w.status !== 'done' && w.mode === 'manual' ? h('button', { class: 'btn primary sm', onclick: async () => { await api('POST', `/api/admin/writebacks/${w.payment_id}/done`, {}); render(); } }, 'Recorded in POS') : null,
          w.status === 'failed' && w.mode === 'auto' && me.role !== 'staff' ? h('button', { class: 'btn soft sm', onclick: async () => { await api('POST', `/api/admin/writebacks/${w.payment_id}/retry`, {}); render(); } }, 'Retry') : null)))))
      : h('p', { class: 'muted' }, 'Nothing to record.'));
}

// ---------- customers (CRM)
async function viewCustomers() {
  if (me.role === 'staff') return h('p', { class: 'card' }, 'Managers only.');
  const s = await api('GET', '/api/admin/customers');
  const k = s.kpi;
  const pct = k.customers ? Math.round((k.returning / k.customers) * 100) : 0;
  const maxB = Math.max(1, ...s.buckets.map((b) => b.customers));
  return h('div', { class: 'grid' },
    h('section', { class: 'kpis wide' },
      kpi('Customers', k.customers), kpi('New (30 days)', k.new_30d), kpi('Returning', `${pct}%`),
      kpi('Avg visits / customer', k.avg_visits), kpi('Avg ticket', fm(k.avg_ticket_minor)),
      kpi('Rating (30 days)', `${k.rating.avg_30d} ★ · ${k.rating.count_30d}`)),
    h('div', { class: 'card' }, h('h3', null, 'Visit frequency'),
      h('p', { class: 'muted' }, 'Customers by number of visits (distinct days).'),
      s.buckets.map((b) => h('div', { class: 'bar-row' },
        h('span', null, `${b.bucket} visit${b.bucket === '1' ? '' : 's'}`),
        h('div', { class: 'bar' }, h('i', { style: `width:${Math.round((b.customers / maxB) * 100)}%` })),
        h('strong', null, b.customers)))),
    h('div', { class: 'card wide' }, h('h3', null, 'Top customers'),
      s.top.length ? h('table', null,
        h('thead', null, h('tr', null, ['Name', 'Phone', 'Visits', 'Spend', 'Last visit', 'Birthday', 'Points', ''].map((c) => h('th', null, c)))),
        h('tbody', null, s.top.map((c) => h('tr', null,
          h('td', null, c.name ?? '—'), h('td', { dir: 'ltr' }, c.phone), h('td', null, c.visits), h('td', null, fm(c.spend_minor)),
          h('td', null, new Date(c.last_visit).toLocaleDateString()), h('td', null, c.birthday ?? '—'), h('td', null, c.points),
          h('td', null, h('button', { class: 'btn ghost sm', onclick: () => pointsDialog(c) }, 'Points'))))))
        : h('p', { class: 'muted' }, 'No signed-in customers yet.')));
}

function pointsDialog(c) {
  const pts = h('input', { inputmode: 'numeric', placeholder: 'e.g. 50 or -20' });
  const why = h('input', { placeholder: 'Reason', maxlength: 120 });
  const out = h('p', { class: 'note' });
  const dlg = h('div', { class: 'scrim' }, h('div', { class: 'card modal' },
    h('h2', null, `Adjust points · ${c.name ?? ''}`), pts, why,
    h('div', { class: 'row gap' },
      h('button', { class: 'btn ghost sm', onclick: () => dlg.remove() }, 'Cancel'),
      h('button', { class: 'btn primary sm', onclick: async () => {
        try { await api('POST', `/api/admin/customers/${c.id}/points`, { points: Number(pts.value), reason: why.value }); dlg.remove(); render(); } catch (e) { msg(out, e.code || 'Check the values'); }
      } }, 'Save')), out));
  document.body.append(dlg);
}

// ---------- campaigns & coupons
async function viewCampaigns() {
  if (me.role === 'staff') return h('p', { class: 'card' }, 'Managers only.');
  const { campaigns } = await api('GET', '/api/admin/campaigns');
  const f = {
    name: h('input', { placeholder: 'Campaign name (shown to the diner)', maxlength: 80 }),
    kind: h('select', null, h('option', { value: 'fixed' }, 'Fixed amount off'), h('option', { value: 'percent' }, '% off'), h('option', { value: 'free_item' }, 'Free item')),
    value: h('input', { placeholder: 'Value: amount (e.g. 10.00) or % (e.g. 15)', inputmode: 'decimal' }),
    item: h('input', { placeholder: 'Free item name — exactly as on the bill' }),
    cap: h('input', { placeholder: 'Max discount (optional)', inputmode: 'decimal' }),
    min: h('input', { placeholder: 'Minimum spend (optional)', inputmode: 'decimal' }),
    audience: h('select', null,
      h('option', { value: 'all' }, 'All my customers'),
      h('option', { value: 'frequent' }, 'Frequent customers (min visits)'),
      h('option', { value: 'lapsed' }, "Haven't visited for N days"),
      h('option', { value: 'birthday' }, 'Birthday (automatic, N days before)')),
    param: h('input', { placeholder: 'N (visits / days) — optional', inputmode: 'numeric' }),
    days: h('input', { placeholder: 'Valid for (days), default 14', inputmode: 'numeric' }),
  };
  const out = h('p', { class: 'note' });
  const audienceText = { all: 'All customers', frequent: 'Frequent', lapsed: 'Lapsed', birthday: 'Birthday (auto)' };
  const val = (c) => (c.kind === 'percent' ? `${c.value}%` : c.kind === 'free_item' ? `Free ${c.item_name}` : fm(c.value));
  return h('div', { class: 'grid' },
    h('div', { class: 'card form' }, h('h3', null, 'New coupon campaign'),
      h('p', { class: 'muted' }, 'Coupons go straight to each customer\'s account and are applied at payment. Customers who opted in also get a WhatsApp message.'),
      Object.values(f),
      h('button', { class: 'btn primary sm', onclick: async () => {
        try {
          const kind = f.kind.value;
          const body = {
            name: f.name.value, kind, audience: f.audience.value,
            value: kind === 'percent' ? Number(f.value.value) : parseMajor(f.value.value || f.cap.value, cur()),
            ...(kind === 'free_item' ? { item_name: f.item.value } : {}),
            ...(f.cap.value && kind === 'percent' ? { max_minor: parseMajor(f.cap.value, cur()) } : {}),
            ...(f.min.value ? { min_spend_minor: parseMajor(f.min.value, cur()) } : {}),
            ...(f.param.value ? { audience_param: Number(f.param.value) } : {}),
            ...(f.days.value ? { valid_days: Number(f.days.value) } : {}),
          };
          const r = await api('POST', '/api/admin/campaigns', body);
          msg(out, `Created — ${r.issued} coupons issued now.`, true);
          setTimeout(render, 1200);
        } catch (e) { msg(out, e.code || 'Check the values'); }
      } }, 'Create & send'), out),
    h('div', { class: 'card' }, h('h3', null, 'Campaigns'),
      campaigns.length ? h('table', null,
        h('thead', null, h('tr', null, ['Name', 'Offer', 'Audience', 'Issued', 'Used', ''].map((c) => h('th', null, c)))),
        h('tbody', null, campaigns.map((c) => h('tr', null,
          h('td', null, c.name), h('td', null, val(c)), h('td', null, audienceText[c.audience]), h('td', null, c.issued), h('td', null, c.redeemed),
          h('td', null, h('button', { class: 'btn ghost sm', onclick: async () => { await api('POST', `/api/admin/campaigns/${c.id}/toggle`, {}); render(); } }, c.active ? 'Pause' : 'Resume'))))))
        : h('p', { class: 'muted' }, 'No campaigns yet.')));
}

// ---------- ratings
async function viewRatings() {
  if (me.role === 'staff') return h('p', { class: 'card' }, 'Managers only.');
  const { ratings } = await api('GET', '/api/admin/ratings');
  const avg = ratings.length ? (ratings.reduce((s, r) => s + r.stars, 0) / ratings.length).toFixed(2) : '—';
  return h('div', { class: 'grid' },
    h('div', { class: 'card wide' }, h('h3', null, `Ratings · average ${avg} ★ (${ratings.length})`),
      h('p', { class: 'muted' }, 'Every diner is invited to review you on Google after rating, whatever their score (Google forbids asking only happy customers).'),
      ratings.length ? h('table', null, h('tbody', null, ratings.map((r) => h('tr', null,
        h('td', null, '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars)), h('td', null, r.comment ?? ''), h('td', null, r.name ?? '—'),
        h('td', null, r.table_label), h('td', null, new Date(r.created_at).toLocaleString())))))
        : h('p', { class: 'muted' }, 'No ratings yet.')));
}

async function restaurantSettingsCard() {
  const st = await api('GET', '/api/admin/settings');
  const g = h('input', { placeholder: 'https://g.page/r/…/review', value: st.google_review_url ?? '' });
  const req = h('input', { type: 'checkbox', checked: st.require_phone });
  const loy = h('input', { type: 'checkbox', checked: st.loyalty_enabled });
  const ppu = h('input', { inputmode: 'numeric', value: st.points_per_unit });
  const out = h('p', { class: 'note' });
  return h('div', { class: 'card form' }, h('h3', null, 'Restaurant settings'),
    h('label', null, 'Google review link', g),
    h('label', { class: 'check' }, req, 'Diners must sign in with WhatsApp before paying'),
    h('label', { class: 'check' }, loy, 'Loyalty points enabled'),
    h('label', null, `Points per 1 ${st.currency}`, ppu),
    h('button', { class: 'btn primary sm', onclick: async () => {
      try {
        await api('PUT', '/api/admin/settings', { google_review_url: g.value.trim() || null, require_phone: req.checked, loyalty_enabled: loy.checked, points_per_unit: Number(ppu.value) });
        msg(out, 'Saved', true);
      } catch (e) { msg(out, e.code || 'Check the values'); }
    } }, 'Save'), out);
}

// ---------- menu (for restaurants without a POS)
async function upload(file) {
  const res = await fetch('/api/admin/menu/files', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': file.type }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error), { code: data.error });
  return data;
}

/** Spreadsheet paste → rows. Columns: Category, Item EN, Item AR, Price, (Description). Tab or comma separated. */
function parseMenuText(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim().replace(/^"|"$/g, ''));
    let price;
    try { price = parseMajor(cols[3] ?? '', cur()); } catch { continue; } // header or bad line
    rows.push({ category_en: cols[0], name_en: cols[1], ...(cols[2] ? { name_ar: cols[2] } : {}), price_minor: price, ...(cols[4] ? { description_en: cols[4] } : {}) });
  }
  return rows;
}

async function viewMenuAdmin() {
  const { categories, files } = await api('GET', '/api/admin/menu');
  const canEdit = me.role !== 'staff';
  const out = h('p', { class: 'note' });

  const fileInput = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png,image/webp', multiple: true });
  const filesCard = h('div', { class: 'card' }, h('h3', null, 'Menu files (PDF or photos)'),
    h('p', { class: 'muted' }, 'When you upload a menu here, diners see only this file under "View menu" — your own design. The item list below is then used only by your staff to build each table\'s bill. One PDF (max 10 MB) and up to 20 photos (max 5 MB each).'),
    canEdit ? [fileInput, h('button', { class: 'btn primary sm', onclick: async () => {
      try {
        for (const f of fileInput.files) await upload(f);
        render();
      } catch (e) { msg(out, e.code === 'UNSUPPORTED_FILE' ? 'Only real PDF, JPG, PNG or WEBP files.' : e.code || 'Upload failed'); }
    } }, 'Upload')] : null,
    h('div', { class: 'thumbs' }, files.map((f) => h('div', { class: 'thumb' },
      f.kind === 'menu_pdf'
        ? h('a', { class: 'pdf', href: `/media/${f.id}`, target: '_blank', rel: 'noopener' }, 'PDF menu')
        : h('a', { href: `/media/${f.id}`, target: '_blank', rel: 'noopener' }, h('img', { src: `/media/${f.id}`, alt: 'menu photo', loading: 'lazy' })),
      h('small', { class: 'muted' }, `${Math.round(f.size / 1024)} KB`),
      canEdit ? h('button', { class: 'btn ghost sm', onclick: async () => { await api('DELETE', `/api/admin/menu/files/${f.id}`, {}); render(); } }, 'Delete') : null))),
    out);

  const paste = h('textarea', { rows: 6, placeholder: 'Category\tItem (EN)\tItem (AR)\tPrice\nDrinks\tSpanish Latte\tسبانش لاتيه\t32.00' });
  const replace = h('input', { type: 'checkbox' });
  const importOut = h('p', { class: 'note' });
  const importCard = h('div', { class: 'card form' }, h('h3', null, 'Import from Excel / Google Sheets'),
    h('p', { class: 'muted' }, 'Copy 4 columns from your sheet — Category, Item (English), Item (Arabic), Price — and paste them here.'),
    paste, h('label', { class: 'check' }, replace, 'Replace the whole current menu'),
    h('button', { class: 'btn primary sm', onclick: async () => {
      const rows = parseMenuText(paste.value);
      if (!rows.length) return msg(importOut, 'No valid lines found (check the price column).');
      if (replace.checked && !confirm('Replace the whole menu?')) return;
      try { const r = await api('POST', '/api/admin/menu/import', { rows, replace: replace.checked }); msg(importOut, `Imported ${r.created} items.`, true); setTimeout(render, 800); }
      catch (e) { msg(importOut, e.code || 'Import failed'); }
    } }, 'Import'), importOut);

  const catName = { en: h('input', { placeholder: 'New category (EN)' }), ar: h('input', { placeholder: 'القسم (عربي)', dir: 'rtl' }) };
  const addCat = h('div', { class: 'card form' }, h('h3', null, 'Add category'), catName.en, catName.ar,
    h('button', { class: 'btn primary sm', onclick: async () => {
      try { await api('POST', '/api/admin/menu/categories', { name_en: catName.en.value, name_ar: catName.ar.value || catName.en.value }); render(); } catch (e) { msg(out, e.code); }
    } }, 'Add'));

  const catCards = categories.map((c) => {
    const f = { en: h('input', { placeholder: 'Item (EN)' }), ar: h('input', { placeholder: 'الصنف (عربي)', dir: 'rtl' }), price: h('input', { placeholder: 'Price', inputmode: 'decimal' }), desc: h('input', { placeholder: 'Description (optional)' }) };
    const res = h('p', { class: 'note' });
    return h('div', { class: 'card wide' },
      h('div', { class: 'row' }, h('h3', null, `${c.name_en} · ${c.name_ar}`),
        canEdit ? h('button', { class: 'btn ghost sm', onclick: async () => { if (confirm(`Delete "${c.name_en}" and its items?`)) { await api('DELETE', `/api/admin/menu/categories/${c.id}`, {}); render(); } } }, 'Delete category') : null),
      c.items.length ? h('table', null, h('tbody', null, c.items.map((i) => h('tr', null,
        h('td', null, h('strong', null, i.name_en), h('small', { class: 'muted' }, ` ${i.name_ar}`), i.description_en ? h('small', { class: 'muted block' }, i.description_en) : null),
        h('td', null, fm(i.price_minor)),
        h('td', null, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: i.available, onchange: async (e) => { await api('POST', `/api/admin/menu/items/${i.id}/availability`, { available: e.target.checked }); } }), 'Available')),
        h('td', null, canEdit ? [
          h('button', { class: 'btn ghost sm', onclick: () => editItem(c, i, categories) }, 'Edit'), ' ',
          h('button', { class: 'btn ghost sm', onclick: async () => { await api('DELETE', `/api/admin/menu/items/${i.id}`, {}); render(); } }, 'Delete')] : null)))))
        : h('p', { class: 'muted' }, 'No items yet.'),
      canEdit ? h('div', { class: 'line add-item' }, f.en, f.ar, f.price, f.desc,
        h('button', { class: 'btn primary sm', onclick: async () => {
          try {
            await api('POST', '/api/admin/menu/items', { category_id: c.id, name_en: f.en.value, name_ar: f.ar.value || f.en.value, price_minor: parseMajor(f.price.value, cur()), ...(f.desc.value ? { description_en: f.desc.value } : {}) });
            render();
          } catch (e) { msg(res, e.code || 'Check the name and price (e.g. 12.50)'); }
        } }, '+ Add item')) : null, res);
  });

  return h('div', { class: 'grid' }, filesCard, canEdit ? importCard : null, canEdit ? addCat : null, ...catCards);
}

function editItem(c, i, categories) {
  const dec = decimalsOf(cur());
  const f = {
    cat: h('select', null, categories.map((k) => h('option', { value: k.id, selected: k.id === c.id }, k.name_en))),
    en: h('input', { value: i.name_en }), ar: h('input', { value: i.name_ar, dir: 'rtl' }),
    price: h('input', { value: (Number(i.price_minor) / 10 ** dec).toFixed(dec), inputmode: 'decimal' }),
    de: h('input', { value: i.description_en ?? '', placeholder: 'Description (EN)' }), da: h('input', { value: i.description_ar ?? '', placeholder: 'الوصف', dir: 'rtl' }),
  };
  const out = h('p', { class: 'note' });
  const dlg = h('div', { class: 'scrim' }, h('div', { class: 'card modal form' }, h('h2', null, 'Edit item'), Object.values(f),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn ghost sm', onclick: () => dlg.remove() }, 'Cancel'),
      h('button', { class: 'btn primary sm', onclick: async () => {
        try {
          await api('PUT', `/api/admin/menu/items/${i.id}`, {
            category_id: f.cat.value, name_en: f.en.value, name_ar: f.ar.value, price_minor: parseMajor(f.price.value, cur()),
            description_en: f.de.value || null, description_ar: f.da.value || null, available: i.available,
          });
          dlg.remove(); render();
        } catch (e) { msg(out, e.code || 'Check the values'); }
      } }, 'Save')), out));
  document.body.append(dlg);
}
