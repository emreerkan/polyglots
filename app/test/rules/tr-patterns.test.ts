import { describe, expect, it } from 'vitest'
import { customFindings } from '../../src/rules/custom.js'
import { renderDefaultRules } from '../../src/rules/defaults.js'
import { parseLocaleRules } from '../../src/rules/load.js'

// The Turkish template ships two grammar checks as commented example
// patterns rather than as rules: a suffix glued to a placeholder, and a plural
// noun after a count. A team turns them on by uncommenting, so what is tested
// here is the template itself, uncommented the way a person would do it, read
// by the same loader and matched by the same engine a review uses.
function uncommentedPatterns() {
  const lines = renderDefaultRules('tr').split('\n')
  const start = lines.indexOf('patterns: []')
  const out = [...lines.slice(0, start), 'patterns:']
  let i = start + 1
  for (; i < lines.length && lines[i]!.startsWith('#  '); i++) out.push(lines[i]!.slice(1))
  out.push(...lines.slice(i))
  return parseLocaleRules(out.join('\n'), 'tr_TR.yaml').patterns
}

const notes = (msgstr: string) =>
  customFindings({ msgid: 'source', msgstr: [msgstr] }, uncommentedPatterns(), 'tr').map((f) => f.message)
const SUFFIX = /suffix on a placeholder/
const PLURAL = /singular after a number/

describe('Turkish example patterns', () => {
  it.each(["%s'de kaydedildi", "%1$s'nin ayarları", "{name}'i sil", "%d'den fazla", '%s’e taşındı'])('reports the suffix in %s', (text) => {
    expect(notes(text).some((n) => SUFFIX.test(n))).toBe(true)
  })

  it.each(["'%s' silindi", "<a href='%s'>bağlantı</a>", "%1$sbu SSS%2$s'ye bakın", '%s konumuna kaydedildi'])('leaves %s alone', (text) => {
    expect(notes(text).some((n) => SUFFIX.test(n))).toBe(false)
  })

  it.each(['%d dosyalar silindi', '<strong>%d</strong> dosyalar', '%d dosyaları', '%d öğelerine', '%1$d yorumlardan'])('reports the plural in %s', (text) => {
    expect(notes(text).some((n) => PLURAL.test(n))).toBe(true)
  })

  // Words that only end like a plural: a currency, an adjective, a noun
  // whose ending reads as -ler plus a case, a brand, and olarak, whose -lar is
  // followed by a back vowel no Turkish plural ending starts with after -ler.
  it.each(['%d dolar', '%d dolara', '%d popüler yazı', '%d galeri', '%d Cloudflare', '%d olarak içe aktarıldı', '%d dosya silindi'])('leaves %s alone', (text) => {
    expect(notes(text).some((n) => PLURAL.test(n))).toBe(false)
  })
})
