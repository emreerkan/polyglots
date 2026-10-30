import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { saveConfig } from '../../../src/config.js'
import { EDITOR_JS } from '../../../src/glossary/editor/client-bundle.js'
import { startGlossaryEditor, type GlossaryEditorServer } from '../../../src/glossary/editor/server.js'
import { openDb } from '../../../src/storage/db.js'
import { countGlossaryEdits, effectiveGlossary, glossaryStamp } from '../../../src/storage/glossary-edits.js'
import { replaceGlossary } from '../../../src/storage/glossary.js'
import type { GlossaryDiff } from '../../../src/glossary/types.js'

let dir: string
let db: Database.Database
let server: GlossaryEditorServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyglots-glossary-server-'))
  db = openDb(join(dir, 'polyglots.db'))
  replaceGlossary(db, 'tr', [
    { locale: 'tr', sourceTerm: 'post', translation: 'yazı', partOfSpeech: 'noun' },
    { locale: 'tr', sourceTerm: 'course', translation: 'kurs', partOfSpeech: 'noun' },
  ])
})

afterEach(async () => {
  vi.useRealTimers()
  await server?.close()
  server = undefined
  if (db.open) db.close()
  await rm(dir, { recursive: true, force: true })
})

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function call(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'GET', headers: opts.headers ?? {} }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

const origin = (s: GlossaryEditorServer) => `http://127.0.0.1:${s.port}`

/**
 * A POST that sends its headers and never its body. An answer at all proves
 * the server decided without waiting for the body.
 */
function headersOnly(url: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers }, (r) => {
      let body = ''
      r.setEncoding('utf8')
      r.on('data', (c: string) => (body += c))
      r.on('end', () => {
        resolve({ status: r.statusCode ?? 0, headers: r.headers, body })
        req.destroy()
      })
    })
    req.on('error', reject)
    req.flushHeaders()
  })
}

