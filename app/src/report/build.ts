import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type Database from 'better-sqlite3'
import { parse as parseDotenv } from 'dotenv'
import { batchFailures, getRun } from '../jobs/index.js'
import { logsDir, mcpLogPath, runLogStem } from '../logs/paths.js'
import { SECRET_KEYS } from '../config.js'
import { secretsFile } from '../paths.js'
import { VERSION } from '../version.js'
import { CUT_MARK } from '../logs/excerpt.js'

export interface ReportRun {
  runId: number
  command: string
  file: string
  startedAt: number
}

export interface Report {
  schema: 1
  polyglots: string
  node: string
  platform: string
  provider: { name: string; version?: string; model?: string }
  batchSize?: number
  parallel?: number
  runs: Array<{ row: unknown; failures: unknown[]; log: string; mcp: string; debug: Array<{ name: string; text: string }> }>
  contact?: string
  cut?: string[]
}

// What the reports endpoint accepts, sent and inflated. The inflated limit is
// checked here too: a report of highly repetitive debug output can gzip under
// a megabyte and still inflate past what the server will read, and a refusal
// after the upload is a worse answer than a cut before it.
export const REPORT_LIMIT_BYTES = 1_000_000
export const REPORT_INFLATED_LIMIT_BYTES = 8_000_000

// Names the limit that failed. A run log of repeated lines can gzip to a few
// kilobytes and still inflate past 8 MB; telling that person their report is
// "10 kB compressed, over the 1 MB limit" reads as a bug in the check. When
// both fail, the compressed one is named, since it is the one the upload hits
// first. Each size is given in the unit of its limit. The uncompressed one is
// rounded to a tenth, but never down to the limit itself: 8.04 MB shown as
// "8.0 MB, over the 8 MB limit" reads as a check that is wrong.
//
// No advice to turn debug mode off and run again, which the first draft gave.
// This is thrown only once every debug file is already cut to nothing, and
// debug mode never writes to the run log, so that advice could never make a
// report fit. What is left over the limit is the run logs and MCP lines.
export class ReportTooLarge extends Error {
  constructor(size: { sent: number; raw: number }) {
    const over =
      size.sent > REPORT_LIMIT_BYTES
        ? `${Math.ceil(size.sent / 1000)} kB compressed, over the ${REPORT_LIMIT_BYTES / 1_000_000} MB limit`
        : `${(Math.max(Math.round(size.raw / 100_000), REPORT_INFLATED_LIMIT_BYTES / 100_000 + 1) / 10).toFixed(1)} MB uncompressed, over the ${REPORT_INFLATED_LIMIT_BYTES / 1_000_000} MB uncompressed limit`
    super(`The problem report is ${over}, with every debug file already cut: the run logs and MCP lines alone are too large to send.`)
    this.name = 'ReportTooLarge'
  }
}

export interface BuildReportOptions {
  provider: Report['provider']
  batchSize?: number
  parallel?: number
  contact?: string
  // The home folder to write as ~, beside os.homedir(). Tests pass their temp
  // home, which is not under the real one.
  home?: string
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

type LogLine = { t?: unknown; kind?: unknown; pid?: unknown }

function parseLines(text: string): LogLine[] {
  const out: LogLine[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (value && typeof value === 'object') out.push(value as LogLine)
    } catch {
      // A torn last line from a process killed mid-write: the rest still reads.
    }
  }
  return out
}

// Each local day the window touches, since the MCP log is one file per local
// day. Stepped by calendar date rather than by 24 hours, so a daylight-saving
// change inside a long run neither skips a day nor reads one twice.
function mcpFilesBetween(from: number, to: number): string[] {
  const files: string[] = []
  const day = new Date(from)
  day.setHours(0, 0, 0, 0)
  while (day.getTime() <= to) {
    files.push(mcpLogPath(day.getTime()))
    day.setDate(day.getDate() + 1)
  }
  return files
}

