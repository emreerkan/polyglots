import type { Finding, Locale } from '../types.js'
import { intlTag } from '../wporg/locales.js'
import { CUSTOM_RULE } from './names.js'
import type { CustomPattern } from './schema.js'

interface Text {
  msgid: string
  msgstr: string[]
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Every code point whose canonical decomposition is a given string, built on
// first use. NFC does not give these back: ड़ (U+095C), য় (U+09DF) and ਸ਼
// (U+0A36) are composition exclusions, so NFC decomposes them and a literal
// normalised either way never contains them. One scan of the code points that
// can decompose at all, nothing above U+2FA1D does, costs tens of
// milliseconds once per process, and only a pattern with a mark in it asks.
let precomposed: Map<string, string[]> | undefined

function precomposedOf(decomposed: string): readonly string[] {
  if (!precomposed) {
    precomposed = new Map()
    for (let cp = 0; cp <= 0x2fa1f; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const ch = String.fromCodePoint(cp)
      const nfd = ch.normalize('NFD')
      if (nfd === ch) continue
      const list = precomposed.get(nfd)
      if (list) list.push(ch)
      else precomposed.set(nfd, [ch])
    }
  }
  return precomposed.get(decomposed) ?? []
}

// Each way the text can spell one letter and its marks: composed, decomposed,
// and with a precomposed code point NFC would not produce. The precomposed
// one may cover only the first marks: in कड़ी the nukta and the vowel sign
// follow one base, and U+095C takes the base and the nukta, not the vowel.
function spellings(cluster: string): string[] {
  const nfd = [...cluster.normalize('NFD')]
  const forms = new Set([cluster.normalize('NFC'), nfd.join('')])
  for (let end = 2; end <= nfd.length; end++) {
    const rest = nfd.slice(end).join('')
    for (const ch of precomposedOf(nfd.slice(0, end).join(''))) forms.add(ch + rest)
  }
  return [...forms]
}

// Keyed by locale and text. Every entry asks again for every pattern, and the
// casing and encodings of each letter are the same answer each time; the
// RegExp itself is still made fresh per call, for the reason regexOf gives.
const literalSources = new Map<string, string>()

/**
 * A case-insensitive regex for a literal, built from the locale's own casing,
 * that finds the literal in whichever encoding the translation carries.
 *
 * JavaScript's `i` flag pairs i with I, which is wrong for Turkish, where i
 * pairs with İ and ı with I. Each letter becomes a class of its locale
 * upper and lower forms instead, so "içerik" finds "İçerik" and not "ICERIK".
 *
 * A letter is a base character with the marks that follow it, and the class
 * holds each of its encodings too, so a pattern written with the precomposed
 * ड़ finds ड plus a nukta, and the reverse (#25). The translation itself is
 * matched as typed rather than normalised first, which keeps every match at
 * its real offset: a fix replaces exactly what it matched and leaves the rest
 * of the string, encoding included, as the contributor wrote it.
 */
function literalRegex(text: string, locale: Locale): RegExp {
  const key = `${locale}\u0000${text}`
  let body = literalSources.get(key)
  if (body === undefined) {
    body = literalSource(text, locale)
    literalSources.set(key, body)
  }
  return new RegExp(body, 'gu')
}

function literalSource(text: string, locale: Locale): string {
  const tag = intlTag(locale)
  return (text.normalize('NFC').match(/\P{M}\p{M}*|\p{M}+/gu) ?? [])
    .map((letter) => {
      const forms = new Set(
        [letter, letter.toLocaleLowerCase(tag), letter.toLocaleUpperCase(tag)].flatMap(spellings),
      )
      if (forms.size === 1) return escapeRegExp(letter)
      return `(?:${[...forms].map(escapeRegExp).join('|')})`
    })
    .join('')
}

// A fresh RegExp per call: a shared one with the g flag keeps lastIndex
// between entries and would skip the next entry's match.
function regexOf(p: CustomPattern, locale: Locale): RegExp {
  return p.text !== undefined ? literalRegex(p.text, locale) : new RegExp(p.find!, `gu${p.ignoreCase ? 'i' : ''}`)
}

const applies = (p: CustomPattern, source: string, locale: Locale) =>
  p.whenSource === undefined || source.toLocaleLowerCase(intlTag(locale)).includes(p.whenSource.toLocaleLowerCase(intlTag(locale)))

const translated = (form: string) => form.trim() !== ''

function message(p: CustomPattern, matched: string): string {
  if (p.kind === 'mistake') {
    return `"${p.text}"${p.right === undefined ? '' : ` -> "${p.right}"`}${p.note ? ` (${p.note})` : ''}`
  }
  return p.note ?? `matches "${matched}"`
}

/**
 * A regular expression's match on normalised text, for a finding.
 *
 * A literal already finds every encoding, but a regular expression cannot be
 * expanded letter by letter without parsing it, so for a finding both the
 * pattern and the translation are put in NFC and compared again. A finding
 * needs no position in the original, which is why this is enough here and
 * not for a fix: a fix written as a regular expression matches the
 * translation as typed, and the documentation says so. Tried after the raw
 * match, not instead of it, so a pattern that names a code point with an
 * escape such as \u095C still finds it where the contributor typed it.
 */
function normalisedMatch(p: CustomPattern, form: string, locale: Locale): RegExpExecArray | null {
  if (p.find === undefined) return null
  return new RegExp(p.find.normalize('NFC'), `gu${p.ignoreCase ? 'i' : ''}`).exec(form.normalize('NFC'))
}

/**
 * Findings for the hint and error patterns of a locale's rules file.
 *
 * A hint is a suspect: it reaches the model as an automated check with the
 * person's note, and the model decides in context. An error is proof, so the
 * entry is condemned through the ordinary path. Fix patterns are not reported
 * here; the repair step has already applied them.
 */
export function customFindings(entry: Text, patterns: readonly CustomPattern[], locale: Locale): Finding[] {
  const findings: Finding[] = []
  for (const p of patterns) {
    if (p.level === 'fix' || !applies(p, entry.msgid, locale)) continue
    for (const form of entry.msgstr.filter(translated)) {
      const match = regexOf(p, locale).exec(form) ?? normalisedMatch(p, form, locale)
      if (match) {
        findings.push({ rule: CUSTOM_RULE, severity: p.level === 'error' ? 'error' : 'suspect', message: message(p, match[0]) })
        break
      }
    }
  }
  return findings
}

function capitaliseLike(matched: string, replacement: string, locale: Locale): string {
  const first = [...matched][0]
  if (!first || first === first.toLocaleLowerCase(intlTag(locale))) return replacement
  const [head = '', ...rest] = [...replacement]
  return head.toLocaleUpperCase(intlTag(locale)) + rest.join('')
}

/**
 * The fix patterns applied to every translated form, with the notes of the
 * ones that changed something; undefined when none did.
 *
 * A literal replacement keeps the capital of what it replaced, so "Önizleme"
 * becomes "Ön izleme" at the start of a label. A replacement that would leave
 * a form empty is not applied: that destroys a translation rather than
 * repairing it.
 */
export function applyFixPatterns(
  entry: Text,
  patterns: readonly CustomPattern[],
  locale: Locale,
): { forms: string[]; notes: string[] } | undefined {
  let forms = entry.msgstr
  const notes: string[] = []
  for (const p of patterns) {
    if (p.level !== 'fix' || p.replace === undefined || !applies(p, entry.msgid, locale)) continue
    let changed = false
    forms = forms.map((form) => {
      if (!translated(form)) return form
      const next =
        p.text !== undefined
          ? form.replace(regexOf(p, locale), (m) => capitaliseLike(m, p.replace!, locale))
          : form.replace(regexOf(p, locale), p.replace!)
      if (next === form || !translated(next)) return form
      changed = true
      return next
    })
    if (changed) notes.push(p.note ?? `replaced ${p.text ?? p.find} with "${p.replace}"`)
  }
  return notes.length > 0 ? { forms, notes } : undefined
}
