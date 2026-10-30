import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readGlossaryCsv } from '../../app/src/glossary/csv.js'
import { createModel, setCell } from '../../app/src/glossary/editor/model.js'
import { STORAGE_KEY, exportUrl, restoreSaved, webHost, type Start, type WebEnv } from '../src/components/glossary-editor/web-host.js'

const CSV = 'en,tr,pos,description\nPost,Yazı,noun,\nPage,Sayfa,noun,A static page\n'

function memory(initial?: string, broken = false) {
  const map = new Map<string, string>(initial === undefined ? [] : [[STORAGE_KEY, initial]])
  const storage = {
    getItem: (k: string) => {
      if (broken) throw new Error('blocked')
      return map.get(k) ?? null
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error('blocked')
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
  }
  return { map, storage }
}

function env(start: Start, storage: WebEnv['storage'], seen: { saved?: unknown; downloads: { name: string; text: string }[] }): WebEnv {
  return {
    storage,
    start: async (saved) => {
      seen.saved = saved
      return start
    },
    download: (name, text) => {
      seen.downloads.push({ name, text })
    },
    pick: async () => ({ name: 'analysis.json', text: '{"a":1}' }),
  }
}

test('export is named after the opened file', async () => {
  const seen = { downloads: [] as { name: string; text: string }[] }
  const host = webHost(env({ kind: 'file', name: 'my-glossary.csv', text: CSV }, memory().storage, seen))
  const data = await host.load()
  assert.equal(data.mode, 'csv')
  assert.equal(data.headerLocale, 'tr')
  assert.equal(data.rows.length, 2)
  const m = createModel(data.rows, 'csv')
  setCell(m, m.rows[0]!.id, 'translation', 'Gönderi')
  assert.deepEqual(await host.save(m), { ok: true })
  assert.equal(seen.downloads[0]!.name, 'my-glossary.csv')
  assert.equal(readGlossaryCsv(seen.downloads[0]!.text).rows[0]!.translation, 'Gönderi')
})

test('export of a new glossary is glossary-<slug>.csv with that header', async () => {
  const seen = { downloads: [] as { name: string; text: string }[] }
  const host = webHost(env({ kind: 'new', locale: 'tr' }, memory().storage, seen))
  const data = await host.load()
  assert.equal(data.rows.length, 0)
  const m = createModel([], 'csv')
  await host.save(m)
  assert.equal(seen.downloads[0]!.name, 'glossary-tr.csv')
  assert.equal(seen.downloads[0]!.text, 'en,tr,pos,description\n')
})

test('a CSV that is not a glossary export fails the load with its message', async () => {
  const seen = { downloads: [] as { name: string; text: string }[] }
  const host = webHost(env({ kind: 'file', name: 'x.csv', text: 'a,b\n1,2\n' }, memory().storage, seen))
  await assert.rejects(host.load(), /first column must be "en"/)
})

test('saved work comes back on the next visit and is cleared by an export', async () => {
  const { storage, map } = memory()
  const first = { downloads: [] as { name: string; text: string }[] }
  const host = webHost(env({ kind: 'file', name: 'g.csv', text: CSV }, storage, first))
  const data = await host.load()
  const m = createModel(data.rows, 'csv')
  setCell(m, m.rows[1]!.id, 'translation', 'Sayfa!')
  host.persist!(m)
  assert.ok(map.has(STORAGE_KEY))

  const second = { downloads: [] as { name: string; text: string }[], saved: undefined as unknown }
  const again = webHost(env({ kind: 'saved' }, storage, second))
  assert.ok(second.saved === undefined)
  const back = await again.load()
  assert.ok(second.saved !== undefined)
  assert.equal(back.file, 'g.csv')
  assert.equal(back.headerLocale, 'tr')
  assert.equal(back.rows[1]!.translation, 'Sayfa!')

  // The editor persists again right after a successful save: that must not
  // bring the exported work back as something to continue.
  const m2 = createModel(back.rows, 'csv')
  assert.deepEqual(await again.save(m2), { ok: true })
  again.persist!(m2)
  assert.equal(map.has(STORAGE_KEY), false)
})

test('a malformed stored value is dropped, not thrown', async () => {
  for (const bad of ['{not json', '"text"', '{"rows":5}', '{"rows":[{"term":1}]}', 'null']) {
    const { storage, map } = memory(bad)
    const seen = { downloads: [] as { name: string; text: string }[], saved: 'unset' as unknown }
    const host = webHost(env({ kind: 'new', locale: 'tr' }, storage, seen))
    await host.load()
    assert.equal(seen.saved, undefined, bad)
    assert.equal(map.has(STORAGE_KEY), false, bad)
  }
  const blocked = memory('{}', true)
  const seen = { downloads: [] as { name: string; text: string }[], saved: 'unset' as unknown }
  const host = webHost(env({ kind: 'new', locale: 'tr' }, blocked.storage, seen))
  await host.load()
  assert.equal(seen.saved, undefined)
  host.persist!(createModel([], 'csv'))
})

test('restoreSaved keeps well formed work and nothing else', () => {
  const ok = restoreSaved({ locale: 'tr', file: 'a.csv', rows: [{ term: 'Post', pos: 'noun', translation: 'Yazı', notes: '' }] })
  assert.deepEqual(ok, { locale: 'tr', file: 'a.csv', rows: [{ term: 'Post', pos: 'noun', translation: 'Yazı', notes: '' }] })
  assert.equal(restoreSaved({ rows: [] }), undefined)
  assert.equal(restoreSaved([]), undefined)
})

test('the analysis picker returns parsed JSON, and nothing when cancelled', async () => {
  const seen = { downloads: [] as { name: string; text: string }[] }
  const host = webHost(env({ kind: 'new', locale: 'tr' }, memory().storage, seen))
  assert.deepEqual(await host.openSidecar!(), { a: 1 })
  const none = webHost({ ...env({ kind: 'new', locale: 'tr' }, memory().storage, seen), pick: async () => undefined })
  assert.equal(await none.openSidecar!(), undefined)
})

test('the wp.org export link uses the locale slug', () => {
  assert.equal(exportUrl('tr'), 'https://translate.wordpress.org/locale/tr/default/glossary/-export/')
})
