'use strict';

const { db } = require('../db/client');
const config = require('../config');

const TRIAL_DAYS = 7;
const PAST_DUE_GRACE_DAYS = 3;
const DAY_SECONDS = 86400;
const VALID_STATUSES = new Set(['trial', 'active', 'past_due', 'cancelled', 'expired']);

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function trialFields(startedAt, days = TRIAL_DAYS) {
  const trialStarted = Number(startedAt || nowSeconds());
  return {
    trialStarted,
    trialEndsAt: trialStarted + (days * DAY_SECONDS),
  };
}

async function loadUser(userOrId) {
  if (userOrId && typeof userOrId === 'object' && userOrId.subscription_status !== undefined) return userOrId;
  const id = typeof userOrId === 'object' ? userOrId?.id : userOrId;
  if (!id) return null;
  return db.prepare(`SELECT id, email, name, role, plan_id,
    stripe_customer_id, stripe_subscription_id, subscription_status,
    subscription_ends, trial_started, trial_ends_at, trial_plan,
    past_due_grace_ends_at, email_alerts
    FROM users WHERE id = ?`).get(id);
}

function statePayload(user, overrides = {}) {
  const trialEnd = user.trial_ends_at ? Number(user.trial_ends_at) : null;
  const now = Number(overrides.now ?? nowSeconds());
  return {
    state: overrides.state || user.subscription_status || 'active',
    reason: overrides.reason || null,
    allowed: overrides.allowed !== false,
    plan_id: user.plan_id || 'free',
    trial_ends_at: trialEnd,
    trial_days_remaining: trialEnd ? Math.max(0, Math.ceil((trialEnd - now) / DAY_SECONDS)) : 0,
    subscription_ends_at: user.subscription_ends ? Number(user.subscription_ends) : null,
    grace_ends_at: user.past_due_grace_ends_at ? Number(user.past_due_grace_ends_at) : null,
    subscribe_url: '/app#/subscribe',
  };
}

async function getAccessState(userOrId, options = {}) {
  const user = await loadUser(userOrId);
  if (!user) return null;
  const now = Number(options.now ?? nowSeconds());

  if (config.selfHosted || user.auth_provider === 'recovery') {
    return statePayload(user, { now, state: 'active', allowed: true });
  }

  const status = VALID_STATUSES.has(user.subscription_status)
    ? user.subscription_status
    : 'active';

  if (status === 'trial') {
    const trialEnd = Number(user.trial_ends_at || 0);
    if (trialEnd > now) return statePayload(user, { now, state: 'trial', allowed: true });
    if (!options.readOnly && user.subscription_status !== 'expired') {
      await db.prepare(`UPDATE users SET subscription_status = 'expired',
        updated_at = strftime('%s','now') WHERE id = ? AND subscription_status = 'trial'`).run(user.id);
      user.subscription_status = 'expired';
    }
    return statePayload(user, { now, state: 'expired', reason: 'trial_expired', allowed: false });
  }

  if (status === 'past_due') {
    const graceEnd = Number(user.past_due_grace_ends_at || 0);
    if (graceEnd > now) {
      return statePayload(user, { now, state: 'past_due', reason: 'payment_grace', allowed: true });
    }
    return statePayload(user, { now, state: 'past_due', reason: 'payment_failed', allowed: false });
  }

  if (status === 'cancelled') {
    const paidThrough = Number(user.subscription_ends || 0);
    if (paidThrough > now) {
      return statePayload(user, { now, state: 'cancelled', reason: 'cancelled_at_period_end', allowed: true });
    }
    return statePayload(user, { now, state: 'cancelled', reason: 'subscription_cancelled', allowed: false });
  }

  if (status === 'expired') {
    return statePayload(user, { now, state: 'expired', reason: 'trial_expired', allowed: false });
  }

  return statePayload(user, { now, state: 'active', allowed: true });
}

async function beginHostedTrial(userId, options = {}) {
  if (config.selfHosted) return null;
  const { trialStarted, trialEndsAt } = trialFields(options.now, options.days || TRIAL_DAYS);
  await db.prepare(`UPDATE users SET plan_id = 'starter', subscription_status = 'trial',
    trial_started = ?, trial_ends_at = ?, trial_plan = 'starter',
    subscription_ends = NULL, past_due_grace_ends_at = NULL,
    updated_at = strftime('%s','now') WHERE id = ?`)
    .run(trialStarted, trialEndsAt, userId);
  return { trialStarted, trialEndsAt };
}

function subscriptionRequiredBody(access) {
  return {
    error: 'A ScreenFizz Self Service subscription is required to continue.',
    code: 'SUBSCRIPTION_REQUIRED',
    reason: access?.reason || 'subscription_required',
    subscribe_url: access?.subscribe_url || '/app#/subscribe',
  };
}

async function requireSubscriptionAccess(req, res, next) {
  try {
    const access = req.access || await getAccessState(req.user);
    req.access = access;
    if (!access || access.allowed) return next();
    return res.status(402).json(subscriptionRequiredBody(access));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  DAY_SECONDS,
  TRIAL_DAYS,
  PAST_DUE_GRACE_DAYS,
  VALID_STATUSES,
  beginHostedTrial,
  getAccessState,
  nowSeconds,
  requireSubscriptionAccess,
  subscriptionRequiredBody,
  trialFields,
};
