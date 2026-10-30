import { normaliseGlossaryRow, readGlossaryCsv } from '../../csv.js'
import { currentRows, diffOf } from '../model.js'
import type { EditorHost, LoadedGlossary, SaveResult } from './host.js'

const GONE = 'The editor server is not answering. If polyglots glossary edit has stopped, run it again to open a new page.'

/**
 * The host for the page served by polyglots glossary edit. Every path is
 * resolved against the page's own URL, which ends in the server's token and a
 * slash, so the token travels with each request without the page knowing it.
 * Writes are JSON POSTs, because the server refuses anything else before it
 * reads a body; that is its fence against a form posted from another site.
 */
export type PickFile = () => Promise<{ name: string; text: string } | undefined>

/**
 * A CSV chosen in the browser's own file picker, read as text on the page.
 * The server is not asked to read it: the person picked a file, not a path,
 * and a path typed into a page is a path the server would have to fence.
 * The input is added for the one choice and removed once it has answered.
 */
export function pickCsv(): Promise<{ name: string; text: string } | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv,text/csv'
    input.hidden = true
    const done = (value: { name: string; text: string } | undefined): void => {
      input.remove()
      resolve(value)
    }
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return done(undefined)
      file.text().then((text) => done({ name: file.name, text }), () => done(undefined))
    })
    input.addEventListener('cancel', () => done(undefined))
    document.body.append(input)
    input.click()
  })
}

export function localHost(page: string = location.href, pick: PickFile = pickCsv): EditorHost {
  const url = (path: string): string => new URL(path, page).toString()
  // The locale the page edits, from the last load: an imported file whose
  // header names another one is said, as glossary import says it.
  let locale = ''
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(url(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  return {
    saveLabel: 'Save',

    async load(): Promise<LoadedGlossary> {
      let res: Response
      try {
        res = await fetch(url('data'))
      } catch {
        throw new Error(GONE)
      }
      if (!res.ok) throw new Error((await errorText(res)) ?? `Could not load the glossary (HTTP ${res.status}).`)
      const loaded = (await res.json()) as LoadedGlossary
      locale = loaded.locale
      return loaded
    },

    // Import CSV. The rows go into the table being edited whatever locale the
    // header names, so a mismatch is said, not refused: the person may mean
    // it, but it more often means the wrong file. Compared by slug alone, since
    // GlotPress writes nl/formal's export as plain nl; the locales table that
    // would resolve a WordPress code is left out of this bundle on purpose.
    async openFile(): Promise<LoadedGlossary | undefined> {
      const picked = await pick()
      if (!picked) return undefined
      const read = readGlossaryCsv(picked.text)
      const slug = locale.split('/')[0]!.toLowerCase()
      const other = read.headerLocale !== '' && slug !== '' && read.headerLocale.toLowerCase() !== slug
      return {
        mode: 'csv',
        locale: read.headerLocale,
        headerLocale: read.headerLocale,
        file: picked.name,
        rows: read.rows.map(normaliseGlossaryRow),
        ...(other
          ? { notice: `${picked.name}'s header says "${read.headerLocale}", but its rows were imported into ${locale}, the glossary this page edits.` }
          : {}),
      }
    },

    // A db save sends only what changed, with the stamp it loaded under; a CSV
    // save sends the whole table, since the file is rewritten whole anyway,
    // with the stamp of the file it loaded, so a newer copy is not overwritten.
    save: (m, stamp) =>
      send(() => post('save', m.mode === 'db' ? { diff: diffOf(m), stamp } : { rows: currentRows(m), stamp })),

    discard: (stamp) => send(() => post('discard', { stamp })),

    ping(): void {
      // Nothing to read, and a failure shows soon enough on the next save.
      void post('ping', {}).catch(() => {})
    },

    close(): void {
      // Fire and forget: the server exits on it, so there is nothing to read.
      void fetch(url('close'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      }).catch(() => {})
    },
  }
}

async function send(request: () => Promise<Response>): Promise<SaveResult> {
  let res: Response
  try {
    res = await request()
  } catch {
    return { ok: false, reason: 'error', message: GONE }
  }
  if (res.ok) {
    const body = (await readJson(res)) as { stamp?: unknown } | undefined
    return typeof body?.stamp === 'string' ? { ok: true, stamp: body.stamp } : { ok: true }
  }
  const text = await errorText(res)
  if (res.status === 409) {
    return { ok: false, reason: 'stale', message: text ?? 'The glossary changed since this page loaded.' }
  }
  if (res.status === 400) {
    return { ok: false, reason: 'problems', message: text ?? 'The server refused the glossary as it stands.' }
  }
  return { ok: false, reason: 'error', message: text ?? `The server answered HTTP ${res.status}.` }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/** The server's own words for a refusal: a message, a list of problems, or both. */
async function errorText(res: Response): Promise<string | undefined> {
  const body = (await readJson(res)) as { message?: unknown; problems?: unknown } | undefined
  const parts: string[] = []
  if (typeof body?.message === 'string' && body.message) parts.push(body.message)
  if (Array.isArray(body?.problems)) {
    const list = body.problems.filter((p): p is string => typeof p === 'string')
    if (list.length > 0) parts.push(list.join('; '))
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}
