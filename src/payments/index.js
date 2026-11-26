// Payment provider abstraction.
// Card data NEVER touches our servers: every provider uses a hosted payment page
// (PCI DSS SAQ-A scope). We only receive brand, BIN and last4 from verified webhooks.
//
// Provider contract:
//   createCheckout({ payment, restaurant }) -> { provider_ref, redirect_url }
//   verifyWebhook(rawBody, headers)         -> NormalizedEvent   (throws if unverifiable)
//
// NormalizedEvent: { event_id, provider_ref, payment_id, status: 'captured'|'failed',
//                    amount_minor, currency, card: { brand, last4, bin } }

import { sandboxProvider } from './sandbox.js';
import { tapProvider } from './tap.js';
import { checkoutProvider } from './checkout.js';

export function createProvider(config) {
  switch (config.PAYMENT_PROVIDER) {
    case 'sandbox': return sandboxProvider(config);
    case 'tap': return tapProvider(config);
    case 'checkout': return checkoutProvider(config);
    default: throw new Error('unknown provider');
  }
}

export { WebhookError, httpJson } from './util.js';
