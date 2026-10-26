# YMT School Management: Database Design (Phase 2)

Status: **designed and implemented as SQL migrations plus a Prisma schema. The SQL is verified on PostgreSQL 16; the Prisma tooling is NOT yet verified.**
See "Verification status" (section 13) for exactly what has and has not been tested.
Not production-ready: see section 12.

## 1. Principles

1. **School isolation is a database property, not only an application rule.**
   Every school-owned row carries a `school_id`, and relationships between
   school-owned rows use *composite foreign keys that include `school_id`*, so
   PostgreSQL itself rejects a link across two schools.
2. **History is never overwritten.** Promotions and class changes create new
   enrollment rows. Foreign keys use `RESTRICT`; nothing cascades a delete.
3. **Constraints live in the database.** Uniqueness, date ranges, overlap
   rules and status rules are enforced by PostgreSQL, so every future client
   (API, scripts, admin tools) gets the same protection.
4. **Collect the minimum.** Only fields with a school-operations purpose are
   stored. See "Data we deliberately do not collect".
5. **Migrations only.** The schema changes through versioned migration files,
   never by hand-editing a database.

## 2. Conventions

| Topic | Rule |
| --- | --- |
| Table and column names | `snake_case`, tables plural (`students`) |
| Primary keys | `uuid`, default `gen_random_uuid()` (built into PostgreSQL 13+). UUIDs are not guessable and not tied to insertion order or school size |
| Timestamps | `timestamptz(3)`; `created_at` and `updated_at` on mutable tables. `updated_at` is maintained by Prisma (`@updatedAt`); raw SQL writers must set it |
| Dates without time | `date` (term dates, date of birth, enrollment dates) |
| Enumerations | PostgreSQL enum types (`student_status`, ...). Adding a value is a small migration; removing one is deliberately hard |
| Money (future) | `numeric(12,2)` (exact decimal) in Ghana cedis pesewas precision, or integer pesewas. **Never `float`/`double`.** Finance tables are out of scope for this phase |
| Referential actions | `ON DELETE RESTRICT ON UPDATE RESTRICT` on every foreign key, chosen on purpose (section 8) |
| Text normalisation | Enforced with `CHECK` constraints (email lowercase, admission numbers uppercase, phone in E.164) so bad data cannot enter even if an app forgets to normalise |

## 3. Entity overview

```
platform_staff ──< support_access_grants >── schools
      │                                         │
    users ──< school_memberships >──────────────┤
      │            │                            │
      │     school_membership_roles             ├──< academic_years ──< terms
      │                                         ├──< classes
  audit_events ───────────────────────────────>─┤──< subjects
                                                ├──< students ──< student_guardians >── guardians
                                                └──< enrollments  (student + class + academic_year)
```

## 4. Entities

### 4.1 `schools`

One row per school on the platform (the tenant).

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `code` | text | no | Unique, lowercase slug (`demo-sunrise`), 3 to 40 chars, `^[a-z0-9]+(-[a-z0-9]+)*$`. Used in URLs and support conversations. **Policy: assigned by YMT staff at onboarding and never changed** (immutability is an application rule) |
| `name` | text | no | Display name |
| `status` | `school_status` | no | `ACTIVE` or `SUSPENDED` (default `ACTIVE`). Suspension blocks access without deleting data |
| `contact_email`, `contact_phone`, `address` | text | yes | Optional; a school can onboard before supplying them |
| `created_at`, `updated_at` | timestamptz | no | |

### 4.2 `users`

A human account. Not tied to any school.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `email` | text | no | **Normalisation policy: trimmed and lowercased by the application before insert; a `CHECK` rejects anything else.** Unique across the platform. (Lowercasing the whole address is a deliberate simplification; it matches how all mainstream providers treat addresses) |
| `full_name` | text | no | Needed to show who did what |
| `status` | `user_status` | no | `INVITED` (default), `ACTIVE`, `DISABLED` |

**No password column.** Credentials and sessions are Phase 4. Likely design:
a separate `user_credentials` table (hash only) and a `sessions` table that
stores hashed tokens, kept apart from `users` so ordinary queries never touch
secrets.

A user has **no access to any school** until a `school_memberships` row exists.

### 4.3 Memberships and roles

