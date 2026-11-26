// Shared, side-effect-free billing math. Used by the server (authoritative)
// and by the browser (display only — the server always recomputes).
// All amounts are INTEGER minor units (fils / halalas / baisa). Never floats.

export const CURRENCIES = {
  AED: { decimals: 2, ar: 'د.إ', en: 'AED' },
  SAR: { decimals: 2, ar: 'ر.س', en: 'SAR' },
  QAR: { decimals: 2, ar: 'ر.ق', en: 'QAR' },
  KWD: { decimals: 3, ar: 'د.ك', en: 'KWD' },
  BHD: { decimals: 3, ar: 'د.ب', en: 'BHD' },
  OMR: { decimals: 3, ar: 'ر.ع', en: 'OMR' },
};

export class BillingError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const isInt = (n) => Number.isSafeInteger(n);
const roundHalfUp = (x) => Math.floor(x + 0.5);

export function assertCurrency(c) {
  if (!CURRENCIES[c]) throw new BillingError('UNSUPPORTED_CURRENCY');
  return CURRENCIES[c];
}

export function formatMoney(minor, currency, lang = 'en') {
  const { decimals, ar, en } = assertCurrency(currency);
  const value = (minor / 10 ** decimals).toLocaleString('en-US', { // Latin digits: standard on GCC receipts
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return lang === 'ar' ? `${value} ${ar}` : `${en} ${value}`;
}

/** Parse a user-typed decimal string ("12.5") into minor units without float error. */
export function parseMajor(str, currency) {
  const { decimals } = assertCurrency(currency);
  const s = String(str).trim();
  const re = new RegExp(`^\\d{1,7}(\\.\\d{1,${decimals}})?$`);
  if (!re.test(s)) throw new BillingError('INVALID_AMOUNT');
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 10 ** decimals + Number(frac.padEnd(decimals, '0'));
}

/**
 * bill: { currency, total_minor, settled_minor (captured + live reservations),
 *         items: [{ id, unit_price_minor, qty, settled_qty }] }
 */
export function remainingOf(bill) {
  return Math.max(0, bill.total_minor - bill.settled_minor);
}

/** Returns { share_minor, items?: [{id, qty}] } for a split selection. */
export function computeShare(bill, sel) {
  const remaining = remainingOf(bill);
  if (remaining <= 0) throw new BillingError('BILL_ALREADY_PAID');

  switch (sel?.mode) {
    case 'full':
      return { share_minor: remaining };

    case 'equal': {
      const { parts, pay } = sel;
      if (!isInt(parts) || !isInt(pay) || parts < 2 || parts > 30 || pay < 1 || pay > parts) {
        throw new BillingError('INVALID_SPLIT');
      }
      const share = roundHalfUp((bill.total_minor * pay) / parts);
      // Last payer(s) absorb rounding: never exceed what's left.
      return { share_minor: Math.min(share, remaining) };
    }

    case 'items': {
      if (!Array.isArray(sel.items) || sel.items.length === 0 || sel.items.length > 200) {
        throw new BillingError('INVALID_SPLIT');
      }
      const byId = new Map(bill.items.map((i) => [String(i.id), i]));
      const itemsSubtotal = bill.items.reduce((s, i) => s + i.unit_price_minor * i.qty, 0);
      const seen = new Set();
      let picked = 0;
      for (const { id, qty } of sel.items) {
        const item = byId.get(String(id));
        if (!item || seen.has(String(id))) throw new BillingError('INVALID_ITEM');
        seen.add(String(id));
        if (!isInt(qty) || qty < 1 || qty > item.qty - (item.settled_qty || 0)) {
          throw new BillingError('ITEM_UNAVAILABLE');
        }
        picked += item.unit_price_minor * qty;
      }
      if (itemsSubtotal <= 0) throw new BillingError('INVALID_SPLIT');
      // Spread bill-level taxes/charges proportionally across the chosen items.
      const share = roundHalfUp((picked * bill.total_minor) / itemsSubtotal);
      return {
        share_minor: Math.min(share, remaining),
        items: sel.items.map(({ id, qty }) => ({ id: String(id), qty })),
      };
    }

    case 'custom': {
      const amt = sel.amount_minor;
      if (!isInt(amt) || amt < 1) throw new BillingError('INVALID_AMOUNT');
      if (amt > remaining) throw new BillingError('AMOUNT_EXCEEDS_REMAINING');
      return { share_minor: amt };
    }

    default:
      throw new BillingError('INVALID_SPLIT');
  }
}

/** tip: { type: 'none' } | { type: 'percent', value } | { type: 'amount', amount_minor } */
export function computeTip(share, tip, policy) {
  if (!tip || tip.type === 'none') return 0;
  if (tip.type === 'percent') {
    if (!policy.tip_percents.includes(tip.value)) throw new BillingError('INVALID_TIP');
    return roundHalfUp((share * tip.value) / 100);
  }
  if (tip.type === 'amount') {
    const a = tip.amount_minor;
    if (!isInt(a) || a < 0) throw new BillingError('INVALID_TIP');
    // Guard against fat-finger tips (e.g. 1000 instead of 10.00).
    const cap = Math.max(roundHalfUp((share * policy.max_tip_percent) / 100), 0);
    if (a > cap) throw new BillingError('TIP_TOO_HIGH');
    return a;
  }
  throw new BillingError('INVALID_TIP');
}

/** offer: { kind: 'percent'|'fixed', value, max_minor?, min_spend_minor? } */
export function computeDiscount(share, offer) {
  if (!offer) return 0;
  if (offer.min_spend_minor && share < offer.min_spend_minor) {
    throw new BillingError('OFFER_MIN_SPEND');
  }
  let d = offer.kind === 'percent' ? roundHalfUp((share * offer.value) / 100) : offer.value;
  if (offer.max_minor) d = Math.min(d, offer.max_minor);
  return Math.max(0, Math.min(d, share - 1)); // diner always pays something
}

export function computeFee(netShare, policy) {
  const fee = roundHalfUp((netShare * policy.fee_bps) / 10000) + (policy.fee_fixed_minor || 0);
  return policy.fee_cap_minor ? Math.min(fee, policy.fee_cap_minor) : fee;
}

/** Full quote. Pure function: same inputs => same outputs on client and server. */
export function quote(bill, req, policy, offer) {
  const { share_minor, items } = computeShare(bill, req.split);
  const tip_minor = computeTip(share_minor, req.tip, policy);
  const discount_minor = computeDiscount(share_minor, offer);
  const fee_minor = computeFee(share_minor - discount_minor, policy);
  const total_minor = share_minor - discount_minor + fee_minor + tip_minor;
  return { currency: bill.currency, share_minor, discount_minor, fee_minor, tip_minor, total_minor, items };
}
