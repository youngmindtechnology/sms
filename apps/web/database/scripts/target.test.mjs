// Unit tests for the target guard. Run with:  npm run test:guard
// (uses Node's built-in test runner; no database and no installs needed)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeTarget, evaluateTarget, parseArgs, summarizeTarget, toPsqlUrl } from './lib/target.mjs'

const REF = 'abcdefghijklmnopqrst' // fictional 20-character project ref
const OTHER = 'zyxwvutsrqponmlkjihg'
const PASSWORD = 'S3cret-Pass-Word'

const local = (db) => `postgresql://dev:${PASSWORD}@localhost:5432/${db}?schema=public`
const direct = `postgresql://postgres:${PASSWORD}@db.${REF}.supabase.co:5432/postgres`
const session = `postgresql://prisma.${REF}:${PASSWORD}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?schema=public`
const txn = `postgresql://prisma.${REF}:${PASSWORD}@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true`
const approvedEnv = { YMT_ENV: 'development', YMT_APPROVED_TARGET_REF: REF }

const decide = (url, ctx) => evaluateTarget(describeTarget(url), ctx)

test('local database ending in _dev or _test is allowed (original rule unchanged)', () => {
  assert.equal(decide(local('ymt_dev'), { env: {} }).ok, true)
  assert.equal(decide(local('ymt_test'), { env: {} }).ok, true)
})

test('local database named postgres is refused and cannot be approved', () => {
  const d = decide(local('postgres'), { env: approvedEnv, approveFlag: REF })
  assert.equal(d.ok, false)
  assert.match(d.problems.join(' '), /not a recognised Supabase project/)
})

test('names that merely contain dev/test are refused', () => {
  for (const db of ['devdb', 'ymt_dev_backup', 'ymt_test2', 'production', 'ymt_prod']) {
    assert.equal(decide(local(db), { env: approvedEnv, approveFlag: REF }).ok, false, db)
  }
})

test('Supabase direct host with database postgres is refused without approval', () => {
  const d = decide(direct, { env: {} })
  assert.equal(d.ok, false)
  assert.equal(d.problems.length, 3) // YMT_ENV, YMT_APPROVED_TARGET_REF, --approve-target
})

test('Supabase target needs all three approvals to agree', () => {
  assert.equal(decide(direct, { env: approvedEnv, approveFlag: REF }).ok, true)
  assert.equal(decide(session, { env: approvedEnv, approveFlag: REF }).ok, true)
  // each missing piece alone refuses
  assert.equal(decide(session, { env: { ...approvedEnv, YMT_ENV: undefined }, approveFlag: REF }).ok, false)
  assert.equal(decide(session, { env: { YMT_ENV: 'development' }, approveFlag: REF }).ok, false)
  assert.equal(decide(session, { env: approvedEnv }).ok, false)
})

test('a ref that does not match the connection string is refused', () => {
  assert.equal(decide(session, { env: { ...approvedEnv, YMT_APPROVED_TARGET_REF: OTHER }, approveFlag: REF }).ok, false)
  assert.equal(decide(session, { env: approvedEnv, approveFlag: OTHER }).ok, false)
})

test('YMT_APPROVED_TARGET_REF may list several projects; the flag must still name exactly one', () => {
  const env = { YMT_ENV: 'development', YMT_APPROVED_TARGET_REF: `${OTHER}, ${REF}` }
  assert.equal(decide(session, { env, approveFlag: REF }).ok, true)
  assert.equal(decide(session, { env: { ...env, YMT_APPROVED_TARGET_REF: OTHER }, approveFlag: REF }).ok, false)
  assert.equal(decide(session, { env, approveFlag: `${OTHER},${REF}` }).ok, false)
})

test('approval returns the ref so the SQL guard can be told', () => {
  assert.equal(decide(session, { env: approvedEnv, approveFlag: REF }).approvedRef, REF)
  assert.equal(decide(local('ymt_dev'), { env: {} }).approvedRef, null)
})

test('transaction pooler (port 6543) is refused even when approved', () => {
  const d = decide(txn, { env: approvedEnv, approveFlag: REF })
  assert.equal(d.ok, false)
  assert.match(d.problems.join(' '), /transaction pooler/)
})

