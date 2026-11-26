// Order station: a phone, tablet or Sunmi-type POS with a built-in printer, paired to one
// restaurant. It can only see and move orders and waiter calls.
import { api, h, mountBoard } from './orders-board.js';

const root = document.getElementById('station');
let wake = null;

async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !wake) keepAwake(); });

function notPaired(text) {
  root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card login' },
    h('h1', null, 'Orderize · Order station'),
    h('p', null, text ?? 'This device is not paired yet.'),
    h('ol', { class: 'muted' },
      h('li', null, 'On the restaurant dashboard, open Orders → Order stations.'),
      h('li', null, 'Add a device (or tap “New pairing code”).'),
      h('li', null, 'Scan the QR code with this device’s camera.')),
    h('p', { class: 'muted' }, 'Staff signed in to the dashboard on this browser can also use this screen.'),
    h('a', { class: 'btn soft', href: '/admin' }, 'Open the dashboard'))));
}

async function boot() {
  const m = location.hash.match(/pair=([A-Za-z0-9_-]{20,64})/);
  if (m) {
    history.replaceState(null, '', '/station'); // remove the single-use code from the address bar
    try { await api('POST', '/api/station/pair', { code: m[1] }); } catch (e) {
      return notPaired(e.code === 'PAIR_CODE_INVALID' ? 'This pairing code has expired or was already used. Create a new one on the dashboard.' : 'Pairing failed, try again.');
    }
  }
  let who;
  try { who = await api('GET', '/api/orders/whoami'); } catch { return notPaired(); }
  const board = h('div');
  root.replaceChildren(h('div', { class: 'st-shell' },
    h('header', { class: 'st-bar' },
      h('div', null, h('strong', null, who.restaurant.name_en), h('small', { class: 'muted' }, ` · ${who.device ?? who.user}`)),
      h('div', { class: 'row gap' },
        document.fullscreenEnabled ? h('button', { class: 'btn soft sm', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}) }, 'Full screen') : null,
        who.device ? h('button', { class: 'btn ghost sm', onclick: async () => {
          const dlg = h('div', { class: 'scrim' }, h('div', { class: 'card modal form' }, h('h2', null, 'Unpair this device?'),
            h('p', null, 'It will stop receiving orders until it is paired again.'),
            h('div', { class: 'row gap' }, h('button', { class: 'btn ghost sm', onclick: () => dlg.remove() }, 'Cancel'),
              h('button', { class: 'btn primary sm', onclick: async () => { await api('POST', '/api/station/unpair', {}); dlg.remove(); notPaired(); } }, 'Unpair'))));
          document.body.append(dlg);
        } }, 'Unpair') : null)),
    board));
  mountBoard(board, { restaurant: who.restaurant, onAuthLost: () => notPaired('This device was removed from the restaurant. Pair it again to continue.') });
  keepAwake();
}

boot();
