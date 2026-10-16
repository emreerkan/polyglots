import { describe, expect, it } from 'vitest'
import { releaseArgs } from '../../scripts/release-size.mjs'

describe('releaseArgs', () => {
  it.each(['patch', 'minor', 'major'])('accepts %s', (size) => {
    expect(releaseArgs([size])).toEqual({ size, noShip: false })
  })

  it('reads --no-ship after the size', () => {
    expect(releaseArgs(['major', '--no-ship'])).toEqual({ size: 'major', noShip: true })
  })

  // npm version would take these too, but they are not a size anyone means
  // to pass here: a prerelease or an exact version skips the changelog's
  // account of what kind of change it is.
  it.each([[[]], [['premajor']], [['1.0.0']], [['--no-ship']]])('refuses %j with the usage line', (argv) => {
    expect(() => releaseArgs(argv)).toThrow('Usage: npm run release -- <patch|minor|major> [--no-ship]')
  })
})
