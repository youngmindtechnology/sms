# Classes and class levels (Phase 3, part 2)

No new tables or migrations: the feature uses `classes` exactly as created by the first two migrations.

## Fields (as stored)
`name` (1-100 characters, unique per school), `level` (`NURSERY`, `KINDERGARTEN`, `PRIMARY`, `JHS`; the screen
shows KINDERGARTEN as "KG"), `sort_order` (whole number), `is_active`.

## Rules
| Rule | Where |
|---|---|
| Name trimmed, inner spaces squeezed, no control characters, 1-100 characters | API (+ DB trim/length check) |
| Name unique within the school, compared ignoring case | API (+ DB exact match) |
| Level must be one of the four values | API (+ DB enum) |
| Order is a whole number 0-10000; a new class without one goes to the end | API |
| Reorder sends the FULL list of the school's class ids; renumbers 1..n in one transaction; a stale, partial, duplicated or foreign list is refused and changes nothing | API |
| Deactivate instead of delete: the row, id and history stay | API (no DELETE route), DB role (no DELETE grant), DB (RESTRICT foreign keys) |

## Endpoints (`/api/classes`, school taken from the session)
`GET /` (any role in the school, `school:read`), `POST /`, `PATCH /:classId` (name, level, sortOrder, isActive),
`PUT /order` (body `{ "classIds": [...] }`). Writes need `classes:manage`. No DELETE exists.

## Permission
New `classes:manage`: OWNER, HEADTEACHER, ADMINISTRATOR. Teachers and bursars can read the list but not change it.

## Database role
`roles/runtime_role.sql` adds for `ymt_app_runtime`: SELECT and INSERT on `classes`; UPDATE on
`name, level, sort_order, is_active, updated_at`. No DELETE; `school_id` cannot be changed. Re-run the script
(approval required) on each database before the API, running as `ymt_app_runtime`, can use classes.