// The MCP server cannot know which run called it, so its lines are joined to a
// run here. The time window alone would hand a run every other run's lookups
// from the same hours, a parallel batch's sibling included, so when the run
// log names the agents it spawned, a line must also come from one of them
// (claude starts the server as its own child) or fall inside one of their
// calls (antigravity starts it under its own long-lived process, whose pid
// polyglots never sees). A run log with no agent lines, a rules-only run or
// one that died before its first batch, falls back to the window.
function mcpLinesFor(lines: LogLine[], from: number, to: number): string {
  const spawns = new Map<number, number>()
  const calls: Array<[number, number]> = []
  for (const line of lines) {
    if (typeof line.t !== 'number' || typeof line.pid !== 'number') continue
    if (line.kind === 'agent-spawn') spawns.set(line.pid, line.t)
    if (line.kind === 'agent-exit') {
      const start = spawns.get(line.pid)
      if (start !== undefined) calls.push([start, line.t])
    }
  }
  // A call with no exit line was still going when the log stopped.
  const ended = new Set(calls.map(([start]) => start))
  for (const start of spawns.values()) if (!ended.has(start)) calls.push([start, to])
  const pids = new Set(spawns.keys())

  const kept: string[] = []
  for (const file of mcpFilesBetween(from, to)) {
    for (const raw of readText(file).split('\n')) {
      if (raw.trim() === '') continue
      let line: { t?: unknown; ppid?: unknown }
      try {
        line = JSON.parse(raw) as typeof line
      } catch {
        continue
      }
      const t = line.t
      if (typeof t !== 'number' || t < from || t > to) continue
      if (pids.size > 0 && !(typeof line.ppid === 'number' && pids.has(line.ppid)) && !calls.some(([a, b]) => t >= a && t <= b)) continue
      kept.push(raw)
    }
  }
  return kept.join('\n')
}

// The copies debug mode makes of antigravity's own CLI log (agent/run.ts
// names them <call>.agy-cli-<time>.log). They stay in the local debug folder
// and never go into a report: nobody has yet checked that agy writes no Google
// account email or OAuth token into that log, and the redactor knows only the
// .env values and the home folder, so it would pass either straight through.
// Worth revisiting once a real log has been read line by line; until then a
// report without them costs a maintainer a request for the file, and a report
// with them could cost a contributor their account.
const AGY_CLI_LOG_COPY = /\.agy-cli-[^/\\]*\.log$/

function readDebug(dir: string): Array<{ name: string; text: string }> {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  const out: Array<{ name: string; text: string }> = []
  for (const name of names) {
    if (AGY_CLI_LOG_COPY.test(name)) continue
    const path = join(dir, name)
    try {
      if (!statSync(path).isFile()) continue
    } catch {
      continue
    }
    out.push({ name, text: readText(path) })
  }
  return out
}

// Every value in .env, under any key, and the two keys polyglots reads from
// the environment too, since a key set only in the shell is just as quotable
// in a prompt. The values are redacted, not the lines dropped: a prompt that
// quotes a key is a report worth reading for everything else in it. config.json
// is never opened; nothing from it belongs in a report.
//
// A key polyglots reads is redacted from KNOWN_MIN_LENGTH up, any other key
// only from OTHER_MIN_LENGTH up. A hand-added X=1 replaced every 1 in every
// timestamp and count, which makes a report unreadable to protect a value
// nobody would call a secret; eight characters is short for any token and
// long enough to be rare in ordinary text. A key polyglots reads used to be
// redacted whatever its length, as a mistyped key still worth hiding, but a
// DEEPL_API_KEY of "1" or "." did the same damage to every version and count,
// and turned the polyglots version itself into one the endpoint refuses. No
// real DeepL or OpenAI key is under six characters, so what is shorter is a
// typo with nothing to hide.
const KNOWN_MIN_LENGTH = 6
const OTHER_MIN_LENGTH = 8

function secretValues(): string[] {
  const values = new Set<string>()
  const known = new Set<string>(SECRET_KEYS)
  const path = secretsFile()
  if (existsSync(path)) {
    for (const [key, value] of Object.entries(parseDotenv(readText(path)))) {
      if (value.length >= (known.has(key) ? KNOWN_MIN_LENGTH : OTHER_MIN_LENGTH)) values.add(value)
    }
  }
  for (const key of SECRET_KEYS) {
    const value = process.env[key]
    if (value && value.length >= KNOWN_MIN_LENGTH) values.add(value)
  }
  return [...values]
}

