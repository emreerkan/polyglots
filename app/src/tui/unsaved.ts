import { createContext, useContext, useEffect } from 'react'

// Whether the screen on show holds edits it has not written, which the locale
// picker refuses to remount it over: a change of locale mounts the screen
// again, and Locale rules or the template editor would drop the edits without
// a word. A ref rather than state, because App reads it only when a pick is
// made and nothing should re-render when it moves.
//
// A context rather than an onDirty prop on each screen, so a screen embedded
// in another (the wizard's rules step renders Locale rules) reports without
// the one around it passing anything along.
export const UnsavedContext = createContext<{ current: boolean } | undefined>(undefined)

export function useReportUnsaved(dirty: boolean): void {
  const ref = useContext(UnsavedContext)
  useEffect(() => {
    if (ref) ref.current = dirty
  }, [ref, dirty])
  // Leaving the screen leaves its edits behind with it, saved or not.
  useEffect(
    () => () => {
      if (ref) ref.current = false
    },
    [ref],
  )
}
