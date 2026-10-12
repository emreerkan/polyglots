import { basename, isAbsolute, relative } from 'node:path'
import { useCallback, useState } from 'react'
import { Box, Text } from 'ink'
import type { BatchItem } from '../../commands/batch.js'
import { isReviewOutput } from '../../commands/review.js'
import { useGlyphs } from '../theme.js'
import { useKeys } from '../hooks/useKeys.js'
import { FilePicker, type FilePickerProps, type PickerView } from './FilePicker.js'
import { Hint } from './Hint.js'

export interface MarkingPickerProps extends Pick<FilePickerProps, 'dir' | 'extensions' | 'annotate'> {
  marked: ReadonlySet<string>
  onMarked: (marked: ReadonlySet<string>) => void
  // Enter with nothing marked: the one file, exactly as before marking existed.
  onPick: (path: string) => void
  // Enter with marks: the marked files, wherever the cursor is.
  onBatch: () => void
  // What the batch does, for the hint: "review", "translate".
  verb: string
}

const plural = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`

/**
 * The review and translate pickers, with files marked for one batch.
 *
 * The marks belong to the screen, not to this component or the folder being
 * browsed, so they survive moving between folders: "everything fetched here
 * and the two in the other folder" is one batch. That means a marked file is
 * often not on screen, so the count under the list is what to trust, and the
 * options screen lists every marked file before anything starts.
 *
 * Kept apart from FilePicker because the key table holds a screen to listing
 * every key it binds. Split, import and export pick one file and have no use
 * for a mark; binding space in the shared picker would have put "mark a
 * file" in their help for a key that means nothing there.
 */
export function MarkingPicker({ marked, onMarked, onPick, onBatch, verb, ...picker }: MarkingPickerProps) {
  const [view, setView] = useState<PickerView>({ cursor: undefined, files: [] })
  // Why the last space did nothing, until the next mark that does something.
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const onView = useCallback((v: PickerView) => setView(v), [])

  const eligible = view.files.filter((f) => !isReviewOutput(f))

  useKeys({
    marks: {
      toggle: () => {
        const file = view.cursor
        if (file === undefined) return
        if (isReviewOutput(file)) {
          setRefused(`${basename(file)} is the output of a review, not a submission, so it stays out of the batch.`)
          return
        }
        setRefused(undefined)
        const next = new Set(marked)
        if (next.has(file)) next.delete(file)
        else next.add(file)
        onMarked(next)
      },
      // A toggle over the folder: the common case is "everything fetched into
      // this folder", and the same key undoing it saves unmarking one by one
      // after marking the wrong folder.
      all: () => {
        if (eligible.length === 0) return
        setRefused(undefined)
        const next = new Set(marked)
        const every = eligible.every((f) => next.has(f))
        for (const f of eligible) {
          if (every) next.delete(f)
          else next.add(f)
        }
        onMarked(next)
      },
    },
  })

  return (
    <Box flexDirection="column">
      <FilePicker {...picker} marked={marked} onView={onView} onPick={(path) => (marked.size > 0 ? onBatch() : onPick(path))} />
      {refused && <Text color="yellow">{refused}</Text>}
      {marked.size > 0 ? (
        <Text>
          {plural(marked.size)} marked <Text dimColor>· enter to {verb} them · space unmarks · * toggles this folder</Text>
        </Text>
      ) : (
        <Hint>{`space marks files to ${verb} in one batch · * every file here`}</Hint>
      )}
    </Box>
  )
}

/**
 * The marked files as batch items, in the order they were marked, each named
 * by its path from where the picker opened. A basename alone would not do:
 * marks span folders, and two folders of exports often hold the same names.
 */
export function markedItems(dir: string, marked: ReadonlySet<string>): BatchItem[] {
  return [...marked].map((file) => {
    const rel = relative(dir, file)
    return { input: rel === '' || rel.startsWith('..') || isAbsolute(rel) ? file : rel, file }
  })
}

/** The marked files, listed on the options screen before Start. */
export function MarkedFiles({ items }: { items: BatchItem[] }) {
  const glyphs = useGlyphs()
  return (
    <Box flexDirection="column" marginBottom={1}>
      {items.map((item) => (
        <Text key={item.file}>
          {'  '}
          {glyphs.bullet} {item.input}
        </Text>
      ))}
    </Box>
  )
}
