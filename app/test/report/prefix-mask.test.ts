import { describe, expect, it } from 'vitest'
import { CUT_MARK } from '../../src/logs/excerpt.js'
import { keyMasker, prefixRanges } from '../../src/report/build.js'

// The prefix mask has a definition simple enough to write as a brute force:
// at each place a prefix may end (before a cut mark, before a quote, at the
// end), the longest proper prefix of each key that ends there, if it is at
// least that place's minimum. The scan in build.ts is a KMP automaton with a
// window path, a jump over text no prefix can start in, and a list of keys
// with the ones that prefix another left out; each of those is a shortcut
// that must give exactly the brute force's answer.
const minAt = (t: string, e: number): number => (e === t.length ? 8 : t[e] === CUT_MARK ? 4 : t[e] === '"' ? 8 : Infinity)

function brute(secrets: string[], t: string): boolean[] {
  const masked = new Array<boolean>(t.length).fill(false)
  for (const s of secrets) {
    if (s.length <= 4) continue
    for (let e = 0; e <= t.length; e++) {
      const min = minAt(t, e)
      if (min === Infinity) continue
      for (let n = Math.min(s.length - 1, e); n >= min; n--) {
        if (t.slice(e - n, e) === s.slice(0, n)) {
          for (let i = e - n; i < e; i++) masked[i] = true
          break
        }
      }
    }
  }
  return masked
}

function scanned(secrets: string[], t: string): boolean[] {
  const masked = new Array<boolean>(t.length).fill(false)
  prefixRanges(secrets)?.(t, (a, b) => {
    for (let i = a; i < b; i++) masked[i] = true
  })
  return masked
}

const bits = (m: boolean[]): string => m.map(Number).join('')

describe('the key prefix scan', () => {
  // When the automaton reaches a whole key it steps back to the longest
  // prefix that is also a suffix, not to nothing: a key that overlaps itself
  // can end a prefix inside the next repeat. The quotes make it the full
  // pass: a window is a key's length less one and never holds a whole key.
  it('carries on from the key\'s own overlap after a whole key', () => {
    const text = `${'"'.repeat(20)}abababab${'ab'}${CUT_MARK}`
    expect(bits(scanned(['abababab'], text))).toBe(bits(brute(['abababab'], text)))
    const ranges: Array<[number, number]> = []
    prefixRanges(['abababab'])!(text, (a, b) => ranges.push([a, b]))
    expect(ranges).toEqual([[24, 30]])
  })

  it('masks exactly what the brute force masks, on random keys and texts', () => {
    let seed = 42
    const r = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000
    for (let iter = 0; iter < 5000; iter++) {
      const alpha = r() < 0.4 ? 'a' : r() < 0.7 ? 'ab' : 'ab"c'
      const count = 1 + Math.floor(r() * 3)
      const secrets: string[] = []
      for (let k = 0; k < count; k++) {
        let s = ''
        const length = 5 + Math.floor(r() * 10)
        for (let i = 0; i < length; i++) s += alpha[Math.floor(r() * alpha.length)]
        secrets.push(s)
      }
      const sparse = r() < 0.5
      const letters = sparse ? `${alpha}xyzxyzxyzxyzxyzxyzxyzxyzxyz` : `${alpha}${CUT_MARK}"x`
      let t = ''
      const length = Math.floor(r() * (r() < 0.3 ? 400 : 40))
      while (t.length < length) {
        if (sparse && r() < 0.03) t += r() < 0.5 ? CUT_MARK : '"'
        else if (r() < 0.3) {
          const s = secrets[Math.floor(r() * count)]!
          t += s.slice(0, Math.floor(r() * s.length))
        } else t += letters[Math.floor(r() * letters.length)]
      }
      const keys = [...new Set(secrets)]
      expect(bits(scanned(keys, t)), JSON.stringify({ keys, t })).toBe(bits(brute(keys, t)))
    }
  })

  // The whole masker, against its definition: every whole-key match, every
  // brute-force prefix range (of each key and its escaped form), sorted by
  // start and merged, an overlap extending the mask before it and a range
  // that starts where the last ended making a second [redacted].
  it('masks keys whole and cut exactly as a sorted merge of brute-force ranges', () => {
    let seed = 7
    const r = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (let iter = 0; iter < 3000; iter++) {
      const alpha = r() < 0.4 ? 'ab' : 'ab"c-'
      const secrets: string[] = []
      const count = 1 + Math.floor(r() * 3)
      for (let k = 0; k < count; k++) {
        // Sometimes the start of an earlier key, as two .env paths can be.
        if (k > 0 && r() < 0.3) secrets.push(secrets[0]!.slice(0, 6 + Math.floor(r() * 4)) + (r() < 0.5 ? '' : 'ab'))
        else {
          let s = ''
          const length = 6 + Math.floor(r() * 10)
          for (let i = 0; i < length; i++) s += alpha[Math.floor(r() * alpha.length)]
          secrets.push(s)
        }
      }
      const keys = [...new Set(secrets)]
      let t = ''
      const length = Math.floor(r() * 200)
      while (t.length < length) {
        if (r() < 0.3) {
          const s = keys[Math.floor(r() * keys.length)]!
          t += r() < 0.3 ? s : s.slice(0, Math.floor(r() * s.length))
        } else t += `${alpha}${CUT_MARK}"x `[Math.floor(r() * (alpha.length + 4))]
      }
      const forms: string[] = []
      for (const s of keys) {
        forms.push(s)
        const e = JSON.stringify(s).slice(1, -1)
        if (e !== s) forms.push(e)
        for (let k = 1; k <= 3 && s.length - k >= 8; k++) forms.push(s.slice(k))
      }
      const whole = new RegExp([...new Set(forms)].sort((a, b) => b.length - a.length).map(esc).join('|'), 'g')
      const ranges: Array<[number, number]> = [...t.matchAll(whole)].map((m) => [m.index, m.index + m[0].length])
      const all = [...new Set(keys.flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]))]
      for (const s of all) {
        if (s.length <= 4) continue
        for (let e = 0; e <= t.length; e++) {
          const min = minAt(t, e)
          if (min === Infinity) continue
          for (let n = Math.min(s.length - 1, e); n >= min; n--) {
            if (t.slice(e - n, e) === s.slice(0, n)) {
              ranges.push([e - n, e])
              break
            }
          }
        }
      }
      ranges.sort((a, b) => a[0] - b[0])
      let expected = ''
      let at = 0
      for (const [start, end] of ranges) {
        if (end <= at) continue
        expected += start >= at ? `${t.slice(at, start)}[redacted]` : ''
        at = end
      }
      expected += t.slice(at)
      expect(keyMasker(keys)!(t), JSON.stringify({ keys, t })).toBe(expected)
    }
  })
})
