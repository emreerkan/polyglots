// The "What's new" half of a release, kept apart from release.mjs so it can be
// tested without running git or npm. Lines are written under `unreleased` in
// src/tui/whats-new.ts when work is merged; the release renames that key to
// the version it cuts, as it moves ## [Unreleased] in the changelog.

const KEY = /^ {2}unreleased:/m

/**
 * @param {string} text the whole of src/tui/whats-new.ts
 * @param {string} version for example 0.33.0
 * @returns {{ text: string, cut: boolean }}
 */
export function cutWhatsNew(text, version) {
  if (!KEY.test(text)) return { text, cut: false }
  // Two sets of lines under one key would leave only the last in the object,
  // silently. Refusing makes the person merge them.
  if (text.includes(`  '${version}':`)) {
    throw new Error(`src/tui/whats-new.ts already has lines for ${version}; merge them into unreleased first.`)
  }
  return { text: text.replace(KEY, `  '${version}':`), cut: true }
}
