import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import React from 'react'
import { saveConfig } from '../../src/config.js'
import { App } from '../../src/tui/App.js'
import { VERSION } from '../../src/version.js'
import { cleanup, fakeCommands, flat, makeHome, render, waitForText, type Home } from './helpers.js'

let home: Home
beforeEach(async () => {
  home = await makeHome()
  saveConfig({ defaultLocale: 'tr', reviewProvider: 'none' })
})
afterEach(async () => {
  cleanup()
  await home.cleanup()
})

describe('a newer version in the header', () => {
  it('is shown beside the version once the check answers', async () => {
    const { lastFrame } = render(<App commands={fakeCommands()} update={Promise.resolve('9.9.9')} />)
    await waitForText(() => flat(lastFrame()), `${VERSION} ! 9.9.9 available`)
  })

  it('is shown in the narrow layout too', async () => {
    const { lastFrame } = render(<App commands={fakeCommands()} update={Promise.resolve('9.9.9')} />, { columns: 70, rows: 30 })
    await waitForText(() => flat(lastFrame()), '9.9.9 available')
  })

  it('is absent when there is nothing newer', async () => {
    const { lastFrame } = render(<App commands={fakeCommands()} update={Promise.resolve(undefined)} />)
    await waitForText(() => flat(lastFrame()), VERSION)
    expect(flat(lastFrame())).not.toContain('available')
  })
})
