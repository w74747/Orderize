// SANDBOX ONLY — simulates a provider's hosted payment page so the whole flow can be
// tested without real money. Registered only when PAYMENT_PROVIDER=sandbox.
// Test cards: 4242 4242 4242 4242 (success), 4000 0000 0000 0002 (declined).
import { randomUUID } from 'node:crypto';
import { applyProviderEvent } from '../services/bills.js';
import { formatMoney } from '../../shared/billing.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const UUID = /^[0-9a-f-]{36}$/i;

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/sandbox.css"></head><body><main class="sbx">${inner}</main></body></html>`;
}

export default async function sandboxRoutes(app, { ctx }) {
  const { pool, provider } = ctx;

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body))),
  );

  async function load(req) {
    const { id } = req.params;
    const { ref, sig } = { ...req.query, ...(req.body ?? {}) };
    if (!UUID.test(id) || !provider.checkoutSigValid(id, ref, sig)) return null;
    const { rows } = await pool.query(
      `SELECT p.*, r.name_en FROM payments p JOIN restaurants r ON r.id = p.restaurant_id
        WHERE p.id = $1 AND p.provider_ref = $2`,
      [id, ref],
    );
    return rows[0] ? { p: rows[0], ref, sig } : null;
  }

  function form({ p, ref, sig }, error = '') {
    return page('Sandbox checkout', `
      <div class="badge">SANDBOX — no real money</div>
      <h1>${esc(p.name_en)}</h1>
      <p class="amt">${esc(formatMoney(p.total_minor, p.currency, 'en'))}</p>
      ${p.allowed_bins?.length ? `<p class="note">Bank offer applied — card must start with: ${esc(p.allowed_bins.join(', '))}</p>` : ''}
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <form method="post" action="/sandbox/checkout/${esc(p.id)}">
        <input type="hidden" name="ref" value="${esc(ref)}"><input type="hidden" name="sig" value="${esc(sig)}">
        <label>Card number<input name="card" inputmode="numeric" autocomplete="off" value="4242424242424242" maxlength="19"></label>
        <button name="action" value="pay">Pay</button>
        <button name="action" value="cancel" class="ghost">Cancel</button>
      </form>
      <p class="hint">4242424242424242 = success · 4000000000000002 = declined</p>`);
  }

  app.get('/sandbox/checkout/:id', async (req, reply) => {
    const s = await load(req);
    if (!s) return reply.code(404).type('text/plain').send('Not found');
    if (s.p.status !== 'pending') return reply.redirect(`/pay/return?payment=${s.p.id}`);
    return reply.type('text/html').send(form(s));
  });

  app.post('/sandbox/checkout/:id', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const s = await load(req);
    if (!s) return reply.code(404).type('text/plain').send('Not found');
    const card = String(req.body.card ?? '').replace(/\s/g, '');
    let status = 'failed';
    if (req.body.action === 'pay') {
      if (!/^\d{16}$/.test(card)) return reply.type('text/html').send(form(s, 'Enter a 16-digit test card number'));
      if (s.p.allowed_bins?.length && !s.p.allowed_bins.some((b) => card.startsWith(b))) {
        return reply.type('text/html').send(form(s, 'This offer is only valid with the participating bank card.'));
      }
      status = card === '4000000000000002' ? 'failed' : 'captured';
    }
    const evt = {
      id: `evt_${randomUUID()}`, payment_id: s.p.id, provider_ref: s.ref, status,
      amount_minor: s.p.total_minor, currency: s.p.currency,
      card: { brand: card.startsWith('5') ? 'MASTERCARD' : 'VISA', last4: card.slice(-4) || null, bin: card.slice(0, 6) || null },
    };
    // Exercise the exact same verified-webhook path as real providers.
    const raw = JSON.stringify(evt);
    const verified = await provider.verifyWebhook(raw, { 'x-sandbox-signature': provider.sign(raw) });
    await applyProviderEvent(pool, provider.name, verified);
    return reply.redirect(`/pay/return?payment=${s.p.id}`, 303);
  });
}