// Applied to every string in the report as the text it is, not to the
// report's own JSON text: on Windows the home folder's backslashes are
// doubled in JSON, and a secret holding a quote is escaped, so a replace over
// a serialised form would miss both. Some strings are JSON text themselves,
// an agent's envelope in a debug file or a run log field, and a torn run log
// line, which cannot be decoded and so is matched as it stands; for those the
// home pattern takes any run of backslashes, and a key's escaped form is one
// more literal (see wholeKeyForms). Neither reads an escape: a backslash is
// only ever a character to match.
//
// The run log and the MCP lines are JSON text, one value per line, and they
// are decoded line by line, redacted value by value and written back (see
// jsonLines). Four rounds matched them as JSON text instead, with patterns
// that counted backslashes to tell an escape from the text, and each round's
// fix opened the next edge: a key matched from inside \n broke a line, then
// a lookbehind that refused a match after a word character read the n of
// \n as one, and a Windows home at the start of every line went out. Decoded,
// a value has no escapes left, and one plain matcher serves the whole report.
//
// Error text is cut to a length where it is written, long before a report is
// built: agent stderr and stdout at 500 characters, a provider's or local
// model's answer at 200, agy's check detail at 128. A key that ran across such
// a cut reaches the report as its first part only, which is not the text the
// whole-key match looks for, so its start went out in the clear. Redacting
// at each cut site was the alternative; it is a dozen places in six modules,
// and the next cut written would not know to do it.
//
// So a key's prefix is masked too, where a cut leaves one. Every cut goes
// through excerpt (logs/excerpt.ts), which ends it in CUT_MARK, wherever the
// cut sits in the line: a failure's "stderr: <cut>; stdout: <cut>" puts the
// first one in the middle. Right before the mark, PREFIX_BEFORE_CUT characters
// are enough, since ordinary text that ends in a key's first four characters
// exactly where a cut was made is rare, and a DeepL key's first characters
// are its UUID; seven of them went out when the minimum was eight everywhere.
// The end of a string counts too, for a cut made some other way, and so does a
// quote, for a cut inside JSON text that an agent printed. Text ends there for
// every other reason as well, so there it takes PREFIX_AT_END. Nowhere else:
// eight characters of a key in the middle of ordinary text are a coincidence
// far more often than a leak.
const PREFIX_BEFORE_CUT = 4
const PREFIX_AT_END = 8

// What the whole-key match looks for, beside each key itself.
//
// Its JSON-escaped form, when that differs: a key holding a quote or a
// backslash is escaped in an agent's JSON envelope, and the envelope reaches
// the report as JSON text, in a debug file or as a decoded run log field. It
// is matched as a literal, like the key, with no escape rules: a match is a
// run of characters, and the backslashes in it are characters too.
//
// And the key without its first one, two or three characters, while eight
// or more are left, as long as a key prefix at the end of a string has to
// be. That is what remains of a key when something upstream decoded its
// start as an escape (an n after a backslash read as \n) or a cut kept the
// end of a text. Polyglots writes neither, but a model or an agent can.
const SUFFIX_DROP_MAX = 3

