// Transactional email sender backed by Resend's HTTPS API.
//
// Configured via env vars:
//   RESEND_API_KEY      Resend API key
//   RESEND_FROM_EMAIL   Sender on a verified Resend domain
//   RESEND_FROM_NAME    Display name (optional; defaults to ScreenTinker)
//
// When unconfigured, sendEmail() logs an [EMAIL] line to stdout and returns
// { sent: false, reason: 'not_configured' } so local dev / test environments
// without a Resend account keep working.

const config = require('../config');

function isConfigured() {
  return !!(config.resendApiKey && config.resendFromEmail);
}

function formatFrom(fromName) {
  const name = String(fromName || config.resendFromName || 'ScreenTinker')
    .replace(/[\r\n<>]/g, ' ')
    .trim();
  return name ? `${name} <${config.resendFromEmail}>` : config.resendFromEmail;
}

// rawSubject: when true, the subject is sent verbatim (no "[ScreenTinker] "
// prefix) — used by the signup emails which carry their own clean subjects.
// fromName: overrides RESEND_FROM_NAME for messages such as personal welcomes.
function buildPayload(to, subject, text, html, fromName, rawSubject) {
  const payload = {
    from: formatFrom(fromName),
    to: [to],
    subject: rawSubject ? subject : `[ScreenTinker] ${subject}`,
    html: html || `<pre style="font-family:sans-serif">${escapeHtml(text || '')}</pre>`,
  };
  if (text) payload.text = text;
  return payload;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Public surface. Caller passes { to, subject, text, html } (html optional;
// derived from text if absent). Returns a result object - never throws to the
// caller. Resend errors are logged and the function returns sent:false so
// app-level flow (e.g. the device-offline alert) keeps running even when
// email delivery is broken.
async function sendEmail({ to, subject, text, html, fromName, rawSubject }) {
  if (!isConfigured()) {
    console.log(`[EMAIL] not configured - would send to ${to}: ${subject}`);
    if (text) console.log(`  ${text.split('\n')[0]}`);
    return { sent: false, reason: 'not_configured' };
  }
  // Dev allow-list. Bypass Resend entirely for recipients not in the list.
  // Skipped when resendDevRestrictTo is empty (i.e. production).
  if (config.resendDevRestrictTo) {
    const allowed = config.resendDevRestrictTo
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(String(to).toLowerCase())) {
      console.log(`[EMAIL] dev restrict - would send to ${to}: ${subject} (suppressed)`);
      return { sent: false, reason: 'dev_restricted' };
    }
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildPayload(to, subject, text, html, fromName, rawSubject)),
      signal: AbortSignal.timeout(15_000),
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`Resend API ${response.status}: ${responseBody.slice(0, 500)}`);
    }
    let id;
    try { id = JSON.parse(responseBody).id; } catch {}
    console.log(`[EMAIL] sent to ${to}: ${subject}`);
    return { sent: true, id };
  } catch (e) {
    console.error(`[EMAIL] Resend send failed for ${to}: ${e.message}`);
    return { sent: false, reason: 'resend_error', error: e.message };
  }
}

module.exports = { sendEmail, isConfigured, buildPayload };
