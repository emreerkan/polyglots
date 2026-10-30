import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Key } from '../../src/tui/input.js'
import { dispatchKeys } from '../../src/tui/hooks/useKeys.js'
import { footerKeys, GLOBAL_KEYS, groupOf, KEYS, SCREEN_KEYS, SCREENS, type KeyEntry } from '../../src/tui/keys.js'
import { walk, type ScreenId } from '../../src/tui/menu.js'

const TUI_SRC = join(import.meta.dirname, '../../src/tui')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

const code = (path: string) => readFileSync(path, 'utf8')
// The hook's own file defines useKeys rather than calling it.
const HOOK = join(TUI_SRC, 'hooks/useKeys.ts')
const groupsIn = (path: string) => (path === HOOK ? [] : boundGroups(code(path), path))

/**
 * The groups named by every useKeys or useGlobalKeys call in a source: the
 * top-level property names of the object literal each call is handed. A
 * scanner rather than a parser, which is enough for code this repo writes, and
 * it refuses a call it cannot read rather than guessing.
 */
function boundGroups(text: string, file = '?'): string[] {
  const groups: string[] = []
  const call = /\buse(?:Global)?Keys\(/g
  let m: RegExpExecArray | null
  while ((m = call.exec(text))) {
    let i = m.index + m[0].length
    while (/\s/.test(text[i]!)) i++
    if (text[i] !== '{') throw new Error(`${file}: useKeys must be handed an object literal of groups`)
    let depth = 0
    let expectName = false
    for (; i < text.length; i++) {
      const c = text[i]!
      if (c === '/' && text[i + 1] === '/') {
        i = text.indexOf('\n', i)
        continue
      }
      if (c === '/' && text[i + 1] === '*') {
        i = text.indexOf('*/', i) + 1
        continue
      }
      if (c === "'"|| c === '"' || c === '`') {
        const end = text.indexOf(c, i + 1)
        i = end
        continue
      }
      if (c === '{' || c === '(' || c === '[') {
        depth++
        if (depth === 1) expectName = true
        continue
      }
      if (c === '}' || c === ')' || c === ']') {
        depth--
        if (depth === 0) break
        continue
      }
      if (depth === 1 && c === ',') {
        expectName = true
        continue
      }
      if (depth === 1 && expectName && /[A-Za-z_]/.test(c)) {
        const name = /^[A-Za-z_]\w*/.exec(text.slice(i))![0]
        groups.push(name)
        i += name.length - 1
        expectName = false
      }
    }
  }
  return groups
}

// The components and hooks a file renders or calls, followed through each
// other but not into other screens: the setup wizard embeds whole screens,
// and those list their own keys. Only an import that brings in a component
// (capitalised) or a hook (use...) is followed, so review's progress pulling
// renderBar out of translate's does not count translate's o as review's.
function graph(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen
  seen.add(file)
  for (const m of code(file).matchAll(/^import \{([^}]*)\} from '(\.[^']+)\.js'/gm)) {
    const names = m[1]!.split(',').map((n) => n.trim()).filter((n) => n !== '' && !n.startsWith('type '))
    if (!names.some((n) => /^(?:[A-Z]|use[A-Z])/.test(n))) continue
    const base = resolve(dirname(file), m[2]!)
    const target = [`${base}.tsx`, `${base}.ts`].find((p) => {
      try {
        return statSync(p).isFile()
      } catch {
        return false
      }
    })
    if (!target) continue
    const rel = relative(TUI_SRC, target)
    if (rel.startsWith('components/') || rel.startsWith('hooks/')) graph(target, seen)
  }
  return seen
}

// Which screens each file draws. Several files hold more than one.
const FILES: Record<string, ScreenId[]> = {
  'screens/Home.tsx': ['home', 'tools', 'config'],
  'screens/Info.tsx': ['help', 'about', 'interface'],
  'screens/Agents.tsx': ['agents'],
  'screens/LocalModels.tsx': ['local-models'],
  'screens/ConfigureKeys.tsx': ['configure-keys'],
  'screens/Split.tsx': ['split'],
  'screens/ImportTm.tsx': ['import-tm'],
  'screens/ExportTm.tsx': ['export-tm'],
  'screens/SyncGlossary.tsx': ['sync-glossary'],
  'screens/EditGlossary.tsx': ['edit-glossary'],
  'screens/Stats.tsx': ['stats'],
  'screens/LocaleRules.tsx': ['locale-rules'],
  'screens/ReplyTemplates.tsx': ['reply-templates'],
  'screens/Wizard.tsx': ['setup'],
  'screens/Fetch.tsx': ['fetch'],
  'screens/Review.tsx': ['review'],
  'screens/Translate.tsx': ['translate'],
  'screens/UsageStats.tsx': ['usage-stats'],
}

