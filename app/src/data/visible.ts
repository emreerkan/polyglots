// Every line the data commands summarise carries text from a file and a
// manifest someone else published, and YAML's "\e" is an ESC byte. Printed
// raw, a replace ending in an erase sequence wipes its own "fix added:" line,
// and the summaries exist so that nothing reaches a person's rules or memory
// unseen; the sha512 is no defence, because the manifest names it. So C0 and
// C1 controls are shown as escapes, once, for the CLI and the TUI alike. The
// newline stays: rules fetch has already split prompt text on it, and one
// left inside a note is a line break, not a cursor command. Tab goes too,
// since Ink measures it as one column and the frame would tear.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g

/** `lines` with every C0 and C1 control but the newline shown as `\u{hex}`. */
export const visible = (lines: string[]): string[] =>
  lines.map((line) => line.replace(CONTROL, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`))
