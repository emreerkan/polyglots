import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type Database from 'better-sqlite3'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ConsistencyEntry, ConsistencyScope, Locale } from '../types.js'
import { getConsistency, lookupEffectiveGlossary, searchTm, setConsistency } from '../storage/index.js'
import { normalizeLocale } from '../tmx/parse.js'
import { mcpLogPath, pruneLogs } from '../logs/paths.js'
import { fetchConsistency as defaultFetchConsistency } from '../wporg/consistency-scraper.js'

export interface ToolDeps {
  db: Database.Database
  // The run's locale. Absent for a server started with no POLYGLOTS_LOCALE
  // and no configured locale, where every call must name its own.
  locale?: Locale
  ttlDays: number
  fetchConsistency?: typeof defaultFetchConsistency
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return { isError: true, content: [{ type: 'text' as const, text: message }] }
}

// One line per call, never its text: the arguments and results are catalogue
// strings. The server cannot know which run called it (antigravity starts it
// from a one-time registration with a fixed environment), so the line carries
// its own pid and parent pid, and the report matches it to a run by time and
// by the agent pid that run recorded.
//
// The wrapper takes the tool's plain value rather than its MCP result, and
// does the json/failure wrapping itself: the result is a single text item
// holding JSON, so counting content items would say 1 for every call, and
// parsing the text back only to count it is work the value already did. A
// throw becomes the tool error it always was, so the agent still sees it.
type ToolResult = ReturnType<typeof json> | ReturnType<typeof failure>

