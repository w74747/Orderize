import { z } from 'zod';

const minor = z.number().int().min(0).max(100_000_000);
const uuid = z.uuid();

export const split = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('full') }),
  z.strictObject({ mode: z.literal('equal'), parts: z.number().int().min(2).max(30), pay: z.number().int().min(1).max(30) }),
  z.strictObject({
    mode: z.literal('items'),
    items: z.array(z.strictObject({ id: uuid, qty: z.number().int().min(1).max(999) })).min(1).max(200),
  }),
  z.strictObject({ mode: z.literal('custom'), amount_minor: minor.min(1) }),
]);

export const tip = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  z.strictObject({ type: z.literal('percent'), value: z.number().int().min(0).max(100) }),
  z.strictObject({ type: z.literal('amount'), amount_minor: minor }),
]);

export const payRequest = z.strictObject({
  split,
  tip: tip.default({ type: 'none' }),
  offer_id: uuid.optional(),
  promo_code: z.string().regex(/^[A-Za-z0-9-]{3,32}$/).optional(),
  marketing_consent: z.boolean().optional(),
});

export const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

const text = (max) => z.string().trim().min(1).max(max);

export const login = z.strictObject({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

export const billItems = z
  .array(z.strictObject({ name_en: text(120), name_ar: text(120), unit_price_minor: minor, qty: z.number().int().min(1).max(999) }))
  .min(1)
  .max(200);

export const createBill = z.strictObject({
  table_id: uuid,
  items: billItems,
  vat_minor: minor.default(0),
  external_ref: text(64).optional(),
});

export const posBill = z.strictObject({
  table_label: text(40),
  external_ref: text(64),
  items: billItems,
  vat_minor: minor.default(0),
});

export const createTable = z.strictObject({ label: text(40) });

export const createPromo = z.strictObject({
  promo_code: z.string().regex(/^[A-Za-z0-9-]{3,32}$/),
  kind: z.enum(['percent', 'fixed']),
  value: z.number().int().min(1).max(100_000_000),
  max_minor: minor.optional(),
  min_spend_minor: minor.optional(),
  title_en: text(80),
  title_ar: text(80),
  max_redemptions: z.number().int().min(1).max(1_000_000).optional(),
  ends_at: z.iso.datetime().optional(),
});

export const newPassword = z
  .string()
  .min(12)
  .max(200)
  .refine((p) => /[a-z]/i.test(p) && /\d/.test(p), 'password must contain letters and digits');
