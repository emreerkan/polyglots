import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  DataError,
  DEFAULT_MANIFEST_URL,
  findEntry,
  manifestUrl,
  parseManifest,
} from '../../src/data/manifest.js'

const fixture = (name: string) => join(import.meta.dirname, '..', 'fixtures', name)

const rulesEntry = {
  locale: 'tr_TR',
  slug: 'tr',
  url: 'https://example.test/tr_TR.rules.yaml',
  sha512: 'a'.repeat(128),
  schema: 2,
  minPolyglots: '1.0.0',
  status: 'maintained',
  maintainers: ['someone'],
}

describe('parseManifest', () => {
  it('refuses a newer manifest', () => {
    expect(() => parseManifest({ schema: 2, generated: '', tm: [], rules: [] })).toThrow(
      'the polyglots-data manifest is schema 2; this polyglots reads up to 1. Update polyglots.',
    )
  })

  // The schema is read before the shape: a schema 2 manifest is allowed to
  // look nothing like schema 1, and "update polyglots" is the useful answer.
  it('refuses a newer manifest before judging its shape', () => {
    expect(() => parseManifest({ schema: 3, entries: {} })).toThrow('is schema 3')
  })

  it('refuses a bad shape as a DataError naming the field', () => {
    expect(() => parseManifest({ schema: 1, generated: '', tm: [{ slug: 'tr' }], rules: [] })).toThrow(DataError)
    expect(() => parseManifest({ schema: 1, generated: '', tm: [{ slug: 'tr' }], rules: [] })).toThrow(/tm\.0\./)
    expect(() => parseManifest('nope')).toThrow(DataError)
  })

  it('refuses a minPolyglots that is not x.y.z', () => {
    expect(() => parseManifest({ schema: 1, generated: '', tm: [], rules: [{ ...rulesEntry, minPolyglots: 'soon' }] })).toThrow(
      /minPolyglots/,
    )
  })

  it('reads the real fixture manifest', async () => {
    const m = parseManifest(JSON.parse(await readFile(fixture('data/index.json'), 'utf8')))
    expect(m.tm[0]).toMatchObject({ locale: 'tr_TR', slug: 'tr', units: 1002 })
  })

  // The long-text projects carry a kind the tm fetch summary reports.
  it('keeps a project kind and a stale date', async () => {
    const m = parseManifest(JSON.parse(await readFile(fixture('data/index.json'), 'utf8')))
    expect(m.tm[0]!.projects).toContainEqual({ path: 'wp-plugins/debug-bar/dev-readme', units: 62, kind: 'long-text' })
    expect(m.tm[0]!.projects).toContainEqual({ path: 'wp-plugins/debug-bar/dev', units: 84, stale: '2026-10-09T03:00:00Z' })
  })

  it('reads a rules entry', () => {
    expect(parseManifest({ schema: 1, generated: '', tm: [], rules: [rulesEntry] }).rules).toEqual([rulesEntry])
  })
})

describe('findEntry', () => {
  it('finds by slug and checks the WP code', () => {
    const e = { slug: 'tr', locale: 'tr_TR' }
    expect(findEntry([e], 'tr')).toBe(e)
    // Review Focus 2: Turkish under az would put Turkish wordings into an
    // Azerbaijani memory, and nothing later would ever take them out.
    expect(() => findEntry([{ slug: 'az', locale: 'tr_TR' }], 'az')).toThrow(/tr_TR.*az/)
    expect(() => findEntry([{ slug: 'az', locale: 'tr_TR' }], 'az')).toThrow(DataError)
  })

  it('checks a variant by its set', () => {
    const e = { slug: 'nl/formal', locale: 'nl_NL_formal' }
    expect(findEntry([e], 'nl/formal')).toBe(e)
    expect(() => findEntry([{ slug: 'nl/formal', locale: 'nl_NL' }], 'nl/formal')).toThrow(/nl_NL.*nl\/formal/)
  })

  it('refuses a WP code translate.wordpress.org does not list, for a slug it does', () => {
    expect(() => findEntry([{ slug: 'tr', locale: 'xx_YY' }], 'tr')).toThrow(/xx_YY/)
  })

  it('trusts the manifest for a slug the registry does not know', () => {
    expect(findEntry([{ slug: 'xx-new', locale: 'xx_NEW' }], 'xx-new').slug).toBe('xx-new')
  })

  it('names the locales that have an entry when one is missing', () => {
    expect(() => findEntry([{ slug: 'tr', locale: 'tr_TR' }], 'de')).toThrow('No polyglots-data entry for de. Available: tr')
    expect(() => findEntry([], 'de')).toThrow(/No polyglots-data entry for de.*none/)
  })
})

describe('compareVersions', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.34.0', '0.34.0')).toBe(0)
    expect(compareVersions('0.34.0', '1.0.0')).toBeLessThan(0)
  })
})

describe('manifestUrl', () => {
  it('is the GitHub latest release unless POLYGLOTS_DATA_URL says otherwise', () => {
    expect(manifestUrl({})).toBe(DEFAULT_MANIFEST_URL)
    expect(manifestUrl({ POLYGLOTS_DATA_URL: '' })).toBe(DEFAULT_MANIFEST_URL)
    expect(manifestUrl({ POLYGLOTS_DATA_URL: 'http://127.0.0.1:9/index.json' })).toBe('http://127.0.0.1:9/index.json')
  })
})
