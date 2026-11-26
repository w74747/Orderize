// Phone normalization to E.164. GCC numbers are validated strictly (mobile ranges);
// other countries only by length, so visitors from abroad can still sign in.
const GCC = {
  '971': /^5\d{8}$/,          // UAE
  '966': /^5\d{8}$/,          // Saudi Arabia
  '974': /^[3567]\d{7}$/,     // Qatar
  '965': /^[569]\d{7}$/,      // Kuwait
  '973': /^[36]\d{7}$/,       // Bahrain
  '968': /^[79]\d{7}$/,       // Oman
};

export function normalizePhone(country, local) {
  const cc = String(country ?? '').replace(/\D/g, '');
  let n = String(local ?? '').replace(/[\s\-()]/g, '');
  if (!/^\d{1,4}$/.test(cc) || !/^\+?\d{6,15}$/.test(n)) return null;
  n = n.replace(/^\+/, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith(cc) && n.length > 9) n = n.slice(cc.length); // pasted with country code
  n = n.replace(/^0+/, '');                                      // national trunk prefix
  if (GCC[cc]) return GCC[cc].test(n) ? `+${cc}${n}` : null;
  const full = `+${cc}${n}`;
  return /^\+[1-9]\d{7,14}$/.test(full) ? full : null;
}

export const maskPhone = (e164) => (e164 ? `${e164.slice(0, 4)}•••${e164.slice(-3)}` : '—');