`school_memberships` links one user to one school.

- `UNIQUE (school_id, user_id)`: one membership per user per school.
- `status`: `INVITED`, `ACTIVE`, `SUSPENDED`, `ENDED`. Ending a membership
  keeps the row (history, audit references).
- A user may hold memberships in several schools (a teacher at two schools).

`school_membership_roles` holds the roles within that membership.

- Roles: `OWNER`, `HEADTEACHER`, `ADMINISTRATOR`, `TEACHER`, `BURSAR`.
- Primary key `(membership_id, role)`: **a membership can hold several roles**
  (an owner who is also the headteacher; a teacher who also does bursar duties),
  without duplicating the membership.

**Why an enum plus a join table, not a free-form permission system yet:** the
five roles are fixed by the product. Authorisation (what a role may do) lives
in application code as a role-to-permission map, which is easy to read and
test. **Later extension:** if schools need custom roles, add `roles` and
`role_permissions` tables, add a nullable `role_id` to
`school_membership_roles`, and migrate the enum values into seeded system
roles. Nothing in the current design blocks that.

### 4.4 Platform support access (separate from school membership)

- `platform_staff (user_id PK/FK, role)`: marks a user as YMT platform staff
  (`SUPPORT` or `ADMIN`). It grants **no** school access by itself.
- `support_access_grants`: an explicit, **time-boxed** grant of one staff user
  to one school, with a mandatory `reason`, `granted_by_user_id`, `starts_at`,
  `expires_at` and optional `revoked_at`. A `CHECK` caps a grant at 7 days.
  Support sees a school's data only while a valid grant exists, and every use
  must produce an audit event.

### 4.5 `academic_years` and `terms`

Fully school-defined; no universal three-term year is assumed.

`academic_years`: `name` (e.g. `2026/2027`), `start_date`, `end_date`,
`status` (`PLANNED`, `ACTIVE`, `CLOSED`).

- `UNIQUE (school_id, name)`.
- `CHECK (end_date > start_date)`.
- **No two years of one school may overlap** (exclusion constraint).
- **At most one `ACTIVE` year per school** (exclusion constraint).
- `UNIQUE (id, school_id)`: lets child tables point at it with a composite key.

`terms`: belongs to a year; `name`, `sequence` (1, 2, 3...; positive),
`start_date`, `end_date`, `status`.

- Composite FK `(academic_year_id, school_id)` to `academic_years(id, school_id)`.
- `UNIQUE (academic_year_id, sequence)` and `UNIQUE (academic_year_id, name)`.
- `CHECK (end_date > start_date)`; **no overlapping terms within a year**;
  **at most one `ACTIVE` term per school**.
- A school may have two, three or more terms per year; each is just a row.

*Not enforced in the database:* that a term's dates lie inside its year's
dates. That needs a cross-table trigger; it is an application validation for
now and is listed under risks.

### 4.6 `classes` and `subjects`

`classes`: school-specific groups of pupils. `name` is free text chosen by the
school (`Primary 4 A`, `Primary 4 Gold`), so streams are just separate classes.
`level` is `NURSERY`, `KINDERGARTEN`, `PRIMARY` or `JHS`. `sort_order` supports
promotion ordering later; `is_active` archives a class instead of deleting it.
`UNIQUE (school_id, name)`: two schools can both have "Primary 4".

`subjects`: `name`, optional `code`, `is_active`. `UNIQUE (school_id, name)` and
`UNIQUE (school_id, code)` (unique only when a code is set).

Which classes are taught which subjects, and by whom, is a later academics
phase.

### 4.7 `students`

Identity profile only. **Class membership is not stored here.**

| Column | Notes |
| --- | --- |
| `school_id` | owner |
| `admission_number` | **Policy: trimmed and UPPERCASE** (enforced by `CHECK`) so `adm/01` and `ADM/01` cannot become two students. `UNIQUE (school_id, admission_number)`: unique inside a school, reusable across schools |
| `first_name`, `middle_name?`, `last_name` | |
| `date_of_birth?`, `admitted_on?` | optional |
| `status` | `ACTIVE`, `WITHDRAWN`, `TRANSFERRED_OUT`, `GRADUATED` |

