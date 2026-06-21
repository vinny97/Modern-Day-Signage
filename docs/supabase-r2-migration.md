# Supabase + Cloudflare R2 Migration

This project currently runs on SQLite (`better-sqlite3`) and local filesystem
uploads. The target free-friendly split is:

- Supabase Postgres for relational application data.
- Cloudflare R2 for uploaded content, thumbnails, screenshots, backups, and APKs.

R2 is object storage, not a relational database, so it should not replace
SQLite for users, devices, playlists, schedules, permissions, or audit data.

## Current Migration Slice

The migration currently includes Postgres tooling plus converted runtime
slices:

- `server/db/schema.postgres.sql` is a generated Postgres bootstrap schema.
- `server/db/postgres.js` exposes a small async `pg` pool/helper layer.
- `scripts/migrate-sqlite-to-postgres.js` initializes the Supabase schema and
  imports rows from the current SQLite database.
- `scripts/verify-postgres-import.js` compares SQLite and Postgres row counts
  after import.
- `server/db/client.js` provides an awaitable SQLite/Postgres facade with native
  Postgres transaction binding.
- Authentication, account bootstrap, MFA, SSO, profile, and workspace-context
  lookups use the facade. A real temporary registration has been verified
  against Supabase.
- API-token creation, revocation, authentication, and workspace binding use
  Postgres.
- Workspace rename, membership, invite flows, and device CRUD/listing use
  Postgres. `db:pg:verify-core` exercises these routes against temporary live
  Supabase rows and removes them afterward.
- Content metadata, folders, quota checks, playlists, items, item schedules,
  and publishing use Postgres. Uploaded file bytes remain on local storage
  until the R2 adapter is configured.
- Layouts, layout zones, device assignments, and schedules use Postgres and are
  covered by the temporary live Supabase verification workflow.
- `server/db/migrations/001_runtime_parity.sql` adds the tables and columns that
  legacy SQLite installs create through startup migrations.

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
npm run db:pg:verify-auth
npm run db:pg:verify-core
```

The full app still boots on SQLite until the remaining route/service call sites
are converted from sync `db.prepare(...).get/all/run` to async Postgres calls.
Do not set the deployed app's `DB_CLIENT=postgres` yet.

For a clean re-import into an existing Supabase database:

```bash
PG_TRUNCATE_BEFORE_IMPORT=true npm run db:pg:migrate
```

Use that only when the target Supabase database contains disposable imported
data. It truncates the imported application tables before loading SQLite rows.

## Remaining Work

- Convert device groups and video walls.
- Convert device/dashboard WebSockets and the shared preview payload builder.
- Convert admin/reporting/background services and user/org/workspace deletion helpers.
- Add a constraint-hardening migration for Postgres foreign keys.
- Move content file writes/reads/deletes to an R2-backed storage adapter.
- Update backup/restore flows so database exports and object storage are handled
  separately.
