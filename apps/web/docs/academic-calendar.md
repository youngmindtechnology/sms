# Academic calendar (Phase 3, part 1)

Academic years and terms for one school at a time. No new tables or migrations: the feature uses
`academic_years` and `terms` exactly as created by the first two migrations.

## What "current" means
There is no separate flag. A period's `status` is `PLANNED`, `ACTIVE` ("current") or `CLOSED`.
The database already allows at most one `ACTIVE` year and one `ACTIVE` term per school
(`academic_years_one_active_excl`, `terms_one_active_excl`).

## Rules enforced by the API (the database also enforces most of them)
| Rule | Where |
|---|---|
| Name 1-50 characters, unique within the school (year) or year (term), compared ignoring case | API + DB (exact match) |
| Dates are real calendar dates (2000-2100), end after start | API + DB |
| Years in one school may not overlap; terms in one year may not overlap | API + DB |
| A term must sit inside its academic year | API only |
| Term number unique within the year; defaults to the next free number | API + DB |
| Changing a year's dates cannot leave a term outside it | API only |
| Making a year current closes the previous current year and its current term, in one transaction | API + DB |
| A term can only be made current while its year is current; the previous current term is closed | API + DB |
| Closed periods cannot be edited or reopened | API only |
| No delete: history is kept (all foreign keys are RESTRICT) | API (no route), DB role (no DELETE grant) |

## Endpoints (all under `/api/academic-years`, school taken from the session)
`GET /`, `POST /`, `GET /:yearId`, `PATCH /:yearId`, `POST /:yearId/activate`, `POST /:yearId/close`,
`GET /:yearId/terms`, `POST /:yearId/terms`, `PATCH /:yearId/terms/:termId`,
`POST /:yearId/terms/:termId/activate`, `POST /:yearId/terms/:termId/close`.

Answers: 200/201 success; 400 bad shape or `validation_error` with `fields`; 401 not signed in;
403 no school / no permission / bad origin or CSRF; 404 not found **or belongs to another school**
(same answer); 409 a rule refused it (`duplicate_name`, `dates_overlap`, `outside_year`, ...).

## Permissions (map change)
* Reading uses the existing `academics:read` (owner, headteacher, administrator, teacher).
* Every change needs the NEW `calendar:manage`: owner, headteacher (via "all except staff:manage") and administrator.
* Teachers keep `academics:write` for later features (scores) but cannot edit the calendar. The bursar cannot read it yet;
  the fees phase will decide whether bursars need a read-only calendar permission.

## Database role
`roles/runtime_role.sql` now also grants `ymt_app_runtime`: SELECT and INSERT on `academic_years` and `terms`, and
UPDATE on `name, start_date, end_date, status, updated_at` (terms also `sequence`). No DELETE; `school_id` and
`academic_year_id` can never be changed. The script must be re-run on each database (needs approval) before the API,
running as `ymt_app_runtime`, can use the calendar.