/** A POST as the page itself sends it: same origin, JSON. */
function post(s: GlossaryEditorServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return call(`${s.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: origin(s), 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  })
}

/** The stamp the page holds after loading, which a save hands back. */
async function stampOf(s: GlossaryEditorServer): Promise<string> {
  return JSON.parse((await call(`${s.url}data`)).body).stamp
}

const dbSource = () => ({ source: { kind: 'db' as const, locale: 'tr', db } })

describe('startGlossaryEditor: fences', () => {
  it('listens on 127.0.0.1 behind a token in the path', async () => {
    server = await startGlossaryEditor(dbSource())
    expect(server.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/[A-Za-z0-9_-]{32}/$`))
  })

  it('serves the page with the editor bundle inline and a #root to mount on', async () => {
    server = await startGlossaryEditor(dbSource())
    const res = await call(server.url)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body).toContain('<div id="root"></div>')
    expect(res.body).toContain(EDITOR_JS.slice(0, 200))
    expect(res.body).toContain('color-scheme')
  })

  it('redirects the bare token to the trailing slash the page resolves against', async () => {
    server = await startGlossaryEditor(dbSource())
    const res = await call(server.url.replace(/\/$/, ''))
    expect(res.status).toBe(308)
    expect(res.headers.location).toBe(new URL(server.url).pathname)
  })

  it('answers 404 for a wrong token, the same as for any unknown path', async () => {
    server = await startGlossaryEditor(dbSource())
    const wrong = server.url.replace(/\/[^/]+\/$/, '/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/')
    expect((await call(wrong)).status).toBe(404)
    expect((await call(`${wrong}data`)).status).toBe(404)
    expect((await call(`http://127.0.0.1:${server.port}/`)).status).toBe(404)
    expect((await call(`${server.url}nope`)).status).toBe(404)
  })

  it('refuses a request whose Host is not this server, which is how DNS rebinding shows itself', async () => {
    server = await startGlossaryEditor(dbSource())
    const res = await call(`${server.url}data`, { headers: { host: `evil.example:${server.port}` } })
    expect(res.status).toBe(421)
    expect(res.body).not.toContain('yazı')
    expect((await call(`${server.url}data`, { headers: { host: `localhost:${server.port}` } })).status).toBe(200)
  })

  it('refuses a cross-site read even with the right token, and lets a cross-site navigation open the page', async () => {
    server = await startGlossaryEditor(dbSource())
    expect((await call(`${server.url}data`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
    expect((await call(server.url, { headers: nav })).status).toBe(200)
  })

  it('sends headers that keep the token and the page to itself', async () => {
    server = await startGlossaryEditor(dbSource())
    const res = await call(server.url)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-polyglots']).toBe('glossary')
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/)
  })

  it('answers each route only with its own method', async () => {
    server = await startGlossaryEditor(dbSource())
    expect((await post(server, '', {})).status).toBe(405)
    expect((await call(`${server.url}save`)).status).toBe(405)
    expect((await call(`${server.url}data`, { method: 'PUT' })).status).toBe(405)
  })

  // Review focus 4. A page on another site that somehow had the token still
  // cannot write: a cross-site POST is refused, and refused before its body
  // is read, so nothing in it reaches the parser or the store.
  it('refuses a cross-site POST with the right token before reading its body', async () => {
    server = await startGlossaryEditor(dbSource())
    const stamp = glossaryStamp(db, 'tr')
    const res = await headersOnly(`${server.url}save`, {
      'content-type': 'application/json',
      'content-length': '1000',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    })
    expect(res.status).toBe(403)
    expect(glossaryStamp(db, 'tr')).toBe(stamp)
  })

  it('refuses a POST whose Origin is not this server, or that has none', async () => {
    server = await startGlossaryEditor(dbSource())
    const diff: GlossaryDiff = { added: [{ term: 'quiz', pos: 'noun', translation: 'sınav', notes: '' }], changed: [], deleted: [] }
    const body = { diff, stamp: glossaryStamp(db, 'tr') }
    expect((await post(server, 'save', body, { origin: 'http://127.0.0.1:1' })).status).toBe(403)
    expect((await post(server, 'save', body, { origin: 'null' })).status).toBe(403)
    const none = await call(`${server.url}save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(none.status).toBe(403)
    expect(countGlossaryEdits(db, 'tr')).toBe(0)
  })

  // A form on another site can post text/plain without a preflight; JSON
  // cannot be sent cross-origin without one.
  it('refuses a POST that is not JSON with 415', async () => {
    server = await startGlossaryEditor(dbSource())
    const body = JSON.stringify({ diff: { added: [], changed: [], deleted: [] }, stamp: glossaryStamp(db, 'tr') })
    const res = await post(server, 'save', {}, { 'content-type': 'text/plain' })
    expect(res.status).toBe(415)
    const res2 = await call(`${server.url}save`, { method: 'POST', headers: { origin: origin(server), 'content-type': 'text/plain' }, body })
    expect(res2.status).toBe(415)
    expect(countGlossaryEdits(db, 'tr')).toBe(0)
  })

  it('accepts JSON with a charset parameter', async () => {
    server = await startGlossaryEditor(dbSource())
    const res = await post(server, 'save', { diff: { added: [], changed: [], deleted: [] }, stamp: glossaryStamp(db, 'tr') }, {
      'content-type': 'application/json; charset=utf-8',
    })
    expect(res.status).toBe(200)
  })

  it('refuses a body over 5 MB with 413, before reading it, when the length says so', async () => {
    server = await startGlossaryEditor(dbSource())
    const res = await headersOnly(`${server.url}save`, {
      'content-type': 'application/json',
      'content-length': String(5 * 1024 * 1024 + 1),
      origin: origin(server),
    })
    expect(res.status).toBe(413)
  })

  it('answers 400 for a body that is not JSON, or not a save', async () => {
    server = await startGlossaryEditor(dbSource())
    const bad = await call(`${server.url}save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: origin(server) },
      body: '{not json',
    })
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body).message).toEqual(expect.any(String))
    expect((await post(server, 'save', { diff: { added: 'x' }, stamp: 's' })).status).toBe(400)
    expect((await post(server, 'save', { diff: { added: [], changed: [], deleted: [] } })).status).toBe(400)
  })
})

