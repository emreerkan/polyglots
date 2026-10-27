import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LONG_STALE_AFTER_MS,
  STALE_AFTER_MS,
  checkGlossaries,
  glossaryCheckFile,
  glossaryNotice,
  stillStale,
  type GlossaryCheckOptions,
} from '../../src/glossary/freshness.js'
import { CHECK_EVERY_MS, RETRY_AFTER_MS } from '../../src/update/index.js'

const DAY = 86_400_000
const SYNCED = Date.UTC(2026, 8, 19, 0, 22)
const CHANGED = Date.UTC(2026, 8, 19, 12, 8)

describe('checkGlossaries', () => {
  let server: Server
  let base: string
  let paths: string[]
  let methods: string[]
  let reply: { status: number; lastModified?: string }

  beforeEach(async () => {
    paths = []
    methods = []
    reply = { status: 200, lastModified: new Date(CHANGED).toUTCString() }
    server = createServer((req, res) => {
      paths.push(req.url ?? '')
      methods.push(req.method ?? '')
      res.writeHead(reply.status, {
        'content-type': 'application/octet-stream',
        ...(reply.lastModified === undefined ? {} : { 'last-modified': reply.lastModified }),
      })
      res.end('en,tr,pos,description\nplugin,eklenti,noun,\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const opts = (now: number, synced: Array<{ locale: string; syncedAt: number }> = [{ locale: 'tr', syncedAt: SYNCED }]): GlossaryCheckOptions => ({
    now: () => now,
    synced: () => synced,
    urlFor: (locale) => `${base}/${locale}/-export/`,
  })

  it('reports a glossary that changed on wp.org after the last sync', async () => {
    expect(await checkGlossaries(opts(SYNCED + DAY))).toEqual([{ locale: 'tr', syncedAt: SYNCED, changedAt: CHANGED }])
    expect(paths).toEqual(['/tr/-export/'])
  })

  // An answer beats the month rule: a copy of a glossary nobody touched since
  // is not stale, and suggesting a sync then is noise.
  it('says nothing when wp.org has not changed it since, within the long fallback', async () => {
    reply.lastModified = new Date(SYNCED - DAY).toUTCString()
    expect(await checkGlossaries(opts(SYNCED + STALE_AFTER_MS + DAY))).toEqual([])
    expect(await checkGlossaries(opts(SYNCED + LONG_STALE_AFTER_MS))).toEqual([])
  })

  // One observed change has matched the header so far. Until more do, a copy
  // past the long fallback is reminded of whatever wp.org says.
  it('reminds past the long fallback even when wp.org says nothing changed', async () => {
    reply.lastModified = new Date(SYNCED - DAY).toUTCString()
    expect(await checkGlossaries(opts(SYNCED + LONG_STALE_AFTER_MS + 1))).toEqual([{ locale: 'tr', syncedAt: SYNCED }])
  })

  it('answers from the saved check for a day, then asks again', async () => {
    await checkGlossaries(opts(SYNCED + DAY))
    expect(await checkGlossaries(opts(SYNCED + DAY + CHECK_EVERY_MS - 1))).toEqual([{ locale: 'tr', syncedAt: SYNCED, changedAt: CHANGED }])
    expect(paths).toHaveLength(1)
    await checkGlossaries(opts(SYNCED + DAY + CHECK_EVERY_MS))
    expect(paths).toHaveLength(2)
  })

  // A sync after the change clears it at once, without waiting for the next
  // day's request: the saved change is compared with the new sync time.
  it('stops reporting as soon as the glossary is synced again', async () => {
    await checkGlossaries(opts(SYNCED + DAY))
    expect(await checkGlossaries(opts(SYNCED + DAY + 1, [{ locale: 'tr', syncedAt: SYNCED + DAY }]))).toEqual([])
  })

  it.each([
    ['a server error', 503],
    ['rate limiting', 429],
    ['a redirect', 301],
  ])('falls back to age after %s: stale only past a month', async (_what, status) => {
    reply = { status }
    expect(await checkGlossaries(opts(SYNCED + STALE_AFTER_MS - 1))).toEqual([])
    expect(await checkGlossaries(opts(SYNCED + STALE_AFTER_MS + RETRY_AFTER_MS))).toEqual([{ locale: 'tr', syncedAt: SYNCED }])
  })

  it('retries an unanswered request after an hour, without counting it as checked', async () => {
    reply = { status: 503 }
    await checkGlossaries(opts(SYNCED + DAY))
    expect(JSON.parse(readFileSync(glossaryCheckFile(), 'utf8')).tr.checkedAt).toBeUndefined()
    await checkGlossaries(opts(SYNCED + DAY + RETRY_AFTER_MS - 1))
    expect(paths).toHaveLength(1)
    reply = { status: 200, lastModified: new Date(CHANGED).toUTCString() }
    expect(await checkGlossaries(opts(SYNCED + DAY + RETRY_AFTER_MS))).toEqual([{ locale: 'tr', syncedAt: SYNCED, changedAt: CHANGED }])
    expect(paths).toHaveLength(2)
  })

  // An answer without the header is still an answer: asking again every hour
  // would not make wp.org start sending it.
  it('treats an answer without Last-Modified as checked, and falls back to age', async () => {
    reply = { status: 200 }
    expect(await checkGlossaries(opts(SYNCED + STALE_AFTER_MS + 1))).toEqual([{ locale: 'tr', syncedAt: SYNCED }])
    await checkGlossaries(opts(SYNCED + STALE_AFTER_MS + RETRY_AFTER_MS + 1))
    expect(paths).toHaveLength(1)
  })

  it('keeps a saved change when a later request goes unanswered', async () => {
    mkdirSync(dirname(glossaryCheckFile()), { recursive: true })
    writeFileSync(glossaryCheckFile(), JSON.stringify({ tr: { checkedAt: 0, changedAt: CHANGED } }))
    reply = { status: 503 }
    expect(await checkGlossaries(opts(CHECK_EVERY_MS))).toEqual([{ locale: 'tr', syncedAt: SYNCED, changedAt: CHANGED }])
  })

  it('asks for each synced locale, and nothing when none is synced', async () => {
    await checkGlossaries(opts(SYNCED + DAY, [{ locale: 'tr', syncedAt: SYNCED }, { locale: 'nl/formal', syncedAt: SYNCED }]))
    expect(paths.sort()).toEqual(['/nl/formal/-export/', '/tr/-export/'])
    paths = []
    expect(await checkGlossaries(opts(SYNCED + 3 * DAY, []))).toEqual([])
    expect(paths).toEqual([])
  })

  // Only the headers are needed; the export itself is not downloaded.
  it('reads the date with a GET', async () => {
    await checkGlossaries(opts(SYNCED + DAY))
    expect(methods).toEqual(['GET'])
  })

  it('never rejects, even on a state file that is not JSON', async () => {
    mkdirSync(dirname(glossaryCheckFile()), { recursive: true })
    writeFileSync(glossaryCheckFile(), '{not json')
    await expect(checkGlossaries(opts(SYNCED + DAY))).resolves.toEqual([{ locale: 'tr', syncedAt: SYNCED, changedAt: CHANGED }])
    await expect(checkGlossaries({ ...opts(SYNCED + DAY), synced: () => { throw new Error('no db') } })).resolves.toEqual([])
  })

  it('asks once when two checks start together', async () => {
    await Promise.all([checkGlossaries(opts(SYNCED + DAY)), checkGlossaries(opts(SYNCED + DAY))])
    expect(paths).toHaveLength(1)
  })
})

// The check reads the sync times when a command starts and is said when it
// ends, so a glossary sync would otherwise end by asking for itself.
describe('stillStale', () => {
  const stale = { locale: 'tr', syncedAt: SYNCED, changedAt: CHANGED }

  it('drops a glossary synced again since the check read it', () => {
    expect(stillStale([stale], () => [{ locale: 'tr', syncedAt: CHANGED + DAY }])).toEqual([])
  })

  it('keeps one whose sync has not moved, or that is no longer found', () => {
    expect(stillStale([stale], () => [{ locale: 'tr', syncedAt: SYNCED }])).toEqual([stale])
    expect(stillStale([stale], () => [])).toEqual([stale])
  })

  it('reads nothing when nothing is stale', () => {
    expect(stillStale([], () => {
      throw new Error('read')
    })).toEqual([])
  })
})

describe('glossaryNotice', () => {
  it('names the change and the command that fetches it', () => {
    expect(glossaryNotice({ locale: 'tr', syncedAt: SYNCED, changedAt: CHANGED })).toBe(
      'The tr glossary on translate.wordpress.org changed after your copy (synced 2026-09-19). Update with: polyglots glossary sync --locale tr',
    )
  })

  it('names the age when wp.org could not say', () => {
    expect(glossaryNotice({ locale: 'nl/formal', syncedAt: SYNCED }, SYNCED + 45 * DAY)).toBe(
      'Your nl/formal glossary was synced 45 days ago. Update with: polyglots glossary sync --locale nl/formal',
    )
  })
})
