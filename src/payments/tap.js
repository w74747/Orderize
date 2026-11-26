// Tap Payments (https://developers.tap.company) — widely used across the GCC
// (KNET, mada, Benefit, Apple Pay, Google Pay, cards).
// Defense in depth: the webhook signature is checked, THEN the charge is re-fetched
// from Tap's API with our secret key and that response is what we trust.
// Verify field names against Tap's current API reference before going live.
import { hmacHex, safeEqual } from '../lib/crypto.js';
import { CURRENCIES } from '../../shared/billing.js';
import { WebhookError, httpJson } from './util.js';

const API = 'https://api.tap.company/v2';

const toMajor = (minor, cur) => (minor / 10 ** CURRENCIES[cur].decimals).toFixed(CURRENCIES[cur].decimals);
const toMinor = (major, cur) => Math.round(Number(major) * 10 ** CURRENCIES[cur].decimals);

export function tapProvider(config) {
  const auth = { authorization: `Bearer ${config.TAP_SECRET_KEY}` };

  function normalize(ch) {
    const cur = ch.currency;
    if (!CURRENCIES[cur]) throw new WebhookError('bad currency');
    return {
      event_id: `${ch.id}:${ch.status}`,
      provider_ref: ch.id,
      payment_id: ch.metadata?.payment_id,
      status: ch.status === 'CAPTURED' ? 'captured' : ['FAILED', 'DECLINED', 'CANCELLED', 'ABANDONED', 'TIMEDOUT'].includes(ch.status) ? 'failed' : 'pending',
      amount_minor: toMinor(ch.amount, cur),
      currency: cur,
      card: { brand: ch.card?.brand ?? null, last4: ch.card?.last_four ?? null, bin: ch.card?.first_six ?? null },
    };
  }

  return {
    name: 'tap',
    async createCheckout({ payment, restaurant }) {
      const ch = await httpJson(`${API}/charges`, {
        method: 'POST',
        headers: auth,
        body: {
          amount: toMajor(payment.total_minor, payment.currency),
          currency: payment.currency,
          threeDSecure: true,
          save_card: false,
          description: `${restaurant.name_en} bill`,
          metadata: { payment_id: payment.id },
          reference: { transaction: payment.id, order: payment.bill_id },
          source: { id: 'src_all' },
          post: { url: `${config.PUBLIC_BASE_URL}/api/webhooks/tap` },
          redirect: { url: `${config.PUBLIC_BASE_URL}/pay/return?payment=${payment.id}` },
        },
      });
      if (!ch.id || !ch.transaction?.url) throw new Error('tap: unexpected response');
      return { provider_ref: ch.id, redirect_url: ch.transaction.url };
    },
    async verifyWebhook(raw, headers) {
      const body = JSON.parse(raw);
      const cur = body.currency;
      if (!CURRENCIES[cur]) throw new WebhookError('bad currency');
      const amount = Number(body.amount).toFixed(CURRENCIES[cur].decimals);
      const toSign =
        `x_id${body.id}x_amount${amount}x_currency${cur}` +
        `x_gateway_reference${body.reference?.gateway ?? ''}x_payment_reference${body.reference?.payment ?? ''}` +
        `x_status${body.status}x_created${body.transaction?.created ?? ''}`;
      const sig = headers['hashstring'];
      if (!sig || !safeEqual(hmacHex(config.TAP_WEBHOOK_SECRET, toSign), sig)) throw new WebhookError('bad signature');
      // Trust only what Tap's API returns for this charge id.
      const fresh = await httpJson(`${API}/charges/${encodeURIComponent(body.id)}`, { headers: auth });
      return normalize(fresh);
    },
  };
}
