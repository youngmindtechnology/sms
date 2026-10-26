// Tests for the fail-closed migration workflow. No database is used or needed:
//  - planMigration / parseDatasource are pure functions;
//  - the end-to-end tests run scripts/migrate-deploy.mjs with a FAKE `npx` placed first
//    on PATH, so the real Prisma is never started and nothing can connect to PostgreSQL.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseDatasource, parseMigrateArgs, planMigration, verifyDatasource } from './lib/migrate-plan.mjs'

const PW = 'SENTINEL-db-pw-7'
const dev = `postgresql://ymt_dev_user:${PW}@localhost:5432/ymt_dev?schema=public`
const tst = `postgresql://ymt_dev_user:${PW}@localhost:5432/ymt_test?schema=public`
const env = { YMT_ENV: 'development', DATABASE_URL: dev, TEST_DATABASE_URL: tst }
const plan = (argv, e = env) => planMigration(argv, e)

// ---- pure rules -----------------------------------------------------------

test('no --target: refused (there is no default database)', () => {
  for (const argv of [[], ['--dry-run'], ['--status'], ['--confirm-database=ymt_dev']]) {
    const p = plan(argv)
    assert.equal(p.ok, false, argv.join(' '))
    assert.match(p.problems.join(' '), /No target given/)
  }
})

test('unknown target, unknown flag and stray arguments are refused', () => {
  assert.equal(plan(['--target=prod', '--dry-run']).ok, false)
  assert.equal(plan(['--target=', '--dry-run']).ok, false)
  assert.match(plan(['--target=test', '--dry-run', '--force']).problems.join(' '), /Unknown option/)
  assert.match(plan(['--target=test', '--dry-run', 'ymt_dev']).problems.join(' '), /Unexpected argument/)
})

test('each target uses ITS OWN variable and never falls back to the other', () => {
  const test_ = plan(['--target=test', '--dry-run'])
  assert.equal(test_.ok, true)
  assert.equal(test_.target.database, 'ymt_test')
  assert.equal(test_.childEnv.DATABASE_URL, tst, 'Prisma must receive the TEST url as DATABASE_URL')
  const dev_ = plan(['--target=dev', '--dry-run'])
  assert.equal(dev_.target.database, 'ymt_dev')
  assert.equal(dev_.childEnv.DATABASE_URL, dev)

  const noTestVar = plan(['--target=test', '--dry-run'], { YMT_ENV: 'development', DATABASE_URL: dev })
  assert.equal(noTestVar.ok, false)
  assert.match(noTestVar.problems.join(' '), /TEST_DATABASE_URL is not set/)
  assert.equal(plan(['--target=dev', '--dry-run'], { TEST_DATABASE_URL: tst }).ok, false)
})

test('the database name must fit the target', () => {
  const wrong = plan(['--target=test', '--dry-run'], { ...env, TEST_DATABASE_URL: dev })
  assert.equal(wrong.ok, false)
  assert.match(wrong.problems.join(' '), /requires a database whose name ends in "_test"/)
  assert.equal(plan(['--target=dev', '--dry-run'], { ...env, DATABASE_URL: tst }).ok, false)
})

test('dev and test pointing at the same database is refused', () => {
  const same = { ...env, TEST_DATABASE_URL: dev.replace('ymt_dev', 'ymt_test'), DATABASE_URL: dev.replace('ymt_dev', 'ymt_test') }
  assert.equal(plan(['--target=test', '--dry-run'], same).ok, false)
  assert.match(plan(['--target=test', '--dry-run'], same).problems.join(' '), /same database/)
})

test('the existing name guard is not weakened: other names, bad URLs and YMT_ENV=production are refused', () => {
  const other = (name) => `postgresql://u:${PW}@localhost:5432/${name}`
  for (const name of ['postgres', 'ymt', 'ymt_prod', 'ymt_dev_backup']) {
    assert.equal(plan(['--target=dev', '--dry-run'], { ...env, DATABASE_URL: other(name) }).ok, false, name)
  }
  assert.equal(plan(['--target=dev', '--dry-run'], { ...env, DATABASE_URL: 'not a url' }).ok, false)
  assert.equal(plan(['--target=dev', '--dry-run'], { ...env, DATABASE_URL: `${dev}&host=other` }).ok, false)
  assert.equal(plan(['--target=dev', '--dry-run'], { ...env, YMT_ENV: 'production' }).ok, false)
})

