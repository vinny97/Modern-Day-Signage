#!/usr/bin/env node
'use strict';

require('./load-env').loadEnv();

const crypto = require('crypto');
process.env.DB_CLIENT = 'postgres';
process.env.SELF_HOSTED = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

const express = require(require.resolve('express', { paths: [require('path').join(__dirname, '..', 'server')] }));
const http = require('http');
const pg = require('../server/db/postgres');

const email = `migration-check-${crypto.randomUUID()}@example.invalid`;
let userId;
let orgId;
let workspaceId;

async function cleanup() {
  const user = userId
    ? { id: userId }
    : await pg.one('SELECT id FROM users WHERE email = $1', [email]);
  if (!user) return;

  const orgs = await pg.many('SELECT id FROM organizations WHERE owner_user_id = $1', [user.id]);
  await pg.transaction(async tx => {
    await tx.run('DELETE FROM activity_log WHERE user_id = $1', [user.id]);
    for (const org of orgs) {
      const workspaces = await tx.many('SELECT id FROM workspaces WHERE organization_id = $1', [org.id]);
      for (const workspace of workspaces) {
        await tx.run('DELETE FROM workspace_invites WHERE workspace_id = $1', [workspace.id]);
        await tx.run('DELETE FROM workspace_members WHERE workspace_id = $1', [workspace.id]);
        await tx.run('DELETE FROM workspaces WHERE id = $1', [workspace.id]);
      }
      await tx.run('DELETE FROM organization_members WHERE organization_id = $1', [org.id]);
      await tx.run('DELETE FROM organizations WHERE id = $1', [org.id]);
    }
    await tx.run('DELETE FROM workspace_members WHERE user_id = $1', [user.id]);
    await tx.run('DELETE FROM organization_members WHERE user_id = $1', [user.id]);
    await tx.run('DELETE FROM users WHERE id = $1', [user.id]);
  });
}

async function main() {
  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) {
    throw new Error('DATABASE_URL or SUPABASE_DB_URL is required');
  }

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../server/routes/auth'));
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
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'MigrationCheck123!',
        name: 'Migration Check',
      }),
    });
    const body = await response.json();
    if (response.status !== 201) {
      throw new Error(`registration returned ${response.status}: ${JSON.stringify(body)}`);
    }

    userId = body.user.id;
    const user = await pg.one('SELECT id FROM users WHERE id = $1', [userId]);
    const org = await pg.one('SELECT id FROM organizations WHERE owner_user_id = $1', [userId]);
    const workspace = org
      ? await pg.one('SELECT id FROM workspaces WHERE organization_id = $1', [org.id])
      : null;
    if (!user || !org || !workspace) throw new Error('registration did not create all tenancy rows');
    orgId = org.id;
    workspaceId = workspace.id;

    console.log('ok registration: user, organization, and workspace are in Postgres');
  } finally {
    await cleanup();
    await new Promise(resolve => server.close(resolve));
  }
}

main()
  .then(async () => {
    await pg.close();
    console.log('ok cleanup: temporary registration removed');
  })
  .catch(async error => {
    console.error(error.stack || error.message);
    try { await cleanup(); } catch (cleanupError) { console.error(`cleanup failed: ${cleanupError.message}`); }
    try { await pg.close(); } catch {}
    process.exit(1);
  });
