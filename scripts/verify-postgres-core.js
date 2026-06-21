#!/usr/bin/env node
'use strict';

require('./load-env').loadEnv();

const crypto = require('crypto');
const path = require('path');
process.env.DB_CLIENT = 'postgres';
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

const express = require(require.resolve('express', { paths: [path.join(__dirname, '..', 'server')] }));
const http = require('http');
const pg = require('../server/db/postgres');
const { generateToken: generateJwt, requireAuth } = require('../server/middleware/auth');
const {
  bearerAuth,
  tokenScopeGate,
} = require('../server/middleware/apiToken');
const { resolveTenancy } = require('../server/lib/tenancy');

const ids = {
  user: crypto.randomUUID(),
  org: crypto.randomUUID(),
  workspace: crypto.randomUUID(),
  device: crypto.randomUUID(),
};

async function cleanup() {
  await pg.transaction(async tx => {
    await tx.run('DELETE FROM api_tokens WHERE user_id = $1', [ids.user]);
    await tx.run('DELETE FROM schedules WHERE workspace_id = $1', [ids.workspace]);
    await tx.run('DELETE FROM playlist_item_schedules WHERE playlist_item_id IN (SELECT pi.id FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE p.workspace_id = $1)', [ids.workspace]);
    await tx.run('DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE workspace_id = $1)', [ids.workspace]);
    await tx.run('DELETE FROM playlists WHERE workspace_id = $1', [ids.workspace]);
    await tx.run('DELETE FROM content WHERE workspace_id = $1', [ids.workspace]);
    await tx.run('DELETE FROM content_folders WHERE workspace_id = $1', [ids.workspace]);
    await tx.run('DELETE FROM layout_zones WHERE layout_id IN (SELECT id FROM layouts WHERE workspace_id = $1)', [ids.workspace]);
    await tx.run('DELETE FROM layouts WHERE workspace_id = $1', [ids.workspace]);
    await tx.run('DELETE FROM devices WHERE id = $1', [ids.device]);
    await tx.run('DELETE FROM workspace_invites WHERE workspace_id = $1', [ids.workspace]);
    await tx.run('DELETE FROM workspace_members WHERE workspace_id = $1 OR user_id = $2', [ids.workspace, ids.user]);
    await tx.run('DELETE FROM organization_members WHERE organization_id = $1 OR user_id = $2', [ids.org, ids.user]);
    await tx.run('DELETE FROM workspaces WHERE id = $1', [ids.workspace]);
    await tx.run('DELETE FROM organizations WHERE id = $1', [ids.org]);
    await tx.run('DELETE FROM users WHERE id = $1', [ids.user]);
  });
}

