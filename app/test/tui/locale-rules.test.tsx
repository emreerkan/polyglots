import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveConfig } from '../../src/config.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import React from 'react'
import { profileFor } from '../../src/audit/rules/profiles.js'
import { localeRulesFile, loadLocaleRules, rulesFingerprint } from '../../src/rules/load.js'
import { hasLocaleRules } from '../../src/tui/setup.js'
import { App } from '../../src/tui/App.js'
import { CommandsProvider } from '../../src/tui/commands.js'
import { LocaleRules } from '../../src/tui/screens/LocaleRules.js'
import { installLocaleFixture } from '../locale-fixture.js'
import { ESC_DELAY, fakeCommands, flat, openFromHome, keys, makeHome, render, tick, waitFor, waitForText, cleanup, type Home } from './helpers.js'

let home: Home

beforeEach(async () => {
  home = await makeHome()
  // Named rather than assumed: polyglots has no default locale (no-locale.test.tsx).
  saveConfig({ defaultLocale: 'tr' })
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

function mount(onBack: () => void = () => undefined) {
  return render(
    <CommandsProvider value={fakeCommands()}>
      <LocaleRules onBack={onBack} />
    </CommandsProvider>,
  )
}

type View = ReturnType<typeof mount>

async function openLocale(view: View) {
  await waitForText(view.lastFrame, /Locale/)
  view.stdin.write(keys.enter)
  await waitForText(view.lastFrame, /Built-in rules/)
}

async function select(view: View, label: RegExp) {
  for (let i = 0; i < 10 && !new RegExp(`❯ ${label.source}`).test(view.lastFrame()); i++) {
    view.stdin.write(keys.down)
    await tick()
  }
  view.stdin.write(keys.enter)
  await tick()
}

// The screen once named the built-in pack a file was layered over. The code
// ships none now, so there is nothing to name.
describe('LocaleRules: no pack', () => {
  it('names no pack for a locale without a file', async () => {
    const view = mount()
    await openLocale(view)
    expect(flat(view.lastFrame())).not.toMatch(/pack/i)
  })
})

describe('LocaleRules: picking a locale', () => {
  it('opens the configured locale and names its file', async () => {
    const view = mount()
    await openLocale(view)
    expect(flat(view.lastFrame())).toMatch(/tr_TR \(tr\)/)
    expect(flat(view.lastFrame())).toMatch(/built-in defaults/)
  })

  it('accepts any spelling of a locale', async () => {
    const view = mount()
    await waitForText(view.lastFrame, /Locale/)
    view.stdin.write(keys.backspace)
    await tick()
    view.stdin.write(keys.backspace)
    await tick()
    view.stdin.write('nl_NL_formal')
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /nl_NL_formal \(nl\/formal\)/)
  })

  it('refuses a locale wp.org does not list, and stays on the field', async () => {
    const view = mount()
    await waitForText(view.lastFrame, /Locale/)
    view.stdin.write(keys.backspace)
    await tick()
    view.stdin.write(keys.backspace)
    await tick()
    view.stdin.write('zz')
    await tick()
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /not listed on translate\.wordpress\.org/)
  })

  it('reports a rules file it cannot read instead of editing a guess', async () => {
    const file = localeRulesFile('tr')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'rules:\n  enable: [nope]\n', 'utf8')
    const view = mount()
    await waitForText(view.lastFrame, /Locale/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /nope/)
  })
})

// Someone content with the built-in rules has to be able to say so: without
// a file the setup step can never be done, and an unchanged draft is not
// dirty, so s used to do nothing.
describe('LocaleRules: accepting the built-in rules', () => {
  it('offers s on a locale with no file, and saving it finishes the setup step', async () => {
    const view = mount()
    await openLocale(view)
    expect(hasLocaleRules('tr')).toBe(false)
    expect(flat(view.lastFrame())).toMatch(/s save these rules/)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    expect(hasLocaleRules('tr')).toBe(true)
  })

  // The defaults are written commented out, which fingerprints as no file:
  // accepting them must not re-review every file of the locale.
  it('writes the defaults without moving the rules fingerprint', async () => {
    const view = mount()
    await openLocale(view)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    expect(rulesFingerprint(loadLocaleRules('tr'))).toBe('')
    expect(flat(view.lastFrame())).not.toMatch(/next review of every tr file starts over/)
  })

  it('does not offer s again once the file exists and nothing changed', async () => {
    const view = mount()
    await openLocale(view)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    expect(flat(view.lastFrame())).not.toMatch(/s save/)
  })
})

