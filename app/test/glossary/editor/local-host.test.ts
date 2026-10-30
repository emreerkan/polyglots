// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addRow, createModel, setCell } from '../../../src/glossary/editor/model.js'
import { localHost } from '../../../src/glossary/editor/page/local-host.js'

const PAGE = 'http://127.0.0.1:4100/tok123/'

function stubFetch(status: number, body: unknown) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('localHost', () => {
  it('loads from data beside the page, under the token', async () => {
    const fetch = stubFetch(200, { mode: 'db', locale: 'tr', rows: [], stamp: 's1' })
    const loaded = await localHost(PAGE).load()
    expect(fetch.mock.calls[0]![0]).toBe('http://127.0.0.1:4100/tok123/data')
    expect(loaded.stamp).toBe('s1')
  })

  it('posts the diff and the stamp as JSON in db mode', async () => {
    const fetch = stubFetch(200, { stamp: 's2' })
    const m = createModel([{ term: 'post', pos: 'noun', translation: 'yazı', notes: '', origin: 'wporg' }], 'db')
    setCell(m, 1, 'translation', 'gönderi')
    expect(await localHost(PAGE).save(m, 's1')).toEqual({ ok: true, stamp: 's2' })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:4100/tok123/save')
    expect(init!.method).toBe('POST')
    expect(new Headers(init!.headers).get('Content-Type')).toBe('application/json')
    const body = JSON.parse(init!.body as string)
    expect(body.stamp).toBe('s1')
    expect(body.diff.changed[0].to.translation).toBe('gönderi')
  })

  it('posts the whole table in csv mode', async () => {
    const fetch = stubFetch(200, {})
    const m = createModel([], 'csv')
    const id = addRow(m)
    setCell(m, id, 'term', 'quiz')
    await localHost(PAGE).save(m, 'sha256:abc')
    // The stamp is the file as the page loaded it, so a save over a newer
    // download of the same file is refused rather than written.
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      rows: [{ term: 'quiz', pos: '', translation: '', notes: '' }],
      stamp: 'sha256:abc',
    })
  })

  it('pings beside the page as a JSON POST', async () => {
    const fetch = stubFetch(200, {})
    localHost(PAGE).ping!()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:4100/tok123/ping')
    expect(init!.method).toBe('POST')
    expect(new Headers(init!.headers).get('Content-Type')).toBe('application/json')
    expect(init!.body).toBe('{}')
  })

  it('reads a 409 as stale and a 400 as problems', async () => {
    stubFetch(409, { message: 'The glossary was synced since this page loaded.' })
    expect(await localHost(PAGE).save(createModel([], 'db'), 's1')).toEqual({
      ok: false, reason: 'stale', message: 'The glossary was synced since this page loaded.',
    })
    stubFetch(400, { problems: ['row 2: empty translation'] })
    expect(await localHost(PAGE).save(createModel([], 'csv'))).toMatchObject({
      ok: false, reason: 'problems', message: expect.stringContaining('row 2: empty translation'),
    })
  })

  it('says the server is gone when fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const r = await localHost(PAGE).discard!('s1')
    expect(r).toMatchObject({ ok: false, reason: 'error' })
    if (!r.ok) expect(r.message).toMatch(/polyglots glossary edit/)
  })
})