async function request(base, route, token, options = {}) {
  const response = await fetch(base + route, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${route} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) {
    throw new Error('DATABASE_URL or SUPABASE_DB_URL is required');
  }

  await pg.initSchema();
  const user = { id: ids.user, email: `core-check-${ids.user}@example.invalid`, role: 'user' };
  await pg.transaction(async tx => {
    await tx.run('INSERT INTO users (id, email, name, role, plan_id) VALUES ($1, $2, $3, $4, $5)', [ids.user, user.email, 'Core Check', user.role, 'pro']);
    await tx.run('INSERT INTO organizations (id, name, owner_user_id) VALUES ($1, $2, $3)', [ids.org, 'Core Check Org', ids.user]);
    await tx.run("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'org_owner')", [ids.org, ids.user]);
    await tx.run('INSERT INTO workspaces (id, organization_id, name, created_by) VALUES ($1, $2, $3, $4)', [ids.workspace, ids.org, 'Core Check Workspace', ids.user]);
    await tx.run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'workspace_admin')", [ids.workspace, ids.user]);
    await tx.run('INSERT INTO devices (id, user_id, workspace_id, name) VALUES ($1, $2, $3, $4)', [ids.device, ids.user, ids.workspace, 'Core Check Display']);
  });

  const app = express();
  app.use(express.json());
  app.use('/api/workspaces', requireAuth, require('../server/routes/workspaces'));
  app.use('/api/tokens', requireAuth, resolveTenancy, require('../server/routes/tokens'));
  app.use('/api/devices', bearerAuth, resolveTenancy, tokenScopeGate, require('../server/routes/devices'));
  app.use('/api/content', bearerAuth, resolveTenancy, tokenScopeGate, require('../server/routes/content'));
  app.use('/api/folders', bearerAuth, resolveTenancy, tokenScopeGate, require('../server/routes/folders'));
  app.use('/api/playlists', bearerAuth, resolveTenancy, tokenScopeGate, require('../server/routes/playlists'));
  app.use('/api/layouts', bearerAuth, resolveTenancy, tokenScopeGate, require('../server/routes/layouts'));
  app.use('/api/assignments', bearerAuth, resolveTenancy, tokenScopeGate, require('../server/routes/assignments'));
  app.use('/api/schedules', bearerAuth, resolveTenancy, tokenScopeGate, require('../server/routes/schedules'));
  app.use((error, req, res, next) => {
    void next;
    res.status(500).json({ error: error.message });
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const jwt = generateJwt(user, ids.workspace);
    const managedToken = await request(base, '/api/tokens', jwt, {
      method: 'POST',
      body: JSON.stringify({ name: 'Core Check Token', scope: 'write' }),
    });
    const apiSecret = managedToken.token;
    const jwtDevices = await request(base, '/api/devices', jwt);
    const tokenDevices = await request(base, '/api/devices', apiSecret);
    if (jwtDevices.length !== 1 || tokenDevices.length !== 1) throw new Error('device listing was not workspace-bound');

    const workspace = await request(base, `/api/workspaces/${ids.workspace}`, jwt, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Core Check Renamed' }),
    });
    const device = await request(base, `/api/devices/${ids.device}`, jwt, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Core Check Updated Display' }),
    });
    if (workspace.name !== 'Core Check Renamed' || device.name !== 'Core Check Updated Display') {
      throw new Error('workspace or device update did not persist');
    }

    const folder = await request(base, '/api/folders', apiSecret, {
      method: 'POST', body: JSON.stringify({ name: 'Core Check Folder' }),
    });
    const content = await request(base, '/api/content/remote', apiSecret, {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/core-check.jpg', name: 'Core Check Content' }),
    });
    const moved = await request(base, `/api/content/${content.id}`, apiSecret, {
      method: 'PUT', body: JSON.stringify({ folder_id: folder.id }),
    });
    const listed = await request(base, `/api/content?folder_id=${folder.id}`, apiSecret);
    if (moved.folder_id !== folder.id || listed.length !== 1 || listed[0].id !== content.id) {
      throw new Error('folder or content metadata did not persist');
    }

    const playlist = await request(base, '/api/playlists', apiSecret, {
      method: 'POST', body: JSON.stringify({ name: 'Core Check Playlist' }),
    });
    const item = await request(base, `/api/playlists/${playlist.id}/items`, apiSecret, {
      method: 'POST', body: JSON.stringify({ content_id: content.id, duration_sec: 12 }),
    });
    const published = await request(base, `/api/playlists/${playlist.id}/publish`, apiSecret, { method: 'POST' });
    if (!item.id || published.status !== 'published' || published.items.length !== 1) {
      throw new Error('playlist item or publish snapshot did not persist');
    }

    const layout = await request(base, '/api/layouts', apiSecret, {
      method: 'POST',
      body: JSON.stringify({ name: 'Core Check Layout', zones: [{ name: 'Main', width_percent: 100, height_percent: 100 }] }),
    });
    await request(base, `/api/layouts/device/${ids.device}`, apiSecret, {
      method: 'PUT', body: JSON.stringify({ layout_id: layout.id }),
    });
    const assignment = await request(base, `/api/assignments/device/${ids.device}`, apiSecret, {
      method: 'POST', body: JSON.stringify({ content_id: content.id, zone_id: layout.zones[0].id, duration_sec: 10 }),
    });
    const schedule = await request(base, '/api/schedules', apiSecret, {
      method: 'POST',
      body: JSON.stringify({
        device_id: ids.device,
        content_id: content.id,
        layout_id: layout.id,
        title: 'Core Check Schedule',
        start_time: '2026-01-01T09:00:00.000Z',
        end_time: '2026-01-01T17:00:00.000Z',
      }),
    });
    const schedules = await request(base, '/api/schedules', apiSecret);
    if (!assignment.id || !schedule.id || !schedules.some(row => row.id === schedule.id)) {
      throw new Error('layout, assignment, or schedule did not persist');
    }

    console.log('ok core Postgres slice: auth through layouts, assignments, and schedules');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main()
  .then(async () => {
    await cleanup();
    await pg.close();
    console.log('ok cleanup: temporary core rows removed');
  })
  .catch(async error => {
    console.error(error.stack || error.message);
    try { await cleanup(); } catch (cleanupError) { console.error(`cleanup failed: ${cleanupError.message}`); }
    try { await pg.close(); } catch {}
    process.exit(1);
  });
