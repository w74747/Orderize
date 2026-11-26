import { applyProviderEvent } from '../services/bills.js';
import { WebhookError } from '../payments/index.js';

export default async function webhookRoutes(app, { ctx }) {
  const { pool, provider } = ctx;

  // Keep the exact raw bytes: signatures are computed over the raw body.
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256 * 1024 }, (req, body, done) =>
    done(null, body),
  );

  app.post('/api/webhooks/:provider', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (req.params.provider !== provider.name) return reply.code(404).send({ error: 'NOT_FOUND' });
    let evt;
    try {
      evt = await provider.verifyWebhook(String(req.body ?? ''), req.headers);
    } catch (e) {
      req.log.warn({ err: e.message }, 'webhook rejected');
      return reply.code(e instanceof WebhookError ? 401 : 400).send({ error: 'INVALID_WEBHOOK' });
    }
    const result = await applyProviderEvent(pool, provider.name, evt);
    req.log.info({ payment: evt.payment_id, result }, 'webhook processed');
    return { ok: true };
  });
}
