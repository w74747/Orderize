// TEST-ONLY: send sign-in codes from a regular WhatsApp number linked by QR code
// (like WhatsApp Web), using the unofficial Baileys library.
//
// Risks (shown to the operator in the console too):
// - WhatsApp's terms forbid unofficial clients; the number can be banned. Use a spare number.
// - The stored session gives full access to that WhatsApp account. It is encrypted at rest,
//   messages are never read or stored, and it can be unlinked from the console or the phone.
// - Refused in real production by config validation. Replace with the Cloud API before launch.
import makeWASocket, { Browsers, BufferJSON, DisconnectReason, initAuthCreds, proto } from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const PER_MINUTE = 10;   // keep volume low: bursts are what get numbers banned
const PER_DAY = 200;

export function createWaWeb({ pool, cipher, log }) {
  let sock = null;
  let state = 'disconnected'; // disconnected | connecting | qr | connected
  let qr = null;
  let me = null;
  let stopped = true;
  let starting = false;
  const sent = [];

  const read = async (key) => {
    const { rows } = await pool.query('SELECT value_enc FROM wa_web_auth WHERE key = $1', [key]);
    return rows[0] ? JSON.parse(cipher.decrypt(rows[0].value_enc), BufferJSON.reviver) : null;
  };
  const write = (key, value) => pool.query(
    `INSERT INTO wa_web_auth(key, value_enc) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
    [key, cipher.encrypt(JSON.stringify(value, BufferJSON.replacer))],
  );
  const remove = (key) => pool.query('DELETE FROM wa_web_auth WHERE key = $1', [key]);

  async function authState() {
    const creds = (await read('creds')) || initAuthCreds();
    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            const out = {};
            await Promise.all(ids.map(async (id) => {
              let v = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
              out[id] = v;
            }));
            return out;
          },
          set: async (data) => {
            const tasks = [];
            for (const cat in data) for (const id in data[cat]) {
              const v = data[cat][id];
              tasks.push(v ? write(`${cat}-${id}`, v) : remove(`${cat}-${id}`));
            }
            await Promise.all(tasks);
          },
        },
      },
      saveCreds: () => write('creds', creds),
    };
  }

  async function start() {
    stopped = false;
    if (sock || starting) return;
    starting = true;
    state = 'connecting';
    try {
      const { state: auth, saveCreds } = await authState();
      sock = makeWASocket({
        auth,
        browser: Browsers.ubuntu('Orderize'),
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        getMessage: async () => undefined, // we never store message contents
      });
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (u) => {
        if (u.qr) { state = 'qr'; qr = u.qr; }
        if (u.connection === 'open') {
          state = 'connected'; qr = null;
          me = sock.user?.id?.split(':')[0]?.split('@')[0] ?? null;
          log.info('whatsapp test link connected');
        }
        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          sock = null; me = null; qr = null;
          if (code === DisconnectReason.loggedOut) {
            state = 'disconnected';
            stopped = true;
            pool.query('DELETE FROM wa_web_auth').catch(() => {});
            log.warn('whatsapp test link logged out');
          } else if (!stopped) {
            state = 'connecting';
            setTimeout(() => start().catch((e) => log.error(e)), 3000).unref();
          } else {
            state = 'disconnected';
          }
        }
      });
    } finally {
      starting = false;
    }
  }

  return {
    get connected() { return state === 'connected'; },

    async status() {
      return {
        state,
        number: me ? `+${me.slice(0, 4)}•••${me.slice(-3)}` : null,
        qr_svg: state === 'qr' && qr ? await QRCode.toString(qr, { type: 'svg', margin: 1 }) : null,
        sent_last_24h: sent.filter((t) => t > Date.now() - 864e5).length,
      };
    },

    start,

    /** Resume a saved session at boot (no QR needed if the phone is still linked). */
    async resume() {
      const { rows } = await pool.query(`SELECT 1 FROM wa_web_auth WHERE key = 'creds'`);
      if (rows.length) await start();
    },

    /** Unlinks the device from the phone and deletes the stored session. */
    async logout() {
      stopped = true;
      try { await sock?.logout(); } catch { /* already gone */ }
      sock?.end?.(undefined);
      sock = null; state = 'disconnected'; qr = null; me = null;
      await pool.query('DELETE FROM wa_web_auth');
    },

    async stop() {
      stopped = true;
      sock?.end?.(undefined);
      sock = null;
    },

    async sendText(e164, text) {
      if (state !== 'connected') throw new Error('not connected');
      const now = Date.now();
      while (sent.length && sent[0] < now - 864e5) sent.shift();
      if (sent.filter((t) => t > now - 60_000).length >= PER_MINUTE || sent.length >= PER_DAY) throw new Error('send limit');
      sent.push(now);
      await sock.sendMessage(`${e164.replace('+', '')}@s.whatsapp.net`, { text });
    },
  };
}
