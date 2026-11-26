import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time compare of two strings (hex/base64). */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---- Passwords: scrypt (memory-hard), N=2^15, r=8, p=1, 64-byte key, per-user salt.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, got);
}

// A real hash to burn equal time when the user doesn't exist (no user enumeration by timing).
export const DUMMY_HASH = await hashPassword(randomToken(16));

// ---- Field encryption (AES-256-GCM) for secrets at rest (TOTP seeds, POS secrets).
export function makeCipher(appSecret) {
  // Key-derivation label kept from the project's first name on purpose:
  // changing it would make every secret already stored in the database unreadable.
  const key = crypto.hkdfSync('sha256', Buffer.from(appSecret), Buffer.alloc(0), 'sufra-field-enc-v1', 32);
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), ct.toString('base64'), c.getAuthTag().toString('base64')].join('.');
    },
    decrypt(blob) {
      const [v, iv, ct, tag] = String(blob).split('.');
      if (v !== 'v1') throw new Error('bad ciphertext');
      const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    },
  };
}

// ---- TOTP (RFC 6238, SHA-1, 30s, 6 digits) — compatible with Google Authenticator etc.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('bad base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secretB32, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** Returns the matched time-step (for replay protection) or null. Allows ±1 step of clock drift. */
export function verifyTotp(secretB32, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (safeEqual(totpAt(secretB32, s), String(code))) return s;
  }
  return null;
}
