const { db: asyncDb } = require('../db/client');
const config = require('../config');
const db = asyncDb;

const TRIAL_DAYS = 14;

async function getUserPlan(userId) {
  const user = await db.prepare(`
    SELECT u.*, p.name as plan_name, p.display_name as plan_display_name,
           p.max_devices, p.max_storage_mb, p.remote_control, p.remote_url,
           p.priority_support, p.price_monthly, p.price_yearly
    FROM users u
    JOIN plans p ON u.plan_id = p.id
    WHERE u.id = ?
  `).get(userId);

  // Check if trial has expired
  if (user && user.trial_started) {
    const trialEnd = user.trial_started + (TRIAL_DAYS * 86400);
    const now = Math.floor(Date.now() / 1000);
    user.trial_active = now < trialEnd;
    user.trial_days_left = Math.max(0, Math.ceil((trialEnd - now) / 86400));
    user.trial_end = trialEnd;

    // Auto-downgrade if trial expired and no paid subscription
    if (!user.trial_active && user.subscription_status !== 'active' && user.plan_name !== 'free') {
      await db.prepare("UPDATE users SET plan_id = 'free', trial_started = NULL WHERE id = ?").run(userId);
      // Re-fetch with free plan
      return getUserPlan(userId);
    }
  } else {
    user.trial_active = false;
    user.trial_days_left = 0;
  }

  return user;
}

async function getUserDeviceCount(userId) {
  return (await db.prepare('SELECT COUNT(*) as count FROM devices WHERE user_id = ?').get(userId)).count;
}

async function getUserStorageMB(userId) {
  const result = await db.prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM content WHERE user_id = ?').get(userId);
  return Math.ceil(result.total / (1024 * 1024));
}

// Check if user can add more devices
async function checkDeviceLimit(req, res, next) {
  const plan = await getUserPlan(req.user.id);
  if (!plan) return res.status(403).json({ error: 'No plan found' });

  // -1 means unlimited
  if (plan.max_devices === -1) return next();

  const deviceCount = await getUserDeviceCount(req.user.id);
  if (deviceCount >= plan.max_devices) {
    return res.status(403).json({
      error: `Device limit reached (${plan.max_devices} on ${plan.plan_display_name} plan). Upgrade to add more.`,
      code: 'DEVICE_LIMIT',
      current: deviceCount,
      limit: plan.max_devices,
      plan: plan.plan_name
    });
  }
  next();
}

// Check if user can upload more content
async function checkStorageLimit(req, res, next) {
  const plan = await getUserPlan(req.user.id);
  if (!plan) return res.status(403).json({ error: 'No plan found' });

  // -1 means unlimited
  if (plan.max_storage_mb === -1) return next();

  const usedMB = await getUserStorageMB(req.user.id);
  if (usedMB >= plan.max_storage_mb) {
    return res.status(403).json({
      error: `Storage limit reached (${plan.max_storage_mb}MB on ${plan.plan_display_name} plan). Upgrade for more.`,
      code: 'STORAGE_LIMIT',
      current_mb: usedMB,
      limit_mb: plan.max_storage_mb,
      plan: plan.plan_name
    });
  }
  next();
}

// Check if user has remote control access
async function checkRemoteControl(req, res, next) {
  const plan = await getUserPlan(req.user.id);
  if (!plan || !plan.remote_control) {
    return res.status(403).json({
      error: 'Remote control requires Starter plan or above.',
      code: 'FEATURE_LOCKED',
      plan: plan?.plan_name
    });
  }
  next();
}

// Check remote URL feature access
async function checkRemoteUrl(req, res, next) {
  const plan = await getUserPlan(req.user.id);
  if (!plan || !plan.remote_url) {
    return res.status(403).json({
      error: 'Remote URL content requires Pro plan or above.',
      code: 'FEATURE_LOCKED',
      plan: plan?.plan_name
    });
  }
  next();
}

// Check subscription is active (not expired)
async function checkActiveSubscription(req, res, next) {
  const plan = await getUserPlan(req.user.id);
  if (!plan) return res.status(403).json({ error: 'No plan found' });

  // Free plan is always active
  if (plan.plan_name === 'free') return next();

  // Self-hosted mode doesn't check expiry
  if (config.selfHosted) return next();

  // Check if subscription has expired
  if (plan.subscription_status !== 'active' && plan.subscription_ends && plan.subscription_ends < Math.floor(Date.now() / 1000)) {
    return res.status(403).json({
      error: 'Subscription expired. Please renew to continue.',
      code: 'SUBSCRIPTION_EXPIRED'
    });
  }
  next();
}

async function getUserPlanAsync(userId) {
  const user = await asyncDb.prepare(`
    SELECT u.*, p.name as plan_name, p.display_name as plan_display_name,
           p.max_devices, p.max_storage_mb, p.remote_control, p.remote_url,
           p.priority_support, p.price_monthly, p.price_yearly
    FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = ?
  `).get(userId);
  if (!user) return null;
  if (user.trial_started) {
    const trialEnd = user.trial_started + (TRIAL_DAYS * 86400);
    user.trial_active = Math.floor(Date.now() / 1000) < trialEnd;
    user.trial_days_left = Math.max(0, Math.ceil((trialEnd - Math.floor(Date.now() / 1000)) / 86400));
    user.trial_end = trialEnd;
    if (!user.trial_active && user.subscription_status !== 'active' && user.plan_name !== 'free') {
      await asyncDb.prepare("UPDATE users SET plan_id = 'free', trial_started = NULL WHERE id = ?").run(userId);
      return getUserPlanAsync(userId);
    }
  } else {
    user.trial_active = false;
    user.trial_days_left = 0;
  }
  return user;
}

async function checkStorageLimitAsync(req, res, next) {
  try {
    const plan = await getUserPlanAsync(req.user.id);
    if (!plan) return res.status(403).json({ error: 'No plan found' });
    if (plan.max_storage_mb === -1) return next();
    const result = await asyncDb.prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM content WHERE user_id = ?').get(req.user.id);
    const usedMB = Math.ceil(Number(result.total) / (1024 * 1024));
    if (usedMB >= plan.max_storage_mb) {
      return res.status(403).json({
        error: `Storage limit reached (${plan.max_storage_mb}MB on ${plan.plan_display_name} plan). Upgrade for more.`,
        code: 'STORAGE_LIMIT', current_mb: usedMB, limit_mb: plan.max_storage_mb, plan: plan.plan_name,
      });
    }
    next();
  } catch (error) { next(error); }
}

async function checkRemoteUrlAsync(req, res, next) {
  try {
    const plan = await getUserPlanAsync(req.user.id);
    if (!plan || !plan.remote_url) {
      return res.status(403).json({ error: 'Remote URL content requires Pro plan or above.', code: 'FEATURE_LOCKED', plan: plan?.plan_name });
    }
    next();
  } catch (error) { next(error); }
}

module.exports = {
  getUserPlan,
  getUserDeviceCount,
  getUserStorageMB,
  checkDeviceLimit,
  checkStorageLimit,
  checkRemoteControl,
  checkRemoteUrl,
  checkStorageLimitAsync,
  checkRemoteUrlAsync,
  getUserPlanAsync,
  checkActiveSubscription
};