// An error message is not free of catalogue text just because it is ours: a
// failed wp.org fetch says "GET <url> failed: 429", and the consistency URL
// carries the source string in its query. A rate limit or a timeout is an
// ordinary failure, so without this the log would hold source strings in
// normal use, and the problem report that bundles these lines leaves the
// machine. The query and fragment go; the origin and path stay, since they
// say which endpoint failed, which is the part worth reading. Only the log
// line is redacted: the agent still gets the whole message as its tool error.
function redactUrls(message: string): string {
  return message.replace(/(https?:\/\/[^\s?#]*)[?#]\S*/g, '$1?…')
}

function logged<A>(tool: string, handler: (args: A) => unknown): (args: A) => Promise<ToolResult> {
  return async (args) => {
    const t0 = Date.now()
    const line = (fields: { results: number | null; error: string | null }) => {
      try {
        // Resolved once, so a call that ends after midnight lands whole in one file.
        const path = mcpLogPath(t0)
        mkdirSync(dirname(path), { recursive: true })
        appendFileSync(
          path,
          JSON.stringify({
            t: t0,
            pid: process.pid,
            ppid: process.ppid,
            tool,
            argBytes: Buffer.byteLength(JSON.stringify(args ?? null)),
            ms: Date.now() - t0,
            ...fields,
          }) + '\n',
        )
      } catch {
        // A lookup is never worth failing over its log line.
      }
    }
    try {
      const out = await handler(args)
      line({ results: Array.isArray(out) ? out.length : null, error: null })
      return json(out)
    } catch (error) {
      line({ results: null, error: redactUrls(error instanceof Error ? error.message : String(error)) })
      return failure(error)
    }
  }
}

const localeArg = z.string().min(1).optional().describe('Target locale code; defaults to the run locale.')

// translate.wordpress.org must never see parallel requests from one review batch, and claude
// issues tool calls concurrently, so fetches go through one queue with in-flight dedupe.
function createConsistencyLookup(deps: ToolDeps, fetchConsistency: typeof defaultFetchConsistency) {
  const inflight = new Map<string, Promise<ConsistencyEntry[]>>()
  let queue: Promise<unknown> = Promise.resolve()

  const fetchAndCache = async (text: string, locale: Locale, scope: ConsistencyScope): Promise<ConsistencyEntry[]> => {
    const cached = getConsistency(deps.db, text, locale, deps.ttlDays, scope)
    if (cached) return cached
    const entries = await fetchConsistency(text, locale, undefined, scope)
    if (entries.length > 0) setConsistency(deps.db, text, locale, entries, scope)
    return entries
  }

  return (text: string, locale: Locale, scope: ConsistencyScope): Promise<ConsistencyEntry[]> => {
    const cached = getConsistency(deps.db, text, locale, deps.ttlDays, scope)
    if (cached) return Promise.resolve(cached)
    const key = `${scope}\0${locale}\0${text}`
    const pending = inflight.get(key)
    if (pending) return pending
    const run = queue.then(() => fetchAndCache(text, locale, scope))
    queue = run.catch(() => undefined)
    inflight.set(key, run)
    void run.finally(() => inflight.delete(key)).catch(() => undefined)
    return run
  }
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  // A run prunes at its own start too, but antigravity can start this server
  // outside any polyglots run (it is registered once, not per run), and the
  // day files it writes should age out on the same terms. A readdir per
  // server start is the whole cost.
  pruneLogs()
  const lookupConsistency = createConsistencyLookup(deps, deps.fetchConsistency ?? defaultFetchConsistency)
  const defaultLocale = deps.locale === undefined ? undefined : normalizeLocale(deps.locale)
  // Refused rather than guessed: a lookup in the wrong locale returns another
  // language's approved wording, which the model would then hold up as
  // authoritative. Thrown inside each handler, so it reaches the agent as a
  // tool error it can act on rather than ending the server.
  const resolveLocale = (locale?: string): Locale => {
    if (locale) return normalizeLocale(locale)
    if (defaultLocale !== undefined) return defaultLocale
    throw new Error('No locale: pass the locale argument, or start the server with POLYGLOTS_LOCALE set')
  }

  server.registerTool(
    'glossary_lookup',
    {
      description:
        "Look up the locale glossary (translate.wordpress.org plus the person's local edits) for a source term; call it whenever a draft contains a WordPress term whose approved translation you are not certain of.",
      inputSchema: {
        term: z.string().min(1).describe('English source term or phrase to look up.'),
        locale: localeArg,
      },
    },
    logged('glossary_lookup', ({ term, locale }: { term: string; locale?: string | undefined }) =>
      lookupEffectiveGlossary(deps.db, term, resolveLocale(locale)),
    ),
  )

  server.registerTool(
    'consistency_lookup',
    {
      description:
        'Check how an exact source string is already translated on translate.wordpress.org, as {translation, count} pairs. Defaults to WordPress core, whose translations are reviewed by the locale team and are authoritative. Call it only when the glossary has no answer for the wording, and widen to scope "all" only if core returns nothing.',
      inputSchema: {
        text: z.string().min(1).describe('Exact English source string to check.'),
        locale: localeArg,
        scope: z
          .enum(['core', 'all'])
          .optional()
          .describe(
            'core (default) = WordPress core only, reviewed and authoritative. all = every plugin and theme, translated by their authors without review, so treat it as weak evidence and expect conflicting variants.',
          ),
      },
    },
    logged(
      'consistency_lookup',
      ({ text, locale, scope }: { text: string; locale?: string | undefined; scope?: ConsistencyScope | undefined }) =>
        lookupConsistency(text, resolveLocale(locale), scope ?? 'core'),
    ),
  )

  server.registerTool(
    'tm_lookup',
    {
      description:
        'Search the local translation memory for near-matching source strings; call it to reuse wording from previously approved translations of similar strings.',
      inputSchema: {
        text: z.string().min(1).describe('Source string to find similar translation-memory entries for.'),
        locale: localeArg,
        limit: z.number().int().positive().max(50).optional().describe('Maximum matches to return (default 5).'),
      },
    },
    logged('tm_lookup', ({ text, locale, limit }: { text: string; locale?: string | undefined; limit?: number | undefined }) =>
      searchTm(deps.db, text, resolveLocale(locale), limit ?? 5),
    ),
  )
}
