import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { useState } from 'react'
import { Text } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'
import { InputGate, TextArea, TextInput, TypingProvider, useInput, useTyping } from '../../src/tui/input.js'
import { render, tick, cleanup, keys } from './helpers.js'

afterEach(() => cleanup())

const TUI_SRC = join(import.meta.dirname, '../../src/tui')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

// An overlay sits on top of a screen that cannot be unmounted, because a run
// would die with it. The only thing keeping keys from leaking through is that
// every listener goes through the gate, so this holds the whole tree to it.
describe('the input gate covers every listener', () => {
  it('leaves input.tsx as the only importer of raw Ink input and the input widgets', () => {
    const offenders = sources(TUI_SRC)
      .filter((path) => !path.endsWith('/input.tsx'))
      .filter((path) => {
        const text = readFileSync(path, 'utf8')
        return (
          /import\s*\{[^}]*\buseInput\b[^}]*\}\s*from\s*'ink'/.test(text) ||
          /from\s*'ink-text-input'/.test(text) ||
          /from\s*'ink-select-input'/.test(text) ||
          /from\s*'react-ink-textarea'/.test(text)
        )
      })
      .map((path) => relative(TUI_SRC, path))
    expect(offenders).toEqual([])
  })
})

function Listener({ onKey }: { onKey: (input: string) => void }) {
  useInput((input) => onKey(input))
  return <Text>listening</Text>
}

function Field() {
  const [value, setValue] = useState('')
  return (
    <>
      <TextInput value={value} onChange={setValue} />
      <Text>[{value}]</Text>
    </>
  )
}

function TypingProbe() {
  const typing = useTyping()
  return <Text>typing={String(typing.current())}</Text>
}

describe('InputGate', () => {
  it('passes keys through when open', async () => {
    const seen: string[] = []
    const { stdin } = render(
      <InputGate open>
        <Listener onKey={(k) => seen.push(k)} />
      </InputGate>,
    )
    await tick()
    stdin.write('x')
    await tick()
    expect(seen).toEqual(['x'])
  })

  it('holds keys back from hooks and text fields when closed', async () => {
    const seen: string[] = []
    const { stdin, lastFrame } = render(
      <InputGate open={false}>
        <Listener onKey={(k) => seen.push(k)} />
        <Field />
      </InputGate>,
    )
    await tick()
    stdin.write('x')
    await tick()
    expect(seen).toEqual([])
    expect(lastFrame()).toContain('[]')
  })

  it('closes for everything beneath a nested closed gate even when the outer one is open', async () => {
    const seen: string[] = []
    const { stdin } = render(
      <InputGate open>
        <InputGate open={false}>
          <Listener onKey={(k) => seen.push(k)} />
        </InputGate>
      </InputGate>,
    )
    await tick()
    stdin.write('x')
    await tick()
    expect(seen).toEqual([])
  })
})

describe('typing', () => {
  it('reports a focused text field, so printable global keys stand down', async () => {
    const { lastFrame, rerender } = render(
      <TypingProvider>
        <TypingProbe />
      </TypingProvider>,
    )
    await tick()
    expect(lastFrame()).toContain('typing=false')
    rerender(
      <TypingProvider>
        <Field />
        <TypingProbe />
      </TypingProvider>,
    )
    await tick()
    rerender(
      <TypingProvider>
        <Field />
        <TypingProbe />
      </TypingProvider>,
    )
    await tick()
    expect(lastFrame()).toContain('typing=true')
  })
})

function Area({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <TextArea value={value} onChange={setValue} />
      <Text>[{JSON.stringify(value)}]</Text>
    </>
  )
}

async function type(stdin: { write(data: string): void }, text: string) {
  for (const ch of text) {
    stdin.write(ch)
    await tick()
  }
}

describe('TextArea', () => {
  it('starts a new line on enter rather than submitting', async () => {
    const { stdin, lastFrame } = render(<Area />)
    await tick()
    await type(stdin, 'ab')
    stdin.write(keys.enter)
    await tick()
    await type(stdin, 'c')
    expect(lastFrame()).toContain('["ab\\nc"]')
  })

  it('opens with the cursor at the start and edits in the middle of the text', async () => {
    const { stdin, lastFrame } = render(<Area initial="Hello world" />)
    await tick()
    for (let i = 0; i < 6; i++) {
      stdin.write(keys.right)
      await tick()
    }
    await type(stdin, 'big ')
    expect(lastFrame()).toContain('["Hello big world"]')
  })

  it('clears the whole text on ctrl+x', async () => {
    const { stdin, lastFrame } = render(<Area initial={'First line\nSecond line'} />)
    await tick()
    stdin.write('\x18')
    await tick()
    expect(lastFrame()).toContain('[""]')
  })

  it('leaves ctrl+k to the palette rather than deleting to the end of the line', async () => {
    const { stdin, lastFrame } = render(<Area initial="Keep all of this" />)
    await tick()
    stdin.write('\x0b')
    await tick()
    expect(lastFrame()).toContain('["Keep all of this"]')
  })

  it('takes no keys under a closed gate', async () => {
    const { stdin, lastFrame } = render(
      <InputGate open={false}>
        <Area />
      </InputGate>,
    )
    await tick()
    await type(stdin, 'x')
    expect(lastFrame()).toContain('[""]')
  })

  it('reports itself as a focused text field', async () => {
    const tree = () => (
      <TypingProvider>
        <Area />
        <TypingProbe />
      </TypingProvider>
    )
    const { lastFrame, rerender } = render(tree())
    await tick()
    rerender(tree())
    await tick()
    expect(lastFrame()).toContain('typing=true')
  })
})