// Bound on every screen, and listed once under "Everywhere" rather than on each.
const EVERYWHERE = new Set(['global', 'back'])

const bindable = (e: KeyEntry) => 'match' in e

describe('the key table and the bindings cannot drift', () => {
  it('leaves no raw key listener outside the input module and useKeys', () => {
    const offenders = sources(TUI_SRC)
      .filter((p) => !p.endsWith('/input.tsx') && !p.endsWith('/hooks/useKeys.ts'))
      .filter((p) => /\buse(?:Global)?Input\(/.test(code(p)))
      .map((p) => relative(TUI_SRC, p))
    expect(offenders).toEqual([])
  })

  it('binds every group in the table somewhere, and nothing that is not in it', () => {
    const bound = new Set(sources(TUI_SRC).flatMap(groupsIn))
    const groups = Object.keys(KEYS).filter((g) => Object.values(KEYS[g as keyof typeof KEYS]).some(bindable))
    expect([...bound].filter((g) => !(g in KEYS))).toEqual([])
    expect(groups.filter((g) => !bound.has(g))).toEqual([])
  })

  it('covers every screen with a file', () => {
    const covered = new Set(Object.values(FILES).flat())
    expect(walk().map((e) => e.node.id).filter((id) => !covered.has(id))).toEqual([])
    expect([...covered].sort()).toEqual(Object.keys(SCREENS).sort())
  })

  for (const [file, screens] of Object.entries(FILES)) {
    it(`lists exactly the keys ${file} binds`, () => {
      const bound = new Set([...graph(join(TUI_SRC, file))].flatMap(groupsIn))
      const listed = screens.flatMap((s) => [...SCREENS[s].shown, ...(SCREENS[s].more ?? [])])

      // Listed but not bound: a hint for a key nothing answers.
      const unbound = listed.filter(bindable).filter((e) => !bound.has(groupOf(e)))
      expect(unbound.map((e) => `${groupOf(e)}: ${e.keys} ${e.does}`)).toEqual([])

      // Bound but not listed: a key the footer and help never mention.
      const shown = new Set(listed)
      const unlisted = [...bound]
        .filter((g) => !EVERYWHERE.has(g))
        .flatMap((g) => Object.values(KEYS[g as keyof typeof KEYS]) as KeyEntry[])
        .filter((e) => bindable(e) && !shown.has(e))
      expect(unlisted.map((e) => `${groupOf(e)}: ${e.keys} ${e.does}`)).toEqual([])
    })
  }

  it('builds the help listing and the footer from the same entries', () => {
    for (const screen of Object.keys(SCREENS) as ScreenId[]) {
      const { shown, more = [] } = SCREENS[screen]
      expect(SCREEN_KEYS[screen]).toEqual([...shown, ...more].map(({ keys, does }) => ({ keys, does })))
    }
    expect(footerKeys('split').map((k) => k.keys)).toEqual(['enter', '?', 'esc'])
  })

  it('lists the keys bound everywhere under one heading', () => {
    expect(GLOBAL_KEYS.map((k) => k.keys)).toEqual(['?', 'ctrl+k  :', 'l', 'esc', 'q', 'ctrl+c', 'x', 'pgup pgdn'])
  })

  // The listings the table used to get wrong while it was only documentation.
  it('lists what export-tm and import-tm actually bind', () => {
    expect(footerKeys('export-tm').map((k) => `${k.keys} ${k.does}`)).toEqual([
      '↑↓  space switch format',
      'enter continue',
      'tab choose the folder',
      '? help',
      'esc back',
    ])
    expect(SCREEN_KEYS['import-tm'].map((k) => k.keys)).not.toContain('space')
  })
})

describe('the locale key', () => {
  it('is a plain l, not L and not ctrl+l', () => {
    expect(KEYS.global.locale.match('l', NO_KEY)).toBe(true)
    expect(KEYS.global.locale.match('L', { ...NO_KEY, shift: true })).toBe(false)
    expect(KEYS.global.locale.match('l', { ...NO_KEY, ctrl: true })).toBe(false)
  })

  it('is listed under the keys bound everywhere', () => {
    expect(GLOBAL_KEYS).toContainEqual({ keys: 'l', does: 'change the locale' })
  })
})

describe('boundGroups', () => {
  it('reads the group names off a call, not the handler names inside', () => {
    const text = `useKeys({ back: { esc: onBack, q: () => { go() } }, menu: { open: (i, k) => f({ a: 1 }) } }, { isActive: on })`
    expect(boundGroups(text)).toEqual(['back', 'menu'])
  })

  it('refuses a call it cannot read', () => {
    expect(() => boundGroups('useKeys(bindings)')).toThrow(/object literal/)
  })
})

const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
}

