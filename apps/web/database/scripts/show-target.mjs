// Password-safe diagnostic: shows WHICH database the project's .env files point
// at, without ever printing a value that could contain a credential.
//
//   npm run db:target                      (from the project root or this package)
//   node scripts/show-target.mjs [file ...] (optional explicit .env paths)
//
// What it prints, per .env file that exists:
//   - whether the file starts with a byte-order mark (BOM), which silently
//     renames the first variable and is a common Windows editing accident
//   - the NAMES of the variables it defines (never their values)
//   - for DATABASE_URL and TEST_DATABASE_URL: host, port, database, role, and the
//     target guard's verdict. Parse problems are reported with the reason.
//
// It reads files with Node's own .env parser (util.parseEnv), the same rules as
// `node --env-file`, so what it reports is what the other scripts will see.
// It only reads; it never connects to a database.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { describeTarget, evaluateTarget, summarizeTarget } from './lib/target.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dbPackage = path.resolve(here, '..')
const projectRoot = path.resolve(dbPackage, '..', '..', '..')

const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const candidates = explicit.length
  ? explicit.map((p) => path.resolve(p))
  : [
      path.join(dbPackage, '.env'),
      path.join(dbPackage, 'prisma', '.env'),
      path.join(projectRoot, 'apps', 'api', '.env'),
      path.join(projectRoot, '.env'),
    ]

const rel = (p) => path.relative(projectRoot, p) || p
const URL_VARS = ['DATABASE_URL', 'TEST_DATABASE_URL']
const seen = []

for (const file of candidates) {
  console.log(`\n${rel(file)}`)
  if (!fs.existsSync(file)) {
    console.log('  not found')
    continue
  }
  const raw = fs.readFileSync(file)
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
  if (bom) {
    console.log('  WARNING: file starts with a UTF-8 byte-order mark (BOM). The first variable name is read with an invisible prefix and will not match. Re-save the file as "UTF-8" (not "UTF-8 with BOM").')
  }
  let env
  try {
    env = parseEnv(raw.toString('utf8'))
  } catch (error) {
    console.log(`  could not be parsed: ${error.message}`)
    continue
  }
  // Names only. Mark any name that carries an invisible prefix.
  const names = Object.keys(env).map((k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `${JSON.stringify(k)} (INVALID NAME - invisible characters)`))
  console.log(`  variables defined (names only): ${names.length ? names.join(', ') : '(none)'}`)
  console.log(`  YMT_ENV: ${env.YMT_ENV === undefined ? '(not set)' : JSON.stringify(env.YMT_ENV)}`)

  for (const name of URL_VARS) {
    if (env[name] === undefined) {
      console.log(`  ${name}: not set in this file`)
      continue
    }
    if (env[name].trim() === '') {
      console.log(`  ${name}: set but EMPTY`)
      continue
    }
    const target = describeTarget(env[name])
    if (target.error) {
      // These messages are fixed text; they never include the connection string.
      console.log(`  ${name}: NOT USABLE - ${target.error}`)
      continue
    }
    console.log(`  ${name}:`)
    console.log(summarizeTarget(target).replace(/^/gm, '    '))
    const verdict = evaluateTarget(target, { env, approveFlag: undefined })
    console.log(`    guard    : ${verdict.ok ? `ALLOWED (${verdict.rule})` : 'REFUSED'}`)
    if (!verdict.ok) for (const problem of verdict.problems) console.log(`      - ${problem}`)
    seen.push({ file: rel(file), name, signature: summarizeTarget(target) })
  }
}

// Prisma silently loads a file called ".env" from the folder it runs in. If DATABASE_URL is
// not set in the shell, a bare `prisma migrate ...` therefore uses THAT file's DATABASE_URL.
const implicit = seen.find((s) => s.name === 'DATABASE_URL' && /(^|[\\/])\.env$/.test(s.file))
if (implicit && explicit.length === 0) {
  console.log(`\nNOTE: Prisma loads ${implicit.file} automatically. A bare "prisma ..." command run inside apps/web/database`)
  console.log('      (for example: npx prisma migrate deploy) would use its DATABASE_URL, which is:')
  console.log(implicit.signature.replace(/^/gm, '        '))
  console.log('      Use the npm scripts instead: they name the target explicitly (see README: "Choosing the database").')
}

const databaseUrls = seen.filter((s) => s.name === 'DATABASE_URL')
if (databaseUrls.length > 1 && new Set(databaseUrls.map((s) => s.signature)).size > 1) {
  console.log('\nWARNING: DATABASE_URL points at DIFFERENT targets in different files:')
  for (const s of databaseUrls) console.log(`  - ${s.file}`)
}
console.log('\nNo values were printed. This command never connects to a database.')
