import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readGlossaryCsv } from '../../app/src/glossary/csv.js'
import { addRow, createModel, diffOf, setCell, toggleDelete } from '../../app/src/glossary/editor/model.js'
import { DEFAULT_SETTINGS } from '../../app/src/glossary/editor/settings.js'
import { SETTINGS_KEY, STORAGE_KEY, discardSaved, exportUrl, fetchWporgGlossary, webHost, type Start, type WebEnv } from '../src/components/glossary-editor/web-host.js'

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

function env(
  start: Start,
  storage: WebEnv['storage'],
  seen: { saved?: unknown; downloads: { name: string; text: string }[]; asked?: Array<[string, string]> },
  // null for a person who declines to choose; undefined would take the default.
  answer: string | null = 'tr',
): WebEnv {
  return {
    storage,
    askLocale: async (name, header) => {
      ;(seen.asked ??= []).push([name, header])
      return answer ?? undefined
    },
    start: async (saved) => {
      seen.saved = saved
      return start
    },
    download: (name, text) => {
      seen.downloads.push({ name, text })
    },
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

// An export writes the header it was opened with. A header with no locale, or
// one wp.org does not list, would be written back as "en,,pos,description",
// which GlotPress and polyglots both refuse, so the locale is asked for.
test('asks for the locale when the header names none, and exports with the answer', async () => {
  const seen = { downloads: [] as { name: string; text: string }[], asked: [] as Array<[string, string]> }
  const host = webHost(env({ kind: 'file', name: 'x.csv', text: 'en,,pos,description\nPost,Yazı,noun,\n' }, memory().storage, seen))
  const data = await host.load()
  assert.deepEqual(seen.asked, [['x.csv', '']])
  assert.equal(data.locale, 'tr')
  assert.equal(data.headerLocale, 'tr')
  await host.save(createModel(data.rows, 'csv'))
  assert.equal(seen.downloads[0]!.text.split('\n')[0], 'en,tr,pos,description')
})

test('asks for the locale when the header names one wp.org does not list', async () => {
  const seen = { downloads: [] as { name: string; text: string }[], asked: [] as Array<[string, string]> }
  const host = webHost(env({ kind: 'file', name: 'x.csv', text: 'en,klingon,pos,description\n' }, memory().storage, seen, 'de'))
  assert.equal((await host.load()).headerLocale, 'de')
  assert.deepEqual(seen.asked, [['x.csv', 'klingon']])
})

test('does not ask when the header names a wp.org locale', async () => {
  const seen = { downloads: [] as { name: string; text: string }[], asked: [] as Array<[string, string]> }
  const host = webHost(env({ kind: 'file', name: 'x.csv', text: CSV }, memory().storage, seen))
  assert.equal((await host.load()).headerLocale, 'tr')
  assert.deepEqual(seen.asked, [])
})

test('refuses the file with a clear message when no locale is chosen', async () => {
  const seen = { downloads: [] as { name: string; text: string }[] }
  const host = webHost(env({ kind: 'file', name: 'x.csv', text: 'en,,pos,description\n' }, memory().storage, seen, null))
  await assert.rejects(host.load(), /x\.csv.*names no locale/)
})

const fresh = () => ({ downloads: [] as { name: string; text: string }[], saved: 'unset' as unknown })

test('saved work comes back with its change list, and an export clears it', async () => {
  const { storage, map } = memory()
  const host = webHost(env({ kind: 'file', name: 'g.csv', text: CSV }, storage, fresh()))
  const data = await host.load()
  const m = createModel(data.rows, 'csv')
  setCell(m, m.rows[1]!.id, 'translation', 'Sayfa!')
  addRow(m)
  toggleDelete(m, m.rows[0]!.id)
  host.persist!(m)
  assert.ok(map.has(STORAGE_KEY))

  const second = fresh()
  const again = webHost(env({ kind: 'saved' }, storage, second))
  const back = await again.load()
  assert.ok(second.saved !== undefined)
  assert.equal(back.file, 'g.csv')
  assert.equal(back.headerLocale, 'tr')
  // The edits made before the tab closed are still edits against the file as
  // opened, not part of the baseline.
  const m2 = back.model!
  assert.deepEqual(diffOf(m2), diffOf(m))
  assert.equal(diffOf(m2).changed.length, 1)
  assert.equal(diffOf(m2).changed[0]!.from.translation, 'Sayfa')
  assert.equal(diffOf(m2).deleted.length, 1)
  assert.equal(diffOf(m2).added.length, 1)

  // The editor persists again right after a successful save: that must not
  // bring the exported work back as something to continue.
  assert.deepEqual(await again.save(m2), { ok: true })
  again.persist!(m2)
  assert.equal(map.has(STORAGE_KEY), false)
})

test('choosing New or Open leaves waiting work in place until the first edit', async () => {
  const { storage, map } = memory()
  const first = webHost(env({ kind: 'file', name: 'g.csv', text: CSV }, storage, fresh()))
  const m = createModel((await first.load()).rows, 'csv')
  setCell(m, m.rows[0]!.id, 'translation', 'X')
  first.persist!(m)
  const waiting = map.get(STORAGE_KEY)

  const seen = fresh()
  const other = webHost(env({ kind: 'new', locale: 'de' }, storage, seen))
  const data = await other.load()
  assert.ok(seen.saved !== undefined, 'the saved work was offered')
  assert.equal(map.get(STORAGE_KEY), waiting)
  // Exporting before any edit must not delete work that was never delivered.
  const m2 = createModel(data.rows, 'csv')
  await other.save(m2)
  other.persist!(m2)
  assert.equal(map.get(STORAGE_KEY), waiting)
})

test('a malformed stored value is dropped, not thrown', async () => {
  const good = { locale: 'tr', model: { mode: 'csv', rows: [{ id: 1, term: 'a', pos: '', translation: 'b', notes: '', origin: 'wporg', deleted: false }] } }
  const row = good.model.rows[0]!
  const bads = [
    '{not json', '"text"', 'null', '{"rows":5}', '{"locale":"tr","rows":[]}',
    JSON.stringify({ ...good, model: { mode: 'db', rows: [] } }),
    JSON.stringify({ ...good, model: { mode: 'csv', rows: [{ ...row, id: '1' }] } }),
    JSON.stringify({ ...good, model: { mode: 'csv', rows: [{ ...row, origin: 'nope' }] } }),
    JSON.stringify({ ...good, model: { mode: 'csv', rows: [row, row] } }),
    JSON.stringify({ ...good, model: { mode: 'csv', rows: [{ ...row, loaded: { term: 1 } }] } }),
    JSON.stringify({ ...good, model: { mode: 'csv', rows: [{ ...row, deleted: 'no' }] } }),
  ]
  for (const bad of bads) {
    const { storage, map } = memory(bad)
    const seen = fresh()
    const host = webHost(env({ kind: 'new', locale: 'tr' }, storage, seen))
    await host.load()
    assert.equal(seen.saved, undefined, bad)
    assert.equal(map.has(STORAGE_KEY), false, bad)
  }
  const ok = memory(JSON.stringify(good))
  const seen = fresh()
  await webHost(env({ kind: 'new', locale: 'tr' }, ok.storage, seen)).load()
  assert.ok(seen.saved !== undefined)
  const blocked = memory('{}', true)
  const s2 = fresh()
  await webHost(env({ kind: 'new', locale: 'tr' }, blocked.storage, s2)).load()
  assert.equal(s2.saved, undefined)
})

test('persist says so when the work cannot be kept', async () => {
  const blocked = memory(undefined, true)
  const host = webHost(env({ kind: 'new', locale: 'tr' }, blocked.storage, fresh()))
  await host.load()
  const m = createModel([], 'csv')
  addRow(m)
  assert.match(String(host.persist!(m)), /not keeping your work/)
  const none = webHost(env({ kind: 'new', locale: 'tr' }, undefined, fresh()))
  await none.load()
  assert.match(String(none.persist!(m)), /not keeping your work/)
  const fine = webHost(env({ kind: 'new', locale: 'tr' }, memory().storage, fresh()))
  await fine.load()
  assert.equal(fine.persist!(m), undefined)
})

test('the website host offers no analysis picker', () => {
  const host = webHost(env({ kind: 'new', locale: 'tr' }, memory().storage, { downloads: [] }))
  assert.equal('openSidecar' in host, false)
})

test('the wp.org export link uses the locale slug', () => {
  assert.equal(exportUrl('tr'), 'https://translate.wordpress.org/locale/tr/default/glossary/-export/')
})

test('the current wp.org glossary is asked of the site, and opens as a file named for its locale', async () => {
  const asked: string[] = []
  const fetch = async (url: string) => {
    asked.push(url)
    return new Response(CSV, { status: 200 })
  }
  assert.deepEqual(await fetchWporgGlossary(fetch, '/polyglots/', 'pt-br'), { name: 'glossary-pt-br.csv', text: CSV })
  assert.deepEqual(asked, ['/polyglots/api/glossary/?locale=pt-br'])
})

// The dev server has no api/ and a proxy may answer with a page; neither is
// a glossary, so neither opens as one.
test('a failed or foreign answer for the wp.org glossary is an error that names the locale', async () => {
  const answer = (body: string, status: number) => async () => new Response(body, { status })
  await assert.rejects(fetchWporgGlossary(answer('wp.org did not return a glossary', 502), '/', 'tr'), /tr glossary could not be loaded/)
  await assert.rejects(fetchWporgGlossary(answer('<?php echo 1;', 200), '/', 'tr'), /tr glossary could not be loaded/)
  const offline = async () => {
    throw new TypeError('Failed to fetch')
  }
  await assert.rejects(fetchWporgGlossary(offline, '/', 'tr'), /tr glossary could not be loaded/)
})

test('discarding the kept work removes it, and says whether it could', () => {
  const kept = memory(JSON.stringify({ locale: 'tr', model: { mode: 'csv', rows: [] } }))
  assert.equal(discardSaved(kept.storage), true)
  assert.equal(kept.map.has(STORAGE_KEY), false)
  const blocked = { ...memory().storage, removeItem: () => { throw new Error('blocked') } }
  assert.equal(discardSaved(blocked), false)
  assert.equal(discardSaved(undefined), false)
})

test('keeps the editor settings in their own storage key, apart from the work', async () => {
  const kept = memory()
  const host = webHost(env({ kind: 'new', locale: 'tr' }, kept.storage, { downloads: [] }))
  assert.equal(await host.settings!.load(), undefined)
  assert.equal(await host.settings!.save({ ...DEFAULT_SETTINGS, sort: 'term-desc' }), undefined)
  assert.equal(JSON.parse(kept.map.get(SETTINGS_KEY)!).sort, 'term-desc')
  assert.equal(kept.map.has(STORAGE_KEY), false)
  assert.deepEqual(await host.settings!.load(), { ...DEFAULT_SETTINGS, sort: 'term-desc' })
  // Discarding the work leaves the settings: they are the person's, not the file's.
  discardSaved(kept.storage)
  assert.equal(kept.map.has(SETTINGS_KEY), true)
})

test('reads unusable kept settings as none, and says when the browser keeps no settings', async () => {
  const kept = memory()
  kept.map.set(SETTINGS_KEY, '{ not json')
  const host = webHost(env({ kind: 'new', locale: 'tr' }, kept.storage, { downloads: [] }))
  assert.equal(await host.settings!.load(), undefined)
  const blocked = webHost(env({ kind: 'new', locale: 'tr' }, memory(undefined, true).storage, { downloads: [] }))
  assert.equal(await blocked.settings!.load(), undefined)
  assert.match((await blocked.settings!.save(DEFAULT_SETTINGS)) ?? '', /not keeping your settings/)
  const none = webHost(env({ kind: 'new', locale: 'tr' }, undefined, { downloads: [] }))
  assert.match((await none.settings!.save(DEFAULT_SETTINGS)) ?? '', /not keeping your settings/)
})