`UNIQUE (id, school_id)` supports composite foreign keys. Index on
`(school_id, last_name, first_name)` for name search.

### 4.8 `guardians` and `student_guardians`

`guardians`: one person per school (`full_name`, optional `phone` in E.164
such as `+233201234567`, optional lowercase `email`). Index `(school_id, phone)`
for finding an existing guardian before creating one.

`student_guardians`: the many-to-many link.

- PK `(student_id, guardian_id)`: the same guardian cannot be linked twice to
  the same student. **One guardian row serves all siblings.**
- Composite FKs `(student_id, school_id)` and `(guardian_id, school_id)`:
  **a student of school A cannot be linked to a guardian of school B.**
- `relationship` (`MOTHER`, `FATHER`, `GRANDPARENT`, `SIBLING`,
  `UNCLE_OR_AUNT`, `OTHER_RELATIVE`, `LEGAL_GUARDIAN`, `OTHER`).
- `is_primary_contact`: **at most one primary contact per student** (exclusion
  constraint).

**Decision needing your approval (D1):** phone numbers are *not* unique,
because spouses or relatives can legitimately share a number. De-duplication
is therefore an application step (search by phone, then link the existing
guardian). A unique phone constraint would be simpler but would block real
families.

### 4.9 `enrollments`

A student's placement in a class for a stretch of time. Separate from
`students` so history survives.

| Column | Notes |
| --- | --- |
| `school_id`, `student_id`, `class_id`, `academic_year_id` | each pair `(x_id, school_id)` is a composite FK to the parent's `(id, school_id)` |
| `status` | `ENROLLED` (current), `PROMOTED`, `REPEATED`, `CLASS_CHANGED`, `WITHDRAWN`, `COMPLETED` |
| `start_date` | required |
| `end_date` | optional while current; **inclusive** last day |

Rules enforced by the database:

- `end_date >= start_date`.
- A non-`ENROLLED` row must have an `end_date`.
- **A student cannot have overlapping enrollment periods** (exclusion
  constraint on `student_id` plus the date range). This prevents being in two
  classes at once and double-enrolling in a year.
- Cross-school links are impossible (composite FKs).

**Promotion** = set the old row's `end_date` to the last day and `status` to
`PROMOTED`; insert a new `ENROLLED` row starting the next day. The old row is
kept. **A mid-year class change on day D** = old row `end_date = D-1`, status
`CLASS_CHANGED`; new row `start_date = D`.

*Not enforced in the database:* that enrollment dates fall inside the academic
year (application validation; see risks).

### 4.10 `audit_events`

Minimum database support for traceability; the writing code is a later phase.

| Column | Notes |
| --- | --- |
| `school_id?` | null for platform-level events |
| `actor_user_id?` | null for system actions |
| `action` | dotted name, e.g. `membership.role_granted` |
| `entity_type`, `entity_id?` | what changed |
| `metadata` | `jsonb`: **ids and changed field names only, never secrets** |
| `occurred_at` | |

- **Append-only at the database level:** triggers reject `UPDATE`, `DELETE`
  and `TRUNCATE`. (A database superuser can still bypass this; production
  should also run the application as a role without those privileges, and ship
  logs to separate storage.)
- Indexes on `(school_id, occurred_at)`, `(entity_type, entity_id)` and
  `(actor_user_id)`.

**Operations that must write an audit event (to be implemented with the
feature):**

| Area | Events |
| --- | --- |
| Membership | invited, accepted, role granted/revoked, suspended, ended |
| Student identity | admission number, name or date-of-birth changed; status changed |
| Enrollment | promotion, class change, withdrawal |
| Academic results (later) | score approved or unlocked, report card published |
| Payments (later) | payment verified, reversed or adjusted |
| Platform | support grant created or revoked, **and every support access to a school** |
| Authentication (Phase 4) | sign-in failures, password reset (event only) |

**Never log:** passwords, hashes, session or reset tokens, full request bodies.
Record the *names* of changed fields, not full old and new personal data,
unless a specific rule requires it.

## 5. Multi-tenant isolation

### 5.1 How ownership is represented

Every school-owned table has `school_id NOT NULL` with a foreign key to
`schools`. A relationship between two school-owned rows uses a **composite
foreign key**:

