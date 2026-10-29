-- Least-privilege RUNTIME role for the API.   NOT a migration; NOT applied automatically.
--
-- Two kinds of database user exist in this project and they must stay separate:
--   * the MIGRATION / OWNER user (for example ymt_dev_user): owns the tables, runs
--     `prisma migrate deploy`, the seed and the operator provisioning command.
--   * the RUNTIME user created here (ymt_app_runtime): used only by the running API.
--     It can read and write exactly what Phase 2 authentication needs and nothing
--     else. It cannot create, alter or drop objects, cannot bypass row security,
--     cannot delete users, schools or memberships, and cannot change or delete
--     audit events.
--
-- Cluster-level object: a role belongs to the whole PostgreSQL server, not to one
-- database. Grants below are per database, so run this in each database that the
-- API will use (ymt_dev, later ymt_test).
--
-- Usage (an operator, as the owner or a superuser; ONLY after explicit approval):
--   psql --single-transaction -v ON_ERROR_STOP=1 -X -d <ymt_dev|ymt_test> -f roles/runtime_role.sql
--   then set the password interactively, so it never appears in a file, a command
--   line or the server log:        \password ymt_app_runtime
--
-- Safe to run again: it re-asserts the attributes and rebuilds the grants from scratch.
-- Phase 3+ will add grants for the school-owned tables as those features arrive; the
-- exact allow-list is enforced by tests/runtime_role.test.sql.

\set ON_ERROR_STOP on

-- Refuse anything that is not a development or test database.
DO $$
BEGIN
  IF current_database() !~ '(_dev|_test)$' THEN
    RAISE EXCEPTION 'Refusing to run on database "%": the name must end in _dev or _test.', current_database();
  END IF;
  IF to_regclass('public.sessions') IS NULL OR to_regclass('public.user_credentials') IS NULL THEN
    RAISE EXCEPTION 'Apply the migration 20261012000000_auth_credentials_sessions first (tables sessions and user_credentials are missing).';
  END IF;
END $$;

-- 1. The role. LOGIN without a password cannot authenticate until \password is run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ymt_app_runtime') THEN
    CREATE ROLE ymt_app_runtime LOGIN;
  END IF;
END $$;

ALTER ROLE ymt_app_runtime
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 20;

-- 2. Database and schema access (no CREATE on the schema).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ymt_app_runtime', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO ymt_app_runtime;
REVOKE CREATE ON SCHEMA public FROM ymt_app_runtime;

-- 3. Start from nothing, then grant the exact allow-list.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ymt_app_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ymt_app_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ymt_app_runtime;

-- Reference data: schools are read-only for the API.
GRANT SELECT ON schools TO ymt_app_runtime;

-- Staff management (Phase 5). The API may create a person (user + credential + membership + roles)
-- and change a membership's status and roles. It still cannot UPDATE or DELETE a user, delete a
-- membership or a credential, or re-point a membership/credential to another school or user.
GRANT SELECT, INSERT ON users TO ymt_app_runtime;
GRANT SELECT, INSERT ON school_memberships TO ymt_app_runtime;
GRANT UPDATE (status, ended_at, updated_at) ON school_memberships TO ymt_app_runtime;
-- Role rows have no history of their own (the audit trail records each change), so replacing a
-- person's roles inserts and deletes rows. A row can never be moved to another membership.
GRANT SELECT, INSERT, DELETE ON school_membership_roles TO ymt_app_runtime;

-- Credentials: read the hash to verify a login; create one for a new person; update only the
-- columns a login, a password change or a staff password reset touches. No DELETE.
GRANT SELECT, INSERT ON user_credentials TO ymt_app_runtime;
GRANT UPDATE (password_hash, algorithm, password_changed_at, failed_login_count, locked_until, must_change_password, updated_at)
  ON user_credentials TO ymt_app_runtime;

-- Sessions: create, read, expire-clean, and update only the mutable columns.
-- user_id, token_hash, csrf_token_hash, created_at and expires_at are fixed at creation.
GRANT SELECT, INSERT, DELETE ON sessions TO ymt_app_runtime;
GRANT UPDATE (active_school_id, last_seen_at, revoked_at, revoked_reason) ON sessions TO ymt_app_runtime;

-- Academic calendar (Phase 3): read, create, and change only the editable columns.
-- No DELETE (history is kept), and school_id / academic_year_id can never be re-pointed.
GRANT SELECT, INSERT ON academic_years, terms TO ymt_app_runtime;
GRANT UPDATE (name, start_date, end_date, status, updated_at) ON academic_years TO ymt_app_runtime;
GRANT UPDATE (name, sequence, start_date, end_date, status, updated_at) ON terms TO ymt_app_runtime;

-- Classes (Phase 3): read, create, and change only the editable columns. No DELETE: classes are
-- history for enrollments. school_id can never be changed.
GRANT SELECT, INSERT ON classes TO ymt_app_runtime;
GRANT UPDATE (name, level, sort_order, is_active, updated_at) ON classes TO ymt_app_runtime;

-- Students (Phase 4): read, create, and change only the profile columns and the status. No
-- DELETE: a student who leaves is given a status, never removed. school_id and id are fixed.
GRANT SELECT, INSERT ON students TO ymt_app_runtime;
GRANT UPDATE (admission_number, first_name, middle_name, last_name, date_of_birth, admitted_on, status, updated_at)
  ON students TO ymt_app_runtime;

-- Guardians (Phase 4): read, create, edit contact details. No DELETE: a guardian may be linked to
-- several students, and is only ever un-linked, not removed.
GRANT SELECT, INSERT ON guardians TO ymt_app_runtime;
GRANT UPDATE (full_name, phone, email, updated_at) ON guardians TO ymt_app_runtime;

-- Student-guardian links (Phase 4): the ONE place DELETE is granted. A link is a plain relationship
-- row with no history of its own (the audit trail records who linked or un-linked and when), and
-- "safe unlink" must remove it. Only the relationship and primary flag can be edited; the student
-- and guardian of a link can never be re-pointed.
GRANT SELECT, INSERT, DELETE ON student_guardians TO ymt_app_runtime;
GRANT UPDATE (relationship, is_primary_contact) ON student_guardians TO ymt_app_runtime;

-- Enrollments (Phase 4): read, create, and change only the status and end date (this is how a class
-- change ends the old row and keeps it as history). No DELETE; student, class, year and start date
-- can never be changed.
GRANT SELECT, INSERT ON enrollments TO ymt_app_runtime;
GRANT UPDATE (status, end_date, updated_at) ON enrollments TO ymt_app_runtime;

-- Audit trail: append and read. The table's triggers also reject UPDATE/DELETE/TRUNCATE.
GRANT SELECT, INSERT ON audit_events TO ymt_app_runtime;
