'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createClient, createFacade, postgresSql } = require('../db/client');

test('postgresSql converts placeholders without touching quoted question marks', () => {
  assert.equal(
    postgresSql("SELECT '?' AS literal, id FROM users WHERE email = ? AND name = ?"),
    "SELECT '?' AS literal, id FROM users WHERE email = $1 AND name = $2"
  );
});

test('postgresSql converts shared SQLite timestamp and ignore syntax', () => {
  assert.equal(
    postgresSql("INSERT OR IGNORE INTO tokens (id, created_at) VALUES (?, strftime('%s','now'))"),
    'INSERT INTO tokens (id, created_at) VALUES ($1, EXTRACT(EPOCH FROM NOW())::BIGINT) ON CONFLICT DO NOTHING'
  );
});

test('SQLite client supports one, many, run, and rollback', async () => {
  const sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL)');
  const db = createClient({ client: 'sqlite', sqlite });

  const inserted = await db.run('INSERT INTO users (id, email) VALUES (?, ?)', ['u1', 'one@example.com']);
  assert.equal(inserted.rowCount, 1);
  assert.deepEqual(await db.one('SELECT * FROM users WHERE id = ?', ['u1']), { id: 'u1', email: 'one@example.com' });
  assert.equal((await db.many('SELECT * FROM users')).length, 1);

  await assert.rejects(db.transaction(async tx => {
    await tx.run('INSERT INTO users (id, email) VALUES (?, ?)', ['u2', 'two@example.com']);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(await db.one('SELECT id FROM users WHERE id = ?', ['u2']), null);
  await db.close();
});

test('Postgres client uses a native transaction and translated SQL', async () => {
  const calls = [];
  const tx = {
    one: async (sql, params) => { calls.push(['one', sql, params]); return { id: 'u1' }; },
    many: async () => [],
    run: async (sql, params) => { calls.push(['run', sql, params]); return { rowCount: 1 }; },
    query: async (sql, params) => { calls.push(['query', sql, params]); return { rowCount: 1, rows: [{ id: 42 }] }; },
  };
  const postgres = {
    ...tx,
    transaction: async fn => fn(tx),
    close: async () => {},
  };
  const db = createClient({ client: 'postgres', postgres });

  await db.transaction(async trx => {
    await trx.run("UPDATE users SET updated_at = strftime('%s','now') WHERE id = ?", ['u1']);
    assert.deepEqual(await trx.one('SELECT id FROM users WHERE id = ?', ['u1']), { id: 'u1' });
  });

  assert.equal(calls[0][1], 'UPDATE users SET updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1');
  assert.equal(calls[1][1], 'SELECT id FROM users WHERE id = $1');
});

test('Postgres runReturningId appends RETURNING id', async () => {
  const calls = [];
  const postgres = {
    one: async () => null, many: async () => [], run: async () => ({ rowCount: 0 }),
    query: async (sql, params) => { calls.push([sql, params]); return { rowCount: 1, rows: [{ id: 9 }] }; },
    transaction: async fn => fn(postgres), close: async () => {},
  };
  const db = createClient({ client: 'postgres', postgres });
  const result = await db.runReturningId('INSERT INTO items (name) VALUES (?)', ['x']);
  assert.equal(result.lastInsertRowid, 9);
  assert.equal(calls[0][0], 'INSERT INTO items (name) VALUES ($1) RETURNING id');
});

test('facade prepare shape stays transaction-bound', async () => {
  const sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE values_table (value TEXT)');
  const client = createClient({ client: 'sqlite', sqlite });
  const isolated = createFacade(() => client);

  const insert = isolated.transaction(async () => {
    await isolated.prepare('INSERT INTO values_table (value) VALUES (?)').run('bound');
  });
  await insert();
  assert.deepEqual(await isolated.many('SELECT value FROM values_table'), [{ value: 'bound' }]);
  await isolated.close();
});
