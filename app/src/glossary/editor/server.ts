import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import type Database from 'better-sqlite3'
import { configuredLocale, loadConfig } from '../../config.js'
import { openDb } from '../../storage/db.js'
import {
  countGlossaryEdits,
  discardGlossaryEdits,
  effectiveGlossary,
  glossaryStamp,
  saveGlossaryEdits,
  StaleGlossaryError,
} from '../../storage/glossary-edits.js'
import type { Locale } from '../../types.js'
import { resolveLocale, splitLocale } from '../../wporg/locales.js'
import { formatGlossaryCsv, GLOSSARY_POS, GlossaryCsvError, readGlossaryCsv } from '../csv.js'
import type { EffectiveRow, GlossaryDiff, GlossaryRow } from '../types.js'
import { renderEditorDocument } from './document.js'
import { createModel, problemsOf, type Problem } from './model.js'
// Type only: tsconfig.json leaves the page out of the Node build, and a value
// import would pull browser code into it.
import type { LoadedGlossary } from './page/host.js'

// The glossary editor's HTTP server, on 127.0.0.1 only. The stats server
// (src/stats/server.ts) is the model and its comment explains the read
// fences, which are copied here: a random token as the first path segment,
// the Host header checked against DNS rebinding, a cross-site fetch refused.
//
// This server differs in one way that matters: it writes, to polyglots.db or
// to the person's CSV, from a browser request. So every write must also be a
// POST that comes from the page itself:
//
//   - Origin must be this server's own. A browser always sends Origin on a
//     POST, and another site cannot forge it.
//   - Content-Type must be application/json. An HTML form can post only
//     urlencoded, multipart or text/plain, and fetch cannot send JSON to
//     another origin without a preflight this server never answers. So no
//     page elsewhere gets a JSON body here at all.
//   - Both are checked, with the token and Sec-Fetch-Site, before the body is
//     read, so a refused request never reaches the parser or the store.
//   - A cross-site navigation is let through only as a GET. A form posted
//     from another site is a navigation too, and is the request to refuse.
//
// The token is visible through ps for the moment openInBrowser's opener
// lives, as with stats. For stats that opens read-only numbers; here it
// opens writes to the glossary. The design accepts that on a single-user
// machine: anyone who can run ps there can already write polyglots.db
// directly. On a shared machine it is a real gap, and the fix would be to
// hand the token to the browser some way other than a command line.
//
// The server ends itself: when the page sends close, or after idleMs with no
// request that carried the token. The page pings while it is open, since
// editing alone makes no requests. done resolves then, and the caller closes.
// A request without the token does not count, or any page probing 127.0.0.1
// could keep the server alive indefinitely.

export type EditorSource = { kind: 'db'; locale: Locale; db?: Database.Database } | { kind: 'csv'; file: string; locale?: Locale }

export interface GlossaryEditorServer {
  // http://127.0.0.1:PORT/<token>/, ready to open.
  url: string
  port: number
  // Resolves when the page sends close, the idle time passes, or close() is
  // called. The caller closes the server then; done itself stops nothing.
  done: Promise<void>
  // Idempotent. Drops open connections, so a browser's keep-alive socket
  // cannot hold a quit open, and closes a database this server opened.
  close(): Promise<void>
}

export interface GlossaryEditorOptions {
  source: EditorSource
  idleMs?: number
  onError?: (e: Error) => void
}

// Long enough for a person to read a forty-term analysis between saves;
// short enough that a forgotten tab does not hold a server for the day.
export const EDITOR_IDLE_MS = 30 * 60 * 1000

// A locale's glossary is a few thousand rows, well under a megabyte as JSON.
// The limit is there so a broken page cannot make the CLI buffer without end.
const BODY_LIMIT = 5 * 1024 * 1024

const BASE_HEADERS = {
  'cache-control': 'no-store',
  // The token is in the URL, and a referrer would carry it to any link.
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-polyglots': 'glossary',
}

const TEXT = 'text/plain; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** A refusal with the status and JSON body the page's host reads. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

