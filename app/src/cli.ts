#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { fileURLToPath } from 'node:url'
import { Command, CommanderError } from 'commander'
import { exportGlossary } from './commands/glossary-export.js'
import { exportTm, type TmExportFormat } from './commands/tm-export.js'
import { fetchProjects, resolveProjects } from './commands/fetch.js'
import { runFetch, type FetchFlags } from './cli/fetch.js'
import { warnAboutLocalModel, warnAboutLocalReview, warnUniversalOnly } from './cli/run-notices.js'
import { copyRules, describeRules, editRules, openInEditor, type OpenEditor } from './cli/rules.js'
import { loadLocaleRules, localeRulesFile } from './rules/load.js'
import { syncGlossary } from './commands/glossary-sync.js'
import { reviewFile } from './commands/review.js'
import { splitPo } from './commands/split.js'
import { watchKeys } from './cli/keys.js'
import { createRunControl, type RunState } from './run-control.js'
import { importTmx } from './commands/tm-import.js'
import { translateFile, type TranslateSummary } from './commands/translate.js'
import { DEFAULT_STATS_FILE, serveStats, writeStats } from './commands/stats.js'
import { openJobsDb } from './jobs/db.js'
import { stopOwnRuns } from './jobs/runs.js'
import { stopOnSignal } from './jobs/stop-on-signal.js'
import { portInUseWarning } from './stats/server.js'
import { DEFAULT_CONFIG, isHttpUrl, loadConfig, loadSecrets, maskSecret, saveConfig, saveSecret, unsetConfig } from './config.js'
import {
  UsageError,
  expandFileArgs,
  isSecretName,
  parseCsvDelimiter,
  parseDraftEngine,
  parseReviewProvider,
  parseLocaleArg,
  parsePositiveInt,
  parseSecretName,
  secretForEngine,
} from './cli/args.js'
import { createProgressReporter, createReviewProgressReporter } from './cli/progress.js'
import { loadPo } from './po/po-file.js'
import { headerLocaleNotice, localeDefaultHelp, requireLocale, resolveFileLocale } from './cli/locale.js'
import { buildReport } from './review/message.js'
import { agentBinOverride, batchAdvice, configuredModel } from './agent/providers.js'
import { discoverAgents, type AgentStatus } from './agent/discover.js'
import {
  checkLocalModel,
  discoverModels,
  kindLabel,
  matchesModel,
  modelFacts,
  serverBaseUrl,
  sanitizeDisplay,
  serverLabel,
  unavailableLine,
  type ModelCheck,
  type ModelServer,
} from './draft/discover.js'
import { localModelId, resolveLocalTarget, type LocalTarget } from './draft/local-chat.js'
import { createPainter, type Painter } from './ui/paint.js'
import { errorLine, header, hintLine, nextLine, okLine, warnLine } from './ui/messages.js'
import { table } from './ui/layout.js'
import { reviewSummary, statsServingSummary, statsSummary, translateSummary } from './cli/summaries.js'
import { LOCAL_REVIEW_NOTICE, localReviewBatchSize } from './review/local.js'
import type { RunTuiOptions } from './tui/index.js'
import type { DraftEngineChoice, Locale, PolyglotsConfig } from './types.js'
import { VERSION } from './version.js'
import { previewUsagePayload, resetUsageState, sendUsageInBackground, usageStatus, usageStateFile } from './usage/index.js'
import { checkForUpdate, updateCheckEnabled, updateNotice } from './update/index.js'

const EXIT_OK = 0
const EXIT_ERROR = 1
const EXIT_USAGE = 2
const EXIT_STOPPED = 3


export interface CliStreams {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: { isTTY?: boolean; columns?: number; write(chunk: string): boolean }
  stderr: { isTTY?: boolean; columns?: number; write(chunk: string): boolean }
}

export type RunTui = (opts?: RunTuiOptions) => Promise<void>

export interface CliDeps {
  streams?: Partial<CliStreams>
  translate?: typeof translateFile
  importTmx?: typeof importTmx
  syncGlossary?: typeof syncGlossary
  exportGlossary?: typeof exportGlossary
  exportTm?: typeof exportTm
  reviewFile?: typeof reviewFile
  splitPo?: typeof splitPo
  writeStats?: typeof writeStats
  serveStats?: typeof serveStats
  resolveProjects?: typeof resolveProjects
  fetchProjects?: typeof fetchProjects
  openEditor?: OpenEditor
  runTui?: RunTui
  discoverAgents?: typeof discoverAgents
  discoverModels?: typeof discoverModels
  checkLocalModel?: typeof checkLocalModel
  // Records this process's running rows as stopped when a signal ends a run,
  // and sends the signal on; see stopOnSignal. Injected for tests, where a
  // real signal ends the worker and the real stop opens jobs.db.
  stopOwnRuns?: () => number
  raiseSignal?: (signal: NodeJS.Signals) => void
  // Injected so tests decide colour and glyphs themselves, instead of
  // inheriting whatever LANG, TERM or NO_COLOR the machine running them has.
  env?: NodeJS.ProcessEnv
  // Starts the weekly usage send without waiting for it (src/usage). Injected
  // so a test can see whether a command starts one without any request.
  sendUsage?: () => void
  // Resolves with the newer version npm holds, or undefined (src/update).
  // Injected so no test, and no website demo, asks the registry.
  checkUpdate?: () => Promise<string | undefined>
}

interface Cli {
  streams: CliStreams
  translate: typeof translateFile
  importTmx: typeof importTmx
  syncGlossary: typeof syncGlossary
  exportGlossary: typeof exportGlossary
  exportTm: typeof exportTm
  reviewFile: typeof reviewFile
  splitPo: typeof splitPo
  writeStats: typeof writeStats
  serveStats: typeof serveStats
  resolveProjects: typeof resolveProjects
  fetchProjects: typeof fetchProjects
  openEditor: OpenEditor
  runTui: RunTui
  discoverAgents: typeof discoverAgents
  discoverModels: typeof discoverModels
  checkLocalModel: typeof checkLocalModel
  // Listens for SIGINT and SIGTERM until the returned function is called.
  stopRunsOnSignal: () => () => void
  config: () => PolyglotsConfig
  // One painter per stream, because the two can disagree: stdout piped into
  // a file while stderr is still on a terminal.
  ui: { out: Painter; err: Painter }
  out(line: string): void
  err(line: string): void
}

// Loaded lazily so subcommands never pay for ink/react startup.
const loadTui: RunTui = async (opts) => {
  const { runTui } = await import('./tui/index.js')
  await runTui(opts)
}

