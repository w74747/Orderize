// Oracle Simphony — Transaction Services Gen2 (STS Gen2) REST API.
// https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/
// - Reads the open check for a table:   GET  /api/v1/checks?tableName=...
// - Records the payment on the check:   POST /api/v1/checks/{checkRef}/round  (tender)
// Auth: Oracle OpenID provider. The restaurant's admin creates an STS API account once and
// pastes its client id + refresh token here; we only keep the refresh token (encrypted) and
// rotate short-lived id_tokens. The API account password is never stored.
// Verify request bodies against your STS Gen2 version in Oracle's lab before going live.
import { PosError, assertPublicHttpsUrl, posFetch, toMajor, toMinor } from '../http.js';

export function simphonyConnector(platform) {
  const allowPrivate = platform.ALLOW_PRIVATE_POS_HOSTS === 'true';

  async function base(conn) {
    const u = await assertPublicHttpsUrl(conn.config.host, { allowPrivate });
    return u.origin;
  }

  async function idToken(conn) {
    const s = conn.secrets ?? {};
    if (!s.client_id || !s.refresh_token) throw new PosError('POS_NOT_CONNECTED');
    if (s.id_token && s.expires_at && Date.now() < s.expires_at - 60_000) return s.id_token;
    const t = await posFetch(`${await base(conn)}/oidc-provider/v1/oauth2/token`, {
      method: 'POST',
      form: { grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id, redirect_uri: 'apiaccount://callback' },
    });
    if (!t.id_token) throw new PosError('POS_AUTH_FAILED');
    await conn.saveSecrets({
      ...s,
      id_token: t.id_token,
      refresh_token: t.refresh_token ?? s.refresh_token, // Oracle rotates refresh tokens
      expires_at: Date.now() + Number(t.expires_in ?? 900) * 1000,
    });
    return t.id_token;
  }

  async function call(conn, path, opts = {}) {
    const c = conn.config;
    return posFetch(`${await base(conn)}/api/v1${path}`, {
      ...opts,
      headers: {
        authorization: `Bearer ${await idToken(conn)}`,
        'Simphony-OrgShortName': c.org,
        'Simphony-LocRef': c.loc,
        'Simphony-RvcRef': String(c.rvc),
        ...(opts.headers ?? {}),
      },
    });
  }

  async function openCheck(conn, table) {
    const name = table.external_name || table.label;
    const r = await call(conn, `/checks?tableName=${encodeURIComponent(name)}`);
    const open = (r.items ?? []).filter((ch) => (ch.header?.status ?? 'open') === 'open');
    if (open.length > 1) throw new PosError('POS_MULTIPLE_CHECKS', 'more than one open check on this table');
    return open[0] ?? null;
  }

  return {
    name: 'simphony',
    label: 'Oracle Simphony',
    capabilities: { oauth: false, liveBill: true, writeBack: true, listTables: false },
    isConfigured: () => true,

    validateConfig(c) {
      for (const k of ['host', 'org', 'loc', 'rvc', 'tender_id', 'employee_ref']) {
        if (!c[k] && c[k] !== 0) throw new PosError('POS_CONFIG_MISSING', k);
      }
    },

    async fetchOpenBill(conn, table, { decimals }) {
      const ch = await openCheck(conn, table);
      if (!ch) return null;
      const t = ch.totals ?? {};
      const paid = toMinor(t.paymentTotal ?? 0, decimals);
      const total = toMinor(t.totalDue ?? 0, decimals) + paid; // whole check, before payments
      const items = (ch.menuItems ?? [])
        .filter((m) => Number(m.quantity ?? 1) > 0)
        .map((m) => {
          const qty = Math.max(1, Math.round(Number(m.quantity ?? 1)));
          const line = toMinor(m.total ?? Number(m.unitPrice ?? 0) * qty, decimals);
          const name = String(m.name ?? 'Item').slice(0, 120);
          return { name_en: name, name_ar: name, unit_price_minor: Math.max(0, Math.round(line / qty)), qty };
        });
      return {
        external_ref: `simphony:${ch.header.checkRef}`,
        total_minor: total,
        vat_minor: toMinor(t.taxTotal ?? 0, decimals),
        paid_minor: paid,
        items,
      };
    },

    async postPayment(conn, { bill, payment, decimals }) {
      const checkRef = bill.external_ref.replace(/^simphony:/, '');
      const c = conn.config;
      const r = await call(conn, `/checks/${encodeURIComponent(checkRef)}/round`, {
        method: 'POST',
        body: {
          header: {
            orgShortName: c.org, locRef: c.loc, rvcRef: Number(c.rvc),
            checkEmployeeRef: Number(c.employee_ref),
            idempotencyId: payment.id.replace(/-/g, ''), // STS duplicate-request detection
          },
          tenders: [{
            tenderId: Number(c.tender_id),
            total: toMajor(payment.share_minor, decimals),
            chargedTipTotal: toMajor(payment.tip_minor, decimals),
            referenceText: `Sufra ${payment.id.slice(0, 8)}`,
          }],
        },
      });
      return { external_ref: r.header?.checkRef ?? checkRef };
    },

    async test(conn) {
      await call(conn, '/checks');
      return { ok: true };
    },
  };
}