const ROUTES: Record<string, 'GET' | 'POST'> = {
  '': 'GET',
  data: 'GET',
  save: 'POST',
  discard: 'POST',
  close: 'POST',
  ping: 'POST',
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// The body is checked for shape before anything acts on it: the store and the
// CSV writer take these values as they are, and a missing field would be
// written as the text "undefined" rather than refused.
function asRow(v: unknown): GlossaryRow | undefined {
  if (!isObject(v)) return undefined
  const { term, pos, translation, notes } = v
  if (typeof term !== 'string' || typeof pos !== 'string' || typeof translation !== 'string' || typeof notes !== 'string') {
    return undefined
  }
  return { term, pos, translation, notes }
}

function asEffective(v: unknown): EffectiveRow | undefined {
  const row = asRow(v)
  if (!row || !isObject(v)) return undefined
  if (v.origin !== 'wporg' && v.origin !== 'changed' && v.origin !== 'added') return undefined
  if (v.base === undefined) return { ...row, origin: v.origin }
  const base = asRow(v.base)
  return base ? { ...row, origin: v.origin, base } : undefined
}

function listOf<T>(v: unknown, read: (x: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: T[] = []
  for (const x of v) {
    const r = read(x)
    if (r === undefined) return undefined
    out.push(r)
  }
  return out
}

function asDiff(v: unknown): GlossaryDiff | undefined {
  if (!isObject(v)) return undefined
  const added = listOf(v.added, asRow)
  const deleted = listOf(v.deleted, asEffective)
  const changed = listOf(v.changed, (c) => {
    if (!isObject(c)) return undefined
    const from = asEffective(c.from)
    const to = asRow(c.to)
    return from && to ? { from, to } : undefined
  })
  return added && deleted && changed ? { added, changed, deleted } : undefined
}

const NOT_A_SAVE = 'Not a glossary save: the request did not have the shape the editor sends.'

const PROBLEM_TEXT: Record<Problem, (r: GlossaryRow) => string> = {
  'empty-term': () => 'no term',
  'empty-translation': () => 'no translation',
  'bad-pos': (r) => `unknown part of speech "${r.pos}"`,
  duplicate: () => 'the same term, part of speech and translation as another row',
}

const rowName = (r: GlossaryRow): string => (r.term === '' ? '' : ` (${r.term})`)

/**
 * The single-row problems of what a db save would write: the added rows and
 * the new values of changed ones. Duplicates are not checked here, since they
 * need the whole effective glossary with the diff applied; the page catches
 * those. The page refuses all of these itself, so this is for a page that did
 * not, and it runs before anything is written.
 */
function diffProblemLines(diff: GlossaryDiff): string[] {
  const written = [
    ...diff.added.map((r, i) => ({ r, where: `Added row ${i + 1}` })),
    ...diff.changed.map((c, i) => ({ r: c.to, where: `Changed row ${i + 1}` })),
  ]
  const lines: string[] = []
  for (const { r, where } of written) {
    const list: Problem[] = []
    if (r.term === '') list.push('empty-term')
    if (r.translation === '') list.push('empty-translation')
    if (r.pos !== '' && !(GLOSSARY_POS as readonly string[]).includes(r.pos)) list.push('bad-pos')
    if (list.length > 0) lines.push(`${where}${rowName(r)}: ${list.map((p) => PROBLEM_TEXT[p](r)).join(', ')}`)
  }
  return lines
}

/**
 * The problems the page would show, one line per row, numbered as the rows
 * are given: from 1, so for a CSV the first row after the header. Also what
 * `glossary import` refuses with.
 */
export function problemLines(rows: GlossaryRow[]): string[] {
  // createModel numbers rows from 1 in order, so an id is a row number.
  const found = problemsOf(createModel(rows, 'csv'))
  return [...found.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, list]) => {
      const row = rows[id - 1]!
      return `Row ${id}${rowName(row)}: ${list.map((p) => PROBLEM_TEXT[p](row)).join(', ')}`
    })
}

const sameRows = (a: GlossaryRow[], b: GlossaryRow[]): boolean =>
  a.length === b.length &&
  a.every((r, i) => {
    const o = b[i]!
    return r.term === o.term && r.pos === o.pos && r.translation === o.translation && r.notes === o.notes
  })

