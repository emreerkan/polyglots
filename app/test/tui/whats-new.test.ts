import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { laterVersion, WHATS_NEW, whatsNewFor } from '../../src/tui/whats-new.js'

const LIST = {
  unreleased: ['Coming next.'],
  '0.33.0': ['Thirty-three.'],
  '0.32.0': ['Thirty-two, first.', 'Thirty-two, second.'],
  '0.30.0': ['Thirty.'],
}

describe('whatsNewFor', () => {
  it('shows every version after the one last seen, newest first', () => {
    expect(whatsNewFor('0.30.0', '0.33.0', LIST)).toEqual([
      { version: '0.33.0', items: ['Thirty-three.'] },
      { version: '0.32.0', items: ['Thirty-two, first.', 'Thirty-two, second.'] },
    ])
  })

  // A version with no entry adds nothing, and a patch on top of a version
  // with one is not a reason to show that version again.
  it('shows nothing when the versions in between have no entry', () => {
    expect(whatsNewFor('0.33.0', '0.33.2', LIST)).toEqual([])
  })

  it('shows nothing once the current version has been seen', () => {
    expect(whatsNewFor('0.33.0', '0.33.0', LIST)).toEqual([])
  })

  // Going back to an older release, or running a development build of one,
  // is not news.
  it('shows nothing when the current version is older than the one seen', () => {
    expect(whatsNewFor('0.33.0', '0.32.0', LIST)).toEqual([])
  })

  // A tui.json written before this feature has no version in it. Its owner
  // used the app before, so they hear about this release, and only this one:
  // the versions before it they lived through.
  it('shows only the current version to someone whose state predates the feature', () => {
    expect(whatsNewFor(undefined, '0.32.0', LIST)).toEqual([
      { version: '0.32.0', items: ['Thirty-two, first.', 'Thirty-two, second.'] },
    ])
  })

  // Not yet a version: a development build carries it but must not show it.
  it('never shows the unreleased lines', () => {
    expect(whatsNewFor('0.33.0', '0.34.0', LIST)).toEqual([])
    expect(whatsNewFor(undefined, '0.34.0', LIST)).toEqual([])
  })

  // A pre-release of a version counts as that version.
  it('counts a pre-release as its release', () => {
    expect(whatsNewFor('0.32.0', '0.33.0-rc.1', LIST)).toEqual([{ version: '0.33.0', items: ['Thirty-three.'] }])
  })
})

describe('laterVersion', () => {
  it('keeps the later of the two, so a downgrade does not lower what was seen', () => {
    expect(laterVersion('0.33.0', '0.32.0')).toBe('0.33.0')
    expect(laterVersion('0.32.0', '0.33.0')).toBe('0.33.0')
    expect(laterVersion(undefined, '0.33.0')).toBe('0.33.0')
  })
})

describe('WHATS_NEW', () => {
  // A typo in a key ('0.3.3') would make an entry nobody ever sees.
  it('names only released versions, or unreleased', () => {
    const changelog = readFileSync(join(import.meta.dirname, '..', '..', 'CHANGELOG.md'), 'utf8')
    const released = new Set([...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]))
    for (const key of Object.keys(WHATS_NEW)) {
      if (key !== 'unreleased') expect(released, key).toContain(key)
    }
  })

  // Two lines whose wording the maintainer decided, pinned so a later edit is
  // a choice. A problem report is offered for more than a failed run (a batch
  // given up, a breaker stop), and "batches" alone also reads as the agent's
  // batches of entries, so the line names the screen of files.
  it('words the report and batch-of-files lines as decided', () => {
    expect(WHATS_NEW.unreleased).toContain('Send a problem report when a run has problems')
    expect(WHATS_NEW.unreleased).toContain('Batch of files: time, estimate, open any file')
  })

  // The home screen gives each line one row and cuts what does not fit, at a
  // frame that can be 60 columns wide with a version in front.
  it('keeps every line short enough for the narrowest frame', () => {
    for (const [key, items] of Object.entries(WHATS_NEW)) {
      expect(items.length, key).toBeGreaterThan(0)
      expect(items.length, key).toBeLessThanOrEqual(3)
      for (const item of items) expect(item.length, item).toBeLessThanOrEqual(50)
    }
  })
})
