// WhatsApp Cloud API (Meta). OTPs use an approved AUTHENTICATION template with a
// copy-code button (the code goes in the body AND the button parameter).
// Without WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID the module runs in "log" mode:
// nothing is sent (used for development and the demo).
import { sha256 } from './crypto.js';

export function createWhatsApp(config, pool, log) {
  const live = Boolean(config.WHATSAPP_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID);
  const url = `https://graph.facebook.com/${config.WHATSAPP_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  async function record(phone, template, status, error) {
    await pool.query('INSERT INTO whatsapp_log(phone_hash, template, status, error) VALUES ($1,$2,$3,$4)', [
      sha256(`wa:${phone}`), template, status, error ? String(error).slice(0, 200) : null,
    ]).catch(() => {});
  }

  async function send(phone, template, lang, components) {
    if (!live) {
      await record(phone, template, 'skipped_no_credentials');
      return { sent: false };
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${config.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone.replace('+', ''),
          type: 'template',
          template: { name: template, language: { code: lang }, components },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await record(phone, template, 'sent');
      return { sent: true };
    } catch (e) {
      log.warn({ template, err: e.message }, 'whatsapp send failed');
      await record(phone, template, 'failed', e.message);
      return { sent: false, error: true };
    } finally {
      clearTimeout(t);
    }
  }

  return {
    live,
    sendOtp(phone, code, lang = config.WHATSAPP_OTP_LANG) {
      return send(phone, config.WHATSAPP_OTP_TEMPLATE, lang, [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ]);
    },
    /** Marketing message (coupon). Only call for customers who opted in. */
    sendCoupon(phone, { restaurant, title }) {
      if (!config.WHATSAPP_COUPON_TEMPLATE) return { sent: false };
      return send(phone, config.WHATSAPP_COUPON_TEMPLATE, config.WHATSAPP_OTP_LANG, [
        { type: 'body', parameters: [{ type: 'text', text: restaurant }, { type: 'text', text: title }] },
      ]);
    },
  };
}
