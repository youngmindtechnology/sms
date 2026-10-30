# Subjects and teaching assignments (Phase 6)

Status: code written and tested without a database. **The migration file exists but has NOT been applied,
the runtime grants have NOT been applied, and no database-backed test has been run.** Each of those needs
the owner's separate, explicit approval.

## What it does
- A subject belongs to ONE class (Primary 4 Maths and Primary 5 Maths are two records) and to one school.
  Fields: name, optional code, active flag. Names are unique per class ignoring letter case; codes are unique per class.
- A teaching assignment links a teacher (through their school membership) to a subject for one academic year.
  Several teachers may share a subject and year; the same teacher cannot be ACTIVE twice for it.
- Only an ACTIVE user with an ACTIVE membership holding the TEACHER role in that school can be assigned.
- New assignments need an active subject and a PLANNED or ACTIVE year. Ending an assignment is always allowed.
- Replacing a teacher ends the old assignment and starts the new one in ONE transaction (with the audit event).
  If any part fails, nothing changes. Nothing is ever deleted: subjects are deactivated, assignments are ended.

## Permissions (two new; no existing role changed)
| | Owner | Headteacher | Administrator | Teacher | Bursar |
|---|---|---|---|---|---|
| `subjects:manage` (create, edit, deactivate subjects) | yes | yes | yes | no | no |
| `subjects:assign` (assign, replace, end teachers) | yes | yes | yes | no | no |
| `academics:read` (view subjects and assignments) | yes | yes | yes | yes | no |

## API (school always comes from the session)
`GET /api/subjects?classId=&academicYearId=` · `POST /api/subjects` · `PATCH /api/subjects/:id` ·
`GET|POST /api/subjects/:id/assignments` · `GET /api/teaching-assignments/eligible-teachers` ·
`POST /api/teaching-assignments/:id/replace` · `POST /api/teaching-assignments/:id/end`. No DELETE routes.

## Database changes (migration `20261029000000_class_subjects_and_teaching_assignments`)
- `subjects.class_id` (required) with a composite foreign key `(class_id, school_id)` to `classes`.
- Old school-wide unique indexes dropped; new: unique `(class_id, lower(name))` and `(class_id, code)`.
- New table `teaching_assignments` with composite foreign keys to subject, academic year and membership
  `(school_id, user_id)`; a partial unique index allows one ACTIVE row per subject + year + teacher; a CHECK ties
  `status` to `ended_at`; all deletes are RESTRICT.
- Runtime grants (in `roles/runtime_role.sql`, to be applied by the owner on `ymt_dev`): `subjects` SELECT, INSERT and
  UPDATE (name, code, is_active, updated_at); `teaching_assignments` SELECT, INSERT and UPDATE (status, ended_at, updated_at).
  No DELETE on either table; subjects cannot change class or school; assignments cannot change teacher, subject or year.

## Existing subject rows: safe plan (nothing is deleted or guessed)
At the time of writing both `ymt_dev` and `ymt_test` had 0 subject rows, so the migration makes `class_id` required
at once. It also **refuses to run (changing nothing) if any subject row exists**, because the old rows were school-wide
and have no class. If a database ever does have such rows, do this, one step at a time, each with its own approval:

1. **Look.** `SELECT id, school_id, name, code, is_active FROM subjects ORDER BY school_id, name;` Keep a `pg_dump` first.
2. **Transitional migration (instead of the one provided, new file, owner approves).** Same as the provided migration except:
   `ADD COLUMN "class_id" UUID` (nullable), keep the composite foreign key, and add
   `ALTER TABLE "subjects" ADD CONSTRAINT "subjects_class_id_required_chk" CHECK ("class_id" IS NOT NULL) NOT VALID;`
   PostgreSQL then enforces the rule for every new or changed row but leaves existing rows alone. The app only reads subjects
   through a class, so old rows never appear on screen. The Prisma field would be temporarily optional.
3. **Decide per row (owner).** A school-wide "Mathematics" may need to become one subject in each class that studies it.
   Write the decision down as a reviewed mapping: legacy row -> list of classes.
4. **Data migration (separate file, owner approves, tested on a copy in `ymt_test` first).** For each mapping: set the legacy row's
   `class_id` to the first class and INSERT a new row for each further class. No row is deleted. Check names and codes stay unique per class.
5. **Verify.** `SELECT count(*) FROM subjects WHERE class_id IS NULL;` must be 0.
6. **Enforce.** `ALTER TABLE subjects VALIDATE CONSTRAINT subjects_class_id_required_chk;` then
   `ALTER TABLE subjects ALTER COLUMN class_id SET NOT NULL;` then drop the check. Update `schema.prisma` to the required field.

## Frontend tests
`apps/web` now has a `test` script (Vitest + Testing Library, jsdom). Install the dev dependencies once, from the project root:
```powershell
npm.cmd install -D vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom --workspace=web
```
Then `npm.cmd run test --workspace=web`. Install them BEFORE `npm.cmd run build --workspace=web`, because the build type-checks the test files too.
