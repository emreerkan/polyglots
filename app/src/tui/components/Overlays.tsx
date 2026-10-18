import { useState } from 'react'
import { Box, Text } from 'ink'
import { TOKENS } from '../../ui/tokens.js'
import { useKeys } from '../hooks/useKeys.js'
import { TextInput } from '../input.js'
import { GLOBAL_KEYS, SCREEN_KEYS, type KeyHelp } from '../keys.js'
import { findNode, HOME, walk, type ScreenId } from '../menu.js'
import { useGlyphs } from '../theme.js'

// What draws over a screen: contextual help, the palette and the quit prompt.
// Each takes the body's place while the screen stays mounted, hidden, behind
// a closed input gate, so a run in it keeps going.

function KeyTable({ rows }: { rows: KeyHelp[] }) {
  const width = Math.max(0, ...rows.map((r) => r.keys.length))
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => (
        <Text key={i}>
          {'  '}
          <Text {...TOKENS.accent.ink}>{r.keys.padEnd(width)}</Text>  {r.does}
        </Text>
      ))}
    </Box>
  )
}

const HOME_HELP =
  'Each card opens a screen; Tools and Configuration open a second level. The header shows the review provider and how much of setup is done. Tab moves to the setup status, where enter opens the step that needs doing.'

// Fits the help to the rows the frame has. The screen's own keys come first
// because they are what the person pressed ? for; the global keys go when
// space runs out, since they are the same everywhere and the help page has
// them. Without this Ink shrinks the box and draws its lines over each other.
export function helpRows(screen: ScreenId, room: number): { keys: KeyHelp[]; globals: KeyHelp[]; trimmed: boolean } {
  const keys = SCREEN_KEYS[screen]
  // Two border rows, the title, up to three lines of prose, two section
  // headings and the closing hint.
  const fixed = 9
  const free = Math.max(0, room - fixed)
  const shownKeys = keys.slice(0, free)
  const shownGlobals = GLOBAL_KEYS.slice(0, Math.max(0, free - shownKeys.length))
  return { keys: shownKeys, globals: shownGlobals, trimmed: shownKeys.length < keys.length || shownGlobals.length < GLOBAL_KEYS.length }
}

export function HelpOverlay({ screen, rows, onClose }: { screen: ScreenId; rows: number; onClose: () => void }) {
  useKeys({ helpOverlay: { close: onClose } })
  const node = findNode(screen)
  const { keys, globals, trimmed } = helpRows(screen, rows)
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexShrink={0}>
      <Text {...TOKENS.heading.ink}>{node?.label ?? 'Home'}</Text>
      <Text wrap="wrap">{node?.help ?? HOME_HELP}</Text>
      {keys.length > 0 && (
        <>
          <Text {...TOKENS.heading.ink}>Keys on this screen</Text>
          <KeyTable rows={keys} />
        </>
      )}
      {globals.length > 0 && (
        <>
          <Text {...TOKENS.heading.ink}>Everywhere</Text>
          <KeyTable rows={globals} />
        </>
      )}
      <Text {...TOKENS.muted.ink}>
        esc or ? to close{trimmed ? ' · more keys on the help page, h on home' : ' · h on home for the full help page'}
      </Text>
    </Box>
  )
}

export interface PaletteEntry {
  // 'locale' is the locale picker, which is an overlay rather than a screen.
  id: ScreenId | 'locale'
  label: string
}

/**
 * Every screen, named by its path through the menu: "Tools › Split a .po into
 * parts". Then the locale picker, which is reached from anywhere and so sits
 * under no menu: someone who has forgotten l finds it here by typing "locale".
 */
export function paletteEntries(separator = '›'): PaletteEntry[] {
  const labelOf = new Map(HOME.map((n) => [n.id, n.label]))
  const screens: PaletteEntry[] = walk()
    .filter((e) => !e.node.children)
    .map((e) => ({
      id: e.node.id,
      label: e.parent ? `${labelOf.get(e.parent.id)} ${separator} ${e.node.label}` : e.node.label,
    }))
  return [...screens, { id: 'locale', label: 'Change locale' }]
}

