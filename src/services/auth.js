import { DUMMY_HASH, randomToken, sha256, verifyPassword, verifyTotp } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { HttpError } from './bills.js';

const MAX_FAILS = 5;
const LOCK_MIN = 15;
const SESSION_HOURS = 12;
const IDLE_MIN = 30;

export const ROLE_RANK = { staff: 1, manager: 2, owner: 3, platform_admin: 4 };

export async function login({ pool, cipher }, { email, password, totp, ip, ua }) {
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  const u = rows[0];
  // Always run the password hash, even for unknown users (prevents timing-based enumeration).
  const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
  if (!u) throw new HttpError(401, 'INVALID_CREDENTIALS');

  if (u.locked_until && u.locked_until > new Date()) {
    await audit(pool, { actorType: 'user', actorId: u.id, restaurantId: u.restaurant_id, action: 'login.locked', ip });
    throw new HttpError(401, 'INVALID_CREDENTIALS');
  }
  if (!ok) {
    await pool.query(
      `UPDATE users SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) END
        WHERE id = $1`,
      [u.id, MAX_FAILS, LOCK_MIN],
    );
    await audit(pool, { actorType: 'user', actorId: u.id, restaurantId: u.restaurant_id, action: 'login.failed', ip });
    throw new HttpError(401, 'INVALID_CREDENTIALS');
  }

  let mfa = false;
  if (u.totp_enabled) {
    if (!totp) throw new HttpError(401, 'TOTP_REQUIRED');
    const step = verifyTotp(cipher.decrypt(u.totp_secret_enc), totp);
    // Reject codes from the same or an earlier time-step (replay protection).
    if (step === null || (u.totp_last_step !== null && step <= u.totp_last_step)) {
      await pool.query('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = $1', [u.id]);
      throw new HttpError(401, 'INVALID_CREDENTIALS');
    }
    await pool.query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [u.id, step]);
    mfa = true;
  }

  await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
  const token = randomToken(32);
  await pool.query(
    `INSERT INTO sessions(id_hash, user_id, mfa_passed, expires_at, ip, user_agent)
     VALUES ($1,$2,$3, now() + make_interval(hours => $4), $5, $6)`,
    [sha256(token), u.id, mfa, SESSION_HOURS, ip, String(ua ?? '').slice(0, 200)],
  );
  await audit(pool, { actorType: 'user', actorId: u.id, restaurantId: u.restaurant_id, action: 'login.success', ip });
  return { token, user: publicUser(u) };
}

export function publicUser(u) {
  return { id: u.id, email: u.email, role: u.role, restaurant_id: u.restaurant_id, totp_enabled: u.totp_enabled };
}

export async function sessionUser(pool, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const { rows } = await pool.query(
    `UPDATE sessions s SET last_seen = now()
       FROM users u
      WHERE s.id_hash = $1 AND u.id = s.user_id AND s.expires_at > now()
        AND s.last_seen > now() - make_interval(mins => $2)
      RETURNING u.*, s.mfa_passed, s.id_hash`,
    [sha256(token), IDLE_MIN],
  );
  return rows[0] ?? null;
}

export async function logout(pool, token) {
  if (token) await pool.query('DELETE FROM sessions WHERE id_hash = $1', [sha256(token)]);
}
