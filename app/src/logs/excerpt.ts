// The one way agent and error text is cut to a length before it is shown,
// logged or kept as a batch failure's reason. Every cut ends in CUT_MARK.
//
// The mark is for the problem report's redactor. A key that ran across a cut
// reaches a report as its first part only, which is not the text the
// whole-key replace looks for, so the redactor also masks a key's start
// where a cut leaves one. Without a mark it could know that place only when
// the cut was the end of the string, and a reason such as "stderr: <cut>;
// stdout: <cut>" puts the first cut in the middle of the line, where 13
// characters of a key went out in a test. With the mark, every cut says
// where it is.
export const CUT_MARK = '…'

// The length is in UTF-16 code units, which is what every caller's limit was
// written in, but the cut never falls between the two halves of a surrogate
// pair: an emoji in agent output cut there left a lone half, which
// JSON.stringify writes as an escape and the server shows as a replacement
// character. The cut steps back one instead, so it is at most one unit short.
export function excerpt(text: string, max: number): string {
  if (text.length <= max) return text
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max
  return `${text.slice(0, end)}${CUT_MARK}`
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
