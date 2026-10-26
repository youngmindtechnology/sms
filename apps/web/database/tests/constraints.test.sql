-- Database constraint tests.
--
-- Run against a database that has had the migrations applied (no seed needed):
--   psql -v ON_ERROR_STOP=1 -X -d <database> -f database/tests/constraints.test.sql
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- so the database is left unchanged. The script exits with an error (non-zero
-- status) if any check fails.
--
-- Safety:
--   1. Refuses to run unless the database name ends in _dev or _test, OR the
--      target was explicitly approved by scripts/run-sql.mjs (psql variable
--      approved_target = a 20-character Supabase project ref; see the seed file).
--   2. Refuses to run unless the database is EMPTY (no schools, users, students).
--      The tests insert their own fixtures and assume nothing else exists, so on
--      a seeded database they would fail. Run them on a separate test database,
--      or on the dev database after migrating and BEFORE seeding.
--   3. Everything runs in one transaction that is rolled back.

\set ON_ERROR_STOP on

BEGIN;

\if :{?approved_target}
  SELECT set_config('ymt.approved_target', :'approved_target', true);
\else
  SELECT set_config('ymt.approved_target', '', true);
\endif

DO $$
BEGIN
  IF current_database() !~ '(_dev|_test)$'
     AND current_setting('ymt.approved_target', true) !~ '^[a-z0-9]{20}$' THEN
    RAISE EXCEPTION 'Refusing to run tests on database "%": name must end in _dev or _test, or the target must be explicitly approved (see database/README.md)', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM schools) OR EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM students) THEN
    RAISE EXCEPTION 'Refusing to run tests: this database already contains data. The constraint tests need an EMPTY database. Use a separate test database, or run them before seeding.';
  END IF;
END $$;

CREATE TEMP TABLE test_results (n serial, label text, ok boolean, detail text);