test('YMT_ENV=production (or any other value) refuses everything', () => {
  for (const v of ['production', 'staging', 'prod']) {
    assert.equal(decide(local('ymt_dev'), { env: { YMT_ENV: v } }).ok, false, v)
    assert.equal(decide(session, { env: { ...approvedEnv, YMT_ENV: v }, approveFlag: REF }).ok, false, v)
  }
})

test('lookalike hosts are not treated as Supabase', () => {
  for (const host of [`db.${REF}.supabase.co.evil.example`, `db.${REF}.notsupabase.co`, 'evil.pooler.supabase.com.example']) {
    const url = `postgresql://postgres.${REF}:${PASSWORD}@${host}:5432/postgres`
    assert.equal(decide(url, { env: approvedEnv, approveFlag: REF }).ok, false, host)
  }
})

test('pooler host without a project ref in the username is not approvable', () => {
  const url = `postgresql://postgres:${PASSWORD}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`
  assert.equal(decide(url, { env: approvedEnv, approveFlag: REF }).ok, false)
})

test('connection strings that can redirect psql to another server or database are refused', () => {
  for (const param of ['host=localhost', 'HOST=localhost', 'hostaddr=127.0.0.1', 'dbname=ymt_dev', 'port=5433', 'user=postgres', 'service=x']) {
    const t = describeTarget(`${session}&${param}`)
    assert.ok(t.error, param)
    assert.match(t.error, /redirect/, param)
    assert.ok(!t.error.includes(PASSWORD), param)
  }
  // harmless parameters are still fine
  assert.equal(describeTarget(`${session}&sslmode=require&connect_timeout=10`).error, undefined)
})

test('an unencoded "@" in the password is refused instead of being mis-parsed', () => {
  const t = describeTarget(`postgresql://dev:p@ss-word@localhost:5432/ymt_dev?schema=public`)
  assert.ok(t.error)
  assert.match(t.error, /%40/)
  assert.ok(!t.error.includes('ss-word'))
  // the encoded form is still fine
  assert.equal(describeTarget(`postgresql://dev:p%40ss-word@localhost:5432/ymt_dev`).error, undefined)
})

test('a connection string without a database name is refused', () => {
  assert.ok(describeTarget(`postgresql://prisma.${REF}:${PASSWORD}@aws-0-eu-west-2.pooler.supabase.com:5432`).error)
  assert.ok(describeTarget(`postgresql://prisma.${REF}:${PASSWORD}@aws-0-eu-west-2.pooler.supabase.com:5432/`).error)
})

test('invalid URLs and wrong protocols are reported, not thrown', () => {
  assert.ok(describeTarget('not a url').error)
  assert.ok(describeTarget('mysql://u:p@h/db').error)
})

test('the password never appears in the summary or in problem messages', () => {
  for (const url of [direct, session, txn, local('postgres')]) {
    const t = describeTarget(url)
    const d = evaluateTarget(t, { env: {}, approveFlag: undefined })
    assert.ok(!summarizeTarget(t).includes(PASSWORD))
    assert.ok(!d.problems.join('\n').includes(PASSWORD))
  }
})

test('toPsqlUrl removes the password and Prisma-only parameters', () => {
  const { connectionString, password } = toPsqlUrl(describeTarget(session))
  assert.equal(password, PASSWORD)
  assert.ok(!connectionString.includes(PASSWORD))
  assert.ok(!connectionString.includes('schema='))
})

test('toPsqlUrl decodes an encoded password', () => {
  const t = describeTarget(`postgresql://dev:p%40ss%2Fword@localhost:5432/ymt_dev`)
  assert.equal(toPsqlUrl(t).password, 'p@ss/word')
})

test('parseArgs separates positionals, --dry-run, --approve-target and unknown flags', () => {
  const r = parseArgs(['DATABASE_URL', 'seeds/dev_seed.sql', '--dry-run', `--approve-target=${REF}`, '--force'])
  assert.deepEqual(r.positional, ['DATABASE_URL', 'seeds/dev_seed.sql'])
  assert.equal(r.dryRun, true)
  assert.equal(r.approveFlag, REF)
  assert.deepEqual(r.unknown, ['--force'])
})
