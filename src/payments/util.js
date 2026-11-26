export class WebhookError extends Error {}

/** fetch with timeout; never logs secrets. */
export async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(`provider HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}