function wholeKeyForms(secrets: string[]): string[] {
  const forms: string[] = []
  for (const secret of secrets) {
    forms.push(secret)
    const escaped = JSON.stringify(secret).slice(1, -1)
    if (escaped !== secret) forms.push(escaped)
    for (let k = 1; k <= SUFFIX_DROP_MAX && secret.length - k >= PREFIX_AT_END; k++) forms.push(secret.slice(k))
  }
  return forms
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Longest first, so the whole of a match is replaced rather than its start,
// and a value that contains another is replaced before the one it contains.
const alternatives = (forms: Iterable<string>): string =>
  [...new Set(forms)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')

// The prefix mask is a scan, not a pattern. As one regex of every prefix,
// a value that repeats itself, the placeholder xxxxxxxxxxxxxxxx in a .env,
// made each alternative match almost to its end at every position before
// the lookahead refused it: 200 identical characters took five seconds on
// five megabytes, 40 took more than one.
//
// It is one Aho-Corasick automaton over every key, so each character of text
// costs one step however many keys there are and whatever their shape. A KMP
// automaton per key did the same for one key, but read the text once for
// each, and keys that share their first characters (every OpenAI project key
// starts sk-proj-) all found their start in the text and all took the pass:
// ten of them took 1.6 seconds on five megabytes.
//
// The automaton's state is the longest suffix of the text read so far that
// is a prefix of some key. The prefix to mask is the longest proper prefix of
// a key ending there, and every shorter one lies inside it, so one length per
// state is enough: the state's own depth when it is a proper prefix of some
// key, which is when it has a child, and otherwise, at a whole key, which the
// whole-key match covers, the same length for its failure state. Stepping on
// from a whole key through its failure state is what lets a key that overlaps
// itself end a prefix inside the next repeat.
//
// Exported for its tests, which hold it to a brute-force definition.
export function prefixRanges(secrets: string[]): ((text: string, add: (start: number, end: number) => void) => void) | undefined {
  const keys = [...new Set(secrets)].filter((secret) => secret.length > PREFIX_BEFORE_CUT)
  if (keys.length === 0) return undefined
  const children: Array<Map<number, number>> = [new Map()]
  const depth: number[] = [0]
  for (const key of keys) {
    let node = 0
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i)
      let next = children[node]!.get(c)
      if (next === undefined) {
        next = children.length
        children.push(new Map())
        depth.push(i + 1)
        children[node]!.set(c, next)
      }
      node = next
    }
  }
  // Breadth first, so a node's failure state, being shallower, is done first.
  const fail = new Int32Array(children.length)
  const masked = new Int32Array(children.length)
  const queue = [...children[0]!.values()]
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!
    masked[node] = children[node]!.size > 0 ? depth[node]! : masked[fail[node]!]!
    for (const [c, child] of children[node]!) {
      let f = fail[node]!
      while (f > 0 && !children[f]!.has(c)) f = fail[f]!
      const target = children[f]!.get(c)
      fail[child] = target !== undefined && target !== child ? target : 0
      queue.push(child)
    }
  }
  const step = (state: number, c: number): number => {
    for (;;) {
      const next = children[state]!.get(c)
      if (next !== undefined) return next
      if (state === 0) return 0
      state = fail[state]!
    }
  }
  const heads = [...new Set(keys.map((key) => key.slice(0, PREFIX_BEFORE_CUT)))]
  const longest = Math.max(...keys.map((key) => key.length))
  const minAt = (text: string, end: number): number =>
    end === text.length ? PREFIX_AT_END : text[end] === CUT_MARK ? PREFIX_BEFORE_CUT : text[end] === '"' ? PREFIX_AT_END : Infinity
  return (text, add) => {
    // A key whose first characters are nowhere in the text has no prefix to
    // mask in it, and in most text that is every key.
    if (!heads.some((head) => text.includes(head))) return
    // The places a prefix may end: before each cut mark and quote, and at the
    // end. Where there are few, a window of the longest key's length before
    // each is read, which holds any prefix ending there; where there are many
    // (a JSON envelope is mostly quotes), one pass over the whole text is
    // cheaper. Both are linear in the text.
    const places: number[] = []
    const budget = text.length / longest
    for (const sign of [CUT_MARK, '"']) {
      for (let at = text.indexOf(sign); at !== -1 && places.length <= budget; at = text.indexOf(sign, at + 1)) places.push(at)
    }
    places.push(text.length)
    if (places.length <= budget + 1) {
      for (const end of places) {
        let state = 0
        for (let i = Math.max(0, end - longest); i < end; i++) state = step(state, text.charCodeAt(i))
        const length = masked[state]!
        if (length >= minAt(text, end)) add(end - length, end)
      }
    } else {
      for (let i = 0, state = 0; i < text.length; i++) {
        state = step(state, text.charCodeAt(i))
        const length = masked[state]!
        if (length >= PREFIX_BEFORE_CUT && length >= minAt(text, i + 1)) add(i + 1 - length, i + 1)
      }
    }
  }
}

