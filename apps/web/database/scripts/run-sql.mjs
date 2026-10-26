// Runs a seed or test .sql file with psql, after the target guard approves.
//
//   node --env-file=.env scripts/run-sql.mjs <ENV_VAR_NAME> <seeds|tests>/<file>.sql [--dry-run] [--approve-target=<project-ref>]
//
// Why a wrapper: it works the same on Windows, macOS and Linux; it never puts
// the password on the command line; it strips Prisma-only URL parameters; and
// it applies the target guard in scripts/lib/target.mjs BEFORE any connection.
//
//   --dry-run   Print the target and the guard decision, then stop. No connection
//               is made and nothing is changed.
//
// Only files inside database/seeds and database/tests may be run through this
// script. Migrations are applied by Prisma (npm run db:migrate:deploy).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeTarget, evaluateTarget, parseArgs, summarizeTarget, toPsqlUrl } from './lib/target.mjs'

const databaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message, code = 2) {
  console.error(message)
  process.exit(code)
}

const { positional, dryRun, approveFlag, unknown } = parseArgs(process.argv.slice(2))
if (unknown.length > 0) fail(`Unknown option(s): ${unknown.join(', ')}`)
const [envName, file] = positional
if (!envName || !file) {
  fail('Usage: node --env-file=.env scripts/run-sql.mjs <ENV_VAR_NAME> <seeds|tests>/<file>.sql [--dry-run] [--approve-target=<project-ref>]')
}

const sqlPath = resolve(file)
const rel = relative(databaseRoot, sqlPath)
const insideAllowedFolder = rel.startsWith(`seeds${sep}`) || rel.startsWith(`tests${sep}`)
if (!insideAllowedFolder || !sqlPath.endsWith('.sql')) {
  fail('Only .sql files inside database/seeds or database/tests can be run with this script.')
}
if (!existsSync(sqlPath)) fail(`SQL file not found: ${sqlPath}`)

const raw = process.env[envName]
if (!raw) fail(`${envName} is not set. Copy .env.example to .env and fill it in.`)

const target = describeTarget(raw)
if (target.error) fail(`${envName}: ${target.error}`)

const decision = evaluateTarget(target, { env: process.env, approveFlag })

console.log(`Target (${envName}):`)
console.log(summarizeTarget(target))
console.log(`  file      : ${rel}`)

if (!decision.ok) {
  console.error('\nREFUSED. Nothing was run.')
  for (const p of decision.problems) console.error(`  - ${p}`)
  process.exit(3)
}
console.log(`  allowed by: ${decision.rule}`)

if (dryRun) {
  console.log('\nDry run: guard passed. No connection was made and nothing was changed.')
  process.exit(0)
}

const { connectionString, password } = toPsqlUrl(target)
const env = { ...process.env }
if (password) env.PGPASSWORD = password

// The approval reaches the SQL guard as a psql variable. The SQL files refuse a
// database that does not end in _dev/_test unless this variable is present.
const args = ['-X', '-v', 'ON_ERROR_STOP=1']
if (decision.approvedRef) args.push('-v', `approved_target=${decision.approvedRef}`)
args.push('-d', connectionString, '-f', sqlPath)

const result = spawnSync('psql', args, { stdio: 'inherit', env })

if (result.error) {
  if (result.error.code === 'ENOENT') {
    console.error(
      'psql was not found. Install the PostgreSQL client tools (they come with the PostgreSQL installer) ' +
        'and make sure psql (version 13 or newer) is on your PATH. On Windows this is usually C:\\Program Files\\PostgreSQL\\16\\bin',
    )
  } else {
    console.error(result.error.message)
  }
  process.exit(1)
}
process.exit(result.status ?? 1)
