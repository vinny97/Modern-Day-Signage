#!/usr/bin/env node
require('./load-env').loadEnv();
const path = require('path');
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(__dirname, '..', 'server')] }));
const config = require('../server/config');
const pg = require('../server/db/postgres');

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function asParams(values, offset = 0) {
  return values.map((_, i) => `$${i + 1 + offset}`).join(', ');
}

function tupleParams(columnCount, rowIndex) {
  const offset = rowIndex * columnCount;
  return `(${Array.from({ length: columnCount }, (_, i) => `$${offset + i + 1}`).join(', ')})`;
}

async function importTable(client, table, rows) {
  if (!rows.length) return 0;
  const columns = Object.keys(rows[0]);
  const chunkSize = parseInt(process.env.PG_IMPORT_CHUNK_SIZE || '100', 10);
  let imported = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params = [];
    for (const row of chunk) {
      for (const column of columns) params.push(row[column]);
    }

    const insertSql = `
      INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')})
      VALUES ${chunk.map((_, idx) => tupleParams(columns.length, idx)).join(', ')}
      ON CONFLICT DO NOTHING
    `;

    const result = await client.query(insertSql, params);
    imported += result.rowCount || 0;
  }

  return imported;
}

async function resetTables(client, tables) {
  if (!tables.length) return;
  await client.query(`TRUNCATE ${tables.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`);
}

async function importTableRowByRow(client, table, rows) {
  if (!rows.length) return 0;
  const columns = Object.keys(rows[0]);
  const insertSql = `
    INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')})
    VALUES (${asParams(columns)})
    ON CONFLICT DO NOTHING
  `;

  let count = 0;
  for (const row of rows) {
    await client.query(insertSql, columns.map((column) => row[column]));
    count += 1;
  }
  return count;
}

async function resetSerials(client) {
  const serials = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_default LIKE 'nextval(%'
  `);

  for (const row of serials.rows) {
    await client.query(`
      SELECT setval(
        pg_get_serial_sequence($1, $2),
        COALESCE((SELECT MAX(${quoteIdent(row.column_name)}) FROM ${quoteIdent(row.table_name)}), 1),
        (SELECT COUNT(*) > 0 FROM ${quoteIdent(row.table_name)})
      )
    `, [row.table_name, row.column_name]);
  }
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

  await pg.initSchema();

  await pg.transaction(async (client) => {
    if (process.env.PG_TRUNCATE_BEFORE_IMPORT === 'true') {
      await resetTables(client, tables);
      console.log(`reset ${tables.length} table(s)`);
    }

    for (const table of tables) {
      const rows = sqlite.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
      let count;
      try {
        count = await importTable(client, table, rows);
      } catch (err) {
        if (!process.env.PG_IMPORT_ROW_BY_ROW_ON_ERROR) throw err;
        console.warn(`${table}: batch import failed (${err.message}); retrying row-by-row`);
        count = await importTableRowByRow(client, table, rows);
      }
      console.log(`${table}: ${count}/${rows.length}`);
    }
    await resetSerials(client);
  });

  sqlite.close();
  await pg.close();
}

main().catch(async (err) => {
  console.error(err);
  try { await pg.close(); } catch {}
  process.exit(1);
});
