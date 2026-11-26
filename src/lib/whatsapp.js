// WhatsApp Cloud API (Meta). OTPs use an approved AUTHENTICATION template with a
// copy-code button (the code goes in the body AND the button parameter).
// Without WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID the module runs in "log" mode:
// nothing is sent (used for development and the demo).
import { sha256 } from './crypto.js';

export function createWhatsApp(config, pool, log, waweb = null) {
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
    /** Official Cloud API configured, or (test only) a personal number linked by QR. */
    get live() { return live || Boolean(waweb?.connected); },
    async sendOtp(phone, code, lang = config.WHATSAPP_OTP_LANG) {
      if (!live && waweb?.connected) {
        try {
          await waweb.sendText(phone, `رمز الدخول إلى Orderize: ${code}\nYour Orderize sign-in code: ${code}\nلا تشاركه مع أحد · Do not share it.`);
          await record(phone, 'web_otp', 'sent');
          return { sent: true };
        } catch (e) {
          log.warn({ err: e.message }, 'whatsapp web send failed');
          await record(phone, 'web_otp', 'failed', e.message);
          return { sent: false, error: true };
        }
      }
      return send(phone, config.WHATSAPP_OTP_TEMPLATE, lang, [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ]);
    },
    /** Marketing message (coupon). Only call for customers who opted in. */
    sendCoupon(phone, { restaurant, title }) {
      // Never send marketing from a personal test number (fastest way to get it banned).
      if (!live || !config.WHATSAPP_COUPON_TEMPLATE) return { sent: false };
      return send(phone, config.WHATSAPP_COUPON_TEMPLATE, config.WHATSAPP_OTP_LANG, [
        { type: 'body', parameters: [{ type: 'text', text: restaurant }, { type: 'text', text: title }] },
      ]);
    },
  };
}
