// Target guard: decides whether a database may be touched by the seed, the
// constraint tests or a migration run.
//
// Principles
//  1. Default deny. A target is refused unless a rule below explicitly allows it.
//  2. Two ways in:
//       a) the database NAME ends in _dev or _test (the original rule, unchanged), or
//       b) the target is a recognised SUPABASE project that the human has approved
//          explicitly, in three places that must all agree:
//            - YMT_ENV is "development" or "test"
//            - YMT_APPROVED_TARGET_REF in .env lists the project ref in the URL
//              (comma-separated if more than one project is approved)
//            - --approve-target=<ref> is typed on the command line for this run
//  3. Anything else (unknown host with a name like "postgres", the Supabase
//     transaction pooler on port 6543, YMT_ENV=production) is refused.
//  4. Passwords are never included in any output this module produces.
//
// This is a guard against ACCIDENTS (wrong URL in .env, stale terminal). It is
// not a defence against someone who deliberately edits the scripts.

const SUFFIX_RULE = /(_dev|_test)$/
const REF_PATTERN = /^[a-z0-9]{20}$/
const ALLOWED_ENVS = new Set(['development', 'test'])
const OVERRIDE_PARAMS = new Set(['host', 'hostaddr', 'port', 'dbname', 'user', 'password', 'service', 'servicefile', 'passfile'])

/** Parses a connection string into the facts the guard needs. Never throws. */
export function describeTarget(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return { error: 'The connection string is not a valid URL. Expected postgresql://USER:PASSWORD@HOST:PORT/DATABASE (special characters in the password must be URL-encoded).' }
  }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
    return { error: 'The connection string must start with postgresql://' }
  }

  // An unencoded "@" inside the password makes URL parsers split the string at the
  // wrong place: part of the password is then read as the host or database, and the
  // guard would be judging (and printing) the wrong target. Refuse instead.
  if ((rawUrl.split('?')[0].match(/@/g) ?? []).length > 1) {
    return { error: 'The connection string contains more than one "@" before the query part. A "@" inside the password must be URL-encoded as %40 (also / as %2F, # as %23, ? as %3F, : as %3A).' }
  }

  // psql follows these query parameters and they OVERRIDE the host, port, user
  // or database written in the URL itself. The guard would then approve one
  // server while psql connects to another (verified with a local test server),
  // so connection strings that carry them are refused outright.
  for (const key of url.searchParams.keys()) {
    if (OVERRIDE_PARAMS.has(key.toLowerCase())) {
      return { error: `The connection string contains the parameter "${key}", which can redirect the connection to a different server or database than the one the safety guard checked. Remove it.` }
    }
  }

  const host = url.hostname.toLowerCase()
  const port = url.port || '5432'
  const username = decodeURIComponent(url.username)
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!database) {
    return { error: 'The connection string has no database name. Expected postgresql://USER:PASSWORD@HOST:PORT/DATABASE' }
  }

  let supabaseRef = null
  let supabaseMode = null
  const direct = host.match(/^db\.([a-z0-9]{20})\.supabase\.(?:co|com)$/)
  if (direct) {
    supabaseRef = direct[1]
    supabaseMode = 'direct connection'
  } else if (host.endsWith('.pooler.supabase.com')) {
    // Pooler usernames look like  <role>.<project-ref>
    const user = username.match(/^[^.]+\.([a-z0-9]{20})$/)
    if (user) {
      supabaseRef = user[1]
      supabaseMode = port === '6543' ? 'transaction pooler' : 'session pooler'
    }
  }

  return { url, host, port, username, database, supabaseRef, supabaseMode }
}

/**
 * Decides whether the target may be used.
 * @param target  result of describeTarget (without .error)
 * @param ctx     { env: process.env-like, approveFlag: string|undefined }
 * @returns { ok, rule, problems, approvedRef }
 */