// Turkish without its rules file starts from the universal set like any
// other locale, so title-case is the opt-in rule a team switches on.
describe('LocaleRules: built-in rules', () => {
  it('shows every built-in rule with its state and toggles one', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Built-in rules/)
    await waitForText(view.lastFrame, /title-case/)
    expect(view.lastFrame()).toMatch(/\[ \] title-case/)
    expect(view.lastFrame()).toMatch(/placeholder.*universal/)
    await select(view, /\[ \] title-case/)
    await waitForText(view.lastFrame, /\[x\] title-case/)
  })

  it('names the rule under the cursor and says what it checks', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Built-in rules/)
    await waitForText(view.lastFrame, /title-case/)
    expect(flat(view.lastFrame())).toContain('Placeholder missing or added')
    view.stdin.write(keys.down)
    await waitForText(view.lastFrame, /HTML tags differ/)
    expect(flat(view.lastFrame())).not.toContain('Placeholder missing or added')
  })

  it('saves the toggle so the rule starts running for the locale', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Built-in rules/)
    await select(view, /\[ \] title-case/)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await waitForText(view.lastFrame, /unsaved/)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    expect(profileFor('tr').rules.has('title-case')).toBe(true)
    expect(profileFor('tr').rules.has('apostrophe')).toBe(false)
  })
})

describe('LocaleRules: glossary match', () => {
  it('steps the ratio and saves it', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Glossary match/)
    await waitForText(view.lastFrame, /0\.70/)
    view.stdin.write(keys.right)
    await tick()
    view.stdin.write(keys.right)
    await waitForText(view.lastFrame, /0\.80/)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    expect(loadLocaleRules('tr')?.glossaryStemRatio).toBe(0.8)
  })
})

async function typeInto(view: View, text: string) {
  view.stdin.write(text)
  await tick()
}

describe('LocaleRules: common mistakes', () => {
  it('adds a mistake with its right form and note, and saves it', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Common mistakes/)
    await waitForText(view.lastFrame, /No mistakes yet/)
    view.stdin.write('a')
    await waitForText(view.lastFrame, /Wrong:/)
    await typeInto(view, 'önizleme')
    view.stdin.write(keys.tab)
    await tick()
    await typeInto(view, 'ön izleme')
    view.stdin.write(keys.tab)
    await tick()
    await typeInto(view, 'TDK writes it as two words')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /önizleme → ön izleme/)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    const p = loadLocaleRules('tr')!.patterns[0]!
    expect(p).toMatchObject({ kind: 'mistake', text: 'önizleme', right: 'ön izleme', note: 'TDK writes it as two words' })
  })

  it('will not add a mistake with nothing to look for', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Common mistakes/)
    view.stdin.write('a')
    await waitForText(view.lastFrame, /Wrong:/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Wrong is required/)
  })

  it('edits and deletes a mistake', async () => {
    const file = localeRulesFile('tr')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'mistakes:\n  - wrong: önizleme\n  - wrong: eposta\n', 'utf8')
    const view = mount()
    await openLocale(view)
    await select(view, /Common mistakes/)
    await waitForText(view.lastFrame, /eposta/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Wrong:/)
    view.stdin.write(keys.tab)
    await tick()
    await typeInto(view, 'e-posta')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /önizleme → e-posta/)
    view.stdin.write(keys.down)
    await tick()
    view.stdin.write('d')
    await waitFor(() => !/eposta/.test(view.lastFrame()))
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    expect(loadLocaleRules('tr')!.patterns.map((p) => [p.text, p.right])).toEqual([['önizleme', 'e-posta']])
  })
})

describe('LocaleRules: proper nouns', () => {
  // From the Turkish rules file, which is where the list comes from now.
  it('starts from the list in the file and adds a name to it', async () => {
    installLocaleFixture('tr_TR.yaml')
    const view = mount()
    await openLocale(view)
    await select(view, /Proper nouns/)
    await waitForText(view.lastFrame, /Always capitalized/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Türkiye/)
    view.stdin.write('a')
    await waitForText(view.lastFrame, /Name:/)
    await typeInto(view, 'Anadolu')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Anadolu/)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    const always = loadLocaleRules('tr')!.properNouns!.always!
    expect(always).toContain('Türkiye')
    expect(always).toContain('Anadolu')
    // The other list was not touched, so it stays as the file had it.
    expect(loadLocaleRules('tr')!.properNouns!.dateOnly).toContain('Ocak')
  })
})

