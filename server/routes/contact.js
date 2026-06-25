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
    no: 'No — I'll handle it myself',
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

  const detailRowsHtml = detailRows.map(([label, value]) => `
    <tr>
      <td style="padding:10px 16px;font-size:14px;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top;border-bottom:1px solid #f3f4f6;">${label}</td>
      <td style="padding:10px 16px;font-size:14px;color:#111827;vertical-align:top;border-bottom:1px solid #f3f4f6;">${value}</td>
    </tr>`).join('');

  const confirmationHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>We've received your enquiry — ScreenFizz</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;">

          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <img src="https://screenfizz.com/assets/screenfizz-logo-wordmark.png" alt="ScreenFizz" width="160" style="display:block;">
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">

              <!-- Top accent -->
              <div style="height:4px;background:linear-gradient(90deg,#ef4444,#f97316);"></div>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:36px 40px 28px;">
                    <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ef4444;">Enquiry Received</p>
                    <h1 style="margin:0 0 20px;font-size:26px;font-weight:800;color:#111827;line-height:1.2;">Hi ${firstName}, thanks for getting in touch!</h1>
                    <p style="margin:0 0 12px;font-size:16px;color:#374151;line-height:1.7;">We've received your enquiry and we're already looking at the best setup for you.</p>
                    <p style="margin:0 0 28px;font-size:16px;color:#374151;line-height:1.7;">One of the team will be in touch <strong>very soon</strong> — usually within a few hours during business hours.</p>
                  </td>
                </tr>

                <!-- Details box -->
                <tr>
                  <td style="padding:0 40px 36px;">
                    <p style="margin:0 0 12px;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#6b7280;">What you shared with us</p>
                    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
                      ${detailRowsHtml}
                    </table>
                  </td>
                </tr>

                <!-- CTA -->
                <tr>
                  <td style="padding:0 40px 36px;">
                    <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">In the meantime, if you have any questions you can reply to this email or reach us on WhatsApp.</p>
                    <a href="https://wa.me/447304061595?text=Hi%20ScreenFizz%2C%20I%20just%20submitted%20an%20enquiry%20and%20had%20a%20quick%20question" style="display:inline-block;background:#111827;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:8px;">Message us on WhatsApp</a>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 0 0;text-align:center;">
              <p style="margin:0 0 6px;font-size:13px;color:#9ca3af;">ScreenFizz — Managed Digital Signage for UK Businesses</p>
              <p style="margin:0;font-size:12px;color:#d1d5db;">
                <a href="https://screenfizz.com/legal/privacy.html" style="color:#d1d5db;text-decoration:none;">Privacy Policy</a>
                &nbsp;·&nbsp;
                <a href="https://screenfizz.com" style="color:#d1d5db;text-decoration:none;">screenfizz.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const customerResult = await sendMailerSend({
    to: cleanEmail,
    toName: cleanName,
    subject: `We've received your enquiry, ${firstName}`,
    html: confirmationHtml,
    text: `Hi ${firstName},\n\nThanks for getting in touch with ScreenFizz!\n\nWe've received your enquiry and one of the team will be in touch very soon — usually within a few hours during business hours.\n\nHere's what you shared with us:\n${detailRows.map(([l, v]) => `• ${l}: ${v}`).join('\n')}\n\nIf you have any questions in the meantime, just reply to this email or message us on WhatsApp: https://wa.me/447304061595\n\nTalk soon,\nThe ScreenFizz Team\nhttps://screenfizz.com`,
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
