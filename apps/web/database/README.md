# YMT School Management: database

PostgreSQL schema, Prisma configuration, migrations, a fictional development
seed, constraint tests and a target-safety guard. Design rationale:
[`../docs/database-design.md`](../docs/database-design.md).

> **Status: Phase 2 foundation. Not production-ready.** No API, authentication,
> row-level security, backup plan or deployment exists yet. See "Known gaps".

## Layout

| Path | Purpose |
| --- | --- |
| `prisma/schema.prisma` | Prisma data model (typed client, relations) |
| `prisma/migrations/` | Versioned SQL migrations: the source of truth for the database |
| `seeds/dev_seed.sql` | **Fictional** development data. Never runs automatically |
| `tests/constraints.test.sql` | 70 database constraint checks (isolation, uniqueness, history) |
| `scripts/lib/target.mjs` | Target guard: decides which databases may be touched |
| `scripts/run-sql.mjs` | Runs the seed or the tests, only after the guard approves |
| `scripts/migrate-deploy.mjs` | Runs `prisma migrate deploy`, only after the guard approves |
| `scripts/target.test.mjs` | Unit tests for the guard (no database needed) |
| `.env.example` | Placeholders only. Copy to `.env` (ignored by Git) |

Two migrations exist. `..._init` is what Prisma would generate. `..._integrity_constraints`
is hand-written SQL for rules Prisma cannot express (CHECK, EXCLUDE, triggers).
To change the schema later, add a **new** migration; never edit an applied one.

## 1. What needs a database connection and what does not

Run everything from the `database/` folder. On Windows PowerShell use `npm.cmd`
if `npm` is blocked.

**No database connection needed** (after `npm install`):

| Command | What it checks |
| --- | --- |
| `npm run test:guard` | The target-safety guard and migration-target workflow (40 tests, no database) |
| `npm run prisma:validate` | The Prisma schema is valid (see note) |
| `npm run prisma:generate` | The typed client generates |
| `npm run db:check` | **Dry run**: prints the seed target and whether the guard allows it. No connection |
| `npm run db:check:test` | Same, for the test database |

Note: `prisma validate` normally still requires `DATABASE_URL` to be *defined*
(not reachable). A copied `.env` with placeholders is enough. Neither Prisma
command was runnable where this was written (see section 7).

**Needs a connection, read-only** (safe against any database, they change nothing):

| Command | What it does |
| --- | --- |
| `npm run db:migrate:status` | Compares applied migrations with the files |
| `npm run db:drift-check` | Compares the live schema with `schema.prisma`. Exit code 0 means identical |

**Needs a connection and CHANGES the database** (guarded; each needs your explicit approval):

| Command | What it does |
| --- | --- |
| `npm run db:migrate:deploy` | Applies pending migrations. Never resets or drops anything |
| `npm run db:seed` | Inserts fictional demo data. Repeatable |
| `npm run db:test` | Runs 70 checks inside a transaction that is rolled back (leaves nothing behind) |

## Choosing the database (read this before any migration)

**Prisma has a hidden default.** If `DATABASE_URL` is not set in the shell, Prisma quietly
loads the file `apps/web/database/.env` and uses *its* `DATABASE_URL` (the development
database). A plain `npx prisma migrate deploy` therefore always hits `ymt_dev`, whatever you
meant. On 2026-10-18 this applied `20261012000000_auth_credentials_sessions` to `ymt_dev`
instead of `ymt_test`.

All migration commands now go through `scripts/migrate-deploy.mjs`, which has **no default
target** and fails closed:

1. you must name the target: `--target=dev` or `--target=test`;
2. the URL comes from that target's own variable (`DATABASE_URL` for dev,
   `TEST_DATABASE_URL` for test) and is handed to Prisma explicitly;
3. the database name must fit the target (`*_dev` / `*_test`) and dev and test must differ;
4. an applying run must repeat the database name (`--confirm-database=ymt_test`);
5. before applying, it runs `prisma migrate status` (read-only) and compares the
   `Datasource "db": ... database "<name>" at "<host:port>"` line Prisma prints with the plan.
   Any mismatch, or an unreadable line, stops everything (exit 4) without applying.

