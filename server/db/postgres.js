const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../config');

function makePool(options = {}) {
  const connectionString = options.connectionString || config.databaseUrl;
  if (!connectionString) {
    throw new Error('DATABASE_URL or SUPABASE_DB_URL is required when using Postgres/Supabase');
  }

  return new Pool({
    connectionString,
    ssl: config.pgSsl ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_TIMEOUT_MS || '10000', 10),
  });
}

let pool;

function getPool() {
  if (!pool) pool = makePool();
  return pool;
}

async function query(sql, params = []) {
  return getPool().query(sql, params);
}

async function one(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

async function many(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function run(sql, params = []) {
  const result = await query(sql, params);
  return { rowCount: result.rowCount };
}

async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const tx = {
      query: (sql, params = []) => client.query(sql, params),
      one: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return result.rows[0] || null;
      },
      many: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return result.rows;
      },
      run: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return { rowCount: result.rowCount };
      },
    };
    const value = await fn(tx);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.postgres.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await query(schema);

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;
  const migrations = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();
  for (const file of migrations) {
    await query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
}

async function close() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

module.exports = {
  getPool,
  query,
  one,
  many,
  run,
  transaction,
  initSchema,
  close,
};