// Every key, whole or cut, is found on the same text and masked in one go.
// The whole-key replace used to run first, and where one .env value starts
// another (two folder paths, a token and the same token with a suffix), it
// wrote [redacted] over the shorter one inside a cut of the longer one; the
// prefix scan then no longer saw the longer one's start, and the rest of the
// cut went out.
//
// The matches overlap and do not come in order: the scan reads one key after
// another, and its window path takes the cut marks before the quotes. Each
// is kept as the furthest end for its start, one slot per position, and read
// back from the left: an overlap extends the mask before it, and a match
// that starts where the last one ended is a second [redacted]. That is the
// merge a sorted list of ranges gives, without the list or the sort, which
// cost half the time on text with a million cuts.
//
// Exported for its tests, which hold it to a sorted merge of brute-force
// ranges.
export function keyMasker(secrets: string[]): ((text: string) => string) | undefined {
  // An empty alternative would match the empty string at every position and
  // never move the exec loop on. secretValues never passes one.
  secrets = secrets.filter((secret) => secret !== '')
  if (secrets.length === 0) return undefined
  const whole = new RegExp(alternatives(wholeKeyForms(secrets)), 'g')
  // The escaped forms too: a key holding a quote, cut in an agent's JSON
  // envelope, leaves the start of its escaped form, not of the key.
  const prefixes = prefixRanges(secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]))
  return (text) => {
    let furthest: Int32Array | undefined
    const add = (start: number, end: number): void => {
      furthest ??= new Int32Array(text.length)
      if (end > furthest[start]!) furthest[start] = end
    }
    // exec over the one regex, not matchAll, which clones it on every call:
    // a run log of tiny lines is hundreds of thousands of strings, and the
    // clones tripled its time. Each search starts again one character after
    // the last match began, not where it ended: where the end of one key is
    // the start of another, written joined, the second starts inside the
    // first, and a search from the first one's end sent the second one's
    // tail. Matches are rare, so the searches they add cost nothing.
    whole.lastIndex = 0
    for (let match = whole.exec(text); match !== null; match = whole.exec(text)) {
      add(match.index, match.index + match[0].length)
      whole.lastIndex = match.index + 1
    }
    prefixes?.(text, add)
    if (furthest === undefined) return text
    let out = ''
    let at = 0
    for (let start = 0; start < text.length; start++) {
      const end = furthest[start]!
      if (end <= at) continue
      out += start >= at ? `${text.slice(at, start)}[redacted]` : ''
      at = end
    }
    return out + text.slice(at)
  }
}

// A Windows home reaches a report in more shapes than its own: with forward
// slashes (Node and agents print C:/Users/x), in a file URL, with the drive or
// the folder in another case (the file system does not care, so neither do
// the tools that print it), escaped in an agent's JSON envelope inside a
// debug file or a run log field, where each backslash is two or four, under
// the roots Git Bash, Cygwin and WSL give a drive (/c/Users/x,
// /cygdrive/c/Users/x, /mnt/c/Users/x), and with a folder in its 8.3 short
// name. A literal match per shape would need a list that is never complete;
// one pattern per home, any run of backslashes or a slash between its
// folders, ignoring case, covers them all. A POSIX home has one shape and
// keeps the literal match, since its case is significant.
//
// The pattern has no lookbehind. A home starts wherever its drive does: after
// a word, after an ANSI colour code's m, after \\?\, at the start of a line.
// Refusing some of those starts was what kept a match from beginning inside a
// JSON escape, and the JSON text is decoded before it is matched now, so there
// is no escape left to begin inside.
const WINDOWS_HOME = /^[A-Za-z]:[\\/]/
const SEPARATOR = '(?:\\\\+|/)'

function windowsHomePattern(homes: string[]): RegExp | undefined {
  if (homes.length === 0) return undefined
  const one = (h: string): string => {
    const [drive, ...folders] = h.split(/[\\/]+/).filter((part) => part !== '')
    const letter = escapeRegExp(drive!.slice(0, 1))
    // A drive root as a home would make every /c in any path one; no real
    // home is that, so the Unix-style roots are for a home with a folder.
    const root = folders.length === 0 ? `${letter}:` : `(?:${letter}:|/(?:cygdrive/|mnt/)?${letter})`
    return [root, ...folders.map(folder)].join(SEPARATOR)
  }
  return new RegExp(`(?:${[...homes].sort((a, b) => b.length - a.length).map(one).join('|')})${HOME_END}`, 'giu')
}

