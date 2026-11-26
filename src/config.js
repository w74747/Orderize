import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().min(1),
    PUBLIC_BASE_URL: z.url(),
    // 32+ random bytes, base64. Used to sign sandbox webhooks & derive keys.
    APP_SECRET: z.string().min(43, 'APP_SECRET must be >= 32 random bytes (base64)'),
    PAYMENT_PROVIDER: z.enum(['sandbox', 'tap', 'checkout']).default('sandbox'),
    TAP_SECRET_KEY: z.string().optional(),
    TAP_WEBHOOK_SECRET: z.string().optional(),
    CHECKOUT_SECRET_KEY: z.string().optional(),
    CHECKOUT_WEBHOOK_SECRET: z.string().optional(),
    CHECKOUT_PROCESSING_CHANNEL_ID: z.string().optional(),
    COOKIE_SECURE: bool.default(true),
    REQUIRE_2FA: bool.default(false),
    TRUST_PROXY: bool.default(true),
    // POS integrations (platform-level app credentials; per-restaurant tokens live encrypted in the DB)
    FOODICS_CLIENT_ID: z.string().optional(),
    FOODICS_CLIENT_SECRET: z.string().optional(),
    FOODICS_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
    FOODICS_API_BASE: z.string().optional(),      // tests only
    FOODICS_CONSOLE_BASE: z.string().optional(),  // tests only
    ALLOW_PRIVATE_POS_HOSTS: z.enum(['true', 'false']).default('false'), // tests only
    // WhatsApp Cloud API (diner sign-in codes, coupon notifications)
    WHATSAPP_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
    WHATSAPP_OTP_TEMPLATE: z.string().default('orderize_otp'),
    WHATSAPP_OTP_LANG: z.string().default('ar'),
    WHATSAPP_COUPON_TEMPLATE: z.string().optional(),
    // DEMO ONLY: return the sign-in code in the API response when WhatsApp isn't configured.
    OTP_DEV_ECHO: bool.default(false),
    // First platform administrator, created at boot if none exists.
    PLATFORM_ADMIN_EMAIL: z.email().optional(),
    PLATFORM_ADMIN_PASSWORD: z.string().min(12).optional(),
    PLATFORM_REQUIRE_2FA: bool.default(true),
    RESERVATION_TTL_MIN: z.coerce.number().int().min(5).max(60).default(15),
    LOG_LEVEL: z.string().default('info'),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production') {
      if (c.PAYMENT_PROVIDER === 'sandbox' && process.env.ALLOW_SANDBOX_IN_PRODUCTION !== 'true') {
        ctx.addIssue({ code: 'custom', message: 'Sandbox payments are disabled in production' });
      }
      if (!c.COOKIE_SECURE) ctx.addIssue({ code: 'custom', message: 'COOKIE_SECURE must be true in production' });
      if (!c.PUBLIC_BASE_URL.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', message: 'PUBLIC_BASE_URL must be https in production' });
      }
    }
    if (c.NODE_ENV === 'production' && (c.ALLOW_PRIVATE_POS_HOSTS === 'true' || c.FOODICS_API_BASE)) {
      ctx.addIssue({ code: 'custom', message: 'POS test overrides are not allowed in production' });
    }
    if (c.NODE_ENV === 'production' && c.OTP_DEV_ECHO && process.env.ALLOW_SANDBOX_IN_PRODUCTION !== 'true') {
      ctx.addIssue({ code: 'custom', message: 'OTP_DEV_ECHO is a demo setting and is refused in real production' });
    }
    if (c.OTP_DEV_ECHO && c.WHATSAPP_TOKEN) {
      ctx.addIssue({ code: 'custom', message: 'OTP_DEV_ECHO must be off when WhatsApp is configured' });
    }
    if (c.PAYMENT_PROVIDER === 'tap' && (!c.TAP_SECRET_KEY || !c.TAP_WEBHOOK_SECRET)) {
      ctx.addIssue({ code: 'custom', message: 'TAP_SECRET_KEY and TAP_WEBHOOK_SECRET are required' });
    }
    if (c.PAYMENT_PROVIDER === 'checkout' && (!c.CHECKOUT_SECRET_KEY || !c.CHECKOUT_WEBHOOK_SECRET)) {
      ctx.addIssue({ code: 'custom', message: 'CHECKOUT_SECRET_KEY and CHECKOUT_WEBHOOK_SECRET are required' });
    }
  });

export function loadConfig(env = process.env) {
  const r = schema.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  return Object.freeze(r.data);
}
