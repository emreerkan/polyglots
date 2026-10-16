import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

function reach(entry: string, root = src): { files: string[]; foreign: string[] } {
  const seen = new Set<string>()
  const foreign: string[] = []
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    // Type-only imports and re-exports are erased and pull nothing in. A
    // side-effect import and a dynamic import name no binding, so the from
    // clause alone misses them, and the bundler follows both.
    const specs = [
      ...text.matchAll(/^(?:import|export)(?!\s+type\b)[^'"]*?from\s+'([^']+)'/gm),
      ...text.matchAll(/^import\s+'([^']+)'/gm),
      ...text.matchAll(/import\(\s*'([^']+)'\s*\)/g),
    ]
    for (const spec of specs.map((m) => m[1]!)) {
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
      else if (!PACKAGES.has(spec)) foreign.push(`${file.slice(root.length + 1)} imports ${spec}`)
    }
  }
  visit(resolve(root, entry))
  return { files: [...seen], foreign }
}

describe('modules the rules builder bundles', () => {
  it.each(ENTRIES)('%s reaches nothing that needs Node', (entry) => {
    expect(reach(entry).foreign).toEqual([])
  })

  // A module that only needs Node for its side effect, or loads it lazily,
  // fails the bundle as surely as one that names it in a from clause.
  it('sees a side-effect import and a dynamic import', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-safe-'))
    try {
      writeFileSync(join(root, 'entry.ts'), "import { x } from './lazy.js'\nimport 'node:fs'\nexport const y = x\n")
      writeFileSync(join(root, 'lazy.ts'), "export const x = async () => (await import('node:path')).sep\n")
      expect(reach('entry.ts', root).foreign.sort()).toEqual(['entry.ts imports node:fs', 'lazy.ts imports node:path'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