// A folder whose name is not itself a valid 8.3 name also has a short one,
// and %TEMP% is often printed with it: C:\Users\ZEYNEP~1\AppData\Local\Temp
// for a user zeynep.kaya, six characters of the name the redaction exists to
// hide. Windows builds it from the name without spaces or dots, the base cut
// to six, a tilde and a digit, and the first three characters of the
// extension. Only the first nine of a name's short forms take that shape;
// past them Windows hashes, and nothing of the name is left to find.
const SHORT_NAME_INVALID = /[ .+,;=[\]]/

function folder(name: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  const literal = escapeRegExp(name)
  if (base.length <= 8 && ext.length <= 3 && !SHORT_NAME_INVALID.test(base) && !SHORT_NAME_INVALID.test(ext)) return literal
  const clean = (s: string): string => s.replace(/[ .]/g, '').replace(/[+,;=[\]]/g, '_')
  const shortBase = clean(base).slice(0, 6)
  if (shortBase === '') return literal
  const shortExt = clean(ext).slice(0, 3)
  return `(?:${literal}|${escapeRegExp(shortBase)}~\\d${shortExt === '' ? '' : `(?:\\.${escapeRegExp(shortExt)})?`})`
}

// A home is a folder, so a match must end where its name does: C:\Users\x is
// not the start of C:\Users\xavier, and a plain replace wrote ~avier there, a
// path that points nowhere and still names most of another user. The name
// ends at anything that cannot continue it: a separator, the end, a quote, a
// space. A full stop ends it too, since "saved in C:\Users\x." is far more
// common than a sibling folder named x.old, and the cost of the rarer one is
// a path written as ~.old, not a name sent. Both the Windows and the POSIX
// forms use it.
const HOME_END = '(?![\\p{L}\\p{N}_-])'

function posixHomePattern(homes: string[]): RegExp | undefined {
  if (homes.length === 0) return undefined
  return new RegExp(`(?:${alternatives(homes)})${HOME_END}`, 'gu')
}

interface Redactor {
  // Every string in a value, read as the text it is. Object keys are left
  // alone: the report's own fields and the run row's columns are names
  // polyglots chose, and a .env value that happens to be one, "parallel" or
  // "provider", would rename a field the endpoint checks.
  plain: (value: unknown) => unknown
  // A JSONL text, the run log or the MCP lines, redacted line by line.
  jsonLines: (text: string) => string
}

function redactor(home: string | undefined): Redactor {
  const secrets = secretValues()
  const keys = keyMasker(secrets)
  const allHomes = [...new Set([homedir(), home].filter((h): h is string => typeof h === 'string' && h.length > 0))]
  const posixHomes = posixHomePattern(allHomes.filter((h) => !WINDOWS_HOME.test(h)))
  const windowsHomes = windowsHomePattern(allHomes.filter((h) => WINDOWS_HOME.test(h)))
  const text = (s: string): string => {
    let out = keys ? keys(s) : s
    if (windowsHomes) out = out.replace(windowsHomes, '~')
    if (posixHomes) out = out.replace(posixHomes, '~')
    return out
  }
  const walk = (value: unknown, renameKeys: boolean): unknown => {
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map((v) => walk(v, renameKeys))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [renameKeys ? text(k) : k, walk(v, renameKeys)]))
    }
    return value
  }
  // Each line is decoded, redacted and encoded again, so a key or a home is
  // matched in the text the line holds rather than in its escapes, and every
  // line that parsed still parses. A line's keys are redacted too: an MCP
  // line logs a tool's arguments as the agent named them, and a name is as
  // quotable as a value. The line written back is JSON.stringify's, not the
  // bytes on disk: key order is kept, and only whitespace polyglots never
  // writes is lost. A line that does not parse, a torn last line from a
  // process killed mid-write, is redacted as plain text, and so is one that
  // parses but nests too deep for walk's recursion: a RangeError there ended
  // buildReport, and no report was built over one line.
  const jsonLines = (lines: string): string =>
    lines
      .split('\n')
      .map((line) => {
        if (line.trim() === '') return line
        try {
          return JSON.stringify(walk(JSON.parse(line), true))
        } catch {
          return text(line)
        }
      })
      .join('\n')
  return { plain: (value) => walk(value, false), jsonLines }
}