```
enrollments (student_id, school_id) -> students (id, school_id)
```

`students` therefore carries `UNIQUE (id, school_id)`. Because `enrollments`
has a single `school_id` shared by all of its composite keys, a student, a
class and an academic year in one enrollment are **forced to belong to the same
school**. PostgreSQL rejects any mismatch with a foreign-key error.
`ON UPDATE RESTRICT` also stops anyone moving a referenced row to another
school.

Composite keys used: `terms`, `student_guardians`, `enrollments`.

### 5.2 How backend queries will be scoped (Phase 3 rules)

1. The active school comes from the **authenticated session** and a verified
   active membership, never from a request body or a client-supplied header
   alone.
2. All data access goes through a small repository layer that **requires a
   `schoolId` argument** for school-owned tables; there is no helper that
   queries those tables without it.
3. Lookups by id always include the school: `WHERE id = $1 AND school_id = $2`.
   A row from another school returns "not found", not "forbidden", so ids do
   not leak existence.
4. Writes set `school_id` from the session, never from the payload.
5. Lint or code review rule: no raw query on a school-owned table without a
   `school_id` predicate.

### 5.3 Row-level security (RLS): deliberately not enabled yet

RLS is a strong second layer, but a half-configured policy gives false
confidence: table owners and superusers bypass it, and policies need a
dedicated non-owner application role and a trustworthy way to set the current
school on each connection. **Plan for the API phase:** create `ymt_app`
(no ownership, no `BYPASSRLS`), `ENABLE` and `FORCE ROW LEVEL SECURITY` on
school-owned tables, set `SET LOCAL app.current_school_id = ...` inside every
transaction, add policies `USING (school_id = current_setting('app.current_school_id')::uuid)`,
and test that a missing setting returns nothing. Until all of that exists and
is tested, we rely on sections 5.1 and 5.2.

### 5.4 Automated cross-school isolation tests (plan)

*Database level (written in this phase; see tests):* every composite foreign
key rejects cross-school links; per-school uniqueness allows the same value in
two schools; deleting referenced rows is refused.

*API level (Phase 3 onward), run against two seeded schools A and B:*

1. For every school-scoped endpoint: a user of A requesting B's record id gets
   404, and the response contains no B data.
2. List endpoints return only A's rows, even when B has more rows.
3. Create and update endpoints ignore a `schoolId` in the payload.
4. A user with a membership in A only, and a user with memberships in both,
   each see only the active school's data; switching school switches data.
5. A suspended school and an ended membership both return 403.
6. Support access without a valid grant is denied; with a grant, it is limited
   to that school and logged.
7. A test that **fails the build** if a new school-owned table has no
   `school_id` or lacks the composite-key pattern for its relations.
8. When RLS is enabled: repeat the above with the app role and confirm the
   database denies cross-school reads even when the application query forgets
   its `school_id` filter.

## 6. Indexing

Indexes follow real query patterns, not every column:

- Unique constraints create their own indexes (school code, user email,
  admission number, membership pair, names per school).
- Foreign-key columns that will be joined or filtered get an index, since
  PostgreSQL does not create these automatically (`memberships.user_id`,
  `enrollments.student_id`, guardian lookups, audit lookups).
- `enrollments (school_id, academic_year_id, class_id)` for "who is in this
  class this year".
- `students (school_id, last_name, first_name)` for name search.
- Exclusion constraints are backed by GiST indexes that double as lookup
  indexes for `student_id`, `school_id` and the date ranges.

Re-evaluate with `EXPLAIN` on realistic data volumes before launch; remove any
index that is not used.

## 7. Constraints the database cannot express through Prisma

Prisma's schema language cannot describe `CHECK` constraints, exclusion
constraints or triggers. They live in a **separate, clearly named migration**
(`..._integrity_constraints`) written in SQL. Prisma does not manage them, so
they are never silently dropped by a schema change, but any rename of a
table or column in `schema.prisma` must also update that SQL by hand. The
extension `btree_gist` is required for the exclusion constraints.

## 8. Deletion, inactivity and history

- **No cascading deletes anywhere.** Every foreign key is
  `ON DELETE RESTRICT`: deleting a school, student, class, year or user that
  has dependants fails.
