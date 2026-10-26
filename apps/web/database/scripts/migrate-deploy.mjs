// Applies (or checks) Prisma migrations against a database that YOU NAME, after the
// target guard approves and Prisma itself confirms which database it will use.
//
//   node --env-file=.env scripts/migrate-deploy.mjs --target=<dev|test> --dry-run
//   node --env-file=.env scripts/migrate-deploy.mjs --target=<dev|test> --status
//   node --env-file=.env scripts/migrate-deploy.mjs --target=<dev|test> --confirm-database=<name>
//   (a Supabase project additionally needs --approve-target=<project-ref>, see README)
//
//   --dry-run   Print the plan and stop. No connection is made.
//   --status    Read-only: `prisma migrate status` against the verified target.
//   (neither)   Verify, show the pending migrations, then `prisma migrate deploy`.
//
// There is deliberately NO default target. See scripts/lib/migrate-plan.mjs for the rules.
// `migrate deploy` only applies migrations that are not yet recorded; it never resets or
// drops anything, but it does change the database, so it needs --confirm-database.
import { spawnSync } from 'node:child_process'
import { planMigration, verifyDatasource } from './lib/migrate-plan.mjs'

const plan = planMigration(process.argv.slice(2), process.env)

if (!plan.ok) {
  console.error('REFUSED. Nothing was connected to or changed.')
  for (const problem of plan.problems) console.error(`  - ${problem}`)
  console.error('\nExample (safe, no connection):  node --env-file=.env scripts/migrate-deploy.mjs --target=test --dry-run')
  process.exit(3)
}

console.log(plan.summary)

if (plan.mode === 'dry-run') {
  console.log('\nDry run: the plan is valid. No connection was made and nothing was changed.')
  process.exit(0)
}

const run = (command) =>
  spawnSync(command, { env: plan.childEnv, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const show = (r) => {
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
}

// Ask Prisma which database it will really use (read-only), and refuse unless it matches.
console.log('\nPre-flight (read-only): asking Prisma which database it will use...')
const status = run('npx prisma migrate status')
if (status.error) {
  console.error(status.error.message)
  process.exit(1)
}
show(status)
const check = verifyDatasource(plan, `${status.stdout}\n${status.stderr}`)
if (!check.ok) {
  console.error(`\nREFUSED. ${check.reason}`)
  console.error('Nothing was changed.')
  process.exit(4)
}
console.log(`\nVerified: Prisma will use database "${check.seen.database}" at ${check.seen.hostPort}, as planned.`)

if (plan.mode === 'status') {
  // Prisma exits 1 when migrations are merely pending. That is a normal answer, not a failure,
  // so only real problems (login refused, schema drift, failed migration...) keep a failing exit code.
  const text = `${status.stdout}\n${status.stderr}`.replace(/\u001b\[[0-9;]*m/g, '')
  const normal = /Database schema is up to date|have not yet been applied/.test(text) && !/failed|drift|P\d{4}/i.test(text)
  process.exit(normal ? 0 : (status.status ?? 1))
}

console.log(`\nApplying pending migrations to "${plan.target.database}" (prisma migrate deploy)...`)
const result = spawnSync('npx prisma migrate deploy', { env: plan.childEnv, shell: true, stdio: 'inherit' })
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
