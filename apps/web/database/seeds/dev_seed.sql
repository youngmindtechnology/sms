-- DEVELOPMENT AND TEST SEED DATA. FICTIONAL. NEVER FOR PRODUCTION.
--
-- Everything here is invented: school names, people (every surname is "Demo"),
-- phone numbers (not real) and email addresses (reserved example.test domain).
-- It contains no real student data and no credentials of any kind.
--
-- Usage:
--   psql -v ON_ERROR_STOP=1 -X -d <database_ending_in_dev_or_test> -f database/seeds/dev_seed.sql
--
-- Safety:
--   1. Refuses to run unless the database name ends in _dev or _test, OR the
--      target was explicitly approved by scripts/run-sql.mjs (which passes the
--      psql variable approved_target = a 20-character Supabase project ref only
--      after checking YMT_ENV, YMT_APPROVED_TARGET_REF and --approve-target).
--      A Supabase database is normally named "postgres", so it needs approval.
--   2. Refuses to run if the database already contains any school whose code
--      does not start with "demo-" (i.e. looks like real data). Approval does
--      NOT bypass this check.
--   3. Repeatable: ids are derived deterministically and every insert uses
--      ON CONFLICT DO NOTHING, so a second run changes nothing.
--   4. Runs in a single transaction: all or nothing.
--   5. Nothing in the project runs this file automatically.

\set ON_ERROR_STOP on

BEGIN;

-- Hand the (optional) approval to the guard below. Without the variable the
-- value is empty and only the _dev/_test name rule can pass.
\if :{?approved_target}
  SELECT set_config('ymt.approved_target', :'approved_target', true);
\else
  SELECT set_config('ymt.approved_target', '', true);
\endif

DO $$
BEGIN
  IF current_database() !~ '(_dev|_test)$'
     AND current_setting('ymt.approved_target', true) !~ '^[a-z0-9]{20}$' THEN
    RAISE EXCEPTION 'Refusing to seed database "%": name must end in _dev or _test, or the target must be explicitly approved (see database/README.md)', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM schools WHERE code NOT LIKE 'demo-%') THEN
    RAISE EXCEPTION 'Refusing to seed: this database contains schools that are not demo schools';
  END IF;
END $$;

