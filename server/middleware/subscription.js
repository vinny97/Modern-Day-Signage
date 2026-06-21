const { db: asyncDb } = require('../db/client');
const { getAccessState } = require('../services/subscriptionAccess');
const db = asyncDb;

async function getUserPlan(userId) {
  const user = await db.prepare(`
    SELECT u.*, p.name as plan_name, p.display_name as plan_display_name,
           p.max_devices, p.max_storage_mb, p.remote_control, p.remote_url,
           p.priority_support, p.price_monthly, p.price_yearly
    FROM users u
    JOIN plans p ON u.plan_id = p.id
    WHERE u.id = ?
  `).get(userId);

  if (!user) return null;
  user.access = await getAccessState(user);
  user.trial_active = user.access?.state === 'trial' && user.access.allowed;
  user.trial_days_left = user.access?.trial_days_remaining || 0;
  user.trial_end = user.access?.trial_ends_at || null;

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

  if (!plan.access?.allowed) return res.status(402).json({
    error: 'A ScreenFizz Self Service subscription is required to continue.',
    code: 'SUBSCRIPTION_REQUIRED',
    reason: plan.access?.reason,
    subscribe_url: plan.access?.subscribe_url,
  });
  next();
}

async function getUserPlanAsync(userId) {
  return getUserPlan(userId);
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