describe('LocaleRules: patterns', () => {
  it('adds a regex fix pattern and saves it', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Patterns/)
    await waitForText(view.lastFrame, /No patterns yet/)
    view.stdin.write('a')
    await waitForText(view.lastFrame, /Text:/)
    view.stdin.write(keys.tab) // Text stays empty
    await tick()
    await typeInto(view, '\\.\\.\\.')
    view.stdin.write(keys.tab) // Ignore case
    await tick()
    view.stdin.write(keys.tab) // Replace
    await tick()
    await typeInto(view, '…')
    view.stdin.write(keys.tab) // Level
    await tick()
    await typeInto(view, 'fix')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /fix/)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    expect(loadLocaleRules('tr')!.patterns[0]).toMatchObject({ kind: 'pattern', find: '\\.\\.\\.', replace: '…', level: 'fix' })
  })

  // Seen while typing, not when the save is refused.
  it('shows a bad regex as it is typed', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Patterns/)
    view.stdin.write('a')
    await waitForText(view.lastFrame, /Text:/)
    view.stdin.write(keys.tab)
    await tick()
    await typeInto(view, '(unclosed')
    await waitForText(view.lastFrame, /not a valid regular expression/)
  })

  it('refuses a fix pattern without a replacement', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Patterns/)
    view.stdin.write('a')
    await waitForText(view.lastFrame, /Text:/)
    await typeInto(view, 'x')
    for (let i = 0; i < 4; i++) {
      view.stdin.write(keys.tab)
      await tick()
    }
    await typeInto(view, 'fix')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /fix needs a replacement/)
  })
})

describe('LocaleRules: when the source lacks a text', () => {
  // The form once had a field for source only, so editing a pattern rebuilt
  // its when from that field and dropped notSource without a word.
  it('shows notSource and keeps it through an edit', async () => {
    const file = localeRulesFile('tr')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'schema: 2\npatterns:\n  - text: blog\n    when: { notSource: blog }\n', 'utf8')
    const view = mount()
    await openLocale(view)
    await select(view, /Patterns/)
    await waitForText(view.lastFrame, /when the source lacks "blog"/)
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /When source lacks:/)
    for (let i = 0; i < 7; i++) {
      view.stdin.write(keys.tab)
      await tick()
    }
    await typeInto(view, 'sitio')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /sitio/)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    const saved = loadLocaleRules('tr')!.patterns[0]!
    expect(saved).toMatchObject({ text: 'blog', whenNotSource: 'blog' })
    expect(saved.note).toContain('sitio')
    expect(saved).not.toHaveProperty('whenSource')
  })
})

describe('LocaleRules: trying the rules', () => {
  it('shows what fires on a sample under the unsaved rules', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Common mistakes/)
    view.stdin.write('a')
    await waitForText(view.lastFrame, /Wrong:/)
    await typeInto(view, 'önizleme')
    view.stdin.write(keys.enter)
    await tick()
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await select(view, /Try the rules/)
    await waitForText(view.lastFrame, /Source:/)
    await typeInto(view, 'Preview')
    view.stdin.write(keys.tab)
    await tick()
    await typeInto(view, 'Önizleme')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /custom/)
    expect(flat(view.lastFrame())).toMatch(/"önizleme"/)
  })
})

describe('LocaleRules: guidance', () => {
  it('types guidance over several lines, counts it, and saves it', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Guidance/)
    await waitForText(view.lastFrame, /0 of 1500/)
    await typeInto(view, 'Button labels are imperative.')
    view.stdin.write(keys.enter)
    await tick()
    await typeInto(view, 'Use siz.')
    await waitForText(view.lastFrame, /38 of 1500/)
    view.stdin.write(keys.backspace)
    await waitForText(view.lastFrame, /37 of 1500/)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    expect(loadLocaleRules('tr')?.guidance).toBe('Button labels are imperative.\nUse siz')
  })

  it('edits saved guidance in the middle, not only at the end', async () => {
    const file = localeRulesFile('tr')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'guidance: Use siz.\n', 'utf8')
    const view = mount()
    await openLocale(view)
    await select(view, /Guidance/)
    await waitForText(view.lastFrame, /8 of 1500/)
    for (let i = 0; i < 4; i++) {
      view.stdin.write(keys.right)
      await tick()
    }
    await typeInto(view, 'always ')
    await waitForText(view.lastFrame, /15 of 1500/)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
    expect(loadLocaleRules('tr')?.guidance).toBe('Use always siz.')
  })

  it('warns past the cap', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Guidance/)
    await typeInto(view, 'x'.repeat(1501))
    await waitForText(view.lastFrame, /1501 of 1500/)
    expect(flat(view.lastFrame())).toMatch(/too long/)
  })
})

