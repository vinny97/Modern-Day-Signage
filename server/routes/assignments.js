const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/client');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
// Phase 2.2j: workspace-aware access. Underlying tables (devices, playlists)
// already carry workspace_id from Phase 1; this route can use them even
// though playlists.js itself isn't yet workspace-filtered.
const { accessContextAsync } = require('../lib/tenancy');
const routeAsync = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// Mark playlist as draft (called after any item mutation)
async function markDraft(playlistId) {
  await db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(playlistId);
}

// Phase 2.2j: workspace-aware device access check. Returns access context
// (with workspaceRole/actingAs) or null. Caller decides if read or write.
async function checkDeviceAccess(req, res, paramName = 'deviceId', requireWrite = true) {
  const device = await db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(req.params[paramName]);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return null; }
  if (!device.workspace_id) { res.status(403).json({ error: 'Device not assigned to a workspace' }); return null; }
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id);
  const ctx = ws && await accessContextAsync(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return { device, ctx };
}

// Ensure device has a playlist; auto-create one if missing.
// Phase 2.2j: stamps workspace_id on the auto-created playlist so it remains
// visible once playlists.js migrates. Mirrors the 2.2i fix in device-groups.js.
async function ensureDevicePlaylist(deviceId, userId) {
  const device = await db.prepare('SELECT playlist_id, workspace_id, name FROM devices WHERE id = ?').get(deviceId);
  if (device?.playlist_id) return device.playlist_id;

  const playlistId = uuidv4();
  await db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, is_auto_generated) VALUES (?, ?, ?, ?, 1)')
    .run(playlistId, userId, device?.workspace_id || null, `${device?.name || 'Display'} playlist`);
  await db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(playlistId, deviceId);
  return playlistId;
}

// Standard item query with joined content/widget info
const ITEM_SELECT = `
  SELECT pi.id, pi.playlist_id, pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec,
         pi.created_at, pi.updated_at,
         COALESCE(c.filename, w.name) as filename,
         c.mime_type, c.filepath, c.thumbnail_path,
         c.duration_sec as content_duration, c.file_size, c.remote_url,
         w.name as widget_name, w.widget_type, w.config as widget_config
  FROM playlist_items pi
  LEFT JOIN content c ON pi.content_id = c.id
  LEFT JOIN widgets w ON pi.widget_id = w.id
`;

// Get assignments (playlist items) for a device
router.get('/device/:deviceId', routeAsync(async (req, res) => {
  if (!await checkDeviceAccess(req, res, 'deviceId', false)) return;
  const device = await db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device?.playlist_id) return res.json([]);

  const items = await db.prepare(`${ITEM_SELECT} WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC`)
    .all(device.playlist_id);
  res.json(items);
}));

// Add content or widget to device playlist.
// Phase 2.2j: closes 2 pre-existing cross-tenant leaks:
//   1. Content gate: today checks content.user_id == caller. A workspace_admin
//      who happens to own content in another workspace could push it into a
//      device in this workspace. Now: content must be in device's workspace
//      (or be a platform-template, workspace_id IS NULL).
//   2. Widget gate: today checks ONLY existence - any user could attach any
//      widget UUID to their own device's playlist. Now: widget must be in
//      device's workspace (or be a platform-template).
router.post('/device/:deviceId', routeAsync(async (req, res) => {
  const access = await checkDeviceAccess(req, res, 'deviceId', true);
  if (!access) return;
  const { content_id, widget_id, zone_id, duration_sec = 10, sort_order } = req.body;

  if (!content_id && !widget_id) return res.status(400).json({ error: 'content_id or widget_id required' });

  if (content_id) {
    const content = await db.prepare('SELECT id, workspace_id FROM content WHERE id = ?').get(content_id);
    if (!content) return res.status(404).json({ error: 'Content not found' });
    if (content.workspace_id && content.workspace_id !== access.device.workspace_id) {
      return res.status(403).json({ error: 'Content is not in this device\'s workspace' });
    }
  }
  if (widget_id) {
    const widget = await db.prepare('SELECT id, workspace_id FROM widgets WHERE id = ?').get(widget_id);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    if (widget.workspace_id && widget.workspace_id !== access.device.workspace_id) {
      return res.status(403).json({ error: 'Widget is not in this device\'s workspace' });
    }
  }

  const playlistId = await ensureDevicePlaylist(req.params.deviceId, req.user.id);

  let order = sort_order;
  if (order === undefined || order === null) {
    const max = await db.prepare('SELECT MAX(sort_order) as max_order FROM playlist_items WHERE playlist_id = ?')
      .get(playlistId);
    order = (max.max_order || 0) + 1;
  }

  try {
    const result = await db.prepare(`
      INSERT INTO playlist_items (playlist_id, content_id, widget_id, zone_id, sort_order, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?)
    `).runReturningId(playlistId, content_id || null, widget_id || null, zone_id || null, order, duration_sec);

    await markDraft(playlistId);

    const item = await db.prepare(`${ITEM_SELECT} WHERE pi.id = ?`).get(result.lastInsertRowid);
    res.status(201).json(item);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Content already in playlist' });
    }
    throw err;
  }
}));