describe('dispatchKeys', () => {
  it('runs the first entry that matches and has a handler', () => {
    const calls: string[] = []
    const handled = dispatchKeys(
      { back: { esc: () => void calls.push('esc'), q: undefined }, run: { pause: () => void calls.push('pause'), resume: undefined, stop: () => void calls.push('stop') } },
      'q',
      NO_KEY,
    )
    expect(handled).toBe(true)
    expect(calls).toEqual(['stop'])
  })

  it('moves on when a handler declines', () => {
    const calls: string[] = []
    dispatchKeys(
      {
        home: { provider: () => false },
        menu: { open: undefined, move: undefined, hotkey: (input) => void calls.push(`hotkey ${input}`) },
      },
      'p',
      NO_KEY,
    )
    expect(calls).toEqual(['hotkey p'])
  })

  it('leaves a letter with ctrl held alone', () => {
    const calls: string[] = []
    const handled = dispatchKeys({ run: { pause: () => void calls.push('pause'), resume: undefined, stop: undefined } }, 'p', { ...NO_KEY, ctrl: true })
    expect(handled).toBe(false)
    expect(calls).toEqual([])
  })
})

// A run screen passes through stages, and its footer lists the keys of the
// stage it is in: "move between fields" while a review runs pointed at keys
// that did nothing.
describe('footer keys by stage', () => {
  const footer = (screen: ScreenId, stage?: string) => footerKeys(screen, false, stage).map((k) => k.does)

  it.each(['review', 'translate'] as const)('%s lists the run keys while it runs, and the result keys when done', (screen) => {
    expect(footer(screen, 'options')).toContain('move between fields')
    expect(footer(screen, 'running')).toEqual(expect.arrayContaining(['pause after the current batch', 'stop after the current batch']))
    expect(footer(screen, 'running')).not.toContain('move between fields')
    expect(footer(screen, 'done')).toContain('back to the menu once it is done')
    expect(footer(screen, 'pick')).not.toContain('move between fields')
  })

  // A batch of marked files ends in a table, with no one result to open or
  // copy; enter opens the file under the cursor instead, so esc is the way back.
  it.each(['review', 'translate'] as const)('%s lists marking in the picker, and no open key under a batch summary', (screen) => {
    expect(footer(screen, 'pick')).toContain('mark or unmark a file for one batch')
    expect(footer(screen, 'summary')).toContain("open a file's own progress")
    expect(footer(screen, 'summary')).toContain('back')
    expect(footer(screen, 'summary')).not.toContain('back to the menu once it is done')
    expect(footer(screen, 'summary').join(' ')).not.toMatch(/open the/)
  })

  it('lists the run keys while fetch runs', () => {
    expect(footer('fetch', 'running')).toContain('pause after the current batch')
    expect(footer('fetch', 'running')).not.toContain('continue')
  })

  it('keeps every stage within what the screen lists', () => {
    for (const [screen, { shown, more = [], stages = {} }] of Object.entries(SCREENS)) {
      const listed = new Set<KeyEntry>([...shown, ...more])
      for (const entries of Object.values(stages)) for (const e of entries ?? []) expect(listed.has(e), `${screen}: ${e.does}`).toBe(true)
    }
  })
})