describe('LocaleRules: copying', () => {
  async function saveOneMistake(view: View) {
    await select(view, /Common mistakes/)
    view.stdin.write('a')
    await waitForText(view.lastFrame, /Wrong:/)
    await typeInto(view, 'önizleme')
    view.stdin.write(keys.enter)
    await tick()
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write('s')
    await waitForText(view.lastFrame, /Saved/)
  }

  it('copies the saved rules to another locale', async () => {
    const view = mount()
    await openLocale(view)
    await saveOneMistake(view)
    await select(view, /Copy to another locale/)
    await waitForText(view.lastFrame, /To locale:/)
    await typeInto(view, 'az_TR')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Copied tr to az-tr/)
    expect(loadLocaleRules('az-tr')?.patterns.map((p) => p.text)).toEqual(['önizleme'])
  })

  // Copy takes the file on disk; with unsaved edits that is not what is on screen.
  it('asks to save first when there are unsaved edits', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Glossary match/)
    view.stdin.write(keys.right)
    await tick()
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    await select(view, /Copy to another locale/)
    await waitForText(view.lastFrame, /Save first/)
    view.stdin.write(keys.esc)
    await waitForText(view.lastFrame, /Built-in rules/)
  })

  it('will not replace an existing file unless asked', async () => {
    const view = mount()
    await openLocale(view)
    await saveOneMistake(view)
    const file = localeRulesFile('az-tr')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'guidance: Mine.\n', 'utf8')
    await select(view, /Copy to another locale/)
    await waitForText(view.lastFrame, /To locale:/)
    await typeInto(view, 'az_TR')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /already exists/)
    expect(await readFile(file, 'utf8')).toBe('guidance: Mine.\n')
    view.stdin.write(keys.tab)
    await tick()
    await typeInto(view, 'y')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /Copied tr to az-tr/)
  })
})

describe('LocaleRules: leaving', () => {
  it('asks before discarding unsaved changes, and discards on d', async () => {
    let back = 0
    const view = mount(() => back++)
    await openLocale(view)
    await select(view, /Glossary match/)
    view.stdin.write(keys.right)
    await tick()
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    view.stdin.write(keys.esc)
    await waitForText(view.lastFrame, /Unsaved changes/)
    expect(back).toBe(0)
    view.stdin.write('d')
    await waitFor(() => back === 1)
    expect(loadLocaleRules('tr')).toBeUndefined()
  })

  it('leaves at once when nothing changed', async () => {
    let back = 0
    const view = mount(() => back++)
    await openLocale(view)
    view.stdin.write(keys.esc)
    await waitFor(() => back === 1)
  })

  // Saving re-reviews the locale's files; the person should know before.
  it('says what saving costs', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Glossary match/)
    view.stdin.write(keys.right)
    await tick()
    view.stdin.write(keys.esc)
    await waitForText(view.lastFrame, /next review of every tr file starts over/)
  })

  it('shows why a save failed, and keeps the edits', async () => {
    const view = mount()
    await openLocale(view)
    await select(view, /Glossary match/)
    view.stdin.write(keys.right)
    await tick()
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    // Someone edits the file in another window meanwhile.
    const file = localeRulesFile('tr')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'guidance: Elsewhere.\n', 'utf8')
    view.stdin.write('s')
    await waitForText(view.lastFrame, /changed on disk/)
    expect(await readFile(file, 'utf8')).toBe('guidance: Elsewhere.\n')
    expect(view.lastFrame()).toMatch(/unsaved/)
  })
})

describe('Menu entry', () => {
  it('reaches the locale rules screen', async () => {
    const view = render(<App commands={fakeCommands()} />)
    await tick()
    await openFromHome(view.stdin, 'locale-rules')
    await waitForText(view.lastFrame, /Locale rules/)
  })
})
