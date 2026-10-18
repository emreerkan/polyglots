import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type Database from 'better-sqlite3'
import { openJobsDb } from '../../src/jobs/db.js'
import { recordBatchFailure, startRun } from '../../src/jobs/runs.js'
import { logsDir, mcpLogPath, runLogStem } from '../../src/logs/paths.js'
import { VERSION } from '../../src/version.js'
import { REPORT_INFLATED_LIMIT_BYTES, REPORT_LIMIT_BYTES, ReportTooLarge, buildReport, encodeReport, summarize, type Report } from '../../src/report/build.js'

let home: string
let db: Database.Database
const savedEnv = { DEEPL_API_KEY: process.env.DEEPL_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'polyglots-report-'))
  process.env.POLYGLOTS_HOME = home
  delete process.env.DEEPL_API_KEY
  delete process.env.OPENAI_API_KEY
  mkdirSync(join(home, 'data'), { recursive: true })
  db = openJobsDb(join(home, 'data', 'jobs.db'))
})
afterEach(() => {
  db.close()
  delete process.env.POLYGLOTS_HOME
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  rmSync(home, { recursive: true, force: true })
})

const START = new Date(2026, 9, 17, 12, 0, 0).getTime()
const provider = { name: 'antigravity', version: '1.2.3', model: 'flash' }