export function evaluateTarget(target, { env = {}, approveFlag } = {}) {
  const problems = []
  const ymtEnv = env.YMT_ENV

  // Hard stop, whatever else is true.
  if (ymtEnv !== undefined && ymtEnv !== '' && !ALLOWED_ENVS.has(ymtEnv)) {
    return {
      ok: false,
      rule: null,
      approvedRef: null,
      problems: [`YMT_ENV is "${ymtEnv}". These scripts only run when YMT_ENV is "development" or "test".`],
    }
  }

  if (SUFFIX_RULE.test(target.database)) {
    return { ok: true, rule: 'database name ends in _dev or _test', problems: [], approvedRef: null }
  }

  if (!target.supabaseRef) {
    return {
      ok: false,
      rule: null,
      approvedRef: null,
      problems: [
        `Database "${target.database}" does not end in _dev or _test, and the host is not a recognised Supabase project, so it cannot be approved.`,
        'Use a database whose name ends in _dev or _test (for example a local PostgreSQL database).',
      ],
    }
  }

  // Recognised Supabase project, database name is not _dev/_test (normally "postgres").
  if (target.supabaseMode === 'transaction pooler') {
    problems.push('This is the Supabase transaction pooler (port 6543). The seed, tests and migrations need a session pooler (port 5432) or a direct connection.')
  }
  if (!ALLOWED_ENVS.has(ymtEnv ?? '')) {
    problems.push('YMT_ENV must be set to "development" (or "test") in .env.')
  }
  const approvedRefs = (env.YMT_APPROVED_TARGET_REF ?? '').split(',').map((r) => r.trim()).filter(Boolean)
  if (approvedRefs.length === 0) {
    problems.push(`YMT_APPROVED_TARGET_REF is not set in .env. Set it to the dev project's reference ID (several refs may be listed, separated by commas).`)
  } else if (!approvedRefs.includes(target.supabaseRef)) {
    problems.push(`The project in the connection string ("${target.supabaseRef}") is not listed in YMT_APPROVED_TARGET_REF.`)
  }
  if (!approveFlag) {
    problems.push('Missing per-run approval. Check the project reference shown above is the DEV project you intend, then re-run with --approve-target=<that project reference>.')
  } else if (approveFlag !== target.supabaseRef) {
    problems.push(`--approve-target ("${approveFlag}") does not match the project in the connection string ("${target.supabaseRef}").`)
  }

  if (problems.length > 0) return { ok: false, rule: null, problems, approvedRef: null }
  return { ok: true, rule: `explicitly approved Supabase project ${target.supabaseRef}`, problems: [], approvedRef: target.supabaseRef }
}

/** A human-readable description of the target. Contains no password. */
export function summarizeTarget(target) {
  const lines = [
    `  host      : ${target.host}:${target.port}`,
    `  database  : ${target.database}`,
    `  role      : ${target.username || '(none)'}`,
  ]
  if (target.supabaseRef) {
    lines.push(`  supabase  : project ${target.supabaseRef} (${target.supabaseMode})`)
  }
  return lines.join('\n')
}

/** Removes URL parameters Prisma understands but libpq (psql) rejects. */
export function toPsqlUrl(target) {
  const url = new URL(target.url.toString())
  for (const p of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'socket_timeout', 'statement_cache_size']) {
    url.searchParams.delete(p)
  }
  const password = url.password ? decodeURIComponent(url.password) : ''
  url.password = ''
  return { connectionString: url.toString(), password }
}

/** Splits process arguments into positionals and the flags this tool knows. */
export function parseArgs(argv) {
  const positional = []
  let dryRun = false
  let approveFlag
  const unknown = []
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('--approve-target=')) approveFlag = arg.slice('--approve-target='.length)
    else if (arg.startsWith('--')) unknown.push(arg)
    else positional.push(arg)
  }
  return { positional, dryRun, approveFlag, unknown }
}

export { REF_PATTERN }