- **Lifecycle by status, not deletion:** students are `WITHDRAWN`,
  `TRANSFERRED_OUT` or `GRADUATED`; memberships `ENDED`; classes and subjects
  `is_active = false`; users `DISABLED`; schools `SUSPENDED`.
- **Mistaken records** (a student entered by error) are corrected by an
  authorised admin through a dedicated, audited operation in a later phase,
  not by ad-hoc SQL.
- **Removing a school entirely** (contract end, legal request) is an
  operational runbook, not an application feature: export, retention review,
  then a reviewed purge executed by a privileged operator. Not implemented in
  this phase.
- Historical academic and financial rows must keep pointing at the student,
  class and year that existed at the time. This is why enrollments are
  separate rows and why nothing is overwritten.

## 9. Data we deliberately do not collect (yet)

Gender, religion, nationality, health information, national ID numbers,
photographs and home addresses of students are **not** stored. Each would need
a documented school-operations or regulatory reason first (for example,
education-authority returns may later justify gender). Guardian records hold
only name, phone and email. Collecting more would increase breach impact and
legal obligations (Ghana's Data Protection Act, 2012, and children's data
deserve particular care).

## 10. Development and test data

- Seed data is **fictional**, uses reserved example email domains and
  obviously synthetic names, and lives in `database/seeds/`.
- The seed refuses to run unless the database name ends in `_dev` or `_test`,
  so it cannot be pointed at a production database by accident.
- It is idempotent: fixed ids plus `ON CONFLICT DO NOTHING`.
- Nothing runs the seed automatically, in any environment.

## 11. Decisions for your approval

| Id | Decision | My recommendation |
| --- | --- | --- |
| D1 | Guardian phone not unique (app-level de-duplication) | Keep as designed |
| D2 | School `code` assigned by YMT staff, immutable | Keep for MVP; self-service signup would need a different policy |
| D3 | Admission numbers stored UPPERCASE | Keep; confirm schools don't need case-sensitive numbers |
| D4 | Multiple roles per membership (join table) | Keep |
| D5 | Support access via time-boxed grants capped at 7 days | Keep; confirm the 7-day cap |
| D6 | RLS postponed to the API phase | Keep, as long as Phase 3 adopts section 5.2 |
| D7 | Database tooling lives in `database/` (its own package), not inside `apps/api` | Keep; the API will depend on it |
| D8 | Dates-within-year rules are application-level for now | Revisit with a constraint trigger before launch |
| D9 | Prisma pinned to 6.x (`^6.0.0`). A newer major changes how the connection is configured and is a separate, deliberate upgrade | Keep for now; confirm after `prisma validate` runs on your machine |
| D10 | The development seed and the constraint tests are plain SQL run through `psql` (via `scripts/run-sql.mjs`), not a TypeScript seed. They were run and verified; a TypeScript seed could not be run in the environment where this was written. Windows users need `psql` on PATH | Keep; port to a Prisma TypeScript seed later only if you prefer, once Prisma runs locally |
| D12 | **Supabase Data API.** Supabase can expose `public` tables over an automatic REST/GraphQL API using public keys, a second door around school isolation. Nothing here uses that API. Options: (a) turn the Data API off for the project in the dashboard (no code change); (b) additionally enable row-level security with **no policies** on every table, which denies the API roles while the table-owning `prisma`/`postgres` roles are unaffected (this needs a new migration, written and tested before it is applied). Supabase says new projects stopped auto-exposing new tables from 30 May 2026 and existing projects follow on 30 October 2026, but your project's real state is unverified | Do (a) now and verify with the read-only queries in `database/README.md`. Decide on (b) together with the Phase 3 RLS plan (section 5.3). **No migration was added; approval needed** |
| D13 | **Supabase connection.** Use the session pooler (port 5432, user `prisma.<ref>`) for migrations, seed and tests. The transaction pooler (port 6543) is refused by the guard. If Phase 3 runs serverless, add a second URL (`directUrl`) for migrations and extend `scripts/migrate-deploy.mjs` to guard it too, otherwise the guard would check the wrong URL | Keep; revisit in Phase 3 |
| D14 | **Seed/test target guard.** The original `_dev`/`_test` name rule is unchanged. A Supabase database is named `postgres`, so a recognised Supabase project may also be used when `YMT_ENV`, `YMT_APPROVED_TARGET_REF` and `--approve-target=<ref>` all agree. The tests additionally require an empty database. The guard stops accidents, not deliberate bypass | Keep; confirm you want tests to be allowed on the dev project at all (README section 6, option 3) |
| D11 | `updated_at` has a database default **and** `@updatedAt` in Prisma (`@default(now()) @updatedAt`), so the schema matches the migration. Raw SQL writers must set `updated_at` themselves | Keep; consider a trigger before launch (risk 2) |

