import { describe, expect, it } from 'vitest'
import { glossaryUrl } from '../../src/wporg/glossary.js'
import { exportUrl, localePageUrl, projectFileName, readSubProjects } from '../../src/wporg/projects.js'
import { buildConsistencyUrl } from '../../src/wporg/consistency-scraper.js'
import { translationsUrl } from '../../src/review/message.js'

// nl/formal is the set "formal" of the locale "nl": every wp.org path has to
// carry it where it used to write /default/.
describe('translation sets in wp.org URLs', () => {
  it('reads the glossary of the set', () => {
    expect(glossaryUrl('tr')).toBe('https://translate.wordpress.org/locale/tr/default/glossary/')
    expect(glossaryUrl('nl/formal')).toBe('https://translate.wordpress.org/locale/nl/formal/glossary/')
  })

  it('checks consistency within the set', () => {
    expect(buildConsistencyUrl('Settings', 'nl/formal')).toContain('set=nl%2Fformal')
    expect(buildConsistencyUrl('Settings', 'tr')).toContain('set=tr%2Fdefault')
  })

  it('looks a project up and exports it in the set', () => {
    expect(localePageUrl('wp-themes', 'koji', 'nl/formal')).toBe('https://translate.wordpress.org/locale/nl/formal/wp-themes/koji/')
    expect(exportUrl('wp-plugins', 'acme', 'dev', 'pt/ao90', 'waiting')).toBe(
      'https://translate.wordpress.org/projects/wp-plugins/acme/dev/pt/ao90/export-translations/?filters%5Bstatus%5D=waiting&format=po',
    )
  })

  it('reads a plugin branch from a sub-project link in a set', () => {
    const html = `<table><tr><td class="set-name"><a href="/projects/wp-plugins/acme/stable/nl/formal/">Stable</a></td>
      <td class="stats untranslated">2</td><td class="stats waiting">7</td></tr></table>`
    expect(readSubProjects(html, 'wp-plugins')).toEqual([{ branch: 'stable', untranslated: 2, waiting: 7 }])
  })

  it('names the file without a slash, and reads the set back for the requester link', () => {
    const file = projectFileName('wp-themes', 'koji', undefined, 'nl/formal')
    expect(file).toBe('wp-themes-koji-nl-formal.po')
    expect(translationsUrl(`/x/${file.replace('.po', '-repaired.po')}`, 'nl/formal', 'emre')).toMatch(
      /^https:\/\/translate\.wordpress\.org\/projects\/wp-themes\/koji\/nl\/formal\/\?/,
    )
    expect(translationsUrl('/x/wp-themes-koji-tr.po', 'tr', 'emre')).toMatch(/\/wp-themes\/koji\/tr\/default\/\?/)
  })
})

describe('translation sets in a memory import', () => {
  // A TMX says nl-NL; the run is nl/formal. The set is not in the file, so the
  // language decides, as it does for nl.
  it('matches a TMX language tag against a locale with a set', async () => {
    const { localeMatches } = await import('../../src/tmx/parse.js')
    expect(localeMatches('nl/formal', 'nl-nl')).toBe(true)
    expect(localeMatches('nl/formal', 'nl')).toBe(true)
    expect(localeMatches('nl/formal', 'de-de')).toBe(false)
  })
})
