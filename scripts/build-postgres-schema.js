#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const inputPath = path.join(root, 'server', 'db', 'schema.sql');
const outputPath = path.join(root, 'server', 'db', 'schema.postgres.sql');

let sql = fs.readFileSync(inputPath, 'utf8');

sql = sql
  .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGSERIAL PRIMARY KEY')
  .replace(/DEFAULT \(strftime\('%s','now'\)\)/g, 'DEFAULT (EXTRACT(EPOCH FROM now())::integer)')
  .replace(/\bREAL\b/g, 'DOUBLE PRECISION')
  .replace(/INSERT OR IGNORE INTO ([\s\S]*?);/g, (match) => (
    match.replace('INSERT OR IGNORE', 'INSERT').replace(/;$/, '\nON CONFLICT DO NOTHING;')
  ));

// Bootstrap mode: keep table creation/import simple. The SQLite schema defines
// several references before the target tables exist, and some tables participate
// in cycles. Add hardened Postgres foreign keys in a later migration after the
// raw import path is verified.
sql = sql.replace(/\s+REFERENCES\s+[A-Za-z_][A-Za-z0-9_]*(?:\([^)]+\))?(?:\s+ON\s+DELETE\s+(?:CASCADE|SET NULL|RESTRICT|NO ACTION))?/g, '');

sql = `-- Generated from server/db/schema.sql by scripts/build-postgres-schema.js.
-- Bootstrap schema for Supabase/Postgres migration. Foreign keys are deferred
-- to a follow-up hardening migration so existing SQLite data can be imported
-- before table-order and circular-reference constraints are tightened.

${sql}
`;

fs.writeFileSync(outputPath, sql);
console.log(`Wrote ${path.relative(root, outputPath)}`);
