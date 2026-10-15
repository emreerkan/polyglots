import * as cheerio from 'cheerio'
import { localeFileTag, splitLocale } from './locales.js'
import type { Locale } from '../types.js'

const ORIGIN = 'https://translate.wordpress.org'

export type ProjectType = 'wp-themes' | 'wp-plugins'

// Which strings to fetch. It also decides the action: untranslated strings are
// translated and waiting ones reviewed, so a run can never translate over the
// submissions other contributors are waiting on.
export type FetchStatus = 'waiting' | 'untranslated'

/**
 * A project as a line of input named it.
 *
 * `type` is absent for a bare slug, which is resolved by asking wp.org. `branch`
 * is a plugin's sub-project (`dev`, `stable`, `dev-readme`, `stable-readme`) and
 * is only present when a URL named one; a theme has none.
 */
export interface ProjectRef {
  type?: ProjectType
  slug: string
  branch?: string
}

// /locale/<locale>/default/<type>/<slug>/ and /projects/<type>/<slug>[/<branch>]/<locale>/default/
const LOCALE_URL = /\/locale\/[^/]+\/[^/]+\/(wp-themes|wp-plugins)\/([^/?#]+)/
const PROJECT_URL = /\/projects\/(wp-themes|wp-plugins)\/([^/?#]+)(?:\/([^/?#]+))?\/[^/?#]+\/[^/?#]+/
// wp-plugins/<slug>[/<branch>] and wp-themes/<slug>: the form the fetch tables
// print for a line, so a row can be pasted back, and the one people write.
const SHORT = /^(?:wp-plugins\/([^/\s]+)(?:\/([^/\s]+))?|wp-themes\/([^/\s]+))\/?$/i

function parseLine(line: string): ProjectRef | undefined {
  const text = line.trim()
  if (text === '') return undefined
  if (!/^https?:\/\//i.test(text)) {
    const short = SHORT.exec(text)
    if (short?.[3]) return { type: 'wp-themes', slug: short[3].toLowerCase() }
    if (short?.[1]) {
      const slug = short[1].toLowerCase()
      return short[2] ? { type: 'wp-plugins', slug, branch: short[2].toLowerCase() } : { type: 'wp-plugins', slug }
    }
    return { slug: text.toLowerCase() }
  }

  const local = LOCALE_URL.exec(text)
  if (local) return { type: local[1] as ProjectType, slug: local[2]!.toLowerCase() }

  // A theme's project URL is /projects/wp-themes/<slug>/<locale>/default/, so
  // the segment after the slug is a locale, not a branch. Only a plugin has one.
  const project = PROJECT_URL.exec(text)
  if (project) {
    const type = project[1] as ProjectType
    const slug = project[2]!.toLowerCase()
    return type === 'wp-plugins' && project[3] ? { type, slug, branch: project[3].toLowerCase() } : { type, slug }
  }
  // A URL that names no project is kept as a slug of itself, so it is reported
  // as not found rather than dropped without a word.
  return { slug: text }
}

/**
 * One project per non-blank line, duplicates dropped.
 *
 * Accepts the two URL shapes a browser shows for a project, the short
 * type/slug[/branch] form, and bare slugs.
 * The locale in a URL is ignored: a list pasted from another locale's pages
 * should not quietly produce a run in that locale.
 */
export function parseProjectLines(text: string): ProjectRef[] {
  const seen = new Set<string>()
  const refs: ProjectRef[] = []
  for (const line of text.split(/\r?\n/)) {
    const ref = parseLine(line)
    if (!ref) continue
    const key = `${ref.type ?? ''}\u0000${ref.slug}\u0000${ref.branch ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}

export interface SubProject {
  // undefined for a theme, which has a single sub-project.
  branch: string | undefined
  untranslated: number
  waiting: number
}

const count = (text: string): number => Number.parseInt(text.replace(/[^\d]/g, ''), 10) || 0

/**
 * The sub-project table of a locale project page, one row per sub-project.
 *
 * The branch is read from each row's link rather than from its label, since the
 * link is the path the export is built from and the label is display text.
 */
export function readSubProjects(html: string, type: ProjectType): SubProject[] {
  const $ = cheerio.load(html)
  const rows: SubProject[] = []
  $('tr').each((_, tr) => {
    const href = $(tr).find('td.set-name a').attr('href')
    if (!href) return
    // /projects/<type>/<slug>[/<branch>]/<locale>/<set>/: a plugin has a branch
    // segment and a theme does not, and the set is whatever the run is in.
    const path = new RegExp(
      type === 'wp-plugins' ? '/projects/wp-plugins/[^/]+/([^/]+)/[^/]+/[^/]+/' : '/projects/wp-themes/[^/]+/[^/]+/[^/]+/',
    ).exec(href)
    if (!path) return
    rows.push({
      branch: type === 'wp-plugins' ? path[1] : undefined,
      untranslated: count($(tr).find('td.stats.untranslated').text()),
      waiting: count($(tr).find('td.stats.waiting').text()),
    })
  })
  return rows
}

export function localePageUrl(type: ProjectType, slug: string, locale: Locale): string {
  const { slug: localeSlug, set } = splitLocale(locale)
  return `${ORIGIN}/locale/${localeSlug}/${set}/${type}/${slug}/`
}

export function exportUrl(
  type: ProjectType,
  slug: string,
  branch: string | undefined,
  locale: Locale,
  status: FetchStatus,
): string {
  const path = branch ? `${type}/${slug}/${branch}` : `${type}/${slug}`
  const { slug: localeSlug, set } = splitLocale(locale)
  return `${ORIGIN}/projects/${path}/${localeSlug}/${set}/export-translations/?filters%5Bstatus%5D=${status}&format=po`
}

// The shape `translationsUrl` reads a project back out of, so a fetched file's
// requester message links to the right page without anyone renaming it.
export function projectFileName(type: ProjectType, slug: string, branch: string | undefined, locale: Locale): string {
  const tag = localeFileTag(locale)
  return branch ? `${type}-${slug}-${branch}-${tag}.po` : `${type}-${slug}-${tag}.po`
}