-- Deterministic id from a readable key, e.g. sid('student:sunrise:1').
CREATE FUNCTION pg_temp.sid(key text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('ymt-dev-seed:' || key)::uuid $$;

-- ---------------------------------------------------------------------------
-- Schools: Sunrise uses three terms, Harvest uses two semesters.
-- ---------------------------------------------------------------------------
INSERT INTO schools (id, code, name, contact_email, contact_phone) VALUES
  (pg_temp.sid('school:sunrise'), 'demo-sunrise', 'Demo Sunrise Basic School', 'office@sunrise.example.test', '+233300000001'),
  (pg_temp.sid('school:harvest'), 'demo-harvest', 'Demo Harvest Academy',      'office@harvest.example.test', '+233300000002')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Users (no passwords exist yet; authentication is a later phase)
-- ---------------------------------------------------------------------------
INSERT INTO users (id, email, full_name, status) VALUES
  (pg_temp.sid('user:owner-sunrise'),   'owner.sunrise@example.test',   'Demo Owner Sunrise',     'ACTIVE'),
  (pg_temp.sid('user:head-sunrise'),    'head.sunrise@example.test',    'Demo Headteacher Sunrise', 'ACTIVE'),
  (pg_temp.sid('user:bursar-sunrise'),  'bursar.sunrise@example.test',  'Demo Bursar Sunrise',    'ACTIVE'),
  (pg_temp.sid('user:teacher-shared'),  'teacher.shared@example.test',  'Demo Teacher Shared',    'ACTIVE'),
  (pg_temp.sid('user:admin-harvest'),   'admin.harvest@example.test',   'Demo Admin Harvest',     'ACTIVE'),
  (pg_temp.sid('user:support'),         'support@example.test',         'Demo Platform Support',  'ACTIVE')
ON CONFLICT DO NOTHING;

INSERT INTO platform_staff (user_id, role) VALUES
  (pg_temp.sid('user:support'), 'SUPPORT')
ON CONFLICT DO NOTHING;

-- Memberships. The shared teacher belongs to BOTH schools.
INSERT INTO school_memberships (id, school_id, user_id, status) VALUES
  (pg_temp.sid('member:owner-sunrise'),   pg_temp.sid('school:sunrise'), pg_temp.sid('user:owner-sunrise'),  'ACTIVE'),
  (pg_temp.sid('member:head-sunrise'),    pg_temp.sid('school:sunrise'), pg_temp.sid('user:head-sunrise'),   'ACTIVE'),
  (pg_temp.sid('member:bursar-sunrise'),  pg_temp.sid('school:sunrise'), pg_temp.sid('user:bursar-sunrise'), 'ACTIVE'),
  (pg_temp.sid('member:teacher-sunrise'), pg_temp.sid('school:sunrise'), pg_temp.sid('user:teacher-shared'), 'ACTIVE'),
  (pg_temp.sid('member:teacher-harvest'), pg_temp.sid('school:harvest'), pg_temp.sid('user:teacher-shared'), 'ACTIVE'),
  (pg_temp.sid('member:admin-harvest'),   pg_temp.sid('school:harvest'), pg_temp.sid('user:admin-harvest'),  'ACTIVE')
ON CONFLICT DO NOTHING;

INSERT INTO school_membership_roles (membership_id, role) VALUES
  (pg_temp.sid('member:owner-sunrise'),   'OWNER'),
  (pg_temp.sid('member:head-sunrise'),    'HEADTEACHER'),
  (pg_temp.sid('member:head-sunrise'),    'TEACHER'),
  (pg_temp.sid('member:bursar-sunrise'),  'BURSAR'),
  (pg_temp.sid('member:teacher-sunrise'), 'TEACHER'),
  (pg_temp.sid('member:teacher-harvest'), 'TEACHER'),
  (pg_temp.sid('member:admin-harvest'),   'OWNER'),
  (pg_temp.sid('member:admin-harvest'),   'ADMINISTRATOR')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Academic years and terms
-- ---------------------------------------------------------------------------
INSERT INTO academic_years (id, school_id, name, start_date, end_date, status) VALUES
  (pg_temp.sid('year:sunrise:2025'), pg_temp.sid('school:sunrise'), '2025/2026', '2025-09-01', '2026-07-31', 'CLOSED'),
  (pg_temp.sid('year:sunrise:2026'), pg_temp.sid('school:sunrise'), '2026/2027', '2026-09-01', '2027-07-31', 'ACTIVE'),
  (pg_temp.sid('year:harvest:2026'), pg_temp.sid('school:harvest'), '2026/2027', '2026-09-01', '2027-07-31', 'ACTIVE')
ON CONFLICT DO NOTHING;

INSERT INTO terms (id, school_id, academic_year_id, name, sequence, start_date, end_date, status) VALUES
  (pg_temp.sid('term:sunrise:1'), pg_temp.sid('school:sunrise'), pg_temp.sid('year:sunrise:2026'), 'Term 1', 1, '2026-09-01', '2026-12-18', 'ACTIVE'),
  (pg_temp.sid('term:sunrise:2'), pg_temp.sid('school:sunrise'), pg_temp.sid('year:sunrise:2026'), 'Term 2', 2, '2027-01-11', '2027-04-02', 'PLANNED'),
  (pg_temp.sid('term:sunrise:3'), pg_temp.sid('school:sunrise'), pg_temp.sid('year:sunrise:2026'), 'Term 3', 3, '2027-04-26', '2027-07-31', 'PLANNED'),
  (pg_temp.sid('term:harvest:1'), pg_temp.sid('school:harvest'), pg_temp.sid('year:harvest:2026'), 'Semester 1', 1, '2026-09-01', '2027-01-29', 'ACTIVE'),
  (pg_temp.sid('term:harvest:2'), pg_temp.sid('school:harvest'), pg_temp.sid('year:harvest:2026'), 'Semester 2', 2, '2027-02-08', '2027-07-31', 'PLANNED')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Classes (streams are simply separate classes) and subjects
-- ---------------------------------------------------------------------------
INSERT INTO classes (id, school_id, name, level, sort_order) VALUES
  (pg_temp.sid('class:sunrise:n1'),  pg_temp.sid('school:sunrise'), 'Nursery 1',     'NURSERY',      1),
  (pg_temp.sid('class:sunrise:kg1'), pg_temp.sid('school:sunrise'), 'Kindergarten 1','KINDERGARTEN', 3),
  (pg_temp.sid('class:sunrise:p3'),  pg_temp.sid('school:sunrise'), 'Primary 3',     'PRIMARY',      7),
  (pg_temp.sid('class:sunrise:p4a'), pg_temp.sid('school:sunrise'), 'Primary 4 A',   'PRIMARY',      8),
  (pg_temp.sid('class:sunrise:p4b'), pg_temp.sid('school:sunrise'), 'Primary 4 B',   'PRIMARY',      8),
  (pg_temp.sid('class:sunrise:j1'),  pg_temp.sid('school:sunrise'), 'JHS 1',         'JHS',         13),
  (pg_temp.sid('class:harvest:p4'),  pg_temp.sid('school:harvest'), 'Primary 4',     'PRIMARY',      8),
  (pg_temp.sid('class:harvest:j1'),  pg_temp.sid('school:harvest'), 'JHS 1',         'JHS',         13)
ON CONFLICT DO NOTHING;

INSERT INTO subjects (id, school_id, class_id, name, code) VALUES
  (pg_temp.sid('subject:sunrise:p4a:eng'),  pg_temp.sid('school:sunrise'), pg_temp.sid('class:sunrise:p4a'), 'English Language', 'ENG'),
  (pg_temp.sid('subject:sunrise:p4a:math'), pg_temp.sid('school:sunrise'), pg_temp.sid('class:sunrise:p4a'), 'Mathematics',      'MATH'),
  (pg_temp.sid('subject:sunrise:p3:math'),  pg_temp.sid('school:sunrise'), pg_temp.sid('class:sunrise:p3'),  'Mathematics',      'MATH'),
  (pg_temp.sid('subject:sunrise:j1:sci'),   pg_temp.sid('school:sunrise'), pg_temp.sid('class:sunrise:j1'),  'Integrated Science','SCI'),
  (pg_temp.sid('subject:harvest:p4:eng'),   pg_temp.sid('school:harvest'), pg_temp.sid('class:harvest:p4'),  'English Language', 'ENG'),
  (pg_temp.sid('subject:harvest:p4:math'),  pg_temp.sid('school:harvest'), pg_temp.sid('class:harvest:p4'),  'Mathematics',      'MATH')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Students. Both schools use ADM-0001..: admission numbers are per school.
-- ---------------------------------------------------------------------------
INSERT INTO students (id, school_id, admission_number, first_name, last_name, date_of_birth, admitted_on) VALUES
  (pg_temp.sid('student:sunrise:1'), pg_temp.sid('school:sunrise'), 'ADM-0001', 'Ama',   'Demo', '2016-03-14', '2023-09-04'),
  (pg_temp.sid('student:sunrise:2'), pg_temp.sid('school:sunrise'), 'ADM-0002', 'Kofi',  'Demo', '2016-07-02', '2023-09-04'),
  (pg_temp.sid('student:sunrise:3'), pg_temp.sid('school:sunrise'), 'ADM-0003', 'Esi',   'Demo', '2016-11-21', '2024-09-02'),
  (pg_temp.sid('student:sunrise:4'), pg_temp.sid('school:sunrise'), 'ADM-0004', 'Yaw',   'Demo', '2021-05-09', '2026-09-01'),
  (pg_temp.sid('student:harvest:1'), pg_temp.sid('school:harvest'), 'ADM-0001', 'Abena', 'Demo', '2016-01-30', '2024-09-02'),
  (pg_temp.sid('student:harvest:2'), pg_temp.sid('school:harvest'), 'ADM-0002', 'Kwame', 'Demo', '2013-08-17', '2022-09-05'),
  (pg_temp.sid('student:harvest:3'), pg_temp.sid('school:harvest'), 'ADM-0003', 'Akosua','Demo', '2016-12-05', '2024-09-02')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Guardians. Sunrise guardian 1 is the primary contact of two siblings.
-- ---------------------------------------------------------------------------
INSERT INTO guardians (id, school_id, full_name, phone, email) VALUES
  (pg_temp.sid('guardian:sunrise:1'), pg_temp.sid('school:sunrise'), 'Demo Guardian One',   '+233200000011', 'guardian1@example.test'),
  (pg_temp.sid('guardian:sunrise:2'), pg_temp.sid('school:sunrise'), 'Demo Guardian Two',   '+233200000012', NULL),
  (pg_temp.sid('guardian:harvest:1'), pg_temp.sid('school:harvest'), 'Demo Guardian Three', '+233200000013', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO student_guardians (student_id, guardian_id, school_id, relationship, is_primary_contact) VALUES
  (pg_temp.sid('student:sunrise:1'), pg_temp.sid('guardian:sunrise:1'), pg_temp.sid('school:sunrise'), 'MOTHER',      true),
  (pg_temp.sid('student:sunrise:2'), pg_temp.sid('guardian:sunrise:1'), pg_temp.sid('school:sunrise'), 'MOTHER',      true),
  (pg_temp.sid('student:sunrise:2'), pg_temp.sid('guardian:sunrise:2'), pg_temp.sid('school:sunrise'), 'GRANDPARENT', false),
  (pg_temp.sid('student:sunrise:3'), pg_temp.sid('guardian:sunrise:2'), pg_temp.sid('school:sunrise'), 'GRANDPARENT', true),
  (pg_temp.sid('student:harvest:1'), pg_temp.sid('guardian:harvest:1'), pg_temp.sid('school:harvest'), 'FATHER',      true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Enrollments. Sunrise student 1 shows preserved history: Primary 3 last year
-- (PROMOTED, ended), Primary 4 A this year (ENROLLED, open-ended).
-- ---------------------------------------------------------------------------
INSERT INTO enrollments (id, school_id, student_id, class_id, academic_year_id, status, start_date, end_date) VALUES
  (pg_temp.sid('enrol:sunrise:1:2025'), pg_temp.sid('school:sunrise'), pg_temp.sid('student:sunrise:1'), pg_temp.sid('class:sunrise:p3'),  pg_temp.sid('year:sunrise:2025'), 'PROMOTED', '2025-09-01', '2026-07-31'),
  (pg_temp.sid('enrol:sunrise:1:2026'), pg_temp.sid('school:sunrise'), pg_temp.sid('student:sunrise:1'), pg_temp.sid('class:sunrise:p4a'), pg_temp.sid('year:sunrise:2026'), 'ENROLLED', '2026-09-01', NULL),
  (pg_temp.sid('enrol:sunrise:2:2026'), pg_temp.sid('school:sunrise'), pg_temp.sid('student:sunrise:2'), pg_temp.sid('class:sunrise:p4a'), pg_temp.sid('year:sunrise:2026'), 'ENROLLED', '2026-09-01', NULL),
  (pg_temp.sid('enrol:sunrise:3:2026'), pg_temp.sid('school:sunrise'), pg_temp.sid('student:sunrise:3'), pg_temp.sid('class:sunrise:p4b'), pg_temp.sid('year:sunrise:2026'), 'ENROLLED', '2026-09-01', NULL),
  (pg_temp.sid('enrol:sunrise:4:2026'), pg_temp.sid('school:sunrise'), pg_temp.sid('student:sunrise:4'), pg_temp.sid('class:sunrise:kg1'), pg_temp.sid('year:sunrise:2026'), 'ENROLLED', '2026-09-01', NULL),
  (pg_temp.sid('enrol:harvest:1:2026'), pg_temp.sid('school:harvest'), pg_temp.sid('student:harvest:1'), pg_temp.sid('class:harvest:p4'),  pg_temp.sid('year:harvest:2026'), 'ENROLLED', '2026-09-01', NULL),
  (pg_temp.sid('enrol:harvest:2:2026'), pg_temp.sid('school:harvest'), pg_temp.sid('student:harvest:2'), pg_temp.sid('class:harvest:j1'),  pg_temp.sid('year:harvest:2026'), 'ENROLLED', '2026-09-01', NULL),
  (pg_temp.sid('enrol:harvest:3:2026'), pg_temp.sid('school:harvest'), pg_temp.sid('student:harvest:3'), pg_temp.sid('class:harvest:p4'),  pg_temp.sid('year:harvest:2026'), 'ENROLLED', '2026-09-01', NULL)
ON CONFLICT DO NOTHING;

COMMIT;
