import { describe, expect, it } from 'vitest'
import {
  MARKER_HEADER,
  encodeMarker,
  fingerprintReview,
  writtenByEarlierVersion,
  type ReviewMarker,
} from '../../src/audit/resume.js'
import { VERSION } from '../../src/version.js'
import type { GlossaryEntry } from '../../src/types.js'

const GLOSSARY: GlossaryEntry[] = [{ locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu' }]

const INPUT = {
  source: 'msgid "Save"\nmsgstr "Kaydet"\n',
  locale: 'tr',
  batchSize: 25,
  noAi: false,
  glossary: GLOSSARY,
  properNouns: ['Türk Dil Kurumu'],
}

const MARKER: ReviewMarker = {
  done: 42,
  of: 114,
  problems: 57,
  unreviewed: 25,
  repaired: 19,
  byRule: { 'ai:meaning': 30, glossary: 27 },
}

describe('review marker', () => {
  it('is one header line, since a .po header cannot hold a newline', () => {
    expect(encodeMarker(MARKER)).not.toContain('\n')
  })

  it('names itself so a human reading the file can tell what it is', () => {
    expect(MARKER_HEADER).toMatch(/^X-/)
  })

  it('stamps the build that wrote it', () => {
    expect(JSON.parse(encodeMarker(MARKER))).toMatchObject({ polyglots: VERSION })
  })
})

describe('writtenByEarlierVersion', () => {
  it('is false for a marker this build wrote', () => {
    expect(writtenByEarlierVersion(encodeMarker(MARKER))).toBe(false)
  })

  it('is true for a 0.2.0-0.4.0 marker, which is the population the notice is for', () => {
    expect(writtenByEarlierVersion('{"v":2,"done":3,"of":12}')).toBe(true)
  })

  it('is true for a marker nobody can parse', () => {
    expect(writtenByEarlierVersion('{not json')).toBe(true)
  })
})

describe('fingerprintReview', () => {
  it('is stable across calls with the same inputs', () => {
    expect(fingerprintReview({ ...INPUT })).toEqual(fingerprintReview(INPUT))
  })

  // The prompt shows each row's note, so a note edited locally answers a
  // different question and must refuse a resume like any other glossary edit.
  it('moves its glossary part when only a note changes', () => {
    const noted = (notes: string) => fingerprintReview({ ...INPUT, glossary: [{ ...GLOSSARY[0]!, notes }] })
    expect(noted('a').glossary).toBe(noted('a').glossary)
    expect(noted('a').glossary).not.toBe(noted('b').glossary)
  })
})
