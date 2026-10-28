import { describe, expect, it } from 'vitest'
import { pluralDistribution } from '../../src/po/plural-forms.js'

// The Plural-Forms headers translate.wordpress.org writes for these locales.
const ARABIC =
  'nplurals=6; plural=(n == 0) ? 0 : ((n == 1) ? 1 : ((n == 2) ? 2 : ((n % 100 >= 3 && n % 100 <= 10) ? 3 : ((n % 100 >= 11 && n % 100 <= 99) ? 4 : 5))));'
const RUSSIAN =
  'nplurals=3; plural=(n % 10 == 1 && n % 100 != 11) ? 0 : ((n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) ? 1 : 2);'
const IRISH = 'nplurals=5; plural=(n == 1) ? 0 : ((n == 2) ? 1 : ((n >= 3 && n <= 6) ? 2 : ((n >= 7 && n <= 10) ? 3 : 4)));'

describe('pluralDistribution', () => {
  const single = (header: string, nplurals: number) => [...pluralDistribution(header, nplurals)!.singleNumber]

  it('names the forms the formula gives exactly one number', () => {
    expect(single(ARABIC, 6)).toEqual([0, 1, 2])
    expect(single('nplurals=2; plural=n != 1;', 2)).toEqual([0])
  })

  it('leaves out a form that also serves 21, 31 and the rest', () => {
    expect(single(RUSSIAN, 3)).toEqual([])
  })

  it('leaves out a form that serves both 0 and 1', () => {
    expect(single('nplurals=2; plural=n > 1;', 2)).toEqual([])
  })

  it('leaves out the one form of a language with no plural', () => {
    expect(single('nplurals=1; plural=0;', 1)).toEqual([])
  })

  // Irish forms 2 and 3 serve four numbers each: a translator cannot spell
  // those out, so only the forms for one and two may drop the number.
  it('counts a form serving a handful of numbers as serving many', () => {
    expect(single(IRISH, 5)).toEqual([0, 1])
  })

  // Turkish and French send 0 to the form for one. Nothing there says a count
  // a word cannot, and code that can pass 0 guards it with its own string.
  it('names the forms that serve no number above one', () => {
    const upToOne = (header: string, nplurals: number) => [...pluralDistribution(header, nplurals)!.upToOne]
    expect(upToOne('nplurals=2; plural=n > 1;', 2)).toEqual([0])
    expect(upToOne('nplurals=2; plural=n != 1;', 2)).toEqual([0])
    expect(upToOne(ARABIC, 6)).toEqual([0, 1])
    expect(upToOne(RUSSIAN, 3)).toEqual([])
    expect(upToOne('nplurals=1; plural=0;', 1)).toEqual([])
  })

  // translate.wordpress.org compares this form with the singular.
  it('names the form that serves 1', () => {
    expect(pluralDistribution(ARABIC, 6)!.formForOne).toBe(1)
    expect(pluralDistribution(RUSSIAN, 3)!.formForOne).toBe(0)
    expect(pluralDistribution('nplurals=2; plural=n > 1;', 2)!.formForOne).toBe(0)
  })

  it('is undefined when there is no formula to read', () => {
    expect(pluralDistribution(undefined, 2)).toBeUndefined()
    expect(pluralDistribution('nplurals=2;', 2)).toBeUndefined()
  })

  it('is undefined when the formula cannot be evaluated', () => {
    expect(pluralDistribution('nplurals=2; plural=n +* 2;', 2)).toBeUndefined()
    expect(pluralDistribution('nplurals=2; plural=one(n);', 2)).toBeUndefined()
  })

  it('is undefined when the formula names a form the header does not have', () => {
    expect(pluralDistribution('nplurals=2; plural=n;', 2)).toBeUndefined()
  })
})
