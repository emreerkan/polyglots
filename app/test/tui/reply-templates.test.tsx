import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveConfig } from '../../src/config.js'
import { configFile } from '../../src/paths.js'
import { starterTemplate, templateFile } from '../../src/reply/templates.js'
import { App } from '../../src/tui/App.js'
import { CommandsProvider } from '../../src/tui/commands.js'
import { ReplyTemplates } from '../../src/tui/screens/ReplyTemplates.js'
import { cleanup, ESC_DELAY, fakeCommands, flat, keys, makeHome, openFromHome, render, tick, waitForText, type Home } from './helpers.js'

// What a terminal sends for ctrl+s once Ink has it in raw mode.
const CTRL_S = '\x13'
const CTRL_X = '\x18'

let home: Home

beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr' })
})

afterEach(async () => {
  cleanup()
  await home.cleanup()
})

function mount(onBack: () => void = () => undefined) {
  return render(
    <CommandsProvider value={fakeCommands()}>
      <ReplyTemplates onBack={onBack} />
    </CommandsProvider>,
  )
}

async function writeTemplate(name: string, text: string) {
  const file = templateFile('tr', name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  return file
}

async function type(view: ReturnType<typeof mount>, text: string) {
  for (const ch of text) {
    view.stdin.write(ch)
    await tick()
  }
}

describe('Reply templates screen', () => {
  it('says there are none yet and how to make one', async () => {
    const view = mount()
    await waitForText(view.lastFrame, /Reply templates/)
    expect(flat(view.lastFrame())).toContain('No reply templates for tr_TR yet. Press n to create one from a starter.')
  })

  it('creates a template from its starter with n and a name', async () => {
    const view = mount()
    await waitForText(view.lastFrame, /Reply templates/)
    view.stdin.write('n')
    await waitForText(view.lastFrame, /New template name/)
    await type(view, 'declined')
    view.stdin.write(keys.enter)
    // Straight into the editor: a new template is made to be rewritten.
    await waitForText(view.lastFrame, /Editing declined/)
    expect(await readFile(templateFile('tr', 'declined'), 'utf8')).toBe(starterTemplate('tr', 'declined'))
  })

  it('refuses a name that already exists and keeps the file', async () => {
    const file = await writeTemplate('approved', 'Mine.')
    const view = mount()
    await waitForText(view.lastFrame, /❯ approved/)
    view.stdin.write('n')
    await waitForText(view.lastFrame, /New template name/)
    await type(view, 'approved')
    view.stdin.write(keys.enter)
    await waitForText(view.lastFrame, /already exists/)
    expect(await readFile(file, 'utf8')).toBe('Mine.')
  })

  it('previews the highlighted template clean, and with problems after v', async () => {
    await writeTemplate('approved', starterTemplate('tr', 'approved'))
    const view = mount()
    await waitForText(view.lastFrame, /There were no problems\./)
    expect(flat(view.lastFrame())).toContain('Hello @requester,')
    view.stdin.write('v')
    await waitForText(view.lastFrame, /There were a few problems, and I fixed them\./)
    expect(flat(view.lastFrame())).toContain('I fixed 3 entries')
  })

  it('moves the preview with the highlight', async () => {
    await writeTemplate('approved', 'Approved text.')
    await writeTemplate('declined', 'Not yet text.')
    const view = mount()
    await waitForText(view.lastFrame, /Approved text\./)
    view.stdin.write(keys.down)
    await waitForText(view.lastFrame, /Not yet text\./)
  })

  it('deletes the highlighted template after d and y', async () => {
    const file = await writeTemplate('approved', 'Mine.')
    const view = mount()
    await waitForText(view.lastFrame, /❯ approved/)
    view.stdin.write('d')
    await waitForText(view.lastFrame, /Delete the approved reply template\?/)
    view.stdin.write('y')
    await waitForText(view.lastFrame, /Deleted approved\./)
    expect(existsSync(file)).toBe(false)
    expect(flat(view.lastFrame())).toContain('No reply templates for tr_TR yet.')
  })

  it('keeps the template when the deletion is not confirmed', async () => {
    const file = await writeTemplate('approved', 'Mine.')
    const view = mount()
    await waitForText(view.lastFrame, /❯ approved/)
    view.stdin.write('d')
    await waitForText(view.lastFrame, /Delete the approved reply template\?/)
    view.stdin.write('n')
    await tick()
    expect(flat(view.lastFrame())).not.toContain('Delete the approved')
    expect(existsSync(file)).toBe(true)
  })

  it('edits the highlighted template with e and saves it with ctrl+s', async () => {
    const file = await writeTemplate('approved', 'Hello world.')
    const view = mount()
    await waitForText(view.lastFrame, /❯ approved/)
    view.stdin.write('e')
    await waitForText(view.lastFrame, /Editing approved/)
    for (let i = 0; i < 6; i++) {
      view.stdin.write(keys.right)
      await tick()
    }
    await type(view, 'big ')
    view.stdin.write(keys.enter)
    await tick()
    view.stdin.write(CTRL_S)
    await waitForText(view.lastFrame, /Saved approved\./)
    expect(await readFile(file, 'utf8')).toBe('Hello big \nworld.')
    expect(flat(view.lastFrame())).not.toContain('Editing approved')
  })

  it('clears the template with ctrl+x, so new text can be pasted in', async () => {
    const file = await writeTemplate('approved', 'Old wording.')
    const view = mount()
    await waitForText(view.lastFrame, /❯ approved/)
    view.stdin.write('e')
    await waitForText(view.lastFrame, /Editing approved/)
    view.stdin.write(CTRL_X)
    await waitForText(view.lastFrame, /Cleared\./)
    view.stdin.write('New wording.')
    await tick()
    view.stdin.write(CTRL_S)
    await waitForText(view.lastFrame, /Saved approved\./)
    expect(await readFile(file, 'utf8')).toBe('New wording.')
  })

  it('types letters that are keys elsewhere on the screen while editing', async () => {
    const file = await writeTemplate('approved', '')
    const view = mount()
    await waitForText(view.lastFrame, /❯ approved/)
    view.stdin.write('e')
    await waitForText(view.lastFrame, /Editing approved/)
    await type(view, 'dnvq')
    view.stdin.write(CTRL_S)
    await waitForText(view.lastFrame, /Saved approved\./)
    expect(await readFile(file, 'utf8')).toBe('dnvq')
  })

  it('leaves the editor on esc without asking when nothing changed', async () => {
    await writeTemplate('approved', 'Mine.')
    const view = mount()
    await waitForText(view.lastFrame, /❯ approved/)
    view.stdin.write('e')
    await waitForText(view.lastFrame, /Editing approved/)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    expect(flat(view.lastFrame())).not.toContain('Editing approved')
    expect(flat(view.lastFrame())).not.toContain('Save the changes')
  })

  it('asks before throwing changes away, and keeps the file on n', async () => {
    const file = await writeTemplate('approved', 'Mine.')
    const view = mount()
    await waitForText(view.lastFrame, /❯ approved/)
    view.stdin.write('e')
    await waitForText(view.lastFrame, /Editing approved/)
    await type(view, 'x')
    view.stdin.write(keys.esc)
    await waitForText(view.lastFrame, /Save the changes to approved\?/)
    view.stdin.write('n')
    await tick()
    expect(flat(view.lastFrame())).not.toContain('Editing approved')
    expect(await readFile(file, 'utf8')).toBe('Mine.')
  })

  it('saves on y from the question', async () => {
    const file = await writeTemplate('approved', 'Mine.')
    const view = mount()
    await waitForText(view.lastFrame, /❯ approved/)
    view.stdin.write('e')
    await waitForText(view.lastFrame, /Editing approved/)
    await type(view, 'x')
    view.stdin.write(keys.esc)
    await waitForText(view.lastFrame, /Save the changes to approved\?/)
    view.stdin.write('y')
    await waitForText(view.lastFrame, /Saved approved\./)
    expect(await readFile(file, 'utf8')).toBe('xMine.')
  })

  it('goes back to editing on esc from the question', async () => {
    await writeTemplate('approved', 'Mine.')
    const view = mount()
    await waitForText(view.lastFrame, /❯ approved/)
    view.stdin.write('e')
    await waitForText(view.lastFrame, /Editing approved/)
    await type(view, 'x')
    view.stdin.write(keys.esc)
    await waitForText(view.lastFrame, /Save the changes to approved\?/)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    expect(flat(view.lastFrame())).toContain('Editing approved')
    expect(flat(view.lastFrame())).not.toContain('Save the changes')
  })

  it('asks for a locale when none is set', async () => {
    await writeFile(configFile(), '{}\n')
    const view = mount()
    await waitForText(view.lastFrame, /No locale set yet/)
  })

  it('goes back on esc', async () => {
    let back = false
    const view = mount(() => (back = true))
    await waitForText(view.lastFrame, /Reply templates/)
    view.stdin.write(keys.esc)
    await tick(ESC_DELAY)
    expect(back).toBe(true)
  })

  it('is reached from Configuration in the menu', async () => {
    const view = render(<App commands={fakeCommands()} />)
    await openFromHome(view.stdin, 'reply-templates')
    await waitForText(view.lastFrame, /No reply templates for tr_TR yet/)
  })
})