/**
 * A subsequence match scored for how tight it is, or undefined when the
 * letters are not all there in order. Lower is better: a match that starts
 * early and runs together beats one strung out across the label.
 */
export function fuzzyScore(query: string, label: string): number | undefined {
  const q = query.toLowerCase().replace(/\s+/g, '')
  const l = label.toLowerCase()
  if (q === '') return 0
  let at = -1
  let first = -1
  let gaps = 0
  for (const ch of q) {
    const next = l.indexOf(ch, at + 1)
    if (next < 0) return undefined
    if (first < 0) first = next
    else gaps += next - at - 1
    at = next
  }
  return first + gaps * 2
}

export function rankPalette(query: string, entries: PaletteEntry[]): PaletteEntry[] {
  return entries
    .map((entry, i) => ({ entry, i, score: fuzzyScore(query, entry.label) }))
    .filter((r): r is { entry: PaletteEntry; i: number; score: number } => r.score !== undefined)
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((r) => r.entry)
}

const PALETTE_ROWS = 8

export interface PaletteProps {
  onPick: (id: PaletteEntry['id']) => void
  onClose: () => void
  blocked?: boolean
  // Off on setup, whose own first step chooses the locale.
  withLocale?: boolean
}

export function Palette({ onPick, onClose, blocked = false, withLocale = true }: PaletteProps) {
  const glyphs = useGlyphs()
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const matches = rankPalette(
    query,
    paletteEntries(glyphs.next).filter((e) => withLocale || e.id !== 'locale'),
  )
  const chosen = Math.min(at, Math.max(0, matches.length - 1))
  useKeys({
    palette: {
      close: onClose,
      move: (_input, key) => (key.upArrow ? setAt(Math.max(0, chosen - 1)) : setAt(Math.min(matches.length - 1, chosen + 1))),
    },
  })
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexShrink={0}>
      <Box>
        <Text {...TOKENS.heading.ink}>Go to </Text>
        <TextInput
          value={query}
          onChange={(v) => {
            setQuery(v)
            setAt(0)
          }}
          onSubmit={() => {
            const pick = matches[chosen]
            if (pick) onPick(pick.id)
          }}
        />
      </Box>
      {matches.slice(0, PALETTE_ROWS).map((m, i) => (
        <Text key={m.id} wrap="truncate-end">
          <Text {...TOKENS.accent.ink}>{i === chosen ? glyphs.next : ' '}</Text> <Text bold={i === chosen}>{m.label}</Text>
        </Text>
      ))}
      {matches.length === 0 && <Text {...TOKENS.muted.ink}>Nothing matches.</Text>}
      {blocked && <Text {...TOKENS.warn.ink}>A run is in progress on this screen. Leave it once the run has finished or been stopped.</Text>}
      <Text {...TOKENS.muted.ink}>type to filter · ↑↓ choose · enter go · esc close</Text>
    </Box>
  )
}

export function QuitPrompt({ onQuit, onCancel }: { onQuit: () => void; onCancel: () => void }) {
  useKeys({ quitPrompt: { quit: onQuit, stay: onCancel } })
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexShrink={0} {...(TOKENS.warn.ink.color ? { borderColor: TOKENS.warn.ink.color } : {})}>
      <Text {...TOKENS.heading.ink}>A run is still going.</Text>
      <Text>Quitting now stops it part way. Work already finished is cached and a rerun picks up from there.</Text>
      <Text> </Text>
      <Text>
        <Text {...TOKENS.accent.ink}>y</Text> quit anyway · <Text {...TOKENS.accent.ink}>n</Text>/esc keep going ·{' '}
        <Text {...TOKENS.accent.ink}>ctrl+c</Text> again to quit
      </Text>
    </Box>
  )
}
