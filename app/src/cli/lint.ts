import { existsSync, readFileSync, type Stats } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { findConfig, type LintConfig } from '../lint/config.js'
import { LintNotStarted } from '../lint/errors.js'
import { lintPot, parseReference, type ReadSource } from '../lint/lint.js'
import type { MakePotOptions } from '../lint/make-pot.js'
import { loadPo } from '../po/po-file.js'
import { errorLine, hintLine, warnLine } from '../ui/messages.js'
import type { Painter } from '../ui/paint.js'
import { UsageError } from './args.js'
import { LINT_FORMATS, githubReport, jsonReport, textReport, totalLine, type LintFormat } from './lint-output.js'

export interface LintFlags {
  strict?: boolean
  format?: string
  source?: string
  config?: string
  domain?: string
}

export interface LintCli {
  ui: { out: Painter; err: Painter }
  out(line: string): void
  err(line: string): void
  makePot: (opts: MakePotOptions) => Promise<void>
}

const EXIT_OK = 0
const EXIT_FINDINGS = 1
const EXIT_NOT_STARTED = 2

function parseFormat(raw: string | undefined): LintFormat {
  const format = raw ?? 'text'
  if (!(LINT_FORMATS as readonly string[]).includes(format)) throw new UsageError('--format must be text, json or github')
  return format as LintFormat
}

// Each file is read once however many strings point into it. CRLF files are
// split the same as LF ones, so the line numbers make-pot wrote still match.
function sourceReader(root: string): ReadSource {
  const cache = new Map<string, readonly string[] | undefined>()
  return (file) => {
    if (!cache.has(file)) {
      let lines: readonly string[] | undefined
      try {
        lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/)
      } catch {
        lines = undefined
      }
      cache.set(file, lines)
    }
    return cache.get(file)
  }
}

// A .pot's references are relative to the plugin or theme folder. --source
// names it; otherwise the .pot's own folder, then its parent, which is the
// usual languages/x.pot beside the plugin root. The first reference decides.
function potSourceRoot(target: string, flags: LintFlags, firstReference: string | undefined): string | undefined {
  if (firstReference === undefined) return undefined
  if (flags.source !== undefined) return resolve(flags.source)
  const file = parseReference(firstReference).file
  const potDir = dirname(resolve(target))
  return [potDir, dirname(potDir)].find((dir) => existsSync(join(dir, file)))
}

export async function runLint(cli: LintCli, target: string, flags: LintFlags): Promise<number> {
  const format = parseFormat(flags.format)
  // Checked here because it reaches a command line, through cmd.exe on Windows.
  if (flags.domain !== undefined && !/^[A-Za-z0-9_.-]+$/.test(flags.domain)) {
    throw new UsageError('--domain must be a text domain: letters, digits, dots, hyphens and underscores')
  }
  let info: Stats
  try {
    info = await stat(target)
  } catch {
    throw new UsageError(`${target} does not exist`)
  }
  const kind = info.isDirectory() ? 'folder' : info.isFile() && /\.pot$/i.test(target) ? 'pot' : undefined
  if (kind === undefined) throw new UsageError(`${target} is neither a folder nor a .pot file`)

  let tmp: string | undefined
  try {
    let potFile = target
    let root: string | undefined
    let config: LintConfig | undefined
    if (kind === 'folder') {
      root = resolve(target)
      // Read before make-pot, which can take a while on a big plugin: a bad
      // settings file should fail at once.
      config = (await findConfig([root], flags.config)).config
      tmp = await mkdtemp(join(tmpdir(), 'polyglots-lint-'))
      potFile = join(tmp, 'lint.pot')
      if (flags.source !== undefined) cli.err(warnLine(cli.ui.err, '--source is only for a .pot; for a folder, the folder is the source.'))
      await cli.makePot({
        dir: root,
        out: potFile,
        ...(flags.domain === undefined ? {} : { domain: flags.domain }),
        notice: (line) => cli.err(warnLine(cli.ui.err, line)),
      })
    }
    const units = (await loadPo(potFile)).units('all')
    if (kind === 'pot') {
      if (flags.domain !== undefined) cli.err(warnLine(cli.ui.err, '--domain is only for a folder; a .pot is read as it is.'))
      const first = units.flatMap((u) => u.references)[0]
      root = potSourceRoot(target, flags, first)
      if (first !== undefined && (root === undefined || !existsSync(join(root, parseReference(first).file)))) {
        cli.err(warnLine(cli.ui.err, `The source files ${target} points to were not found, so polyglots-ignore markers were not read. Name the plugin or theme folder with --source.`))
        root = undefined
      }
      const dirs = [dirname(resolve(target)), ...(root === undefined ? [] : [root])]
      config = (await findConfig(dirs, flags.config)).config
    }
    const report = lintPot(units, config!, root === undefined ? undefined : sourceReader(root))
    const strict = flags.strict === true
    // make-pot keeps only the strings in the Text Domain header's domain, or
    // the folder's name when there is no header, so a checkout folder named
    // after the repository can make a .pot with nothing in it, which would
    // otherwise read as a clean pass.
    if (kind === 'folder' && report.checked === 0) {
      cli.err(warnLine(cli.ui.err, 'make-pot found no strings outside the plugin or theme header. It keeps only strings whose text domain matches the Text Domain header, or the folder name when there is no such header. Add the header, or name the domain with --domain.'))
    }

    if (format === 'json') cli.out(jsonReport(report, target))
    else if (format === 'github') {
      // GitHub reads annotation paths from the repository root, which is
      // GITHUB_WORKSPACE in a workflow, not necessarily the folder lint ran
      // in. Without a source root a reference is relative to a folder nobody
      // found, so the annotation names no file rather than a wrong one.
      const base = process.env.GITHUB_WORKSPACE || process.cwd()
      const locate = (ref: string) => {
        if (root === undefined) return undefined
        const { file, line } = parseReference(ref)
        const path = relative(base, join(root, file))
        // Outside the repository GitHub cannot attach it to any file.
        if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined
        const posix = path.split(sep).join('/')
        return line === undefined ? { file: posix } : { file: posix, line }
      }
      for (const line of githubReport(report, locate)) cli.out(line)
      cli.out(totalLine(cli.ui.out, report, strict))
    } else for (const line of textReport(cli.ui.out, report, strict)) cli.out(line)

    return report.errors > 0 || (strict && report.warnings > 0) ? EXIT_FINDINGS : EXIT_OK
  } catch (err) {
    if (err instanceof UsageError) throw err
    // Anything that stops the lint before a report is printed means nothing
    // was checked: an unreadable .pot, a cache folder that cannot be written,
    // no temporary folder. Exit 1 would tell a CI job the strings have
    // errors, so every such failure is exit 2.
    const message = err instanceof LintNotStarted ? err.message : `The lint did not start: ${err instanceof Error ? err.message : String(err)}`
    cli.err(errorLine(cli.ui.err, message))
    if (err instanceof LintNotStarted) for (const line of err.detail) cli.err(hintLine(cli.ui.err, line))
    return EXIT_NOT_STARTED
  } finally {
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true })
  }
}
