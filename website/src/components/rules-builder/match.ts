import type { PatternLevel } from '../../../../app/src/rules/schema.js';
import type { BuilderPattern, BuilderState } from '../../../../app/src/rules/emit.js';

// What the live tester runs for one sample: which mistakes and patterns apply
// to the sample's source, and the regex work each one needs, mirroring
// customFindings and applyFixPatterns in app/src/rules/custom.ts. The work
// itself runs in a worker with the app's budget (tester.ts); this half is
// pure, so it is tested without a browser.
//
// One deliberate difference: the app expands a literal into every encoding of
// each letter (composed, decomposed, precomposed exclusions), which takes a
// scan of the whole code point range. The tester matches the locale's casing
// only, so a literal typed in one encoding can miss text stored in the other
// here while the app still finds it. A false "does not fire" in a preview is
// the cheaper error than a page that stalls while it builds that table.

export interface RegexJob {
  source: string;
  flags: string;
  text: string;
  // Both the pattern and the text in NFC, the app's second try for a regex hint.
  normalise?: boolean;
  // Set for a fix: the text after replacing, rather than whether it matched.
  replace?: string;
  // A literal fix keeps the capital of what it replaced, in this locale's
  // casing, as the app's does: Önizleme becomes Ön izleme.
  capitaliseTag?: string;
}

export interface Check {
  kind: 'mistake' | 'pattern';
  // The row's place in its own list, for pointing back at it.
  index: number;
  label: string;
  level: PatternLevel;
  regex: boolean;
  applies: boolean;
  invalid: boolean;
  ops: RegexJob[];
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A literal as a regex that matches it in the locale's own upper and lower case: Turkish i with İ, not with I. */
export function literalSource(text: string, tag: string): string {
  return (text.normalize('NFC').match(/\P{M}\p{M}*|\p{M}+/gu) ?? [])
    .map((letter) => {
      const forms = new Set([letter, letter.toLocaleLowerCase(tag), letter.toLocaleUpperCase(tag)]);
      return forms.size === 1 ? escapeRegExp(letter) : `(?:${[...forms].map(escapeRegExp).join('|')})`;
    })
    .join('');
}

export const compiles = (source: string): boolean => {
  try {
    new RegExp(source, 'u');
    return true;
  } catch {
    return false;
  }
};

/** Every non-blank mistake and pattern, in file order, with what to run for this sample. */
export function checksFor(state: BuilderState, source: string, translation: string, tag: string): Check[] {
  const has = (needle: string) => source.toLocaleLowerCase(tag).includes(needle.toLocaleLowerCase(tag));
  const translated = translation.trim() !== '';
  const checks: Check[] = [];
  state.mistakes.forEach((m, index) => {
    if (m.wrong.trim() === '') return;
    checks.push({
      kind: 'mistake',
      index,
      label: m.wrong,
      level: 'hint',
      regex: false,
      applies: translated,
      invalid: false,
      ops: translated ? [{ source: literalSource(m.wrong, tag), flags: 'gu', text: translation }] : [],
    });
  });
  state.patterns.forEach((p, index) => {
    // A literal keeps its edge spaces, as the emitted file does: the app
    // matches it as a substring, so ' :' must not preview as ':'. Only a
    // literal of spaces alone is a blank row, the same line emit.ts draws.
    const value = p.value;
    if (p.mode === 'find' ? value === '' : value.trim() === '') return;
    const regex = p.mode === 'find';
    const invalid = regex && !compiles(value);
    const conditions =
      (p.whenSource.trim() === '' || has(p.whenSource)) && (p.whenNotSource.trim() === '' || !has(p.whenNotSource));
    const applies = translated && conditions && !invalid;
    const re = regex ? { source: value, flags: `gu${p.ignoreCase ? 'i' : ''}` } : { source: literalSource(value, tag), flags: 'gu' };
    let ops: RegexJob[] = [];
    if (applies) {
      ops =
        p.level === 'fix'
          ? [{ ...re, text: translation, replace: p.replace, ...(regex ? {} : { capitaliseTag: tag }) }]
          : [{ ...re, text: translation }, ...(regex ? [{ ...re, text: translation, normalise: true }] : [])];
    }
    // Named by its note, as the app names it in a finding; a long regex is
    // no name a person can read in a list.
    const label = p.note.trim() || value;
    checks.push({ kind: 'pattern', index, label, level: p.level, regex, applies, invalid, ops });
  });
  return checks;
}

// What a pattern row would be refused for, said beside it rather than only
// as the file's first error in the review step; empty when nothing is wrong.
// It says no more than the app's parser would. An empty replace on a fix is
// not a missing one: emit.ts writes it as replace: '', the schema accepts it,
// and the app deletes what the pattern finds, which is how a stray space
// before a comma is removed. Flagging it put a false error beside a valid row.
export function patternProblem(p: BuilderPattern): string {
  if (p.mode === 'find' && p.value !== '' && !compiles(p.value)) return 'Not a valid regular expression.';
  return '';
}
