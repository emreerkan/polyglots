import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { configDir, configFile } from '../../src/paths.js'
import type { TranslateOptions } from '../../src/commands/translate.js'
import { CommandsProvider } from '../../src/tui/commands.js'
import { Translate } from '../../src/tui/screens/Translate.js'
import { formatSummary } from '../../src/tui/components/Progress.js'
import { ESC_DELAY, fakeCommands, flat, keys, makeHome, render, scriptedTranslate, tick, waitFor, waitForText, cleanup, type Home } from './helpers.js'
import { DEFAULT_QWEN_MODEL } from '../../src/draft/qwen.js'
import { ProviderRefusal } from '../../src/agent/agy-check.js'

let home: Home
let cwd: string
let poFile: string

beforeEach(async () => {
  home = await makeHome()
  // Named rather than assumed: polyglots has no default locale (no-locale.test.tsx).
  saveConfig({ defaultLocale: 'tr' })
  cwd = join(home.path, 'work')
  await mkdir(cwd)
  poFile = join(cwd, 'plugin-tr.po')
  await writeFile(poFile, '')
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

function mount(commands = fakeCommands(), onBack: () => void = () => undefined) {
  return render(
    <CommandsProvider value={commands}>
      <Translate cwd={cwd} onBack={onBack} />
    </CommandsProvider>,
  )
}

async function pickFile(stdin: { write(data: string): void }, lastFrame: () => string | undefined) {
  await waitForText(lastFrame, 'plugin-tr.po')
  stdin.write(keys.down)
  await tick()
  stdin.write(keys.enter)
  await waitForText(lastFrame, /Draft engine/)
}

describe('Translate options', () => {
  // The locale is no longer a row of the form: the header names it. What the
  // config holds is read off the run the form starts.
  it('defaults to the configured engine and locale', async () => {
    saveConfig({ defaultDraftEngine: 'openai', defaultLocale: 'de' })
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    const frame = lastFrame() ?? ''
    expect(frame).toMatch(/Draft engine:\s+openai/)
    expect(frame).not.toContain('Locale:')
    expect(frame).toMatch(/Mode:\s+pending/)
    for (let i = 0; i < 4; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.enter)
    await waitFor(() => (commands.translateFile as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect((commands.translateFile as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ draftEngine: 'openai', locale: 'de' })
  })

  it('toggles mode and engine with the arrow keys', async () => {
    const { lastFrame, stdin } = mount()
    await pickFile(stdin, lastFrame)
    stdin.write(keys.right)
    await waitForText(lastFrame, /Mode:\s+all/)
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.right)
    await waitForText(lastFrame, /Draft engine:\s+openai/)
    stdin.write(keys.left)
    await waitForText(lastFrame, /Draft engine:\s+deepl/)
  })
})

describe('Translate with no draft engine', () => {
  it('offers none as an engine and says what it does', async () => {
    const { lastFrame, stdin } = mount()
    await pickFile(stdin, lastFrame)
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.left)
    await waitForText(lastFrame, /Draft engine:\s+none/)
    expect(flat(lastFrame())).toContain('Fills from the translation memory only')
  })

  it('says when the drafts will be written unreviewed', async () => {
    saveConfig({ reviewProvider: 'none' })
    const { lastFrame, stdin } = mount()
    await pickFile(stdin, lastFrame)
    expect(flat(lastFrame())).toContain('No review provider: drafts are written fuzzy')
  })

  it('counts what was left untranslated', () => {
    expect(formatSummary({ file: 'x.po', total: 9, pending: 7, fromTm: 2, translated: 0, fuzzy: 0, skipped: 0, untranslated: 5 })).toBe(
      'Done. 2 from TM, 5 left untranslated (no memory match).',
    )
  })
})

describe('Translate run', () => {
  it('passes the chosen options to translateFile and shows the summary', async () => {
    const calls: TranslateOptions[] = []
    const commands = fakeCommands({
      translateFile: vi.fn(async (opts: TranslateOptions) => {
        calls.push(opts)
        return scriptedTranslate((file) => [
          { type: 'start', file, total: 8, pending: 3 },
          { type: 'tm-hit', count: 1 },
          { type: 'batch-start', index: 1, of: 1, size: 2, at: Date.now() },
          { type: 'batch-done', index: 1, translated: 2, fuzzy: 1, at: Date.now() },
          { type: 'saved' },
          { type: 'done', summary: { file, total: 8, pending: 3, fromTm: 1, translated: 2, fuzzy: 1, skipped: 0 } },
        ])(opts)
      }),
    })
    let back = 0
    const { lastFrame, stdin } = mount(commands, () => back++)
    await pickFile(stdin, lastFrame)

    stdin.write(keys.right)
    await waitForText(lastFrame, /Mode:\s+all/)
    for (let i = 0; i < 4; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Done. 2 translated, 1 fuzzy, 1 from TM, 0 skipped.')
    expect(flat(lastFrame())).toContain(`Open ${poFile} in your .po editor to review.`)
    await waitForText(lastFrame, 'enter/q back to menu')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ file: poFile, mode: 'all', draftEngine: 'deepl', locale: 'tr' })
    expect(typeof calls[0]!.onProgress).toBe('function')

    stdin.write(keys.enter)
    await tick()
    expect(back).toBe(1)
  })



  it('ignores q and escape while a run is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const commands = fakeCommands({
      translateFile: vi.fn(async (opts: TranslateOptions) => {
        opts.onProgress?.({ type: 'start', file: opts.file, total: 4, pending: 2 })
        await gate
        const summary = { file: opts.file, total: 4, pending: 2, fromTm: 0, translated: 2, fuzzy: 0, skipped: 0 }
        opts.onProgress?.({ type: 'done', summary })
        return summary
      }),
    })
    let back = 0
    const { lastFrame, stdin } = mount(commands, () => back++)
    await pickFile(stdin, lastFrame)
    for (let i = 0; i < 5; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.enter)
    await waitForText(lastFrame, /0\/2/)

    stdin.write('q')
    stdin.write(keys.esc)
    await tick(ESC_DELAY)
    expect(back).toBe(0)

    release()
    await waitForText(lastFrame, 'Done. 2 translated')
    stdin.write('q')
    await tick()
    expect(back).toBe(1)
  })

  it('shows the error when translateFile rejects', async () => {
    const commands = fakeCommands({
      translateFile: vi.fn(async () => {
        throw new Error('DEEPL_API_KEY is not set')
      }),
    })
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    for (let i = 0; i < 5; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'DEEPL_API_KEY is not set')
  })

  // A refusal is the provider check stopping the run before it spent
  // anything: the run ends stopped, so the screen must not call it a failure.
  it('says a provider refusal stopped the run, not that it failed', async () => {
    const commands = fakeCommands({
      translateFile: vi.fn(async () => {
        throw new ProviderRefusal('antigravity is signed out. Run agy once to sign in, then start again.')
      }),
    })
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    for (let i = 0; i < 5; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.enter)
    await waitForText(lastFrame, 'Stopped: antigravity is signed out.')
    expect(flat(lastFrame())).not.toContain('Translation failed')
  })
})

