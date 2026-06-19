#!/usr/bin/env node
require('./load-env').loadEnv();
const path = require('path');
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(__dirname, '..', 'server')] }));
const config = require('../server/config');
const pg = require('../server/db/postgres');

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function main() {
  const sqlitePath = process.env.SQLITE_DB_PATH || config.dbPath;
  const sqlite = new Database(sqlitePath, { readonly: true });
  const tables = sqlite.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);

  let mismatches = 0;
  for (const table of tables) {
    const sqliteCount = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get().n;
    const result = await pg.query(`SELECT COUNT(*)::integer AS n FROM ${quoteIdent(table)}`);
    const pgCount = result.rows[0]?.n || 0;
    const ok = sqliteCount === pgCount;
    if (!ok) mismatches += 1;
    console.log(`${ok ? 'ok' : 'MISMATCH'} ${table}: sqlite=${sqliteCount} postgres=${pgCount}`);
  }

  sqlite.close();
  await pg.close();

  if (mismatches) {
    console.error(`${mismatches} table count mismatch(es)`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  try { await pg.close(); } catch {}
  process.exit(1);
});
