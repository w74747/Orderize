// Live orders board, shared by the restaurant dashboard and paired order-station devices.
// Polls the server, plays an alert while new orders or waiter calls are waiting, and prints
// 80 mm kitchen tickets through the browser's print dialog (Sunmi / Android POS printers,
// or any printer set as default).
import { formatMoney } from '../shared/billing.js';

export function h(tag, attrs, ...kids) {
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

export async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'ERROR'), { code: data.error, status: res.status });
  return data;
}

const STATUS = { new: 'New', preparing: 'Preparing', ready: 'Ready', served: 'Served', cancelled: 'Cancelled' };
const ACTIONS = {
  new: [['preparing', 'Accept', 'primary'], ['cancelled', 'Reject', 'ghost']],
  preparing: [['ready', 'Ready', 'primary'], ['served', 'Served', 'soft']],
  ready: [['served', 'Served', 'primary']],
};
const REASONS = ['Item not available', 'Kitchen is closed', 'Duplicate order', 'Please order from a waiter'];
const pref = (k, d) => { try { return JSON.parse(localStorage.getItem(`orderize_${k}`)) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`orderize_${k}`, JSON.stringify(v)); } catch { /* ignore */ } };
const ago = (iso, now) => {
  const m = Math.max(0, Math.round((now - new Date(iso)) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const lineText = (l) => `${l.qty}× ${l.name_en || l.name_ar}${l.name_ar && l.name_en ? ` · ${l.name_ar}` : ''}`;

/** Short repeating chime with Web Audio (no audio files, works offline). */
function chime() {
  let ctx = null;
  return {
    unlock() { ctx ??= new (window.AudioContext || window.webkitAudioContext)(); return ctx.resume(); },
    get ready() { return ctx?.state === 'running'; },
    play() {
      if (!ctx || ctx.state !== 'running') return;
      const t0 = ctx.currentTime;
      [880, 1175, 1568].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + i * 0.16);
        g.gain.exponentialRampToValueAtTime(0.35, t0 + i * 0.16 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + i * 0.16); o.stop(t0 + i * 0.16 + 0.32);
      });
    },
  };
}

