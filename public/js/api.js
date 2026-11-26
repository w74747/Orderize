// Real API client. (The demo build swaps this module for api.demo.js.)
async function req(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || 'DEFAULT');
    e.code = data.error || 'DEFAULT';
    e.status = res.status;
    throw e;
  }
  return data;
}

export const api = {
  demo: false,
  getTable: (token) => req('GET', `/api/t/${encodeURIComponent(token)}`),
  quote: (token, body) => req('POST', `/api/t/${encodeURIComponent(token)}/quote`, body),
  pay: (token, body, idemKey) =>
    req('POST', `/api/t/${encodeURIComponent(token)}/payments`, body, { 'idempotency-key': idemKey }),
  payment: (id) => req('GET', `/api/payments/${encodeURIComponent(id)}`),
  otpRequest: (country, phone) => req('POST', '/api/me/otp', { country, phone }),
  otpVerify: (challenge_id, code) => req('POST', '/api/me/otp/verify', { challenge_id, code }),
  saveProfile: (p) => req('PUT', '/api/me/profile', p),
  me: () => req('GET', '/api/me'),
  logout: () => req('POST', '/api/me/logout', {}),
  deleteMe: () => req('DELETE', '/api/me'),
  orders: (token) => req('GET', `/api/t/${encodeURIComponent(token)}/orders`),
  placeOrder: (token, body) => req('POST', `/api/t/${encodeURIComponent(token)}/orders`, body),
  callWaiter: (token, kind) => req('POST', `/api/t/${encodeURIComponent(token)}/call`, { kind }),
  bannerClick: (token, id) => req('POST', `/api/t/${encodeURIComponent(token)}/banners/${encodeURIComponent(id)}/click`, {}),
  bannersSeen: (token, ids) => req('POST', `/api/t/${encodeURIComponent(token)}/banners/seen`, { ids }),
  rate: (id, stars, comment) => req('POST', `/api/payments/${encodeURIComponent(id)}/rating`, { stars, ...(comment ? { comment } : {}) }),
  /** Only follow redirects to https or our own origin (defence against open redirects). */
  go(url) {
    const u = new URL(url, location.href);
    if (u.origin === location.origin || u.protocol === 'https:') location.assign(u.href);
    else throw new Error('Blocked redirect');
  },
};