export function buildReport(jobs: Database.Database, runIds: number[], opts: BuildReportOptions): Report {
  const runs: Report['runs'] = []
  for (const runId of runIds) {
    const row = getRun(jobs, runId)
    if (!row) continue
    const stem = runLogStem(row.startedAt, runId)
    const log = readText(join(logsDir(), `${stem}.jsonl`))
    const lines = parseLines(log)
    // The window closes at the last line the run wrote, not at finished_at: a
    // run that threw or was killed has no finish time, and its last line is
    // the nearest thing to when it stopped.
    const last = lines.reduce((max, l) => (typeof l.t === 'number' && l.t > max ? l.t : max), row.startedAt)
    const to = lines.length > 0 ? last : (row.finishedAt ?? Date.now())
    runs.push({
      row,
      failures: batchFailures(jobs, runId),
      log,
      mcp: mcpLinesFor(lines, row.startedAt, to),
      debug: readDebug(join(logsDir(), stem)),
    })
  }
  const report: Report = {
    schema: 1,
    polyglots: VERSION,
    node: process.version,
    platform: process.platform,
    provider: opts.provider,
    ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
    ...(opts.parallel === undefined ? {} : { parallel: opts.parallel }),
    runs,
    ...(opts.contact === undefined ? {} : { contact: opts.contact }),
  }
  const redact = redactor(opts.home)
  const redacted: Report = {
    ...(redact.plain({ ...report, runs: [] }) as Report),
    runs: report.runs.map((run) => ({
      row: redact.plain(run.row),
      failures: redact.plain(run.failures) as unknown[],
      log: redact.jsonLines(run.log),
      mcp: redact.jsonLines(run.mcp),
      debug: redact.plain(run.debug) as Report['runs'][number]['debug'],
    })),
  }
  // Put back as polyglots wrote them. These are its own values, never a
  // secret, and the endpoint checks each one as written: a key that happens
  // to occur in the version, the Node version or the provider's name would
  // otherwise make the endpoint refuse the report, or mislabel it.
  return fitFields({
    ...redacted,
    schema: report.schema,
    polyglots: report.polyglots,
    node: report.node,
    platform: report.platform,
    provider: { ...redacted.provider, name: report.provider.name },
  })
}

// What the endpoint takes (polyglots-admin's validate.js): the contact line
// up to 200 characters, the provider's model and version up to 128 (its
// MAX_DETAIL), each one line with no control character.
export const CONTACT_MAX = 200
const DETAIL_MAX = 128

/**
 * Free text made into what the endpoint accepts: one line, no control
 * characters, at most `max` long, and none when nothing is left. The endpoint
 * refuses the whole report over one field it cannot take, and only after the
 * upload, so a pasted tab in the contact line or a colour code in a
 * --version line would cost the report itself. A control character becomes a
 * space rather than nothing, so "slack:<tab>emre" stays two words.
 */
export function oneLine(text: string, max = Infinity): string | undefined {
  const line = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max).trimEnd()
  return line === '' ? undefined : line
}

// Cut after redaction, never before. The redactor writes [redacted], ten
// characters, for a key polyglots reads from six characters up, so a short
// key makes a value longer than it was, and a field cut to the limit first
// went out over it. And a key that ran across the limit was cut in half, and
// the half left was no longer the text the redactor looks for, so it went
// out in the clear.
function fitFields(report: Report): Report {
  const { name, version, model } = report.provider
  const fitVersion = version === undefined ? undefined : oneLine(version, DETAIL_MAX)
  const fitModel = model === undefined ? undefined : oneLine(model, DETAIL_MAX)
  const { contact, ...rest } = report
  const fitContact = contact === undefined ? undefined : oneLine(contact, CONTACT_MAX)
  return {
    ...rest,
    provider: { name, ...(fitVersion === undefined ? {} : { version: fitVersion }), ...(fitModel === undefined ? {} : { model: fitModel }) },
    ...(fitContact === undefined ? {} : { contact: fitContact }),
  }
}

