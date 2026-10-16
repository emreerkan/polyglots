import { readFile } from 'node:fs/promises'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { Locale, TmEntry } from '../types.js'

export interface TmxOptions {
  targetLocale: Locale
  project?: string
}

type Attrs = Record<string, string>
type Node = { ':@'?: Attrs } & { [tag: string]: Node[] | Attrs | string | undefined }

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
})

export function parseTmx(xml: string, opts: TmxOptions): TmEntry[] {
  const valid = XMLValidator.validate(xml)
  if (valid !== true) throw new Error(`Invalid TMX: ${valid.err.msg} (line ${valid.err.line})`)

  const doc = parser.parse(xml) as Node[]
  const root = doc.find((n) => 'tmx' in n)
  if (!root) throw new Error('Invalid TMX: missing <tmx> root element')

  const rootChildren = children(root, 'tmx')
  const header = rootChildren.find((n) => 'header' in n)
  const body = rootChildren.find((n) => 'body' in n)
  const headerSrc = attrs(header)['srclang']
  const target = normalizeLocale(opts.targetLocale)

  const entries: TmEntry[] = []
  if (!body) return entries

  for (const node of children(body, 'body')) {
    if (!('tu' in node)) continue
    const entry = readTu(node, headerSrc, target, opts)
    if (entry) entries.push(entry)
  }
  return entries
}

export async function loadTmx(path: string, opts: TmxOptions): Promise<TmEntry[]> {
  return parseTmx(decodeXml(await readFile(path)), opts)
}

export function decodeXml(bytes: Buffer): string {
  const [b0, b1, b2] = [bytes[0], bytes[1], bytes[2]]
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return bytes.subarray(3).toString('utf8')
  if (b0 === 0xff && b1 === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (b0 === 0xfe && b1 === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le')
  if (b0 === 0x3c && b1 === 0x00) return bytes.toString('utf16le')
  if (b0 === 0x00 && b1 === 0x3c) return Buffer.from(bytes).swap16().toString('utf16le')
  return bytes.toString('utf8')
}

// TMX 1.4 allows srclang="*all*", meaning no single source language; PoEdit's reader special-cases it the same way.
const ANY_SRCLANG = '*all*'

function readTu(tu: Node, headerSrc: string | undefined, target: string, opts: TmxOptions): TmEntry | undefined {
  const tuChildren = children(tu, 'tu')
  const srcRaw = attrs(tu)['srclang'] ?? headerSrc
  const srcNormalized = srcRaw ? normalizeLocale(srcRaw) : undefined
  const src = srcNormalized && srcNormalized !== ANY_SRCLANG ? srcNormalized : undefined

  // Exact language tags are claimed before language-only ones, and a tuv
  // claimed by one side is never taken by the other. A single first-match
  // scan was enough while the source and target were different languages,
  // but en_GB, en_AU and the other English variants share a language with
  // an en source: a bare "en" matches every English region, so the source
  // tuv was read as the target and every unit filed reversed. The row count
  // stayed right, so nothing downstream could notice.
  const tuvs = tuChildren
    .filter((child) => 'tuv' in child)
    .map((node) => ({ node, lang: normalizeLocale(attrs(node)['xml:lang'] ?? attrs(node)['lang'] ?? '') }))
  const targetBase = target.split('/')[0] ?? target
  const claimed = new Set<Node>()
  const claim = (match: (lang: string) => boolean): Node | undefined => {
    const hit = tuvs.find((t) => !claimed.has(t.node) && match(t.lang))
    if (hit) claimed.add(hit.node)
    return hit?.node
  }

  let targetNode = claim((lang) => lang === targetBase)
  const targetExact = targetNode !== undefined
  let sourceNode = src ? claim((lang) => lang === src) : undefined
  targetNode ??= claim((lang) => localeMatches(target, lang))
  if (src) sourceNode ??= claim((lang) => localeMatches(src, lang))
  // Without a srclang the source is a tuv in another language. Only when
  // none exists, and the target was found by its exact tag, is a sibling of
  // the same language (en beside en-GB) taken as the source. Found by
  // language alone, a second tuv of that language is a duplicate of the
  // target, and a tu of tr and tr-TR has no source at all.
  else sourceNode = claim((lang) => !localeMatches(target, lang)) ?? (targetExact ? claim(() => true) : undefined)
  const targetSeg = targetNode && segText(targetNode)
  const sourceSeg = sourceNode && segText(sourceNode)

  if (!sourceSeg?.trim() || !targetSeg?.trim()) return undefined

  const entry: TmEntry = { source: sourceSeg, target: targetSeg, locale: target }
  const context = readContext(tuChildren)
  if (context) entry.context = context
  const project = opts.project || readProject(tuChildren)
  if (project) entry.project = project
  return entry
}

// polyglots-data tags each unit with every project it was taken from, the
// first being the one it came from; a unit in two projects carries two props.
// One project per row is what the memory stores, so the first is kept. An
// explicit project option still wins: tm import --project is the person
// saying what the file is, and they know better than its tags.
function readProject(tuChildren: Node[]): string | undefined {
  for (const child of tuChildren) {
    if ('prop' in child && attrs(child)['type'] === 'x-project') {
      const text = textOf(children(child, 'prop')).trim()
      if (text) return text
    }
  }
  return undefined
}

function readContext(tuChildren: Node[]): string | undefined {
  let note: string | undefined
  for (const child of tuChildren) {
    if ('prop' in child && attrs(child)['type'] === 'x-context') {
      const text = textOf(children(child, 'prop')).trim()
      if (text) return text
    }
    if (note === undefined && 'note' in child) {
      note = textOf(children(child, 'note')).trim() || undefined
    }
  }
  return note
}

function segText(tuv: Node): string | undefined {
  const seg = children(tuv, 'tuv').find((n) => 'seg' in n)
  return seg ? textOf(children(seg, 'seg')) : undefined
}

function textOf(nodes: Node[]): string {
  let out = ''
  for (const node of nodes) {
    for (const key of Object.keys(node)) {
      if (key === ':@') continue
      const value = node[key]
      if (key === '#text' || key === '#cdata') {
        out += typeof value === 'string' ? value : ''
      } else if (Array.isArray(value)) {
        out += textOf(value)
      }
    }
  }
  return out
}

function children(node: Node, tag: string): Node[] {
  const value = node[tag]
  return Array.isArray(value) ? value : []
}

function attrs(node: Node | undefined): Attrs {
  return node?.[':@'] ?? {}
}

export function normalizeLocale(locale: string): string {
  return locale.trim().toLowerCase().replace(/_/g, '-')
}

export function localeMatches(wanted: string, actual: string): boolean {
  // A file never names a translation set (nl/formal); its language decides.
  wanted = wanted.split('/')[0] ?? wanted
  if (!wanted || !actual) return false
  if (wanted === actual) return true
  const wantedLang = wanted.split('-')[0]
  const actualLang = actual.split('-')[0]
  if (wantedLang !== actualLang) return false
  return wanted === wantedLang || actual === actualLang
}