// What a CSV page loaded: the file's exact text, hashed, or that there was no
// file. Compared on save, so a save over a file that changed since (the
// GlotPress export downloaded again under the same name, a header that now
// names another locale, the file deleted or created) is refused as stale
// instead of erasing what is there now. The hash is of the bytes, not of the
// parsed rows, so a change the reader would not show still counts.
const ABSENT = 'absent'
const textStamp = (text: string | undefined): string =>
  text === undefined ? ABSENT : `sha256:${createHash('sha256').update(text, 'utf8').digest('base64url')}`

/** The file's text, or undefined when there is none. */
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}


export async function startGlossaryEditor(opts: GlossaryEditorOptions): Promise<GlossaryEditorServer> {
  const { source } = opts
  const idleMs = opts.idleMs ?? EDITOR_IDLE_MS
  const report = (err: unknown) => opts.onError?.(err instanceof Error ? err : new Error(String(err)))

  // The locale of a CSV that does not exist yet, so has no header: the one
  // given, or the configured one. Asked again on each use, since the file can
  // appear or vanish while the page is open.
  const newFileLocale = (file: string): Locale => {
    const locale = source.locale ?? configuredLocale(loadConfig())
    if (locale === undefined) {
      throw new Refusal(422, `${file} does not exist, so it has no header to read the locale from. Name one with --locale.`)
    }
    return locale
  }
  // Refused before the server starts, so the command says it rather than a
  // page that opens on an error.
  if (source.kind === 'csv' && !existsSync(source.file)) {
    try {
      newFileLocale(source.file)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  }

  const ownsDb = source.kind === 'db' && source.db === undefined
  const db = source.kind === 'db' ? (source.db ?? openDb()) : undefined
  // 24 bytes is 32 base64url characters, as for stats.
  const token = randomBytes(24).toString('base64url')
  let port = 0

  let finish!: () => void
  const done = new Promise<void>((resolve) => (finish = resolve))
  let idle: ReturnType<typeof setTimeout> | undefined
  const touch = (): void => {
    if (idle !== undefined) clearTimeout(idle)
    idle = setTimeout(finish, idleMs)
    // The listening server keeps the process alive; the timer must not keep
    // it alive after close.
    idle.unref?.()
  }

  function send(res: ServerResponse, head: boolean, status: number, type: string, body: string, extra = {}): void {
    res.writeHead(status, { ...BASE_HEADERS, 'content-type': type, 'content-length': Buffer.byteLength(body), ...extra })
    res.end(head ? undefined : body)
  }
  const sendJson = (res: ServerResponse, head: boolean, status: number, value: unknown, extra = {}): void =>
    send(res, head, status, JSON_TYPE, JSON.stringify(value), extra)

  // The body is read only here, after every fence has passed.
  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      const onData = (chunk: Buffer): void => {
        size += chunk.length
        if (size > BODY_LIMIT) {
          req.off('data', onData)
          // Drain the rest unread so the refusal can be sent; the connection
          // closes after it.
          req.resume()
          reject(new Refusal(413, 'The request is larger than the editor ever sends.'))
          return
        }
        chunks.push(chunk)
      }
      req.on('data', onData)
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  /** The CSV as the page should see it, with the locale in use and why it differs from the header. */
  // Takes the text already read, so the stamp a caller computes and the rows
  // it reads come from the same read of the file.
  function readCsv(
    file: string,
    text: string | undefined,
  ): { rows: GlossaryRow[]; headerLocale?: string; locale: Locale; notice?: string } {
    if (text === undefined) return { rows: [], locale: newFileLocale(file) }
    let parsed: ReturnType<typeof readGlossaryCsv>
    try {
      parsed = readGlossaryCsv(text)
    } catch (err) {
      if (err instanceof GlossaryCsvError) throw new Refusal(422, `${file}: ${err.message}`)
      throw err
    }
    const header = parsed.headerLocale
    const resolved = resolveLocale(header)
    const base = { rows: parsed.rows, headerLocale: header }
    if (source.locale !== undefined) {
      // GlotPress writes the slug, so nl/formal's export says nl: only a
      // different slug is a mismatch.
      if (resolved?.slug === splitLocale(source.locale).slug) return { ...base, locale: source.locale }
      const slug = splitLocale(source.locale).slug
      return {
        ...base,
        locale: source.locale,
        notice: `The file's header says "${header}", but the editor uses ${source.locale} as asked. Saving writes ${slug} into the header.`,
      }
    }
    if (resolved === undefined) {
      throw new Refusal(422, `The header of ${file} names "${header}", which is not a wp.org locale. Name one with --locale.`)
    }
    return { ...base, locale: resolved.id }
  }

  function loadData(): LoadedGlossary {
    if (source.kind === 'db') {
      // One read transaction, so the stamp is the stamp of these rows: a sync
      // from another process between two separate reads would hand the page
      // new stamp, old rows, and its save would pass the freshness check.
      return db!.transaction(() => ({
        mode: 'db' as const,
        locale: source.locale,
        rows: effectiveGlossary(db!, source.locale),
        stamp: glossaryStamp(db!, source.locale),
        localEdits: countGlossaryEdits(db!, source.locale),
      }))()
    }
    const text = readText(source.file)
    const csv = readCsv(source.file, text)
    return {
      mode: 'csv',
      locale: csv.locale,
      ...(csv.headerLocale === undefined ? {} : { headerLocale: csv.headerLocale }),
      ...(csv.notice === undefined ? {} : { notice: csv.notice }),
      file: source.file,
      rows: csv.rows,
      stamp: textStamp(text),
    }
  }

  function saveCsv(file: string, body: unknown): { stamp: string } {
    const rows = isObject(body) ? listOf(body.rows, asRow) : undefined
    if (!rows || !isObject(body) || typeof body.stamp !== 'string') throw new Refusal(400, NOT_A_SAVE)
    const problems = problemLines(rows)
    if (problems.length > 0) {
      throw new Refusal(400, 'The glossary was not saved: fix these rows first.', { problems })
    }
    const current = readText(file)
    if (textStamp(current) !== body.stamp) {
      throw new StaleGlossaryError(`${basename(file)} changed on disk since this page was opened; reload.`)
    }
    const { locale } = readCsv(file, current)
    const text = formatGlossaryCsv(rows, splitLocale(locale).slug)
    const part = `${file}.part`
    // A .part left by a crash is removed first, and the new one is created
    // exclusively: a .part that is a symlink, planted or left, would
    // otherwise send the write to wherever it points.
    try {
      unlinkSync(part)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    try {
      writeFileSync(part, text, { flag: 'wx' })
      // Read back what reached the disk, as the reader will next time: a
      // write that does not round trip must not replace the file.
      if (!sameRows(readGlossaryCsv(readFileSync(part, 'utf8')).rows, rows)) {
        throw new Error(`The written file did not read back as the rows sent, so ${file} was left as it was.`)
      }
      renameSync(part, file)
    } catch (err) {
      // Only a .part this save created; a wx that failed because one appeared
      // in between is not ours to remove.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        try {
          unlinkSync(part)
        } catch {
          // ignored: there may be no .part to remove
        }
      }
      throw err
    }
    return { stamp: textStamp(text) }
  }

  function saveDb(locale: Locale, body: unknown): { stamp: string } {
    const diff = isObject(body) ? asDiff(body.diff) : undefined
    if (!diff || !isObject(body) || typeof body.stamp !== 'string') throw new Refusal(400, NOT_A_SAVE)
    const problems = diffProblemLines(diff)
    if (problems.length > 0) {
      throw new Refusal(400, 'The glossary was not saved: fix these rows first.', { problems })
    }
    return { stamp: saveGlossaryEdits(db!, locale, diff, body.stamp) }
  }

  function discardDb(locale: Locale, body: unknown): { stamp: string } {
    if (!isObject(body) || typeof body.stamp !== 'string') throw new Refusal(400, NOT_A_SAVE)
    const stamp = body.stamp
    // The same freshness check as a save: a page that has not seen a sync's
    // or another tab's edits must not discard them.
    return db!.transaction(() => {
      if (stamp !== glossaryStamp(db!, locale)) throw new StaleGlossaryError()
      discardGlossaryEdits(db!, locale)
      return { stamp: glossaryStamp(db!, locale) }
    })()
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const head = req.method === 'HEAD'
    const host = req.headers.host
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      send(res, head, 421, TEXT, 'Misdirected request\n')
      return
    }
    // A cross-site GET navigation is someone following the link; anything
    // else cross-site is another page reaching in, a posted form included.
    const navigating =
      (req.method === 'GET' || head) &&
      req.headers['sec-fetch-mode'] === 'navigate' &&
      req.headers['sec-fetch-dest'] === 'document'
    if (req.headers['sec-fetch-site'] === 'cross-site' && !navigating) {
      send(res, head, 403, TEXT, 'Forbidden\n', { connection: 'close' })
      return
    }
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, BASE_HEADERS)
      res.end()
      return
    }
    const [, first = '', ...rest] = url.pathname.split('/')
    if (!sameToken(first, token)) {
      send(res, head, 404, TEXT, 'Not found\n', { connection: 'close' })
      return
    }
    touch()
    if (rest.length === 0) {
      // Without the slash the page's relative fetches would resolve one level
      // up and lose the token.
      res.writeHead(308, { ...BASE_HEADERS, location: `/${token}/${url.search}` })
      res.end()
      return
    }
    const route = rest.join('/')
    const method = ROUTES[route]
    if (method === undefined) {
      send(res, head, 404, TEXT, 'Not found\n', { connection: 'close' })
      return
    }
    const allowed = method === 'GET' ? req.method === 'GET' || head : req.method === 'POST'
    if (!allowed) {
      send(res, head, 405, TEXT, 'Method not allowed\n', { allow: method === 'GET' ? 'GET, HEAD' : 'POST', connection: 'close' })
      return
    }

    try {
      if (method === 'GET') {
        if (route === '') {
          const doc = renderEditorDocument()
          send(res, head, 200, 'text/html; charset=utf-8', doc.html, {
            // frame-ancestors only works as a header, never in a meta tag.
            'content-security-policy': `${doc.csp}; frame-ancestors 'none'`,
          })
        } else {
          sendJson(res, head, 200, loadData())
        }
        return
      }

      // Every refusal below is sent with the body unread, and closes the
      // connection so the unread body is not taken for the next request.
      if (req.headers.origin !== `http://${host}`) {
        sendJson(res, false, 403, { message: 'Refused: the request did not come from the editor page.' }, { connection: 'close' })
        return
      }
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      if (type !== 'application/json') {
        sendJson(res, false, 415, { message: 'The editor sends JSON only.' }, { connection: 'close' })
        return
      }
      if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) {
        sendJson(res, false, 413, { message: 'The request is larger than the editor ever sends.' }, { connection: 'close' })
        return
      }
      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        throw new Refusal(400, 'The request body is not JSON.')
      }

      // A ping only proves the page is open; the token check above has
      // already restarted the idle wait.
      if (route === 'ping') {
        sendJson(res, false, 200, {})
        return
      }
      if (route === 'close') {
        // done resolves once the answer has gone out, so the caller closing
        // the server on it cannot cut the page's request off.
        res.once('finish', finish)
        sendJson(res, false, 200, {})
        return
      }
      if (source.kind === 'csv') {
        if (route !== 'save') throw new Refusal(404, 'A CSV has no local edits to discard.')
        sendJson(res, false, 200, saveCsv(source.file, body))
        return
      }
      sendJson(res, false, 200, route === 'save' ? saveDb(source.locale, body) : discardDb(source.locale, body))
    } catch (err) {
      if (res.headersSent) {
        report(err)
        return
      }
      if (err instanceof Refusal) {
        sendJson(res, head, err.status, { message: err.message, ...err.extra }, err.status === 413 ? { connection: 'close' } : {})
        return
      }
      if (err instanceof StaleGlossaryError) {
        sendJson(res, head, 409, { reason: 'stale', message: err.message })
        return
      }
      const code = (err as { code?: unknown } | null)?.code
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
        sendJson(res, head, 503, { message: 'polyglots.db is busy with another write; try again.' }, { 'retry-after': '2' })
        return
      }
      report(err)
      // The person's own machine, their own files: the error's words are
      // more use on the page than a bare 500.
      sendJson(res, head, 500, { message: err instanceof Error ? err.message : String(err) })
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(report)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (err) {
    if (ownsDb && db?.open) db.close()
    throw err
  }
  server.on('error', report)
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
  touch()

  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${port}/${token}/`,
    port,
    done,
    close() {
      closing ??= new Promise<void>((resolve) => {
        if (idle !== undefined) clearTimeout(idle)
        server.close(() => {
          if (ownsDb && db?.open) db.close()
          finish()
          resolve()
        })
        server.closeAllConnections()
      })
      return closing
    },
  }
}
