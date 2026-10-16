// Where the website's rules builder is served. One constant, so the CLI, the
// TUI and the file the builder writes cannot point at three different places
// when the site moves.
export const RULES_BUILDER_URL = 'https://ada.tools/polyglots/rules-builder/'

/** The rules builder with a locale preselected, by its WordPress code (tr_TR). */
export function rulesBuilderUrl(wpCode: string): string {
  return `${RULES_BUILDER_URL}?locale=${encodeURIComponent(wpCode)}`
}