function createCli(deps: CliDeps): Cli {
  const streams: CliStreams = {
    stdin: deps.streams?.stdin ?? process.stdin,
    stdout: deps.streams?.stdout ?? process.stdout,
    stderr: deps.streams?.stderr ?? process.stderr,
  }
  let cached: PolyglotsConfig | undefined
  const env = deps.env ?? process.env
  return {
    streams,
    ui: { out: createPainter(streams.stdout, env, streams.stderr), err: createPainter(streams.stderr, env, streams.stdout) },
    translate: deps.translate ?? translateFile,
    importTmx: deps.importTmx ?? importTmx,
    syncGlossary: deps.syncGlossary ?? syncGlossary,
    exportGlossary: deps.exportGlossary ?? exportGlossary,
    exportTm: deps.exportTm ?? exportTm,
    reviewFile: deps.reviewFile ?? reviewFile,
    splitPo: deps.splitPo ?? splitPo,
    writeStats: deps.writeStats ?? writeStats,
    serveStats: deps.serveStats ?? serveStats,
    resolveProjects: deps.resolveProjects ?? resolveProjects,
    fetchProjects: deps.fetchProjects ?? fetchProjects,
    openEditor: deps.openEditor ?? openInEditor,
    runTui: deps.runTui ?? loadTui,
    discoverAgents: deps.discoverAgents ?? discoverAgents,
    discoverModels: deps.discoverModels ?? discoverModels,
    checkLocalModel: deps.checkLocalModel ?? checkLocalModel,
    stopRunsOnSignal: () =>
      stopOnSignal({
        // Only installed around a run, so a run is what a signal interrupts.
        busy: () => true,
        stop: () => void (deps.stopOwnRuns ?? stopOwnRunsInJobsDb)(),
        ...(deps.raiseSignal === undefined ? {} : { raise: deps.raiseSignal }),
      }),
    config: () => (cached ??= loadConfig()),
    out: (line) => streams.stdout.write(`${line}\n`),
    err: (line) => streams.stderr.write(`${line}\n`),
  }
}

// Resolves to undefined when the interface closes without an answer (Ctrl-D, Ctrl-C in
// terminal mode, or a closed pipe); rl.question alone would leave the promise pending.
function ask(streams: CliStreams, question: string, hidden: boolean): Promise<string | undefined> {
  return new Promise((resolve) => {
    const output = hidden ? new Writable({ write: (_chunk, _enc, cb) => cb() }) : streams.stderr
    const rl = createInterface({ input: streams.stdin, output: output as NodeJS.WritableStream, terminal: hidden })
    let settled = false
    const settle = (answer: string | undefined) => {
      if (settled) return
      settled = true
      rl.close()
      resolve(answer)
    }
    rl.once('close', () => settle(undefined))
    rl.question(question, settle)
  })
}

async function confirm(streams: CliStreams, question: string): Promise<boolean> {
  const answer = await ask(streams, question, false)
  return answer !== undefined && /^y(es)?$/i.test(answer.trim())
}

async function readSecretFromStdin(streams: CliStreams, name: string): Promise<string | undefined> {
  if (!streams.stdin.isTTY) {
    const raw = await text(streams.stdin)
    return raw.split(/\r?\n/)[0] ?? ''
  }
  streams.stderr.write(`Enter value for ${name} (input hidden): `)
  try {
    return await ask(streams, '', true)
  } finally {
    streams.stderr.write('\n')
  }
}

// What the header names as the reviewer: provider and, when known, model,
// the same id the verdict cache keys on, so the line says whose judgement the
// run is about to record.
function reviewerLabel(config: PolyglotsConfig, model: string | undefined): string {
  if (config.reviewProvider === 'none') return 'rules only'
  if (config.reviewProvider === 'local') {
    try {
      return localModelId(resolveLocalTarget(config, model))
    } catch {
      return 'local (no model chosen)'
    }
  }
  const chosen = model ?? configuredModel(config.reviewProvider)
  return chosen ? `${config.reviewProvider}:${chosen}` : config.reviewProvider
}

// What translate's header says about the review pass. Not reviewerLabel's
// "rules only": translate runs no review rules of its own, and the two cases
// with no reviewer differ in what they leave the person to check.
function translateReviewerLabel(config: PolyglotsConfig, draftEngine: DraftEngineChoice, model: string | undefined): string {
  if (draftEngine === 'none') return 'skipped (nothing drafted)'
  if (config.reviewProvider === 'none') return 'none, drafts written fuzzy'
  return reviewerLabel(config, model)
}

async function countTranslated(files: string[]): Promise<number> {
  let n = 0
  for (const file of files) {
    const po = await loadPo(file)
    n += po.units('all').length - po.units('pending').length
  }
  return n
}

interface TranslateFlags {
  all?: boolean
  fresh?: boolean
  dryRun?: boolean
  draftEngine?: string
  locale?: string
  batchSize?: string
  model?: string
  localModel?: string
  yes?: boolean
}

interface ReviewFlags {
  locale?: string
  outDir?: string
  ai?: boolean
  batchSize?: string
  fresh?: boolean
}

async function runTranslate(cli: Cli, patterns: string[], flags: TranslateFlags): Promise<number> {
  const files = expandFileArgs(patterns)
  const config = cli.config()
  const { locale, fromHeader } = await resolveFileLocale(flags.locale, config, files, {
    antigravity: config.reviewProvider === 'antigravity',
  })
  if (fromHeader) cli.err(hintLine(cli.ui.err, headerLocaleNotice(locale)))
  loadLocaleRules(locale)
  warnUniversalOnly(cli, locale)
  const draftEngine = parseDraftEngine(flags.draftEngine ?? config.defaultDraftEngine)
  // With no engine nothing is drafted, so nothing is reviewed either: the
  // local reviewer is neither checked nor warned about for a run that will
  // never ask it anything.
  const localReview = config.reviewProvider === 'local' && draftEngine !== 'none'
  const batchSize = resolveBatchSize(config, flags.batchSize)
  const dryRun = flags.dryRun === true
  const mustConfirm = flags.all === true && flags.yes !== true && !dryRun
  // The prompt is written to stderr, so a redirected stderr would leave the user staring at
  // a silent process waiting for input.
  const interactive = cli.streams.stdin.isTTY === true && cli.streams.stderr.isTTY === true
  if (mustConfirm && !interactive) {
    throw new UsageError('--all requires --yes when stdin or stderr is not a terminal (it re-translates already-translated entries)')
  }

  const secrets = loadSecrets()
  const secretName = secretForEngine(draftEngine)
  if (secretName && !secrets[secretName]?.trim()) {
    throw new Error(`Draft engine "${draftEngine}" needs ${secretName}. Set it with: polyglots config set-key ${secretName}`)
  }
  // A local engine has no key to check, so its runner is asked instead, once
  // per invocation and before the --all question, so the warning is read
  // before saying yes. It warns and never refuses: a model mid-pull, a proxy
  // in front of Ollama or a name the matcher does not know would all read as
  // missing, and the first batch's own error stays the authoritative one. An
  // OpenAI-compatible target with no model at all is refused, by
  // resolveLocalTarget, because no run with it can succeed.
  const draftTarget = draftEngine === 'local' ? resolveLocalTarget(config, flags.localModel) : undefined
  if (draftTarget) await warnAboutLocalModel(cli, draftTarget)
  if (localReview) {
    const reviewTarget = resolveLocalTarget(config, flags.model)
    // The same model drafting and reviewing is asked about once.
    const same = draftTarget !== undefined && localModelId(draftTarget) === localModelId(reviewTarget)
    await warnAboutLocalReview(cli, reviewTarget, batchSize, locale, same ? 'skip-check' : 'check')
  }

  if (mustConfirm) {
    const n = await countTranslated(files)
    if (!(await confirm(cli.streams, `This will re-translate ${n} already-translated entries. Continue? [y/N] `))) {
      cli.err(warnLine(cli.ui.err, 'Aborted.'))
      return EXIT_ERROR
    }
  }

  // One unreadable file must not abort the rest of a multi-file run; report it and move on.
  let failed = 0
  for (const file of files) {
    for (const line of header(cli.ui.err, 'translate', file, [
      ['locale', locale],
      ['draft', draftEngine === 'none' ? 'none (translation memory only)' : draftEngine],
      ['review', translateReviewerLabel(config, draftEngine, flags.model)],
    ])) cli.err(line)
    const report = createProgressReporter(cli.streams.stderr, cli.ui.err)
    let summary: TranslateSummary
    const unwatchSignals = cli.stopRunsOnSignal()
    try {
      summary = await cli.translate({
        file,
        locale,
        mode: flags.all ? 'all' : 'pending',
        draftEngine,
        ...(flags.fresh ? { fresh: true } : {}),
        dryRun,
        batchSize,
        model: flags.model,
        ...(flags.localModel ? { localModel: flags.localModel } : {}),
        secrets,
        // No agent is spawned when nothing is drafted, so none is named.
        bin: draftEngine === 'none' ? undefined : agentBinOverride(config.reviewProvider, process.env),
        onProgress: report,
      })
    } catch (error) {
      report.finish()
      cli.err(errorLine(cli.ui.err, `${file}: ${errorMessage(error)}`))
      failed += 1
      continue
    } finally {
      unwatchSignals()
    }
    report.finish()
    for (const line of translateSummary(cli.ui.out, summary, dryRun)) cli.out(line)
    if (summary.stopped) {
      cli.err(warnLine(cli.ui.err, `Stopped: ${summary.stopped}`))
      cli.err(hintLine(cli.ui.err, 'Already-written entries are kept; re-run the same command to resume.'))
      return EXIT_STOPPED
    }
  }
  return failed > 0 ? EXIT_ERROR : EXIT_OK
}

