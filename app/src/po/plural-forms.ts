import tannin from '@tannin/plural-forms'

// The package's types describe its ES build, where the function is the default
// export. Node loads its CommonJS build, where module.exports is the function
// itself, so at run time the default import is the function while the types
// say it is a module holding one. Taking either shape keeps this working
// whichever build a runner resolves.
const pluralForms = ((tannin as { default?: unknown }).default ?? tannin) as (expression: string) => (n: number) => number

// The numbers gettext samples to learn how a formula spreads over its forms
// (msgl-check.c, check_plural_eval). For each of the formulas GlotPress ships,
// a form seen once in this range is not seen again up to two million.
const SAMPLE_UP_TO = 1000

/** How a catalogue's plural formula spreads the numbers over its forms. */
export interface PluralDistribution {
  /**
   * The forms the formula uses for exactly one number.
   *
   * Such a form may say its number in words: Arabic writes "عنصر واحد" for one
   * item and "عنصران" for two, where English needs %d. The GNU gettext manual
   * allows it for a form that "applies only to n == 1", and msgfmt checks those
   * forms leniently. A form that also serves 21 and 31, as Russian msgstr[0]
   * does, cannot drop the number, though its English counterpart says "one".
   *
   * msgfmt is laxer than this: it treats a form seen fewer than five times in
   * 0..1000 as rare. Irish msgstr[2] serves 3 to 6, which no word can spell, so
   * only a form for a single number counts here.
   */
  singleNumber: ReadonlySet<number>
  /**
   * The forms the formula uses for no number above one: 0, 1, or both.
   *
   * Turkish and French send 0 to the form for one, so it is not a form for a
   * single number, and holding it to msgid_plural made "Bir yorum" for "One
   * comment" an error. translate.wordpress.org compares that form with the
   * singular and accepts it, msgfmt checks it leniently as a form seen twice,
   * and code that can pass 0 guards it with its own string ("No comments").
   * Nothing a form for 0 and 1 says is a count no word can spell, which is what
   * keeps Irish 3 to 6 out of singleNumber.
   */
  upToOne: ReadonlySet<number>
  // The form the formula uses for 1. translate.wordpress.org compares this one
  // with the singular and every other form with the plural.
  formForOne: number
}

/**
 * Reads the Plural-Forms header's formula.
 *
 * The formula is evaluated by @tannin/plural-forms, the evaluator WordPress's
 * own JavaScript i18n runs on these headers. A hand-written parser was the
 * alternative and the riskier one: the formulas nest ternaries and mix && and
 * || without parentheses. It does not validate syntax: what it cannot make
 * sense of comes out as NaN and is refused below, and a malformed formula it
 * does read is taken as WordPress would take it.
 *
 * Undefined when the header has no formula, or one that cannot be evaluated or
 * names a form the header does not declare. The caller then has nothing to go
 * on and keeps reading msgstr[0] as the singular.
 */
export function pluralDistribution(header: string | undefined, nplurals: number): PluralDistribution | undefined {
  const expression = /plural\s*=\s*([^;]+)/.exec(header ?? '')?.[1]?.trim()
  if (!expression) return undefined
  const counts: number[] = Array.from({ length: nplurals }, () => 0)
  const largest: number[] = Array.from({ length: nplurals }, () => -1)
  let formForOne = 0
  try {
    const formFor = pluralForms(expression)
    for (let n = 0; n <= SAMPLE_UP_TO; n++) {
      const form = formFor(n)
      if (!Number.isInteger(form) || form < 0 || form >= nplurals) return undefined
      counts[form]!++
      largest[form] = n
      if (n === 1) formForOne = form
    }
  } catch {
    return undefined
  }
  return {
    singleNumber: new Set(counts.flatMap((count, form) => (count === 1 ? [form] : []))),
    upToOne: new Set(largest.flatMap((n, form) => (n >= 0 && n <= 1 ? [form] : []))),
    formForOne,
  }
}
