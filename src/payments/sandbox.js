// Local sandbox provider for development/demo. Simulates a hosted payment page and a
// signed webhook. Refused in production by config validation.
import { hmacHex, randomToken, safeEqual } from '../lib/crypto.js';
import { WebhookError } from './util.js';

export function sandboxProvider(config) {
  const secret = `sandbox-webhook:${config.APP_SECRET}`;
  return {
    name: 'sandbox',
    async createCheckout({ payment }) {
      const provider_ref = `sbx_${randomToken(12)}`;
      const sig = hmacHex(secret, `checkout:${payment.id}:${provider_ref}`);
      return {
        provider_ref,
        redirect_url: `${config.PUBLIC_BASE_URL}/sandbox/checkout/${payment.id}?ref=${provider_ref}&sig=${sig}`,
      };
    },
    checkoutSigValid(paymentId, ref, sig) {
      return typeof sig === 'string' && safeEqual(hmacHex(secret, `checkout:${paymentId}:${ref}`), sig);
    },
    sign(raw) {
      return hmacHex(secret, raw);
    },
    async verifyWebhook(raw, headers) {
      const sig = headers['x-sandbox-signature'];
      if (!sig || !safeEqual(hmacHex(secret, raw), sig)) throw new WebhookError('bad signature');
      const e = JSON.parse(raw);
      return {
        event_id: e.id,
        provider_ref: e.provider_ref,
        payment_id: e.payment_id,
        status: e.status,
        amount_minor: e.amount_minor,
        currency: e.currency,
        card: e.card,
      };
    },
  };
}