/**
 * The batch size a run uses: the flag, or the configured one, or for the
 * experimental local reviewer the smaller of that and its own default. A
 * batch sized for an agent (the configured value is often 100) is three
 * times what an 8k context holds, and a prompt over the edge is cut without
 * a word on most local servers.
 */
function resolveBatchSize(config: PolyglotsConfig, flag: string | undefined): number {
  if (flag !== undefined) return parsePositiveInt('--batch-size', flag)
  return config.reviewProvider === 'local' ? localReviewBatchSize(config.batchSize) : config.batchSize
}

// defaultLocale named first and by hand: it has no default, so it is not a key
// of DEFAULT_CONFIG, and leaving it out would make it impossible to set.
// usageStats likewise: absent means never asked, so it has no default either.
// updateCheck too: absent means on, so it is not written into every config.
const CONFIG_KEYS = ['defaultLocale', ...Object.keys(DEFAULT_CONFIG), 'usageStats', 'updateCheck'] as Array<keyof PolyglotsConfig>
// The parts of the two local server settings, settable on their own. Dotted
// rather than a nested `config set ollama '{...}'`, because nobody should have
// to type JSON to change a model name.
const SERVER_KEYS = [
  'ollama.model',
  'ollama.baseUrl',
  'ollama.contextLength',
  'openaiCompatible.model',
  'openaiCompatible.baseUrl',
  'openaiCompatible.contextLength',
] as const
type ServerKey = (typeof SERVER_KEYS)[number]
type ServerGroup = 'ollama' | 'openaiCompatible'
type ServerField = 'model' | 'baseUrl' | 'contextLength'

function isServerKey(key: string): key is ServerKey {
  return (SERVER_KEYS as readonly string[]).includes(key)
}

function splitServerKey(key: ServerKey): [ServerGroup, ServerField] {
  return key.split('.') as [ServerGroup, ServerField]
}

const SETTABLE_KEYS = [...CONFIG_KEYS, ...SERVER_KEYS].join(', ')

function parseHttpUrl(key: string, raw: string): string {
  const url = raw.trim()
  if (!isHttpUrl(url)) throw new UsageError(`${key} must be an http or https URL, got "${raw}"`)
  return url
}

function isConfigKey(key: string): key is keyof PolyglotsConfig {
  return (CONFIG_KEYS as string[]).includes(key)
}

function coerceConfigValue(key: keyof PolyglotsConfig, raw: string): PolyglotsConfig[typeof key] {
  switch (key) {
    case 'batchSize':
    case 'localIdleTimeout':
      return parsePositiveInt(key, raw)
    case 'consistencyTtlDays':
      if (!/^\d+$/.test(raw.trim())) throw new UsageError(`${key} must be a non-negative integer, got "${raw}"`)
      return Number(raw)
    case 'defaultDraftEngine':
      return parseDraftEngine(raw)
    case 'reviewProvider':
      return parseReviewProvider(raw)
    case 'localServerKind': {
      const kind = raw.trim()
      if (kind === 'ollama' || kind === 'openai-compatible') return kind
      throw new UsageError(`${key} must be ollama or openai-compatible, got "${raw}"`)
    }
    case 'openaiCompatible':
      throw new UsageError(
        'openaiCompatible has a model, a baseUrl and a contextLength; set them with: polyglots config set openaiCompatible.model <id> (or openaiCompatible.baseUrl <url>, openaiCompatible.contextLength <tokens>)',
      )
    case 'defaultLocale':
      return parseLocaleArg(raw)
    // Validated here as well as in the schema, so a typo is refused at the
    // moment it is typed rather than at the next review, where it would be
    // welded into a link posted under the reviewer's name.
    case 'wporgUsername': {
      const name = raw.trim()
      if (name !== '' && !/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new UsageError(`${key} may only hold letters, digits, hyphens and underscores, got "${raw}"`)
      }
      return name
    }
    case 'properNouns':
      throw new UsageError('properNouns is a per-locale list; add entries with: polyglots config add-name <name>')
    // Validated here as well as in the schema, so the person is told which
    // entry is wrong rather than an index into an array they typed as a list.
    case 'localModelServers':
      return raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => parseHttpUrl(key, entry))
    // on and off, the words the issue and the docs use; true and false too,
    // since that is what config.json holds and what someone will type.
    case 'usageStats':
    case 'updateCheck': {
      const value = raw.trim().toLowerCase()
      if (value === 'on' || value === 'true') return true
      if (value === 'off' || value === 'false') return false
      throw new UsageError(`${key} must be on or off, got "${raw}"`)
    }
    case 'ollama':
      throw new UsageError(
        'ollama has a model, a baseUrl and a contextLength; set them with: polyglots config set ollama.model <name> (or ollama.baseUrl <url>, ollama.contextLength <tokens>)',
      )
  }
}

// undefined only for an empty contextLength, which unsets it: the server's
// own default applies again.
function coerceServerValue(key: ServerKey, raw: string): string | number | undefined {
  const [, field] = splitServerKey(key)
  if (field === 'baseUrl') return parseHttpUrl(key, raw)
  if (field === 'contextLength') return raw.trim() === '' ? undefined : parsePositiveInt(key, raw)
  // Model names never hold whitespace, on Ollama or on any OpenAI-compatible
  // server, so a space inside is a typo or two arguments run together, and
  // would only surface as a 404 on batch one.
  const model = raw.trim()
  if (model === '' || /\s/.test(model)) throw new UsageError(`${key} must be a model name without spaces, got "${raw}"`)
  return model
}

