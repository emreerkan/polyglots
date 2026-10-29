// Two sets and nothing in between. A terminal that cannot draw a check mark
// usually cannot draw a box corner either, so mixing per glyph would only
// produce output that is half broken instead of wholly plain.
export interface GlyphSet {
  ok: string
  fail: string
  warn: string
  next: string
  bullet: string
  ellipsis: string
  box: { tl: string; tr: string; bl: string; br: string; h: string; v: string }
  bar: { filled: string; empty: string }
  spark: readonly string[]
  // The frames of the mark on a line being worked on, in order.
  spinner: readonly string[]
}

// The bar keeps the parallelograms progress.ts has always drawn, moved here so
// the CLI and the TUI draw one bar. Parallelograms rather than hashes in
// brackets: the filled and empty cells are the same shape and width, so the
// bar reads as one object at a glance instead of as punctuation.
export const UNICODE_GLYPHS: GlyphSet = {
  ok: '✓',
  fail: '✗',
  warn: '!',
  next: '›',
  bullet: '•',
  ellipsis: '…',
  box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  bar: { filled: '▰', empty: '▱' },
  spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
}

export const ASCII_GLYPHS: GlyphSet = {
  ok: '+',
  fail: 'x',
  warn: '!',
  next: '>',
  bullet: '*',
  ellipsis: '...',
  box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
  bar: { filled: '#', empty: '-' },
  spark: ['_', '.', ':', '-', '=', '+', '*', '#'],
  spinner: ['|', '/', '-', '\\'],
}
