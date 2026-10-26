// Decides, BEFORE anything connects, which database a migration command may touch.
//
// Why this exists: Prisma reads DATABASE_URL from the process environment, and if the
// variable is not set it silently falls back to a file called ".env" in the current
// folder. A plain `prisma migrate deploy` therefore always targets whatever ".env"
// says (the development database). The wrapper below never relies on that:
//   1. the operator must NAME the target (--target=dev or --target=test);
//   2. the connection string comes from the variable that belongs to that target
//      (DATABASE_URL for dev, TEST_DATABASE_URL for test) and is passed to Prisma
//      explicitly as DATABASE_URL, so Prisma never needs the fallback;
//   3. the database name must fit the target (dev -> *_dev, test -> *_test);
//   4. an applying run must repeat the database name (--confirm-database=<name>);
//   5. the caller then asks Prisma itself which database it will really use and
//      refuses on any mismatch (see parseDatasource).
// Every check fails closed: anything missing or unclear means "refuse".
//
// Messages never contain a connection string or a password.

import { describeTarget, evaluateTarget, summarizeTarget } from './target.mjs'

export const TARGETS = {
  dev: { envVar: 'DATABASE_URL', suffix: '_dev' },
  test: { envVar: 'TEST_DATABASE_URL', suffix: '_test' },
}

/** Parses this wrapper's own flags. Unknown flags are reported, never ignored. */
export function parseMigrateArgs(argv) {
  const out = { target: undefined, confirmDatabase: undefined, approveFlag: undefined, dryRun: false, status: false, unknown: [], positional: [] }
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--status') out.status = true
    else if (arg.startsWith('--target=')) out.target = arg.slice('--target='.length)
    else if (arg.startsWith('--confirm-database=')) out.confirmDatabase = arg.slice('--confirm-database='.length)
    else if (arg.startsWith('--approve-target=')) out.approveFlag = arg.slice('--approve-target='.length)
    else if (arg.startsWith('--')) out.unknown.push(arg)
    else out.positional.push(arg)
  }
  return out
}

const hostPortOf = (t) => `${t.host}:${t.port}`
const sameDatabase = (a, b) => a.host === b.host && a.port === b.port && a.database === b.database

/**
 * @returns {{ ok: boolean, problems: string[], mode: 'dry-run'|'status'|'deploy',
 *             targetName?: string, envVar?: string, target?: object, summary?: string, childEnv?: object }}
 */
export function planMigration(argv, env) {
  const args = parseMigrateArgs(argv)
  const mode = args.dryRun ? 'dry-run' : args.status ? 'status' : 'deploy'
  const problems = []
  const refuse = () => ({ ok: false, problems, mode })

  if (args.unknown.length > 0) problems.push(`Unknown option(s): ${args.unknown.join(', ')}`)
  if (args.positional.length > 0) problems.push(`Unexpected argument(s): ${args.positional.join(', ')}`)

  const choices = Object.keys(TARGETS).map((n) => `--target=${n}`).join(' or ')
  if (!args.target) {
    problems.push(`No target given. Name the database you mean: ${choices}.`)
    return refuse()
  }
  const spec = TARGETS[args.target]
  if (!spec) {
    problems.push(`Unknown target "${args.target}". Use ${choices}.`)
    return refuse()
  }

  const raw = env[spec.envVar]
  if (!raw) {
    problems.push(`${spec.envVar} is not set, so the "${args.target}" target cannot be identified. (It is deliberately NOT replaced by another variable or by Prisma's .env fallback.)`)
    return refuse()
  }
  const target = describeTarget(raw)
  if (target.error) {
    problems.push(`${spec.envVar}: ${target.error}`)
    return refuse()
  }

  const decision = evaluateTarget(target, { env, approveFlag: args.approveFlag })
  if (!decision.ok) {
    problems.push(...decision.problems)
    return refuse()
  }

  // The name must fit the target. (A recognised, explicitly approved Supabase project is
  // only ever the "dev" target and is identified by its approval, not by a name suffix.)
  const approvedSupabase = decision.approvedRef !== null
  if (approvedSupabase) {
    if (args.target !== 'dev') problems.push('An approved Supabase project may only be used as --target=dev.')
  } else if (!target.database.endsWith(spec.suffix)) {
    problems.push(`--target=${args.target} requires a database whose name ends in "${spec.suffix}", but ${spec.envVar} points at "${target.database}".`)
  }

  // dev and test must never be the same database.
  const other = TARGETS[args.target === 'dev' ? 'test' : 'dev']
  const otherRaw = env[other.envVar]
  if (otherRaw) {
    const otherTarget = describeTarget(otherRaw)
    if (!otherTarget.error && sameDatabase(target, otherTarget)) {
      problems.push(`${spec.envVar} and ${other.envVar} point at the same database ("${target.database}"). Fix the .env file so dev and test are different databases.`)
    }
  }

  if (mode === 'deploy') {
    if (!args.confirmDatabase) {
      problems.push(`An applying run must repeat the database name: add --confirm-database=${target.database}`)
    } else if (args.confirmDatabase !== target.database) {
      problems.push(`--confirm-database="${args.confirmDatabase}" does not match the target database "${target.database}".`)
    }
  }
  if (problems.length > 0) return refuse()

  // Prisma gets exactly one URL, under the name it reads, taken from the chosen variable.
  const childEnv = { ...env, DATABASE_URL: raw }
  const summary = [
    `Target       : ${args.target}  (from ${spec.envVar})`,
    summarizeTarget(target),
    `  allowed by : ${decision.rule}`,
    `  mode       : ${mode}`,
  ].join('\n')
  return { ok: true, problems: [], mode, targetName: args.target, envVar: spec.envVar, target, summary, childEnv }
}

const ANSI = /\u001b\[[0-9;]*m/g

/**
 * Reads the line Prisma prints before it connects:
 *   Datasource "db": PostgreSQL database "ymt_test", schema "public" at "localhost:5432"
 * Returns null when it cannot be read (the caller must then refuse).
 */
export function parseDatasource(output) {
  const m = /Datasource "[^"]*": PostgreSQL database "([^"]+)", schema "([^"]*)" at "([^"]+)"/.exec(String(output).replace(ANSI, ''))
  return m ? { database: m[1], schema: m[2], hostPort: m[3] } : null
}

/** Compares what Prisma says it will use with what the plan intended. */
export function verifyDatasource(plan, output) {
  const seen = parseDatasource(output)
  if (!seen) return { ok: false, reason: 'Could not read which database Prisma will use from its output, so the target is not verified.' }
  if (seen.database !== plan.target.database || seen.hostPort !== hostPortOf(plan.target)) {
    return { ok: false, reason: `Prisma would connect to "${seen.database}" at ${seen.hostPort}, but the plan was "${plan.target.database}" at ${hostPortOf(plan.target)}.` }
  }
  return { ok: true, seen }
}