function formatConfigValue(key: keyof PolyglotsConfig, value: PolyglotsConfig[keyof PolyglotsConfig]): string {
  if (key === 'ollama' || key === 'openaiCompatible') {
    const { baseUrl, model, contextLength } = value as PolyglotsConfig['ollama']
    const context = contextLength === undefined ? '' : `, ${contextLength}-token context`
    return `${model || '(no model)'} at ${baseUrl}${context}`
  }
  if (key === 'localModelServers') {
    const servers = value as string[]
    return servers.length === 0 ? '(none)' : servers.join(', ')
  }
  if (key === 'defaultLocale' && value === undefined) return '(not set)'
  if (key === 'usageStats') return value === true ? 'on' : value === false ? 'off' : '(not asked; off)'
  if (key === 'updateCheck') return value === false ? 'off' : 'on'
  if (key !== 'properNouns') return String(value)
  const byLocale = value as Record<string, string[]>
  const locales = Object.keys(byLocale).sort()
  if (locales.length === 0) return '(none)'
  return locales.map((locale) => `${locale}: ${byLocale[locale]!.join(', ')}`).join(' | ')
}

function configAddName(cli: Cli, name: string, locale: Locale): number {
  const trimmed = name.trim()
  if (!trimmed) throw new UsageError('name must not be empty')
  const existing = cli.config().properNouns
  const current = existing[locale] ?? []
  if (current.some((n) => n === trimmed)) {
    cli.out(`${JSON.stringify(trimmed)} is already listed for ${locale}.`)
    return EXIT_OK
  }
  saveConfig({ properNouns: { ...existing, [locale]: [...current, trimmed] } })
  cli.out(okLine(cli.ui.out, `Added ${JSON.stringify(trimmed)} to the ${locale} proper-noun list.`))
  return EXIT_OK
}

function parseTmExportFormat(value: string | undefined): TmExportFormat | undefined {
  if (value === undefined) return undefined
  const format = value.trim().toLowerCase()
  if (format === 'tmx' || format === 'po') return format
  throw new UsageError(`Unknown format "${value}"; expected tmx or po`)
}

function configGet(cli: Cli, key: string | undefined): void {
  const config = cli.config()
  const secrets = loadSecrets()
  if (key === undefined) {
    for (const k of CONFIG_KEYS) cli.out(`${k} = ${formatConfigValue(k, config[k])}`)
    cli.out(`DEEPL_API_KEY = ${maskSecret(secrets.DEEPL_API_KEY)}`)
    cli.out(`OPENAI_API_KEY = ${maskSecret(secrets.OPENAI_API_KEY)}`)
    return
  }
  if (isServerKey(key)) {
    const [group, field] = splitServerKey(key)
    cli.out(String(config[group][field] ?? ''))
    return
  }
  if (key === 'localModelServers') {
    // Comma-joined with no space, the form config set reads back.
    cli.out(config.localModelServers.join(','))
    return
  }
  if (isConfigKey(key)) {
    // The two server objects printed as a line rather than [object Object].
    // An unset locale prints as an empty line rather than "undefined", so a
    // script testing for one reads it as absent.
    if (key === 'usageStats') {
      cli.out(config.usageStats === undefined ? '' : formatConfigValue(key, config.usageStats))
      return
    }
    cli.out(key === 'ollama' || key === 'openaiCompatible' ? formatConfigValue(key, config[key]) : String(config[key] ?? ''))
    return
  }
  if (isSecretName(key)) {
    cli.out(maskSecret(secrets[key]))
    return
  }
  throw new UsageError(`Unknown config key "${key}"; expected one of ${SETTABLE_KEYS}, DEEPL_API_KEY, OPENAI_API_KEY`)
}

async function configSet(cli: Cli, key: string, raw: string): Promise<void> {
  if (isSecretName(key)) throw new UsageError(`"${key}" is a secret; use: polyglots config set-key ${key}`)
  if (isServerKey(key)) {
    const [group, field] = splitServerKey(key)
    const value = coerceServerValue(key, raw)
    const { [field]: _previous, ...rest } = cli.config()[group]
    const saved = saveConfig({ [group]: value === undefined ? rest : { ...rest, [field]: value } })
    cli.out(okLine(cli.ui.out, value === undefined ? `${key} unset` : `${key} = ${value}`))
    // Saved first and checked after, with exit 0 either way: choosing a model
    // before pulling or loading it is ordinary, and the warning says what to run.
    if (field === 'model') {
      await warnAboutLocalModel(cli, {
        kind: group === 'ollama' ? 'ollama' : 'openai-compatible',
        baseUrl: saved[group].baseUrl,
        model: saved[group].model,
      })
    }
    return
  }
  if (!isConfigKey(key)) throw new UsageError(`Unknown config key "${key}"; expected one of ${SETTABLE_KEYS}`)
  // An empty locale is no locale: each file's Language header decides again.
  if (key === 'defaultLocale' && raw.trim() === '') {
    unsetConfig('defaultLocale')
    cli.out(okLine(cli.ui.out, 'defaultLocale unset'))
    return
  }
  const saved = saveConfig({ [key]: coerceConfigValue(key, raw) })
  cli.out(okLine(cli.ui.out, `${key} = ${formatConfigValue(key, saved[key])}`))
  // The one door to the experimental reviewer, so the warning is said here.
  if (key === 'reviewProvider' && saved.reviewProvider === 'local') cli.err(warnLine(cli.ui.err, LOCAL_REVIEW_NOTICE))
}

async function configSetKey(cli: Cli, rawName: string, value: string | undefined): Promise<number> {
  const name = parseSecretName(rawName)
  const entered = value ?? (await readSecretFromStdin(cli.streams, name))
  if (entered === undefined) {
    cli.err(warnLine(cli.ui.err, 'Cancelled.'))
    return EXIT_ERROR
  }
  const secret = entered.trim()
  if (!secret) throw new UsageError(`No value given for ${name}; pass it as an argument or on stdin`)
  saveSecret(name, secret)
  cli.out(okLine(cli.ui.out, `Saved ${name} (${maskSecret(secret)}).`))
  return EXIT_OK
}

const ENVIRONMENT_HELP = [
  '',
  'Environment:',
  '  POLYGLOTS_AGENT_BIN   agent executable for the review pass, whichever provider is set (default: claude or agy on PATH)',
  '  POLYGLOTS_CLAUDE_BIN  the older name, applied to claude only',
  '  POLYGLOTS_HOME        root for config/ and data/ instead of the XDG directories',
  '  POLYGLOTS_ASCII=1     plain ASCII glyphs instead of Unicode (also NO_COLOR, FORCE_COLOR)',
  '  DO_NOT_TRACK=1        never send usage statistics, whatever usageStats says',
  '  POLYGLOTS_USAGE_URL   where opted-in usage statistics go (default: https://ada.tools/polyglots/api/usage)',
  '  NO_UPDATE_NOTIFIER=1  never check npm for a newer version (also CI, or: config set updateCheck off)',
].join('\n')

const LIVE_WARNING = 'Sends one prompt to each usable agent; this spends a request on metered plans.'

function authText(status: AgentStatus): string {
  if (status.auth.state === 'signed-in') return status.auth.detail ? `signed in (${status.auth.detail})` : 'signed in'
  if (status.auth.state === 'signed-out') return 'signed out'
  return 'sign-in unknown'
}

function liveText(live: AgentStatus['live']): string | undefined {
  if (!live) return undefined
  return live.ok ? `live ok ${(live.ms / 1000).toFixed(1)}s` : `live failed: ${live.error ?? 'no reason given'}`
}

/**
 * The configured provider decides the exit code, not every provider: a
 * machine without agy is a fine machine for someone who reviews with claude,
 * and a scheduled review gated on this must not fail over an agent it never
 * runs.
 */
