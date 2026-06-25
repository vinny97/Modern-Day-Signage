// Public (unauthenticated) contact form endpoint. Captures leads from the
// marketing website quiz. Saves every submission to Postgres (Supabase) first,
// then attempts to send a notification email via Resend.
// If email is unconfigured or fails, the lead is still saved and the user
// gets a success response.
//
// Honeypot: hidden 'fax_number' field — bots fill it, real users never see it.

const express = require('express');
const router = express.Router();
const { sendEmail } = require('../services/email');
const { sendMailerSend } = require('../services/mailersend');
const { db } = require('../db/client');
const { sanitizeString } = require('../middleware/sanitize');

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function clamp(s, max) {
  return String(s || '').slice(0, max);
}

// Parse a screen-count value that may be "1", "2-3", "4+", or a plain integer.
function parseScreens(val) {
  if (!val) return null;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

router.post('/enterprise', async (req, res) => {
  const {
    name, email, company, screens, multi_tenant, hosting, message, fax_number,
    // fields added by the new wizard
    business_type, package: pkg, installation, has_screen, use_case
  } = req.body || {};

  // Honeypot — return 200 to fool bots but drop the submission
  if (fax_number && String(fax_number).trim() !== '') {
    console.log(`[contact] honeypot triggered from ${req.ip}; dropping`);
    return res.json({ success: true });
  }

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }
  if (!isEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const cleanName        = clamp(name, 200);
  const cleanEmail       = clamp(email, 200);
  const cleanCompany     = clamp(company || business_type || '', 200);
  const cleanMessage     = clamp(message, 5000);
  const screensVal       = clamp(screens, 20);
  const cleanBizType     = clamp(business_type || company || '', 100);
  const cleanPkg         = clamp(pkg || '', 50);
  const cleanInstall     = clamp(installation || '', 50);
  const cleanHasScreen   = clamp(has_screen || '', 10);
  const cleanUseCase     = clamp(use_case || '', 50);

  // Save lead to DB — source of truth regardless of email outcome
  let savedId = null;
  try {
    const result = await db.prepare(`
      INSERT INTO contact_leads
        (name, email, business_type, use_case, screens, package, installation, has_screen, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).runReturningId(
      cleanName, cleanEmail, cleanBizType, cleanUseCase, screensVal,
      cleanPkg, cleanInstall, cleanHasScreen, cleanMessage
    );
    savedId = result.lastInsertRowid;
  } catch (dbErr) {
    console.error('[contact] DB save failed:', dbErr.message);
    // Continue — still try to send email and return success
  }

  // ── Admin notification (plain text via Resend) ──────────────────────────────
  const adminSubject = `New enquiry: ${cleanName}${cleanCompany ? ' (' + cleanCompany + ')' : ''}`;
  const adminText =
`New ScreenFizz enquiry from ${cleanName} (${cleanEmail})

Business type : ${cleanCompany || 'Not provided'}
Use case      : ${cleanUseCase || 'Not provided'}
Screens       : ${screensVal || 'Not provided'}
Package       : ${pkg || 'Not provided'}
Installation  : ${cleanInstall || 'Not provided'}
Has screen    : ${cleanHasScreen || 'Not provided'}

Message:
${cleanMessage || '(none)'}

---
Source IP: ${req.ip}
`;

  const adminResult = await sendEmail({ to: 'info@screenfizz.com', subject: adminSubject, text: adminText });
  if (adminResult.sent) {
    console.log(`[contact] admin notification sent for ${cleanEmail}`);
    if (savedId) {
      try {
        await db.prepare('UPDATE contact_leads SET email_sent=1 WHERE id=?').run(savedId);
      } catch (_) {}
    }
  } else {
    console.warn(`[contact] admin email not sent for ${cleanEmail}: ${adminResult.reason}`);
  }

  // ── Customer confirmation email (branded HTML via MailerSend) ────────────
  const firstName = cleanName.split(' ')[0];

  const useCaseLabel = {
    menu_boards: 'Menu Boards',
    window_displays: 'Window Displays',
    promotions: 'Promotions & Info',
  }[cleanUseCase] || cleanUseCase || null;

  const installLabel = {
    yes: 'Yes — I need installation',
    no: "No — I'll handle it myself",
    unsure: 'Not sure yet',
  }[cleanInstall] || cleanInstall || null;

  const hasScreenLabel = {
    yes: 'Yes — I already have a screen',
    no: 'No — I need a screen too',
  }[cleanHasScreen] || cleanHasScreen || null;

  const detailRows = [
    cleanBizType   && ['Business type', cleanBizType],
    useCaseLabel   && ['What you need', useCaseLabel],
    screensVal     && ['Number of screens', screensVal],
    cleanPkg       && ['Package interest', cleanPkg],
    installLabel   && ['Installation', installLabel],
    hasScreenLabel && ['Already have a screen?', hasScreenLabel],
    cleanMessage   && ['Your message', cleanMessage],
  ].filter(Boolean);

  const htmlValue = value => sanitizeString(String(value));
  const detailRowsHtml = detailRows.map(([label, value]) =>
    `<li><strong>${label}:</strong> ${htmlValue(value)}</li>`
  ).join('');
  const detailRowsText = detailRows.map(([label, value]) => `${label}: ${value}`).join('\n');
  const safeFirstName = htmlValue(firstName);

  const confirmationHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>We've received your enquiry — ScreenFizz</title>
</head>
<body style="margin:0;padding:24px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;">
  <div style="max-width:640px;">
    <p>Hi ${safeFirstName},</p>
    <p>Thanks for getting in touch with ScreenFizz.</p>
    <p>We've received your enquiry and one of the team will be in touch very soon, usually within a few hours during business hours.</p>
    ${detailRowsHtml ? `
    <p>Here's what you shared with us:</p>
    <ul>
      ${detailRowsHtml}
    </ul>` : ''}
    <p>If you have any questions in the meantime, you can reply directly to this email.</p>
    <p>Talk soon,<br>The ScreenFizz Team</p>
  </div>
</body>
</html>`;

  const customerResult = await sendMailerSend({
    to: cleanEmail,
    toName: cleanName,
    subject: `We've received your enquiry, ${firstName}`,
    html: confirmationHtml,
    text: `Hi ${firstName},\n\nThanks for getting in touch with ScreenFizz.\n\nWe've received your enquiry and one of the team will be in touch very soon, usually within a few hours during business hours.\n\n${detailRowsText ? `Here's what you shared with us:\n${detailRowsText}\n\n` : ''}If you have any questions in the meantime, you can reply directly to this email.\n\nTalk soon,\nThe ScreenFizz Team`,
  });

  if (customerResult.sent) {
    console.log(`[contact] confirmation sent to ${cleanEmail}`);
  } else {
    console.warn(`[contact] customer confirmation not sent to ${cleanEmail}: ${customerResult.reason}`);
  }

  // Always return success — the lead is saved regardless of email status
  res.json({ success: true });
});

module.exports = router;
