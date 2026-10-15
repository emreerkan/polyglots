import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  exportUrl,
  localePageUrl,
  parseProjectLines,
  projectFileName,
  readSubProjects,
} from '../../src/wporg/projects.js'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '..', 'fixtures', 'wporg', name), 'utf8')

describe('parseProjectLines', () => {
  it('reads a bare slug as a project of unknown type', () => {
    expect(parseProjectLines('koji')).toEqual([{ slug: 'koji' }])
  })

  // The two shapes a browser shows when you are looking at a project.
  it('reads a locale page URL', () => {
    expect(parseProjectLines('https://translate.wordpress.org/locale/tr/default/wp-themes/koji/')).toEqual([
      { type: 'wp-themes', slug: 'koji' },
    ])
  })

  it('reads a project URL, branch included', () => {
    expect(
      parseProjectLines('https://translate.wordpress.org/projects/wp-plugins/contact-form-7/dev/tr/default/'),
    ).toEqual([{ type: 'wp-plugins', slug: 'contact-form-7', branch: 'dev' }])
  })

  it('keeps a readme branch when a URL names one', () => {
    expect(
      parseProjectLines('https://translate.wordpress.org/projects/wp-plugins/contact-form-7/dev-readme/tr/default/'),
    ).toEqual([{ type: 'wp-plugins', slug: 'contact-form-7', branch: 'dev-readme' }])
  })

  // The short form the tables print, and the one #33's own example used: it
  // was read as a slug with a slash in it and reported as not found.
  it('reads the short type/slug[/branch] form', () => {
    expect(
      parseProjectLines(['wp-plugins/Stocktake-For-WooCommerce', 'wp-plugins/acme/stable-readme', 'wp-themes/koji'].join('\n')),
    ).toEqual([
      { type: 'wp-plugins', slug: 'stocktake-for-woocommerce' },
      { type: 'wp-plugins', slug: 'acme', branch: 'stable-readme' },
      { type: 'wp-themes', slug: 'koji' },
    ])
  })

  // A theme has no branch, and an unknown type is no project shape at all:
  // both are kept whole, so they are reported as not found, not dropped.
  it('keeps a short form it cannot read as a slug of itself', () => {
    expect(parseProjectLines('wp-themes/koji/dev\nmeta/forums')).toEqual([{ slug: 'wp-themes/koji/dev' }, { slug: 'meta/forums' }])
  })

  // Pasted lists arrive with whatever line endings and padding the source had.
  it('reads a list pasted with CRLF, tabs and trailing spaces like a clean one', () => {
    expect(parseProjectLines('koji\r\n\tsydney  \r\n  \r\nloose\t')).toEqual([
      { slug: 'koji' },
      { slug: 'sydney' },
      { slug: 'loose' },
    ])
  })

  it('reads a URL with a query string, a fragment, or no trailing slash', () => {
    expect(
      parseProjectLines(
        [
          'https://translate.wordpress.org/projects/wp-themes/koji/tr/default/?filters%5Bstatus%5D=waiting',
          'https://translate.wordpress.org/locale/tr/default/wp-themes/sydney#top',
          'https://translate.wordpress.org/locale/tr/default/wp-themes/loose',
        ].join('\n'),
      ),
    ).toEqual([
      { type: 'wp-themes', slug: 'koji' },
      { type: 'wp-themes', slug: 'sydney' },
      { type: 'wp-themes', slug: 'loose' },
    ])
  })

  // wp.org slugs are lowercase, so a capital is a typing accident.
  it('lowercases a slug typed with capitals', () => {
    expect(parseProjectLines('GeneratePress')).toEqual([{ slug: 'generatepress' }])
  })

  it('drops blank lines and duplicates', () => {
    expect(parseProjectLines('koji\n\nkoji\nKOJI\n')).toEqual([{ slug: 'koji' }])
  })

  // A list copied from another locale's pages must not quietly change the
  // run's locale, so the locale in a URL carries nothing.
  it('takes nothing from the locale in a URL', () => {
    expect(parseProjectLines('https://translate.wordpress.org/locale/de/default/wp-themes/koji/')).toEqual([
      { type: 'wp-themes', slug: 'koji' },
    ])
  })
})

describe('readSubProjects', () => {
  it('reads every sub-project of a plugin, with its branch and counts', () => {
    const rows = readSubProjects(fixture('plugin-page.html'), 'wp-plugins')
    expect(rows.map((r) => r.branch).sort()).toEqual(['dev', 'dev-readme', 'stable', 'stable-readme'])
    expect(rows.find((r) => r.branch === 'stable')).toEqual({ branch: 'stable', untranslated: 0, waiting: 0 })
  })

  it('reads a theme as one row with no branch', () => {
    expect(readSubProjects(fixture('theme-page.html'), 'wp-themes')).toEqual([
      { branch: undefined, untranslated: 3, waiting: 111 },
    ])
  })

  // Large projects print their counts with a thousands separator.
  it('reads a count printed with a thousands separator', () => {
    const html = `<table><tr><td class="set-name"><a href="/projects/wp-plugins/big/dev/tr/default/">Dev</a></td>
      <td class="stats untranslated"><a>1,204</a></td><td class="stats waiting"><a>14,530</a></td></tr></table>`
    expect(readSubProjects(html, 'wp-plugins')).toEqual([{ branch: 'dev', untranslated: 1204, waiting: 14530 }])
  })

  it('finds nothing in a page without the table', () => {
    expect(readSubProjects('<html><body>Not found</body></html>', 'wp-themes')).toEqual([])
  })
})

describe('URLs and names', () => {
  it('builds the locale page a project is checked against', () => {
    expect(localePageUrl('wp-themes', 'koji', 'tr')).toBe(
      'https://translate.wordpress.org/locale/tr/default/wp-themes/koji/',
    )
  })

  it('builds an export URL for a theme and for a plugin branch', () => {
    expect(exportUrl('wp-themes', 'koji', undefined, 'tr', 'waiting')).toBe(
      'https://translate.wordpress.org/projects/wp-themes/koji/tr/default/export-translations/?filters%5Bstatus%5D=waiting&format=po',
    )
    expect(exportUrl('wp-plugins', 'contact-form-7', 'dev', 'tr', 'untranslated')).toBe(
      'https://translate.wordpress.org/projects/wp-plugins/contact-form-7/dev/tr/default/export-translations/?filters%5Bstatus%5D=untranslated&format=po',
    )
  })

  // The name the requester-message link is read back from.
  it('names the file the way the requester link reads it back', () => {
    expect(projectFileName('wp-themes', 'koji', undefined, 'tr')).toBe('wp-themes-koji-tr.po')
    expect(projectFileName('wp-plugins', 'contact-form-7', 'dev', 'tr')).toBe('wp-plugins-contact-form-7-dev-tr.po')
  })
})
