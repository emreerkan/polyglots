import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type Database from 'better-sqlite3'
import { openJobsDb } from '../../src/jobs/db.js'
import { recordBatchFailure, startRun } from '../../src/jobs/runs.js'
import { excerpt } from '../../src/logs/excerpt.js'
import { logsDir, mcpLogPath, runLogStem } from '../../src/logs/paths.js'
import { secretsFile } from '../../src/paths.js'
import { buildReport, encodeReport, type Report } from '../../src/report/build.js'

// Hostile text through the whole path a problem report takes: into every
// place of a run that a report reads, through buildReport and encodeReport,
// and back out of the gzipped body. Four rounds of the redactor each passed
// their own pins and failed on an input nobody had written down, so this
// sends the same few hundred shapes through every place at once and asks
// only the two questions that matter: did any character of a key or of the
// user name go out, and does every run log and MCP line still parse.
//
// No key holds four digits in a row, since the report's timestamps and ids
// do, and a four-character window of a key is what counts as a leak.
const KEYS: Record<string, string> = {
  DEEPL_API_KEY: '1f2e3d4c-5b6a-4c8d-9abc-def0a1b2c3d4:fx',
  OPENAI_API_KEY: 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z',
  // Each starts with a letter a JSON escape uses, so a key after a backslash
  // reads, in JSON text, as an escape and the rest of the key.
  N_KEY: 'nQ7rT2vX9zB4dF6hJ8kL',
  U_KEY: 'u00e9Zq8Wm3Ns6Pt9Vx2',
  T_KEY: 'tH5jK7lM9nB2vC4xZ6aS',
  B_KEY: 'bW3eR5tY7uI9oP1aS3dF',
}
// sk-proj- is the same in every OpenAI key; the secret is what follows it.
const secretOf = (name: string, key: string): string => (name === 'OPENAI_API_KEY' ? key.slice(8) : key)

const WINDOWS_HOME = 'C:\\Users\\zeynep.kaya'
const WINDOWS_NAME = /zeynep|kay/i
const POSIX_HOME = '/home/selin'
const POSIX_NAME = /selin/

let home: string
let db: Database.Database
let clock = new Date(2026, 9, 17, 12, 0, 0).getTime()

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'polyglots-probe-'))
  process.env.POLYGLOTS_HOME = home
  mkdirSync(join(home, 'data'), { recursive: true })
  mkdirSync(join(home, 'config'), { recursive: true })
  db = openJobsDb(join(home, 'data', 'jobs.db'))
})
afterAll(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

// One run that holds `text` in every place a report reads at once: a batch
// failure's reason, a debug file, a run log field, an agent's JSON envelope
// inside a run log field, an object key in a run log line, an MCP line, and a
// torn last line of the run log, which cannot be decoded and is redacted as
// the JSON text it is. `raw`, when given, is one more run log line written as
// JSON text by hand, for escapes JSON.stringify never writes. Returns every
// string the sent report decodes to, outside the run row (whose temporary
// path is random), with the torn line's text among them, and every other
// line that did not parse.
function send(text: string, reportHome: string, raw?: string): { strings: string[]; unparsed: string[] } {
  process.env.POLYGLOTS_HOME = home
  // The test setup points HOME at a fresh folder per test; the .env lives
  // under POLYGLOTS_HOME, which this file keeps for all of its runs.
  writeFileSync(secretsFile(), Object.entries(KEYS).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  const start = (clock += 3_600_000)
  const runId = startRun(db, { file: join(home, 'x.po'), command: 'review', locale: 'tr_TR', nplurals: 2, batchSize: 100, engine: 'e' }, () => start)
  recordBatchFailure(db, { runId, batch: 1, attempt: 1, size: 1, phase: 'review', reason: text, ms: 1, final: true, at: start + 10 })
  const stem = runLogStem(start, runId)
  const lines = [
    JSON.stringify({ t: start, kind: 'run-start' }),
    JSON.stringify({ t: start + 1000, kind: 'agent-spawn', pid: 4242 }),
    JSON.stringify({ t: start + 2000, kind: 'agent-exit', pid: 4242, reason: text, stdout: JSON.stringify({ result: text }) }),
    JSON.stringify({ t: start + 2100, kind: 'note', [text]: 'as a key' }),
    ...(raw === undefined ? [] : [`{"t":${start + 2500},"kind":"note","note":"${raw}"}`]),
    JSON.stringify({ t: start + 3000, kind: 'run-end' }),
    `{"t":${start + 3001},"kind":"note","note":${JSON.stringify(text)}`,
  ]
  mkdirSync(join(logsDir(), stem), { recursive: true })
  writeFileSync(join(logsDir(), `${stem}.jsonl`), lines.join('\n') + '\n')
  writeFileSync(join(logsDir(), stem, 'batch-001-attempt-1.stdout.txt'), text)
  writeFileSync(mcpLogPath(start), JSON.stringify({ t: start + 1500, ppid: 4242, tool: 'x', error: text }) + '\n')

  const report = buildReport(db, [runId], { provider: { name: 'antigravity' }, home: reportHome })
  const sent = JSON.parse(gunzipSync(encodeReport(report).body).toString('utf8')) as Report
  const strings: string[] = []
  const unparsed: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') strings.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') for (const [k, inner] of Object.entries(v)) (strings.push(k), walk(inner))
  }
  for (const run of sent.runs) {
    walk(run.failures)
    walk(run.debug)
    for (const line of [...run.log.split('\n'), ...run.mcp.split('\n')]) {
      if (line.trim() === '') continue
      if (line.startsWith(`{"t":${start + 3001},`)) {
        strings.push(line)
        continue
      }
      try {
        const value = JSON.parse(line) as { stdout?: unknown }
        walk(value)
        if (typeof value.stdout === 'string') walk(JSON.parse(value.stdout))
      } catch {
        unparsed.push(line)
      }
    }
  }
  return { strings, unparsed }
}