| Command (project root) | What it does |
|---|---|
| `npm run db:migrate:plan:test` | Shows the plan for the test database. **No connection** |
| `npm run db:migrate:status:test` / `:dev` | Read-only: which database, which migrations are pending |
| `npm run db:migrate:deploy:test` | Applies pending migrations to the **test** database only (after the checks above) |
| `npm run db:migrate:deploy` | Refuses: no target was named |
| `npm run db:target` | Shows where each `.env` points (no values), and which database a bare `prisma` command would use |

There is intentionally no `db:migrate:deploy:dev` script. Applying to the development
database means typing the full command yourself:
`node --env-file=.env scripts/migrate-deploy.mjs --target=dev --confirm-database=ymt_dev`.

Do not run `prisma migrate ...` directly in this folder. Tests: `npm run test:guard`
(unit tests plus end-to-end tests of the wrapper against a fake `npx`; no database needed).

**Do not use** `prisma migrate dev`, `migrate reset`, `db push` or `db pull`
against Supabase. `migrate dev` can offer to *reset* a database it thinks has
drifted. Create new migrations only against a throwaway local database.

## 2. Connecting Prisma to Supabase

Facts below come from the Supabase and Prisma documentation (links at the end);
the connection steps themselves have **not** been run against your project.

- **Use the session pooler for now** (`...pooler.supabase.com`, port **5432**,
  user `prisma.<PROJECT_REF>`). Supabase recommends it for a long-running,
  server-based app, for both migrations and runtime, and it works over IPv4.
- **Direct connection** (`db.<PROJECT_REF>.supabase.co:5432`) also works, but
  Supabase documents it as requiring IPv6 or the paid IPv4 add-on. Many home and
  office networks are IPv4-only, so start with the session pooler.
- **Do not use the transaction pooler (port 6543)** for migrations, the seed or
  the tests. Our guard refuses it. It is meant for serverless runtimes.
- **Connection pooling later (Phase 3).** If the API runs as a normal long-lived
  server, keep the session pooler for runtime and migrations. If it runs
  serverless, use the transaction pooler (6543, `?pgbouncer=true`) for the
  running app and keep a direct or session URL separately for migrations. That
  needs a second connection setting (`directUrl` in Prisma 6, or the config-file
  model in Prisma 7). It is a Phase 3 decision, not made here.
- **Database name.** Supabase's database is called `postgres`. The seed/tests'
  `_dev`/`_test` name rule therefore cannot pass, by design. The explicit approval
  in section 4 exists for this case; the name rule itself is unchanged.
- **Password encoding.** Special characters in the password must be URL-encoded in
  `DATABASE_URL` (`@` becomes `%40`, `/` becomes `%2F`, `!` becomes `%21`).
- **Never paste credentials into chat, issues or commits.** Only `.env` holds
  them, and Git ignores it.

## 3. One-time Supabase preparation (you do this in the dashboard)

These change your dev project. They are your decisions to make; nothing in this
repository does them for you. Use the SQL Editor on **`ymt-school-management-dev`** only.

1. **Create a dedicated migration role** instead of using the main `postgres`
   user (the Supabase Prisma guide recommends this). Replace the placeholder
   with a long random password generated by a password manager:

   ```sql
   create user "prisma" with password 'PASTE_A_LONG_RANDOM_PASSWORD_HERE';
   grant "prisma" to "postgres";
   grant usage, create on schema public to "prisma";
   ```

   The SQL Editor keeps query history, so treat that password as exposed to
   anyone with dashboard access and rotate it if that matters.