async function runDoctor(cli: Cli, flags: { json?: boolean; live?: boolean }): Promise<number> {
  const configured = cli.config().reviewProvider
  // No reviewer is a mode, not a missing agent. Discovery is not run at all:
  // it spawns every agent CLI to ask its version and sign-in, which is exactly
  // what someone who chose to work without AI asked not to have done, and its
  // answer could not change the exit code.
  if (configured === 'none') {
    if (flags.json) {
      cli.out(JSON.stringify({ configured, agents: [] }, null, 2))
      return EXIT_OK
    }
    cli.out(okLine(cli.ui.out, 'Review provider: none (rules only, no AI)'))
    cli.out(hintLine(cli.ui.out, 'Reviews run the rules only. Choose an agent with: polyglots config set reviewProvider claude'))
    return EXIT_OK
  }
  const live = flags.live === true
  if (live) cli.err(warnLine(cli.ui.err, LIVE_WARNING))
  const agents = await cli.discoverAgents({ refresh: true, ...(live ? { live: true } : {}) })
  // The experimental local reviewer is no agent, so its health is its model
  // check: the same question `models` answers, asked of the one target a
  // review would use. A live prompt is never sent to it; --live is for agents.
  // An OpenAI-compatible server with no model chosen is an answer too, not a
  // crash: the agents table is still worth printing, and the line says what
  // is missing.
  let local: { id: string; check: ModelCheck } | { unset: true } | undefined
  if (configured === 'local') {
    let target: LocalTarget | undefined
    try {
      target = resolveLocalTarget(cli.config())
    } catch {
      target = undefined
    }
    local = target ? { id: localModelId(target), check: await cli.checkLocalModel(target) } : { unset: true }
  }
  const mine = agents.find((a) => a.provider === configured)
  const ok = local
    ? 'check' in local && local.check.state === 'installed'
    : mine !== undefined && mine.usable && (!live || mine.live?.ok === true)
  if (flags.json) {
    cli.out(JSON.stringify({ configured, agents, ...(local ? { local } : {}) }, null, 2))
    return ok ? EXIT_OK : EXIT_ERROR
  }
  const p = cli.ui.out
  const rows = agents.map((a) => {
    const facts = a.usable
      ? [a.path ?? a.bin, a.version, authText(a), a.model].filter((x): x is string => Boolean(x))
      : [a.reason ?? 'unavailable']
    const liveLine = liveText(a.live)
    if (liveLine) facts.push(liveLine)
    return [a.provider, a.usable ? p.paint('success', 'ready') : p.paint('error', 'unavailable'), facts.join('  ')]
  })
  const lines = table(rows)
  agents.forEach((a, i) => {
    cli.out(lines[i]!)
    for (const note of a.notes) cli.out(hintLine(p, `note: ${note}`))
  })
  // The closing line is the answer the exit code gives, so it carries the
  // glyph; the table above is detail.
  const status = (good: boolean, msg: string) => cli.out((good ? okLine : errorLine)(p, msg))
  if (local && 'unset' in local) {
    status(false, 'Review provider: local (experimental) (no model chosen)')
    cli.out(hintLine(p, 'Set one with: polyglots config set openaiCompatible.model <id>'))
    return EXIT_ERROR
  }
  if (local) {
    status(ok, `Review provider: local (experimental) ${local.id} (${checkText(local.check)})`)
    if (local.check.state !== 'installed' && local.check.message) cli.out(hintLine(p, local.check.message))
    return ok ? EXIT_OK : EXIT_ERROR
  }
  const state = !mine ? 'unknown' : mine.usable ? 'ready' : `unavailable: ${mine.reason ?? 'no reason given'}`
  status(ok, `Review provider: ${configured} (${state})`)
  return ok ? EXIT_OK : EXIT_ERROR
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function checkText(check: ModelCheck): string {
  if (check.state === 'installed') return 'installed'
  if (check.state === 'missing') return 'not installed'
  return check.kind === 'openai-compatible' ? 'server unreachable' : 'Ollama unreachable'
}

/**
 * The exit code answers whether any local runner is up at all, so a script
 * can ask that one question. Whether the configured model is installed is
 * printed but does not decide it: an LM Studio-only machine is up.
 */
async function runModels(cli: Cli, flags: { json?: boolean }): Promise<number> {
  const config = cli.config()
  const servers = await cli.discoverModels({ refresh: true, config })
  // The target a local run would use. An OpenAI-compatible kind with no model
  // yet is not an error here: the listing is exactly where one is chosen from.
  let target: LocalTarget | undefined
  try {
    target = resolveLocalTarget(config)
  } catch {
    target = undefined
  }
  const configured = target ? await cli.checkLocalModel(target) : undefined
  const ok = servers.some((s) => s.state === 'up')
  if (flags.json) {
    cli.out(JSON.stringify({ servers, configured: configured ?? null }, null, 2))
    return ok ? EXIT_OK : EXIT_ERROR
  }
  const p = cli.ui.out
  const up = servers.filter((s) => s.state === 'up')
  // One table for the server lines, so their URLs line up across servers even
  // though each is followed by its own model rows.
  const serverLines = table(up.map((s) => [p.paint('heading', serverLabel(s)), s.target.baseUrl, plural(s.models.length, 'model')]), { gap: 3 })
  // Compared without the API version, as discovery lists servers.
  const configuredBase = target ? serverBaseUrl(target.baseUrl) : undefined
  up.forEach((server, at) => {
    cli.out(serverLines[at]!)
    const facts = server.models.map(modelFacts)
    const rows = server.models.map((model, i) => {
      const isConfigured =
        target !== undefined &&
        server.kind === target.kind &&
        server.target.baseUrl === configuredBase &&
        (target.kind === 'ollama' ? matchesModel(target.model, model) : model.name === target.model)
      const mark = isConfigured ? p.paint('accent', '(configured)') : ''
      // Only Ollama reports size, parameters and quantisation; the others
      // list a name and nothing else.
      return [sanitizeDisplay(model.name), ...(server.kind === 'ollama' ? facts[i]! : []), mark]
    })
    for (const line of table(rows, { indent: 2, align: ['left', 'right', 'left', 'left', 'left'] })) cli.out(line)
  })
  for (const server of servers.filter((s) => s.state !== 'up')) cli.out(hintLine(p, unavailableLine(server)))
  // Shown whatever the default engine: it costs nothing and answers the
  // question anyone reading a model list asks next.
  if (configured && target) {
    const line = `Local model: ${configured.model} (${kindLabel(target.kind)}, ${checkText(configured)})`
    cli.out(configured.state === 'installed' ? okLine(p, line) : warnLine(p, line))
    if (configured.state !== 'installed' && configured.message) cli.out(hintLine(p, configured.message))
  } else {
    cli.out(warnLine(p, 'Local model: none chosen for the OpenAI-compatible server. Set one with: polyglots config set openaiCompatible.model <id>'))
  }
  return ok ? EXIT_OK : EXIT_ERROR
}

function helpConfig(cli: Cli): PolyglotsConfig {
  try {
    return cli.config()
  } catch {
    return DEFAULT_CONFIG
  }
}

function buildProgram(cli: Cli, setExitCode: (code: number) => void): Command {
  const shown = helpConfig(cli)
  const program = new Command()
    .name('polyglots')
    .description('Translate WordPress .po files with machine drafts and AI review. Run without arguments for the interactive menu.')
    .version(VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (chunk) => cli.streams.stdout.write(chunk),
      writeErr: (chunk) => cli.streams.stderr.write(chunk),
    })
    .addHelpText('after', '\nExit codes: 0 success, 1 error or aborted, 2 usage error, 3 run stopped early (API quota or rate limit).')

  program
    .command('translate <files...>')
    .description('Translate pending (empty or fuzzy) entries of one or more .po files')
    .option('--all', 'Re-translate every entry, including already-translated ones (asks for confirmation)')
    .option('--fresh', 'Ignore the cached drafts and reviews, and translate again')
    .option('--dry-run', 'Run the pipeline without writing to the .po files')
    .option('--draft-engine <engine>', `Draft engine: deepl, openai, local, or none to fill from the translation memory only (default: ${shown.defaultDraftEngine})`)
    .option('--local-model <name>', 'Model for the local draft engine on this run, instead of the configured one')
    .option('--locale <locale>', `Target locale (${localeDefaultHelp(shown, true)})`)
    .option('--batch-size <n>', `Entries per draft/review batch (default: ${shown.batchSize})`)
    .option('--model <model>', 'Model for the review pass (the agent\'s, or the local reviewer\'s)')
    .option('--yes', 'Skip the --all confirmation prompt (required with --all when stdin is not a terminal)')
    .addHelpText('after', ENVIRONMENT_HELP)
    .action(async (files: string[], flags: TranslateFlags) => {
      setExitCode(await runTranslate(cli, files, flags))
    })

  const rules = program.command('rules').description('Locale-specific rules: built-in switches, common mistakes, patterns, guidance')
  rules
    .command('edit [locale]')
    .description('Open the locale rules file in $VISUAL or $EDITOR, creating it with the defaults if needed')
    .action(async (raw: string | undefined) => {
      const locale = requireLocale(raw, cli.config(), { argument: 'polyglots rules edit' })
      for (const line of await editRules(locale, cli.openEditor, cli.ui.out)) cli.out(line)
    })
  rules
    .command('check [locale]')
    .description('Validate the locale rules file and summarise what it sets')
    .action((raw: string | undefined) => {
      const locale = requireLocale(raw, cli.config(), { argument: 'polyglots rules check' })
      for (const line of describeRules(locale, cli.ui.out)) cli.out(line)
    })
  rules
    .command('copy <from> <to>')
    .description('Duplicate one locale\'s rules file as another\'s, e.g. nl_NL to nl_BE')
    .option('--force', 'Replace the target file if it exists')
    .action(async (from: string, to: string, flags: { force?: boolean }) => {
      for (const line of await copyRules(parseLocaleArg(from), parseLocaleArg(to), flags.force === true, cli.ui.out)) cli.out(line)
    })
  rules
    .command('path [locale]')
    .description('Print where the locale rules file lives')
    .action((raw: string | undefined) => {
      cli.out(localeRulesFile(requireLocale(raw, cli.config(), { argument: 'polyglots rules path' })))
    })

  const tm = program.command('tm').description('Translation memory')
  tm.command('import <files...>')
    .description('Import TMX or .po exports into the local translation memory (additive)')
    .option('--locale <locale>', `Target locale to import (${localeDefaultHelp(shown)})`)
    .option('--project <name>', 'Tag imported entries with a project name')
    .action(async (patterns: string[], flags: { locale?: string; project?: string }) => {
      const files = expandFileArgs(patterns)
      const locale = requireLocale(flags.locale, cli.config())
      const result = await cli.importTmx(files, {
        locale,
        project: flags.project,
        onProgress: (e) => cli.err(hintLine(cli.ui.err, `${e.file}: ${e.entries} entries, ${e.upserted} upserted`)),
      })
      cli.out(okLine(cli.ui.out, `Imported ${result.files} file(s): ${result.entries} entries, ${result.upserted} upserted (locale ${locale}).`))
    })

  program
    .command('fetch [names...]')
    .description('Fetch themes and plugins from translate.wordpress.org and review or translate every one')
    .option('--get <status>', 'waiting (reviewed) or untranslated (translated)')
    .option('--parallel <n>', `Projects to run at once, 1 to 8 (default: 1)`)
    .option('--out-dir <dir>', 'Where to save the exports (default: ~/Downloads/polyglots)')
    .option('--force', 'With --get untranslated, replace a file that already exists instead of keeping it')
    .option('--locale <locale>', `Locale (${localeDefaultHelp(shown)})`)
    .option('--batch-size <n>', `Entries per batch (default: ${shown.batchSize})`)
    .option('--fresh', 'Ignore cached verdicts or drafts and ask again')
    .option('--no-ai', 'Review only: run the deterministic checks, skipping AI adjudication')
    .option('--draft-engine <engine>', `Translate only: deepl, openai, local or none (default: ${shown.defaultDraftEngine})`)
    .addHelpText(
      'after',
      '\nNames are slugs or translate.wordpress.org URLs, as arguments or one per line on stdin.\nA bare slug is tried as a theme first, then as a plugin.',
    )
    .action(async (names: string[], flags: FetchFlags) => {
      setExitCode(
        await runFetch(
          {
            stdin: cli.streams.stdin,
            config: cli.config,
            resolveProjects: cli.resolveProjects,
            fetchProjects: cli.fetchProjects,
            reviewFile: cli.reviewFile,
            translate: cli.translate,
            stopRunsOnSignal: cli.stopRunsOnSignal,
            checkLocalModel: cli.checkLocalModel,
            out: cli.out,
            err: cli.err,
            ui: cli.ui,
          },
          names,
          flags,
        ),
      )
    })

  program
    .command('review <file>')
    .description('Audit a submitted .po and write out only the entries that need work')
    .option('--locale <locale>', `Review locale (${localeDefaultHelp(shown, true)})`)
    .option('--out-dir <dir>', 'Where to write the problems file (default: beside the input)')
    .option('--no-ai', 'Run the deterministic checks only, skipping AI adjudication')
    .option('--batch-size <n>', `Entries per AI batch (default: ${shown.batchSize})`)
    .option('--fresh', 'Ignore the cached verdicts for this file and review it again')
    .addHelpText('after', ENVIRONMENT_HELP)
    .action(async (raw: string, flags: ReviewFlags) => {
      const [target] = expandFileArgs([raw])
      const config = cli.config()
      const { locale, fromHeader } = await resolveFileLocale(flags.locale, config, [target!], {
        antigravity: config.reviewProvider === 'antigravity' && flags.ai !== false,
      })
      if (fromHeader) cli.err(hintLine(cli.ui.err, headerLocaleNotice(locale)))
      // Before anything else: a review must not run on rules the person
      // believes are in force when the file that says so cannot be read.
      loadLocaleRules(locale)
      warnUniversalOnly(cli, locale)
      const batchSize = resolveBatchSize(config, flags.batchSize)
      const advice = batchAdvice(config.reviewProvider, batchSize)
      if (advice) cli.err(warnLine(cli.ui.err, advice))
      if (config.reviewProvider === 'local' && flags.ai !== false) {
        await warnAboutLocalReview(cli, resolveLocalTarget(config), batchSize, locale)
      }
      // Said once per run, before the header, so a person who set none long
      // ago and forgot is not left wondering why no agent ran.
      const noReviewer = config.reviewProvider === 'none'
      if (noReviewer && flags.ai !== false) {
        cli.err(hintLine(cli.ui.err, 'reviewProvider is none, so this review runs the rules only, with no AI.'))
      }
      const rulesOnly = flags.ai === false || noReviewer
      for (const line of header(cli.ui.err, 'review', target!, [
        ['locale', locale],
        ['review', rulesOnly ? 'rules only' : reviewerLabel(config, undefined)],
      ])) cli.err(line)
      const report = createReviewProgressReporter(cli.streams.stderr, cli.ui.err)
      // Only binds on a terminal. A piped or scheduled run has nobody to press
      // anything, and raw mode on a pipe would break it.
      const control = createRunControl()
      const unwatchKeys = watchKeys(cli.streams.stdin, control, {
        onInterrupt: () => {
          unwatchKeys()
          process.kill(process.pid, 'SIGINT')
        },
      })
      const unsubscribe = control.subscribe((state: RunState) => {
        if (state === 'paused') report({ type: 'paused', at: Date.now() })
        if (state === 'running') report({ type: 'resumed', at: Date.now() })
        if (state === 'stopping') report({ type: 'stopping', at: Date.now() })
      })
      const unwatchSignals = cli.stopRunsOnSignal()
      const summary = await cli.reviewFile({
        control,
        file: target!,
        locale,
        ...(flags.outDir ? { outDir: flags.outDir } : {}),
        ...(rulesOnly ? { noAi: true } : {}),
        batchSize,
        ...(flags.fresh ? { fresh: true } : {}),
        bin: agentBinOverride(config.reviewProvider, process.env),
        onProgress: report,
      }).finally(() => {
        unwatchSignals()
        unsubscribe()
        unwatchKeys()
        report.finish()
      })
      // The requester message is the line to post back to whoever submitted
      // the translation. Printed rather than copied: a CLI run may be in a pipe
      // or a script, where reaching for the clipboard would be a side effect
      // nobody asked for.
      const requesterMessage = buildReport(summary, cli.config().wporgUsername) || undefined
      for (const line of reviewSummary(cli.ui.out, summary, requesterMessage, noReviewer ? { noReviewer: true } : {})) cli.out(line)
    })

  program
    .command('doctor')
    .description('Check which agent CLIs are installed, signed in and set up, without sending a prompt')
    .option('--json', 'Print the result as JSON')
    .option('--live', 'Also send one short prompt to each usable agent (spends a request on metered plans)')
    .addHelpText('after', '\nExits 1 when the configured review provider cannot be used (or, with --live, fails its prompt).')
    .action(async (flags: { json?: boolean; live?: boolean }) => {
      setExitCode(await runDoctor(cli, flags))
    })

  program
    .command('models')
    .description('List local model servers (Ollama, LM Studio, llama.cpp, vLLM) and the models they hold, without loading any')
    .option('--json', 'Print the result as JSON')
    .addHelpText(
      'after',
      [
        '',
        'Probes Ollama at ollama.baseUrl, LM Studio on localhost:1234 and llama.cpp on localhost:8080,',
        'plus any URL in localModelServers. The defaults are all on this machine; a configured URL may',
        'not be, and is asked because it was listed.',
        '',
        'Exits 1 when no server is up.',
      ].join('\n'),
    )
    .action(async (flags: { json?: boolean }) => {
      setExitCode(await runModels(cli, flags))
    })

  program
    .command('split <file>')
    .description('Cut a .po into numbered parts so each can be run and submitted on its own')
    .requiredOption('--size <n>', 'Entries per part, counted over the whole file')
    .option('--force', 'Write into a folder that already has files in it')
    .action(async (raw: string, flags: { size: string; force?: boolean }) => {
      const [target] = expandFileArgs([raw])
      const summary = await cli.splitPo({
        file: target!,
        size: parsePositiveInt('--size', flags.size),
        ...(flags.force ? { force: true } : {}),
      })
      const last = summary.parts[summary.parts.length - 1]
      // The last part's size is the one thing the arithmetic does not give
      // away, and it is what decides whether the tail is worth its own run.
      const tail = last && last.entries !== summary.size ? `, last ${last.entries}` : ''
      cli.out(okLine(cli.ui.out, `${summary.entries} entries into ${summary.parts.length} parts of ${summary.size}${tail}.`))
      cli.out(nextLine(cli.ui.out, `Wrote ${cli.ui.out.paint('path', summary.dir)}`))
      // Higher-numbered parts from an earlier, finer split look exactly like
      // work waiting to be submitted. Nothing is deleted, so they are named.
      if (summary.leftBehind.length > 0) {
        cli.err(warnLine(cli.ui.err, `Left alone, not part of this split: ${summary.leftBehind.join(', ')}`))
      }
    })

  tm.command('export [file]')
    .description('Write the translation memory as TMX or .po (stdout when no file is given)')
    .option('--locale <locale>', `Memory locale (${localeDefaultHelp(shown)})`)
    .option('--format <format>', 'tmx or po (default: from the file name, else tmx)')
    .action(async (file: string | undefined, flags: { locale?: string; format?: string }) => {
      const locale = requireLocale(flags.locale, cli.config())
      const format = parseTmExportFormat(flags.format)
      const result = await cli.exportTm({ locale, ...(file ? { file } : {}), ...(format ? { format } : {}) })
      if (!result.file) {
        cli.streams.stdout.write(result.text)
        return
      }
      // The dropped count is the whole reason a .po export is not the default:
      // saying nothing would hand back a file holding less than it was asked for.
      const lost = result.dropped > 0 ? `, ${result.dropped} alternative wording(s) dropped` : ''
      cli.out(okLine(cli.ui.out, `Exported ${result.entries} translations (${locale}) to ${result.file}${lost}`))
    })

  const glossary = program.command('glossary').description('translate.wordpress.org glossary cache')
  glossary
    .command('sync')
    .description('Download the WordPress.org glossary for a locale into the local cache')
    .option('--locale <locale>', `Glossary locale (${localeDefaultHelp(shown)})`)
    .action(async (flags: { locale?: string }) => {
      const locale = requireLocale(flags.locale, cli.config())
      const result = await cli.syncGlossary({ locale })
      cli.out(okLine(cli.ui.out, `Synced ${result.entries} glossary entries for ${locale}.`))
    })
  glossary
    .command('export [file]')
    .description('Write the cached glossary as a Poedit-compatible CSV (stdout when no file is given)')
    .option('--locale <locale>', `Glossary locale (${localeDefaultHelp(shown)})`)
    .option('--delimiter <char>', 'Column separator, ";" or "," (default: ;)')
    .action(async (file: string | undefined, flags: { locale?: string; delimiter?: string }) => {
      const locale = requireLocale(flags.locale, cli.config())
      const delimiter = parseCsvDelimiter(flags.delimiter ?? ';')
      const result = await cli.exportGlossary({ locale, file, delimiter })
      if (result.file) cli.out(okLine(cli.ui.out, `Exported ${result.entries} glossary terms (${locale}) to ${result.file}`))
      else cli.streams.stdout.write(result.csv)
    })

  program
    .command('stats')
    .description('Open review statistics in the browser, or write them to a self-contained HTML page')
    .option('--out <file>', `Write a standalone copy instead of serving (default off a terminal: ${DEFAULT_STATS_FILE})`)
    .option('--since <date>', 'Only count reviews started on or after this date, e.g. 2026-09-01')
    .option('--no-open', 'Serve without opening the browser; the URL is printed either way')
    .action(async (flags: { out?: string; since?: string; open: boolean }) => {
      const since = flags.since ? { since: flags.since } : {}
      // Off a terminal (cron, a pipe) there is no one to open a browser for
      // and no Ctrl+C to stop a server, so it writes the file, as it did
      // before the page was served. Scripts that relied on that keep working.
      if (flags.out || cli.streams.stdout.isTTY !== true) {
        const result = await cli.writeStats({ ...(flags.out ? { out: flags.out } : {}), ...since })
        // Saying "nothing recorded yet" while the page holds real translate
        // numbers would send the user to look at a page they think is empty, so
        // the summary checks both before saying it.
        for (const line of statsSummary(cli.ui.out, result)) cli.out(line)
        return
      }
      const onError = (err: Error) => cli.err(errorLine(cli.ui.err, `stats server: ${err.message}`))
      let shared = false
      await cli.serveStats({ ...since, open: flags.open, onError }, ({ url, opened, summary, portInUse, sharedWith }) => {
        shared = sharedWith !== undefined
        if (portInUse !== undefined) cli.err(warnLine(cli.ui.err, portInUseWarning(portInUse, Number(new URL(url).port))))
        for (const line of statsServingSummary(cli.ui.out, summary, url, opened, sharedWith)) cli.out(line)
      })
      if (!shared) cli.out(okLine(cli.ui.out, 'Stopped'))
    })

  const usage = program.command('usage-stats').description('Opt-in anonymous usage totals: see what is sent, or forget the install id')
  usage
    .command('show')
    .description('Print exactly what the next weekly send carries')
    .action(() => usageStatsShow(cli))
  usage
    .command('reset')
    .description('Forget the install id; a new one is made at the next send')
    .action(() => {
      const removed = resetUsageState()
      cli.out(okLine(cli.ui.out, removed ? 'Install id forgotten. Totals already sent stay counted under the old one.' : 'There was no install id to forget.'))
    })

  const cfg = program.command('config').description('Settings and API keys')
  cfg
    .command('get [key]')
    .description('Show a setting, or all settings (API keys are masked)')
    .action((key?: string) => configGet(cli, key))
  cfg
    .command('set <key> <value>')
    .description(`Change a setting (${SETTABLE_KEYS})`)
    .action(async (key: string, value: string) => configSet(cli, key, value))
  cfg
    .command('add-name <name>')
    .description('Add a proper noun the title-case check should never flag (places, people, institutions)')
    .option('--locale <locale>', `Locale the name belongs to (${localeDefaultHelp(shown)})`)
    .action((name: string, flags: { locale?: string }) => {
      const locale = requireLocale(flags.locale, cli.config())
      setExitCode(configAddName(cli, name, locale))
    })
  cfg
    .command('set-key <name> [value]')
    .description('Store DEEPL_API_KEY or OPENAI_API_KEY; omit the value to read it from stdin')
    .action(async (name: string, value?: string) => {
      setExitCode(await configSetKey(cli, name, value))
    })

  return program
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function exitCodeFor(cli: Cli, error: unknown): number {
  if (error instanceof CommanderError) {
    return error.exitCode === 0 ? EXIT_OK : EXIT_USAGE
  }
  if (error instanceof UsageError) {
    cli.err(errorLine(cli.ui.err, error.message))
    return EXIT_USAGE
  }
  cli.err(errorLine(cli.ui.err, errorMessage(error)))
  return EXIT_ERROR
}

// The commands that start a usage send: the ones that do the work being
// counted, and the interactive app. Not config, so turning the setting on
// sends nothing until the next real command; not usage-stats, so looking at
// the payload never sends it; not help or --version.
const SENDS_USAGE = new Set(['review', 'translate', 'fetch', 'stats', 'tm', 'glossary', 'split'])

function startsUsageSend(argv: string[]): boolean {
  if (argv.length === 0) return true
  return SENDS_USAGE.has(argv[0]!) && !argv.includes('--help') && !argv.includes('-h')
}

function usageStatsShow(cli: Cli): void {
  // process.env, not the injected one: that exists for colour, and
  // DO_NOT_TRACK has to be read where the send reads it.
  const config = cli.config()
  const status = usageStatus(config, process.env)
  const payload = previewUsagePayload({ config, env: process.env })
  const say: Record<typeof status, string> = {
    on: `On. This is what the next weekly send carries; nothing else leaves this machine. The install id is kept in ${usageStateFile()}.`,
    off: 'Off: nothing is sent. Turned on, this is what would be: polyglots config set usageStats on',
    unanswered: 'Off, never turned on: nothing is sent. Turned on, this is what would be: polyglots config set usageStats on',
    'do-not-track': 'Off because DO_NOT_TRACK is set, whatever usageStats says: nothing is sent. This is what would be.',
  }
  cli.err(hintLine(cli.ui.err, say[status]))
  cli.out(JSON.stringify(payload, null, 2))
}

/**
 * Starts the daily update check for the same commands that start a usage
 * send, when stderr is a terminal: the notice goes there, and a run whose
 * stderr is piped or captured has nobody reading it as it happens. The
 * environment is the injected one, so tests and the website's demos decide
 * CI and NO_UPDATE_NOTIFIER for themselves.
 */
function startUpdateCheck(cli: Cli, argv: string[], deps: CliDeps): UpdateCheck | undefined {
  try {
    if (!startsUsageSend(argv) || cli.streams.stderr.isTTY !== true) return undefined
    if (!updateCheckEnabled(cli.config(), deps.env ?? process.env)) return undefined
    const check: UpdateCheck = { promise: (deps.checkUpdate ?? checkForUpdate)() }
    check.promise = check.promise.then(
      (latest) => (check.latest = latest),
      () => undefined,
    )
    return check
  } catch {
    // An unreadable config, or a check that throws, has no business failing
    // a command; the command reports the config itself.
    return undefined
  }
}

interface UpdateCheck {
  promise: Promise<string | undefined>
  // Set once the check has answered. Read at the end without waiting: a check
  // still out then is dropped, and the next command reads what it saved.
  latest?: string | undefined
}

function sayUpdate(cli: Cli, check: UpdateCheck | undefined): void {
  if (check?.latest === undefined) return
  // Yellow throughout, not only the glyph as messages.ts does elsewhere: this
  // is the one line meant to be noticed after a run's own output.
  cli.err(cli.ui.err.paint('warn', `${cli.ui.err.glyphs.warn} ${updateNotice(check.latest)}`))
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const cli = createCli(deps)
  let exitCode = EXIT_OK
  const update = startUpdateCheck(cli, argv, deps)
  // Started, never awaited: it reads the setting itself and does nothing when
  // off, and a request still out when the command ends dies with the process.
  if (startsUsageSend(argv)) {
    try {
      ;(deps.sendUsage ?? (() => void sendUsageInBackground()))()
    } catch {
      // A usage send has no business failing a command.
    }
  }
  try {
    if (argv.length === 0) {
      await cli.runTui(update === undefined ? {} : { update: update.promise })
      sayUpdate(cli, update)
      return EXIT_OK
    }
    await buildProgram(cli, (code) => (exitCode = code)).parseAsync(argv, { from: 'user' })
    sayUpdate(cli, update)
    return exitCode
  } catch (error) {
    const code = exitCodeFor(cli, error)
    sayUpdate(cli, update)
    return code
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1]
  if (!script) return false
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) process.exitCode = await main(process.argv.slice(2))

function stopOwnRunsInJobsDb(): number {
  const db = openJobsDb()
  try {
    return stopOwnRuns(db)
  } finally {
    db.close()
  }
}
