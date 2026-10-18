import { describe, expect, it } from 'vitest'
import { CUT_MARK, excerpt } from '../../src/logs/excerpt.js'

// Every cut of agent or error text marks itself, so a report's redactor can
// find the start of a key that ran across the cut wherever the cut sits in
// the line, not only at its end.
describe('excerpt', () => {
  it('keeps text within the length as it is', () => {
    expect(excerpt('short', 5)).toBe('short')
  })

  it('marks a cut with an ellipsis after the kept part', () => {
    expect(CUT_MARK).toBe('…')
    expect(excerpt('abcdefgh', 5)).toBe('abcde…')
  })

  // A cut counts UTF-16 code units, and an emoji in agent output is two. Cut
  // between them, the lone half is not text: JSON.stringify writes it as an
  // escape the server shows as a replacement character.
  it('never cuts between the two halves of a character outside the BMP', () => {
    const cut = excerpt('ab\u{1F600}cd', 3)
    expect(cut).toBe('ab…')
    expect(cut).not.toMatch(/[\uD800-\uDFFF]/)
    expect(excerpt('ab\u{1F600}cd', 4)).toBe('ab\u{1F600}…')
  })
})