## 12. Known risks before a real launch

1. Prisma-managed schema and the hand-written constraints migration can drift
   if a table is renamed; mitigate with the drift check in the README and CI.
2. `updated_at` is maintained by Prisma, not the database; raw SQL writers must
   set it (or we add a trigger later).
3. Terms inside years and enrollments inside years are not database-enforced (D8).
4. The audit table is append-only against ordinary roles only; a superuser can
   bypass it.
5. No backups, point-in-time recovery, connection pooling, role separation or
   encryption-at-rest decisions exist yet. They belong to the deployment phase
   and are **launch blockers**.
6. Nothing here is production-ready: authentication, authorisation, the API,
   RLS and the isolation test suite are not built.
7. **Prisma/exclusion-constraint interaction is unverified.** Prisma does not
   model EXCLUDE constraints or their backing GiST indexes, so
   `prisma migrate dev` or `migrate diff` may report them as drift. Run
   `npm run db:drift-check` on a real Prisma install before relying on
   `migrate dev` (see `database/README.md`).
8. The sandbox PostgreSQL was a single local instance. Behaviour under
   concurrent writes, with large tables, and on other PostgreSQL versions has
   not been tested.
9. Windows development needs `psql` for the seed and tests (D10).
10. **Supabase specifics are unverified.** No connection to a Supabase project has
    been made. Unverified there: the dedicated `prisma` role setup, the extension
    pre-install step (a limited role fails migration 2 without it, reproduced on a
    local PostgreSQL), the session pooler, the real Data API/grant state (D12), and
    `prisma migrate deploy` against it.
11. Supabase's own Prisma guide creates the `prisma` role with `bypassrls`; the
    README here deliberately omits it. Either way, a future runtime role that relies
    on row-level security (section 5.3) must **not** bypass it.
12. A guard bypass (`?host=`/`?dbname=` in a connection string redirecting psql) was
    found and fixed on 12 October 2026; the guard remains an accident-prevention
    measure only (D14).

## 13. Verification status

Last verified: 11 October 2026, PostgreSQL 16.15, using the exact files in this
repository.

**Executed and passed**

- Both migrations apply cleanly to empty databases as a non-superuser owner
  (including `CREATE EXTENSION btree_gist`).
- 70 of 70 checks in `database/tests/constraints.test.sql`: per-school
  admission numbers (duplicate rejected in one school, allowed across schools),
  invalid foreign keys rejected, every composite cross-school link rejected
  (enrollment to another school's student, class or year; guardian link; term
  to another school's year; moving a referenced student to another school),
  enrollment history preserved through promotion and class change, overlapping
  enrollments rejected, per-school academic structures, role and membership
  rules, support-grant limits, append-only audit table, and RESTRICT on delete.
- The tests can fail: dropping a cross-school foreign key, or the admission
  number unique index, each made the suite fail (mutation check).
- The seed inserts the expected rows, is repeatable (second run changes
  nothing) and refuses a database not named `*_dev`/`*_test` or one holding a
  non-demo school.
- `schema.prisma` matches the database structure (tables, columns,
  nullability, enum values, 30 index names, 23 foreign keys and actions),
  checked by a one-off comparison script. This is a naming and structure
  check, **not** Prisma validation.

**Not executed (needs Prisma, which could not be installed where this was written)**

- `prisma validate`, `prisma generate`, `prisma migrate status`,
  `prisma migrate dev` (no spurious new migration), `db:drift-check` and any
  use of the generated client.

**Not tested:** concurrency, performance, other PostgreSQL versions, database
roles and privileges, backups and restore.

Details and commands: `database/README.md`.
