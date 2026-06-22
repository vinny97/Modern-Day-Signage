#!/usr/bin/env node
'use strict';

/**
 * Create or reset a platform-admin login, directly in whatever database the app
 * is configured to use. Works for Supabase/Postgres (DB_CLIENT=postgres with
 * DATABASE_URL / SUPABASE_DB_URL set) and for SQLite.
 *
 * It reads server/.env, so run it from the repo root in the same environment
 * the server uses.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='your-new-password' \
 *     node scripts/set-admin.js
 *
 *   # or positional:
 *   node scripts/set-admin.js you@example.com 'your-new-password'
 *
 * If a user with that email exists, its password is reset and it is promoted to
 * platform_admin with auth_provider='local'. If not, a new platform_admin is
 * created. Re-runnable; never deletes anything.
 */

require('./load-env').loadEnv();

const path = require('path');
const crypto = require('crypto');
const bcrypt = require(path.join(__dirname, '..', 'server', 'node_modules', 'bcryptjs'));
const { db } = require(path.join(__dirname, '..', 'server', 'db', 'client'));

const email = (process.env.ADMIN_EMAIL || process.argv[2] || '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || process.argv[3] || '';

async function main() {
  if (!email || !password) {
    console.error('Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret node scripts/set-admin.js');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  console.log(`Database client: ${db.client}`);
  const passwordHash = bcrypt.hashSync(password, 10);

  // `?` placeholders and strftime() are translated to Postgres automatically by
  // the DB client, so the same statements work on SQLite and Supabase.
  const existing = await db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);

  if (existing) {
    await db.prepare(`UPDATE users SET password_hash = ?, auth_provider = 'local',
      role = 'platform_admin', updated_at = strftime('%s','now') WHERE id = ?`)
      .run(passwordHash, existing.id);
    console.log(`Reset password and promoted existing user to platform_admin: ${email}`);
  } else {
    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO users (id, email, name, password_hash, auth_provider, role)
      VALUES (?, ?, ?, ?, 'local', 'platform_admin')`)
      .run(id, email, email.split('@')[0], passwordHash);
    console.log(`Created new platform_admin: ${email} (id ${id})`);
    console.log('Note: a brand-new admin has no workspace yet — create one in the app after logging in.');
  }

  await db.close();
  console.log('Done. Log in with that email + password.');
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
