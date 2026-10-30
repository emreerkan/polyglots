// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addRow, createModel, setCell } from '../../../src/glossary/editor/model.js'
import { localHost, pickCsv } from '../../../src/glossary/editor/page/local-host.js'
import { DEFAULT_SETTINGS } from '../../../src/glossary/editor/settings.js'

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
  it('reads the settings beside the page, and posts them to save-settings', async () => {
    const fetch = stubFetch(200, { sort: 'term-asc' })
    const host = localHost(PAGE)
    expect(await host.settings!.load()).toEqual({ sort: 'term-asc' })
    expect(fetch.mock.calls[0]![0]).toBe('http://127.0.0.1:4100/tok123/settings')
    expect(await host.settings!.save(DEFAULT_SETTINGS)).toBeUndefined()
    const [url, init] = fetch.mock.calls[1]!
    expect(url).toBe('http://127.0.0.1:4100/tok123/save-settings')
    expect(init!.method).toBe('POST')
    expect(JSON.parse(init!.body as string)).toEqual(DEFAULT_SETTINGS)
  })

  it('words a refused or failed settings save as a warning, and a failed read as a rejection', async () => {
    stubFetch(500, { message: 'disk full' })
    const host = localHost(PAGE)
    expect(await host.settings!.save(DEFAULT_SETTINGS)).toBe('The settings were not kept: disk full')
    await expect(host.settings!.load()).rejects.toThrow()
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    expect(await host.settings!.save(DEFAULT_SETTINGS)).toMatch(/^The settings were not kept: The editor server is not answering/)
  })

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

  // Import CSV is offered only by a host that can open a file, so without
  // this the button never appeared in polyglots mode.
  it('opens a CSV picked from disk, its rows normalised, and says when its header names another locale', async () => {
    stubFetch(200, { mode: 'db', locale: 'tr', rows: [], stamp: 's1' })
    const pick = vi.fn(async () => ({ name: 'terms.csv', text: 'en,de,pos,description\n  lesson ,Lektion , noun,\n' }))
    const host = localHost(PAGE, pick)
    await host.load()
    const file = await host.openFile!()
    expect(pick).toHaveBeenCalledOnce()
    expect(file).toMatchObject({ mode: 'csv', file: 'terms.csv', headerLocale: 'de' })
    expect(file!.rows).toEqual([{ term: 'lesson', pos: 'noun', translation: 'Lektion', notes: '' }])
    expect(file!.notice).toMatch(/"de".*tr/)
  })

  it('says nothing of a header that names the locale being edited, and returns nothing when the picker is cancelled', async () => {
    stubFetch(200, { mode: 'db', locale: 'tr', rows: [], stamp: 's1' })
    const texts = ['en,tr,pos,description\npost,yazı,noun,\n', undefined]
    const host = localHost(PAGE, async () => {
      const text = texts.shift()
      return text === undefined ? undefined : { name: 'tr.csv', text }
    })
    await host.load()
    expect((await host.openFile!())?.notice).toBeUndefined()
    expect(await host.openFile!()).toBeUndefined()
  })

  it('throws the reader\'s message for a file that is not a glossary export', async () => {
    const host = localHost(PAGE, async () => ({ name: 'x.csv', text: 'Term,Translation\n' }))
    await expect(host.openFile!()).rejects.toThrow(/first column must be "en"/)
  })
})

describe('pickCsv', () => {
  it('reads the file chosen in a file input, and nothing when the picker is cancelled', async () => {
    let files: File[] = [new File(['en,tr,pos,description\n'], 'tr.csv', { type: 'text/csv' })]
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      expect(this.type).toBe('file')
      Object.defineProperty(this, 'files', { value: files })
      this.dispatchEvent(new Event(files.length === 0 ? 'cancel' : 'change'))
    })
    expect(await pickCsv()).toEqual({ name: 'tr.csv', text: 'en,tr,pos,description\n' })
    files = []
    expect(await pickCsv()).toBeUndefined()
    // The input is removed once it has answered, so a page that imports
    // often does not collect them.
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0)
  })
})
