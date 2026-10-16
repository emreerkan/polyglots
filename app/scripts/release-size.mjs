// The arguments of npm run release, kept apart from release.mjs so they can be
// tested without running git or npm: release.mjs does both at the top level.
//
// major joined patch and minor at 1.0.0. Before that a minor could carry a
// breaking change, so the script refused major outright rather than let one
// be cut by a slip of the keyboard. From 1.0 on a break is exactly what major
// says, and the rule for choosing it lives in CLAUDE.md beside the others.
// Anything else npm version would take (premajor, an exact version) is still
// refused: it would cut a release without anyone having said what kind of
// change it is.

const SIZES = ['patch', 'minor', 'major']
const USAGE = 'Usage: npm run release -- <patch|minor|major> [--no-ship]'

/**
 * @param {readonly string[]} argv the arguments after the script's name
 * @returns {{ size: 'patch' | 'minor' | 'major', noShip: boolean }}
 */
export function releaseArgs(argv) {
  const [size, ...rest] = argv
  if (size === undefined || !SIZES.includes(size)) throw new Error(USAGE)
  return { size: /** @type {'patch' | 'minor' | 'major'} */ (size), noShip: rest.includes('--no-ship') }
}