function keyLeaks(strings: string[]): string[] {
  const text = strings.join('\n')
  const hits: string[] = []
  for (const [name, key] of Object.entries(KEYS)) {
    const secret = secretOf(name, key)
    for (let i = 0; i + 4 <= secret.length; i++) {
      if (text.includes(secret.slice(i, i + 4))) {
        hits.push(`${name} '${secret.slice(i, i + 4)}'`)
        break
      }
    }
  }
  return hits
}

describe('a problem report under hostile input', () => {
  // Every length a cut can leave from four characters of the key up, at the
  // end of a string and in the middle of a failure's "stderr: <cut>; stdout:"
  // line. Three characters or fewer before the cut mark are left as they are,
  // by design: that short, the start of a key is too common in ordinary text
  // to mask (see PREFIX_BEFORE_CUT).
  it('sends no character of a key that a cut left, wherever the cut is', () => {
    for (const [name, key] of Object.entries(KEYS)) {
      for (const n of [4, 5, 7, 8, 13, key.length - 1, key.length, key.length + 1]) {
        const cut = excerpt(`Bearer ${key} tail`, 7 + n)
        for (const text of [`401 ${cut}`, `stderr: 401 ${cut}; stdout: {"ok":false}`]) {
          const { strings, unparsed } = send(text, POSIX_HOME)
          expect(keyLeaks(strings), `${name} cut at ${n}: ${text}`).toEqual([])
          expect(unparsed).toEqual([])
        }
      }
    }
  })

  // A run of backslashes before a key: in plain text a backslash is only a
  // backslash, and through JSON.stringify the run doubles. Neither may keep
  // a character of the key, or break a line.
  it('sends no character of a key after a run of backslashes', () => {
    for (const [name, key] of Object.entries(KEYS)) {
      for (let r = 0; r <= 3; r++) {
        const bs = '\\'.repeat(r)
        for (const text of [`Q${bs}${key} Z`, `Q${bs}${key}`, excerpt(`Q${bs}${key} Z`, 1 + r + 12)]) {
          const { strings, unparsed } = send(text, POSIX_HOME)
          expect(keyLeaks(strings), `${name} after ${r} backslashes: ${text}`).toEqual([])
          expect(unparsed).toEqual([])
        }
      }
    }
  })

  // A line written by hand as JSON text, where an odd run of backslashes is
  // an escape. Polyglots writes every line through JSON.stringify, which
  // never leaves an odd run before a key's first letter, so what such a
  // line holds is an escaped character and the rest of a key, not the key;
  // only that the line still parses is asked of it.
  it('keeps a hand-written JSON line with escapes parsing', () => {
    for (const key of Object.values(KEYS)) {
      for (let r = 0; r <= 5; r++) {
        const raw = `Q${'\\'.repeat(r)}${key}`
        let parses = true
        try {
          JSON.parse(`"${raw}"`)
        } catch {
          parses = false
        }
        if (!parses) continue
        const { strings, unparsed } = send('nothing here', POSIX_HOME, raw)
        expect(unparsed, raw).toEqual([])
        if (r % 2 === 0) expect(keyLeaks(strings), raw).toEqual([])
      }
    }
  })

  // Every shape a home folder takes in agent output and error text that a
  // redaction round has missed. A sibling folder (zeynep.kaya-old), another
  // case of a POSIX home and a PHP-style \/ are known and accepted, and not
  // here.
  it('sends no character of the user name, in any shape the home takes', () => {
    const W = WINDOWS_HOME
    const windows = [
      `${W}\\a.po`,
      'C:/Users/zeynep.kaya/a.po',
      'file:///C:/Users/zeynep.kaya/a.po',
      'c:\\users\\ZEYNEP.KAYA\\a.po',
      `open "${W}" failed`,
      `saved in ${W}.`,
      `cwd ${W}\nnext`,
      `files:\n${W}\\a.po`,
      `x\t${W}\\a.po`,
      `x\r\n${W}\\a.po`,
      `\u001b[32m${W}\\a.po\u001b[0m`,
      `\\\\?\\${W}\\a.po`,
      '/c/Users/zeynep.kaya/a.po',
      '/cygdrive/c/Users/zeynep.kaya/a.po',
      '/mnt/c/Users/zeynep.kaya/a.po',
      'C:\\Users\\ZEYNEP~1\\AppData\\Local\\Temp',
      'C:\\Users\\ZEYNEP~1.KAY\\AppData\\Local\\Temp',
      `x${W}\\a.po`,
      `HOME=${W}`,
      JSON.stringify(JSON.stringify(`${W}\\a.po`)),
    ]
    for (const text of windows) {
      const { strings, unparsed } = send(text, WINDOWS_HOME)
      expect(strings.filter((s) => WINDOWS_NAME.test(s)), text).toEqual([])
      expect(unparsed).toEqual([])
    }
    const U = POSIX_HOME
    const posix = [`${U}/a.po`, `cd "${U}"`, `in ${U}.`, `${U}\nnext`, `x\n${U}/a.po`, `x\t${U}/a.po`, `\u001b[1m${U}/a.po`, `file://${U}/a.po`]
    for (const text of posix) {
      const { strings, unparsed } = send(text, POSIX_HOME)
      expect(strings.filter((s) => POSIX_NAME.test(s)), text).toEqual([])
      expect(unparsed).toEqual([])
    }
  })
})
