import { emitRulesYaml, emptyBuilderState, type BuilderMistake, type BuilderPattern, type BuilderState } from '../../../../app/src/rules/emit.js';

// The builder keeps the person's work in localStorage, so a reload, a closed
// tab or a failed share never loses it. What comes back is whatever an older
// version of this page, or a hand edit in devtools, left there, so every field
// is checked and anything malformed falls back to empty rather than breaking
// the page. Contact details are deliberately not kept: they are personal data,
// and the page has no reason to hold them after it is closed.

export const STORAGE_KEY = 'pg-rules-builder';
export const STEPS = 6;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
const rows = <T>(v: unknown, read: (o: Record<string, unknown>) => T | undefined): T[] =>
  Array.isArray(v) ? v.flatMap((o) => (isObject(o) ? [read(o)].filter((r): r is T => r !== undefined) : [])) : [];

const LEVELS = ['hint', 'error', 'fix'] as const;

function mistake(o: Record<string, unknown>): BuilderMistake | undefined {
  if (typeof o.wrong !== 'string') return undefined;
  return { wrong: o.wrong, right: str(o.right), note: str(o.note) };
}

function pattern(o: Record<string, unknown>): BuilderPattern | undefined {
  if (typeof o.value !== 'string') return undefined;
  const level = LEVELS.find((l) => l === o.level) ?? 'hint';
  return {
    mode: o.mode === 'find' ? 'find' : 'text',
    value: o.value,
    level,
    replace: str(o.replace),
    ignoreCase: o.ignoreCase === true,
    whenSource: str(o.whenSource),
    whenNotSource: str(o.whenNotSource),
    note: str(o.note),
  };
}

function state(raw: unknown): BuilderState {
  const empty = emptyBuilderState('');
  if (!isObject(raw)) return empty;
  const register = isObject(raw.register) ? raw.register : {};
  const nouns = isObject(raw.properNouns) ? raw.properNouns : {};
  const end = isObject(raw.sentenceEnd) ? raw.sentenceEnd : {};
  const ratio = raw.glossaryStemRatio;
  return {
    locale: str(raw.locale),
    enable: strings(raw.enable),
    disable: strings(raw.disable),
    glossaryStemRatio: typeof ratio === 'number' && ratio > 0 && ratio <= 1 ? ratio : null,
    formality: raw.formality === 'formal' || raw.formality === 'informal' ? raw.formality : '',
    register: { audit: str(register.audit), translate: str(register.translate) },
    capitalization: str(raw.capitalization),
    guidance: str(raw.guidance),
    properNouns: { always: strings(nouns.always), dateOnly: strings(nouns.dateOnly) },
    mistakes: rows(raw.mistakes, mistake),
    patterns: rows(raw.patterns, pattern),
    sentenceEnd: {
      answers: rows(end.answers, (o) => (typeof o.text === 'string' ? { text: o.text, source: str(o.source) } : undefined)),
      unmarked: end.unmarked === true,
      notEnding: str(end.notEnding),
    },
  };
}

export interface Saved {
  state: BuilderState;
  step: number;
}

/** What localStorage held, made safe to render. */
export function restoreSaved(raw: unknown): Saved {
  if (!isObject(raw)) return { state: emptyBuilderState(''), step: 0 };
  const step = typeof raw.step === 'number' && Number.isInteger(raw.step) && raw.step >= 0 && raw.step < STEPS ? raw.step : 0;
  return { state: state(raw.state), step };
}

/** Reads the saved work; an empty builder when there is none or storage is blocked. */
export function loadSaved(): Saved {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return restoreSaved(text === null ? null : JSON.parse(text));
  } catch {
    return restoreSaved(null);
  }
}

/** Keeps the work; silently does nothing in a private window or with storage blocked. */
export function save(saved: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // The page works the same without it; only a reload loses the work.
  }
}

/** Whether the state holds anything the person entered, whatever its locale. */
export const hasContent = (s: BuilderState): boolean => emitRulesYaml({ ...s, locale: '' }) !== emitRulesYaml(emptyBuilderState(''));

export interface LocaleRequest {
  state: BuilderState;
  conflict?: { saved: string; asked: string };
}

/**
 * The state to open with when the address asks for a locale. The app's link
 * (polyglots rules builder tr) is a request to work on that locale, so an
 * empty state, or work not yet tied to a locale, takes it. Work saved for
 * another locale keeps its own: relabelling it would download or share de_DE
 * rules as tr_TR without a word. The conflict is returned for the page to
 * offer a fresh start, as the published-rules fetch asks before it replaces.
 */
export function applyAskedLocale(saved: BuilderState, asked: string | undefined): LocaleRequest {
  if (asked === undefined || saved.locale === asked) return { state: saved };
  if (saved.locale !== '' && hasContent(saved)) return { state: saved, conflict: { saved: saved.locale, asked } };
  return { state: { ...saved, locale: asked } };
}
