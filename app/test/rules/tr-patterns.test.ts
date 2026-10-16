import { describe, expect, it } from 'vitest'
import { customFindings } from '../../src/rules/custom.js'
import { readFileSync } from 'node:fs'
import { parseLocaleRules } from '../../src/rules/load.js'

// Two Turkish grammar checks written as patterns rather than rules: a suffix
// glued to a placeholder, and a plural noun after a count. The Turkish
// template used to carry them as commented examples; with the packs gone they
// live in the tr_TR rules file in polyglots-data, and the fixture is a verbatim
// copy of those two entries. What is tested is still the file a team ships,
// read by the same loader and matched by the same engine a review uses.
function grammarPatterns() {
  const path = new URL('../fixtures/locale/tr-grammar-patterns.yaml', import.meta.url)
  return parseLocaleRules(readFileSync(path, 'utf8'), 'tr_TR.yaml').patterns
}

const notes = (msgstr: string) =>
  customFindings({ msgid: 'source', msgstr: [msgstr] }, grammarPatterns(), 'tr').map((f) => f.message)
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
