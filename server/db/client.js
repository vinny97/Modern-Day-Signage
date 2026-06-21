'use strict';

const config = require('../config');
const { AsyncLocalStorage } = require('node:async_hooks');

function postgresSql(sql) {
  let normalized = String(sql)
    .replace(/strftime\(\s*'%s'\s*,\s*'now'\s*\)/gi, 'EXTRACT(EPOCH FROM NOW())::BIGINT')
    .replace(/CAST\(strftime\(\s*'%H'\s*,\s*([^,]+),\s*'unixepoch'\s*,\s*'localtime'\s*\)\s+AS\s+INTEGER\)/gi,
      "EXTRACT(HOUR FROM to_timestamp($1) AT TIME ZONE current_setting('TIMEZONE'))::INTEGER")
    .replace(/date\(\s*([^,]+),\s*'unixepoch'\s*,\s*'localtime'\s*\)/gi,
      "TO_CHAR(to_timestamp($1) AT TIME ZONE current_setting('TIMEZONE'), 'YYYY-MM-DD')")
    .replace(/GROUP_CONCAT\(\s*([^,)]+)\s*\)/gi, "STRING_AGG(($1)::text, ',')")
    .replace(/\s+COLLATE\s+NOCASE\b/gi, '')
    .replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, match => match.replace(/OR\s+IGNORE\s+/i, ''));

  let output = '';
  let parameter = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (lineComment) {
      output += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      output += char;
      if (char === '*' && next === '/') {
        output += next;
        i += 1;
        blockComment = false;
      }
      continue;
    }
    if (!quote && char === '-' && next === '-') {
      output += char + next;
      i += 1;
      lineComment = true;
      continue;
    }
    if (!quote && char === '/' && next === '*') {
      output += char + next;
      i += 1;
      blockComment = true;
      continue;
    }
    if (quote) {
      output += char;
      if (char === quote) {
        if (next === quote) {
          output += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      continue;
    }
    if (char === '?') {
      output += `$${++parameter}`;
      continue;
    }
    output += char;
  }

  if (/^\s*INSERT\s+INTO\b/i.test(output)
      && /^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(String(sql))
      && !/\bON\s+CONFLICT\b/i.test(output)) {
    const semicolon = output.match(/;\s*$/);
    if (semicolon) output = output.slice(0, semicolon.index) + ' ON CONFLICT DO NOTHING' + semicolon[0];
    else output += ' ON CONFLICT DO NOTHING';
  }

  return output;
}

function sqliteAdapter(sqlite) {
  return {
    async one(sql, params = []) {
      return sqlite.prepare(sql).get(...params) || null;
    },
    async many(sql, params = []) {
      return sqlite.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      const result = sqlite.prepare(sql).run(...params);
      return {
        rowCount: result.changes,
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    },
    async runReturningId(sql, params = []) {
      const result = sqlite.prepare(sql).run(...params);
      return { rowCount: result.changes, changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
  };
}

function postgresAdapter(postgres) {
  return {
    async one(sql, params = []) {
      return postgres.one(postgresSql(sql), params);
    },
    async many(sql, params = []) {
      return postgres.many(postgresSql(sql), params);
    },
    async run(sql, params = []) {
      const result = await postgres.run(postgresSql(sql), params);
      return { rowCount: result.rowCount, changes: result.rowCount };
    },
    async runReturningId(sql, params = []) {
      let statement = postgresSql(sql).replace(/;\s*$/, '');
      if (!/\bRETURNING\b/i.test(statement)) statement += ' RETURNING id';
      const result = await postgres.query(statement, params);
      return { rowCount: result.rowCount, changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
    },
    async exec(sql) {
      await postgres.query(postgresSql(sql));
    },
  };
}

function createClient(options = {}) {
  const client = (options.client || config.dbClient).toLowerCase();

  if (client === 'postgres' || client === 'postgresql' || client === 'supabase') {
    const postgres = options.postgres || require('./postgres');
    const adapter = postgresAdapter(postgres);
    return {
      client: 'postgres',
      ...adapter,
      transaction: (fn) => postgres.transaction(tx => fn({ client: 'postgres', ...postgresAdapter(tx) })),
      close: () => postgres.close(),
    };
  }

  if (client !== 'sqlite') throw new Error(`Unsupported DB_CLIENT: ${client}`);
  const sqlite = options.sqlite || require('./database').db;
  const adapter = sqliteAdapter(sqlite);
  let transactionTail = Promise.resolve();

  return {
    client: 'sqlite',
    ...adapter,
    async transaction(fn) {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        sqlite.exec('BEGIN IMMEDIATE');
        const value = await fn({ client: 'sqlite', ...adapter });
        sqlite.exec('COMMIT');
        return value;
      } catch (error) {
        try { sqlite.exec('ROLLBACK'); } catch {}
        throw error;
      } finally {
        release();
      }
    },
    async close() {
      sqlite.close();
    },
  };
}

function createFacade(resolveClient) {
  const transactionStorage = new AsyncLocalStorage();
  const currentClient = () => transactionStorage.getStore() || resolveClient();
  const facade = {
    get client() { return currentClient().client; },
    one: (...args) => currentClient().one(...args),
    many: (...args) => currentClient().many(...args),
    run: (...args) => currentClient().run(...args),
    runReturningId: (...args) => currentClient().runReturningId(...args),
    exec: (...args) => currentClient().exec(...args),
    prepare(sql) {
      return {
        get: (...params) => facade.one(sql, params),
        all: (...params) => facade.many(sql, params),
        run: (...params) => facade.run(sql, params),
        runReturningId: (...params) => facade.runReturningId(sql, params),
      };
    },
    async withTransaction(fn) {
      const current = transactionStorage.getStore();
      if (current) return fn(current);
      return currentClient().transaction(tx => transactionStorage.run(tx, () => fn(tx)));
    },
    transaction(fn) {
      return (...args) => facade.withTransaction(() => fn(...args));
    },
    close: (...args) => currentClient().close(...args),
  };
  return facade;
}

let defaultClient;
const db = createFacade(() => {
  if (!defaultClient) defaultClient = createClient();
  return defaultClient;
});

module.exports = { db, createClient, createFacade, postgresSql };
