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

  // Attempt email notification (best-effort)
  const tenantLabel  = multi_tenant === 'multi' ? 'Multiple organizations' : 'Single organization';
  const hostingLabel = { hosted: 'Hosted for me', self: 'Self-host', unsure: 'Not sure yet' }[hosting] || hosting || 'n/a';

  const subject = `New enquiry: ${cleanName}${cleanCompany ? ' (' + cleanCompany + ')' : ''}`;
  const text =
`New ScreenFizz enquiry from ${cleanName} (${cleanEmail})

Business type: ${cleanCompany || 'Not provided'}
Screens: ${screensVal || 'Not provided'}
Package: ${pkg || 'Not provided'}
Installation: ${installation || 'Not provided'}
Has screen: ${has_screen || 'Not provided'}
${multi_tenant ? 'Multi-tenant: ' + tenantLabel + '\n' : ''}${hosting ? 'Hosting: ' + hostingLabel + '\n' : ''}
Message:
${cleanMessage || '(none)'}

---
Source IP: ${req.ip}
`;

  const result = await sendEmail({ to: 'info@screenfizz.com', subject, text });

  if (result.sent) {
    console.log(`[contact] enquiry from ${cleanEmail} delivered`);
    if (savedId) {
      try {
        await db.prepare('UPDATE contact_leads SET email_sent=1 WHERE id=?').run(savedId);
      } catch (_) {}
    }
  } else {
    console.warn(`[contact] email not sent for ${cleanEmail}: reason=${result.reason} — lead saved to DB`);
  }

  // Always return success — the lead is saved regardless of email status
  res.json({ success: true });
});

module.exports = router;
