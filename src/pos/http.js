// Outbound HTTP for POS connectors.
// - HTTPS only, short timeouts, bounded response size.
// - SSRF guard: hosts that restaurants type in (e.g. a Simphony host) must resolve to
//   public IP addresses, so nobody can point us at internal services or cloud metadata.
import dns from 'node:dns/promises';
import net from 'node:net';

export class PosError extends Error {
  constructor(code, message, { retryable = false, status } = {}) {
    super(message || code);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
    v.startsWith('::ffff:') && isPrivateIp(v.slice(7));
}

export async function assertPublicHttpsUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new PosError('INVALID_URL');
  }
  if (allowPrivate) return u;
  if (u.protocol !== 'https:' || u.username || u.password) throw new PosError('URL_MUST_BE_HTTPS');
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new PosError('URL_NOT_ALLOWED');
  return u;
}

const MAX_BYTES = 2 * 1024 * 1024;

/** JSON request with timeout. Throws PosError; 5xx/429/network errors are retryable. */
export async function posFetch(url, { method = 'GET', headers = {}, body, form, timeoutMs = 6000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      redirect: 'error', // never follow redirects to other hosts
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
    });
  } catch (e) {
    throw new PosError('POS_UNREACHABLE', e.name === 'AbortError' ? 'timeout' : 'network error', { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new PosError('POS_RESPONSE_TOO_LARGE');
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new PosError('POS_BAD_RESPONSE', `HTTP ${res.status}`, { retryable: res.status >= 500 });
  }
  if (res.status === 401 || res.status === 403) throw new PosError('POS_AUTH_FAILED', `HTTP ${res.status}`, { status: res.status });
  if (!res.ok) {
    throw new PosError('POS_HTTP_ERROR', `HTTP ${res.status}`, { retryable: res.status >= 500 || res.status === 429, status: res.status });
  }
  return json;
}

/** Major-unit decimal (number or string) -> integer minor units, without float drift. */
export function toMinor(value, decimals) {
  const s = typeof value === 'number' ? value.toFixed(decimals) : String(value ?? '0');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new PosError('POS_BAD_AMOUNT');
  const neg = s.startsWith('-');
  const [w, f = ''] = s.replace('-', '').split('.');
  const frac = f.padEnd(decimals + 1, '0');
  let n = Number(w) * 10 ** decimals + Number(frac.slice(0, decimals));
  if (Number(frac[decimals]) >= 5) n += 1; // half-up on the next digit
  return neg ? -n : n;
}

export const toMajor = (minor, decimals) => Number((minor / 10 ** decimals).toFixed(decimals));
