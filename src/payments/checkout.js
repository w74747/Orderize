// Checkout.com Hosted Payments Page (https://www.checkout.com/docs).
// Webhook: HMAC-SHA256 of the raw body in `cko-signature`, then the payment is
// re-fetched from the API and that response is trusted.
// Verify field names against Checkout.com's current API reference before going live.
import { hmacHex, safeEqual } from '../lib/crypto.js';
import { CURRENCIES } from '../../shared/billing.js';
import { WebhookError, httpJson } from './util.js';

export function checkoutProvider(config) {
  const API = config.NODE_ENV === 'production' ? 'https://api.checkout.com' : 'https://api.sandbox.checkout.com';
  const auth = { authorization: `Bearer ${config.CHECKOUT_SECRET_KEY}` };

  return {
    name: 'checkout',
    async createCheckout({ payment, restaurant }) {
      const ret = `${config.PUBLIC_BASE_URL}/pay/return?payment=${payment.id}`;
      const r = await httpJson(`${API}/hosted-payments`, {
        method: 'POST',
        headers: { ...auth, 'cko-idempotency-key': payment.id },
        body: {
          amount: payment.total_minor, // Checkout.com uses minor units
          currency: payment.currency,
          reference: payment.id,
          description: `${restaurant.name_en} bill`,
          billing: { address: { country: restaurant.country } },
          processing_channel_id: config.CHECKOUT_PROCESSING_CHANNEL_ID,
          '3ds': { enabled: true },
          metadata: { payment_id: payment.id },
          success_url: ret,
          failure_url: ret,
          cancel_url: ret,
        },
      });
      if (!r.id || !r._links?.redirect?.href) throw new Error('checkout: unexpected response');
      return { provider_ref: r.id, redirect_url: r._links.redirect.href };
    },
    async verifyWebhook(raw, headers) {
      const sig = headers['cko-signature'];
      if (!sig || !safeEqual(hmacHex(config.CHECKOUT_WEBHOOK_SECRET, raw), sig)) throw new WebhookError('bad signature');
      const evt = JSON.parse(raw);
      const p = await httpJson(`${API}/payments/${encodeURIComponent(evt.data?.id)}`, { headers: auth });
      if (!CURRENCIES[p.currency]) throw new WebhookError('bad currency');
      return {
        event_id: evt.id,
        provider_ref: p.metadata?.hosted_payment_id ?? evt.data?.id,
        payment_id: p.metadata?.payment_id ?? p.reference,
        status: p.status === 'Captured' || p.status === 'Paid' ? 'captured' : ['Declined', 'Canceled', 'Voided', 'Expired'].includes(p.status) ? 'failed' : 'pending',
        amount_minor: p.amount,
        currency: p.currency,
        card: { brand: p.source?.scheme ?? null, last4: p.source?.last4 ?? null, bin: p.source?.bin ?? null },
      };
    },
  };
}
