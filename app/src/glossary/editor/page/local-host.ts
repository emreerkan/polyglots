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
export function localHost(page: string = location.href): EditorHost {
  const url = (path: string): string => new URL(path, page).toString()
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
      return (await res.json()) as LoadedGlossary
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
