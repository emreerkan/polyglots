import { useState } from 'react'
import { Box, Text } from 'ink'
import { TOKENS } from '../../ui/tokens.js'
import { WPORG_LOCALES, localeId } from '../../wporg/locales.js'
import { useKeys } from '../hooks/useKeys.js'
import { TextInput } from '../input.js'
import { useGlyphs } from '../theme.js'

/** The locales that match what has been typed: by WordPress code, slug, or slug/set. */
export function matchLocales(query: string, limit = 8): Array<{ id: string; wp: string }> {
  const q = query.trim().toLowerCase().replace(/-/g, '_')
  const all = WPORG_LOCALES.map((l) => ({ id: localeId(l.slug, l.set), wp: l.wp }))
  if (q === '') return all.slice(0, limit)
  const exact = all.filter((l) => l.id === query.trim().toLowerCase() || l.wp.toLowerCase() === q)
  const starts = all.filter((l) => !exact.includes(l) && (l.wp.toLowerCase().startsWith(q) || l.id.startsWith(query.trim().toLowerCase())))
  const contains = all.filter((l) => !exact.includes(l) && !starts.includes(l) && (l.wp.toLowerCase().includes(q) || l.id.includes(q)))
  return [...exact, ...starts, ...contains].slice(0, limit)
}

// A recent id wp.org no longer lists still shows, under its own name, rather
// than vanishing from the list someone remembers it in.
const wpOf = (id: string): string => WPORG_LOCALES.find((l) => localeId(l.slug, l.set) === id)?.wp ?? id

export interface LocaleSearchProps {
  initial: string
  recent?: readonly string[]
  current?: string
  onPick: (id: string) => void
  error?: string
}

/**
 * The search field and the list under it, shared by the setup locale step
 * and the locale picker so the two cannot come to match differently. Enter is
 * the field's own submit; the arrows move the list.
 */
export function LocaleSearch({ initial, recent = [], current, onPick, error }: LocaleSearchProps) {
  const glyphs = useGlyphs()
  const [query, setQuery] = useState(initial)
  const [at, setAt] = useState(0)
  // With nothing typed, the recent locales, or nothing at all: an unfiltered
  // list would put a cursor on whichever locale sorts first, and enter would
  // quietly choose it.
  const empty = query.trim() === ''
  const matches = empty ? recent.map((id) => ({ id, wp: wpOf(id) })) : matchLocales(query)
  const chosen = Math.min(at, Math.max(0, matches.length - 1))
  useKeys({
    localeSearch: {
      move: (_input, key) => (key.upArrow ? setAt(Math.max(0, chosen - 1)) : setAt(Math.min(matches.length - 1, chosen + 1))),
    },
  })
  return (
    <Box flexDirection="column">
      <Box>
        <Text>Search: </Text>
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
      {matches.map((m, i) => (
        <Text key={m.id}>
          <Text {...TOKENS.accent.ink}>{i === chosen ? glyphs.next : ' '}</Text> <Text bold={i === chosen}>{m.id}</Text>{' '}
          <Text {...TOKENS.muted.ink}>{m.wp}</Text>
          {m.id === current && <Text {...TOKENS.muted.ink}> current</Text>}
        </Text>
      ))}
      {empty
        ? matches.length === 0 && <Text {...TOKENS.muted.ink}>Type the locale's code: de, pt_BR, nl_NL_formal, es_ES…</Text>
        : matches.length === 0 && <Text {...TOKENS.warn.ink}>translate.wordpress.org lists no locale like that.</Text>}
      {error && <Text {...TOKENS.error.ink}>Could not save that: {error}</Text>}
    </Box>
  )
}
