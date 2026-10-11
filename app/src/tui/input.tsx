import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { useInput as useInkInput, type Key } from 'ink'
import InkTextInput, { type Props as TextInputProps } from 'ink-text-input'
import InkSelectInput from 'ink-select-input'
import { TextArea as InkTextArea, type TextAreaHandle } from 'react-ink-textarea'

// Every key listener in the TUI comes through here, so one switch can silence
// a whole subtree.
//
// The switch exists for overlays. Help, the palette and the quit prompt draw on
// top of a screen that has to stay mounted underneath, because a translate or
// review running in it would die on unmount. Ink hands every key to every
// active listener, so without a gate the palette's typing would also land in
// the screen below: "t" in a search box would open Translate.
//
// Unmounting the screen was the obvious alternative and the one rejected, for
// the run it would kill. Reaching into Ink's private stdin context to filter
// the event stream would cover third-party widgets for free, but it is not
// exported and would break silently on an Ink update. Wrapping the two widgets
// we use and the hook is a few lines and fails loudly: a test holds every file
// under src/tui to importing them from here.

const GateContext = createContext(true)

export function InputGate({ open, children }: { open: boolean; children: ReactNode }) {
  // A closed gate closes everything beneath it whatever a nested one says, so
  // an overlay does not need to know what the screen under it renders.
  const outer = useContext(GateContext)
  return <GateContext.Provider value={outer && open}>{children}</GateContext.Provider>
}

export function useGateOpen(): boolean {
  return useContext(GateContext)
}

export type { Key }

export function useInput(handler: (input: string, key: Key) => void, options: { isActive?: boolean } = {}): void {
  const open = useContext(GateContext)
  useInkInput(handler, { isActive: (options.isActive ?? true) && open })
}

/**
 * The frame's own listener, which no gate closes: Ctrl+C, the palette and
 * help must work over whatever is open, including the overlays themselves.
 * Nothing but the frame should use it.
 */
export function useGlobalInput(handler: (input: string, key: Key) => void): void {
  useInkInput(handler)
}

// Whether a text field has focus somewhere. The frame reads it before acting
// on `?` or `:`, which are printable: in a locale search or a project list
// they are characters the person meant to type. Counted rather than flagged,
// because a form can mount more than one field, and read through a function
// rather than state so the frame's key handler sees the current answer without
// a re-render racing the keypress.
interface Typing {
  current(): boolean
  enter(): () => void
}

function createTyping(): Typing {
  let focused = 0
  return {
    current: () => focused > 0,
    enter() {
      focused++
      let left = false
      return () => {
        if (left) return
        left = true
        focused--
      }
    },
  }
}

const TypingContext = createContext<Typing>(createTyping())

export function TypingProvider({ children }: { children: ReactNode }) {
  const typing = useRef<Typing | undefined>(undefined)
  typing.current ??= createTyping()
  return <TypingContext.Provider value={typing.current}>{children}</TypingContext.Provider>
}

export function useTyping(): Typing {
  return useContext(TypingContext)
}

/**
 * Marks a hand-rolled text field as focused while `active`, for the screens
 * that read characters through useInput instead of a TextInput: the fetch
 * project list and the multiline guidance editor.
 */
export function useTypingWhile(active: boolean): void {
  const open = useContext(GateContext)
  const typing = useContext(TypingContext)
  const focused = active && open
  useEffect(() => (focused ? typing.enter() : undefined), [focused, typing])
}

export function TextInput(props: TextInputProps) {
  const open = useContext(GateContext)
  const focused = (props.focus ?? true) && open
  useTypingWhile(focused)
  return <InkTextInput {...props} focus={focused} />
}

type SelectProps<V> = Parameters<typeof InkSelectInput<V>>[0]

export function SelectInput<V>(props: SelectProps<V>) {
  const open = useContext(GateContext)
  return <InkSelectInput<V> {...props} isFocused={(props.isFocused ?? true) && open} />
}

export interface TextAreaProps {
  value: string
  onChange: (value: string) => void
  focus?: boolean
  /** Rows shown before the text scrolls. */
  viewportLines?: number
  /** Told after ctrl+x has emptied the text, so the screen can say how to get it back. */
  onClear?: () => void
}

/**
 * A multi-line editor with a cursor that moves anywhere, for text a person
 * shapes rather than appends to: a reply template.
 *
 * The widget submits on enter and wants ctrl+j or shift+enter for a new line.
 * Nobody editing a paragraph expects enter to finish it, and shift+enter
 * reaches the program as plain enter in most terminals, so enter is taken
 * away from the widget and turned into a newline here. Finishing is the
 * caller's: its own esc or save key, through useKeys, as everywhere else.
 *
 * ctrl+x empties the text, for replacing a starter or old wording with a
 * paste. The widget's undo records only its own edits, so a clear cannot be
 * undone with ctrl+z; nothing is written until the caller saves, and its esc
 * offers to throw the change away, which is the way back.
 *
 * The widget's ctrl+k, delete to the end of the line, is switched off. The
 * frame hears ctrl+k over any text field and opens the palette, so one press
 * did both: the palette opened and half a line vanished underneath it.
 */
export function TextArea({ value, onChange, focus = true, viewportLines, onClear }: TextAreaProps) {
  const open = useContext(GateContext)
  const focused = focus && open
  const area = useRef<TextAreaHandle>(null)
  useTypingWhile(focused)
  useInkInput(
    (input, key) => {
      if (key.return && !key.ctrl && !key.meta && !key.shift) area.current?.insert('\n')
      if (key.ctrl && input === 'x') {
        onChange('')
        onClear?.()
      }
    },
    { isActive: focused },
  )
  return (
    <InkTextArea
      ref={area}
      focus={focused}
      value={value}
      onChange={onChange}
      onSubmit={() => undefined}
      keybindings={{ Enter: false, 'Ctrl+K': false }}
      disableCursorBlink
      {...(viewportLines === undefined ? {} : { viewportLines })}
    />
  )
}
