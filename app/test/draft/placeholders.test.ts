import { describe, expect, it } from 'vitest'
import { missingPlaceholders } from '../../src/draft/placeholders.js'

describe('missingPlaceholders and real placeholders', () => {
  it('reports one the draft dropped', () => {
    expect(missingPlaceholders('Hello %s', 'Merhaba')).toEqual(['%s'])
  })

  it('reports nothing when the draft kept it', () => {
    expect(missingPlaceholders('Hello %s', 'Merhaba %s')).toEqual([])
  })

  it('counts repeats, so losing one of two is caught', () => {
    expect(missingPlaceholders('%s and %s', 'yalnızca %s')).toEqual(['%s'])
  })

  it('handles positional and precision forms', () => {
    expect(missingPlaceholders('%1$s costs %.2f', 'bedel')).toEqual(['%1$s', '%.2f'])
  })

  it('handles brace and token forms', () => {
    expect(missingPlaceholders('Hi {name} and ###TOKEN###', 'Merhaba')).toEqual(['{name}', '###TOKEN###'])
  })

  it('ignores an escaped percent', () => {
    expect(missingPlaceholders('100%% sure', 'kesinlikle')).toEqual([])
  })
})

describe('missingPlaceholders and a literal percent sign', () => {
  // English writes "100% satisfaction"; Turkish writes "%100 memnuniyet". The
  // sign moves to the other side of the number, so anything that reads "% s" as
  // a placeholder reports it lost on every single one of these.
  it('does not read "100% satisfaction" as a %s placeholder', () => {
    expect(missingPlaceholders('100% satisfaction guaranteed', '%100 memnuniyet garantisi')).toEqual([])
  })

  it('does not read "30% off" as a %o placeholder', () => {
    expect(missingPlaceholders('<strong>Get 30% off for 12 months!</strong>', '<strong>12 ay boyunca %30 indirim!</strong>')).toEqual([])
  })

  it('does not read "101% Growth" as a %G placeholder', () => {
    expect(missingPlaceholders('101% Growth - Optional Image Caption', '%101 Büyüme - İsteğe bağlı görsel altyazısı')).toEqual([])
  })

  it('does not read "50% opacity" as a %o placeholder', () => {
    expect(missingPlaceholders('a 50% opacity overlay', '%50 saydamlıkta bir katman')).toEqual([])
  })

  it('still catches a real placeholder in a string that also has a percent', () => {
    // The percent must not become a blanket excuse to stop looking.
    expect(missingPlaceholders('%s is 100% done', 'bitti')).toEqual(['%s'])
  })
})

describe('missingPlaceholders and percent-encoded URLs', () => {
  it('says nothing when the draft kept the URL intact', () => {
    // %2F reads as width-2 float. It cancels out when both sides carry it,
    // which is the common case: the URL is not translated.
    const src = '<a href="https://example.com/a%2Fb">Link</a>'
    expect(missingPlaceholders(src, '<a href="https://example.com/a%2Fb">Bağlantı</a>')).toEqual([])
  })

  it('does flag a draft that mangled the URL, which is worth knowing', () => {
    const src = '<a href="https://example.com/a%2Fb">Link</a>'
    expect(missingPlaceholders(src, '<a href="https://example.com/ab">Bağlantı</a>')).toHaveLength(1)
  })
})

describe('missingPlaceholders and numbering', () => {
  // sprintf fills the k-th unnumbered placeholder from the k-th argument, so a
  // translation that numbers them can put them in any order. A family-name-first
  // locale needs that for "%s %s", and Turkish word order often does.
  it('accepts unnumbered placeholders numbered and reordered in the translation', () => {
    expect(missingPlaceholders('%s %s', '%2$s %1$s')).toEqual([])
    expect(missingPlaceholders('%s by %s', '%2$s tarafından %1$s')).toEqual([])
    expect(missingPlaceholders('%s of %d items', '%2$d öğenin %1$s kadarı')).toEqual([])
    expect(missingPlaceholders('%2$s %1$s', '%s %s')).toEqual([])
  })

  it('still finds a numbered placeholder whose conversion does not match its argument', () => {
    expect(missingPlaceholders('%s of %d items', '%2$s of %1$d items')).toEqual(['%s', '%d'])
  })

  it('still finds a lost argument when the rest are numbered', () => {
    expect(missingPlaceholders('%s %s', '%2$s')).toEqual(['%s'])
  })

  it('leaves a source that mixes numbered and unnumbered placeholders as written', () => {
    expect(missingPlaceholders('%1$s %s', '%2$s %1$s')).toEqual(['%s'])
  })
})
