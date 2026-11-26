import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { ZodError } from 'zod';
import { makeCipher } from './lib/crypto.js';
import { createProvider } from './payments/index.js';
import { HttpError, expireStalePayments } from './services/bills.js';
import { createConnectors } from './pos/connectors/index.js';
import { processWritebacks } from './pos/service.js';
import { PosError } from './pos/http.js';
import { oauthCallbackRoutes } from './routes/integrations.js';
import publicRoutes from './routes/public.js';
import webhookRoutes from './routes/webhooks.js';
import sandboxRoutes from './routes/sandbox.js';
import adminRoutes from './routes/admin.js';
import posRoutes from './routes/pos.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildApp({ config, pool, logger = true }) {
  const app = Fastify({
    logger: logger && {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-pos-signature"]',
        'req.headers["x-pos-key"]', 'req.headers.hashstring', 'req.headers["cko-signature"]'],
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 64 * 1024,
    genReqId: () => crypto.randomUUID(),
    routerOptions: { maxParamLength: 100 },
  });

  const ctx = {
    pool, config, provider: createProvider(config), cipher: makeCipher(config.APP_SECRET), log: app.log,
    connectors: createConnectors(config),
  };
  app.decorate('ctx', ctx);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
      },
    },
    hsts: config.NODE_ENV === 'production' ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'no-referrer' }, // table tokens live in URLs: never leak them via Referer
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code });
    if (err instanceof PosError) return reply.code(err.code === 'POS_UNREACHABLE' ? 502 : 422).send({ error: err.code });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED', fields: err.issues.map((i) => i.path.join('.')) });
    }
    if (err.statusCode === 429) return reply.code(429).send({ error: 'RATE_LIMITED' });
    if (err.code === '22P02') return reply.code(404).send({ error: 'NOT_FOUND' }); // malformed uuid
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'BAD_REQUEST' });
    req.log.error({ err }, 'unhandled');
    return reply.code(500).send({ error: 'INTERNAL_ERROR' }); // never leak internals
  });

  await app.register(fstatic, { root: path.join(root, 'public'), prefix: '/', index: false, wildcard: false });
  await app.register(fstatic, { root: path.join(root, 'shared'), prefix: '/shared/', decorateReply: false });

  const spa = (file) => (req, reply) => reply.header('cache-control', 'no-store').sendFile(file);
  app.get('/', spa('home.html'));
  app.get('/t/:token', spa('index.html'));
  app.get('/pay/return', spa('index.html'));
  app.get('/admin', spa('admin.html'));
  app.get('/healthz', async () => ({ ok: true }));

  await app.register(publicRoutes, { ctx });
  await app.register(webhookRoutes, { ctx });
  await app.register(adminRoutes, { ctx });
  await app.register(posRoutes, { ctx });
  await app.register(oauthCallbackRoutes, { ctx });
  if (config.PAYMENT_PROVIDER === 'sandbox') await app.register(sandboxRoutes, { ctx });

  const timer = setInterval(() => expireStalePayments(pool).catch((e) => app.log.error(e)), 60_000);
  timer.unref();
  const wb = setInterval(() => processWritebacks(ctx).catch((e) => app.log.error(e)), 15_000);
  wb.unref();
  app.addHook('onClose', async () => { clearInterval(timer); clearInterval(wb); });

  return app;
}
