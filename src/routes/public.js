import { idempotencyKey, payRequest } from './schemas.js';
import { createPayment, HttpError, paymentStatus, publicView, quoteFor } from '../services/bills.js';
import { getDiner } from './me.js';

export default async function publicRoutes(app, { ctx }) {
  const { pool } = ctx;

  app.get('/api/t/:token', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return publicView(ctx, req.params.token, await getDiner(ctx, req));
  });

  app.post('/api/t/:token/quote', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const body = payRequest.parse(req.body);
    return quoteFor(pool, req.params.token, body, await getDiner(ctx, req));
  });

  app.post(
    '/api/t/:token/payments',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const key = idempotencyKey.safeParse(req.headers['idempotency-key']);
      if (!key.success) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED');
      const body = payRequest.parse(req.body);
      const p = await createPayment(ctx, { token: req.params.token, body, idemKey: key.data, ip: req.ip, customer: await getDiner(ctx, req) });
      reply.code(201).header('cache-control', 'no-store');
      return { payment_id: p.id, redirect_url: p.redirect_url, total_minor: p.total_minor, currency: p.currency };
    },
  );

  app.get('/api/payments/:id', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return paymentStatus(pool, req.params.id);
  });
}
