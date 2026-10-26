-- Tests for roles/runtime_role.sql. Run on a SEPARATE, EMPTY test database that has
-- had all migrations applied:
--   psql -v ON_ERROR_STOP=1 -X -d <database_ending_in__test> -f tests/runtime_role.test.sql
--
-- Everything, including creating the role, happens in ONE transaction that is
-- ROLLED BACK, so the role and its grants are not left behind. CREATE ROLE is
-- transactional in PostgreSQL, so this is safe on a shared server.
--
-- Safety: refuses unless the database name ends in _test, or the database is not empty.
-- Needs a user who may create roles and SET ROLE to them (a superuser, or an owner
-- with CREATEROLE that is permitted to SET ROLE).

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_database() !~ '_test$' THEN
    RAISE EXCEPTION 'Refusing to run: database "%" does not end in _test.', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM schools) OR EXISTS (SELECT 1 FROM users) THEN
    RAISE EXCEPTION 'Refusing to run: the database already contains data. Use an empty test database.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ymt_app_runtime') THEN
    RAISE EXCEPTION 'The role ymt_app_runtime already exists on this server. This test creates it itself, so run it on a server where it does not exist yet (or drop it first).';
  END IF;
END $$;

\ir ../roles/runtime_role.sql

CREATE TEMP TABLE test_results (n serial, label text, ok boolean, detail text);

