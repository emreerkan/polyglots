import { emitRulesYaml, emptyBuilderState, stateFromRules, type BuilderState } from '../../../../app/src/rules/emit.js';
import { BUILT_IN_RULES, UNIVERSAL_RULES, findingLabel } from '../../../../app/src/rules/names.js';
import { RulesFileError, parseRulesText } from '../../../../app/src/rules/parse.js';
import type { LocaleRules } from '../../../../app/src/rules/schema.js';
import { intlTag, localeDisplayName, resolveLocale } from '../../../../app/src/wporg/locales.js';
import { agentPrompt } from './agent-prompt.js';
import { debounce } from './debounce.js';
import { checksFor, compiles, formatProblem, patternProblem, type Check } from './match.js';
import { probeProblem } from './probe.js';
import { RULE_EXAMPLES } from './rule-copy.js';
import { stateFromPasted } from './paste.js';
import { emptyShare, sendRules, shareBlocker, type ShareFields } from './share.js';
import { applyAskedLocale, hasContent, loadSaved, save, STEPS } from './store.js';
import { PATTERN_BUDGET_MS, RegexRunner } from './tester.js';

// The page's behaviour. Plain DOM: the site has no client framework, and the
// builder is a form with a few lists. Typing changes the state in place and
// never re-renders the field being typed in; a list is redrawn only when a row
// is added or removed, or a whole state is loaded.

// raw.githubusercontent.com answers with CORS headers; release assets are
// not reliably CORS-enabled, so the published file is read from main.
const PUBLISHED = 'https://raw.githubusercontent.com/emreerkan/polyglots-data/main/locales/';

type ListName = 'mistakes' | 'patterns' | 'answers' | 'formats';

const $ = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => root.querySelector<T & Element>(selector)!;
const $$ = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => [...root.querySelectorAll<T & Element>(selector)];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function removeButton(label: string, data: Record<string, string>): HTMLButtonElement {
  const button = el('button', { type: 'button', class: 'icon-btn remove', 'aria-label': label, ...data });
  button.append(icon('x'));
  return button;
}

// Reads and writes a dotted path such as register.audit or sentenceEnd.unmarked.
function getPath(state: BuilderState, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], state);
}
function setPath(state: BuilderState, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, state as unknown as Record<string, unknown>);
  parent[last] = value;
}

const errorText = (err: unknown) => (err instanceof RulesFileError ? err.message : err instanceof Error ? err.message : String(err));

