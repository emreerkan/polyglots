import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { emitRulesYaml, emptyBuilderState, type BuilderPattern } from '../../app/src/rules/emit.js'
import { parseRulesText } from '../../app/src/rules/parse.js'
import { runRegexOps, skippedFor } from '../../app/src/rules/sandbox.js'
import { debounce } from '../src/components/rules-builder/debounce.js'
import { checksFor, literalSource, patternProblem, type RegexJob } from '../src/components/rules-builder/match.js'
import { probeProblem } from '../src/components/rules-builder/probe.js'
import { emptyShare, sendRules, shareBlocker, type ShareFields } from '../src/components/rules-builder/share.js'
import { applyAskedLocale, restoreSaved } from '../src/components/rules-builder/store.js'

const contact = (patch: Partial<ShareFields> = {}): ShareFields => ({ ...emptyShare(), slack: 'emre', consent: true, ...patch })

// A fetch that answers once with the given status and body, and records what it was asked.
function answering(status: number, body: string, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(body, { status, headers })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

test('share: posts the file same-origin with only the contacts given', async () => {
  const { fetchFn, calls } = answering(200, '{"ok":true}', { 'content-type': 'application/json' })
  const result = await sendRules(fetchFn, { locale: 'tr_TR', yaml: 'schema: 2\n', fields: contact({ wporg: ' emreerkan ', website: '' }) })
  assert.deepEqual(result, { ok: true, message: 'Sent. The maintainer may contact you on Slack.' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, '/polyglots/api/rules')
  assert.equal(calls[0]!.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    locale: 'tr_TR',
    yaml: 'schema: 2\n',
    wporg: 'emreerkan',
    slack: 'emre',
    consent: true,
    website: '',
  })
})

test('share: a refusal shows the server\'s reason in one line', async () => {
  const { fetchFn } = answering(400, '{"error":"email is not an address"}', { 'content-type': 'application/json' })
  const result = await sendRules(fetchFn, { locale: 'tr_TR', yaml: 'x', fields: contact() })
  assert.equal(result.ok, false)
  assert.match(result.message, /email is not an address/)
  assert.doesNotMatch(result.message, /\n/)
})

test('share: a busy server says when to try again', async () => {
  const { fetchFn } = answering(503, '{"error":"too many submissions this hour"}', { 'content-type': 'application/json', 'retry-after': '1200' })
  const result = await sendRules(fetchFn, { locale: 'tr_TR', yaml: 'x', fields: contact() })
  assert.equal(result.ok, false)
  assert.match(result.message, /too many submissions this hour/)
  assert.match(result.message, /20 minutes/)
})

test('share: an endpoint that is not there yet is an error, not a success', async () => {
  const { fetchFn } = answering(404, '<!doctype html><title>Not found</title>', { 'content-type': 'text/html' })
  const result = await sendRules(fetchFn, { locale: 'tr_TR', yaml: 'x', fields: contact() })
  assert.equal(result.ok, false)
  assert.match(result.message, /404/)
  assert.doesNotMatch(result.message, /doctype/)
})

test('share: a network failure is an error that points at the download', async () => {
  const fetchFn = (async () => {
    throw new TypeError('Failed to fetch')
  }) as unknown as typeof fetch
  const result = await sendRules(fetchFn, { locale: 'tr_TR', yaml: 'x', fields: contact() })
  assert.equal(result.ok, false)
  assert.match(result.message, /Download/)
})

test('share: the button says why it cannot send', () => {
  const ok = { locale: 'tr_TR', error: undefined }
  assert.equal(shareBlocker(contact(), ok), undefined)
  assert.match(shareBlocker(contact(), { locale: 'tr_TR', error: 'patterns.0.find is not a valid regular expression' })!, /not valid/)
  assert.match(shareBlocker(contact(), { locale: '', error: undefined })!, /locale/)
  assert.match(shareBlocker(contact({ slack: '', wporg: 'emreerkan' }), ok)!, /Slack, GitHub or email/)
  assert.match(shareBlocker(contact({ slack: '', email: 'not-an-address' }), ok)!, /email/)
  assert.match(shareBlocker(contact({ consent: false }), ok)!, /checkbox/)
})

test('store: anything unreadable restores an empty builder', () => {
  for (const raw of [null, 'x', 42, { state: 'x' }, { state: { patterns: 'no' } }]) {
    const { state, step } = restoreSaved(raw)
    assert.equal(step, 0)
    assert.deepEqual({ ...state, locale: '' }, emptyBuilderState(''))
  }
})

test('store: keeps what is well formed and drops what is not', () => {
  const { state, step } = restoreSaved({
    step: 3,
    state: {
      locale: 'tr_TR',
      guidance: 'Use siz.',
      formality: 'casual',
      enable: ['title-case', 7],
      mistakes: [{ wrong: 'herşey', right: 'her şey', note: '' }, { wrong: 3 }],
      register: { audit: 'a' },
    },
  })
  assert.equal(step, 3)
  assert.equal(state.locale, 'tr_TR')
  assert.equal(state.guidance, 'Use siz.')
  assert.equal(state.formality, '')
  assert.deepEqual(state.enable, ['title-case'])
  assert.deepEqual(state.mistakes, [{ wrong: 'herşey', right: 'her şey', note: '' }])
  assert.deepEqual(state.register, { audit: 'a', translate: '' })
})

test('tester: a literal follows the locale\'s own casing', () => {
  const re = new RegExp(literalSource('içerik', 'tr'), 'gu')
  assert.ok(re.test('Bu İçerik'))
  assert.equal(new RegExp(literalSource('içerik', 'tr'), 'gu').test('ICERIK'), false)
})

const pattern = (patch: Partial<BuilderPattern>): BuilderPattern => ({
  mode: 'text',
  value: '',
  level: 'hint',
  replace: '',
  ignoreCase: false,
  whenSource: '',
  whenNotSource: '',
  note: '',
  ...patch,
})

test('tester: conditions on the source decide which checks run', () => {
  const state = {
    ...emptyBuilderState('es_ES'),
    mistakes: [{ wrong: 'loguear', right: 'iniciar sesión', note: '' }],
    patterns: [
      pattern({ value: 'blog', whenNotSource: 'blog' }),
      pattern({ mode: 'find', value: 'e-?mail', ignoreCase: true, whenSource: 'mail' }),
      pattern({ mode: 'find', value: ' {2,}', level: 'fix', replace: ' ' }),
    ],
  }
  const checks = checksFor(state, 'Read the blog by email', 'Lee el blog  por E-mail', 'es')
  assert.deepEqual(
    checks.map((c) => [c.label, c.applies]),
    [
      ['loguear', true],
      ['blog', false],
      ['e-?mail', true],
      [' {2,}', true],
    ],
  )
  const regex = checks[2]!
  assert.equal(regex.ops[0]!.flags, 'gui')
  assert.equal(checks[3]!.ops[0]!.replace, ' ')
})

test('tester: a literal keeps its edge spaces, as the file does', () => {
  const state = {
    ...emptyBuilderState('fr_FR'),
    mistakes: [{ wrong: ' ki ', right: '', note: '' }],
    patterns: [pattern({ value: ' :', whenSource: ' :' })],
  }
  const checks = checksFor(state, 'Name:', 'Nom: kilo', 'fr')
  assert.deepEqual(
    checks.map((c) => [c.label, c.applies]),
    [
      [' ki ', true],
      [' :', false],
    ],
  )
  assert.equal(checks[0]!.ops[0]!.source, literalSource(' ki ', 'fr'))
})

test('tester: an empty translation runs nothing', () => {
  const state = { ...emptyBuilderState('es_ES'), patterns: [pattern({ value: 'blog' })] }
  assert.equal(checksFor(state, 'blog', '  ', 'es')[0]!.applies, false)
})

test('tester: a pattern is named by its note when it has one', () => {
  const state = { ...emptyBuilderState('es_ES'), patterns: [pattern({ mode: 'find', value: '\\s{2,}', note: ' One space ' })] }
  assert.equal(checksFor(state, 'a', 'b', 'es')[0]!.label, 'One space')
})

// Download, Copy and Send read the file the last refresh built. A click
// inside the debounce after an edit must not ship the file from before it.
test('debounce: flush runs a pending refresh now, and only once', async () => {
  let runs = 0
  const refresh = debounce(() => runs++, 20)
  refresh.schedule()
  refresh.flush()
  assert.equal(runs, 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(runs, 1)
  refresh.flush()
  assert.equal(runs, 1)
})

test('debounce: a schedule with no flush runs once after the wait', async () => {
  let runs = 0
  const refresh = debounce(() => runs++, 10)
  refresh.schedule()
  refresh.schedule()
  assert.equal(runs, 0)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(runs, 1)
})

// A fix with an empty replace deletes what it finds, and the app reads it as
// such. The row must say no more than the parser would.
test('rows: a deletion fix is no problem, as the app reads it', () => {
  const p: BuilderPattern = { mode: 'find', value: '\\s+(?=[.,])', level: 'fix', replace: '', ignoreCase: false, whenSource: '', whenNotSource: '', note: '' }
  const yaml = emitRulesYaml({ ...emptyBuilderState('tr_TR'), patterns: [p] })
  assert.equal(parseRulesText(yaml, 'tr_TR.yaml').patterns[0]?.replace, '')
  assert.equal(patternProblem(p), '')
  assert.equal(patternProblem({ ...p, value: '(' }), 'Not a valid regular expression.')
})

// The page's Web Worker cannot run under node, so the probe is handed the
// app's own sandbox instead: the same budget, enforced the same way, over the
// same strings rules check uses.
let probeId = 0
const sandboxRun = async (job: RegexJob) => {
  const id = `builder-probe-${probeId++}`
  const [result] = runRegexOps([{ kind: 'exec', id, source: job.source, flags: job.flags, text: job.text }])
  return skippedFor(id) ? { runaway: true as const } : { match: result?.match ?? null }
}

// rules check refuses a regex that runs away on its probes, and the page
// tells the person to run rules check, so the page must not call that file valid.
test('validity: a regex that runs away on the probes is not valid', async () => {
  const yaml = emitRulesYaml({
    ...emptyBuilderState('tr_TR'),
    patterns: [pattern({ mode: 'find', value: '\\s{2,}' }), pattern({ mode: 'find', value: '(a+)+$' })],
  })
  const problem = await probeProblem(parseRulesText(yaml, 'tr_TR.yaml'), sandboxRun)
  assert.match(problem ?? '', /patterns\.1\.find/)
  assert.match(problem ?? '', /\(a\+\)\+\$/)
  assert.match(problem ?? '', /100 ms/)
})

test('validity: ordinary regexes pass the probes', async () => {
  const yaml = emitRulesYaml({ ...emptyBuilderState('tr_TR'), patterns: [pattern({ mode: 'find', value: '\\s{2,}' })] })
  assert.equal(await probeProblem(parseRulesText(yaml, 'tr_TR.yaml'), sandboxRun), undefined)
})

// RegexRunner builds its Worker inside run's promise chain, so a constructor
// that throws (a worker-src refusal, say) arrives as a rejection. Left to
// escape, it rejected the page's probe unhandled: the validity line stayed on
// "Checking the regular expressions…" and Send, awaiting the probe, did
// nothing. A thrown run is an untested file, the same as a worker that would
// not start, and gets the same answer.
test('validity: a run that throws is reported as untested, not left hanging', async () => {
  const yaml = emitRulesYaml({ ...emptyBuilderState('tr_TR'), patterns: [pattern({ mode: 'find', value: '\\s{2,}' })] })
  const rules = parseRulesText(yaml, 'tr_TR.yaml')
  const refused = new Error('Refused to create a worker')
  const rejecting = (): Promise<never> => Promise.reject(refused)
  const throwing = (): never => {
    throw refused
  }
  for (const run of [rejecting, throwing]) {
    const problem = await probeProblem(rules, run)
    assert.match(problem ?? '', /could not be tested in this browser \(Refused to create a worker\)/)
  }
})

// The app's link names a locale in the address. Saved work for another
// locale must not be relabelled to it, or de_DE rules leave the page as tr_TR.
test('store: an address locale does not relabel saved work for another locale', () => {
  const saved = { ...emptyBuilderState('de_DE'), guidance: 'Sie, nicht du.' }
  const { state, conflict } = applyAskedLocale(saved, 'tr_TR')
  assert.equal(state.locale, 'de_DE')
  assert.equal(state.guidance, 'Sie, nicht du.')
  assert.deepEqual(conflict, { saved: 'de_DE', asked: 'tr_TR' })
})

test('store: an address locale switches an empty or same-locale state silently', () => {
  const empty = applyAskedLocale(emptyBuilderState('de_DE'), 'tr_TR')
  assert.equal(empty.state.locale, 'tr_TR')
  assert.equal(empty.conflict, undefined)
  const same = applyAskedLocale({ ...emptyBuilderState('tr_TR'), guidance: 'siz' }, 'tr_TR')
  assert.equal(same.state.guidance, 'siz')
  assert.equal(same.conflict, undefined)
  // Work with no locale yet belongs to none, so the address may name it.
  const unnamed = applyAskedLocale({ ...emptyBuilderState(''), guidance: 'siz' }, 'tr_TR')
  assert.equal(unnamed.state.locale, 'tr_TR')
  assert.equal(unnamed.conflict, undefined)
  assert.equal(applyAskedLocale(emptyBuilderState('de_DE'), undefined).state.locale, 'de_DE')
})

// ---- The agent prompt, the template it points at, and pasting the answer back

test('agent prompt: names the locale, the file, the template and every key the schema takes', async () => {
  const { agentPrompt } = await import('../src/components/rules-builder/agent-prompt.js')
  const { localeRulesSchema } = await import('../../app/src/rules/schema.js')
  const { BUILT_IN_RULES } = await import('../../app/src/rules/names.js')
  const prompt = agentPrompt({
    wp: 'de_DE',
    language: 'German',
    templateUrl: 'https://ada.tools/polyglots/rules-builder/template.txt',
    builderUrl: 'https://ada.tools/polyglots/rules-builder/',
  })
  assert.match(prompt, /German \(de_DE\)/)
  assert.match(prompt, /de_DE\.yaml/)
  assert.match(prompt, /https:\/\/ada\.tools\/polyglots\/rules-builder\/template\.txt/)
  // A key the schema gains and the prompt does not mention would have agents
  // writing files that leave it out, or guessing its shape.
  for (const key of Object.keys(localeRulesSchema.shape)) assert.ok(prompt.includes(key), `prompt does not mention ${key}`)
  for (const rule of BUILT_IN_RULES) assert.ok(prompt.includes(rule), `prompt does not mention the rule ${rule}`)
  assert.match(prompt, /2,500/)
  assert.match(prompt, /1,500/)
  assert.match(prompt, /500/)
})

test('agent prompt: without a locale it asks the agent to find out which one', async () => {
  const { agentPrompt } = await import('../src/components/rules-builder/agent-prompt.js')
  const prompt = agentPrompt({ wp: '', language: '', templateUrl: 'https://x/template.txt', builderUrl: 'https://x/' })
  assert.match(prompt, /Ask me which WordPress locale/)
  assert.doesNotMatch(prompt, /undefined|\(\)/)
})

test('template: every section of the rules file, for no locale in particular', async () => {
  const { rulesTemplate } = await import('../src/lib/rules-template.js')
  const text = rulesTemplate()
  for (const key of ['schema: 2', 'rules:', 'glossaryStemRatio', 'properNouns', 'mistakes', 'patterns', 'guidance', 'capitalization', 'register', 'formality', 'sentenceEnd', 'notSource']) {
    assert.ok(text.includes(key), `template lacks ${key}`)
  }
  assert.match(text, /^# polyglots rules for <wp_code>$/m)
  assert.match(text, /polyglots rules check <wp_code>/)
  // Rendered for some locale and then made generic: no trace of it may stay.
  assert.doesNotMatch(text, /\b[a-z]{2,3}_[A-Z]{2}\b/)
  // As written, it is a valid file that changes nothing.
  parseRulesText(text, 'template.yaml')
})

test('paste: a valid file becomes the builder state, under the chosen locale', async () => {
  const { stateFromPasted } = await import('../src/components/rules-builder/paste.js')
  const result = stateFromPasted('schema: 2\nformality: formal\nmistakes:\n  - wrong: e-mail\n    right: E-Mail\n', 'de_DE')
  assert.ok('state' in result)
  assert.equal(result.state.locale, 'de_DE')
  assert.equal(result.state.formality, 'formal')
  assert.equal(result.state.mistakes[0]!.wrong, 'e-mail')
})

test('paste: an agent answer wrapped in a code fence still loads', async () => {
  const { stateFromPasted } = await import('../src/components/rules-builder/paste.js')
  const result = stateFromPasted('Here is the file:\n\n```yaml\nschema: 2\nformality: informal\n```\n', 'de_DE')
  assert.ok('state' in result)
  assert.equal(result.state.formality, 'informal')
})

test('paste: an invalid or empty file says why and loads nothing', async () => {
  const { stateFromPasted } = await import('../src/components/rules-builder/paste.js')
  const bad = stateFromPasted('schema: 2\nrules:\n  enable: [nope]\n', 'de_DE')
  assert.ok('error' in bad)
  assert.match(bad.error, /nope/)
  const empty = stateFromPasted('   \n', 'de_DE')
  assert.ok('error' in empty)
  assert.match(empty.error, /empty/i)
})
