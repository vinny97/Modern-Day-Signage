# Supabase + Cloudflare R2 Migration

This project currently runs on SQLite (`better-sqlite3`) and local filesystem
uploads. The target free-friendly split is:

- Supabase Postgres for relational application data.
- Cloudflare R2 for uploaded content, thumbnails, screenshots, backups, and APKs.

R2 is object storage, not a relational database, so it should not replace
SQLite for users, devices, playlists, schedules, permissions, or audit data.

## Current Migration Slice

The first slice adds Postgres tooling without switching the live app away from
SQLite:

- `server/db/schema.postgres.sql` is a generated Postgres bootstrap schema.
- `server/db/postgres.js` exposes a small async `pg` pool/helper layer.
- `scripts/migrate-sqlite-to-postgres.js` initializes the Supabase schema and
  imports rows from the current SQLite database.
- `scripts/verify-postgres-import.js` compares SQLite and Postgres row counts
  after import.

The bootstrap schema intentionally defers foreign keys. The SQLite schema has
references before target tables exist and a few circular relationships; importing
data first and tightening constraints later gives a safer migration path.

## Environment

Use a Supabase Postgres connection string. For free-tier deployments from
IPv4-only hosts, the Shared Pooler string is usually the practical choice:

```bash
DATABASE_URL='postgresql://postgres.jkbtfzmebgjzmjapsdmz:<YOUR-PASSWORD>@aws-1-eu-central-2.pooler.supabase.com:6543/postgres'
PGSSL=true
SQLITE_DB_PATH=/path/to/remote_display.db
PG_POOL_MAX=3
```

`SQLITE_DB_PATH` is optional. If omitted, the script uses the existing app
default from `server/config.js`. `PG_POOL_MAX=3` is conservative for Supabase's
shared pooler and is enough for the migration scripts.

Do not commit the real connection string. Put it in `server/.env` locally or set
it in the host's environment variables. The `db:pg:*` npm scripts load
`server/.env` automatically.

## Commands

From `server/`:

```bash
npm run db:pg:schema
npm run db:pg:migrate
npm run db:pg:verify
```

The app still boots on SQLite until route/service call sites are converted from
sync `db.prepare(...).get/all/run` to async Postgres calls.

For a clean re-import into an existing Supabase database:

```bash
PG_TRUNCATE_BEFORE_IMPORT=true npm run db:pg:migrate
```

Use that only when the target Supabase database contains disposable imported
data. It truncates the imported application tables before loading SQLite rows.

## Remaining Work

- Convert runtime DB access route-by-route to the async Postgres helper.
- Add a constraint-hardening migration for Postgres foreign keys.
- Move content file writes/reads/deletes to an R2-backed storage adapter.
- Update backup/restore flows so database exports and object storage are handled
  separately.
