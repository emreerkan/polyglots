import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  DataError,
  DEFAULT_MANIFEST_URL,
  findEntry,
  findRulesEntry,
  findTmEntry,
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

  it('refuses a bad top level as a DataError naming the field', () => {
    expect(() => parseManifest({ schema: 1, generated: '', tm: {}, rules: [] })).toThrow(DataError)
    expect(() => parseManifest({ schema: 1, generated: '', tm: {}, rules: [] })).toThrow(/tm: /)
    expect(() => parseManifest('nope')).toThrow(DataError)
  })

  // One locale's entry is the producer's mistake for that locale only: a
  // shipped client cannot be patched, so a bad neighbour must not take every
  // other locale's fetch down with it. Entries are judged when one is chosen.
  it('reads a manifest whose entries for other locales are malformed', () => {
    const m = parseManifest({
      schema: 1,
      generated: '',
      tm: [{ slug: 'de', locale: 'de_DE', sha512: 'short' }],
      rules: [{ ...rulesEntry, slug: 'de', locale: 'de_DE', status: 'retired', minPolyglots: 'soon' }, rulesEntry],
    })
    expect(findRulesEntry(m, 'tr')).toEqual(rulesEntry)
  })

  it('reads the real fixture manifest', async () => {
    const m = parseManifest(JSON.parse(await readFile(fixture('data/index.json'), 'utf8')))
    expect(m.tm[0]).toMatchObject({ locale: 'tr_TR', slug: 'tr', units: 1002 })
    expect(m.generated).toMatch(/^\d{4}-/)
  })

  // The long-text projects carry a kind the tm fetch summary reports.
  it('keeps a project kind and a stale date', async () => {
    const m = parseManifest(JSON.parse(await readFile(fixture('data/index.json'), 'utf8')))
    const tm = findTmEntry(m, 'tr')
    expect(tm.projects).toContainEqual({ path: 'wp-plugins/debug-bar/dev-readme', units: 62, kind: 'long-text' })
    expect(tm.projects).toContainEqual({ path: 'wp-plugins/debug-bar/dev', units: 84, stale: '2026-10-09T03:00:00Z' })
  })

  it('reads a rules entry', () => {
    expect(findRulesEntry(parseManifest({ schema: 1, generated: '', tm: [], rules: [rulesEntry] }), 'tr')).toEqual(rulesEntry)
  })
})

// rules fetch reads only schema, generated and rules[]; a manifest that
// publishes no tm list yet (or one that drops it) must not refuse it.
describe('parseManifest: a list left out', () => {
  it('reads a manifest with no tm list as one listing no memory', () => {
    const m = parseManifest({ schema: 1, generated: '', rules: [rulesEntry] })
    expect(findRulesEntry(m, 'tr')).toEqual(rulesEntry)
    expect(() => findTmEntry(m, 'tr')).toThrow('No polyglots-data entry for tr; the manifest lists none.')
  })

  it('reads a manifest with no rules list as one listing no rules', () => {
    const m = parseManifest({ schema: 1, generated: '', tm: [] })
    expect(() => findRulesEntry(m, 'tr')).toThrow('No polyglots-data entry for tr; the manifest lists none.')
  })
})

describe('findRulesEntry and findTmEntry', () => {
  const manifest = (rules: unknown[], tm: unknown[] = []) => parseManifest({ schema: 1, generated: '', tm, rules })

  it('refuses a malformed requested entry, naming the locale and the field', () => {
    expect(() => findRulesEntry(manifest([{ ...rulesEntry, sha512: 'short' }]), 'tr')).toThrow(DataError)
    expect(() => findRulesEntry(manifest([{ ...rulesEntry, sha512: 'short' }]), 'tr')).toThrow(
      /polyglots-data rules entry for tr is not valid: sha512/,
    )
    expect(() => findTmEntry(manifest([], [{ slug: 'tr', locale: 'tr_TR' }]), 'tr')).toThrow(/tm entry for tr is not valid: url/)
  })

  it('refuses a status this client does not know for the requested entry', () => {
    expect(() => findRulesEntry(manifest([{ ...rulesEntry, status: 'retired' }]), 'tr')).toThrow(/status/)
  })

  it('refuses a minPolyglots that is not a version', () => {
    expect(() => findRulesEntry(manifest([{ ...rulesEntry, minPolyglots: 'soon' }]), 'tr')).toThrow(/minPolyglots/)
  })

  // The contract says semver, so a prerelease is a version, and refusing it
  // as malformed would say "not valid" where "update polyglots" is the truth.
  it('accepts a prerelease minPolyglots', () => {
    expect(findRulesEntry(manifest([{ ...rulesEntry, minPolyglots: '1.1.0-rc.1' }]), 'tr').minPolyglots).toBe('1.1.0-rc.1')
  })

  it('still names the locales that have an entry, skipping rows with no slug', () => {
    expect(() => findRulesEntry(manifest([{ ...rulesEntry, slug: 'de', locale: 'de_DE' }, { locale: 'x' }, 7]), 'tr')).toThrow(
      'No polyglots-data entry for tr. Available: de',
    )
  })

  it('still cross-checks the WP code against the registry', () => {
    expect(() => findRulesEntry(manifest([{ ...rulesEntry, slug: 'az' }]), 'az')).toThrow(/tr_TR.*az/)
  })

  it('reads the tm entry of the real fixture manifest', async () => {
    const m = parseManifest(JSON.parse(await readFile(fixture('data/index.json'), 'utf8')))
    expect(findTmEntry(m, 'tr')).toMatchObject({ locale: 'tr_TR', slug: 'tr', units: 1002 })
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

  // A prerelease sorts below its release, so 1.0.0 satisfies 1.0.0-rc.1 and
  // 1.0.0-rc.1 does not satisfy 1.0.0. NaN here once let every check pass.
  it('places a prerelease below its release', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0)
    expect(compareVersions('1.1.0-rc.1', '1.0.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0)
  })
})

describe('manifestUrl', () => {
  it('is the GitHub latest release unless POLYGLOTS_DATA_URL says otherwise', () => {
    expect(manifestUrl({})).toBe(DEFAULT_MANIFEST_URL)
    expect(manifestUrl({ POLYGLOTS_DATA_URL: '' })).toBe(DEFAULT_MANIFEST_URL)
    expect(manifestUrl({ POLYGLOTS_DATA_URL: 'http://127.0.0.1:9/index.json' })).toBe('http://127.0.0.1:9/index.json')
  })
})