-- Run `stmt`, expect it to fail with SQLSTATE `state` (and optionally a named constraint).
-- `state` may be a comma-separated list of acceptable SQLSTATEs. This is used ONLY
-- for ON DELETE/UPDATE RESTRICT checks: PostgreSQL 17 and earlier raise 23503
-- (foreign_key_violation) and PostgreSQL 18 raises 23001 (restrict_violation).
-- Any other code still fails the test.
CREATE FUNCTION pg_temp.expect_error(label text, stmt text, state text, constr text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  got_state text;
  got_constr text;
  got_msg text;
BEGIN
  BEGIN
    EXECUTE stmt;
    INSERT INTO test_results(label, ok, detail) VALUES (label, false, 'statement succeeded but should have been rejected');
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    got_state := SQLSTATE;
    GET STACKED DIAGNOSTICS got_constr = CONSTRAINT_NAME, got_msg = MESSAGE_TEXT;
  END;
  IF got_state = ANY (string_to_array(state, ',')) AND (constr IS NULL OR got_constr = constr) THEN
    INSERT INTO test_results(label, ok, detail) VALUES (label, true, coalesce(got_constr, got_msg));
  ELSE
    INSERT INTO test_results(label, ok, detail)
    VALUES (label, false, format('expected %s%s, got %s (%s): %s', state, coalesce(' / ' || constr, ''), got_state, coalesce(got_constr, '-'), got_msg));
  END IF;
END $$;

-- Run `stmt`, expect it to succeed.
CREATE FUNCTION pg_temp.expect_ok(label text, stmt text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE got_msg text;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got_msg = MESSAGE_TEXT;
    INSERT INTO test_results(label, ok, detail) VALUES (label, false, 'unexpected error: ' || got_msg);
    RETURN;
  END;
  INSERT INTO test_results(label, ok, detail) VALUES (label, true, NULL);
END $$;

-- Assert that a boolean query result is true.
CREATE FUNCTION pg_temp.expect_true(label text, query text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE result boolean;
BEGIN
  EXECUTE query INTO result;
  INSERT INTO test_results(label, ok, detail) VALUES (label, coalesce(result, false), CASE WHEN coalesce(result, false) THEN NULL ELSE 'assertion was false' END);
END $$;

-- ===========================================================================
-- Fixtures (all fictional). Two schools with the SAME year name, class name and
-- admission number, but different term structures.
-- Id pattern: <type>000000-0000-4000-8000-0000000000<school+n>
-- ===========================================================================
INSERT INTO schools (id, code, name) VALUES
  ('10000000-0000-4000-8000-0000000000a1', 'test-alpha', 'Test School Alpha'),
  ('10000000-0000-4000-8000-0000000000b1', 'test-bravo', 'Test School Bravo');

INSERT INTO users (id, email, full_name, status) VALUES
  ('20000000-0000-4000-8000-000000000001', 'owner@example.test',   'Test Owner',   'ACTIVE'),
  ('20000000-0000-4000-8000-000000000002', 'teacher@example.test', 'Test Teacher', 'ACTIVE'),
  ('20000000-0000-4000-8000-000000000003', 'support@example.test', 'Test Support', 'ACTIVE');

INSERT INTO platform_staff (user_id, role) VALUES ('20000000-0000-4000-8000-000000000003', 'SUPPORT');

INSERT INTO school_memberships (id, school_id, user_id, status) VALUES
  ('70000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('70000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-000000000001', 'ACTIVE'),
  ('70000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000002', 'ACTIVE');

INSERT INTO school_membership_roles (membership_id, role) VALUES
  ('70000000-0000-4000-8000-0000000000a1', 'OWNER'),
  ('70000000-0000-4000-8000-0000000000a1', 'HEADTEACHER'),
  ('70000000-0000-4000-8000-0000000000a2', 'TEACHER');

INSERT INTO academic_years (id, school_id, name, start_date, end_date, status) VALUES
  ('30000000-0000-4000-8000-0000000000a0', '10000000-0000-4000-8000-0000000000a1', '2025/2026', '2025-09-01', '2026-07-31', 'CLOSED'),
  ('30000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '2026/2027', '2026-09-01', '2027-07-31', 'ACTIVE'),
  ('30000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000b1', '2026/2027', '2026-09-01', '2027-07-31', 'ACTIVE');

-- School Alpha uses 3 terms; School Bravo uses 2 semesters.
INSERT INTO terms (id, school_id, academic_year_id, name, sequence, start_date, end_date, status) VALUES
  ('80000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'Term 1', 1, '2026-09-01', '2026-12-18', 'ACTIVE'),
  ('80000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'Term 2', 2, '2027-01-11', '2027-04-02', 'PLANNED'),
  ('80000000-0000-4000-8000-0000000000a3', '10000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'Term 3', 3, '2027-04-26', '2027-07-31', 'PLANNED'),
  ('80000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000b1', '30000000-0000-4000-8000-0000000000b1', 'Semester 1', 1, '2026-09-01', '2027-01-29', 'ACTIVE'),
  ('80000000-0000-4000-8000-0000000000b2', '10000000-0000-4000-8000-0000000000b1', '30000000-0000-4000-8000-0000000000b1', 'Semester 2', 2, '2027-02-08', '2027-07-31', 'PLANNED');

INSERT INTO classes (id, school_id, name, level, sort_order) VALUES
  ('40000000-0000-4000-8000-0000000000a0', '10000000-0000-4000-8000-0000000000a1', 'Primary 3',   'PRIMARY', 3),
  ('40000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'Primary 4',   'PRIMARY', 4),
  ('40000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-0000000000a1', 'Primary 4 B', 'PRIMARY', 4),
  ('40000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000b1', 'Primary 4',   'PRIMARY', 4);

INSERT INTO students (id, school_id, admission_number, first_name, last_name) VALUES
  ('50000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'ADM-001', 'Test', 'StudentOne'),
  ('50000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-0000000000a1', 'ADM-002', 'Test', 'StudentTwo'),
  ('50000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000b1', 'ADM-001', 'Test', 'StudentThree');

INSERT INTO guardians (id, school_id, full_name, phone) VALUES
  ('60000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'Test Guardian A', '+233201234567'),
  ('60000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000b1', 'Test Guardian B', '+233209876543');

-- One guardian linked to two students (siblings).
INSERT INTO student_guardians (student_id, guardian_id, school_id, relationship, is_primary_contact) VALUES
  ('50000000-0000-4000-8000-0000000000a1', '60000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'MOTHER', true),
  ('50000000-0000-4000-8000-0000000000a2', '60000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'MOTHER', true);

-- Student A1 keeps history: Primary 3 last year, Primary 4 this year.
INSERT INTO enrollments (id, school_id, student_id, class_id, academic_year_id, status, start_date, end_date) VALUES
  ('90000000-0000-4000-8000-0000000000a0', '10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a1', '40000000-0000-4000-8000-0000000000a0', '30000000-0000-4000-8000-0000000000a0', 'PROMOTED', '2025-09-01', '2026-07-31'),
  ('90000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a1', '40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'ENROLLED', '2026-09-01', NULL),
  ('90000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a2', '40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'ENROLLED', '2026-09-01', NULL),
  ('90000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000b1', '50000000-0000-4000-8000-0000000000b1', '40000000-0000-4000-8000-0000000000b1', '30000000-0000-4000-8000-0000000000b1', 'ENROLLED', '2026-09-01', NULL);

-- ===========================================================================
-- Tests
-- ===========================================================================

-- ---- Admission numbers --------------------------------------------------
SELECT pg_temp.expect_true('same admission number exists in two different schools',
  $$ SELECT count(*) = 2 FROM students WHERE admission_number = 'ADM-001' $$);
SELECT pg_temp.expect_error('duplicate admission number in the SAME school is rejected',
  $$ INSERT INTO students (school_id, admission_number, first_name, last_name) VALUES ('10000000-0000-4000-8000-0000000000a1', 'ADM-001', 'Dup', 'Student') $$,
  '23505', 'students_school_id_admission_number_key');
SELECT pg_temp.expect_ok('same admission number is accepted in a different school',
  $$ INSERT INTO students (school_id, admission_number, first_name, last_name) VALUES ('10000000-0000-4000-8000-0000000000b1', 'ADM-002', 'Other', 'School') $$);
SELECT pg_temp.expect_error('lowercase admission number is rejected (must be uppercase)',
  $$ INSERT INTO students (school_id, admission_number, first_name, last_name) VALUES ('10000000-0000-4000-8000-0000000000a1', 'adm-009', 'Low', 'Case') $$,
  '23514', 'students_admission_number_chk');
SELECT pg_temp.expect_error('admission number with surrounding spaces is rejected',
  $$ INSERT INTO students (school_id, admission_number, first_name, last_name) VALUES ('10000000-0000-4000-8000-0000000000a1', ' ADM-010 ', 'Space', 'Pad') $$,
  '23514', 'students_admission_number_chk');
SELECT pg_temp.expect_error('student without a school is rejected',
  $$ INSERT INTO students (school_id, admission_number, first_name, last_name) VALUES (NULL, 'ADM-011', 'No', 'School') $$,
  '23502');

-- ---- Foreign keys: invalid references -----------------------------------
SELECT pg_temp.expect_error('enrollment for a non-existent student is rejected',
  $$ INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id, start_date)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000ff', '40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', '2026-09-01') $$,
  '23503', 'enrollments_student_id_school_id_fkey');
SELECT pg_temp.expect_error('membership for a non-existent school is rejected',
  $$ INSERT INTO school_memberships (school_id, user_id) VALUES ('10000000-0000-4000-8000-0000000000ff', '20000000-0000-4000-8000-000000000002') $$,
  '23503', 'school_memberships_school_id_fkey');

-- ---- Cross-school isolation (composite foreign keys) --------------------
-- NOTE: in each isolation test below, ONLY the cross-school link is wrong. Dates
-- (Jan 2020) overlap nothing, so no other constraint can fire first. (PostgreSQL
-- checks exclusion/unique constraints immediately but foreign keys at the end
-- of the statement, so an input that breaks both reports the former.)
SELECT pg_temp.expect_error('enrollment: class from ANOTHER school is rejected',
  $$ INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id, status, start_date, end_date)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a2', '40000000-0000-4000-8000-0000000000b1', '30000000-0000-4000-8000-0000000000a1', 'WITHDRAWN', '2020-01-01', '2020-01-31') $$,
  '23503', 'enrollments_class_id_school_id_fkey');
SELECT pg_temp.expect_error('enrollment: academic year from ANOTHER school is rejected',
  $$ INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id, status, start_date, end_date)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a2', '40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000b1', 'WITHDRAWN', '2020-01-01', '2020-01-31') $$,
  '23503', 'enrollments_academic_year_id_school_id_fkey');
SELECT pg_temp.expect_error('enrollment: student from ANOTHER school is rejected',
  $$ INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id, status, start_date, end_date)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000b1', '40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'WITHDRAWN', '2020-01-01', '2020-01-31') $$,
  '23503', 'enrollments_student_id_school_id_fkey');
SELECT pg_temp.expect_error('student-guardian link across schools is rejected (guardian of another school)',
  $$ INSERT INTO student_guardians (student_id, guardian_id, school_id, relationship)
     VALUES ('50000000-0000-4000-8000-0000000000a2', '60000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000a1', 'FATHER') $$,
  '23503', 'student_guardians_guardian_id_school_id_fkey');
SELECT pg_temp.expect_error('student-guardian link across schools is rejected (student of another school)',
  $$ INSERT INTO student_guardians (student_id, guardian_id, school_id, relationship)
     VALUES ('50000000-0000-4000-8000-0000000000b1', '60000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'FATHER') $$,
  '23503', 'student_guardians_student_id_school_id_fkey');
SELECT pg_temp.expect_error('term attached to a year of ANOTHER school is rejected',
  -- Dates fall in the gap between Term 1 and Term 2, so no overlap rule can fire.
  $$ INSERT INTO terms (school_id, academic_year_id, name, sequence, start_date, end_date)
     VALUES ('10000000-0000-4000-8000-0000000000b1', '30000000-0000-4000-8000-0000000000a1', 'Bad Term', 9, '2026-12-20', '2026-12-31') $$,
  '23503', 'terms_academic_year_id_school_id_fkey');
-- A fresh student with a unique admission number in school B's namespace, so
-- only the referenced-key update rule can fire.
SELECT pg_temp.expect_error('moving a referenced student to another school is rejected (ON UPDATE RESTRICT)',
  $$ INSERT INTO students (id, school_id, admission_number, first_name, last_name)
       VALUES ('50000000-0000-4000-8000-0000000000a9', '10000000-0000-4000-8000-0000000000a1', 'ADM-777', 'Mover', 'Test');
     INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id, status, start_date, end_date)
       VALUES ('10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a9', '40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'WITHDRAWN', '2020-01-01', '2020-01-31');
     UPDATE students SET school_id = '10000000-0000-4000-8000-0000000000b1' WHERE id = '50000000-0000-4000-8000-0000000000a9' $$,
  '23503,23001', 'enrollments_student_id_school_id_fkey');

-- ---- Enrollment history -------------------------------------------------
SELECT pg_temp.expect_true('promotion keeps history: student A1 has BOTH enrollments',
  $$ SELECT count(*) = 2
       AND count(*) FILTER (WHERE status = 'PROMOTED' AND end_date IS NOT NULL) = 1
       AND count(*) FILTER (WHERE status = 'ENROLLED' AND end_date IS NULL) = 1
     FROM enrollments WHERE student_id = '50000000-0000-4000-8000-0000000000a1' $$);
SELECT pg_temp.expect_ok('mid-year class change: end the old row, start a new one',
  $$ UPDATE enrollments SET status = 'CLASS_CHANGED', end_date = '2026-10-14'
       WHERE id = '90000000-0000-4000-8000-0000000000a2';
     INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id, status, start_date)
       VALUES ('10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a2', '40000000-0000-4000-8000-0000000000a2', '30000000-0000-4000-8000-0000000000a1', 'ENROLLED', '2026-10-15') $$);
SELECT pg_temp.expect_true('class change preserved the old enrollment (student A2 now has 2 rows)',
  $$ SELECT count(*) = 2 FROM enrollments WHERE student_id = '50000000-0000-4000-8000-0000000000a2' $$);
SELECT pg_temp.expect_error('overlapping enrollment for the same student is rejected',
  $$ INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id, status, start_date, end_date)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a1', '40000000-0000-4000-8000-0000000000a2', '30000000-0000-4000-8000-0000000000a1', 'ENROLLED', '2026-11-01', NULL) $$,
  '23P01', 'enrollments_no_overlap_excl');
SELECT pg_temp.expect_error('enrollment ending before it starts is rejected',
  $$ INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id, status, start_date, end_date)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a2', '40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a0', 'WITHDRAWN', '2025-10-10', '2025-10-01') $$,
  '23514', 'enrollments_dates_chk');
SELECT pg_temp.expect_error('finished enrollment (not ENROLLED) without an end date is rejected',
  $$ INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id, status, start_date, end_date)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a2', '40000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a0', 'WITHDRAWN', '2025-10-01', NULL) $$,
  '23514', 'enrollments_ended_when_not_enrolled_chk');

-- ---- Academic years and terms ------------------------------------------
SELECT pg_temp.expect_true('two schools may share the same academic year name and dates',
  $$ SELECT count(*) = 2 FROM academic_years WHERE name = '2026/2027' $$);
SELECT pg_temp.expect_true('schools may use different term structures (3 terms vs 2 semesters)',
  $$ SELECT (SELECT count(*) FROM terms WHERE school_id = '10000000-0000-4000-8000-0000000000a1') = 3
        AND (SELECT count(*) FROM terms WHERE school_id = '10000000-0000-4000-8000-0000000000b1') = 2 $$);
SELECT pg_temp.expect_error('academic year ending on or before its start is rejected',
  $$ INSERT INTO academic_years (school_id, name, start_date, end_date) VALUES ('10000000-0000-4000-8000-0000000000a1', '2030/2031', '2030-09-01', '2030-09-01') $$,
  '23514', 'academic_years_dates_chk');
SELECT pg_temp.expect_error('duplicate academic year name in the same school is rejected',
  $$ INSERT INTO academic_years (school_id, name, start_date, end_date) VALUES ('10000000-0000-4000-8000-0000000000a1', '2026/2027', '2040-09-01', '2041-07-31') $$,
  '23505', 'academic_years_school_id_name_key');
SELECT pg_temp.expect_error('overlapping academic years in the same school are rejected',
  $$ INSERT INTO academic_years (school_id, name, start_date, end_date) VALUES ('10000000-0000-4000-8000-0000000000a1', '2026 overlap', '2027-06-01', '2028-05-31') $$,
  '23P01', 'academic_years_no_overlap_excl');
SELECT pg_temp.expect_error('a second ACTIVE academic year in the same school is rejected',
  $$ INSERT INTO academic_years (school_id, name, start_date, end_date, status) VALUES ('10000000-0000-4000-8000-0000000000a1', '2027/2028', '2027-09-01', '2028-07-31', 'ACTIVE') $$,
  '23P01', 'academic_years_one_active_excl');
SELECT pg_temp.expect_error('term ending on or before its start is rejected',
  $$ INSERT INTO terms (school_id, academic_year_id, name, sequence, start_date, end_date) VALUES ('10000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'Term X', 7, '2026-09-10', '2026-09-10') $$,
  '23514', 'terms_dates_chk');
SELECT pg_temp.expect_error('duplicate term sequence in the same year is rejected',
  $$ INSERT INTO terms (school_id, academic_year_id, name, sequence, start_date, end_date) VALUES ('10000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'Term Dup', 1, '2027-06-01', '2027-06-20') $$,
  '23505', 'terms_academic_year_id_sequence_key');
SELECT pg_temp.expect_error('overlapping terms in the same year are rejected',
  $$ INSERT INTO terms (school_id, academic_year_id, name, sequence, start_date, end_date) VALUES ('10000000-0000-4000-8000-0000000000a1', '30000000-0000-4000-8000-0000000000a1', 'Term Overlap', 4, '2026-12-01', '2027-01-20') $$,
  '23P01', 'terms_no_overlap_excl');
SELECT pg_temp.expect_error('a second ACTIVE term in the same school is rejected',
  $$ UPDATE terms SET status = 'ACTIVE' WHERE id = '80000000-0000-4000-8000-0000000000a2' $$,
  '23P01', 'terms_one_active_excl');

-- ---- Classes and subjects ----------------------------------------------
SELECT pg_temp.expect_true('two schools may both have a class named "Primary 4"',
  $$ SELECT count(*) = 2 FROM classes WHERE name = 'Primary 4' $$);
SELECT pg_temp.expect_error('duplicate class name in the same school is rejected',
  $$ INSERT INTO classes (school_id, name, level) VALUES ('10000000-0000-4000-8000-0000000000a1', 'Primary 4', 'PRIMARY') $$,
  '23505', 'classes_school_id_name_key');
SELECT pg_temp.expect_ok('two schools may both have a subject named "Mathematics"',
  $$ INSERT INTO subjects (school_id, name, code) VALUES
       ('10000000-0000-4000-8000-0000000000a1', 'Mathematics', 'MATH'),
       ('10000000-0000-4000-8000-0000000000b1', 'Mathematics', 'MATH') $$);
SELECT pg_temp.expect_error('duplicate subject name in the same school is rejected',
  $$ INSERT INTO subjects (school_id, name) VALUES ('10000000-0000-4000-8000-0000000000a1', 'Mathematics') $$,
  '23505', 'subjects_school_id_name_key');
SELECT pg_temp.expect_ok('several subjects without a code are allowed in one school (NULL codes do not collide)',
  $$ INSERT INTO subjects (school_id, name) VALUES
       ('10000000-0000-4000-8000-0000000000a1', 'Art'),
       ('10000000-0000-4000-8000-0000000000a1', 'Music') $$);

-- ---- Guardians ----------------------------------------------------------
SELECT pg_temp.expect_true('one guardian can be linked to several students',
  $$ SELECT count(*) = 2 FROM student_guardians WHERE guardian_id = '60000000-0000-4000-8000-0000000000a1' $$);
SELECT pg_temp.expect_error('linking the same guardian to the same student twice is rejected',
  $$ INSERT INTO student_guardians (student_id, guardian_id, school_id, relationship)
     VALUES ('50000000-0000-4000-8000-0000000000a1', '60000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-0000000000a1', 'MOTHER') $$,
  '23505', 'student_guardians_pkey');
SELECT pg_temp.expect_error('a second primary contact for the same student is rejected',
  $$ INSERT INTO guardians (id, school_id, full_name) VALUES ('60000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-0000000000a1', 'Test Guardian A2');
     INSERT INTO student_guardians (student_id, guardian_id, school_id, relationship, is_primary_contact)
     VALUES ('50000000-0000-4000-8000-0000000000a1', '60000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-0000000000a1', 'FATHER', true) $$,
  '23P01', 'student_guardians_one_primary_excl');
SELECT pg_temp.expect_error('guardian phone not in international format is rejected',
  $$ INSERT INTO guardians (school_id, full_name, phone) VALUES ('10000000-0000-4000-8000-0000000000a1', 'Bad Phone', '0201234567') $$,
  '23514', 'guardians_phone_chk');
SELECT pg_temp.expect_ok('two guardians may share a phone number (decision D1)',
  $$ INSERT INTO guardians (school_id, full_name, phone) VALUES
       ('10000000-0000-4000-8000-0000000000a1', 'Shared Phone One', '+233500000001'),
       ('10000000-0000-4000-8000-0000000000a1', 'Shared Phone Two', '+233500000001') $$);

-- ---- Users, memberships, roles -----------------------------------------
SELECT pg_temp.expect_error('duplicate user email is rejected',
  $$ INSERT INTO users (email, full_name) VALUES ('owner@example.test', 'Another Owner') $$,
  '23505', 'users_email_key');
SELECT pg_temp.expect_error('non-normalised (uppercase) user email is rejected',
  $$ INSERT INTO users (email, full_name) VALUES ('Mixed@Example.Test', 'Mixed Case') $$,
  '23514', 'users_email_chk');
SELECT pg_temp.expect_true('one user can belong to two schools',
  $$ SELECT count(DISTINCT school_id) = 2 FROM school_memberships WHERE user_id = '20000000-0000-4000-8000-000000000001' $$);
SELECT pg_temp.expect_error('a second membership for the same user and school is rejected',
  $$ INSERT INTO school_memberships (school_id, user_id) VALUES ('10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000001') $$,
  '23505', 'school_memberships_school_id_user_id_key');
SELECT pg_temp.expect_true('one membership can hold several roles',
  $$ SELECT count(*) = 2 FROM school_membership_roles WHERE membership_id = '70000000-0000-4000-8000-0000000000a1' $$);
SELECT pg_temp.expect_error('the same role twice on one membership is rejected',
  $$ INSERT INTO school_membership_roles (membership_id, role) VALUES ('70000000-0000-4000-8000-0000000000a1', 'OWNER') $$,
  '23505', 'school_membership_roles_pkey');
SELECT pg_temp.expect_error('an unknown role value is rejected',
  $$ INSERT INTO school_membership_roles (membership_id, role) VALUES ('70000000-0000-4000-8000-0000000000a2', 'JANITOR') $$,
  '22P02');
SELECT pg_temp.expect_error('an ENDED membership without an end time is rejected',
  $$ UPDATE school_memberships SET status = 'ENDED' WHERE id = '70000000-0000-4000-8000-0000000000a2' $$,
  '23514', 'school_memberships_ended_chk');

-- ---- School data -------------------------------------------------------
SELECT pg_temp.expect_error('duplicate school code is rejected',
  $$ INSERT INTO schools (code, name) VALUES ('test-alpha', 'Copycat') $$,
  '23505', 'schools_code_key');
SELECT pg_temp.expect_error('school code with spaces/uppercase is rejected',
  $$ INSERT INTO schools (code, name) VALUES ('Bad Code', 'Bad') $$,
  '23514', 'schools_code_format_chk');

-- ---- Platform support access ------------------------------------------
SELECT pg_temp.expect_ok('a support grant of 3 days is accepted',
  $$ INSERT INTO support_access_grants (school_id, staff_user_id, granted_by_user_id, reason, starts_at, expires_at)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'Investigating import issue', now(), now() + interval '3 days') $$);
SELECT pg_temp.expect_error('a support grant longer than 7 days is rejected',
  $$ INSERT INTO support_access_grants (school_id, staff_user_id, granted_by_user_id, reason, starts_at, expires_at)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'Too long', now(), now() + interval '8 days') $$,
  '23514', 'support_access_grants_window_chk');
SELECT pg_temp.expect_error('a support grant without a reason is rejected',
  $$ INSERT INTO support_access_grants (school_id, staff_user_id, granted_by_user_id, reason, starts_at, expires_at)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', '   ', now(), now() + interval '1 day') $$,
  '23514', 'support_access_grants_reason_chk');
SELECT pg_temp.expect_error('a support grant for a user who is not platform staff is rejected',
  $$ INSERT INTO support_access_grants (school_id, staff_user_id, granted_by_user_id, reason, starts_at, expires_at)
     VALUES ('10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'Not staff', now(), now() + interval '1 day') $$,
  '23503', 'support_access_grants_staff_user_id_fkey');
SELECT pg_temp.expect_true('platform staff status alone gives no school membership',
  $$ SELECT NOT EXISTS (SELECT 1 FROM school_memberships WHERE user_id = '20000000-0000-4000-8000-000000000003') $$);

-- ---- Audit events: append-only ----------------------------------------
SELECT pg_temp.expect_ok('an audit event can be appended',
  $$ INSERT INTO audit_events (id, school_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000001',
             'membership.role_granted', 'school_membership', '70000000-0000-4000-8000-0000000000a2', '{"role": "TEACHER"}') $$);
SELECT pg_temp.expect_error('an audit event cannot be updated',
  $$ UPDATE audit_events SET action = 'tampered' $$, '23000');
SELECT pg_temp.expect_error('an audit event cannot be deleted',
  $$ DELETE FROM audit_events $$, '23000');
SELECT pg_temp.expect_error('the audit table cannot be truncated',
  $$ TRUNCATE audit_events $$, '23000');
SELECT pg_temp.expect_error('audit metadata must be a JSON object',
  $$ INSERT INTO audit_events (action, entity_type, metadata) VALUES ('x.y', 'thing', '[1,2]') $$,
  '23514', 'audit_events_metadata_chk');

-- ---- Deletion safety (RESTRICT everywhere) -----------------------------
SELECT pg_temp.expect_error('a school with data cannot be deleted',
  $$ DELETE FROM schools WHERE id = '10000000-0000-4000-8000-0000000000a1' $$, '23503,23001');
SELECT pg_temp.expect_error('a student with enrollments cannot be deleted',
  $$ DELETE FROM students WHERE id = '50000000-0000-4000-8000-0000000000a1' $$, '23503,23001');
SELECT pg_temp.expect_error('a class with enrollments cannot be deleted',
  $$ DELETE FROM classes WHERE id = '40000000-0000-4000-8000-0000000000a1' $$, '23503,23001');
SELECT pg_temp.expect_error('an academic year with terms or enrollments cannot be deleted',
  $$ DELETE FROM academic_years WHERE id = '30000000-0000-4000-8000-0000000000a1' $$, '23503,23001');
SELECT pg_temp.expect_error('a user with memberships cannot be deleted',
  $$ DELETE FROM users WHERE id = '20000000-0000-4000-8000-000000000001' $$, '23503,23001');

-- ---- Structural: every school-owned table has a NOT NULL school_id ---------
-- Any table NOT on this allow-list must carry a NOT NULL school_id. A future
-- table added without school_id makes this test fail until it is either given
-- a school_id or deliberately added to the list (a conscious, reviewable step).
--   schools                  : the tenant itself
--   users, platform_staff    : platform-level identities, not school-owned
--   school_membership_roles  : child of school_memberships (which has school_id)
--   audit_events             : school_id is NULL for platform-level events
--   user_credentials, sessions: authentication storage, keyed by user (a session's
--                              active_school_id is nullable by design)
--   _prisma_migrations       : Prisma's own bookkeeping table
SELECT pg_temp.expect_true('every table has a NOT NULL school_id unless explicitly allow-listed',
  $$ SELECT NOT EXISTS (
       SELECT 1 FROM information_schema.tables t
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND t.table_name NOT IN ('schools','users','platform_staff','school_membership_roles','audit_events','user_credentials','sessions','_prisma_migrations')
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = t.table_name
               AND c.column_name = 'school_id' AND c.is_nullable = 'NO')) $$);
SELECT pg_temp.expect_true('the structural check covers the 10 school-owned tables',
  $$ SELECT count(*) = 10 FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'school_id' AND is_nullable = 'NO' $$);

-- ---- Defaults ----------------------------------------------------------
SELECT pg_temp.expect_ok('a row can be inserted without an id',
  $$ INSERT INTO classes (school_id, name, level) VALUES ('10000000-0000-4000-8000-0000000000a1', 'Default Id Check', 'JHS') $$);
SELECT pg_temp.expect_true('the database generated a non-null id for that row',
  $$ SELECT count(*) = 1 FROM classes WHERE name = 'Default Id Check' AND id IS NOT NULL $$);

-- ---- Authentication: credentials and sessions ---------------------------
-- Fixture values are obviously fake. Token hashes are 32 arbitrary bytes.
SELECT pg_temp.expect_ok('a credential with an argon2id-format hash is accepted',
  $$ INSERT INTO user_credentials (user_id, password_hash, algorithm)
     VALUES ('20000000-0000-4000-8000-000000000001', '$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHQ$ZmFrZWhhc2hmb3J0ZXN0aW5n', 'argon2id') $$);
SELECT pg_temp.expect_ok('a credential with a scrypt-format hash is accepted',
  $$ INSERT INTO user_credentials (user_id, password_hash, algorithm)
     VALUES ('20000000-0000-4000-8000-000000000002', 'scrypt$16384$8$1$ZmFrZXNhbHQ$ZmFrZWhhc2hmb3J0ZXN0aW5n', 'scrypt') $$);
SELECT pg_temp.expect_error('a second credential for the same user is rejected',
  $$ INSERT INTO user_credentials (user_id, password_hash, algorithm)
     VALUES ('20000000-0000-4000-8000-000000000001', '$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHQ$ZmFrZWhhc2hmb3J0ZXN0aW5n', 'argon2id') $$,
  '23505', 'user_credentials_pkey');
SELECT pg_temp.expect_error('a credential for a non-existent user is rejected',
  $$ INSERT INTO user_credentials (user_id, password_hash, algorithm)
     VALUES ('20000000-0000-4000-8000-0000000000ee', '$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHQ$ZmFrZWhhc2hmb3J0ZXN0aW5n', 'argon2id') $$,
  '23503', 'user_credentials_user_id_fkey');
SELECT pg_temp.expect_error('a plain-text style password is rejected (hash format check)',
  $$ INSERT INTO user_credentials (user_id, password_hash, algorithm)
     VALUES ('20000000-0000-4000-8000-000000000003', 'correct horse battery staple', 'argon2id') $$,
  '23514', 'user_credentials_hash_format_chk');
SELECT pg_temp.expect_error('an algorithm that does not match the hash prefix is rejected',
  $$ INSERT INTO user_credentials (user_id, password_hash, algorithm)
     VALUES ('20000000-0000-4000-8000-000000000003', 'scrypt$16384$8$1$ZmFrZXNhbHQ$ZmFrZWhhc2hmb3J0ZXN0aW5n', 'argon2id') $$,
  '23514', 'user_credentials_hash_format_chk');
SELECT pg_temp.expect_error('an unknown algorithm name is rejected',
  $$ INSERT INTO user_credentials (user_id, password_hash, algorithm)
     VALUES ('20000000-0000-4000-8000-000000000003', 'md5$ZmFrZXNhbHQ$ZmFrZWhhc2hmb3J0ZXN0aW5n', 'md5') $$,
  '23514', 'user_credentials_algorithm_chk');
SELECT pg_temp.expect_error('a negative failed-login counter is rejected',
  $$ UPDATE user_credentials SET failed_login_count = -1 WHERE user_id = '20000000-0000-4000-8000-000000000001' $$,
  '23514', 'user_credentials_failed_count_chk');
SELECT pg_temp.expect_error('a user with a credential cannot be deleted',
  $$ DELETE FROM users WHERE id = '20000000-0000-4000-8000-000000000002' $$, '23503,23001');

SELECT pg_temp.expect_ok('a session with an active school the user belongs to is accepted',
  $$ INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, active_school_id, expires_at)
     VALUES ('a0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
             decode(repeat('11', 32), 'hex'), decode(repeat('21', 32), 'hex'),
             '10000000-0000-4000-8000-0000000000a1', now() + interval '8 hours') $$);
SELECT pg_temp.expect_ok('a session without an active school (just logged in) is accepted',
  $$ INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, expires_at)
     VALUES ('a0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002',
             decode(repeat('12', 32), 'hex'), decode(repeat('22', 32), 'hex'), now() + interval '8 hours') $$);
SELECT pg_temp.expect_error('a session cannot name a school the user has no membership in',
  $$ INSERT INTO sessions (user_id, token_hash, csrf_token_hash, active_school_id, expires_at)
     VALUES ('20000000-0000-4000-8000-000000000002', decode(repeat('13', 32), 'hex'), decode(repeat('23', 32), 'hex'),
             '10000000-0000-4000-8000-0000000000b1', now() + interval '8 hours') $$,
  '23503', 'sessions_active_school_id_user_id_fkey');
SELECT pg_temp.expect_error('a session cannot name a school that does not exist',
  $$ INSERT INTO sessions (user_id, token_hash, csrf_token_hash, active_school_id, expires_at)
     VALUES ('20000000-0000-4000-8000-000000000001', decode(repeat('14', 32), 'hex'), decode(repeat('24', 32), 'hex'),
             '10000000-0000-4000-8000-0000000000ee', now() + interval '8 hours') $$,
  '23503', 'sessions_active_school_id_user_id_fkey');
SELECT pg_temp.expect_error('a session for a non-existent user is rejected',
  $$ INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at)
     VALUES ('20000000-0000-4000-8000-0000000000ee', decode(repeat('15', 32), 'hex'), decode(repeat('25', 32), 'hex'), now() + interval '8 hours') $$,
  '23503', 'sessions_user_id_fkey');
SELECT pg_temp.expect_error('two sessions cannot share a token hash',
  $$ INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at)
     VALUES ('20000000-0000-4000-8000-000000000002', decode(repeat('11', 32), 'hex'), decode(repeat('26', 32), 'hex'), now() + interval '8 hours') $$,
  '23505', 'sessions_token_hash_key');
SELECT pg_temp.expect_error('a token hash that is not 32 bytes is rejected (raw tokens cannot be stored)',
  $$ INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at)
     VALUES ('20000000-0000-4000-8000-000000000002', convert_to('raw-looking-token-value', 'UTF8'), decode(repeat('27', 32), 'hex'), now() + interval '8 hours') $$,
  '23514', 'sessions_token_hash_len_chk');
SELECT pg_temp.expect_error('a CSRF hash that is not 32 bytes is rejected',
  $$ INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at)
     VALUES ('20000000-0000-4000-8000-000000000002', decode(repeat('16', 32), 'hex'), decode('00', 'hex'), now() + interval '8 hours') $$,
  '23514', 'sessions_csrf_hash_len_chk');
SELECT pg_temp.expect_error('a session that expires before it was created is rejected',
  $$ INSERT INTO sessions (user_id, token_hash, csrf_token_hash, created_at, expires_at)
     VALUES ('20000000-0000-4000-8000-000000000002', decode(repeat('17', 32), 'hex'), decode(repeat('28', 32), 'hex'), now(), now() - interval '1 hour') $$,
  '23514', 'sessions_expiry_chk');
SELECT pg_temp.expect_error('revoking a session without a reason is rejected',
  $$ UPDATE sessions SET revoked_at = now() WHERE id = 'a0000000-0000-4000-8000-000000000002' $$,
  '23514', 'sessions_revocation_chk');
SELECT pg_temp.expect_error('a revocation reason without a revocation time is rejected',
  $$ UPDATE sessions SET revoked_reason = 'logout' WHERE id = 'a0000000-0000-4000-8000-000000000002' $$,
  '23514', 'sessions_revocation_chk');
SELECT pg_temp.expect_error('an unknown revocation reason is rejected',
  $$ UPDATE sessions SET revoked_at = now(), revoked_reason = 'because' WHERE id = 'a0000000-0000-4000-8000-000000000002' $$,
  '23514', 'sessions_revocation_chk');
SELECT pg_temp.expect_ok('revoking a session with a valid reason is accepted',
  $$ UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = 'a0000000-0000-4000-8000-000000000002' $$);
SELECT pg_temp.expect_error('a membership that a session points at cannot be deleted',
  $$ DELETE FROM school_memberships WHERE id = '70000000-0000-4000-8000-0000000000a1' $$, '23503,23001');
SELECT pg_temp.expect_error('switching a session to a school without membership via UPDATE is rejected',
  $$ UPDATE sessions SET active_school_id = '10000000-0000-4000-8000-0000000000b1' WHERE id = 'a0000000-0000-4000-8000-000000000002' $$,
  '23503', 'sessions_active_school_id_user_id_fkey');
SELECT pg_temp.expect_ok('switching a session to a school the user belongs to via UPDATE is accepted',
  $$ UPDATE sessions SET active_school_id = '10000000-0000-4000-8000-0000000000b1' WHERE id = 'a0000000-0000-4000-8000-000000000001' $$);
SELECT pg_temp.expect_true('the users table has no column that could hold a password or token',
  $$ SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'
         AND column_name ~* '(pass|hash|token|secret)') $$);

-- ===========================================================================
-- Report
-- ===========================================================================
\echo
\echo '=== Constraint test results ==='
SELECT lpad(n::text, 3) AS "#", CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, label, CASE WHEN ok THEN '' ELSE detail END AS detail
  FROM test_results ORDER BY n;

SELECT count(*) AS total, count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM test_results;

DO $$
DECLARE failed int;
BEGIN
  SELECT count(*) INTO failed FROM test_results WHERE NOT ok;
  IF failed > 0 THEN
    RAISE EXCEPTION '% constraint test(s) FAILED', failed;
  END IF;
END $$;

ROLLBACK;
