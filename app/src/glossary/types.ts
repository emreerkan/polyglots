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
