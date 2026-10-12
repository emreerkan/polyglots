import { readdirSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { useKeys } from '../hooks/useKeys.js'
import { SelectInput } from '../input.js'
import { useGlyphs } from '../theme.js'
import { ScrollTarget } from './Viewport.js'

/**
 * How the listing is ordered.
 *
 * Date means the file's mtime. For the catalogues this picker exists to find,
 * that is when it was downloaded, which is the closest thing to "the file this
 * session is about" that the filesystem knows.
 */
export type SortMode = 'date-asc' | 'date-desc' | 'name-asc' | 'name-desc'

// The order the `s` key walks, listed so that starting from the default steps
// through name ordering before coming back round to oldest-first.
export const SORT_CYCLE: readonly SortMode[] = ['date-asc', 'date-desc', 'name-asc', 'name-desc']

// Newest first, because the file a session is about is nearly always the one
// just downloaded. Ordering by name instead puts it wherever the alphabet says,
// which in a working directory of exports is effectively at random.
export const DEFAULT_SORT: SortMode = 'date-desc'

export const SORT_LABEL: Record<SortMode, string> = {
  'date-asc': 'oldest first',
  'date-desc': 'newest first',
  'name-asc': 'name A-Z',
  'name-desc': 'name Z-A',
}

export function nextSort(mode: SortMode): SortMode {
  const at = SORT_CYCLE.indexOf(mode)
  return SORT_CYCLE[(at + 1) % SORT_CYCLE.length]!
}

export interface FilePickerProps {
  dir: string
  extensions: string[]
  onPick: (path: string) => void
  limit?: number
  /**
   * Extra detail to show beside a matching file, such as how many entries it
   * holds. Called once per file per listing.
   *
   * Must be a stable reference: a module-level function, not an inline arrow.
   * It is a dependency of the memo that stops the directory being re-read on
   * every keystroke, so a new identity each render would defeat it.
   */
  annotate?: (path: string) => string | undefined
  /**
   * Choose a folder rather than a file.
   *
   * Matching files are not listed, because in this mode they are not choices
   * and the list is shorter without them, and a row at the top picks the folder
   * being browsed. That row leads so that opening the picker and pressing enter
   * chooses where you already are, which is usually the answer.
   */
  chooseDir?: boolean
  /**
   * Files marked for a batch, drawn with a bullet before the name. The
   * picker only draws them: which keys mark a file, and what a mark means,
   * belong to MarkingPicker, so the pickers that never mark anything keep
   * their keys and their rows exactly as they were.
   */
  marked?: ReadonlySet<string>
  /**
   * Told the file row under the cursor (undefined on a folder) and the files
   * the folder lists, whenever either changes, for a screen that marks them.
   */
  onView?: (view: PickerView) => void
}

export interface PickerView {
  cursor: string | undefined
  files: string[]
}

// `choose` is the row that picks the folder being browsed, in chooseDir mode.
export type EntryKind = 'dir' | 'file' | 'choose'

interface Entry {
  path: string
  kind: EntryKind
  name: string
  mtimeMs: number
}

// Selection outranks kind. Yellow marks "this is the thing you came here to
// pick", but a yellow cursor row sitting among yellow neighbours left weight as
// the only difference, which does not read at a glance in a list of file names
// that share a long prefix. The selected row takes the same blue as the ❯
// pointer, so the two cues agree instead of competing.
export function itemColor(kind: EntryKind | undefined, isSelected: boolean): string | undefined {
  if (isSelected) return 'blue'
  return kind === 'file' || kind === 'choose' ? 'yellow' : undefined
}

interface Listing {
  items: { key: string; label: string; value: Entry }[]
  error?: string
}

function isDirectory(path: string, entry: { isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// A name tiebreak under every mode, so the list cannot reshuffle between renders
// of the same directory. Files written in the same millisecond are ordinary,
// a split job emits a directory of them at once, and an unstable order in a
// picker means the row under the cursor is not the row that was under it a
// moment ago.
export function compareEntries(mode: SortMode): (a: Entry, b: Entry) => number {
  const byName = (a: Entry, b: Entry): number => a.name.localeCompare(b.name)
  if (mode === 'name-asc') return byName
  if (mode === 'name-desc') return (a, b) => byName(b, a)
  const direction = mode === 'date-desc' ? -1 : 1
  return (a, b) => (a.mtimeMs === b.mtimeMs ? byName(a, b) : direction * (a.mtimeMs - b.mtimeMs))
}

// Counts sit in a column rather than trailing each name, so a file holding two
// hundred entries and one holding ten thousand are told apart at a glance
// instead of by reading to the end of two different-length lines.
function labelled(entry: Entry, pad: number, detail: string | undefined): string {
  if (entry.kind === 'dir') return `${entry.name}/`
  return detail === undefined ? entry.name : `${entry.name.padEnd(pad)}  ${detail}`
}

function list(
  cwd: string,
  extensions: string[],
  sort: SortMode,
  annotate: FilePickerProps['annotate'],
  chooseDir = false,
): Listing {
  const items: Listing['items'] = []
  if (chooseDir) {
    items.push({ key: '.', label: '[ use this folder ]', value: { path: cwd, kind: 'choose', name: '.', mtimeMs: 0 } })
  }
  const parent = dirname(cwd)
  // Pinned above everything: it is navigation, not a candidate, so no sort order
  // should ever move it.
  if (parent !== cwd) {
    items.push({ key: '..', label: '..', value: { path: parent, kind: 'dir', name: '..', mtimeMs: 0 } })
  }

  let error: string | undefined
  const dirs: Entry[] = []
  const files: Entry[] = []
  try {
    for (const dirent of readdirSync(cwd, { withFileTypes: true })) {
      if (dirent.name.startsWith('.')) continue
      const path = join(cwd, dirent.name)
      const kind: EntryKind = isDirectory(path, dirent) ? 'dir' : 'file'
      if (kind === 'file' && (chooseDir || !extensions.includes(extname(dirent.name).toLowerCase()))) continue
      // An entry whose stat fails still belongs in the list; only its date is
      // unknown, and dropping the row would hide a file the user can see.
      let mtimeMs = 0
      try {
        mtimeMs = statSync(path).mtimeMs
      } catch {
        mtimeMs = 0
      }
      const entry: Entry = { path, kind, name: dirent.name, mtimeMs }
      if (kind === 'dir') dirs.push(entry)
      else files.push(entry)
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  const order = compareEntries(sort)
  files.sort(order)
  dirs.sort(order)

  const pad = files.reduce((width, f) => Math.max(width, f.name.length), 0)

  // Matching files come before directories: a plugin checkout can hold dozens of
  // folders, and listing those first buries the one file the picker exists to find.
  for (const entry of files) {
    items.push({ key: entry.path, label: labelled(entry, pad, annotate?.(entry.path)), value: entry })
  }
  for (const entry of dirs) {
    items.push({ key: entry.path, label: labelled(entry, pad, undefined), value: entry })
  }
  return { items, error }
}

export function FilePicker({ dir, extensions, onPick, limit = 15, annotate, chooseDir, marked, onView }: FilePickerProps) {
  const glyphs = useGlyphs()
  const [cwd, setCwd] = useState(dir)
  const [sort, setSort] = useState<SortMode>(DEFAULT_SORT)
  const listing = useMemo(
    () => list(cwd, extensions, sort, annotate, chooseDir),
    [cwd, extensions, sort, annotate, chooseDir],
  )
  const hasFiles = chooseDir || listing.items.some((i) => i.value.kind === 'file')

  // The row under SelectInput's cursor, which it keeps to itself and reports
  // only on a move. Its cursor goes back to the top whenever the listing
  // changes, which here is only ever a new folder or a new order, so this is
  // cleared at the same two places and falls back to the first row.
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined)
  const cursorEntry = listing.items.find((i) => i.value.path === highlighted)?.value ?? listing.items[0]?.value
  const cursor = cursorEntry?.kind === 'file' ? cursorEntry.path : undefined
  const files = useMemo(() => listing.items.filter((i) => i.value.kind === 'file').map((i) => i.value.path), [listing])
  useEffect(() => {
    onView?.({ cursor, files })
  }, [onView, cursor, files])

  // SelectInput binds the arrows, j, k and return; s is free. It resets its
  // cursor to the top whenever the item values change, which is what a re-sort
  // wants, because the row that was under the cursor has moved and holding the
  // index would put the cursor on an unrelated file.
  useKeys({
    picker: {
      sort: () => {
        setSort(nextSort)
        setHighlighted(undefined)
      },
    },
  })

  // ink-select-input hands its item component only the label, so the kind is
  // looked up by label; a directory's label carries a trailing slash, so a file
  // and a folder of the same name never collide.
  const ItemView = useMemo(() => {
    const kinds = new Map(listing.items.map((i) => [i.label, i.value.kind]))
    const paths = new Map(listing.items.map((i) => [i.label, i.value.path]))
    return function Item({ isSelected, label }: { isSelected?: boolean; label: string }) {
      const selected = isSelected === true
      const kind = kinds.get(label)
      // Every file row is indented by the bullet's width once anything is
      // marked, so a mark does not shift its row against the others. Not
      // before: with nothing marked the picker reads exactly as it always has.
      const marking = marked !== undefined && marked.size > 0 && kind === 'file'
      const mark = !marking ? '' : marked.has(paths.get(label)!) ? `${glyphs.bullet} ` : '  '
      // Followed by the body: the picker is taller than the body on a short
      // terminal, and its cursor would otherwise walk off the bottom.
      return (
        <ScrollTarget active={selected}>
          <Text color={itemColor(kind, selected)} bold={selected}>
            {mark}
            {label}
          </Text>
        </ScrollTarget>
      )
    }
  }, [listing, marked, glyphs])

  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>Browsing </Text>
        {cwd}
      </Text>
      <Text dimColor>
        Sorted by {SORT_LABEL[sort]} · s to change
      </Text>
      {listing.error && <Text color="red">Cannot read directory: {listing.error}</Text>}
      {!hasFiles && <Text dimColor>(no {extensions.join('/')} files here)</Text>}
      <SelectInput
        items={listing.items}
        itemComponent={ItemView}
        limit={limit}
        onHighlight={(item) => setHighlighted(item.value.path)}
        onSelect={(item) => {
          if (item.value.kind !== 'dir') return onPick(item.value.path)
          setCwd(item.value.path)
          setHighlighted(undefined)
        }}
      />
    </Box>
  )
}
