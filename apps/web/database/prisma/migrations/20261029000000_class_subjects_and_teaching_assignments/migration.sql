-- Class-specific subjects and teaching assignments.
--
-- 1. subjects become class-specific (a required class, same school).
-- 2. teaching_assignments links a teacher (via the school membership) to a subject in an academic year.
--
-- Existing subject rows are NEVER deleted, moved or guessed at. The old subjects table was school-wide
-- and had no class, so if any rows exist this migration stops and changes nothing. See
-- apps/web/docs/subjects.md for the safe plan to follow in that case.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subjects") THEN
    RAISE EXCEPTION 'subjects is not empty (% rows). They are school-wide and have no class, so they cannot be given one automatically. Nothing was changed. See apps/web/docs/subjects.md.', (SELECT count(*) FROM "subjects");
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- subjects: one class each
-- ---------------------------------------------------------------------------
ALTER TABLE "subjects" ADD COLUMN "class_id" UUID NOT NULL;

DROP INDEX "subjects_school_id_name_key";
DROP INDEX "subjects_school_id_code_key";

-- Composite key: the class must belong to the same school as the subject.
ALTER TABLE "subjects"
  ADD CONSTRAINT "subjects_class_id_school_id_fkey"
  FOREIGN KEY ("class_id", "school_id") REFERENCES "classes"("id", "school_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Not expressible in Prisma's schema language: the same name twice in one class is refused whatever
-- the letter case ("maths" = "Maths"). Primary 4 Maths and Primary 5 Maths are different classes, so both are allowed.
CREATE UNIQUE INDEX "subjects_class_id_lower_name_key" ON "subjects"("class_id", lower("name"));
-- Codes are optional. When present they are unique within the class (NULLs never collide).
CREATE UNIQUE INDEX "subjects_class_id_code_key" ON "subjects"("class_id", "code");
CREATE INDEX "subjects_class_id_school_id_idx" ON "subjects"("class_id", "school_id");

-- ---------------------------------------------------------------------------
-- teaching_assignments
-- ---------------------------------------------------------------------------
CREATE TYPE "teaching_assignment_status" AS ENUM ('ACTIVE', 'ENDED');

CREATE TABLE "teaching_assignments" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id"        UUID NOT NULL,
    "subject_id"       UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "user_id"          UUID NOT NULL,
    "status"           "teaching_assignment_status" NOT NULL DEFAULT 'ACTIVE',
    "ended_at"         TIMESTAMPTZ(3),
    "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teaching_assignments_pkey" PRIMARY KEY ("id"),
    -- ACTIVE has no end time; ENDED has one.
    CONSTRAINT "teaching_assignments_status_ended_chk"
      CHECK (("status" = 'ACTIVE' AND "ended_at" IS NULL) OR ("status" = 'ENDED' AND "ended_at" IS NOT NULL))
);

-- Every reference must be inside the SAME school (composite foreign keys).
ALTER TABLE "teaching_assignments"
  ADD CONSTRAINT "teaching_assignments_subject_id_school_id_fkey"
    FOREIGN KEY ("subject_id", "school_id") REFERENCES "subjects"("id", "school_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "teaching_assignments_academic_year_id_school_id_fkey"
    FOREIGN KEY ("academic_year_id", "school_id") REFERENCES "academic_years"("id", "school_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "teaching_assignments_school_id_user_id_fkey"
    FOREIGN KEY ("school_id", "user_id") REFERENCES "school_memberships"("school_id", "user_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One teacher cannot hold two ACTIVE assignments for the same subject and year, even if two
-- requests arrive at the same moment. Ended rows are history and never collide.
CREATE UNIQUE INDEX "teaching_assignments_one_active_key"
  ON "teaching_assignments"("subject_id", "academic_year_id", "user_id") WHERE ("status" = 'ACTIVE');

CREATE INDEX "teaching_assignments_subject_id_school_id_idx" ON "teaching_assignments"("subject_id", "school_id");
CREATE INDEX "teaching_assignments_school_id_academic_year_id_idx" ON "teaching_assignments"("school_id", "academic_year_id");
CREATE INDEX "teaching_assignments_school_id_user_id_idx" ON "teaching_assignments"("school_id", "user_id");
