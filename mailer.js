// Sends emails through Resend (resend.com). No packages needed.
// Set RESEND_API_KEY and MAIL_FROM (for example: Madifyx Clips <clips@madifyx.com>).
// For local testing without an email service, MAIL_DEV=1 prints emails to the console instead.
const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || '';
const DEV = process.env.MAIL_DEV === '1';

const ready = () => !!(KEY && FROM) || DEV;

async function sendMail({ to, subject, html, text }) {
  if (DEV && !KEY) {
    console.log(`\n[MAIL_DEV] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return { id: 'dev' };
  }
  if (!KEY || !FROM) throw new Error('Email sending is not set up');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || `Email service error ${r.status}`);
  return body;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Branded email with the code and a one-click button.
function verificationEmail({ appName, name, code, link, logoUrl }) {
  const text = `Hi ${name},

Your ${appName} verification code is: ${code}

Or confirm with one click: ${link}

The code works for 30 minutes. If you didn't try to create an account, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#07080D;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07080D;padding:40px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#0F111A;border:1px solid #1F2333;border-radius:20px;">
<tr><td style="padding:32px 32px 8px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${esc(logoUrl)}" width="36" height="36" alt="" style="display:block;border-radius:9px;"></td>
    <td style="padding-left:11px;color:#FFFFFF;font-weight:800;font-size:16px;letter-spacing:.02em;">MADIFYX<div style="color:#00C3FF;font-size:9px;letter-spacing:.32em;font-weight:600;margin-top:2px;">CLIPS</div></td>
  </tr></table>
</td></tr>
<tr><td style="padding:20px 32px 0;color:#F4F6FA;">
  <div style="font-size:22px;font-weight:800;letter-spacing:-.02em;">Confirm your email</div>
  <p style="color:#B4BBC8;font-size:15px;line-height:1.55;margin:10px 0 0;">Hi ${esc(name)}, enter this code to finish creating your ${esc(appName)} account.</p>
</td></tr>
<tr><td style="padding:22px 32px 6px;">
  <div style="background:#07080D;border:1px solid #1F2333;border-radius:14px;padding:18px;text-align:center;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:.35em;color:#FFFFFF;">${code}</div>
</td></tr>
<tr><td style="padding:16px 32px 6px;" align="center">
  <a href="${esc(link)}" style="display:inline-block;background:#00C3FF;color:#021018;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:12px;">Confirm my email</a>
</td></tr>
<tr><td style="padding:18px 32px 30px;color:#7D8597;font-size:13px;line-height:1.5;">The code works for 30 minutes. If you didn't try to create an account, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: `${code} is your ${appName} code`, html, text };
}

module.exports = { sendMail, verificationEmail, mailReady: ready };
