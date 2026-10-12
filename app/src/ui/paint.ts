import { styleText } from 'node:util'
import { ASCII_GLYPHS, UNICODE_GLYPHS, type GlyphSet } from './glyphs.js'
import { TOKENS, type Token } from './tokens.js'

export interface PaintStream {
  isTTY?: boolean
  columns?: number
}

export interface Painter {
  readonly color: boolean
  readonly glyphs: GlyphSet
  readonly width: number
  paint(token: Token, text: string): string
}

// Decided here rather than by styleText's own stream check, for two reasons.
// stdout and stderr need separate answers: in `review x.po | tee log` the
// summary goes down a pipe while the progress line is still on a terminal.
// And tests inject plain objects, which styleText would judge by the real
// process streams instead of the ones the command was handed.
export function colorEnabled(stream: PaintStream, env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR) return false
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'
  if (env.TERM === 'dumb') return false
  return stream.isTTY === true
}

// An unset locale reads as UTF-8 because that is what every modern terminal
// is, and CI images that leave LANG empty render Unicode fine. LANG=C is the
// case worth catching: a minimal container whose console really cannot.
//
// Windows sets no LANG, so the locale says nothing there. The console host
// that PowerShell and cmd open in on Windows 10 draws arrows and box lines
// but shows a check mark, the spark blocks and the wordmark as empty boxes,
// and nothing in the environment names it. So Windows is ASCII unless a
// terminal known to draw Unicode announces itself: Windows Terminal (the
// default on Windows 11), VS Code, JetBrains, Cmder, or a TERM set by a
// Unix-style emulator. CI counts too, since its logs are read in a browser.
// The list is the one is-unicode-supported keeps, inlined rather than added
// as a dependency for ten comparisons. POLYGLOTS_ASCII=0 is the way out for
// a console host someone has given a font that does have the glyphs.
export function asciiOnly(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  if (env.POLYGLOTS_ASCII === '0') return false
  if (env.POLYGLOTS_ASCII === '1' || env.TERM === 'dumb') return true
  if (platform === 'win32') return !windowsDrawsUnicode(env)
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG
  return locale !== undefined && locale !== '' && !/utf-?8/i.test(locale)
}

const windowsDrawsUnicode = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(env.WT_SESSION) ||
  Boolean(env.CI) ||
  Boolean(env.TERMINUS_SUBLIME) ||
  env.ConEmuTask === '{cmd::Cmder}' ||
  env.TERM_PROGRAM === 'vscode' ||
  env.TERM_PROGRAM === 'Terminus-Sublime' ||
  env.TERMINAL_EMULATOR === 'JetBrains-JediTerm' ||
  ['xterm-256color', 'alacritty', 'rxvt-unicode', 'rxvt-unicode-256color'].includes(env.TERM ?? '')

const DEFAULT_WIDTH = 80

const columnsOf = (stream: PaintStream | undefined): number | undefined =>
  typeof stream?.columns === 'number' && stream.columns > 0 ? stream.columns : undefined

// Colour and width answer different questions about a piped stream. Colour
// asks whether the bytes will be interpreted by a terminal, and a pipe says no.
// Width asks how wide the screen is that a person reads them on, and under
// `review x.po | tee log` that is still the terminal stderr is drawn on: a box
// sized to a fixed 80 there wrapped into a mess on a narrower window. So width
// falls back to the sibling stream, then to COLUMNS, and only then to 80.
// The sibling can only widen a pipe, never narrow it below 80: a pipe cannot
// say whether it is tee or > file, and a box cut to a narrow window loses text
// in a saved log for good, where a wrapped one under tee is only untidy.
export function createPainter(stream: PaintStream, env: NodeJS.ProcessEnv = process.env, sibling?: PaintStream): Painter {
  const color = colorEnabled(stream, env)
  const fromEnv = Number(env.COLUMNS)
  const beside = columnsOf(sibling)
  const width =
    columnsOf(stream) ??
    (beside === undefined ? undefined : Math.max(beside, DEFAULT_WIDTH)) ??
    (Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_WIDTH)
  return {
    color,
    glyphs: asciiOnly(env) ? ASCII_GLYPHS : UNICODE_GLYPHS,
    width,
    paint: (token, text) => (color ? styleText(TOKENS[token].cli, text, { validateStream: false }) : text),
  }
}

export const plainPainter: Painter = {
  color: false,
  glyphs: UNICODE_GLYPHS,
  width: DEFAULT_WIDTH,
  paint: (_token, text) => text,
}
