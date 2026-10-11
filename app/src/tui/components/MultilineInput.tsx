import { Box } from 'ink'
import { useKeys } from '../hooks/useKeys.js'
import { TextArea } from '../input.js'

export interface MultilineInputProps {
  value: string
  onChange: (value: string) => void
  onDone: () => void
}

/**
 * Free text over several lines, edited anywhere: the arrows move the cursor,
 * enter starts a new line, ctrl+z undoes, esc finishes. It used to be
 * append-only, with editing in the middle of a paragraph left to `rules edit`
 * and an external editor; the reply template editor brought a real one, and
 * the guidance is the same kind of text.
 */
export function MultilineInput({ value, onChange, onDone }: MultilineInputProps) {
  useKeys({ back: { esc: onDone, q: undefined } })
  return (
    <Box borderStyle="round" paddingX={1}>
      <TextArea value={value} onChange={onChange} viewportLines={12} />
    </Box>
  )
}