test('applying needs --confirm-database with the exact name; status and dry-run do not', () => {
  assert.equal(plan(['--target=test']).ok, false)
  assert.match(plan(['--target=test']).problems.join(' '), /--confirm-database=ymt_test/)
  assert.equal(plan(['--target=test', '--confirm-database=ymt_dev']).ok, false, 'confirming the OTHER database is refused')
  assert.equal(plan(['--target=test', '--confirm-database=YMT_TEST']).ok, false)
  assert.equal(plan(['--target=test', '--confirm-database=ymt_test']).ok, true)
  assert.equal(plan(['--target=test', '--status']).ok, true)
  assert.equal(plan(['--target=test', '--dry-run']).ok, true)
})

test('--target=dev with a name that is really the test database cannot be confirmed into applying', () => {
  const swapped = { ...env, DATABASE_URL: tst, TEST_DATABASE_URL: dev }
  assert.equal(plan(['--target=dev', '--confirm-database=ymt_test'], swapped).ok, false)
})

test('plans and refusals never contain the password or the connection string', () => {
  const texts = [
    plan(['--target=test', '--dry-run']).summary,
    ...plan(['--target=test']).problems,
    ...plan([], env).problems,
    ...plan(['--target=test', '--dry-run'], { ...env, TEST_DATABASE_URL: `${tst}&host=x` }).problems,
    ...plan(['--target=dev', '--dry-run'], { ...env, DATABASE_URL: `postgresql://u:${PW}@h@localhost/ymt_dev` }).problems,
  ]
  for (const text of texts) {
    assert.ok(!String(text).includes(PW), 'password leaked')
    assert.ok(!String(text).includes('postgresql://'), 'connection string leaked')
  }
})

test('parseMigrateArgs', () => {
  const a = parseMigrateArgs(['--target=test', '--confirm-database=ymt_test', '--status', '--dry-run', '--approve-target=abc', '--x', 'y'])
  assert.deepEqual([a.target, a.confirmDatabase, a.status, a.dryRun, a.approveFlag, a.unknown, a.positional], ['test', 'ymt_test', true, true, 'abc', ['--x'], ['y']])
})

test('parseDatasource reads Prisma output (with colours) and rejects anything else', () => {
  const line = 'Datasource "db": PostgreSQL database "ymt_test", schema "public" at "localhost:5432"'
  assert.deepEqual(parseDatasource(line), { database: 'ymt_test', schema: 'public', hostPort: 'localhost:5432' })
  assert.deepEqual(parseDatasource(`\u001b[36m${line}\u001b[0m`), { database: 'ymt_test', schema: 'public', hostPort: 'localhost:5432' })
  for (const junk of ['', 'Error: P1000', 'Datasource "db": MySQL database "x"', undefined]) assert.equal(parseDatasource(junk), null)
})

test('verifyDatasource: refuses a different database, a different host, or unreadable output', () => {
  const p = plan(['--target=test', '--status'])
  const ok = 'Datasource "db": PostgreSQL database "ymt_test", schema "public" at "localhost:5432"'
  assert.equal(verifyDatasource(p, ok).ok, true)
  assert.equal(verifyDatasource(p, ok.replace('ymt_test', 'ymt_dev')).ok, false)
  assert.equal(verifyDatasource(p, ok.replace('localhost:5432', 'db.example.com:5432')).ok, false)
  assert.equal(verifyDatasource(p, 'something unexpected').ok, false)
})

// ---- end to end with a fake `npx` (Prisma is never started) ----------------

const here = dirname(fileURLToPath(import.meta.url))
const script = resolve(here, 'migrate-deploy.mjs')
const shimDir = mkdtempSync(join(tmpdir(), 'ymt-fake-npx-'))
after(() => rmSync(shimDir, { recursive: true, force: true }))

writeFileSync(join(shimDir, 'fake-prisma.mjs'), `
import { appendFileSync } from 'node:fs'
const url = new URL(process.env.DATABASE_URL ?? 'postgresql://x@nowhere/none')
const seenDb = decodeURIComponent(url.pathname.slice(1))
const args = process.argv.slice(2).join(' ')
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, seenDb, hasPw: String(process.env.DATABASE_URL).includes(${JSON.stringify(PW)}) }) + '\\n')
if (process.env.FAKE_SILENT) { process.exit(0) }
const db = process.env.FAKE_PRISMA_DB ?? seenDb
console.log('Environment variables loaded from .env')
console.log('Datasource "db": PostgreSQL database "' + db + '", schema "public" at "' + url.hostname + ':' + (url.port || '5432') + '"')
if (process.env.FAKE_ERROR) { console.log('Error: ' + process.env.FAKE_ERROR + ': Authentication failed'); process.exit(1) }\nif (args.includes('status')) { console.log('Following migration have not yet been applied: 20261012000000_auth_credentials_sessions'); process.exit(1) }
console.log('The following migration(s) have been applied: 20261012000000_auth_credentials_sessions'); process.exit(0)
`)
writeFileSync(join(shimDir, 'npx'), `#!/bin/sh\nexec "${process.execPath}" "${join(shimDir, 'fake-prisma.mjs')}" "$@"\n`)
chmodSync(join(shimDir, 'npx'), 0o755)
writeFileSync(join(shimDir, 'npx.cmd'), `@echo off\r\n"${process.execPath}" "${join(shimDir, 'fake-prisma.mjs')}" %*\r\n`)

