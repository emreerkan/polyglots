import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The website's rules builder bundles these modules for the browser, so the
// builder validates with the app's own schema and parser instead of a copy.
// Nothing they reach may need Node: a node: import fails the site's build, and
// a package with Node internals fails it in the browser instead, which nobody
// sees until a person opens the page. Walked statically, as the bundler does.
const ENTRIES = ['rules/emit.ts', 'rules/parse.ts', 'rules/builder-url.ts', 'rules/names.ts', 'wporg/locales.ts']
const PACKAGES = new Set(['zod', 'yaml'])
const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src')

function reach(entry: string): { files: string[]; foreign: string[] } {
  const seen = new Set<string>()
  const foreign: string[] = []
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    // Type-only imports and re-exports are erased and pull nothing in.
    for (const m of text.matchAll(/^(?:import|export)(?!\s+type\b)[^'"]*?from\s+'([^']+)'/gm)) {
      const spec = m[1]!
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
      else if (!PACKAGES.has(spec)) foreign.push(`${file.slice(src.length + 1)} imports ${spec}`)
    }
  }
  visit(resolve(src, entry))
  return { files: [...seen], foreign }
}

describe('modules the rules builder bundles', () => {
  it.each(ENTRIES)('%s reaches nothing that needs Node', (entry) => {
    expect(reach(entry).foreign).toEqual([])
  })
})
