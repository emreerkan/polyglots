import { PRINTF_PLACEHOLDER } from '../../draft/placeholders.js'

// The order a locale writes a person's given name and family name in. English
// puts the given name first, and so a string such as woocommerce's
// "%1$s %2$s" (context "full name", translators: 1: first name 2: last name)
// is copied as it stands into locales that put the family name first:
// Japanese, Hungarian, Chinese, Korean, Vietnamese. Raised on make/polyglots
// on 30 September 2026, where core's own profile screen has the same problem
// in its field order. A translation can fix its strings on its own, and this
// checks that it did.
//
// Only a translator comment says which argument is which name, so without one
// this says nothing. Guessing from "%1$s %2$s" alone would send contributors a
// warning about strings that are not names at all, and a wrong warning costs
// the reviewer the time the rule was meant to save.
//
// The schema imports the type only: the website's rules builder bundles the
// schema for the browser and has no use for the check.

// CLDR's terms for the same two (personNames, nameOrderLocales): given-first
// is givenFirst, family-first is surnameFirst. polyglots-data takes a locale's
// value from there.
export type NameOrder = 'given-first' | 'family-first'

/** A locale's names, from the names section of its rules file. */
export interface NameRules {
  order: NameOrder
}

const GIVEN = /\b(?:first[ _-]?name|given[ _-]?name|forename)\b/i
const FAMILY = /\b(?:last[ _-]?name|family[ _-]?name|surname)\b/i
// Where a comment starts describing one argument: "1:", "%1$s:", "2 =".
const ARGUMENT = /(?:^|[\s,;(])%?(\d+)(?:\$[a-z])?\s*[:=]/gi

/**
 * Which argument is the given name and which the family name, when a
 * translator comment names both, each once. "1: author first name (bold),
 * 2: freelance studio name" names one, so it says nothing; neither does an
 * argument described as both, or a role given to two arguments.
 */
export function nameRoles(comments: readonly string[]): { given: number; family: number } | undefined {
  const text = comments.join(' ')
  const starts = [...text.matchAll(ARGUMENT)]
  const given: number[] = []
  const family: number[] = []
  starts.forEach((m, i) => {
    const description = text.slice(m.index + m[0].length, starts[i + 1]?.index ?? text.length)
    // "1: First, 2: Last" names them with the word alone, but only a word
    // that is the whole description: "1: last login date" is no family name.
    const bare = description.replace(/[().,;!]/g, '').trim().toLowerCase()
    const isGiven = GIVEN.test(description) || bare === 'first' || bare === 'given'
    const isFamily = FAMILY.test(description) || bare === 'last' || bare === 'family'
    if (isGiven === isFamily) return
    ;(isGiven ? given : family).push(Number(m[1]))
  })
  if (given.length !== 1 || family.length !== 1 || given[0] === family[0]) return undefined
  return { given: given[0]!, family: family[0]! }
}

interface Placed {
  argument: number
  start: number
  end: number
  // The conversion after the argument number: "s" in %1$s and in %s.
  conversion: string
}

// Each printf placeholder with the argument sprintf gives it. A text whose
// placeholders are all unnumbered takes them in turn; one that mixes the two
// forms is not something to work out, and says nothing.
function placed(text: string): Placed[] | undefined {
  const found = [...text.replaceAll('%%', '\0\0').matchAll(new RegExp(PRINTF_PLACEHOLDER, 'g'))]
  const numbered = found.map((m) => /^%(\d+)\$/.exec(m[0]))
  if (numbered.some(Boolean) && !numbered.every(Boolean)) return undefined
  return found.map((m, k) => ({
    argument: numbered[k] ? Number(numbered[k]![1]) : k + 1,
    start: m.index,
    end: m.index + m[0].length,
    conversion: m[0].replace(/^%(\d+\$)?/, ''),
  }))
}

// Core's display name choices carry no numbered comment, but their context
// names the two in the order of the arguments: "Display name based on first
// name and last name" for "%1$s %2$s". Read only for a source with exactly two
// placeholders, which is the only case where the order of mention can be the
// order of the arguments.
function contextRoles(msgctxt: string | undefined, from: Placed[]): { given: number; family: number } | undefined {
  if (msgctxt === undefined || from.length !== 2) return undefined
  const given = GIVEN.exec(msgctxt)?.index
  const family = FAMILY.exec(msgctxt)?.index
  if (given === undefined || family === undefined) return undefined
  const [a, b] = from.map((p) => p.argument) as [number, number]
  return given < family ? { given: a, family: b } : { given: b, family: a }
}

/**
 * What to write instead, when a locale that writes the family name first
 * keeps a full name in English order: the two names side by side in the
 * source, given name first, and still so in the translation.
 *
 * A given-first locale is never told anything. English already writes the
 * names its way, so a translation that swapped them did it on purpose. A
 * source that puts the family name first is deliberate too, in any locale:
 * "%2$s, %1$s" is the order of a list sorted by family name. And only side by
 * side, because a sentence that names each in its own place follows the
 * language's grammar, not the order of a name.
 */
export function nameOrderProblem(
  source: { msgid: string; msgctxt?: string; comments: readonly string[] },
  translation: string,
  order: NameOrder,
  language: string,
): string | undefined {
  if (order !== 'family-first') return undefined
  const from = placed(source.msgid)
  if (!from) return undefined
  const roles = nameRoles(source.comments) ?? contextRoles(source.msgctxt, from)
  if (!roles) return undefined
  const given = from.find((p) => p.argument === roles.given)
  const family = from.find((p) => p.argument === roles.family)
  if (!given || !family || given.start > family.start) return undefined
  // \s covers the no-break space as well.
  if (!/^\s+$/.test(source.msgid.slice(given.end, family.start))) return undefined

  const to = placed(translation)
  const givenAt = to?.find((p) => p.argument === roles.given)?.start
  const familyAt = to?.find((p) => p.argument === roles.family)?.start
  if (givenAt === undefined || familyAt === undefined) return undefined
  if (familyAt < givenAt) return undefined

  const spell = (p: Placed) => `%${p.argument}$${p.conversion}`
  return `${language} writes the family name first: "${spell(family)} ${spell(given)}"`
}

/** The names section as a prompt line, for a locale that writes the family name first. */
export function nameOrderInstruction(rules: NameRules | undefined, language: string): string {
  if (rules?.order !== 'family-first') return ''
  return `- Names: ${language} writes a person's family name before the given name. Where a string puts the two side by side, such as "%1$s %2$s" with a translator comment saying 1 is the first name and 2 the last, write the family name first: "%2$s %1$s". A sentence that names them apart follows its own grammar instead.\n`
}
