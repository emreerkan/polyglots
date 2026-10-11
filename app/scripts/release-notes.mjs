#!/usr/bin/env node
// node scripts/release-notes.mjs <version>
//
// Prints one version's changelog section, for the GitHub Release the publish
// workflow creates. The release commit's body holds the same text, but the
// workflow runs on a tag and reading the changelog it carries needs no
// assumption about which commit the tag landed on.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @param {string} changelog the whole CHANGELOG.md
 * @param {string} version for example 0.28.0
 * @returns {string} the section's body, without its heading
 */
export function notesFor(changelog, version) {
  const heading = `## [${version}]`
  const start = changelog.indexOf(`\n${heading}`)
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}.`)
  const bodyStart = changelog.indexOf('\n', start + 1)
  const next = changelog.indexOf('\n## [', bodyStart)
  return changelog.slice(bodyStart, next === -1 ? changelog.length : next).trim()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: node scripts/release-notes.mjs <version>')
    process.exit(1)
  }
  const app = join(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    console.log(notesFor(readFileSync(join(app, 'CHANGELOG.md'), 'utf8'), version))
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
