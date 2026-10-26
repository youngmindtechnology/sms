# YMT School Management System

Cloud-based, multi-school management platform for Ghanaian basic schools
(nursery, kindergarten, primary and JHS), by Young Mind Technology.

**Status: early development. Not production-ready.**

| Path | What it is | State |
| --- | --- | --- |
| `apps/web/` | React + TypeScript + Vite frontend | Phase 1 dashboard shell, fictional sample data |
| `database/` | PostgreSQL schema, Prisma, migrations, dev seed, tests | Phase 2 foundation, see [`database/README.md`](database/README.md) |
| `docs/database-design.md` | Database design and decisions | Phase 2 |
| `apps/api/` | Backend API | Not started (Phase 3) |

## Run the frontend

```bash
cd apps/web
npm install
npm run dev        # http://localhost:5173/
```

On Windows PowerShell, use `npm.cmd` if `npm` is blocked by the execution policy.

## Set up the database

Follow [`database/README.md`](database/README.md). The frontend does not use the
database yet; it still shows fictional sample data.

## Secrets

Real `.env` files are ignored by Git. Only `database/.env.example`
(placeholders) is committed. Never commit credentials or real student data.