// Helper: load a playlist item and check write access via the parent
// playlist's workspace. Returns the item row or null after sending 403/404.
async function checkItemWrite(req, res) {
  const item = await db.prepare('SELECT pi.*, p.workspace_id AS pl_workspace_id FROM playlist_items pi JOIN playlists p ON pi.playlist_id = p.id WHERE pi.id = ?').get(req.params.id);
  if (!item) { res.status(404).json({ error: 'Item not found' }); return null; }
  if (!item.pl_workspace_id) { res.status(403).json({ error: 'Playlist not assigned to a workspace' }); return null; }
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(item.pl_workspace_id);
  const ctx = ws && await accessContextAsync(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return item;
}

// Update playlist item
router.put('/:id', routeAsync(async (req, res) => {
  const item = await checkItemWrite(req, res);
  if (!item) return;

  const { sort_order, duration_sec, zone_id } = req.body;
  const updates = [];
  const values = [];

  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  if (duration_sec !== undefined) { updates.push('duration_sec = ?'); values.push(duration_sec); }
  // zone_id can be null (clear the zone) - treat undefined as "no change",
  // any other value (including null) as "write this".
  if (zone_id !== undefined) { updates.push('zone_id = ?'); values.push(zone_id || null); }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    await db.prepare(`UPDATE playlist_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    await markDraft(item.playlist_id);
  }

  const updated = await db.prepare(`${ITEM_SELECT} WHERE pi.id = ?`).get(req.params.id);
  res.json(updated);
}));

// Delete playlist item
router.delete('/:id', routeAsync(async (req, res) => {
  const item = await checkItemWrite(req, res);
  if (!item) return;

  await db.prepare('DELETE FROM playlist_item_schedules WHERE playlist_item_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM playlist_items WHERE id = ?').run(req.params.id);
  await markDraft(item.playlist_id);

  res.json({ success: true, content_id: item.content_id });
}));

// Reorder items for a device's playlist
router.post('/device/:deviceId/reorder', routeAsync(async (req, res) => {
  if (!await checkDeviceAccess(req, res, 'deviceId', true)) return;
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of item IDs' });

  const device = await db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!device?.playlist_id) return res.json([]);

  const updateStmt = db.prepare('UPDATE playlist_items SET sort_order = ? WHERE id = ? AND playlist_id = ?');
  const transaction = db.transaction(async () => {
    for (const [index, itemId] of order.entries()) await updateStmt.run(index, itemId, device.playlist_id);
  });
  await transaction();

  await markDraft(device.playlist_id);

  const items = await db.prepare(`${ITEM_SELECT} WHERE pi.playlist_id = ? ORDER BY pi.sort_order ASC`)
    .all(device.playlist_id);
  res.json(items);
}));

// Copy playlist from one device to another.
// Phase 2.2j: closes a pre-existing cross-tenant leak. Today both deviceIds
// only got the user_id ownership check; a caller with reach into a foreign
// workspace could copy that workspace's playlist into a device in their own
// workspace (or vice versa). Now: both devices must be in the same workspace,
// and the caller must have write access there.
router.post('/device/:deviceId/copy-to/:targetDeviceId', routeAsync(async (req, res) => {
  const sourceAccess = await checkDeviceAccess(req, res, 'deviceId', true);
  if (!sourceAccess) return;
  const targetAccess = await checkDeviceAccess(req, res, 'targetDeviceId', true);
  if (!targetAccess) return;
  if (sourceAccess.device.workspace_id !== targetAccess.device.workspace_id) {
    return res.status(403).json({ error: 'Source and target devices must be in the same workspace' });
  }

  const sourceDevice = await db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(req.params.deviceId);
  if (!sourceDevice?.playlist_id) return res.status(404).json({ error: 'Source device has no playlist' });

  const sourceItems = await db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort_order')
    .all(sourceDevice.playlist_id);
  if (!sourceItems.length) return res.status(404).json({ error: 'Source playlist is empty' });

  const target = await db.prepare('SELECT id, user_id FROM devices WHERE id = ?').get(req.params.targetDeviceId);
  if (!target) return res.status(404).json({ error: 'Target device not found' });

  const targetPlaylistId = await ensureDevicePlaylist(req.params.targetDeviceId, target.user_id || req.user.id);

  if (req.body.replace) {
    await db.prepare('DELETE FROM playlist_item_schedules WHERE playlist_item_id IN (SELECT id FROM playlist_items WHERE playlist_id = ?)').run(targetPlaylistId);
    await db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(targetPlaylistId);
  }

  const maxOrder = (await db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?')
    .get(targetPlaylistId)).m || 0;
  const stmt = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, widget_id, zone_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, ?, ?)');

  const transaction = db.transaction(async () => {
    for (const [i, item] of sourceItems.entries()) {
      await stmt.run(targetPlaylistId, item.content_id, item.widget_id, item.zone_id || null, maxOrder + i + 1, item.duration_sec);
    }
  });
  await transaction();

  await markDraft(targetPlaylistId);
  res.json({ success: true, copied: sourceItems.length });
}));

module.exports = router;
