// Machine translation between Arabic and English for menu names/descriptions.
// Providers: DeepL (DEEPL_API_KEY; free keys end with ":fx") or Google Cloud Translation
// (GOOGLE_TRANSLATE_API_KEY). Hosts are fixed — no user-controlled URLs.

const DAILY_CHAR_LIMIT = 60_000; // per restaurant, protects the platform's translation bill

export function createTranslator(config, log) {
  const deepl = config.DEEPL_API_KEY;
  const google = config.GOOGLE_TRANSLATE_API_KEY;
  const provider = deepl ? 'deepl' : google ? 'google' : null;

  async function call(texts, from, to) {
    const ctl = AbortSignal.timeout(8000);
    if (provider === 'deepl') {
      const host = deepl.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
      const res = await fetch(`https://${host}/v2/translate`, {
        method: 'POST', signal: ctl,
        headers: { authorization: `DeepL-Auth-Key ${deepl}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: texts, source_lang: from.toUpperCase(), target_lang: to === 'en' ? 'EN-GB' : 'AR' }),
      });
      if (!res.ok) throw new Error(`deepl ${res.status}`);
      return (await res.json()).translations.map((t) => t.text);
    }
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(google)}`, {
      method: 'POST', signal: ctl, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: texts, source: from, target: to, format: 'text' }),
    });
    if (!res.ok) throw new Error(`google ${res.status}`);
    return (await res.json()).data.translations.map((t) => t.translatedText);
  }

  return {
    get enabled() { return Boolean(provider); },
    provider,
    /**
     * Translates texts (all same direction). Returns null when unavailable or over quota.
     * `quota(db, restaurantId, chars)` reserves characters atomically for the day.
     */
    async translate(pool, restaurantId, texts, from, to) {
      if (!provider || !texts.length) return null;
      const chars = texts.reduce((s, t) => s + t.length, 0);
      const { rowCount } = await pool.query(
        `UPDATE restaurants SET
            translate_chars_used = CASE WHEN translate_chars_day = current_date THEN translate_chars_used ELSE 0 END + $2,
            translate_chars_day = current_date
          WHERE id = $1
            AND (CASE WHEN translate_chars_day = current_date THEN translate_chars_used ELSE 0 END) + $2 <= $3`,
        [restaurantId, chars, DAILY_CHAR_LIMIT],
      );
      if (!rowCount) return null;
      try {
        const out = await call(texts, from, to);
        return out.map((s) => String(s ?? '').trim().slice(0, 300));
      } catch (e) {
        log.warn({ err: e.message }, 'translation failed');
        return null;
      }
    },
  };
}

/**
 * Fills the empty side of each AR/EN pair by translation.
 * Returns { values, auto } where auto lists the fields that were machine-filled.
 */
export async function fillTranslations(translator, pool, restaurantId, values, pairs) {
  const out = { ...values };
  const auto = [];
  for (const dir of [['ar', 'en'], ['en', 'ar']]) {
    const [from, to] = dir;
    const todo = pairs.filter((p) => out[`${p}_${from}`] && !out[`${p}_${to}`]);
    if (!todo.length) continue;
    const res = await translator.translate(pool, restaurantId, todo.map((p) => out[`${p}_${from}`]), from, to);
    todo.forEach((p, i) => {
      if (res?.[i]) { out[`${p}_${to}`] = res[i]; auto.push(`${p}_${to}`); }
    });
  }
  return { values: out, auto };
}
