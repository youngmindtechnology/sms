# Staff management: database changes APPROVED, FILES WRITTEN, NOT YET APPLIED

Approved by the owner. The migration file `20261028000000_user_credentials_must_change_password` and the
grants in `roles/runtime_role.sql` are now written, and `tests/runtime_role.test.sql` was extended
(84/84 pass on a throwaway PostgreSQL 16 cluster). They have NOT been applied to `ymt_test` or
`ymt_dev` yet: the owner runs the commands.

## Why a change is needed

New staff accounts (and password resets) use a one-time **temporary password** that the person must
replace at first sign-in. The code needs to remember "this password is temporary". The existing
`user_credentials` table has no column for that, and there is no honest way to express it with the
existing columns (`users.status = INVITED` cannot sign in by design, and a reset of an ACTIVE user
has no status to flip). So: one new column, and the runtime role needs the permissions to create
accounts.

The code in the working copy **already reads `must_change_password`** (sign-in, `/api/auth/me`,
change-password, staff). `schema.prisma` declares it, but the database does not have it yet.

> **Do not start the API against `ymt_dev` until BOTH changes below are applied.** Without the
> column, every sign-in would fail. `ymt_test` has no runtime role and needs only the migration.

## 1. Proposed migration (additive)

Folder: `apps/web/database/prisma/migrations/20261028000000_user_credentials_must_change_password/migration.sql`

```sql
-- A temporary password handed out by a school administrator must be replaced at first sign-in.
-- Additive: existing rows get false, so nobody is forced to change anything.
ALTER TABLE "user_credentials"
  ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
```

Targets: `ymt_test` first, then `ymt_dev`, each through the guarded wrapper
(`db:migrate:plan:*`, `db:migrate:deploy:*`). Adding a column with a constant default is a
metadata-only change in PostgreSQL 11+ (instant, no table rewrite).

## 2. Proposed runtime-role grants (target `ymt_dev` only)

Replace the existing `user_credentials` UPDATE grant and add the rest, in `roles/runtime_role.sql`:

```sql
-- user_credentials: add the new column to the columns the runtime may update, and allow INSERT
-- (creating a staff account). The hash can never be read back by the staff code.
GRANT SELECT, INSERT ON user_credentials TO ymt_app_runtime;
GRANT UPDATE (password_hash, algorithm, password_changed_at, failed_login_count, locked_until, must_change_password, updated_at)
  ON user_credentials TO ymt_app_runtime;

-- users: create an account. No UPDATE and no DELETE: the API cannot disable, rename or remove a user.
GRANT SELECT, INSERT ON users TO ymt_app_runtime;

-- school_memberships: create a membership; change only its status and end date.
-- (SELECT ... FOR UPDATE, used to protect the last owner, needs the UPDATE privilege.)
GRANT SELECT, INSERT ON school_memberships TO ymt_app_runtime;
GRANT UPDATE (status, ended_at, updated_at) ON school_memberships TO ymt_app_runtime;

-- school_membership_roles: give a role (INSERT) and take one away (DELETE: the only place this
-- feature deletes anything; a role row has no history of its own and the change is audited).
GRANT SELECT, INSERT, DELETE ON school_membership_roles TO ymt_app_runtime;
```

Not granted: INSERT/UPDATE/DELETE on `schools`; UPDATE or DELETE on `users`; DELETE on
`school_memberships`; any new privilege on `sessions` (revoking sessions already works).

Honest note: after this, the runtime role CAN create users and memberships. That is exactly what staff
management is. The protection is the API (permission `staff:manage`, the role-escalation rules, school
isolation, audit), not the database grant. Column grants stop it from touching anything else.

## 3. Existing role tests that will need updating WITH the grants

`tests/runtime_role.test.sql` currently asserts these are denied; they become allowed (or change):
"cannot insert a user", "cannot grant itself a membership", "cannot grant itself a role",
"cannot change a membership status", "cannot create a credential", plus the two allow-list queries
(table-level and column-level). New checks to add: can create a user + credential + membership +
role; can end a membership and clear `ended_at`; can delete a role row; still cannot UPDATE
`users`, DELETE a user/membership/credential, change a membership's `school_id` or `user_id`,
or read `user_credentials` columns other than through SELECT as before. I will make these edits
and run them on a throwaway database only after you approve the SQL above.

## 4. Order of operations after approval

1. Migration on `ymt_test` (plan, then deploy), then on `ymt_dev`.
2. `npm.cmd run db:generate` (refreshes the Prisma client with the new column).
3. Runtime grants on `ymt_dev` (you run it; set no password in files).
4. Start the API.
