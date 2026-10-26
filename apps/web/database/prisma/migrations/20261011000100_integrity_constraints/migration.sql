-- Integrity constraints that Prisma's schema language cannot express:
-- CHECK constraints, exclusion constraints and triggers.
-- Prisma does not manage these. If a table or column is renamed in
-- schema.prisma, update this SQL by hand in a NEW migration.

-- Required for exclusion constraints that combine equality (school_id,
-- student_id, ...) with range overlap (&&). Trusted extension: the database
-- owner may create it without superuser rights on PostgreSQL 13+.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- schools
-- ---------------------------------------------------------------------------
ALTER TABLE "schools"
  ADD CONSTRAINT "schools_code_format_chk"
    CHECK ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("code") BETWEEN 3 AND 40),
  ADD CONSTRAINT "schools_name_chk"
    CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 200),
  ADD CONSTRAINT "schools_contact_email_chk"
    CHECK ("contact_email" IS NULL OR "contact_email" = lower(btrim("contact_email"))),
  ADD CONSTRAINT "schools_contact_phone_chk"
    CHECK ("contact_phone" IS NULL OR "contact_phone" ~ '^\+[1-9][0-9]{7,14}$');

-- ---------------------------------------------------------------------------
-- users: email must already be normalised (trimmed, lowercase)
-- ---------------------------------------------------------------------------
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_chk"
    CHECK ("email" = lower(btrim("email"))
           AND length("email") <= 254
           AND "email" ~ '^[^@\s]+@[^@\s]+$'),
  ADD CONSTRAINT "users_full_name_chk"
    CHECK ("full_name" = btrim("full_name") AND length("full_name") BETWEEN 1 AND 200);

-- ---------------------------------------------------------------------------
-- support_access_grants: time-boxed, maximum 7 days, non-empty reason
-- ---------------------------------------------------------------------------
ALTER TABLE "support_access_grants"
  ADD CONSTRAINT "support_access_grants_reason_chk"
    CHECK (length(btrim("reason")) > 0),
  ADD CONSTRAINT "support_access_grants_window_chk"
    CHECK ("expires_at" > "starts_at" AND ("expires_at" - "starts_at") <= interval '7 days'),
  ADD CONSTRAINT "support_access_grants_revoked_chk"
    CHECK ("revoked_at" IS NULL OR "revoked_at" >= "starts_at");

-- ---------------------------------------------------------------------------
-- school_memberships
-- ---------------------------------------------------------------------------
ALTER TABLE "school_memberships"
  ADD CONSTRAINT "school_memberships_ended_chk"
    CHECK (("status" = 'ENDED') = ("ended_at" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- academic_years
-- ---------------------------------------------------------------------------
ALTER TABLE "academic_years"
  ADD CONSTRAINT "academic_years_name_chk"
    CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 50),
  ADD CONSTRAINT "academic_years_dates_chk"
    CHECK ("end_date" > "start_date"),
  -- A school's academic years may not overlap in time.
  ADD CONSTRAINT "academic_years_no_overlap_excl"
    EXCLUDE USING gist ("school_id" WITH =, daterange("start_date", "end_date", '[]') WITH &&),
  -- At most one ACTIVE academic year per school.
  ADD CONSTRAINT "academic_years_one_active_excl"
    EXCLUDE USING gist ("school_id" WITH =) WHERE ("status" = 'ACTIVE');

-- ---------------------------------------------------------------------------
-- terms
-- ---------------------------------------------------------------------------
ALTER TABLE "terms"
  ADD CONSTRAINT "terms_name_chk"
    CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 50),
  ADD CONSTRAINT "terms_sequence_chk"
    CHECK ("sequence" > 0),
  ADD CONSTRAINT "terms_dates_chk"
    CHECK ("end_date" > "start_date"),
  -- Terms inside one academic year may not overlap.
  ADD CONSTRAINT "terms_no_overlap_excl"
    EXCLUDE USING gist ("academic_year_id" WITH =, daterange("start_date", "end_date", '[]') WITH &&),
  -- At most one ACTIVE term per school.
  ADD CONSTRAINT "terms_one_active_excl"
    EXCLUDE USING gist ("school_id" WITH =) WHERE ("status" = 'ACTIVE');