function seedRun(opts: { debug?: Record<string, string>; logText?: string; start?: number; end?: number; pid?: number } = {}): number {
  const start = opts.start ?? START
  const end = opts.end ?? start + 9000
  const pid = opts.pid ?? 4242
  const runId = startRun(
    db,
    { file: join(home, 'sites', 'plugin-tr_TR.po'), command: 'review', locale: 'tr_TR', nplurals: 2, batchSize: 100, engine: 'e' },
    () => start,
  )
  for (const attempt of [1, 2]) {
    recordBatchFailure(db, { runId, batch: 3, attempt, size: 100, phase: 'review', reason: `timed out ${attempt}`, ms: 1000, final: attempt === 2, at: start + 1000 * attempt })
  }
  mkdirSync(logsDir(), { recursive: true })
  const stem = runLogStem(start, runId)
  const log =
    opts.logText ??
    [
      { t: start, kind: 'run-start', file: join(home, 'sites', 'plugin-tr_TR.po') },
      { t: start + 1000, kind: 'agent-spawn', pid },
      { t: end - 4000, kind: 'agent-exit', pid },
      { t: end, kind: 'run-end', ended: 'done' },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  writeFileSync(join(logsDir(), `${stem}.jsonl`), log)
  if (opts.debug) {
    mkdirSync(join(logsDir(), stem), { recursive: true })
    for (const [name, text] of Object.entries(opts.debug)) writeFileSync(join(logsDir(), stem, name), text)
  }
  return runId
}

function writeMcp(lines: object[], day: number = START): void {
  writeFileSync(mcpLogPath(day), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

describe('buildReport', () => {
  it('holds the run row, its failures, its log and only the MCP lines inside its window', () => {
    const runId = seedRun()
    writeMcp([
      { t: START + 2000, pid: 900, ppid: 4242, tool: 'inside_by_pid' },
      { t: START - 60_000, pid: 900, ppid: 4242, tool: 'before_the_run' },
      { t: START + 7000, pid: 901, ppid: 1, tool: 'between_calls_other_parent' },
    ])
    const report = buildReport(db, [runId], { provider, batchSize: 100, parallel: 2, contact: 'emre', home })
    expect(report).toMatchObject({ schema: 1, provider, batchSize: 100, parallel: 2, contact: 'emre', node: process.version, platform: process.platform })
    expect(typeof report.polyglots).toBe('string')
    expect(report.runs).toHaveLength(1)
    const [run] = report.runs
    expect(run!.failures).toHaveLength(2)
    expect((run!.row as { id: number }).id).toBe(runId)
    expect(run!.log).toContain('"run-start"')
    expect(run!.log).toContain('"run-end"')
    expect(run!.mcp).toContain('inside_by_pid')
    expect(run!.mcp).not.toContain('before_the_run')
    expect(run!.mcp).not.toContain('between_calls_other_parent')
    expect(run!.debug).toEqual([])
  })

  it('keeps an MCP line from another parent when it falls inside an agent call', () => {
    // antigravity runs the MCP server under its own daemon, so the parent pid
    // never matches the agent polyglots spawned; the call's time span does.
    const runId = seedRun()
    writeMcp([{ t: START + 3000, pid: 900, ppid: 77, tool: 'during_the_call' }])
    const [run] = buildReport(db, [runId], { provider, home }).runs
    expect(run!.mcp).toContain('during_the_call')
  })

  it('reads both days\' MCP files for a run that crosses local midnight', () => {
    // The MCP log is one file per local day; a run from 23:59 to 00:01 has
    // lines in two of them.
    const start = new Date(2026, 9, 17, 23, 59, 0).getTime()
    const end = new Date(2026, 9, 18, 0, 1, 0).getTime()
    const runId = seedRun({ start, end })
    writeMcp([{ t: start + 2000, pid: 900, ppid: 4242, tool: 'before_midnight' }], start)
    writeMcp([{ t: end - 5000, pid: 900, ppid: 4242, tool: 'after_midnight' }], end)
    expect(mcpLogPath(start)).not.toBe(mcpLogPath(end))
    const [run] = buildReport(db, [runId], { provider, home }).runs
    expect(run!.mcp).toContain('before_midnight')
    expect(run!.mcp).toContain('after_midnight')
  })

  // A home is a folder, so it ends where its name does: C:\Users\x is not
  // the start of C:\Users\xavier, and replacing it there wrote ~avier, a
  // path that points nowhere and still names most of another user.
  it('replaces a home only where its folder name ends, on Windows and POSIX', () => {
    const text = [
      'C:\\Users\\x\\a.po',
      'C:\\Users\\xavier\\a.po',
      'in C:\\Users\\x.',
      '/home/x/a.po',
      '/home/xavier/a.po',
      'cd "/home/x"',
      '/home/x',
    ].join('\n')
    const winRun = seedRun({ debug: { 'batch-001-attempt-1.prompt.txt': text } })
    const win = buildReport(db, [winRun], { provider, home: 'C:\\Users\\x' }).runs[0]!.debug[0]!.text.split('\n')
    expect(win.slice(0, 3)).toEqual(['~\\a.po', 'C:\\Users\\xavier\\a.po', 'in ~.'])
    const posix = buildReport(db, [winRun], { provider, home: '/home/x' }).runs[0]!.debug[0]!.text.split('\n')
    expect(posix.slice(3)).toEqual(['~/a.po', '/home/xavier/a.po', 'cd "~"', '~'])
  })

  // The drive letter is matched in either case, so on a drive n the home's
  // "n:" could start from inside a JSON \n escape and leave "\~", a line
  // that no longer parses. The line is decoded before it is matched, so the
  // value holds a newline there, not an n, and nothing starts inside it.
  it('never starts a Windows home inside a JSON escape', () => {
    const file = 'a\n:\\Users\\x\\f.po'
    const runId = seedRun({ logText: JSON.stringify({ t: START, kind: 'run-start', file }) + '\n' })
    const [run] = buildReport(db, [runId], { provider, home: 'N:\\Users\\x' }).runs
    expect((JSON.parse(run!.log.trim()) as { file: string }).file).toBe(file)
  })

  // A lookbehind that refused a home after a word character read the letter
  // of a JSON \n or \t as one, so a Windows home at the start of a line of a
  // file list or a multi-line stderr went out in the run log; it read the m
  // that ends an ANSI colour code the same way. Each line is now decoded
  // before it is redacted, so there is no escape for a home to start inside,
  // and a home is replaced wherever it starts.
  it('replaces a Windows home at a line start, after a tab, a colour code, a word or an extended-length prefix', () => {
    const files = 'files:\nC:\\Users\\x\\a.po\n\tC:\\Users\\x\\b.po'
    const debug = ['\u001b[32mC:\\Users\\x\\a.po\u001b[0m', '\\\\?\\C:\\Users\\x\\a.po', 'xC:\\Users\\x\\a.po'].join('\n')
    const runId = seedRun({
      logText: JSON.stringify({ t: START, kind: 'run-start', files }) + '\n',
      debug: { 'batch-001-attempt-1.stderr.txt': debug },
    })
    writeMcp([{ t: START, pid: 900, ppid: 4242, tool: 'read', files }])
    const [run] = buildReport(db, [runId], { provider, home: 'C:\\Users\\x' }).runs
    for (const text of [run!.log, run!.mcp]) expect((JSON.parse(text.trim()) as { files: string }).files).toBe('files:\n~\\a.po\n\t~\\b.po')
    expect(run!.debug[0]!.text.split('\n')).toEqual(['\u001b[32m~\\a.po\u001b[0m', '\\\\?\\~\\a.po', 'x~\\a.po'])
  })

  // Claude Code on Windows runs its tools in Git Bash, and WSL and Cygwin
  // print the same folder under their own roots, so an agent's output can
  // name the home in any of these.
  it('replaces a Windows home in its Git Bash, Cygwin and WSL forms', () => {
    const forms = ['/c/Users/x/a.po', '/cygdrive/c/Users/x/a.po', '/mnt/c/Users/x/a.po', '/C/users/X']
    const runId = seedRun({ debug: { 'batch-001-attempt-1.stdout.txt': forms.join('\n') } })
    const text = buildReport(db, [runId], { provider, home: 'C:\\Users\\x' }).runs[0]!.debug[0]!.text
    expect(text.split('\n')).toEqual(['~/a.po', '~/a.po', '~/a.po', '~'])
  })

  // %TEMP% is often given in 8.3 form, and for a user name that is not a
  // valid short name, the folder in it is the short name: six characters of
  // the user name, a tilde and a digit.
  it('replaces a Windows home given by its 8.3 short name', () => {
    const forms = ['C:\\Users\\ZEYNEP~1\\AppData\\Local\\Temp', 'C:\\Users\\ZEYNEP~1.KAY\\AppData', 'C:/Users/zeynep~2/a.po']
    const runId = seedRun({ debug: { 'batch-001-attempt-1.stdout.txt': forms.join('\n') } })
    const text = buildReport(db, [runId], { provider, home: 'C:\\Users\\zeynep.kaya' }).runs[0]!.debug[0]!.text
    expect(text.split('\n')).toEqual(['~\\AppData\\Local\\Temp', '~\\AppData', '~/a.po'])
  })

  // A line of the run log or the MCP log is decoded, redacted value by value
  // and written back, so what it holds is matched as the text it is, and a
  // key used as an object's key, the name of an argument an agent invented,
  // goes too. A line that is not JSON, a torn last line, is plain text.
  it('redacts the keys and values of each JSON line, and a line that is not JSON as plain text', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), 'OPENAI_API_KEY=sk-proj-0123456789abcdef\n')
    const key = 'sk-proj-0123456789abcdef'
    const runId = seedRun({
      logText: [JSON.stringify({ t: START, kind: 'note', [key]: `in C:\\Users\\x\\${key}` }), `{"t":${START + 1},"kind":"torn","note":"${key}`].join('\n') + '\n',
    })
    writeMcp([{ t: START, pid: 900, ppid: 4242, args: { [key]: key } }])
    const [run] = buildReport(db, [runId], { provider, home: 'C:\\Users\\x' }).runs
    const lines = run!.log.split('\n')
    expect(JSON.parse(lines[0]!)).toEqual({ t: START, kind: 'note', '[redacted]': 'in ~\\[redacted]' })
    expect(lines[1]).toBe(`{"t":${START + 1},"kind":"torn","note":"[redacted]`)
    expect(lines[2]).toBe('')
    expect((JSON.parse(run!.mcp) as { args: unknown }).args).toEqual({ '[redacted]': '[redacted]' })
  })

  it('writes the home folder as ~ everywhere', () => {
    const runId = seedRun({ debug: { 'batch-001-attempt-1.prompt.txt': `Read ${home}/sites/plugin-tr_TR.po` } })
    const report = buildReport(db, [runId], { provider, home })
    const text = JSON.stringify(report)
    expect(text).not.toContain(home)
    expect(text).toContain('~/sites/plugin-tr_TR.po')
  })

  it('redacts a Windows home and a quoted key inside the raw JSON lines of the run log and the MCP log', () => {
    // The run log and the MCP lines go into the report as their JSONL text,
    // so a backslash in them is already doubled and a quote already escaped:
    // the plain form of the home or the key is not in that text at all.
    const winHome = 'C:\\Users\\x'
    const key = 'sk-"quoted"-secret'
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), `OPENAI_API_KEY='${key}'\n`)
    // Ends in a backslash, which JSON doubles. Replaced plain form first, the
    // second backslash of its escape is left to escape the closing quote, and
    // the line no longer parses; the escaped form, being longer, goes first.
    // Set in the environment, since .env quoting cannot end a value in one.
    const backslashKey = 'dl-abcdef\\'
    process.env.DEEPL_API_KEY = backslashKey
    const file = `${winHome}\\sites\\plugin-tr_TR.po`
    const runId = seedRun({
      logText:
        [
          { t: START, kind: 'run-start', file },
          { t: START + 9000, kind: 'run-end', ended: 'done', note: `key ${key}` },
          { t: START + 9001, kind: 'note', note: `deepl ${backslashKey}` },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n',
    })
    writeMcp([{ t: START + 2000, pid: 900, ppid: 1, tool: 'read', path: file, key }])
    const [run] = buildReport(db, [runId], { provider, home: winHome }).runs
    for (const text of [run!.log, run!.mcp]) {
      expect(text).not.toContain('Users')
      expect(text).not.toContain('quoted')
    }
    // Still JSON lines a maintainer can parse, with the path kept past the home.
    expect((JSON.parse(run!.log.split('\n')[0]!) as { file: string }).file).toBe('~\\sites\\plugin-tr_TR.po')
    expect((JSON.parse(run!.log.split('\n')[1]!) as { note: string }).note).toBe('key [redacted]')
    expect((JSON.parse(run!.log.split('\n')[2]!) as { note: string }).note).toBe('deepl [redacted]')
    expect((JSON.parse(run!.mcp) as { path: string }).path).toBe('~\\sites\\plugin-tr_TR.po')
  })

  it('writes a Windows home as ~ with either separator, any case, in a file URL and escaped twice', () => {
    // Agent output in the debug files holds paths in every shape: forward
    // slashes, a lower-case drive, a file URL, and JSON text inside a JSON
    // string, where each backslash is four.
    const winHome = 'C:\\Users\\x'
    const b4 = '\\'.repeat(4)
    const forms = [
      'C:/Users/x/sites/a.po',
      'file:///C:/Users/x/sites/a.po',
      'c:\\users\\x\\sites\\a.po',
      `C:${b4}Users${b4}x${b4}sites${b4}a.po`,
    ]
    const runId = seedRun({ debug: { 'batch-001-attempt-1.stdout.txt': forms.join('\n') } })
    const text = buildReport(db, [runId], { provider, home: winHome }).runs[0]!.debug[0]!.text
    expect(text).not.toMatch(/users/i)
    expect(text.split('\n')).toEqual(['~/sites/a.po', 'file:///~/sites/a.po', '~\\sites\\a.po', `~${b4}sites${b4}a.po`])
  })

  it('replaces every .env value with [redacted], even inside a debug prompt', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), 'DEEPL_API_KEY=abc123\nOPENAI_API_KEY=sk-zz9\n')
    const runId = seedRun({ debug: { 'batch-001-attempt-1.prompt.txt': 'the user pasted DEEPL_API_KEY=abc123 and sk-zz9 here' } })
    const report = buildReport(db, [runId], { provider, home })
    const text = JSON.stringify(report)
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('sk-zz9')
    expect(report.runs[0]!.debug[0]).toEqual({ name: 'batch-001-attempt-1.prompt.txt', text: 'the user pasted DEEPL_API_KEY=[redacted] and [redacted] here' })
  })

  it('redacts a key polyglots reads from 6 characters, and other values from 8', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    // A hand-added X=1 would otherwise turn every 1 in every timestamp into
    // [redacted]; a five-character DeepL key is a typo, not a key, and would
    // do the same to every word that holds it.
    writeFileSync(join(home, 'config', '.env'), 'DEEPL_API_KEY=k9abc\nOPENAI_API_KEY=sk-123\nX=1\nSHORTISH=abcdefg\nOTHER_TOKEN=tok-12345678\n')
    const runId = seedRun({ debug: { 'batch-001-attempt-1.prompt.txt': 'keys k9abc, sk-123 and tok-12345678, at 2026-10-17 11:01 with abcdefg' } })
    const report = buildReport(db, [runId], { provider, home })
    expect(report.runs[0]!.debug[0]!.text).toBe('keys k9abc, [redacted] and [redacted], at 2026-10-17 11:01 with abcdefg')
  })

  // Error text is cut to a length where it is written (agent stderr, a
  // provider's answer), before the report ever sees it. A key that ran across
  // that cut is no longer the whole key the redactor looks for, so the start
  // of it is masked too, where a cut leaves it: at the end of a string, or at
  // the end of a string inside a JSON line.
  it('masks the start of a key that a cut left at the end of a string', () => {
    const key = 'sk-"quoted"-0123456789abcdef'
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), `OPENAI_API_KEY='${key}'\n`)
    const cut = key.slice(0, 14)
    const runId = seedRun({
      debug: { 'batch-001-attempt-1.output.txt': `agy said: Unauthorized ${cut}` },
      logText: JSON.stringify({ t: START, kind: 'batch-failed', reason: `401 for ${cut}` }) + '\n',
    })
    const [run] = buildReport(db, [runId], { provider, home }).runs
    expect(run!.debug[0]!.text).toBe('agy said: Unauthorized [redacted]')
    expect((JSON.parse(run!.log.trim()) as { reason: string }).reason).toBe('401 for [redacted]')
    expect(JSON.stringify(run)).not.toContain('quoted')
  })

  // In the JSON text a newline is a backslash and an n. A key that starts with
  // n must not be matched from inside that escape, which would leave "\[redacted]"
  // and a run log line that no longer parses.
  it('never matches a key prefix from inside a JSON escape', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), 'OPENAI_API_KEY=nabcdefghijk\n')
    const runId = seedRun({ logText: JSON.stringify({ t: START, kind: 'batch-failed', reason: 'line1\nabcdefgh' }) + '\n' })
    const [run] = buildReport(db, [runId], { provider, home }).runs
    expect((JSON.parse(run!.log.trim()) as { reason: string }).reason).toBe('line1\nabcdefgh')
  })

  // The whole key, not only a prefix. In the JSON text, a newline followed by
  // the rest of a key that starts with n reads as the key from the n on, but
  // the string that line holds is a newline and the rest, not the key: no
  // writer of it had the key to write, since JSON.stringify writes a
  // backslash before the key's n as two. Each line is decoded before it is
  // redacted, so the newline is a newline, and what follows it is the key
  // without its first character, which goes as one (see wholeKeyForms). The
  // line still parses. A real backslash before the key is matched with the
  // key after it, in the run log and in a plain debug file alike.
  it('never matches a whole key from inside a JSON escape', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), 'OPENAI_API_KEY=nabcdefghijk\nDEEPL_API_KEY=u0001-deepl-key\n')
    const runId = seedRun({
      logText:
        [
          { t: START, kind: 'batch-failed', reason: 'line1\nabcdefghijk' },
          { t: START + 1, kind: 'batch-failed', reason: 'caf\u0001-deepl-key' },
          { t: START + 2, kind: 'batch-failed', reason: 'even \\nabcdefghijk' },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n',
      debug: { 'batch-001-attempt-1.prompt.txt': 'path C:\\nabcdefghijk' },
    })
    const [run] = buildReport(db, [runId], { provider, home }).runs
    const reasons = run!.log.trim().split('\n').map((l) => (JSON.parse(l) as { reason: string }).reason)
    expect(reasons).toEqual(['line1\n[redacted]', 'caf\u0001-deepl-key', 'even \\[redacted]'])
    // A debug file is plain text, where a backslash is only a backslash: the
    // key is whole after it, and goes whole.
    expect(run!.debug[0]!.text).toBe('path C:\\[redacted]')
  })

  // A backslash is only ever a character to match. When escapes were read in
  // every string, a key in a plain debug file that starts with u after a
  // backslash kept its first five characters, taken for a \u escape that was
  // not there.
  it('matches a key plainly in text that is not JSON', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), 'DEEPL_API_KEY=u0001-deepl-key\n')
    const runId = seedRun({ debug: { 'batch-001-attempt-1.prompt.txt': 'C:\\u0001-deepl-key and C:\\u0001-deep' } })
    expect(buildReport(db, [runId], { provider, home }).runs[0]!.debug[0]!.text).toBe('C:\\[redacted] and C:\\[redacted]')
  })

  // The match takes the run of backslashes before a key. Started at every
  // backslash of a long run, it read the rest of the run each time: 40,000
  // backslashes took most of a second, 200,000 about twenty, with the event
  // loop blocked. A run is now taken only from its first backslash.
  it('redacts past a long run of backslashes in linear time', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), 'OPENAI_API_KEY=sk-0123456789abcdef\n')
    const runId = seedRun({ debug: { 'batch-001-attempt-1.stdout.txt': '\\'.repeat(200_000) + 'x \\\\sk-0123456789abcdef' } })
    const started = performance.now()
    const text = buildReport(db, [runId], { provider, home }).runs[0]!.debug[0]!.text
    expect(performance.now() - started).toBeLessThan(1000)
    expect(text.endsWith('x \\\\[redacted]')).toBe(true)
  })

  // A failure's reason is "stderr: <excerpt>; stdout: <excerpt>", so the cut
  // of stderr sits in the middle of the line, not at its end. Each cut marks
  // itself, and a key's start right before the mark is masked there too.
  it('masks the start of a key before a cut mark in the middle of a line', () => {
    const key = 'sk-proj-ABCDEFGHIJKLMNOP'
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), `OPENAI_API_KEY=${key}\n`)
    const reason = `stderr: 401 Bearer ${key.slice(0, 13)}…; stdout: {"error":"unauthorized"}`
    const runId = seedRun({
      debug: { 'batch-001-attempt-1.output.txt': reason },
      logText: JSON.stringify({ t: START, kind: 'batch-failed', reason }) + '\n',
    })
    const [run] = buildReport(db, [runId], { provider, home }).runs
    const masked = 'stderr: 401 Bearer [redacted]…; stdout: {"error":"unauthorized"}'
    expect(run!.debug[0]!.text).toBe(masked)
    expect((JSON.parse(run!.log.trim()) as { reason: string }).reason).toBe(masked)
  })

  // Right before the cut mark, ordinary text ending in a key's first few
  // characters is rare, and a DeepL key's first characters are its UUID.
  // Four are masked there; three are not, nor are seven at the end of a
  // string, where the text ends for every other reason too.
  it('masks four characters of a key before a cut mark, and leaves three', () => {
    const key = '1f2e3d4c-5b6a-4789-8abc-def012345678:fx'
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), `DEEPL_API_KEY=${key}\n`)
    const reasons = [`stderr: 401 ${key.slice(0, 4)}…; stdout: {}`, `401 ${key.slice(0, 3)}…`, `401 ${key.slice(0, 7)}`]
    const runId = seedRun({
      debug: { 'batch-001-attempt-1.output.txt': reasons.join('\n') },
      logText: reasons.map((reason, i) => JSON.stringify({ t: START + i, kind: 'batch-failed', reason })).join('\n') + '\n',
    })
    const [run] = buildReport(db, [runId], { provider, home }).runs
    const masked = ['stderr: 401 [redacted]…; stdout: {}', '401 1f2…', '401 1f2e3d4']
    expect(run!.debug[0]!.text.split('\n')).toEqual(masked)
    expect(run!.log.trim().split('\n').map((l) => (JSON.parse(l) as { reason: string }).reason)).toEqual(masked)
  })

  // A text full of quotes, a JSON envelope, has more places a prefix may end
  // than a window before each is worth, and is read in one pass instead. It
  // must mask the same prefixes.
  it('masks a key prefix the same way in text with many quotes', () => {
    const key = '1f2e3d4c-5b6a-4c8d-9abc-def0a1b2c3d4:fx'
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), `DEEPL_API_KEY=${key}\n`)
    const quotes = '"'.repeat(200)
    const runId = seedRun({ debug: { 'batch-001-attempt-1.stdout.txt': `${quotes} ${key.slice(0, 4)}… ${key.slice(0, 3)}… ${key.slice(0, 9)}" ${key.slice(0, 7)}` } })
    const text = buildReport(db, [runId], { provider, home }).runs[0]!.debug[0]!.text
    expect(text).toBe(`${quotes} [redacted]… 1f2… [redacted]" 1f2e3d4`)
  })

  // Five megabytes of agent output built to make a pattern work hard: a
  // key's prefix and a cut mark over and over, in a run log field, where it
  // is decoded first, and in a debug file. Each must stay linear.
  it('redacts five megabytes of hostile text in under a second', () => {
    const key = '1f2e3d4c-5b6a-4789-8abc-def012345678:fx'
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), `DEEPL_API_KEY=${key}\n`)
    const unit = `\\${key.slice(0, -1)}…C:\\Users\\`
    const hostile = unit.repeat(Math.ceil(5_000_000 / unit.length))
    const runId = seedRun({
      logText: JSON.stringify({ t: START, kind: 'agent-exit', stdout: hostile }) + '\n',
      debug: { 'batch-001-attempt-1.stdout.txt': hostile },
    })
    const started = performance.now()
    const [run] = buildReport(db, [runId], { provider, home: 'C:\\Users\\x' }).runs
    expect(performance.now() - started).toBeLessThan(1000)
    expect(run!.debug[0]!.text).not.toContain(key.slice(0, 8))
    expect(run!.log).not.toContain(key.slice(0, 8))
  })

  // A placeholder such as DEEPL_API_KEY=xxxxxxxxxxxxxxxx is a real .env, and
  // a value that repeats itself made every prefix an alternative that
  // matched almost all the way at every position: 200 identical characters
  // took five seconds on five megabytes, with the event loop blocked.
  for (const length of [16, 40]) {
    it(`redacts five megabytes in under a second for a key of ${length} identical characters`, () => {
      const key = 'x'.repeat(length)
      mkdirSync(join(home, 'config'), { recursive: true })
      writeFileSync(join(home, 'config', '.env'), `DEEPL_API_KEY=${key}\n`)
      const unit = `${key.slice(0, -1)}b`
      const hostile = unit.repeat(Math.ceil(5_000_000 / unit.length)) + `${key.slice(0, -1)}…`
      const runId = seedRun({
        logText: JSON.stringify({ t: START, kind: 'agent-exit', stdout: hostile }) + '\n',
        debug: { 'batch-001-attempt-1.stdout.txt': hostile },
      })
      const started = performance.now()
      const [run] = buildReport(db, [runId], { provider, home }).runs
      expect(performance.now() - started).toBeLessThan(1000)
      expect(run!.debug[0]!.text.endsWith('b[redacted]…')).toBe(true)
    })
  }

  // Several placeholders, or several keys at once: the scan reads the text
  // once per key, and with a cut mark every few characters every key took
  // the full pass. Three placeholders took more than a second here.
  it('redacts five megabytes in under a second with several placeholder or random keys', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    const cases: Array<{ env: string[]; unit: string }> = [
      { env: [16, 24, 32, 40].map((n, i) => `${['DEEPL_API_KEY', 'OPENAI_API_KEY', 'A_TOKEN', 'B_TOKEN'][i]}=${'x'.repeat(n)}`), unit: 'xxxx…' },
      { env: [16, 24, 32, 40].map((n, i) => `${['DEEPL_API_KEY', 'OPENAI_API_KEY', 'A_TOKEN', 'B_TOKEN'][i]}=${'x'.repeat(n)}`), unit: 'xxxxxxxx"' },
    ]
    const random = ['1f2e3d4c-5b6a-4c8d-9abc-def0a1b2c3d4:fx', 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z', 'tok_Qw8Er5Ty2Ui9Op3As6Df1Gh4Jk7Lz']
    cases.push({ env: random.map((k, i) => `${['DEEPL_API_KEY', 'OPENAI_API_KEY', 'A_TOKEN'][i]}=${k}`), unit: random.map((k) => `${k.slice(0, 12)}… `).join('') })
    for (const { env, unit } of cases) {
      writeFileSync(join(home, 'config', '.env'), env.join('\n') + '\n')
      const hostile = unit.repeat(Math.ceil(5_000_000 / unit.length))
      const runId = seedRun({
        logText: JSON.stringify({ t: START, kind: 'agent-exit', stdout: hostile }) + '\n',
        debug: { 'batch-001-attempt-1.stdout.txt': hostile },
      })
      const started = performance.now()
      buildReport(db, [runId], { provider, home })
      expect(performance.now() - started, unit).toBeLessThan(1000)
    }
  })

  // Keys that share their first characters, as every OpenAI project key
  // shares sk-proj-, found the head of each in the text, and the scan read
  // the text once for each of them: ten such keys took 1.6 seconds on five
  // megabytes of their common start before a quote.
  it('redacts five megabytes in under a second with ten keys that share their start', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    const keys = Array.from({ length: 10 }, (_, i) => `sk-proj-${String(i).repeat(4)}Ab3dEf6hIj9kLm2nOp5q`)
    writeFileSync(join(home, 'config', '.env'), keys.map((k, i) => `KEY_${i}=${k}`).join('\n') + '\n')
    const unit = 'sk-proj-0"'
    const hostile = unit.repeat(Math.ceil(5_000_000 / unit.length))
    const runId = seedRun({
      logText: JSON.stringify({ t: START, kind: 'agent-exit', stdout: hostile }) + '\n',
      debug: { 'batch-001-attempt-1.stdout.txt': hostile },
    })
    const started = performance.now()
    const [run] = buildReport(db, [runId], { provider, home }).runs
    expect(performance.now() - started).toBeLessThan(1000)
    expect(run!.debug[0]!.text).not.toContain('sk-proj-0"')
  })

  // The ranges overlap and do not come in order: the full pass reads one key
  // after another, and the window path collects the cut marks before the
  // quotes. Merged unsorted, a later key's earlier range was skipped as
  // already covered, and its prefix went out.
  it('masks every key prefix whichever key or place comes first', () => {
    const k1 = '1f2e3d4c-5b6a-4c8d-9abc-def0a1b2c3d4:fx'
    const k2 = 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), `DEEPL_API_KEY=${k1}\nOPENAI_API_KEY=${k2}\n`)
    const texts = [`a ${k2.slice(0, 12)}… b ${k1.slice(0, 12)}… c`, `a ${k1.slice(0, 12)}" ${'z'.repeat(200)} ${k1.slice(0, 5)}… c`]
    const runId = seedRun({ debug: Object.fromEntries(texts.map((t, i) => [`batch-00${i + 1}-attempt-1.stdout.txt`, t])) })
    const debug = buildReport(db, [runId], { provider, home }).runs[0]!.debug.map((d) => d.text)
    expect(debug).toEqual(['a [redacted]… b [redacted]… c', `a [redacted]" ${'z'.repeat(200)} [redacted]… c`])
  })

  // One .env value can start another: two folder paths, or a token and the
  // same token with a suffix. The whole-key replace ran first and wrote
  // [redacted] over the shorter value inside a cut of the longer one, and the
  // prefix scan then no longer saw the longer one's start: the rest of the
  // cut went out. Both are found on the same text now, and masked once.
  it('masks a cut prefix of a value that another, shorter value starts', () => {
    const long = '1f2e3d4c-5b6a-4c8d-9abc-def0a1b2c3d4:fx'
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(
      join(home, 'config', '.env'),
      [`DEEPL_API_KEY=${long}`, `SHORT_TOKEN=${long.slice(0, 18)}`, 'SITE_DIR=/srv/wp/client-site', 'STAGING_DIR=/srv/wp/client-site-staging'].join('\n') + '\n',
    )
    const texts = [`a ${long.slice(0, 30)}… b`, `a "${long.slice(0, 30)}" b`, 'cd /srv/wp/client-site-stag… then /srv/wp/client-site-staging and /srv/wp/client-site']
    const runId = seedRun({ debug: Object.fromEntries(texts.map((t, i) => [`batch-00${i + 1}-attempt-1.stdout.txt`, t])) })
    const debug = buildReport(db, [runId], { provider, home }).runs[0]!.debug.map((d) => d.text)
    expect(debug).toEqual(['a [redacted]… b', 'a "[redacted]" b', 'cd [redacted]… then [redacted] and [redacted]'])
  })

  // A key's escaped form is a key too: cut in an agent's JSON envelope, its
  // prefix is the escaped one. Seven characters before a quote are not a cut
  // and stay; eight are masked.
  it('masks a cut prefix of a key\'s escaped form, and keeps seven before a quote', () => {
    process.env.OPENAI_API_KEY = 'abcdefgh"ijkl'
    process.env.DEEPL_API_KEY = '1f2e3d4c-5b6a-4c8d-9abc-def0a1b2c3d4:fx'
    const runId = seedRun({ debug: { 'batch-001-attempt-1.stdout.txt': '{"result":"abcdefgh\\"ij…"} see "1f2e3d4" and "1f2e3d4c"' } })
    const text = buildReport(db, [runId], { provider, home }).runs[0]!.debug[0]!.text
    expect(text).toBe('{"result":"[redacted]…"} see "1f2e3d4" and "[redacted]"')
  })

  // A key that holds a quote or a backslash is escaped wherever it sits in
  // JSON text: an agent's JSON envelope in a debug file, or the same
  // envelope as a run log field, which decodes to JSON text. The escaped
  // form is matched as a literal beside the key itself.
  it('redacts the JSON-escaped form of a key inside JSON text', () => {
    const key = 'sk-"quo\\ted"-0123456789'
    process.env.OPENAI_API_KEY = key
    const envelope = JSON.stringify({ result: `token ${key} refused` })
    const runId = seedRun({
      logText: JSON.stringify({ t: START, kind: 'agent-exit', stdout: envelope }) + '\n',
      debug: { 'batch-001-attempt-1.stdout.txt': envelope },
    })
    const [run] = buildReport(db, [runId], { provider, home }).runs
    const redacted = '{"result":"token [redacted] refused"}'
    expect(run!.debug[0]!.text).toBe(redacted)
    expect((JSON.parse(run!.log.trim()) as { stdout: string }).stdout).toBe(redacted)
  })

  // The key without its first one to three characters, where eight or more
  // stay: what is left of a key whose start an upstream decoder took for an
  // escape, \n or \t, or a cut that kept the end of a text.
  it('redacts a key that lost its first three characters or fewer', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), 'OPENAI_API_KEY=nabcdefghijk\n')
    const texts = ['a abcdefghijk', 'a bcdefghijk', 'a cdefghijk', 'a defghijk']
    const runId = seedRun({ debug: { 'batch-001-attempt-1.stdout.txt': texts.join('\n') } })
    const text = buildReport(db, [runId], { provider, home }).runs[0]!.debug[0]!.text
    expect(text.split('\n')).toEqual(['a [redacted]', 'a [redacted]', 'a [redacted]', 'a defghijk'])
  })

  // walk recurses, so a line nested deep enough ran out of stack after it
  // parsed, and the throw ended buildReport: no report at all over one line
  // nobody needs decoded.
  it('builds a report around a run log line nested too deep to walk', () => {
    const deep = '['.repeat(10_000) + ']'.repeat(10_000)
    const runId = seedRun({ logText: [JSON.stringify({ t: START, kind: 'run-start' }), deep].join('\n') + '\n' })
    const [run] = buildReport(db, [runId], { provider, home }).runs
    expect(run!.log.split('\n')[1]).toBe(deep)
  })

  it('leaves seven characters of a key alone, which ordinary text holds by chance', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), 'OPENAI_API_KEY=sk-proj-0123456789\n')
    const runId = seedRun({ debug: { 'batch-001-attempt-1.output.txt': 'see sk-proj' } })
    expect(buildReport(db, [runId], { provider, home }).runs[0]!.debug[0]!.text).toBe('see sk-proj')
  })

  // The endpoint checks these as polyglots wrote them, and refuses the whole
  // report when one does not parse: a key of "1" made polyglots "[redacted].0.[redacted]".
  // Each restored field is pinned by a key of six characters or more that
  // occurs in it, so the redactor would rewrite it without the restore. The
  // polyglots version cannot be pinned that way while VERSION is under six
  // characters ("1.0.1"); the "1" key below shows only that a short key no
  // longer touches it.
  it('never redacts the fields polyglots writes itself', () => {
    process.env.DEEPL_API_KEY = '1'
    process.env.OPENAI_API_KEY = 'antigr'
    // The key is read from .env as well as the environment, which gives one
    // more slot: the start of the Node version.
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', '.env'), `DEEPL_API_KEY=${process.version.slice(0, 6)}\n`)
    const report = buildReport(db, [seedRun()], { provider, home })
    expect(report).toMatchObject({ schema: 1, polyglots: VERSION, node: process.version })
    expect(report.provider.name).toBe('antigravity')
  })

  // Only where the platform's name is six characters, the shortest key redacted.
  it.skipIf(process.platform !== 'darwin')('never redacts the platform', () => {
    process.env.OPENAI_API_KEY = 'darwin'
    expect(buildReport(db, [seedRun()], { provider, home }).platform).toBe('darwin')
  })

  // agy's own CLI log may hold the Google account or an OAuth token, and
  // nobody has looked yet. Debug mode keeps the copies on disk; a report
  // leaves them out.
  it('leaves the copies of antigravity\'s own CLI logs out of a report', () => {
    const runId = seedRun({
      debug: {
        'batch-001-attempt-1.prompt.txt': 'prompt',
        'batch-001-attempt-1.agy-cli-20261017_120000.log': 'account someone@example.com',
      },
    })
    const report = buildReport(db, [runId], { provider, home })
    expect(report.runs[0]!.debug.map((f) => f.name)).toEqual(['batch-001-attempt-1.prompt.txt'])
  })

  it('never reads config.json', () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ wporgUsername: 'config-only-value' }))
    const runId = seedRun()
    expect(JSON.stringify(buildReport(db, [runId], { provider, home }))).not.toContain('config-only-value')
  })
})