-- Run `stmt` AS the runtime role; expect failure with one of the comma-separated SQLSTATEs.
CREATE FUNCTION pg_temp.as_runtime_expect_error(label text, stmt text, states text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE got_state text; got_msg text;
BEGIN
  BEGIN
    SET LOCAL ROLE ymt_app_runtime;
    EXECUTE stmt;
    RESET ROLE;
    INSERT INTO test_results(label, ok, detail) VALUES (label, false, 'statement succeeded but should have been denied');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    got_state := SQLSTATE;
    GET STACKED DIAGNOSTICS got_msg = MESSAGE_TEXT;
  END;
  IF got_state = ANY (string_to_array(states, ',')) THEN
    INSERT INTO test_results(label, ok, detail) VALUES (label, true, got_msg);
  ELSE
    INSERT INTO test_results(label, ok, detail) VALUES (label, false, format('expected %s, got %s: %s', states, got_state, got_msg));
  END IF;
END $$;

CREATE FUNCTION pg_temp.as_runtime_expect_ok(label text, stmt text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE got_msg text;
BEGIN
  BEGIN
    SET LOCAL ROLE ymt_app_runtime;
    EXECUTE stmt;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got_msg = MESSAGE_TEXT;
    INSERT INTO test_results(label, ok, detail) VALUES (label, false, 'unexpected error: ' || got_msg);
    RETURN;
  END;
  INSERT INTO test_results(label, ok, detail) VALUES (label, true, NULL);
END $$;

CREATE FUNCTION pg_temp.expect_true(label text, q text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r boolean;
BEGIN
  EXECUTE q INTO r;
  INSERT INTO test_results(label, ok, detail) VALUES (label, coalesce(r, false), CASE WHEN coalesce(r, false) THEN NULL ELSE 'query returned false or null' END);
END $$;

-- Fixtures (created as the connecting user, before switching roles).
INSERT INTO schools (id, code, name) VALUES
  ('10000000-0000-4000-8000-0000000000a1', 'test-alpha', 'Test School Alpha'),
  ('10000000-0000-4000-8000-0000000000b1', 'test-bravo', 'Test School Bravo');
INSERT INTO users (id, email, full_name, status) VALUES
  ('20000000-0000-4000-8000-000000000001', 'owner@example.test', 'Test Owner', 'ACTIVE');
INSERT INTO school_memberships (id, school_id, user_id, status) VALUES
  ('70000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('70000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-000000000001', 'ACTIVE');
INSERT INTO school_membership_roles (membership_id, role) VALUES ('70000000-0000-4000-8000-0000000000a1', 'OWNER');
INSERT INTO user_credentials (user_id, password_hash, algorithm)
  VALUES ('20000000-0000-4000-8000-000000000001', '$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHQ$ZmFrZWhhc2hmb3J0ZXN0aW5n', 'argon2id');
INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, active_school_id, expires_at)
  VALUES ('a0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
          decode(repeat('11', 32), 'hex'), decode(repeat('21', 32), 'hex'),
          '10000000-0000-4000-8000-0000000000a1', now() + interval '8 hours');
INSERT INTO audit_events (action, entity_type) VALUES ('test.fixture', 'thing');
INSERT INTO classes (id, school_id, name, level, sort_order)
  VALUES ('40000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'Basic 1A', 'PRIMARY', 1);
INSERT INTO academic_years (id, school_id, name, start_date, end_date)
  VALUES ('30000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '2026/2027', '2026-09-01', '2027-07-31');
INSERT INTO terms (id, school_id, academic_year_id, name, sequence, start_date, end_date)
  VALUES ('80000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'Term 1', 1, '2026-09-01', '2026-12-18');

-- ---- Role attributes ----------------------------------------------------
SELECT pg_temp.expect_true('role is not a superuser and has no create-db/create-role/replication/bypass-RLS',
  $$ SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
       FROM pg_roles WHERE rolname = 'ymt_app_runtime' $$);
SELECT pg_temp.expect_true('role does not inherit and has a connection limit',
  $$ SELECT NOT rolinherit AND rolconnlimit BETWEEN 1 AND 100 FROM pg_roles WHERE rolname = 'ymt_app_runtime' $$);
SELECT pg_temp.expect_true('role is not a member of any other role',
  $$ SELECT NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'ymt_app_runtime') $$);
SELECT pg_temp.expect_true('role owns no objects',
  $$ SELECT NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'ymt_app_runtime') $$);
SELECT pg_temp.expect_true('role cannot create objects in the public schema',
  $$ SELECT NOT has_schema_privilege('ymt_app_runtime', 'public', 'CREATE') $$);
SELECT pg_temp.expect_true('role cannot log in without a password (no password set by the script)',
  $$ SELECT rolpassword IS NULL FROM pg_authid WHERE rolname = 'ymt_app_runtime' $$);

-- ---- Exact privilege allow-list (table level) ---------------------------
SELECT pg_temp.expect_true('table privileges are EXACTLY the documented allow-list',
  $$ WITH actual AS (
       SELECT table_name || ':' || privilege_type AS p
         FROM information_schema.role_table_grants
        WHERE grantee = 'ymt_app_runtime' AND table_schema = 'public'),
     expected(p) AS (VALUES
       ('schools:SELECT'), ('users:SELECT'), ('school_memberships:SELECT'), ('school_membership_roles:SELECT'),
       ('user_credentials:SELECT'),
       ('sessions:SELECT'), ('sessions:INSERT'), ('sessions:DELETE'),
       ('academic_years:SELECT'), ('academic_years:INSERT'), ('terms:SELECT'), ('terms:INSERT'),
       ('classes:SELECT'), ('classes:INSERT'),
       ('audit_events:SELECT'), ('audit_events:INSERT'))
     SELECT NOT EXISTS (SELECT p FROM actual EXCEPT SELECT p FROM expected)
        AND NOT EXISTS (SELECT p FROM expected EXCEPT SELECT p FROM actual) $$);
SELECT pg_temp.expect_true('column-level UPDATE is limited to the documented columns',
  $$ WITH actual AS (
       SELECT table_name || '.' || column_name AS c
         FROM information_schema.column_privileges
        WHERE grantee = 'ymt_app_runtime' AND table_schema = 'public' AND privilege_type = 'UPDATE'),
     expected(c) AS (VALUES
       ('user_credentials.password_hash'), ('user_credentials.algorithm'), ('user_credentials.password_changed_at'),
       ('user_credentials.failed_login_count'), ('user_credentials.locked_until'), ('user_credentials.updated_at'),
       ('sessions.active_school_id'), ('sessions.last_seen_at'), ('sessions.revoked_at'), ('sessions.revoked_reason'),
       ('academic_years.name'), ('academic_years.start_date'), ('academic_years.end_date'), ('academic_years.status'), ('academic_years.updated_at'),
       ('terms.name'), ('terms.sequence'), ('terms.start_date'), ('terms.end_date'), ('terms.status'), ('terms.updated_at'),
       ('classes.name'), ('classes.level'), ('classes.sort_order'), ('classes.is_active'), ('classes.updated_at'))
     SELECT NOT EXISTS (SELECT c FROM actual EXCEPT SELECT c FROM expected)
        AND NOT EXISTS (SELECT c FROM expected EXCEPT SELECT c FROM actual) $$);

-- ---- What the API needs: these must work --------------------------------
SELECT pg_temp.as_runtime_expect_ok('can read users, schools, memberships and roles',
  $$ SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM schools) + (SELECT count(*) FROM school_memberships) + (SELECT count(*) FROM school_membership_roles) $$);
SELECT pg_temp.as_runtime_expect_ok('can read a credential (to verify a login)',
  $$ SELECT password_hash FROM user_credentials $$);
SELECT pg_temp.as_runtime_expect_ok('can record a failed login and a lock',
  $$ UPDATE user_credentials SET failed_login_count = 3, locked_until = now() + interval '15 minutes', updated_at = now() $$);
SELECT pg_temp.as_runtime_expect_ok('can change a password hash',
  $$ UPDATE user_credentials SET password_hash = '$argon2id$v=19$m=19456,t=2,p=1$bmV3c2FsdA$bmV3aGFzaGZvcnRlc3Rpbmc', password_changed_at = now() $$);
SELECT pg_temp.as_runtime_expect_ok('can create a session',
  $$ INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at)
     VALUES ('20000000-0000-4000-8000-000000000001', decode(repeat('12', 32), 'hex'), decode(repeat('22', 32), 'hex'), now() + interval '8 hours') $$);
SELECT pg_temp.as_runtime_expect_ok('can switch the active school and touch last_seen_at',
  $$ UPDATE sessions SET active_school_id = '10000000-0000-4000-8000-0000000000b1', last_seen_at = now() WHERE id = 'a0000000-0000-4000-8000-000000000001' $$);
SELECT pg_temp.as_runtime_expect_ok('can revoke a session',
  $$ UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = 'a0000000-0000-4000-8000-000000000001' $$);
SELECT pg_temp.as_runtime_expect_ok('can delete a session (expired-session cleanup)',
  $$ DELETE FROM sessions WHERE token_hash = decode(repeat('12', 32), 'hex') $$);
SELECT pg_temp.as_runtime_expect_ok('can append an audit event',
  $$ INSERT INTO audit_events (action, entity_type, metadata) VALUES ('auth.login.succeeded', 'session', '{}') $$);
SELECT pg_temp.as_runtime_expect_ok('can read academic years and terms',
  $$ SELECT (SELECT count(*) FROM academic_years) + (SELECT count(*) FROM terms) $$);
SELECT pg_temp.as_runtime_expect_ok('can create an academic year',
  $$ INSERT INTO academic_years (school_id, name, start_date, end_date) VALUES ('10000000-0000-4000-8000-0000000000a1', '2027/2028', '2027-09-01', '2028-07-31') $$);
SELECT pg_temp.as_runtime_expect_ok('can create a term',
  $$ INSERT INTO terms (school_id, academic_year_id, name, sequence, start_date, end_date) VALUES ('10000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'Term 2', 2, '2027-01-11', '2027-04-02') $$);
SELECT pg_temp.as_runtime_expect_ok('can change a year''s name, dates and status',
  $$ UPDATE academic_years SET name = '2026-2027', status = 'ACTIVE', updated_at = now() WHERE id = '30000000-0000-4000-8000-0000000000a1' $$);
SELECT pg_temp.as_runtime_expect_ok('can change a term''s status',
  $$ UPDATE terms SET status = 'ACTIVE', updated_at = now() WHERE id = '80000000-0000-4000-8000-0000000000a1' $$);
SELECT pg_temp.as_runtime_expect_ok('can read classes',
  $$ SELECT count(*) FROM classes $$);
SELECT pg_temp.as_runtime_expect_ok('can create a class',
  $$ INSERT INTO classes (school_id, name, level, sort_order) VALUES ('10000000-0000-4000-8000-0000000000a1', 'KG 1', 'KINDERGARTEN', 2) $$);
SELECT pg_temp.as_runtime_expect_ok('can rename, reorder and deactivate a class',
  $$ UPDATE classes SET name = 'Basic 1B', level = 'PRIMARY', sort_order = 5, is_active = false, updated_at = now() WHERE id = '40000000-0000-4000-8000-0000000000a1' $$);
SELECT pg_temp.as_runtime_expect_ok('can read audit events',
  $$ SELECT count(*) FROM audit_events $$);

-- ---- What the API must NOT be able to do: SQLSTATE 42501 ----------------
SELECT pg_temp.as_runtime_expect_error('cannot insert a user (no public registration through the API database role)',
  $$ INSERT INTO users (email, full_name) VALUES ('new@example.test', 'New') $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot update a user (cannot self-activate or change status)',
  $$ UPDATE users SET status = 'ACTIVE' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot delete a user',
  $$ DELETE FROM users $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot insert or modify schools',
  $$ UPDATE schools SET name = 'Hacked' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot insert a school',
  $$ INSERT INTO schools (code, name) VALUES ('rogue-school', 'Rogue') $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot grant itself a membership',
  $$ INSERT INTO school_memberships (school_id, user_id) VALUES ('10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000001') $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot grant itself a role',
  $$ INSERT INTO school_membership_roles (membership_id, role) VALUES ('70000000-0000-4000-8000-0000000000b1', 'OWNER') $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot change a membership status',
  $$ UPDATE school_memberships SET status = 'ACTIVE' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot create a credential',
  $$ INSERT INTO user_credentials (user_id, password_hash, algorithm) VALUES ('20000000-0000-4000-8000-000000000001', '$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHQ$ZmFrZWhhc2hmb3J0ZXN0aW5n', 'argon2id') $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot delete a credential',
  $$ DELETE FROM user_credentials $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot re-point a credential to another user',
  $$ UPDATE user_credentials SET user_id = '20000000-0000-4000-8000-0000000000ee' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot change a session''s owner',
  $$ UPDATE sessions SET user_id = '20000000-0000-4000-8000-0000000000ee' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot extend a session''s expiry',
  $$ UPDATE sessions SET expires_at = now() + interval '10 years' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot overwrite a session token hash',
  $$ UPDATE sessions SET token_hash = decode(repeat('99', 32), 'hex') $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot update audit events',
  $$ UPDATE audit_events SET action = 'tampered' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot delete audit events',
  $$ DELETE FROM audit_events $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot truncate audit events',
  $$ TRUNCATE audit_events $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot truncate sessions',
  $$ TRUNCATE sessions $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot delete an academic year',
  $$ DELETE FROM academic_years $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot delete a term',
  $$ DELETE FROM terms $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move an academic year to another school',
  $$ UPDATE academic_years SET school_id = '10000000-0000-4000-8000-0000000000b1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move a term to another year',
  $$ UPDATE terms SET academic_year_id = '30000000-0000-4000-8000-0000000000a1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot delete a class',
  $$ DELETE FROM classes $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move a class to another school',
  $$ UPDATE classes SET school_id = '10000000-0000-4000-8000-0000000000b1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot read students (no grant yet in Phase 2)',
  $$ SELECT count(*) FROM students $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot read enrollments',
  $$ SELECT count(*) FROM enrollments $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot read guardians',
  $$ SELECT count(*) FROM guardians $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot read platform staff',
  $$ SELECT count(*) FROM platform_staff $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot read support access grants',
  $$ SELECT count(*) FROM support_access_grants $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot read the migration history table',
  $$ SELECT count(*) FROM _prisma_migrations $$, '42501,42P01');
SELECT pg_temp.as_runtime_expect_error('cannot create a table',
  $$ CREATE TABLE public.rogue (id int) $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot drop a table',
  $$ DROP TABLE sessions $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot alter a table',
  $$ ALTER TABLE users ADD COLUMN rogue int $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot disable the audit triggers',
  $$ ALTER TABLE audit_events DISABLE TRIGGER ALL $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot create a role',
  $$ CREATE ROLE rogue_role $$, '42501');
-- PostgreSQL only WARNS (it does not error) when a role tries to grant what it cannot
-- grant, so the check is that the attempt changes nothing.
SELECT pg_temp.as_runtime_expect_ok('a GRANT attempt by the role is accepted but ineffective (PostgreSQL warns only)',
  $$ GRANT INSERT, UPDATE, DELETE ON users TO ymt_app_runtime $$);
SELECT pg_temp.expect_true('the role still cannot insert, update or delete users after trying to grant itself that',
  $$ SELECT NOT has_table_privilege('ymt_app_runtime', 'users', 'INSERT')
        AND NOT has_table_privilege('ymt_app_runtime', 'users', 'UPDATE')
        AND NOT has_table_privilege('ymt_app_runtime', 'users', 'DELETE') $$);

-- The fixtures and the role are discarded by the ROLLBACK below.
\echo
\echo '=== Runtime role test results ==='
SELECT lpad(n::text, 3) AS "#", CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, label, CASE WHEN ok THEN '' ELSE detail END AS detail
  FROM test_results ORDER BY n;
SELECT count(*) AS total, count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM test_results;

DO $$
DECLARE failed int;
BEGIN
  SELECT count(*) INTO failed FROM test_results WHERE NOT ok;
  IF failed > 0 THEN RAISE EXCEPTION '% runtime-role test(s) FAILED', failed; END IF;
END $$;

ROLLBACK;
