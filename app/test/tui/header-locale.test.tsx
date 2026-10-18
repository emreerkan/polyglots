import { afterEach, describe, expect, it } from 'vitest'
import React from 'react'
import { Header } from '../../src/tui/components/Chrome.js'
import type { SetupStatus } from '../../src/tui/setup.js'
import { cleanup, flat, render } from './helpers.js'

// The header names the locale every run is for, ahead of the provider, so a
// person who switches locales can see which one a screen is about to act on.

afterEach(cleanup)

const status: SetupStatus = {
  steps: { locale: 'done', provider: 'done', credentials: 'done', glossary: 'done', memory: 'done', rules: 'done' },
  done: 6,
  total: 6,
} as unknown as SetupStatus

describe('Header locale', () => {
  it('shows the locale before the provider', () => {
    const { lastFrame } = render(<Header wordmark provider="codex" locale="nl" status={status} />)
    expect(flat(lastFrame())).toContain('locale nl · review codex')
  })

  it('shows locale none when none is configured', () => {
    const { lastFrame } = render(<Header wordmark provider="codex" status={status} />)
    expect(flat(lastFrame())).toContain('locale none · review codex')
  })

  it('shows it in the narrow layout too', () => {
    const { lastFrame } = render(<Header wordmark={false} provider="codex" locale="nl" status={status} />)
    expect(flat(lastFrame())).toContain('locale nl · review codex')
  })
})
