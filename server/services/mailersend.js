// MailerSend transactional email service.
// Used for marketing emails: contact form confirmations, etc.
//
// Env vars required (set in Render dashboard):
//   MAILERSEND_API_KEY       — API token from MailerSend dashboard
//   MAILERSEND_FROM_EMAIL    — verified sender address (e.g. info@screenfizz.com)
//   MAILERSEND_FROM_NAME     — display name (defaults to ScreenFizz)

const config = require('../config');

function isConfigured() {
  return !!(config.mailersendApiKey && config.mailersendFromEmail);
}

async function sendMailerSend({ to, toName, subject, html, text }) {
  if (!isConfigured()) {
    console.log(`[MAILERSEND] not configured — would send to ${to}: ${subject}`);
    return { sent: false, reason: 'not_configured' };
  }

  const payload = {
    from: { email: config.mailersendFromEmail, name: config.mailersendFromName || 'ScreenFizz' },
    to: [{ email: to, name: toName || to }],
    subject,
    html,
  };
  if (text) payload.text = text;

  try {
    const response = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.mailersendApiKey}`,
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`MailerSend API ${response.status}: ${body.slice(0, 500)}`);
    }
    console.log(`[MAILERSEND] sent to ${to}: ${subject}`);
    return { sent: true };
  } catch (e) {
    console.error(`[MAILERSEND] send failed for ${to}: ${e.message}`);
    return { sent: false, reason: 'mailersend_error', error: e.message };
  }
}

module.exports = { sendMailerSend, isConfigured };
