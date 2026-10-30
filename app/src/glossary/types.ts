/**
 * Browser-safe glossary types. Type-only on purpose: the editor page bundles
 * the modules that import this, and a runtime import here could drag in
 * node:* or better-sqlite3 and break that bundle. Storage and the editor both
 * import from here so neither has to reach into the other.
 */

/** One glossary row as the CSV and the editor see it. '' stands for empty. */
export interface GlossaryRow {
  term: string
  pos: string
  translation: string
  notes: string
}

/** Where an effective row came from: the wp.org copy, a local change of one, or a local addition. */
export type RowOrigin = 'wporg' | 'changed' | 'added'

/** A glossary row with its origin; `base` is the wp.org row a 'changed' row replaced. */
export interface EffectiveRow extends GlossaryRow {
  origin: RowOrigin
  base?: GlossaryRow
}