export function start(): void {
  const root = document.querySelector<HTMLElement>('[data-rb]');
  if (!root) return;
  const saved = loadSaved();
  // A locale named in the address wins over the saved one, unless the saved
  // work is for another locale: then that work stays as it is, and step 1
  // offers to start over for the asked locale (see applyAskedLocale).
  const asked = new URLSearchParams(location.search).get('locale');
  const request = applyAskedLocale(saved.state, asked === null ? undefined : resolveLocale(asked)?.wp);
  let state = request.state;
  let step = saved.step;
  const share: ShareFields = emptyShare();
  const runner = new RegexRunner();
  // The probes get a runner of their own. A pattern that runs away on the
  // person's sample in the tester is not one rules check would refuse, and
  // sharing the runner's memory of runaways would let the tester's sample
  // decide whether the file is valid.
  const prober = new RegexRunner();
  const probePassed = new Set<string>();
  let probing = 0;
  // The latest refresh's probe, which Send waits for after its flush.
  let probed: Promise<void> = Promise.resolve();
  let yaml = '';
  let fileError: string | undefined;

  const persist = () => save({ state, step });
  const localeTag = () => {
    const row = resolveLocale(state.locale);
    return row ? intlTag(row.id) : 'en';
  };

  // ---- Step 1: the locale and the published file -------------------------
  const localeInput = $<HTMLInputElement>(root, '[data-locale]');
  const localeStatus = $(root, '[data-locale-status]');
  const fetchStatus = $(root, '[data-fetch-status]');
  const showLocale = () => {
    const row = state.locale === '' ? undefined : resolveLocale(state.locale);
    localeStatus.textContent = row
      ? `${localeDisplayName(row.id)} (${row.wp}).`
      : localeInput.value.trim() === ''
        ? 'Any WordPress locale code from translate.wordpress.org.'
        : `“${localeInput.value.trim()}” is not a locale on translate.wordpress.org.`;
    showAgentPrompt();
  };
  localeInput.value = state.locale;
  localeInput.addEventListener('input', () => {
    const row = resolveLocale(localeInput.value);
    state.locale = row ? row.wp : '';
    showLocale();
    changed();
  });
  localeInput.addEventListener('change', () => {
    if (state.locale !== '') localeInput.value = state.locale;
  });

  const say = (node: HTMLElement, text: string, tone?: 'ok' | 'warn') => {
    node.textContent = text;
    if (tone) node.dataset.tone = tone;
    else delete node.dataset.tone;
  };

  $(root, '[data-fetch]').addEventListener('click', async () => {
    const wp = state.locale;
    if (wp === '') {
      say(fetchStatus, 'Pick a locale first.', 'warn');
      return;
    }
    say(fetchStatus, `Reading the published rules for ${wp}…`);
    let text: string;
    try {
      const response = await fetch(`${PUBLISHED}${encodeURIComponent(wp)}/rules.yaml`, { cache: 'no-cache' });
      if (response.status === 404) {
        say(fetchStatus, `${wp} has no published rules yet, so you start from an empty file.`);
        return;
      }
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      text = await response.text();
    } catch (err) {
      say(fetchStatus, `Could not read polyglots-data: ${errorText(err)}.`, 'warn');
      return;
    }
    let next: BuilderState;
    try {
      next = stateFromRules(parseRulesText(text, `locales/${wp}/rules.yaml`), wp);
    } catch (err) {
      say(fetchStatus, `The published file cannot be read here: ${errorText(err)}`, 'warn');
      return;
    }
    if (hasContent(state) && !confirm('Replace what you have entered with the published rules?')) {
      say(fetchStatus, 'Kept what you had.');
      return;
    }
    load(next);
    say(fetchStatus, `Loaded the published rules for ${wp}. The comments in that file are not carried over.`, 'ok');
  });

  // ---- Pasting a file: an agent's answer, or a file from elsewhere -------------
  const pastePanel = $(root, '[data-paste]');
  const pasteToggle = $<HTMLButtonElement>(root, '[data-paste-toggle]');
  const pasteText = $<HTMLTextAreaElement>(root, '[data-paste-text]');
  const showPaste = (open: boolean) => {
    pastePanel.hidden = !open;
    pasteToggle.setAttribute('aria-expanded', String(open));
    if (open) pasteText.focus();
  };
  const loadPasted = (text: string) => {
    const result = stateFromPasted(text, state.locale);
    if ('error' in result) {
      say(fetchStatus, `Not loaded: ${result.error}`, 'warn');
      return;
    }
    if (hasContent(state) && !confirm('Replace what you have entered with the pasted file?')) {
      say(fetchStatus, 'Kept what you had.');
      return;
    }
    load(result.state);
    pasteText.value = '';
    showPaste(false);
    say(
      fetchStatus,
      state.locale === ''
        ? 'Loaded the pasted file. Pick its locale above to name the file.'
        : 'Loaded the pasted file. Look through the steps, then check it in Review and share.',
      'ok',
    );
  };
  pasteToggle.addEventListener('click', () => showPaste(pasteToggle.getAttribute('aria-expanded') !== 'true'));
  $(root, '[data-paste-cancel]').addEventListener('click', () => showPaste(false));
  $(root, '[data-paste-load]').addEventListener('click', () => loadPasted(pasteText.value));
  const pasteFile = $<HTMLInputElement>(root, '[data-paste-file]');
  pasteFile.addEventListener('change', async () => {
    const file = pasteFile.files?.[0];
    pasteFile.value = '';
    if (!file) return;
    try {
      pasteText.value = await file.text();
    } catch {
      say(fetchStatus, `Could not read ${file.name}.`, 'warn');
      return;
    }
    loadPasted(pasteText.value);
  });

  $(root, '[data-reset]').addEventListener('click', () => {
    if (hasContent(state) && !confirm('Clear everything you have entered?')) return;
    load(emptyBuilderState(state.locale));
    say(fetchStatus, 'Started over.');
  });

  // ---- Plain fields bound by path -----------------------------------------
  const form = $<HTMLFormElement>(root, '[data-form]');
  const fillBound = () => {
    for (const input of $$<HTMLInputElement | HTMLTextAreaElement>(form, '[data-bind]')) {
      const value = getPath(state, input.dataset.bind!);
      if (input instanceof HTMLInputElement && input.type === 'radio') input.checked = input.value === value;
      else if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = value === true;
      else input.value = value === null || value === undefined ? '' : String(value);
    }
  };
  form.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (target.dataset.bind) {
      const path = target.dataset.bind;
      if (target instanceof HTMLInputElement && target.type === 'radio') {
        if (target.checked) setPath(state, path, target.value);
      } else if (target instanceof HTMLInputElement && target.type === 'checkbox') setPath(state, path, target.checked);
      else if (path === 'glossaryStemRatio') {
        const n = Number(target.value);
        setPath(state, path, target.value.trim() === '' || !Number.isFinite(n) ? null : n);
      } else setPath(state, path, target.value);
      // The usual formats are checked against the clock and the order, so a
      // change to either says at once which rows no longer agree.
      if (path.startsWith('dateTime.')) for (const li of $$(lists.get('formats')!, 'li')) showRowError(li);
      changed();
      return;
    }
    const row = target.closest<HTMLElement>('[data-row]');
    if (row && target.dataset.field) {
      const list = rowsOf(row.dataset.list as ListName);
      const item = list[Number(row.dataset.row)] as unknown as Record<string, unknown> | undefined;
      if (!item) return;
      const field = target.dataset.field;
      item[field] = target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.value;
      if (field === 'mode' || field === 'level') updatePatternRow(row);
      showRowError(row);
      changed();
    }
  });

  // ---- Step 2: the built-in rules -----------------------------------------
  const rulesList = $(root, '[data-rules]');
  const isUniversal = (rule: string) => UNIVERSAL_RULES.includes(rule);
  const active = (rule: string) => (isUniversal(rule) ? !state.disable.includes(rule) : state.enable.includes(rule));
  const drawRules = () => {
    rulesList.replaceChildren(
      ...BUILT_IN_RULES.map((rule) => {
        const label = findingLabel(rule);
        const box = el('input', { type: 'checkbox', 'data-rule': rule });
        box.checked = active(rule);
        return el(
          'li',
          {},
          el(
            'label',
            {},
            box,
            el(
              'span',
              {},
              el('span', { class: 'rule-name', text: label?.name ?? rule }),
              el('span', { class: 'rule-key', text: rule }),
              el('span', { class: 'rule-default', text: isUniversal(rule) ? 'runs by default' : 'off by default' }),
              el('p', { class: 'rule-text', text: label?.description ?? '' }),
              el('p', { class: 'rule-example', text: `Example: ${RULE_EXAMPLES[rule]}` }),
            ),
          ),
        );
      }),
    );
  };
  rulesList.addEventListener('change', (event) => {
    const box = event.target as HTMLInputElement;
    const rule = box.dataset.rule;
    if (!rule) return;
    // Only what differs from the default is written: a universal rule turned
    // off goes in disable, an optional one turned on in enable.
    const on = new Set(BUILT_IN_RULES.filter((r) => (r === rule ? box.checked : active(r))));
    state.enable = BUILT_IN_RULES.filter((r) => !isUniversal(r) && on.has(r));
    state.disable = BUILT_IN_RULES.filter((r) => isUniversal(r) && !on.has(r));
    changed();
  });

  // ---- Counters -------------------------------------------------------------
  const counters = $$(root, '[data-count]');
  const showCounts = () => {
    for (const counter of counters) {
      const value = String(getPath(state, counter.dataset.count!) ?? '');
      const limit = Number(counter.dataset.limit);
      counter.textContent = `${value.length.toLocaleString('en')} of ${limit.toLocaleString('en')}`;
      if (value.length > limit) counter.dataset.over = '';
      else delete counter.dataset.over;
    }
  };

  // ---- Proper nouns as tags -------------------------------------------------
  const tagBoxes = $$(root, '[data-tags]');
  const drawTags = (box: HTMLElement) => {
    const list = box.dataset.tags as 'always' | 'dateOnly';
    const input = $<HTMLInputElement>(box, '[data-tag-input]');
    $$(box, '.tag').forEach((t) => t.remove());
    state.properNouns[list].forEach((name, i) => {
      const tag = el('span', { class: 'tag' }, el('span', { text: name }), removeButton(`Remove ${name}`, { 'data-untag': String(i) }));
      box.insertBefore(tag, input);
    });
  };
  for (const box of tagBoxes) {
    const list = box.dataset.tags as 'always' | 'dateOnly';
    const input = $<HTMLInputElement>(box, '[data-tag-input]');
    const add = (text: string) => {
      const names = text.split(/[,\n]/).map((s) => s.trim()).filter((s) => s !== '' && !state.properNouns[list].includes(s));
      if (names.length === 0) return;
      state.properNouns[list].push(...names);
      drawTags(box);
      changed();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        add(input.value);
        input.value = '';
      } else if (event.key === 'Backspace' && input.value === '' && state.properNouns[list].length > 0) {
        state.properNouns[list].pop();
        drawTags(box);
        changed();
      }
    });
    input.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text') ?? '';
      if (!/[,\n]/.test(text)) return;
      event.preventDefault();
      add(text);
    });
    input.addEventListener('blur', () => {
      add(input.value);
      input.value = '';
    });
    box.addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLElement>('[data-untag]');
      if (!button) {
        if (event.target === box) input.focus();
        return;
      }
      state.properNouns[list].splice(Number(button.dataset.untag), 1);
      drawTags(box);
      input.focus();
      changed();
    });
  }

  // ---- Lists: mistakes, patterns, sentence-end answers, usual formats --------
  const rowsOf = (name: ListName): unknown[] =>
    name === 'answers' ? state.sentenceEnd.answers : name === 'formats' ? state.dateTime.formats : state[name];
  const field = (row: number, list: ListName, key: string, label: string, value: string, extra: Record<string, string> = {}, area = false) => {
    const id = `rb-${list}-${row}-${key}`;
    const input = area
      ? el('textarea', { id, rows: '2', 'data-field': key, ...extra })
      : el('input', { id, 'data-field': key, spellcheck: 'false', ...extra });
    input.value = value;
    return el('div', { class: 'field' }, el('label', { for: id, text: label }), input);
  };
  const select = (row: number, list: ListName, key: string, label: string, value: string, options: [string, string][]) => {
    const id = `rb-${list}-${row}-${key}`;
    const node = el('select', { id, 'data-field': key }, ...options.map(([v, text]) => el('option', { value: v, text })));
    node.value = value;
    return el('div', { class: 'field' }, el('label', { for: id, text: label }), node);
  };

  const drawRow = (list: ListName, i: number): HTMLLIElement => {
    const li = el('li', { 'data-row': String(i), 'data-list': list });
    if (list === 'mistakes') {
      const m = state.mistakes[i]!;
      li.append(
        field(i, list, 'wrong', 'Wrong', m.wrong),
        field(i, list, 'right', 'Right (optional)', m.right),
        field(i, list, 'note', 'Note (optional)', m.note),
        removeButton(`Remove mistake ${i + 1}`, { 'data-remove': list, 'data-index': String(i) }),
      );
    } else if (list === 'patterns') {
      const p = state.patterns[i]!;
      const ignore = el('input', { type: 'checkbox', 'data-field': 'ignoreCase', id: `rb-patterns-${i}-ic` });
      ignore.checked = p.ignoreCase;
      li.append(
        select(i, list, 'mode', 'Kind', p.mode, [['text', 'Text'], ['find', 'Regular expression']]),
        field(i, list, 'value', p.mode === 'find' ? 'Find (regular expression)' : 'Find (text)', p.value, { 'data-mono': '' }),
        select(i, list, 'level', 'Level', p.level, [['hint', 'Hint'], ['error', 'Error'], ['fix', 'Fix']]),
        field(i, list, 'replace', 'Replace with', p.replace, { 'data-mono': '' }),
        field(i, list, 'whenSource', 'Only when the source contains', p.whenSource),
        field(i, list, 'whenNotSource', 'Only when the source does not contain', p.whenNotSource),
        field(i, list, 'note', 'Note', p.note, {}, true),
        el('label', { class: 'check', for: `rb-patterns-${i}-ic` }, ignore, 'Ignore case (regular expressions)'),
        removeButton(`Remove pattern ${i + 1}`, { 'data-remove': list, 'data-index': String(i) }),
        el('p', { class: 'row-error', 'data-row-error': '', 'aria-live': 'polite' }),
      );
      updatePatternRow(li);
    } else if (list === 'formats') {
      const f = state.dateTime.formats[i]!;
      li.append(
        field(i, list, 'source', 'English format', f.source, { 'data-mono': '' }),
        field(i, list, 'target', 'Your format', f.target, { 'data-mono': '' }),
        removeButton(`Remove format ${i + 1}`, { 'data-remove': list, 'data-index': String(i) }),
        el('p', { class: 'row-error', 'data-row-error': '', 'aria-live': 'polite' }),
      );
    } else {
      const a = state.sentenceEnd.answers[i]!;
      li.append(
        field(i, list, 'text', 'Final mark (regular expression)', a.text, { 'data-mono': '' }),
        field(i, list, 'source', 'Answers this source mark (optional)', a.source, { 'data-mono': '' }),
        removeButton(`Remove final mark ${i + 1}`, { 'data-remove': list, 'data-index': String(i) }),
        el('p', { class: 'row-error', 'data-row-error': '', 'aria-live': 'polite' }),
      );
    }
    showRowError(li);
    return li;
  };

  // What a row would be refused for, said beside it rather than only as the
  // file's first error in the review step.
  function showRowError(li: HTMLElement) {
    const out = li.querySelector<HTMLElement>('[data-row-error]');
    if (!out) return;
    const i = Number(li.dataset.row);
    let problem = '';
    if (li.dataset.list === 'patterns') {
      const p = state.patterns[i];
      if (p) problem = patternProblem(p);
    } else if (li.dataset.list === 'answers') {
      const a = state.sentenceEnd.answers[i];
      if (a && ((a.text !== '' && !compiles(a.text)) || (a.source !== '' && !compiles(a.source)))) problem = 'Not a valid regular expression.';
    } else if (li.dataset.list === 'formats') {
      const f = state.dateTime.formats[i];
      if (f) problem = formatProblem(f, state.dateTime);
    }
    out.textContent = problem;
  }
  function updatePatternRow(li: HTMLElement) {
    const p = state.patterns[Number(li.dataset.row)];
    if (!p) return;
    const valueLabel = li.querySelector<HTMLLabelElement>('label[for$="-value"]');
    if (valueLabel) valueLabel.textContent = p.mode === 'find' ? 'Find (regular expression)' : 'Find (text)';
    const ignore = li.querySelector<HTMLInputElement>('[data-field="ignoreCase"]');
    if (ignore) ignore.disabled = p.mode !== 'find';
  }

  const lists = new Map<ListName, HTMLElement>($$(root, '[data-list]').filter((n) => n.tagName === 'OL').map((n) => [n.dataset.list as ListName, n]));
  const drawList = (name: ListName) => {
    const node = lists.get(name)!;
    node.replaceChildren(...rowsOf(name).map((_, i) => drawRow(name, i)));
  };
  const drawLists = () => {
    for (const name of lists.keys()) drawList(name);
  };
  for (const button of $$(root, '[data-add]')) {
    button.addEventListener('click', () => {
      const name = button.dataset.add as ListName;
      if (name === 'mistakes') state.mistakes.push({ wrong: '', right: '', note: '' });
      else if (name === 'patterns') {
        state.patterns.push({ mode: 'text', value: '', level: 'hint', replace: '', ignoreCase: false, whenSource: '', whenNotSource: '', note: '' });
      } else if (name === 'formats') state.dateTime.formats.push({ source: '', target: '' });
      else state.sentenceEnd.answers.push({ text: '', source: '' });
      drawList(name);
      const rows = $$(lists.get(name)!, 'li');
      rows[rows.length - 1]?.querySelector<HTMLElement>('input, select, textarea')?.focus();
      changed();
    });
  }
  root.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-remove]');
    if (!button) return;
    const name = button.dataset.remove as ListName;
    rowsOf(name).splice(Number(button.dataset.index), 1);
    drawList(name);
    changed();
  });

  // ---- The tester ------------------------------------------------------------
  const trySource = $<HTMLTextAreaElement>(root, '[data-try="source"]');
  const tryTranslation = $<HTMLTextAreaElement>(root, '[data-try="translation"]');
  const results = $(root, '[data-try-results]');
  let trial = 0;
  const describe = async (check: Check): Promise<HTMLLIElement> => {
    const name = `${check.kind === 'mistake' ? 'Mistake' : 'Pattern'} “${check.label}”`;
    if (check.invalid) return el('li', { 'data-tone': 'warn', text: `${name}: not a valid regular expression.` });
    if (!check.applies) return el('li', { 'data-tone': 'quiet', text: `${name}: does not run on this source.` });
    for (const job of check.ops) {
      const outcome = await runner.run(job);
      if ('runaway' in outcome) {
        return el('li', {
          'data-tone': 'warn',
          text: `${name}: took longer than ${PATTERN_BUDGET_MS} ms, so it is left out of the tester. A review would stop it the same way.`,
        });
      }
      if ('error' in outcome) return el('li', { 'data-tone': 'warn', text: `${name}: ${outcome.error}.` });
      if ('text' in outcome) {
        return outcome.text === job.text || outcome.text.trim() === ''
          ? el('li', { 'data-tone': 'quiet', text: `${name} (fix): changes nothing.` })
          : el('li', { 'data-tone': 'hit', text: `${name} (fix): would change the translation to “${outcome.text}”.` });
      }
      if (outcome.match !== null) {
        return el('li', { 'data-tone': 'hit', text: `${name} (${check.level}): fires on “${outcome.match}”.` });
      }
    }
    return el('li', { 'data-tone': 'quiet', text: `${name}: does not fire.` });
  };
  const runTester = async () => {
    const mine = ++trial;
    if (trySource.value === '' && tryTranslation.value === '') {
      results.replaceChildren(el('li', { 'data-tone': 'quiet', text: 'Type a source and a translation to see which mistakes and patterns fire.' }));
      return;
    }
    const checks = checksFor(state, trySource.value, tryTranslation.value, localeTag());
    if (checks.length === 0) {
      results.replaceChildren(el('li', { 'data-tone': 'quiet', text: 'Add a mistake or a pattern to try it here.' }));
      return;
    }
    const items: HTMLLIElement[] = [];
    for (const check of checks) {
      const item = await describe(check);
      // A newer keystroke has started its own run; this one's answers are stale.
      if (mine !== trial) return;
      items.push(item);
    }
    results.replaceChildren(...items);
  };
  trySource.addEventListener('input', () => schedule());
  tryTranslation.addEventListener('input', () => schedule());

  // ---- Review: YAML, validation, download, copy -------------------------------
  const yamlOut = $(root, '[data-yaml]');
  const validity = $(root, '[data-validity]');
  const install = $(root, '[data-install]');
  const fileName = () => `${state.locale || 'rules'}.yaml`;
  const refreshFile = () => {
    yaml = emitRulesYaml(state);
    const mine = ++probing;
    let rules: LocaleRules | undefined;
    try {
      rules = parseRulesText(yaml, fileName());
      // Parsed is not yet valid: rules check also probes every regex, so the
      // file stays unsendable until the probes below have come back.
      fileError = 'the regular expressions are still being checked';
      say(validity, 'Checking the regular expressions…');
    } catch (err) {
      fileError = err instanceof RulesFileError ? err.message : errorText(err);
      say(validity, `Not valid yet: ${fileError}`, 'warn');
    }
    if (rules) {
      probed = probeProblem(rules, (job) => prober.run(job), probePassed).then((problem) => {
        // A newer refresh has its own file and its own probe.
        if (mine !== probing) return;
        fileError = problem;
        if (problem === undefined) say(validity, 'Valid: polyglots reads this file as it is.', 'ok');
        else say(validity, `Not valid yet: ${problem}`, 'warn');
        showShare();
      });
    }
    yamlOut.textContent = yaml;
    install.textContent =
      state.locale === ''
        ? 'Pick a locale in step 1 to name the file.'
        : `Save it as ~/.config/polyglots/locales/${fileName()} (polyglots rules path ${state.locale} prints the exact place), then run polyglots rules check ${state.locale}.`;
    showShare();
  };
  $(root, '[data-download]').addEventListener('click', () => {
    pending.flush();
    const url = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml;charset=utf-8' }));
    const a = el('a', { href: url, download: fileName() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const copyLabel = $(root, '[data-copy-label]');
  $(root, '[data-copy-yaml]').addEventListener('click', async () => {
    pending.flush();
    try {
      await navigator.clipboard.writeText(yaml);
      copyLabel.textContent = 'Copied';
    } catch {
      // No clipboard permission: select the text so a keyboard copy works.
      const range = document.createRange();
      range.selectNodeContents(yamlOut);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      copyLabel.textContent = 'Selected: press copy';
    }
    setTimeout(() => (copyLabel.textContent = 'Copy'), 1800);
  });

  // ---- The agent prompt ------------------------------------------------------------
  // Follows the locale picked in step 1, so the prompt names the language and
  // the file. The page renders the no-locale prompt, so it reads without this.
  const agentBox = $(root, '[data-agent]');
  const agentText = $(root, '[data-agent-text]');
  const agentFull = $(root, '[data-agent-full]');
  const agentDialog = $<HTMLDialogElement>(root, '[data-agent-dialog]');
  let prompt = agentText.textContent ?? '';
  function showAgentPrompt() {
    const row = state.locale === '' ? undefined : resolveLocale(state.locale);
    prompt = agentPrompt({
      wp: row?.wp ?? '',
      language: row ? localeDisplayName(row.id) : '',
      templateUrl: agentBox.dataset.templateUrl!,
      builderUrl: agentBox.dataset.builderUrl!,
    });
    agentText.textContent = prompt;
    agentFull.textContent = prompt;
  }
  const copyPrompt = async (label: HTMLElement, shown: HTMLElement) => {
    try {
      await navigator.clipboard.writeText(prompt);
      label.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(shown);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      label.textContent = 'Selected: press copy';
    }
    setTimeout(() => (label.textContent = 'Copy prompt'), 1800);
  };
  // The box shows only the top of the prompt, so a selection made there would
  // not hold all of it: without the clipboard, the dialog opens to select in.
  $(root, '[data-agent-copy]').addEventListener('click', () => {
    const label = $(root, '[data-agent-copy-label]');
    navigator.clipboard?.writeText(prompt).then(
      () => {
        label.textContent = 'Copied';
        setTimeout(() => (label.textContent = 'Copy prompt'), 1800);
      },
      () => {
        agentDialog.showModal();
        void copyPrompt($(root, '[data-agent-copy-full-label]'), agentFull);
      },
    ) ?? (agentDialog.showModal(), void copyPrompt($(root, '[data-agent-copy-full-label]'), agentFull));
  });
  $(root, '[data-agent-copy-full]').addEventListener('click', () => void copyPrompt($(root, '[data-agent-copy-full-label]'), agentFull));
  $(root, '[data-agent-expand]').addEventListener('click', () => agentDialog.showModal());
  $(root, '[data-agent-close]').addEventListener('click', () => agentDialog.close());
  // A click on the backdrop lands on the dialog element itself.
  agentDialog.addEventListener('click', (event) => {
    if (event.target === agentDialog) agentDialog.close();
  });

  // ---- Share ---------------------------------------------------------------------
  const shareToggle = $<HTMLButtonElement>(root, '[data-share-toggle]');
  const shareForm = $(root, '[data-share]');
  const sendButton = $<HTMLButtonElement>(root, '[data-send]');
  const shareStatus = $(root, '[data-share-status]');
  let sending = false;
  function showShare() {
    const blocker = shareBlocker(share, { locale: state.locale, error: fileError });
    sendButton.disabled = blocker !== undefined || sending;
    if (!sending && !shareStatus.dataset.sticky) say(shareStatus, blocker ?? '', blocker ? 'warn' : undefined);
  }
  shareToggle.addEventListener('click', () => {
    const open = shareForm.hidden;
    shareForm.hidden = !open;
    shareToggle.setAttribute('aria-expanded', String(open));
    if (open) shareForm.querySelector<HTMLInputElement>('input:not([tabindex="-1"])')?.focus();
  });
  shareForm.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    const key = input.dataset.shareField as keyof ShareFields | undefined;
    if (!key) return;
    if (key === 'consent') share.consent = input.checked;
    else share[key] = input.value;
    delete shareStatus.dataset.sticky;
    showShare();
  });
  sendButton.addEventListener('click', async () => {
    pending.flush();
    // A click inside the debounce starts a fresh probe; send once it answers
    // rather than refusing a click the person made on a valid file.
    await probed;
    if (shareBlocker(share, { locale: state.locale, error: fileError }) !== undefined) return;
    sending = true;
    showShare();
    say(shareStatus, 'Sending…');
    const result = await sendRules(fetch.bind(window), { locale: state.locale, yaml, fields: share });
    sending = false;
    // The result stays on screen until the person changes a field.
    shareStatus.dataset.sticky = '1';
    say(shareStatus, result.message, result.ok ? 'ok' : 'warn');
    showShare();
  });

  // ---- Steps ---------------------------------------------------------------------
  const sections = $$(root, '[data-step]');
  const stepButtons = $$<HTMLButtonElement>(root, '[data-goto]');
  const prev = $<HTMLButtonElement>(root, '[data-prev]');
  const next = $<HTMLButtonElement>(root, '[data-next]');
  const show = (n: number, focus = false) => {
    step = Math.max(0, Math.min(STEPS - 1, n));
    sections.forEach((s) => (s.hidden = Number(s.dataset.step) !== step));
    stepButtons.forEach((b) => (Number(b.dataset.goto) === step ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current')));
    prev.disabled = step === 0;
    next.hidden = step === STEPS - 1;
    if (focus) sections[step]?.querySelector<HTMLElement>('h2')?.focus();
    persist();
  };
  for (const s of sections) s.querySelector('h2')?.setAttribute('tabindex', '-1');
  stepButtons.forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.goto), true)));
  prev.addEventListener('click', () => show(step - 1, true));
  next.addEventListener('click', () => show(step + 1, true));

  // ---- Change propagation ------------------------------------------------------
  const pending = debounce(() => {
    refreshFile();
    void runTester();
  }, 150);
  function schedule() {
    pending.schedule();
  }
  function changed() {
    persist();
    showCounts();
    schedule();
  }
  function load(next: BuilderState) {
    state = next;
    localeInput.value = state.locale;
    showLocale();
    fillBound();
    drawRules();
    tagBoxes.forEach(drawTags);
    drawLists();
    // Open the advanced section when what was loaded uses it, so nothing in
    // the file is hidden from the person who is about to edit it.
    if (state.patterns.length > 0 || state.sentenceEnd.answers.length > 0 || state.sentenceEnd.unmarked || state.sentenceEnd.notEnding !== '') {
      $<HTMLDetailsElement>(form, '[data-advanced]').open = true;
    }
    changed();
  }

  load(state);
  if (request.conflict) {
    const { saved: kept, asked: wanted } = request.conflict;
    const restart = el('button', { type: 'button', class: 'btn quiet', text: `Start over for ${wanted}` });
    // The saved work for the other locale is all the page keeps, and load
    // overwrites it in storage at once, so this asks as the reset does.
    restart.addEventListener('click', () => {
      if (hasContent(state) && !confirm(`Clear your ${kept} work and start over for ${wanted}?`)) return;
      load(emptyBuilderState(wanted));
      say(fetchStatus, `Started over for ${wanted}.`);
    });
    say(fetchStatus, `The link asked for ${wanted}, but your saved work is for ${kept}, so it stays ${kept}. `, 'warn');
    fetchStatus.append(restart);
    // The notice sits on the first step, so open there rather than at the
    // saved step, where it would go unseen.
    step = 0;
  }
  show(step);
  refreshFile();
  void runTester();
}
