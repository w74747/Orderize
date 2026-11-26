// Foodics (https://apidocs.foodics.com) — API v5, OAuth 2.0 authorization-code flow.
// Reads the table's active order live. Foodics' public flow for pay-at-table partners is that
// the cashier records the payment, so write-back is "manual" (staff confirm in the dashboard).
// Endpoint paths and field names follow Foodics v5 conventions — verify against the current
// docs in Foodics' sandbox before going live (see INTEGRATIONS.md).
import { PosError, posFetch, toMinor } from '../http.js';

const ACTIVE = 2; // Foodics order status: 1 pending, 2 active, 3 void, 4 done

export function foodicsConnector(platform) {
  const sandbox = platform.FOODICS_ENV !== 'production';
  const api = platform.FOODICS_API_BASE || (sandbox ? 'https://api-sandbox.foodics.com' : 'https://api.foodics.com');
  const consoleBase = platform.FOODICS_CONSOLE_BASE || (sandbox ? 'https://console-sandbox.foodics.com' : 'https://console.foodics.com');

  async function token(conn) {
    const s = conn.secrets;
    if (!s?.access_token) throw new PosError('POS_NOT_CONNECTED');
    if (s.expires_at && Date.now() > s.expires_at - 60_000 && s.refresh_token) {
      const t = await posFetch(`${api}/oauth/token`, {
        method: 'POST',
        body: { grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: platform.FOODICS_CLIENT_ID, client_secret: platform.FOODICS_CLIENT_SECRET },
      });
      await conn.saveSecrets(normalizeToken(t, s));
      return t.access_token;
    }
    return s.access_token;
  }

  function normalizeToken(t, prev = {}) {
    if (!t.access_token) throw new PosError('POS_AUTH_FAILED');
    return {
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? prev.refresh_token ?? null,
      expires_at: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : null,
    };
  }

  async function get(conn, path) {
    return posFetch(`${api}/v5${path}`, { headers: { authorization: `Bearer ${await token(conn)}` } });
  }

  return {
    name: 'foodics',
    label: 'Foodics',
    capabilities: { oauth: true, liveBill: true, writeBack: false, listTables: true },

    isConfigured: () => Boolean(platform.FOODICS_CLIENT_ID && platform.FOODICS_CLIENT_SECRET),

    authorizeUrl({ state }) {
      const u = new URL('/authorize', consoleBase);
      u.searchParams.set('client_id', platform.FOODICS_CLIENT_ID);
      u.searchParams.set('state', state);
      return u.toString();
    },

    async exchangeCode({ code, redirectUri }) {
      const t = await posFetch(`${api}/oauth/token`, {
        method: 'POST',
        body: { grant_type: 'authorization_code', code, client_id: platform.FOODICS_CLIENT_ID, client_secret: platform.FOODICS_CLIENT_SECRET, redirect_uri: redirectUri },
      });
      return normalizeToken(t);
    },

    async listBranches(conn) {
      const r = await get(conn, '/branches');
      return (r.data ?? []).map((b) => ({ id: String(b.id), name: b.name, name_ar: b.name_localized ?? b.name }));
    },

    async listTables(conn) {
      if (!conn.config.branch_id) throw new PosError('POS_BRANCH_REQUIRED');
      const r = await get(conn, `/tables?filter[branch_id]=${encodeURIComponent(conn.config.branch_id)}&include=section`);
      return (r.data ?? []).map((t) => ({
        external_id: String(t.id),
        name: t.section?.name ? `${t.section.name} ${t.name}` : String(t.name),
      }));
    },

    async fetchOpenBill(conn, table, { decimals }) {
      if (!table.external_id) return null;
      const q = new URLSearchParams({
        'filter[status]': String(ACTIVE),
        'filter[table_id]': table.external_id,
        ...(conn.config.branch_id ? { 'filter[branch_id]': conn.config.branch_id } : {}),
        include: 'products.product,payments,table',
      });
      const r = await get(conn, `/orders?${q}`);
      // Defensive: re-check table + status locally even though we filtered server-side.
      const order = (r.data ?? []).find((o) => Number(o.status) === ACTIVE && String(o.table?.id ?? o.table_id) === table.external_id);
      if (!order) return null;
      const items = (order.products ?? [])
        .filter((p) => Number(p.quantity) > 0)
        .map((p) => {
          const qty = Math.max(1, Math.round(Number(p.quantity)));
          const line = toMinor(p.total_price ?? Number(p.unit_price) * qty, decimals);
          return {
            name_en: String(p.product?.name ?? 'Item').slice(0, 120),
            name_ar: String(p.product?.name_localized || p.product?.name || 'صنف').slice(0, 120),
            unit_price_minor: Math.max(0, Math.round(line / qty)),
            qty,
          };
        });
      const paid = (order.payments ?? []).reduce((s, p) => s + toMinor(p.amount ?? 0, decimals), 0);
      return {
        external_ref: `foodics:${order.id}`,
        total_minor: toMinor(order.total_price, decimals),
        vat_minor: toMinor(order.tax_exclusive_total ?? order.total_tax ?? 0, decimals) || 0,
        paid_minor: paid,
        items,
      };
    },

    async test(conn) {
      const branches = await this.listBranches(conn);
      return { ok: true, branches };
    },
  };
}