describe('startGlossaryEditor: polyglots mode', () => {
  it('serves the effective glossary, its stamp and the number of local edits', async () => {
    server = await startGlossaryEditor(dbSource())
    const res = await call(`${server.url}data`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    const data = JSON.parse(res.body)
    expect(data).toMatchObject({ mode: 'db', locale: 'tr', stamp: glossaryStamp(db, 'tr'), localEdits: 0 })
    expect(data.rows).toEqual(effectiveGlossary(db, 'tr'))
  })

  it('saves a diff as local edits and hands back the next stamp', async () => {
    server = await startGlossaryEditor(dbSource())
    const loaded = JSON.parse((await call(`${server.url}data`)).body)
    const diff: GlossaryDiff = {
      added: [{ term: 'quiz', pos: 'noun', translation: 'sınav', notes: '' }],
      changed: [{ from: loaded.rows[0], to: { term: 'post', pos: 'noun', translation: 'gönderi', notes: '' } }],
      deleted: [loaded.rows[1]],
    }
    const res = await post(server, 'save', { diff, stamp: loaded.stamp })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ stamp: glossaryStamp(db, 'tr') })
    expect(effectiveGlossary(db, 'tr').map((r) => [r.term, r.translation, r.origin])).toEqual([
      ['post', 'gönderi', 'changed'],
      ['quiz', 'sınav', 'added'],
    ])
    const again = JSON.parse((await call(`${server.url}data`)).body)
    expect(again.localEdits).toBe(3)
  })

  it('refuses a save under a stale stamp with 409 and writes nothing', async () => {
    server = await startGlossaryEditor(dbSource())
    const loaded = JSON.parse((await call(`${server.url}data`)).body)
    // A sync lands while the page is open, a minute after the first one. A
    // sync in the same millisecond as the last writes the same updated_at,
    // and so the same stamp, which made this test fail now and then.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_000)
    replaceGlossary(db, 'tr', [{ locale: 'tr', sourceTerm: 'post', translation: 'yazı', partOfSpeech: 'noun' }])
    vi.useRealTimers()
    const before = glossaryStamp(db, 'tr')
    const diff: GlossaryDiff = { added: [{ term: 'quiz', pos: 'noun', translation: 'sınav', notes: '' }], changed: [], deleted: [] }
    const res = await post(server, 'save', { diff, stamp: loaded.stamp })
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ reason: 'stale', message: expect.any(String) })
    expect(countGlossaryEdits(db, 'tr')).toBe(0)
    expect(glossaryStamp(db, 'tr')).toBe(before)
  })

  // The page refuses these itself; the store must not depend on it. Duplicates
  // need the whole effective glossary and stay the page's to catch.
  it('refuses an added or changed row with no term, no translation or an unknown part of speech, writing nothing', async () => {
    server = await startGlossaryEditor(dbSource())
    const loaded = JSON.parse((await call(`${server.url}data`)).body)
    const diff: GlossaryDiff = {
      added: [
        { term: 'quiz', pos: 'noun', translation: 'sınav', notes: '' },
        { term: 'lesson', pos: 'noun', translation: '', notes: '' },
      ],
      changed: [{ from: loaded.rows[0], to: { term: 'post', pos: 'thing', translation: 'yazı', notes: '' } }],
      deleted: [],
    }
    const res = await post(server, 'save', { diff, stamp: loaded.stamp })
    expect(res.status).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.problems).toHaveLength(2)
    expect(body.problems.join('\n')).toMatch(/lesson.*no translation/)
    expect(body.problems.join('\n')).toMatch(/post.*"thing"/)
    expect(countGlossaryEdits(db, 'tr')).toBe(0)
    const blank: GlossaryDiff = { added: [{ term: '', pos: '', translation: 'x', notes: '' }], changed: [], deleted: [] }
    expect((await post(server, 'save', { diff: blank, stamp: loaded.stamp })).status).toBe(400)
    expect(countGlossaryEdits(db, 'tr')).toBe(0)
  })

  it('discards every local edit under the current stamp, and refuses a stale one', async () => {
    server = await startGlossaryEditor(dbSource())
    const loaded = JSON.parse((await call(`${server.url}data`)).body)
    const diff: GlossaryDiff = { added: [{ term: 'quiz', pos: 'noun', translation: 'sınav', notes: '' }], changed: [], deleted: [] }
    const saved = JSON.parse((await post(server, 'save', { diff, stamp: loaded.stamp })).body)
    expect((await post(server, 'discard', { stamp: loaded.stamp })).status).toBe(409)
    expect(countGlossaryEdits(db, 'tr')).toBe(1)
    const res = await post(server, 'discard', { stamp: saved.stamp })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ stamp: glossaryStamp(db, 'tr') })
    expect(countGlossaryEdits(db, 'tr')).toBe(0)
  })

  it('opens polyglots.db under the isolated test home when it is given none, and closes it', async () => {
    server = await startGlossaryEditor({ source: { kind: 'db', locale: 'tr' } })
    const res = await call(`${server.url}data`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).rows).toEqual([])
    await server.close()
    server = undefined
  })

  it('leaves a database it was given open on close', async () => {
    server = await startGlossaryEditor(dbSource())
    await server.close()
    server = undefined
    expect(db.open).toBe(true)
  })
})

