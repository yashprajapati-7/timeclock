// Payslip email through Brevo's HTTPS API (Railway Hobby blocks outbound SMTP). Built-in fetch; no dependency.
// Env: BREVO_API_KEY, MAIL_FROM (verified sender), optional MAIL_FROM_NAME, MAIL_REPLY_TO. The key never leaves this module.
import { HttpError } from './errors.js';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class MailError extends Error {
  constructor(message){ super(message); this.name = 'MailError'; }
}

export function createMailer(env = process.env, { fetch: fetchImpl = globalThis.fetch } = {}){
  const key = env.BREVO_API_KEY, from = env.MAIL_FROM;
  const configured = !!(key && from);
  return {
    configured, from: from || null,
    async send({ to, toName, subject, text, attachments = [] }){
      if(!configured) throw new HttpError(503, 'Email is not set up: set BREVO_API_KEY and MAIL_FROM on the server');
      const body = {
        sender: { email: from, ...(env.MAIL_FROM_NAME ? { name: env.MAIL_FROM_NAME.slice(0, 70) } : {}) },
        to: [{ email: to, ...(toName ? { name: String(toName).slice(0, 70) } : {}) }],
        subject,
        textContent: text,
        htmlContent: `<div style="font-family:sans-serif;white-space:pre-wrap">${escHtml(text)}</div>`,
        ...(env.MAIL_REPLY_TO ? { replyTo: { email: env.MAIL_REPLY_TO } } : {}),
        ...(attachments.length ? { attachment: attachments.map(a => ({ name: a.name, content: Buffer.from(a.content).toString('base64') })) } : {}),
      };
      let res;
      try{
        res = await fetchImpl(BREVO_URL, {
          method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
          headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
        });
      }catch(e){
        throw new MailError(e?.name === 'TimeoutError' ? 'Email service timed out' : 'Could not reach the email service');
      }
      const raw = await res.text();
      let json = null;
      try{ json = JSON.parse(raw); }catch{ /* non-JSON gateway error */ }
      if(res.status !== 201) throw new MailError(json?.message || `Email service error (HTTP ${res.status})`);
      return { messageId: json?.messageId ?? null };
    },
  };
}