2. **Pre-install the `btree_gist` extension** as the privileged user:

   ```sql
   create extension if not exists btree_gist with schema extensions;
   ```

   Why: migration 2 runs `CREATE EXTENSION IF NOT EXISTS btree_gist`. A role that
   is not the database owner is denied that ("permission denied to create
   extension"), which was reproduced in a local simulation. Once the extension
   exists the migration step is a harmless no-op. Having it in Supabase's
   `extensions` schema was also tested and causes no problem.

3. **Find your project reference** (dashboard > Project Settings > General >
   Reference ID, 20 lowercase characters) and copy the **Session pooler**
   connection string from the Connect dialog. In it, change the user to
   `prisma.<PROJECT_REF>`.

4. **Decide about the Supabase Data API** (see "Security note" below).

## 4. Target safety: how the guard works

Nothing runs automatically. The seed, the tests and `db:migrate:deploy` first
pass the guard in `scripts/lib/target.mjs`, which refuses by default.

A target is allowed only if **either**:

1. **The database name ends in `_dev` or `_test`** (the original rule, unchanged), **or**
2. **It is a recognised Supabase project that you approved in three places that all agree:**
   - `YMT_ENV` is `development` or `test` in `.env`;
   - `YMT_APPROVED_TARGET_REF` in `.env` lists that project's reference ID;
   - you typed `--approve-target=<project ref>` on the command line for this run.

Always refused: `YMT_ENV=production` (or any other value), a database named
`postgres` on any host that is not a recognised Supabase project, the
transaction pooler (port 6543), SQL files outside `seeds/` and `tests/`, a
connection string with no database name, and any connection string containing
`host`, `hostaddr`, `port`, `dbname`, `user`, `password`, `service`, `servicefile`
or `passfile` parameters. (psql obeys those parameters over the URL itself, so the
guard could approve one server while psql connected to another. This was
reproduced locally and is now refused.)

The SQL files repeat the check inside the database. The seed additionally refuses
if the database holds any school that is not a `demo-` school, **even when
approved**. The tests additionally refuse unless the database is **empty**.

The guard protects against accidents such as a wrong URL in `.env` or a stale
terminal. It is not a defence against someone who edits the scripts.

## 5. Safe workflow for the Supabase dev project

Steps marked **STOP** change your database. Do not run them until you are ready.

```text
1  copy .env.example to .env and fill it in (your machine only)
2  npm install
3  npm run test:guard                  offline: guard logic
4  npm run prisma:validate             offline: schema valid
   npm run prisma:generate             offline: client generates
5  npm run db:check                    dry run: shows target, host, role, project ref
                                       and whether the guard allows it. No connection.
6  npm run db:migrate:status           connects, read-only. A fresh project should list
                                       both migrations as not yet applied.
7  STOP  npm run db:migrate:deploy -- --approve-target=<project ref>
8  npm run db:migrate:status           both migrations applied
   npm run db:drift-check              exit code 0 (see section 7)
9  tests on an EMPTY database (section 6)
10 STOP  npm run db:seed -- --approve-target=<project ref>
```

If step 6 or 7 reports that the schema is **not empty** (Prisma error P3005),
stop and report it; do not "fix" it with a reset.

## 6. Running the 70 constraint tests safely

The tests insert their own fixtures and assume an **empty** database, then roll
back, so they leave nothing behind. They refuse to run on a database that holds
any school, user or student. Use one of:

1. **A separate local test database (recommended).** Create an empty database whose
   name ends in `_test`, migrate it, point `TEST_DATABASE_URL` at it, then run
   `npm run db:check:test` followed by `npm run db:test`. Needs local PostgreSQL 13+
   with `psql` on your PATH.
2. **A second, empty Supabase project** for tests. Put both project refs in
   `YMT_APPROVED_TARGET_REF`, separated by a comma, point `TEST_DATABASE_URL` at
   the test project, and pass `--approve-target=<test project ref>`.
3. **The dev project, after migrating and before seeding.** Works because the
   tests roll back and require an empty database, but it is the least isolated
   option. Never after seeding: the tests will refuse.

## 7. What has been verified

**Executed on 12 October 2026** in a Linux workspace with PostgreSQL 16.15,
psql 16.15 and Node 22.22, using the exact files in this folder (both migrations
were confirmed byte-identical to Phase 2 by checksum). No connection to Supabase
was made: no credentials were provided or used.

| Check | Result |
| --- | --- |
| Guard unit tests (`npm run test:guard`) | 19 passed, 0 failed |
| Guard CLI, dry run (no connection possible): local `_dev` allowed; Supabase refused with nothing approved, with only the `.env` approval, with only the flag, with a wrong ref in the flag, on the transaction pooler, and under `YMT_ENV=production`; allowed only with all three approvals; SQL files outside `seeds/`/`tests/` and `../` path escapes refused; `db:migrate:deploy` guarded the same way; no password in any output | Passed |
| Guard bypass found and fixed: `?host=` or `?dbname=` in the URL redirected psql away from the checked target. Now refused, with tests | Reproduced, fixed, 2 new tests pass |
| Both migrations on an empty `_test` database, then 70 constraint tests through `run-sql.mjs`; 0 rows left behind | 70 passed, 0 failed |
| Same on a database NOT named `_dev`/`_test` (stand-in for Supabase's `postgres`), run with psql directly: tests and seed refused without approval; refused with a malformed approval value; ran when approved (tests 70/70) | Passed |
| Seed twice leaves identical counts (2 schools, 7 students, 8 enrollments); tests refuse a seeded database; seed refuses a non-demo school even when approved | Passed |
| Limited role (not the database owner, `CREATE` on schema `public` only), `btree_gist` NOT pre-installed: migration 1 applies, **migration 2 fails** with `permission denied to create extension "btree_gist"` | Reproduced |
| Same role after an admin pre-installs `btree_gist` into a separate `extensions` schema: migration 2 applies (no-op notice) and all 70 tests pass with `search_path=public` | Passed |
| `schema.prisma` matches the database: tables, columns, nullability, enums, 30 index names, 23 foreign keys and their RESTRICT actions (one-off script, not Prisma) | Passed |

**Not executed (Prisma could not be installed here: the package registry is blocked):**
`prisma validate`, `prisma generate`, `prisma migrate status`, `prisma migrate deploy`,
`db:drift-check`, and `scripts/migrate-deploy.mjs` beyond its dry run. Note that
`prisma generate` needs internet access to download Prisma's engine files, but not a database.

`db:drift-check` may report the indexes that back the EXCLUDE constraints, which
Prisma does not model. That expectation is untested; if it appears, paste the
output rather than acting on it.

**Not executed at all:** any connection to Supabase (so the `prisma` role steps, the
Supabase extension step, the session pooler and the Data API checks are all
unverified there), performance, concurrency, other PostgreSQL versions, backups.

**Known limits of the guard:** it prevents accidents, not deliberate bypass. The
`approved_target` value passed to the SQL files is only a flag the wrapper sets;
the database cannot confirm which project it is. Because the tests roll back and
require an empty database, and the seed refuses non-demo schools, a wrong-target
run could at worst add the two demo schools. A remote host that is not Supabase is
accepted if its database name ends in `_dev` or `_test` (the original rule).

## Security note: the Supabase Data API

Supabase can expose tables in the `public` schema over an automatic REST/GraphQL
API using public keys. This project uses Prisma and, later, its own API, not
that Data API, so exposed tables would be an unwanted second door around school
isolation.

Per Supabase's documentation, new tables are no longer exposed automatically for
new projects (rolled out from 30 May 2026), and the same applies to all existing
projects from **30 October 2026**. Your project's actual state is unknown, so check it
(read-only) after migrating:

```sql
-- Which API roles can access our tables? Expect no rows.
select grantee, table_name, string_agg(privilege_type, ', ')
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
group by grantee, table_name order by table_name, grantee;

-- Is row-level security enabled? (false is expected for now; see decision D12)
select c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by 1;
```

Strongest simple protection: turn the **Data API off** for this project in the
dashboard, since nothing here uses it. Never put the project's public (anon) key
in the frontend as a data path. Whether to also enable row-level security on all
tables is decision D12 in the design doc.

## Known gaps before any real launch

See design doc section 12. In short: no authentication or authorisation, no API,
no row-level security, no API-level isolation tests, no backup/restore or
point-in-time recovery, no production role separation, and dates-inside-year rules
are not enforced by the database. Do not put real student data in the dev project.

## Pinned Prisma version

`package.json` pins Prisma **6.x** (`^6.0.0`). The current Supabase and Prisma
guides describe a newer configuration style (`prisma.config.ts`, driver adapters).
Upgrading is a separate, deliberate task (decision D9); nothing here depends on it.

## References

- [Supabase: Prisma guide](https://supabase.com/docs/guides/database/prisma)
- [Supabase: Hardening the Data API](https://supabase.com/docs/guides/api/hardening-data-api)
- [Supabase changelog: new tables not exposed to the Data API automatically](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
- [Prisma: Supabase](https://www.prisma.io/docs/v6/orm/overview/databases/supabase)
