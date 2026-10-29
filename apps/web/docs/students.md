# Students, guardians and enrollments

Uses the tables created in the first migration; **no new migration was needed**.

## Rules (all enforced in the service, and again by the database)
- Admission number: trimmed, UPPERCASE, 1-40 chars of letters, digits and `/ . _ -`; unique per school (409 on duplicate).
- Student status: ACTIVE, WITHDRAWN, TRANSFERRED_OUT, GRADUATED. Never deleted. Leaving closes the open enrollment (its end date is kept as history).
- Guardian: name, optional phone (stored E.164) and email (lower-case). One guardian may be linked to several students (siblings).
- One primary guardian per student (database EXCLUDE constraint). Making someone primary demotes the previous one, atomically.
- Unlinking removes only the link row. The guardian and the student stay. It is the only DELETE in this feature.
- Enrollment: class + academic year; closed years and inactive classes refuse new enrollments (409). Dates cannot overlap for one student (database constraint).
- Class transfer (race-safe): the old enrollment is only ended if it is still ENROLLED; if another request got there first the transfer is refused with 409 and nothing changes. The old enrollment ends with status CLASS_CHANGED and an inclusive end date; a new row starts. One transaction, history kept.

## Permissions
- `students:read`: OWNER, HEADTEACHER, ADMINISTRATOR, TEACHER, BURSAR.
- `students:write`: OWNER, HEADTEACHER, ADMINISTRATOR.
- `students:sensitive` (new): OWNER, HEADTEACHER, ADMINISTRATOR. Without it the API returns `dateOfBirth: null` and guardian `phone: null`, `email: null` in every response (profile, nested guardians, guardian detail, search, and the create/update responses). The filtering is in the services (`redactStudent`, `redactGuardian`), the flag comes only from the verified session, and a missing flag means "not allowed".

## Endpoints (school always comes from the session; bodies containing `schoolId` are rejected with 400)
- `GET /api/students`, `POST /api/students`, `GET|PATCH /api/students/:id`, `POST /api/students/:id/status`
- `POST /api/students/:id/guardians`, `PATCH|DELETE /api/students/:id/guardians/:guardianId`
- `GET|POST /api/students/:id/enrollments`, `POST /api/students/:id/enrollments/transfer`
- `/api/guardians` and `/api/enrollments` (guardian search/edit, class rosters)

## Audit
Events record ids, status words and the names of changed fields only: never names, dates of birth, phone numbers, e-mail addresses or admission numbers.

## Runtime-role grants
Defined in `database/roles/runtime_role.sql`; **not applied** until approved. See that file for the exact SQL.
