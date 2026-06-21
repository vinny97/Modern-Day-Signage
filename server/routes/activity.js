const express = require('express');
const router = express.Router();
const { getActivity, pruneActivityLog } = require('../services/activity');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');

// Get activity log
router.get('/', async (req, res, next) => {
  try {
  const { device_id, limit, offset } = req.query;
  const isAdmin = PLATFORM_ROLES.includes(req.user.role);

  const activity = await getActivity({
    userId: isAdmin ? null : req.user.id,
    deviceId: device_id || null,
    limit: Math.min(parseInt(limit) || 50, 200),
    offset: parseInt(offset) || 0,
  });

  res.json(activity);
  } catch (error) { next(error); }
});

// Prune old logs (admin only)
router.delete('/prune', async (req, res, next) => {
  try {
  if (!ELEVATED_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  await pruneActivityLog();
  res.json({ success: true });
  } catch (error) { next(error); }
});

module.exports = router;
