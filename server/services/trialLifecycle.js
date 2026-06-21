'use strict';

// Trial lifecycle emails for hosted ScreenFizz accounts.
// Sends three required service communications (no opt-out) and one win-back
// that honours the user's email_alerts preference.
//
// Idempotency: subscription_notifications(user_id, event_key) PRIMARY KEY
// guarantees each milestone fires at most once per user.
//
// Milestones:
//   trial_day5  — sent when <=2 days remain in the trial (day 5 of 7)
//   trial_day7  — sent when the trial has expired
//   trial_day10 — win-back, 3 days after expiry; respects email_alerts opt-out
//
// Gated on HOSTED_INSTANCE=true (same as activationNudge).

const { db } = require('../db/client');
const { sendEmail } = require('./email');

const SWEEP_HOUR_UTC = 8; // 08:00 UTC daily

function isHosted() {
  return process.env.HOSTED_INSTANCE === 'true';
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function upgradeUrl() {
  return (process.env.APP_URL || 'https://screentinker.com') + '/app#/subscribe';
}

// ── Day 5: 2 days left ──────────────────────────────────────────────────────

function day5Text(name) {
  return `Hi ${name},

Just a heads up - your ScreenFizz Self Service trial ends in 2 days.

To keep your screen running and your content live, subscribe before the
trial expires:

  -> ${upgradeUrl()}

It's GBP 5 per month - no commitment, cancel any time.

If you have any questions just reply to this email.

- Dan
ScreenFizz`;
}

function day5Html(name) {
  const url = upgradeUrl();
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<p>Hi ${htmlEscape(name)},</p>
<p>Just a heads up - your ScreenFizz Self Service trial ends in <strong>2 days</strong>.</p>
<p>To keep your screen running and your content live, subscribe before the trial expires:</p>
<p><a href="${url}" style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Subscribe now - GBP 5/month</a></p>
<p style="font-size:13px;color:#666">No commitment. Cancel any time.</p>
<p>If you have any questions just reply to this email.</p>
<p>- Dan<br>ScreenFizz</p>
</div>`;
}

// ── Day 7: trial just expired ────────────────────────────────────────────────

function day7Text(name) {
  return `Hi ${name},

Your ScreenFizz Self Service trial has ended and your screen is now paused.

Subscribe to restore your display instantly:

  -> ${upgradeUrl()}

GBP 5 per month. Your content and settings are all still there.

- Dan
ScreenFizz`;
}

function day7Html(name) {
  const url = upgradeUrl();
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<p>Hi ${htmlEscape(name)},</p>
<p>Your ScreenFizz Self Service trial has ended and your screen is now <strong>paused</strong>.</p>
<p>Subscribe to restore your display instantly:</p>
<p><a href="${url}" style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Restore my screen - GBP 5/month</a></p>
<p style="font-size:13px;color:#666">Your content and settings are all still there - nothing has been deleted.</p>
<p>- Dan<br>ScreenFizz</p>
</div>`;
}

// ── Day 10: win-back (respects opt-out) ─────────────────────────────────────

function day10Text(name) {
  return `Hi ${name},

It's been a few days since your ScreenFizz trial ended. I wanted to
check in - was there something that stopped you from subscribing?

Hit reply and let me know. Happy to help or answer any questions.

If you'd like to get your screen back up and running:

  -> ${upgradeUrl()}

And if you'd rather not hear from me again, just say the word.

- Dan
ScreenFizz`;
}

function day10Html(name) {
  const url = upgradeUrl();
  return `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<p>Hi ${htmlEscape(name)},</p>
<p>It's been a few days since your ScreenFizz trial ended. I wanted to check in - was there something that stopped you from subscribing?</p>
<p>Hit reply and let me know. Happy to help or answer any questions.</p>
<p>If you'd like to get your screen back up and running: <a href="${url}" style="font-weight:600">click here</a></p>
<p style="font-size:13px;color:#666">And if you'd rather not hear from me again, just say the word.</p>
<p>- Dan<br>ScreenFizz</p>
</div>`;
}

// ── Idempotent notification helpers ─────────────────────────────────────────

function hasNotification(userId, eventKey) {
  const row = db.prepare(
    "SELECT 1 FROM subscription_notifications WHERE user_id = ? AND event_key = ? AND status = 'sent'"
  ).get(userId, eventKey);
  return !!row;
}

function markNotificationSent(userId, eventKey) {
  db.prepare(`INSERT INTO subscription_notifications (user_id, event_key, status, sent_at)
    VALUES (?, ?, 'sent', strftime('%s','now'))
    ON CONFLICT(user_id, event_key) DO UPDATE SET status = 'sent', sent_at = strftime('%s','now')`)
    .run(userId, eventKey);
}

// ── Sweep ────────────────────────────────────────────────────────────────────

async function runTrialLifecycleSweep() {
  if (!isHosted()) return 0;
  const now = Math.floor(Date.now() / 1000);
  let sent = 0;

  // Users whose trial ends within the next 2 days and hasn't expired yet.
  const day5Candidates = db.prepare(`
    SELECT id, email, name FROM users
    WHERE subscription_status = 'trial'
      AND trial_ends_at IS NOT NULL
      AND trial_ends_at > ? AND trial_ends_at <= ?
  `).all(now, now + 2 * 86400);

  for (const u of day5Candidates) {
    if (hasNotification(u.id, 'trial_day5')) continue;
    const name = (u.name && u.name.trim()) ? u.name.trim() : u.email.split('@')[0];
    await sendEmail({
      to: u.email,
      fromName: 'Dan at ScreenFizz',
      rawSubject: true,
      subject: 'Your ScreenFizz trial ends in 2 days',
      text: day5Text(name),
      html: day5Html(name),
    });
    markNotificationSent(u.id, 'trial_day5');
    console.log(`[TRIAL-LIFECYCLE] day5 -> ${u.email}`);
    sent++;
  }

  // Users whose trial expired within the last 24 hours.
  const day7Candidates = db.prepare(`
    SELECT id, email, name FROM users
    WHERE subscription_status IN ('trial', 'expired')
      AND trial_ends_at IS NOT NULL
      AND trial_ends_at <= ? AND trial_ends_at > ?
      AND stripe_subscription_id IS NULL
  `).all(now, now - 86400);

  for (const u of day7Candidates) {
    if (hasNotification(u.id, 'trial_day7')) continue;
    const name = (u.name && u.name.trim()) ? u.name.trim() : u.email.split('@')[0];
    await sendEmail({
      to: u.email,
      fromName: 'Dan at ScreenFizz',
      rawSubject: true,
      subject: 'Your ScreenFizz trial has ended',
      text: day7Text(name),
      html: day7Html(name),
    });
    markNotificationSent(u.id, 'trial_day7');
    console.log(`[TRIAL-LIFECYCLE] day7 -> ${u.email}`);
    sent++;
  }

  // Win-back: expired 3-4 days ago, no subscription, email_alerts not off.
  const day10Candidates = db.prepare(`
    SELECT id, email, name FROM users
    WHERE subscription_status = 'expired'
      AND trial_ends_at IS NOT NULL
      AND trial_ends_at <= ? AND trial_ends_at > ?
      AND stripe_subscription_id IS NULL
      AND COALESCE(email_alerts, 1) = 1
  `).all(now - 3 * 86400, now - 4 * 86400);

  for (const u of day10Candidates) {
    if (hasNotification(u.id, 'trial_day10')) continue;
    const name = (u.name && u.name.trim()) ? u.name.trim() : u.email.split('@')[0];
    await sendEmail({
      to: u.email,
      fromName: 'Dan at ScreenFizz',
      rawSubject: true,
      subject: "Quick check-in - how did your ScreenFizz trial go?",
      text: day10Text(name),
      html: day10Html(name),
    });
    markNotificationSent(u.id, 'trial_day10');
    console.log(`[TRIAL-LIFECYCLE] day10 -> ${u.email}`);
    sent++;
  }

  return sent;
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SWEEP_HOUR_UTC, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function startTrialLifecycle() {
  if (!isHosted()) {
    console.log('[TRIAL-LIFECYCLE] HOSTED_INSTANCE not set - trial lifecycle sweep disabled');
    return;
  }
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[TRIAL-LIFECYCLE] next sweep in ~${Math.round(delay / 60000)} min (${SWEEP_HOUR_UTC}:00 UTC daily)`);
    setTimeout(() => {
      runTrialLifecycleSweep().catch(e => console.error('[TRIAL-LIFECYCLE] sweep error:', e.message));
      schedule();
    }, delay);
  };
  schedule();
}

module.exports = { startTrialLifecycle, runTrialLifecycleSweep };