export function mountBoard(container, { restaurant, onAuthLost } = {}) {
  const sound = chime();
  let data = { orders: [], calls: [] };
  let timer = null, alertT = null, stopped = false, showDone = false;
  let soundOn = pref('sound', true), autoPrint = pref('autoprint', false);
  const printed = new Set(pref('printed', []));
  const money = (m, c) => formatMoney(Number(m), c, 'en');

  const status = h('span', { class: 'ob-status' });
  const soundBtn = h('button', { class: 'btn soft sm' });
  const printBtn = h('button', { class: 'btn soft sm' });
  const doneBtn = h('button', { class: 'btn soft sm', onclick: () => { showDone = !showDone; paint(); } });
  const calls = h('div', { class: 'ob-calls' });
  const cols = { new: h('div', { class: 'ob-col-list' }), preparing: h('div', { class: 'ob-col-list' }), ready: h('div', { class: 'ob-col-list' }) };
  const heads = { new: h('h3'), preparing: h('h3'), ready: h('h3') };
  const done = h('div', { class: 'ob-done' });
  const printArea = document.getElementById('print-area') ?? document.body.appendChild(h('div', { id: 'print-area' }));

  function paintToggles() {
    soundBtn.textContent = soundOn ? (sound.ready ? '🔔 Sound on' : '🔔 Tap to enable sound') : '🔕 Sound off';
    printBtn.textContent = autoPrint ? '🖨 Auto-print on accept: on' : '🖨 Auto-print on accept: off';
    doneBtn.textContent = showDone ? 'Hide finished' : 'Show finished';
  }
  soundBtn.addEventListener('click', async () => {
    if (soundOn && !sound.ready) { await sound.unlock(); sound.play(); }
    else { soundOn = !soundOn; setPref('sound', soundOn); if (soundOn) await sound.unlock(); }
    paintToggles();
  });
  printBtn.addEventListener('click', () => { autoPrint = !autoPrint; setPref('autoprint', autoPrint); paintToggles(); });
  // Browsers only allow audio after a user gesture: the first tap anywhere unlocks it.
  container.addEventListener('pointerdown', () => { if (soundOn && !sound.ready) sound.unlock().then(paintToggles); }, { once: true });

  function printTicket(o) {
    const now = new Date();
    printArea.replaceChildren(h('div', { class: 'ticket' },
      h('div', { class: 'tk-head' }, restaurant?.name_en ?? 'Orderize'),
      h('div', { class: 'tk-big' }, `#${o.number} · Table ${o.table}`),
      h('div', { class: 'tk-small' }, new Date(o.created_at).toLocaleString()),
      h('hr'),
      o.items.map((l) => h('div', { class: 'tk-line' },
        h('div', { class: 'tk-item' }, lineText(l)),
        l.options?.length ? h('div', { class: 'tk-opt' }, l.options.map((c) => `+ ${c.name_en || c.name_ar}`).join('\n')) : null,
        l.note ? h('div', { class: 'tk-note' }, `» ${l.note}`) : null)),
      o.note ? [h('hr'), h('div', { class: 'tk-note' }, `NOTE: ${o.note}`)] : null,
      h('hr'),
      h('div', { class: 'tk-total' }, `Total ${money(o.subtotal_minor, o.currency)}`),
      h('div', { class: 'tk-small' }, `Printed ${now.toLocaleTimeString()}`)));
    printed.add(o.id);
    setPref('printed', [...printed].slice(-200));
    window.print();
  }

  async function move(o, next) {
    let reason;
    if (next === 'cancelled') {
      reason = await pickReason();
      if (reason === null) return;
    }
    try {
      await api('POST', `/api/orders/${o.id}/status`, { status: next, ...(reason ? { reason } : {}) });
      if (next === 'preparing' && autoPrint) printTicket(o);
      await poll();
    } catch (e) { flash(e.code === 'INVALID_TRANSITION' ? 'This order was already updated on another device.' : (e.code || 'Error')); await poll(); }
  }

  function pickReason() {
    return new Promise((resolve) => {
      const other = h('input', { placeholder: 'Other reason', maxlength: '200' });
      const close = (v) => { dlg.remove(); resolve(v); };
      const dlg = h('div', { class: 'scrim' }, h('div', { class: 'card modal form' },
        h('h2', null, 'Reject order'), h('p', { class: 'muted' }, 'The diner will see this reason.'),
        REASONS.map((r) => h('button', { class: 'btn soft', onclick: () => close(r) }, r)),
        other, h('div', { class: 'row gap' },
          h('button', { class: 'btn ghost sm', onclick: () => close(null) }, 'Back'),
          h('button', { class: 'btn primary sm', onclick: () => close(other.value.trim() || null) }, 'Reject'))));
      document.body.append(dlg);
    });
  }

  function flash(t) { status.textContent = t; status.className = 'ob-status err'; setTimeout(() => { status.className = 'ob-status'; }, 4000); }

  function card(o, now) {
    const late = o.status === 'new' && now - new Date(o.created_at) > 3 * 60000;
    return h('article', { class: `ob-card s-${o.status}${late ? ' late' : ''}` },
      h('header', null, h('strong', { class: 'ob-num' }, `#${o.number}`), h('span', { class: 'ob-table' }, `Table ${o.table}`),
        h('span', { class: 'ob-time' }, ago(o.created_at, now))),
      o.pos_entry_needed ? h('span', { class: 'chip warn' }, 'Enter this order in the POS') : null,
      h('ul', null, o.items.map((l) => h('li', null, h('strong', null, lineText(l)),
        l.options?.length ? h('small', null, l.options.map((c) => c.name_en || c.name_ar).join(' · ')) : null,
        l.note ? h('em', null, `“${l.note}”`) : null))),
      o.note ? h('p', { class: 'ob-note' }, `Note: ${o.note}`) : null,
      o.cancel_reason ? h('p', { class: 'muted' }, `Reason: ${o.cancel_reason}`) : null,
      h('footer', null,
        h('span', { class: 'num' }, money(o.subtotal_minor, o.currency)),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn ghost sm', title: 'Print ticket', onclick: () => printTicket(o) }, printed.has(o.id) ? '🖨 Reprint' : '🖨 Print'),
          (ACTIONS[o.status] ?? []).map(([next, label, kind]) => h('button', { class: `btn ${kind} sm`, onclick: () => move(o, next) }, label)))));
  }

  function paint() {
    const now = Date.now() + (data.offset ?? 0);
    calls.replaceChildren(...data.calls.map((c) => h('div', { class: 'ob-call' },
      h('strong', null, c.kind === 'bill' ? `🧾 Table ${c.table_label} asks for the bill` : `🔔 Table ${c.table_label} calls a waiter`),
      h('span', { class: 'muted' }, ago(c.created_at, now)),
      h('button', { class: 'btn primary sm', onclick: async () => { await api('POST', `/api/orders/calls/${c.id}/resolve`, {}).catch(() => {}); poll(); } }, 'Done'))));
    for (const k of Object.keys(cols)) {
      const list = data.orders.filter((o) => o.status === k).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      heads[k].textContent = `${STATUS[k]} (${list.length})`;
      cols[k].replaceChildren(...(list.length ? list.map((o) => card(o, now)) : [h('p', { class: 'muted ob-empty' }, '—')]));
    }
    const fin = data.orders.filter((o) => o.status === 'served' || o.status === 'cancelled');
    done.hidden = !showDone;
    done.replaceChildren(h('h3', null, `Finished in the last 3 hours (${fin.length})`), ...fin.map((o) => card(o, now)));
    paintToggles();
  }

  function alertLoop() {
    clearTimeout(alertT);
    const waiting = data.orders.some((o) => o.status === 'new') || data.calls.length > 0;
    if (waiting && soundOn) sound.play();
    if (!stopped) alertT = setTimeout(alertLoop, waiting ? 8000 : 4000);
  }

  async function poll() {
    clearTimeout(timer);
    try {
      const fresh = await api('GET', '/api/orders/board');
      fresh.offset = new Date(fresh.server_time) - Date.now();
      const newIds = fresh.orders.filter((o) => o.status === 'new' && !data.orders.some((x) => x.id === o.id));
      data = fresh;
      status.textContent = `Live · updated ${new Date().toLocaleTimeString()}`;
      status.className = 'ob-status';
      paint();
      if (newIds.length && soundOn) sound.play();
    } catch (e) {
      if (e.status === 401) { stopped = true; onAuthLost?.(); return; }
      status.textContent = 'Connection lost — retrying…';
      status.className = 'ob-status err';
    }
    if (!stopped) timer = setTimeout(poll, 4000);
  }

  container.replaceChildren(h('div', { class: 'ob' },
    h('div', { class: 'ob-bar' }, status, h('div', { class: 'row gap' }, soundBtn, printBtn, doneBtn)),
    calls,
    h('div', { class: 'ob-cols' }, ['new', 'preparing', 'ready'].map((k) => h('section', { class: `ob-col c-${k}` }, heads[k], cols[k]))),
    done));
  paint();
  poll();
  alertLoop();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(alertT); };
}