describe('startGlossaryEditor: CSV mode', () => {
  const csv = 'en,tr,pos,description\npost,yazı,noun,\ncourse,kurs,noun,"Not ""ders""."\n'

  it('serves the file rows with the header locale resolved', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, csv)
    server = await startGlossaryEditor({ source: { kind: 'csv', file } })
    const data = JSON.parse((await call(`${server.url}data`)).body)
    expect(data).toMatchObject({ mode: 'csv', locale: 'tr', headerLocale: 'tr', file })
    expect(data.notice).toBeUndefined()
    expect(data.stamp).toEqual(expect.any(String))
    expect(data.rows).toEqual([
      { term: 'post', translation: 'yazı', pos: 'noun', notes: '' },
      { term: 'course', translation: 'kurs', pos: 'noun', notes: 'Not "ders".' },
    ])
  })

  it('lets the given locale win over the header, and says so', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, csv)
    server = await startGlossaryEditor({ source: { kind: 'csv', file, locale: 'de' } })
    const data = JSON.parse((await call(`${server.url}data`)).body)
    expect(data.locale).toBe('de')
    expect(data.headerLocale).toBe('tr')
    expect(data.notice).toMatch(/tr/)
    expect(data.notice).toMatch(/de/)
  })

  // GlotPress writes the slug, so nl/formal's export says nl: no mismatch.
  it('reads a slug header as matching a variant of the same slug', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, 'en,nl,pos,description\npost,bericht,noun,\n')
    server = await startGlossaryEditor({ source: { kind: 'csv', file, locale: 'nl/formal' } })
    const data = JSON.parse((await call(`${server.url}data`)).body)
    expect(data.locale).toBe('nl/formal')
    expect(data.notice).toBeUndefined()
  })

  it('opens a missing file as an empty glossary of the given locale, or the configured one', async () => {
    const file = join(dir, 'new.csv')
    server = await startGlossaryEditor({ source: { kind: 'csv', file, locale: 'de' } })
    expect(JSON.parse((await call(`${server.url}data`)).body)).toMatchObject({ mode: 'csv', locale: 'de', rows: [] })
    await server.close()
    saveConfig({ defaultLocale: 'tr' })
    server = await startGlossaryEditor({ source: { kind: 'csv', file } })
    expect(JSON.parse((await call(`${server.url}data`)).body)).toMatchObject({ mode: 'csv', locale: 'tr', rows: [] })
    expect(existsSync(file)).toBe(false)
  })

  it('refuses to start on a missing file when no locale is given or configured', async () => {
    await expect(startGlossaryEditor({ source: { kind: 'csv', file: join(dir, 'new.csv') } })).rejects.toThrow(/--locale/)
  })

  // The analysis is not part of the released editor: a file beside the CSV is
  // never read, and reaches the page only through the console snippet.
  it('leaves an analysis file beside the CSV alone', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, csv)
    writeFileSync(join(dir, 'g.analysis.json'), '{oops')
    server = await startGlossaryEditor({ source: { kind: 'csv', file } })
    const data = JSON.parse((await call(`${server.url}data`)).body)
    expect(data.sidecar).toBeUndefined()
    expect(data.notice).toBeUndefined()
  })

  it('answers a file that is not a glossary export with its reason, for the page to show', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, '<html>login</html>\n')
    server = await startGlossaryEditor({ source: { kind: 'csv', file, locale: 'tr' } })
    const res = await call(`${server.url}data`)
    expect(res.status).toBe(422)
    expect(JSON.parse(res.body).message).toMatch(/"en"/)
  })

  it('writes the file through a .part and leaves none behind', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, csv)
    server = await startGlossaryEditor({ source: { kind: 'csv', file } })
    const rows = [
      { term: 'post', pos: 'noun', translation: 'gönderi', notes: 'a, "b"' },
      { term: 'İstanbul', pos: '', translation: 'ıı', notes: '' },
    ]
    const res = await post(server, 'save', { rows, stamp: await stampOf(server) })
    expect(res.status).toBe(200)
    expect(existsSync(`${file}.part`)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('en,tr,pos,description\npost,gönderi,noun,"a, ""b"""\nİstanbul,ıı,,\n')
    // The stamp of what was written, so the next save from the same page works.
    const next = JSON.parse(res.body).stamp
    expect(next).toBe(await stampOf(server))
    const second = await post(server, 'save', { rows: rows.slice(1), stamp: next })
    expect(second.status).toBe(200)
    expect(readFileSync(file, 'utf8')).toBe('en,tr,pos,description\nİstanbul,ıı,,\n')
    // The first stamp is spent once the second save has written.
    expect((await post(server, 'save', { rows, stamp: next })).status).toBe(409)
  })

  it('writes the slug of the locale in use into the header of a new file', async () => {
    const file = join(dir, 'new.csv')
    server = await startGlossaryEditor({ source: { kind: 'csv', file, locale: 'nl/formal' } })
    const stamp = await stampOf(server)
    expect((await post(server, 'save', { rows: [{ term: 'post', pos: 'noun', translation: 'bericht', notes: '' }], stamp })).status).toBe(200)
    expect(readFileSync(file, 'utf8')).toBe('en,nl,pos,description\npost,bericht,noun,\n')
  })

  it('refuses rows with problems with 400, naming them, and leaves the file as it was', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, csv)
    server = await startGlossaryEditor({ source: { kind: 'csv', file } })
    const res = await post(server, 'save', {
      rows: [
        { term: 'post', pos: 'noun', translation: 'yazı', notes: '' },
        { term: 'quiz', pos: 'noun', translation: '', notes: '' },
      ],
      stamp: await stampOf(server),
    })
    expect(res.status).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.problems).toHaveLength(1)
    expect(body.problems[0]).toMatch(/Row 2/)
    expect(body.problems[0]).toMatch(/quiz/)
    expect(readFileSync(file, 'utf8')).toBe(csv)
    expect(existsSync(`${file}.part`)).toBe(false)
  })

  // The realistic case: the GlotPress export downloaded again under the same
  // name while the editor is open. The page's save must not erase it.
  it('refuses with 409 a save over a file that changed since the page loaded, and leaves it as it is', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, csv)
    server = await startGlossaryEditor({ source: { kind: 'csv', file } })
    const stamp = await stampOf(server)
    const newer = 'en,tr,pos,description\npost,gönderi,noun,\n'
    writeFileSync(file, newer)
    const res = await post(server, 'save', { rows: [{ term: 'post', pos: 'noun', translation: 'yazı', notes: '' }], stamp })
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ reason: 'stale', message: expect.any(String) })
    expect(readFileSync(file, 'utf8')).toBe(newer)
  })

  // A header that now names another locale would otherwise be written over
  // with the locale the page loaded under.
  it('refuses a save after the header changed to another locale', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, csv)
    server = await startGlossaryEditor({ source: { kind: 'csv', file } })
    const stamp = await stampOf(server)
    const other = csv.replace('en,tr,', 'en,de,')
    writeFileSync(file, other)
    expect((await post(server, 'save', { rows: [{ term: 'post', pos: 'noun', translation: 'yazı', notes: '' }], stamp })).status).toBe(409)
    expect(readFileSync(file, 'utf8')).toBe(other)
  })

  it('refuses a save after the file was deleted, and after a missing file appeared', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, csv)
    server = await startGlossaryEditor({ source: { kind: 'csv', file, locale: 'tr' } })
    const rows = [{ term: 'post', pos: 'noun', translation: 'yazı', notes: '' }]
    const loaded = await stampOf(server)
    unlinkSync(file)
    expect((await post(server, 'save', { rows, stamp: loaded })).status).toBe(409)
    expect(existsSync(file)).toBe(false)
    const absent = await stampOf(server)
    expect(absent).not.toBe(loaded)
    writeFileSync(file, csv)
    expect((await post(server, 'save', { rows, stamp: absent })).status).toBe(409)
    expect(readFileSync(file, 'utf8')).toBe(csv)
  })

  it('refuses a CSV save with no stamp', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, csv)
    server = await startGlossaryEditor({ source: { kind: 'csv', file } })
    expect((await post(server, 'save', { rows: [{ term: 'post', pos: 'noun', translation: 'yazı', notes: '' }] })).status).toBe(400)
    expect(readFileSync(file, 'utf8')).toBe(csv)
  })

  // A .part left by a crash, or planted as a symlink to another file, must
  // not be written through: the write goes to a fresh file of its own.
  it('replaces a leftover .part, and never writes through a symlinked one', async () => {
    const file = join(dir, 'g.csv')
    const victim = join(dir, 'victim.txt')
    writeFileSync(file, csv)
    writeFileSync(victim, 'keep me')
    symlinkSync(victim, `${file}.part`)
    server = await startGlossaryEditor({ source: { kind: 'csv', file } })
    const rows = [{ term: 'post', pos: 'noun', translation: 'gönderi', notes: '' }]
    const res = await post(server, 'save', { rows, stamp: await stampOf(server) })
    expect(res.status).toBe(200)
    expect(readFileSync(victim, 'utf8')).toBe('keep me')
    expect(readFileSync(file, 'utf8')).toBe('en,tr,pos,description\npost,gönderi,noun,\n')
    expect(existsSync(`${file}.part`)).toBe(false)
  })

  it('has no discard in CSV mode', async () => {
    const file = join(dir, 'g.csv')
    writeFileSync(file, csv)
    server = await startGlossaryEditor({ source: { kind: 'csv', file } })
    expect((await post(server, 'discard', { stamp: 'x' })).status).toBe(404)
  })
})

