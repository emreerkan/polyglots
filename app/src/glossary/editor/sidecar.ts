/**
 * The analysis sidecar: the JSON the Masteriyo prompt writes beside a glossary
 * CSV, shown read-only in the editor's evidence panel. Browser-safe: the page
 * reads it from a dropped file as well as from the local server.
 */

export interface SidecarRecord {
  en: string
  pos: string
  proposed: string
  confidence: 'settled' | 'contested'
  occurrences: Record<string, number>
  currentRenderings: Array<{ text: string; count: number }>
  glossary: Array<{ tr: string; pos: string; description: string }>
  otherPlugins: Array<{ project: string; tr: string }>
  tm: Array<{ en: string; tr: string }>
  examples: string[]
  reason: string
}

/**
 * A record is identified by its English term and part of speech, never by
 * position: the person reorders, adds and deletes rows. The NUL separator
 * cannot occur in either part, so two different pairs never share a key.
 */
export const sidecarKey = (en: string, pos: string): string => `${en.toLowerCase()}\u0000${pos}`

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Keep the objects of a list and read their fields, dropping anything else. */
function list<T>(v: unknown, read: (o: Record<string, unknown>) => T): T[] {
  return Array.isArray(v) ? v.filter(isObject).map(read) : []
}

/**
 * Lenient on purpose: the file is produced by a model following a prompt, so
 * a missing optional field becomes empty instead of discarding the whole
 * sidecar. Only the shape that makes matching impossible (wrong version, no
 * rows array) is an error, and an error means a notice, never blocked editing.
 */
export function readSidecar(json: unknown): { records: Map<string, SidecarRecord> } | { error: string } {
  if (!isObject(json)) return { error: 'Not an analysis file: expected a JSON object.' }
  if (json.version !== 1) return { error: `Unsupported analysis file version: ${String(json.version)}.` }
  if (!Array.isArray(json.rows)) return { error: 'Not an analysis file: "rows" is missing.' }
  const records = new Map<string, SidecarRecord>()
  for (const raw of json.rows) {
    if (!isObject(raw) || typeof raw.en !== 'string') continue
    const pos = str(raw.pos)
    const occurrences: Record<string, number> = {}
    if (isObject(raw.occurrences)) {
      for (const [k, n] of Object.entries(raw.occurrences)) if (typeof n === 'number') occurrences[k] = n
    }
    records.set(sidecarKey(raw.en, pos), {
      en: raw.en,
      pos,
      proposed: str(raw.proposed),
      confidence: raw.confidence === 'contested' ? 'contested' : 'settled',
      occurrences,
      currentRenderings: list(raw.currentRenderings, (o) => ({ text: str(o.text), count: typeof o.count === 'number' ? o.count : 0 })),
      glossary: list(raw.glossary, (o) => ({ tr: str(o.tr), pos: str(o.pos), description: str(o.description) })),
      otherPlugins: list(raw.otherPlugins, (o) => ({ project: str(o.project), tr: str(o.tr) })),
      tm: list(raw.tm, (o) => ({ en: str(o.en), tr: str(o.tr) })),
      examples: Array.isArray(raw.examples) ? raw.examples.filter((e): e is string => typeof e === 'string') : [],
      reason: str(raw.reason),
    })
  }
  return { records }
}