-- ---------------------------------------------------------------------------
-- classes and subjects
-- ---------------------------------------------------------------------------
ALTER TABLE "classes"
  ADD CONSTRAINT "classes_name_chk"
    CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 100);

ALTER TABLE "subjects"
  ADD CONSTRAINT "subjects_name_chk"
    CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 100),
  ADD CONSTRAINT "subjects_code_chk"
    CHECK ("code" IS NULL OR ("code" = btrim("code") AND length("code") BETWEEN 1 AND 20));

-- ---------------------------------------------------------------------------
-- students: admission numbers are trimmed and UPPERCASE so that
-- "adm/01" and "ADM/01" cannot become two different students.
-- ---------------------------------------------------------------------------
ALTER TABLE "students"
  ADD CONSTRAINT "students_admission_number_chk"
    CHECK ("admission_number" = upper(btrim("admission_number"))
           AND length("admission_number") BETWEEN 1 AND 40),
  ADD CONSTRAINT "students_first_name_chk"
    CHECK ("first_name" = btrim("first_name") AND length("first_name") BETWEEN 1 AND 100),
  ADD CONSTRAINT "students_middle_name_chk"
    CHECK ("middle_name" IS NULL OR ("middle_name" = btrim("middle_name") AND length("middle_name") BETWEEN 1 AND 100)),
  ADD CONSTRAINT "students_last_name_chk"
    CHECK ("last_name" = btrim("last_name") AND length("last_name") BETWEEN 1 AND 100);

-- ---------------------------------------------------------------------------
-- guardians: phone in E.164 (e.g. +233201234567); email lowercase
-- ---------------------------------------------------------------------------
ALTER TABLE "guardians"
  ADD CONSTRAINT "guardians_full_name_chk"
    CHECK ("full_name" = btrim("full_name") AND length("full_name") BETWEEN 1 AND 200),
  ADD CONSTRAINT "guardians_phone_chk"
    CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "guardians_email_chk"
    CHECK ("email" IS NULL OR "email" = lower(btrim("email")));

-- ---------------------------------------------------------------------------
-- student_guardians: at most one primary contact per student
-- ---------------------------------------------------------------------------
ALTER TABLE "student_guardians"
  ADD CONSTRAINT "student_guardians_one_primary_excl"
    EXCLUDE USING gist ("student_id" WITH =) WHERE ("is_primary_contact");

-- ---------------------------------------------------------------------------
-- enrollments
-- end_date is the INCLUSIVE last day. Two enrollments of one student may not
-- overlap in time (no two classes at once; no double enrolment in a year).
-- ---------------------------------------------------------------------------
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_dates_chk"
    CHECK ("end_date" IS NULL OR "end_date" >= "start_date"),
  ADD CONSTRAINT "enrollments_ended_when_not_enrolled_chk"
    CHECK ("status" = 'ENROLLED' OR "end_date" IS NOT NULL),
  ADD CONSTRAINT "enrollments_no_overlap_excl"
    EXCLUDE USING gist ("student_id" WITH =, daterange("start_date", "end_date", '[]') WITH &&);

-- ---------------------------------------------------------------------------
-- audit_events: append-only. UPDATE, DELETE and TRUNCATE are rejected.
-- A database superuser can still disable triggers; production must also run
-- the application under a role without those privileges.
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_action_chk"
    CHECK (length(btrim("action")) > 0),
  ADD CONSTRAINT "audit_events_entity_type_chk"
    CHECK (length(btrim("entity_type")) > 0),
  ADD CONSTRAINT "audit_events_metadata_chk"
    CHECK (jsonb_typeof("metadata") = 'object');

CREATE FUNCTION "audit_events_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "audit_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_reject_change"();

CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_reject_change"();
