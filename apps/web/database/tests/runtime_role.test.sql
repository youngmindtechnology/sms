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

INSERT INTO students (id, school_id, admission_number, first_name, last_name)
  VALUES ('50000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'ADM/001', 'Ama', 'Mensah'),
         ('50000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-0000000000a1', 'ADM/002', 'Kofi', 'Mensah');
INSERT INTO guardians (id, school_id, full_name)
  VALUES ('60000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'Test Guardian');
INSERT INTO student_guardians (student_id, guardian_id, school_id, relationship, is_primary_contact)
  VALUES ('50000000-0000-4000-8000-0000000000a1', '60000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'MOTHER', true);
INSERT INTO enrollments (id, school_id, student_id, class_id, academic_year_id, start_date, end_date)
  VALUES ('90000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a1',
          '40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', '2026-09-01', '2027-07-31');

INSERT INTO subjects (id, school_id, class_id, name, code)
  VALUES ('44000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '40000000-0000-4000-8000-0000000000a1', 'Mathematics', 'MATH');
INSERT INTO teaching_assignments (id, school_id, subject_id, academic_year_id, user_id)
  VALUES ('45000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '44000000-0000-4000-8000-0000000000a1',
          '30000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000001');

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
       ('schools:SELECT'), ('users:SELECT'), ('users:INSERT'),
       ('school_memberships:SELECT'), ('school_memberships:INSERT'),
       ('school_membership_roles:SELECT'), ('school_membership_roles:INSERT'), ('school_membership_roles:DELETE'),
       ('user_credentials:SELECT'), ('user_credentials:INSERT'),
       ('sessions:SELECT'), ('sessions:INSERT'), ('sessions:DELETE'),
       ('academic_years:SELECT'), ('academic_years:INSERT'), ('terms:SELECT'), ('terms:INSERT'),
       ('classes:SELECT'), ('classes:INSERT'),
       ('students:SELECT'), ('students:INSERT'), ('guardians:SELECT'), ('guardians:INSERT'),
       ('student_guardians:SELECT'), ('student_guardians:INSERT'), ('student_guardians:DELETE'),
       ('enrollments:SELECT'), ('enrollments:INSERT'),
       ('subjects:SELECT'), ('subjects:INSERT'), ('teaching_assignments:SELECT'), ('teaching_assignments:INSERT'),
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
       ('user_credentials.failed_login_count'), ('user_credentials.locked_until'), ('user_credentials.must_change_password'),
       ('user_credentials.updated_at'),
       ('school_memberships.status'), ('school_memberships.ended_at'), ('school_memberships.updated_at'),
       ('sessions.active_school_id'), ('sessions.last_seen_at'), ('sessions.revoked_at'), ('sessions.revoked_reason'),
       ('academic_years.name'), ('academic_years.start_date'), ('academic_years.end_date'), ('academic_years.status'), ('academic_years.updated_at'),
       ('terms.name'), ('terms.sequence'), ('terms.start_date'), ('terms.end_date'), ('terms.status'), ('terms.updated_at'),
       ('classes.name'), ('classes.level'), ('classes.sort_order'), ('classes.is_active'), ('classes.updated_at'),
       ('students.admission_number'), ('students.first_name'), ('students.middle_name'), ('students.last_name'),
       ('students.date_of_birth'), ('students.admitted_on'), ('students.status'), ('students.updated_at'),
       ('guardians.full_name'), ('guardians.phone'), ('guardians.email'), ('guardians.updated_at'),
       ('student_guardians.relationship'), ('student_guardians.is_primary_contact'),
       ('enrollments.status'), ('enrollments.end_date'), ('enrollments.updated_at'),
       ('subjects.name'), ('subjects.code'), ('subjects.is_active'), ('subjects.updated_at'),
       ('teaching_assignments.status'), ('teaching_assignments.ended_at'), ('teaching_assignments.updated_at'))
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
SELECT pg_temp.as_runtime_expect_ok('can create a person: user, credential, membership and role',
  $$ WITH u AS (INSERT INTO users (id, email, full_name, status) VALUES ('20000000-0000-4000-8000-000000000002', 'teacher@example.test', 'Test Teacher', 'ACTIVE') RETURNING id),
          c AS (INSERT INTO user_credentials (user_id, password_hash, algorithm, must_change_password)
                VALUES ('20000000-0000-4000-8000-000000000002', '$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHQ$ZmFrZWhhc2hmb3J0ZXN0aW5n', 'argon2id', true) RETURNING user_id),
          m AS (INSERT INTO school_memberships (id, school_id, user_id, status) VALUES ('70000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000002', 'ACTIVE') RETURNING id)
     INSERT INTO school_membership_roles (membership_id, role) SELECT id, 'TEACHER' FROM m $$);
SELECT pg_temp.as_runtime_expect_ok('can replace a membership''s roles (delete one row, add another)',
  $$ DELETE FROM school_membership_roles WHERE membership_id = '70000000-0000-4000-8000-0000000000a2';
     INSERT INTO school_membership_roles (membership_id, role) VALUES ('70000000-0000-4000-8000-0000000000a2', 'BURSAR') $$);
SELECT pg_temp.as_runtime_expect_ok('can suspend, end and reactivate a membership (ended_at set then cleared)',
  $$ UPDATE school_memberships SET status = 'SUSPENDED', updated_at = now() WHERE id = '70000000-0000-4000-8000-0000000000a2';
     UPDATE school_memberships SET status = 'ENDED', ended_at = now(), updated_at = now() WHERE id = '70000000-0000-4000-8000-0000000000a2';
     UPDATE school_memberships SET status = 'ACTIVE', ended_at = NULL, updated_at = now() WHERE id = '70000000-0000-4000-8000-0000000000a2' $$);
SELECT pg_temp.as_runtime_expect_ok('can set and clear must_change_password',
  $$ UPDATE user_credentials SET must_change_password = true, updated_at = now() WHERE user_id = '20000000-0000-4000-8000-000000000002';
     UPDATE user_credentials SET must_change_password = false, updated_at = now() WHERE user_id = '20000000-0000-4000-8000-000000000002' $$);
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
SELECT pg_temp.as_runtime_expect_ok('can read students, guardians, links and enrollments',
  $$ SELECT (SELECT count(*) FROM students) + (SELECT count(*) FROM guardians) + (SELECT count(*) FROM student_guardians) + (SELECT count(*) FROM enrollments) $$);
SELECT pg_temp.as_runtime_expect_ok('can register a student',
  $$ INSERT INTO students (school_id, admission_number, first_name, last_name) VALUES ('10000000-0000-4000-8000-0000000000a1', 'ADM/003', 'Esi', 'Boateng') $$);
SELECT pg_temp.as_runtime_expect_ok('can edit a student profile and status',
  $$ UPDATE students SET first_name = 'Akua', admission_number = 'ADM/001A', date_of_birth = '2015-05-05', admitted_on = '2026-09-01', status = 'WITHDRAWN', updated_at = now() WHERE id = '50000000-0000-4000-8000-0000000000a1' $$);
SELECT pg_temp.as_runtime_expect_ok('can create and edit a guardian',
  $$ WITH g AS (INSERT INTO guardians (school_id, full_name, phone) VALUES ('10000000-0000-4000-8000-0000000000a1', 'Second Guardian', '+233241234567') RETURNING id)
     UPDATE guardians SET full_name = 'Renamed Guardian', email = 'g@example.test', updated_at = now() WHERE id IN (SELECT id FROM g) $$);
SELECT pg_temp.as_runtime_expect_ok('can link a guardian and change the relationship and primary flag',
  $$ INSERT INTO student_guardians (student_id, guardian_id, school_id, relationship) VALUES ('50000000-0000-4000-8000-0000000000a2', '60000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'FATHER');
     UPDATE student_guardians SET relationship = 'LEGAL_GUARDIAN', is_primary_contact = true WHERE student_id = '50000000-0000-4000-8000-0000000000a2' $$);
SELECT pg_temp.as_runtime_expect_ok('can un-link a guardian (delete the link row only)',
  $$ DELETE FROM student_guardians WHERE student_id = '50000000-0000-4000-8000-0000000000a2' $$);
SELECT pg_temp.as_runtime_expect_ok('can enroll a student',
  $$ INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id, start_date, end_date)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a2', '40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', '2026-09-01', '2027-07-31') $$);
SELECT pg_temp.as_runtime_expect_ok('can end an enrollment as a class change (status and end date)',
  $$ UPDATE enrollments SET status = 'CLASS_CHANGED', end_date = '2026-11-30', updated_at = now() WHERE id = '90000000-0000-4000-8000-0000000000a1' $$);
SELECT pg_temp.as_runtime_expect_ok('can read subjects and teaching assignments',
  $$ SELECT (SELECT count(*) FROM subjects) + (SELECT count(*) FROM teaching_assignments) $$);
SELECT pg_temp.as_runtime_expect_ok('can create a subject in a class',
  $$ INSERT INTO subjects (school_id, class_id, name, code) VALUES ('10000000-0000-4000-8000-0000000000a1', '40000000-0000-4000-8000-0000000000a1', 'English Language', 'ENG') $$);
SELECT pg_temp.as_runtime_expect_ok('can rename, recode and deactivate a subject',
  $$ UPDATE subjects SET name = 'Maths', code = NULL, is_active = false, updated_at = now() WHERE id = '44000000-0000-4000-8000-0000000000a1' $$);
SELECT pg_temp.as_runtime_expect_ok('can assign a teacher to a subject for a year',
  $$ INSERT INTO teaching_assignments (school_id, subject_id, academic_year_id, user_id)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '44000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000002') $$);
SELECT pg_temp.as_runtime_expect_ok('can end an assignment (status and end time) and keep the row',
  $$ UPDATE teaching_assignments SET status = 'ENDED', ended_at = now(), updated_at = now() WHERE id = '45000000-0000-4000-8000-0000000000a1' $$);
SELECT pg_temp.as_runtime_expect_ok('can read audit events',
  $$ SELECT count(*) FROM audit_events $$);

-- ---- What the API must NOT be able to do: SQLSTATE 42501 ----------------
SELECT pg_temp.as_runtime_expect_error('cannot delete a membership',
  $$ DELETE FROM school_memberships $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move a membership to another school',
  $$ UPDATE school_memberships SET school_id = '10000000-0000-4000-8000-0000000000b1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move a membership to another user',
  $$ UPDATE school_memberships SET user_id = '20000000-0000-4000-8000-000000000001' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot change a role row in place (only delete and insert)',
  $$ UPDATE school_membership_roles SET role = 'OWNER' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot truncate role rows',
  $$ TRUNCATE school_membership_roles $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot re-point a credential to another user (second check)',
  $$ UPDATE user_credentials SET user_id = '20000000-0000-4000-8000-000000000001' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot update a user (cannot self-activate or change status)',
  $$ UPDATE users SET status = 'ACTIVE' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot delete a user',
  $$ DELETE FROM users $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot insert or modify schools',
  $$ UPDATE schools SET name = 'Hacked' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot insert a school',
  $$ INSERT INTO schools (code, name) VALUES ('rogue-school', 'Rogue') $$, '42501');
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
SELECT pg_temp.as_runtime_expect_error('cannot delete a student',
  $$ DELETE FROM students $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move a student to another school',
  $$ UPDATE students SET school_id = '10000000-0000-4000-8000-0000000000b1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot delete a guardian',
  $$ DELETE FROM guardians $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move a guardian to another school',
  $$ UPDATE guardians SET school_id = '10000000-0000-4000-8000-0000000000b1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot re-point a link to another student',
  $$ UPDATE student_guardians SET student_id = '50000000-0000-4000-8000-0000000000a2' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot re-point a link to another guardian',
  $$ UPDATE student_guardians SET guardian_id = '60000000-0000-4000-8000-0000000000a1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot truncate links',
  $$ TRUNCATE student_guardians $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot delete an enrollment',
  $$ DELETE FROM enrollments $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move an enrollment to another class',
  $$ UPDATE enrollments SET class_id = '40000000-0000-4000-8000-0000000000a1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move an enrollment to another student',
  $$ UPDATE enrollments SET student_id = '50000000-0000-4000-8000-0000000000a2' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot rewrite an enrollment start date',
  $$ UPDATE enrollments SET start_date = '2020-01-01' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot delete a subject',
  $$ DELETE FROM subjects $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move a subject to another class',
  $$ UPDATE subjects SET class_id = '40000000-0000-4000-8000-0000000000a1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move a subject to another school',
  $$ UPDATE subjects SET school_id = '10000000-0000-4000-8000-0000000000b1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot delete a teaching assignment',
  $$ DELETE FROM teaching_assignments $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot truncate teaching assignments',
  $$ TRUNCATE teaching_assignments $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot change an assignment''s teacher',
  $$ UPDATE teaching_assignments SET user_id = '20000000-0000-4000-8000-000000000001' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot change an assignment''s subject',
  $$ UPDATE teaching_assignments SET subject_id = '44000000-0000-4000-8000-0000000000a1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot change an assignment''s academic year',
  $$ UPDATE teaching_assignments SET academic_year_id = '30000000-0000-4000-8000-0000000000a1' $$, '42501');
SELECT pg_temp.as_runtime_expect_error('cannot move an assignment to another school',
  $$ UPDATE teaching_assignments SET school_id = '10000000-0000-4000-8000-0000000000b1' $$, '42501');
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
  $$ GRANT UPDATE, DELETE ON users TO ymt_app_runtime $$);
SELECT pg_temp.expect_true('the role still cannot update or delete users after trying to grant itself that',
  $$ SELECT NOT has_table_privilege('ymt_app_runtime', 'users', 'UPDATE')
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