describe('encodeReport', () => {
  it('cuts the largest debug texts to fit under 1 MB, names them, and keeps the run log whole', () => {
    const big = (n: number) => randomBytes(n).toString('base64')
    const runId = seedRun({ debug: { 'batch-001-attempt-1.stdout.txt': big(1_500_000), 'batch-001-attempt-1.prompt.txt': big(1_500_000), 'small.txt': 'keep me' } })
    const report = buildReport(db, [runId], { provider, home })
    const log = report.runs[0]!.log
    const { body, cut } = encodeReport(report)
    const stem = runLogStem(START, runId)
    expect(body.length).toBeLessThanOrEqual(REPORT_LIMIT_BYTES)
    expect(cut).toEqual(expect.arrayContaining([`${stem}/batch-001-attempt-1.stdout.txt`, `${stem}/batch-001-attempt-1.prompt.txt`]))
    expect(cut).not.toContain(`${stem}/small.txt`)
    // Named as `v` named them before the send, so the line saying what was
    // cut points at a file the person was shown.
    const shown = summarize(report).map((i) => i.name)
    for (const name of cut) expect(shown).toContain(name)
    const sent = JSON.parse(gunzipSync(body).toString('utf8')) as Report
    expect(sent.runs[0]!.log).toBe(log)
    expect(sent.cut).toEqual(cut)
    expect(sent.runs[0]!.debug.find((d) => d.name === 'small.txt')!.text).toBe('keep me')
  })

  it('also cuts a report that compresses small but inflates past what the endpoint reads', () => {
    const runId = seedRun({ debug: { 'batch-001-attempt-1.stdout.txt': 'a'.repeat(12_000_000) } })
    const { body, cut } = encodeReport(buildReport(db, [runId], { provider, home }))
    expect(cut).toEqual([`${runLogStem(START, runId)}/batch-001-attempt-1.stdout.txt`])
    expect(gunzipSync(body).length).toBeLessThanOrEqual(REPORT_INFLATED_LIMIT_BYTES)
  })

  it('cuts a long debug run in a few compressions, not one per halving', () => {
    // Seventy batches of three files each, word-like text that gzips about the
    // way a real prompt and agent output do. Halving one file and compressing
    // the whole report again took hundreds of rounds and half a minute here,
    // with the event loop blocked throughout.
    let seed = 7
    const rand = (n: number): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) % n
    }
    const words = Array.from({ length: 4000 }, (_, i) => `w${i.toString(36)}${'aeiou'[i % 5]}`)
    const prose = (bytes: number): string => {
      const parts: string[] = []
      let size = 0
      while (size < bytes) {
        const word = words[rand(words.length)]!
        parts.push(word)
        size += word.length + 1
      }
      return parts.join(' ')
    }
    const debug: Record<string, string> = {}
    for (let batch = 1; batch <= 70; batch++) {
      const stem = `batch-${String(batch).padStart(3, '0')}-attempt-1`
      debug[`${stem}.prompt.txt`] = prose(60_000)
      debug[`${stem}.stdout.txt`] = prose(60_000)
      debug[`${stem}.stderr.txt`] = prose(2_000)
    }
    const runId = seedRun({ debug })
    const report = buildReport(db, [runId], { provider, home })
    let rounds = 0
    const compress = (json: string): Buffer => {
      rounds++
      // Fails fast instead of spending the minutes the old loop took.
      if (rounds > 8) throw new Error(`compressed ${rounds} times`)
      return gzipSync(json)
    }
    const { body, cut } = encodeReport(report, compress)
    expect(rounds).toBeLessThanOrEqual(8)
    expect(body.length).toBeLessThanOrEqual(REPORT_LIMIT_BYTES)
    // Not cut to nothing on the way: the estimate lands near the limit.
    expect(body.length).toBeGreaterThan(REPORT_LIMIT_BYTES * 0.7)
    expect(cut.length).toBeGreaterThan(0)
  })

  it('gives two runs whose debug folders share a file name two cut names, each joined to its own run', () => {
    const big = (n: number) => randomBytes(n).toString('base64')
    const name = 'batch-001-attempt-1.stdout.txt'
    const first = seedRun({ debug: { [name]: big(1_000_000) } })
    // The windows overlap (START..+9 s and +3 s..+12 s), so the time window
    // cannot keep the lines apart; the agent pid and the call span must. The
    // first run's call is +1 s..+5 s, the second's +4 s..+8 s. Each line
    // below falls in both windows and outside the other run's call, so only
    // its own run's pid keeps it.
    const second = seedRun({ start: START + 3000, pid: 5353, debug: { [name]: big(1_000_000) } })
    writeMcp([
      { t: START + 3500, pid: 900, ppid: 4242, tool: 'first_run_lookup' },
      { t: START + 8500, pid: 901, ppid: 5353, tool: 'second_run_lookup' },
    ])
    const report = buildReport(db, [first, second], { provider, home })
    expect(report.runs.map((r) => r.mcp)).toEqual([expect.stringContaining('first_run_lookup'), expect.stringContaining('second_run_lookup')])
    expect(report.runs[0]!.mcp).not.toContain('second_run_lookup')
    expect(report.runs[1]!.mcp).not.toContain('first_run_lookup')
    const { cut } = encodeReport(report)
    expect(cut.slice().sort()).toEqual([`${runLogStem(START, first)}/${name}`, `${runLogStem(START + 3000, second)}/${name}`].sort())
    const shown = summarize(report).map((i) => i.name)
    for (const c of cut) expect(shown).toContain(c)
  })

  it('leaves a report that fits untouched', () => {
    const runId = seedRun({ debug: { 'a.txt': 'short' } })
    const { body, cut } = encodeReport(buildReport(db, [runId], { provider, home }))
    expect(cut).toEqual([])
    expect((JSON.parse(gunzipSync(body).toString('utf8')) as Report).cut).toBeUndefined()
  })

  it('throws ReportTooLarge when the run log alone cannot fit', () => {
    const runId = seedRun({ logText: randomBytes(4_500_000).toString('hex') })
    expect(() => encodeReport(buildReport(db, [runId], { provider, home }))).toThrow(ReportTooLarge)
    expect(() => encodeReport(buildReport(db, [runId], { provider, home }))).toThrow(/compressed.*over the 1 MB limit/)
    // Thrown only once every debug file is cut to nothing, and debug mode
    // never writes to the run log, so turning it off cannot make this fit.
    expect(() => encodeReport(buildReport(db, [runId], { provider, home }))).toThrow(/run logs and MCP lines alone/)
    expect(() => encodeReport(buildReport(db, [runId], { provider, home }))).not.toThrow(/debug mode/)
  })

  it('names the 8 MB uncompressed limit when that is the one a report fails', () => {
    // Gzips to a few kilobytes, so naming the 1 MB compressed limit here
    // would tell the person their report is under the limit it names.
    const runId = seedRun({ logText: 'a'.repeat(9_000_000) })
    let error: unknown
    try {
      encodeReport(buildReport(db, [runId], { provider, home }))
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ReportTooLarge)
    expect((error as Error).message).toMatch(/9\.0 MB uncompressed.*over the 8 MB uncompressed limit/)
    expect((error as Error).message).toMatch(/run logs and MCP lines alone/)
    expect((error as Error).message).not.toMatch(/1 MB|kB|debug mode/)
  })

  // Rounded to a tenth, 8.04 MB would read "8.0 MB, over the 8 MB limit",
  // which reads as a check that is wrong; the size is never shown at the limit.
  it('never shows an uncompressed size just over the limit as the limit itself', () => {
    expect(new ReportTooLarge({ sent: 1000, raw: 8_040_000 }).message).toMatch(/8\.1 MB uncompressed/)
  })
})

describe('summarize', () => {
  it('lists what the report holds, file by file, with sizes', () => {
    const runId = seedRun({ debug: { 'batch-001-attempt-1.prompt.txt': 'x'.repeat(500) } })
    const stem = runLogStem(START, runId)
    const items = summarize(buildReport(db, [runId], { provider, home, contact: 'me' }))
    const names = items.map((i) => i.name)
    expect(names).toEqual(expect.arrayContaining([`${stem}.jsonl`, `${stem}/batch-001-attempt-1.prompt.txt`]))
    expect(items.find((i) => i.name === `${stem}/batch-001-attempt-1.prompt.txt`)!.bytes).toBe(500)
    for (const i of items) expect(i.bytes).toBeGreaterThanOrEqual(0)
  })
})
