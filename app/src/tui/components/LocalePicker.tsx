import { Box, Text } from 'ink'
import { TOKENS } from '../../ui/tokens.js'
import { useKeys } from '../hooks/useKeys.js'
import { LocaleSearch } from './LocaleSearch.js'

export interface LocalePickerProps {
  current?: string
  recent: readonly string[]
  // Why a pick was refused: a run going, or edits not saved. The picker stays
  // open so the person sees it, and esc is the way out.
  blocked?: string
  // Why the save failed, as the setup locale step words it.
  error?: string
  onPick: (id: string) => void
  onClose: () => void
}

/** Drawn over a screen like the palette, which it borrows esc from. */
export function LocalePicker({ current, recent, blocked, error, onPick, onClose }: LocalePickerProps) {
  useKeys({ palette: { close: onClose, move: undefined } })
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexShrink={0}>
      <Text {...TOKENS.heading.ink}>Change locale</Text>
      <LocaleSearch
        initial=""
        recent={recent}
        {...(current === undefined ? {} : { current })}
        {...(error === undefined ? {} : { error })}
        onPick={onPick}
      />
      {blocked && <Text {...TOKENS.warn.ink}>{blocked}</Text>}
      <Text {...TOKENS.muted.ink}>type to search · ↑↓ choose · enter change · esc close</Text>
    </Box>
  )
}