// Debug files are the only part cut. The run log, the failures and the MCP
// lines are what a report is for and are small without debug mode; a report
// they alone push over the limit is refused rather than sent without them.
// The largest text is halved each time, keeping its start, rather than
// dropped: the head of a prompt or an agent's output says what the call was,
// and the next halving takes the next largest, so the cut spreads over the big
// files instead of erasing one. Under a kilobyte a halving saves too little to
// be worth counting, so it goes to nothing.
//
// Compression is what costs, and gzipSync blocks the event loop while it runs.
// Compressing after every halving took hundreds of rounds on a long debug run,
// half a minute to two minutes with the TUI frozen. So each round estimates how
// many raw bytes must go, from the ratio the last compression gave, halves as
// many files as that takes measured by their raw JSON size, and only then
// compresses again to check. The aim sits a little under the limit, because
// the debug text being cut can compress worse than the report as a whole; a
// round that still misses runs again with the ratio it just measured. The
// exact gzip check is the only gate, so the estimate can cost a few rounds or a
// slightly deeper cut, never a report over the limit.
const CUT_AIM = 0.95

export function encodeReport(report: Report, compress: (json: string) => Buffer = gzipSync): { body: Buffer; cut: string[] } {
  const draft = structuredClone(report)
  delete draft.cut
  const cut: string[] = []
  const encode = (): { body: Buffer; raw: number } => {
    const json = JSON.stringify(cut.length > 0 ? { ...draft, cut } : draft)
    return { body: compress(json), raw: Buffer.byteLength(json) }
  }
  // Named as summarize() names them, the run's log stem and the file, so the
  // line saying what was cut points at a name `v` showed before the send, and
  // at the folder on disk the file came from. The stem holds the run id, so
  // two runs' debug folders, which hold the same names, stay apart.
  const files = draft.runs.flatMap((run) => {
    const row = run.row as { id: number; startedAt: number }
    const stem = runLogStem(row.startedAt, row.id)
    return run.debug.map((file) => ({ file, name: `${stem}/${file.name}` }))
  })
  const jsonBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s))
  let out = encode()
  while (out.body.length > REPORT_LIMIT_BYTES || out.raw > REPORT_INFLATED_LIMIT_BYTES) {
    const ratio = out.body.length / out.raw
    const aim = CUT_AIM * Math.min(REPORT_INFLATED_LIMIT_BYTES, REPORT_LIMIT_BYTES / ratio)
    // The cut list itself grows the JSON as names join it; a round that
    // estimates nothing to remove still halves one file, so it cannot spin.
    let excess = Math.max(1, out.raw - aim)
    let halved = false
    while (excess > 0) {
      let largest: (typeof files)[number] | undefined
      for (const entry of files) if (entry.file.text.length > 0 && (!largest || entry.file.text.length > largest.file.text.length)) largest = entry
      if (!largest) break
      const { file, name } = largest
      const before = jsonBytes(file.text)
      file.text = file.text.length < 1000 ? '' : file.text.slice(0, Math.floor(file.text.length / 2))
      excess -= before - jsonBytes(file.text)
      if (!cut.includes(name)) {
        cut.push(name)
        excess += jsonBytes(name) + 1
      }
      halved = true
    }
    if (!halved) throw new ReportTooLarge({ sent: out.body.length, raw: out.raw })
    out = encode()
  }
  return { body: out.body, cut }
}

// What `v` shows before anything is sent: each run's log, its row and failures,
// its MCP lines and each debug file, named as they are on disk where they come
// from a file, with their uncompressed sizes.
export function summarize(report: Report): Array<{ name: string; bytes: number }> {
  const bytes = (s: string): number => Buffer.byteLength(s)
  const items: Array<{ name: string; bytes: number }> = []
  for (const run of report.runs) {
    const row = run.row as { id: number; startedAt: number }
    const stem = runLogStem(row.startedAt, row.id)
    items.push({ name: `${stem}.jsonl`, bytes: bytes(run.log) })
    items.push({ name: `run ${row.id}: run record and ${run.failures.length} batch failure(s)`, bytes: bytes(JSON.stringify({ row: run.row, failures: run.failures })) })
    items.push({ name: `run ${row.id}: MCP log lines`, bytes: bytes(run.mcp) })
    for (const file of run.debug) items.push({ name: `${stem}/${file.name}`, bytes: bytes(file.text) })
  }
  if (report.contact !== undefined) items.push({ name: 'contact line', bytes: bytes(report.contact) })
  return items
}
