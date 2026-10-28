import { describe, expect, it } from 'vitest'
import { nameOrderProblem, nameRoles } from '../../src/audit/rules/name-order.js'

// WooCommerce's, as it reaches translate.wordpress.org.
const WOO = ['translators: 1: first name 2: last name']

describe('nameRoles', () => {
  it('reads which argument is the given name and which the family name', () => {
    expect(nameRoles(WOO)).toEqual({ given: 1, family: 2 })
    expect(nameRoles(['translators: %1$s: Last name, %2$s: First name'])).toEqual({ given: 2, family: 1 })
    expect(nameRoles(['translators: 1: customer given name, 2: customer surname'])).toEqual({ given: 1, family: 2 })
    expect(nameRoles(['translators: 1: family name; 2: forename'])).toEqual({ given: 2, family: 1 })
    expect(nameRoles(['translators: 1: First, 2: Last.'])).toEqual({ given: 1, family: 2 })
  })

  it('takes a bare role word only when it is the whole description', () => {
    expect(nameRoles(['translators: 1: first item, 2: last login date'])).toBeUndefined()
  })

  it('says nothing unless both roles are named, each once', () => {
    expect(nameRoles(['translators: 1: author first name (bold), 2: freelance studio name (linked).'])).toBeUndefined()
    expect(nameRoles(['translators: %s: author first name.'])).toBeUndefined()
    expect(nameRoles(['translators: 1: first name or last name, 2: email'])).toBeUndefined()
    expect(nameRoles(['translators: 1: first name, 2: first name of the partner, 3: last name'])).toBeUndefined()
    expect(nameRoles([])).toBeUndefined()
  })
})

const problem = (msgid: string, msgstr: string, order: 'given-first' | 'family-first', comments = WOO, msgctxt?: string) =>
  nameOrderProblem({ msgid, comments, ...(msgctxt === undefined ? {} : { msgctxt }) }, msgstr, order, 'Japanese')

// Core's display name choices on the profile screen, which say in the context
// what the translator comment does not.
const FIRST_LAST = 'Display name based on first name and last name'
const LAST_FIRST = 'Display name based on last name and first name'

describe('nameOrderProblem', () => {
  it('asks a family-name-first locale for the family name first', () => {
    expect(problem('%1$s %2$s', '%1$s %2$s', 'family-first')).toBe('Japanese writes the family name first: "%2$s %1$s"')
    expect(problem('%1$s %2$s', '%2$s %1$s', 'family-first')).toBeUndefined()
    expect(problem('%1$s %2$s', '%2$s%1$s', 'family-first')).toBeUndefined()
    expect(problem('%1$s\u00a0%2$s', '%1$s\u00a0%2$s', 'family-first')).toBe('Japanese writes the family name first: "%2$s %1$s"')
  })

  it('numbers an unnumbered source in what it suggests', () => {
    expect(problem('%s %s', '%s %s', 'family-first')).toBe('Japanese writes the family name first: "%2$s %1$s"')
    expect(problem('%s %s', '%2$s %1$s', 'family-first')).toBeUndefined()
  })

  // English already writes the given name first, so a given-first locale
  // that swapped the two did it on purpose, and a warning would only be noise.
  it('says nothing to a given-name-first locale', () => {
    expect(problem('%1$s %2$s', '%2$s %1$s', 'given-first')).toBeUndefined()
  })

  it('reads the roles from a context that names them in order', () => {
    expect(problem('%1$s %2$s', '%1$s %2$s', 'family-first', [], FIRST_LAST)).toBe('Japanese writes the family name first: "%2$s %1$s"')
    expect(problem('%1$s %2$s', '%2$s %1$s', 'family-first', [], FIRST_LAST)).toBeUndefined()
    // Its arguments are the last name and then the first: already the family
    // name first, and deliberate, so never reported.
    expect(problem('%1$s %2$s', '%1$s %2$s', 'family-first', [], LAST_FIRST)).toBeUndefined()
  })

  it('leaves a sort form and a sentence alone', () => {
    // "Last, First" is the order a list sorted by family name shows.
    expect(problem('%2$s, %1$s', '%2$s, %1$s', 'family-first')).toBeUndefined()
    expect(problem('Dear %1$s, your account %2$s', 'Dear %1$s, your account %2$s', 'family-first')).toBeUndefined()
  })

  it('leaves a translation that lost a name to the placeholder rule', () => {
    expect(problem('%1$s %2$s', '%1$s', 'family-first')).toBeUndefined()
  })

  it('needs the comment to say which is which', () => {
    expect(problem('%1$s %2$s', '%1$s %2$s', 'family-first', [])).toBeUndefined()
  })
})
