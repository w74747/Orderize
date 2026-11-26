import * as S from './schemas.js';
import { HttpError, ratePayment } from '../services/bills.js';
import { accountView, customerFromToken, deleteAccount, publicCustomer, requestOtp, updateProfile, verifyOtp } from '../services/customers.js';
import { sha256 } from '../lib/crypto.js';

export const dinerCookie = (config) => (config.COOKIE_SECURE ? '__Host-orderize_diner' : 'orderize_diner');

/** Resolves the signed-in diner (or null) from the diner cookie. */
export const getDiner = (ctx, req) => customerFromToken(ctx.pool, req.cookies[dinerCookie(ctx.config)]);

export default async function meRoutes(app, { ctx }) {
  const { pool, config } = ctx;
  const COOKIE = dinerCookie(config);
  const origin = new URL(config.PUBLIC_BASE_URL).origin;
  // Lax (not Strict) so the session survives the top-level navigation from the QR scan.
  const cookieOpts = { path: '/', httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax' };

  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (req.method === 'GET') return;
    if (req.headers.origin !== origin) throw new HttpError(403, 'BAD_ORIGIN');
  });

  const requireDiner = async (req) => {
    req.diner = await getDiner(ctx, req);
    if (!req.diner) throw new HttpError(401, 'SIGN_IN_REQUIRED');
  };

  app.post('/api/me/otp', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const b = S.otpRequest.parse(req.body);
    return requestOtp(ctx, { country: b.country, phone: b.phone, ip: req.ip });
  });

  app.post('/api/me/otp/verify', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = S.otpVerify.parse(req.body);
    const r = await verifyOtp(ctx, { challengeId: b.challenge_id, code: b.code });
    if (r.error) return reply.code(422).send({ error: r.error, attempts_left: r.attempts_left });
    reply.setCookie(COOKIE, r.token, { ...cookieOpts, maxAge: 90 * 86400 });
    return { customer: r.customer, needs_profile: r.needs_profile };
  });

  app.get('/api/me', { preHandler: requireDiner }, async (req) => accountView(pool, req.diner));

  app.put('/api/me/profile', { preHandler: requireDiner }, async (req) => {
    const p = S.profile.parse(req.body);
    return { customer: await updateProfile(pool, req.diner.id, p) };
  });

  app.post('/api/me/logout', async (req, reply) => {
    const t = req.cookies[COOKIE];
    if (t) await pool.query('DELETE FROM customer_sessions WHERE id_hash = $1', [sha256(t)]);
    reply.clearCookie(COOKIE, cookieOpts);
    return { ok: true };
  });

  app.delete('/api/me', { preHandler: requireDiner }, async (req, reply) => {
    await deleteAccount(pool, req.diner.id);
    reply.clearCookie(COOKIE, cookieOpts);
    return { ok: true };
  });

  app.post('/api/payments/:id/rating', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = S.rating.parse(req.body);
    return ratePayment(pool, req.params.id, b, await getDiner(ctx, req));
  });
}

export { publicCustomer };