/**
 * Translate asked twice: once on "Start translation" and again at a [y/N].
 * Review asks once, and so does the translate command, whose confirmation is
 * scoped to --all (cli.ts: `flags.all === true && flags.yes !== true`). The
 * second question only earns its place on the mode that overwrites entries
 * that already have a translation, in a file translate saves in place.
 */
describe('Translate starting a run', () => {
  it('starts a pending run straight from the options, with no confirmation', async () => {
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    for (let i = 0; i < 5; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.enter)

    await waitFor(() => (commands.translateFile as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect(lastFrame()).not.toContain('[y/N]')
    expect((commands.translateFile as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ mode: 'pending' })
  })

  // The review pass of a translate run spawns the configured provider, so it
  // must run the binary discovery checked, not whatever is first on PATH.
  it('runs the agent binary named by POLYGLOTS_AGENT_BIN', async () => {
    vi.stubEnv('POLYGLOTS_AGENT_BIN', '/opt/claude/bin/claude')
    try {
      const commands = fakeCommands()
      const { lastFrame, stdin } = mount(commands)
      await pickFile(stdin, lastFrame)
      for (let i = 0; i < 5; i++) {
        stdin.write(keys.down)
        await tick()
      }
      stdin.write(keys.enter)

      await waitFor(() => (commands.translateFile as ReturnType<typeof vi.fn>).mock.calls.length > 0)
      expect((commands.translateFile as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
        bin: '/opt/claude/bin/claude',
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  /**
   * `all` does not ask either. Choosing it is the choice, and it is spelled out
   * on the screen where it is made: re-translating entries that already have a
   * translation is the point of the mode, not a mistake to be caught on the way
   * out.
   */
  it('starts an all run without asking, having said what it will do', async () => {
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    stdin.write(keys.right)
    await waitForText(lastFrame, /Mode:\s+all/)
    // Said on the options screen, where the mode is chosen.
    expect(flat(lastFrame())).toMatch(/re-translate already-translated entries/i)

    for (let i = 0; i < 5; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.enter)

    await waitFor(() => (commands.translateFile as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect(lastFrame()).not.toContain('[y/N]')
    expect((commands.translateFile as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ mode: 'all' })
  })
})

/**
 * translateFile has taken a batch size since it had batches, the CLI has
 * --batch-size, and review's screen has offered the choice for releases. This
 * screen never passed one, so a translate run in the TUI was stuck on the
 * configured default however large the file.
 */
describe('Translate batch size', () => {
  it('offers the batch size and passes the chosen one to translateFile', async () => {
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    expect(flat(lastFrame())).toMatch(/Batch size:\s+25/)

    for (let i = 0; i < 2; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.right)
    await waitForText(lastFrame, /Batch size:\s+50/)
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)

    await waitFor(() => (commands.translateFile as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect((commands.translateFile as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ batchSize: 50 })
  })
})

/**
 * Draft keys hold only the source, so mode all on a file translated before
 * re-translated every entry from the cache and changed nothing. The CLI has
 * had --fresh, and the batch form a Start over field; this screen had
 * neither, so there was no way here to draft again.
 */
describe('Translate start over', () => {
  it('reuses the cache by default', async () => {
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    expect(flat(lastFrame())).toMatch(/Start over:\s+no, reuse what is cached/)
    for (let i = 0; i < 5; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.enter)
    await waitFor(() => (commands.translateFile as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect((commands.translateFile as ReturnType<typeof vi.fn>).mock.calls[0]![0]).not.toHaveProperty('fresh')
  })

  it('passes fresh when start over is chosen', async () => {
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    for (let i = 0; i < 3; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.right)
    await waitForText(lastFrame, /Start over:\s+yes, ignore what is cached/)
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.enter)
    await waitFor(() => (commands.translateFile as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect((commands.translateFile as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ fresh: true })
  })
})

describe('Translate with the local engine', () => {
  async function toQwen(stdin: { write(data: string): void }, lastFrame: () => string | undefined) {
    stdin.write(keys.down)
    await tick()
    stdin.write(keys.right)
    await waitForText(lastFrame, /Draft engine:\s+openai/)
    stdin.write(keys.right)
    await waitForText(lastFrame, /Draft engine:\s+local/)
  }

  it('checks the model and names it under the engine', async () => {
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    await toQwen(stdin, lastFrame)
    await waitForText(() => flat(lastFrame()), `Model: ${DEFAULT_QWEN_MODEL} at http://localhost:11434 (Ollama)`)
    expect(commands.checkLocalModel).toHaveBeenCalledWith({ kind: 'ollama', baseUrl: 'http://localhost:11434', model: `${DEFAULT_QWEN_MODEL}` })
  })

  it('shows the warning when the model is missing, and still starts', async () => {
    const message = `${DEFAULT_QWEN_MODEL} is not installed in Ollama at http://localhost:11434. Pull it with: ollama pull ${DEFAULT_QWEN_MODEL}`
    const commands = fakeCommands({
      checkLocalModel: vi.fn(async (o: { baseUrl: string; model: string }) => ({ state: 'missing' as const, ...o, message })),
    })
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    await toQwen(stdin, lastFrame)
    await waitForText(() => flat(lastFrame()), `Pull it with: ollama pull ${DEFAULT_QWEN_MODEL}`)
    for (let i = 0; i < 4; i++) {
      stdin.write(keys.down)
      await tick()
    }
    stdin.write(keys.enter)
    await waitFor(() => (commands.translateFile as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect((commands.translateFile as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ draftEngine: 'local' })
  })

  it('shows nothing extra when the check rejects', async () => {
    const commands = fakeCommands({ checkLocalModel: vi.fn(async () => Promise.reject(new Error('boom'))) })
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    await toQwen(stdin, lastFrame)
    await waitForText(() => flat(lastFrame()), `Model: ${DEFAULT_QWEN_MODEL}`)
    await tick(10)
    expect(lastFrame()).not.toContain('boom')
  })

  it('never checks for a metered engine', async () => {
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    await tick(10)
    expect(lastFrame()).not.toContain('Model:')
    expect(commands.checkLocalModel).not.toHaveBeenCalled()
  })

  // A config saved before the rename still says qwen; the screen must show
  // and run the engine it means, not an engine nobody can cycle back to.
  it('reads a saved qwen as local', async () => {
    await mkdir(configDir(), { recursive: true })
    await writeFile(configFile(), JSON.stringify({ defaultDraftEngine: 'qwen' }))
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    await waitForText(lastFrame, /Draft engine:\s+local/)
  })

  it('names an OpenAI-compatible model with its server', async () => {
    saveConfig({ defaultDraftEngine: 'local', localServerKind: 'openai-compatible', openaiCompatible: { baseUrl: 'http://localhost:1234', model: 'qwen/qwen3-8b' } })
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    await waitForText(() => flat(lastFrame()), 'Model: qwen/qwen3-8b at http://localhost:1234 (OpenAI-compatible)')
    expect(commands.checkLocalModel).toHaveBeenCalledWith({ kind: 'openai-compatible', baseUrl: 'http://localhost:1234', model: 'qwen/qwen3-8b' })
  })

  it('says what to do when the OpenAI-compatible server has no model chosen', async () => {
    saveConfig({ defaultDraftEngine: 'local', localServerKind: 'openai-compatible' })
    const commands = fakeCommands()
    const { lastFrame, stdin } = mount(commands)
    await pickFile(stdin, lastFrame)
    await waitForText(() => flat(lastFrame()), 'openaiCompatible.model is not set')
    expect(commands.checkLocalModel).not.toHaveBeenCalled()
  })
})