function runWrapper(argv, extraEnv = {}) {
  const log = join(shimDir, `log-${Math.random().toString(36).slice(2)}.jsonl`)
  const result = spawnSync(process.execPath, [script, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, ...env, PATH: `${shimDir}${delimiter}${process.env.PATH}`, FAKE_LOG: log, ...extraEnv },
  })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  return { status: result.status, out: `${result.stdout}\n${result.stderr}`, calls }
}

test('e2e: no target, or a missing variable -> refused (exit 3) and Prisma is never started', () => {
  for (const [argv, extra] of [[[], {}], [['--target=test', '--confirm-database=ymt_test'], { TEST_DATABASE_URL: '' }], [['--target=nope'], {}]]) {
    const r = runWrapper(argv, extra)
    assert.equal(r.status, 3, argv.join(' '))
    assert.equal(r.calls.length, 0)
    assert.ok(!r.out.includes(PW))
  }
})

test('e2e: --dry-run connects to nothing', () => {
  const r = runWrapper(['--target=test', '--dry-run'])
  assert.equal(r.status, 0)
  assert.equal(r.calls.length, 0)
  assert.match(r.out, /Target\s+: test/)
  assert.match(r.out, /database\s+: ymt_test/)
})

test('e2e: --status asks Prisma ONLY about the chosen database, with the TEST url passed as DATABASE_URL', () => {
  const r = runWrapper(['--target=test', '--status'])
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].args, 'prisma migrate status')
  assert.equal(r.calls[0].seenDb, 'ymt_test', 'the process DATABASE_URL (dev) was replaced by the test URL')
  assert.match(r.out, /Verified: Prisma will use database "ymt_test"/)
  const dev_ = runWrapper(['--target=dev', '--status'])
  assert.equal(dev_.calls[0].seenDb, 'ymt_dev')
})

test('e2e: --status exits 0 when migrations are merely pending, but non-zero on a real Prisma error', () => {
  const pending = runWrapper(['--target=test', '--status'])
  assert.equal(pending.status, 0, 'pending migrations are a normal answer')
  const broken = runWrapper(['--target=test', '--status'], { FAKE_ERROR: 'P1000' })
  assert.notEqual(broken.status, 0, 'a login failure must not look like success')
})

test('e2e: applying without or with the wrong confirmation never starts Prisma', () => {
  for (const argv of [['--target=test'], ['--target=test', '--confirm-database=ymt_dev'], ['--target=test', '--confirm-database=']]) {
    const r = runWrapper(argv)
    assert.equal(r.status, 3, argv.join(' '))
    assert.equal(r.calls.length, 0)
  }
})

test('e2e: a confirmed apply runs the read-only check first, then deploy, both on the test database', () => {
  const r = runWrapper(['--target=test', '--confirm-database=ymt_test'])
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(r.calls.map((c) => c.args), ['prisma migrate status', 'prisma migrate deploy'])
  assert.ok(r.calls.every((c) => c.seenDb === 'ymt_test'))
})

test('e2e: if Prisma reports a different database than planned, deploy is NEVER run (exit 4)', () => {
  const r = runWrapper(['--target=test', '--confirm-database=ymt_test'], { FAKE_PRISMA_DB: 'ymt_dev' })
  assert.equal(r.status, 4)
  assert.deepEqual(r.calls.map((c) => c.args), ['prisma migrate status'])
  assert.match(r.out, /would connect to "ymt_dev"/)
})

test('e2e: if the datasource cannot be read from Prisma output, deploy is NEVER run (exit 4)', () => {
  const r = runWrapper(['--target=test', '--confirm-database=ymt_test'], { FAKE_SILENT: '1' })
  assert.equal(r.status, 4)
  assert.deepEqual(r.calls.map((c) => c.args), ['prisma migrate status'])
})

test('e2e: the password never reaches the output, in any mode', () => {
  for (const argv of [['--target=test', '--dry-run'], ['--target=test', '--status'], ['--target=test', '--confirm-database=ymt_test'], ['--target=test']]) {
    assert.ok(!runWrapper(argv).out.includes(PW), argv.join(' '))
  }
})