describe('startGlossaryEditor: ending', () => {
  it('resolves done when the page sends close', async () => {
    server = await startGlossaryEditor(dbSource())
    let ended = false
    void server.done.then(() => (ended = true))
    const res = await post(server, 'close', {})
    expect(res.status).toBe(200)
    await server.done
    expect(ended).toBe(true)
  })

  it('resolves done when it is closed, and closes idempotently with a keep-alive socket open', async () => {
    server = await startGlossaryEditor(dbSource())
    const socket = createConnection(server.port, '127.0.0.1')
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    socket.write(`GET ${new URL(server.url).pathname}data HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: keep-alive\r\n\r\n`)
    await new Promise<void>((resolve) => socket.once('data', () => resolve()))
    await Promise.all([server.close(), server.close()])
    await server.done
    socket.destroy()
    server = undefined
  })

  it('resolves done after the idle time with no request, and each request starts the wait again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server = await startGlossaryEditor({ ...dbSource(), idleMs: 60_000 })
    let ended = false
    void server.done.then(() => (ended = true))
    await vi.advanceTimersByTimeAsync(40_000)
    expect((await call(`${server.url}data`)).status).toBe(200)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(21_000)
    expect(ended).toBe(true)
  })

  // Editing makes no requests, so without this a long edit would outlive
  // the server and its Save would find nothing there.
  it('lets the page hold the idle timer off with a ping, behind the same fences as a write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server = await startGlossaryEditor({ ...dbSource(), idleMs: 60_000 })
    let ended = false
    void server.done.then(() => (ended = true))
    await vi.advanceTimersByTimeAsync(40_000)
    expect((await post(server, 'ping', {})).status).toBe(200)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(ended).toBe(false)
    expect((await post(server, 'ping', {}, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(server, 'ping', {}, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await call(`${server.url}ping`)).status).toBe(405)
  })

  // A page elsewhere probing 127.0.0.1 must not be able to keep the server
  // alive past its idle time without knowing the token.
  it('does not let a request without the token hold the idle timer off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server = await startGlossaryEditor({ ...dbSource(), idleMs: 60_000 })
    let ended = false
    void server.done.then(() => (ended = true))
    await vi.advanceTimersByTimeAsync(40_000)
    expect((await call(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404)
    await vi.advanceTimersByTimeAsync(21_000)
    expect(ended).toBe(true)
  })
})
