import { readFileSync } from 'node:fs'
import { configuredLocale, loadConfig } from '../config.js'
import { readGlossaryCsv } from '../glossary/csv.js'
import { startGlossaryEditor, type EditorSource, type GlossaryEditorServer } from '../glossary/editor/server.js'
import { openInBrowser } from '../stats/server.js'
import { resolveLocale } from '../wporg/locales.js'

export interface EditGlossaryOptions {
  source: EditorSource
  // Errors the server meets after it started. The CLI writes them to stderr,
  // as stats does: the page shows a refused save, but a 500 says nothing.
  onError?: (err: Error) => void
  // Seams for tests and the website's demos. The defaults are the real
  // server, the real opener, and the first SIGINT or SIGTERM.
  start?: typeof startGlossaryEditor
  openBrowser?: (url: string) => Promise<boolean>
  untilStopped?: () => Promise<void>
}

export interface EditorServing {
  url: string
  mode: 'polyglots' | 'CSV'
  locale: string
  opened: boolean
}

// How the editor ended: stopped from the terminal, or closed by itself, when
// the page sent close or sat idle. The CLI says how to reopen it only after
// the second, since after a Ctrl+C the person knows.
export type EditorEnd = 'stopped' | 'closed'

export const editorReadyLine = (s: EditorServing): string =>
  `Glossary editor at ${s.url} (${s.mode}, ${s.locale}). Press Ctrl+C to stop.`

/**
 * The locale a CSV editor works in, for the line that announces it: the one
 * given, else the header's, else the configured one for a file not there yet.
 * The server decides the same on every load and refuses what it cannot
 * resolve, so this never refuses: a header it cannot read is named as it is,
 * and the page says what is wrong with it.
 */
function csvLocale(file: string, given: string | undefined): string {
  if (given !== undefined) return given
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return configuredLocale(loadConfig()) ?? 'no locale'
  }
  try {
    const header = readGlossaryCsv(text).headerLocale
    return resolveLocale(header)?.id ?? header
  } catch {
    return 'unreadable header'
  }
}

/**
 * Serves the glossary editor in the foreground until it ends: Ctrl+C here,
 * or the server ending itself (see startGlossaryEditor). `onReady` hears the
 * URL once the server listens and the browser was asked, so the caller can
 * print it. Resolves after the server has closed, with how it ended.
 */
export async function editGlossary(opts: EditGlossaryOptions, onReady: (serving: EditorServing) => void): Promise<EditorEnd> {
  const server: GlossaryEditorServer = await (opts.start ?? startGlossaryEditor)({
    source: opts.source,
    ...(opts.onError === undefined ? {} : { onError: opts.onError }),
  })
  // The listeners go as soon as either side ends, so a server that closed by
  // itself does not leave a SIGINT handler swallowing the next Ctrl+C.
  let dispose = (): void => {}
  try {
    const opened = await (opts.openBrowser ?? openInBrowser)(server.url)
    onReady({
      url: server.url,
      mode: opts.source.kind === 'db' ? 'polyglots' : 'CSV',
      locale: opts.source.kind === 'db' ? opts.source.locale : csvLocale(opts.source.file, opts.source.locale),
      opened,
    })
    const stopped = opts.untilStopped
      ? opts.untilStopped()
      : new Promise<void>((resolve) => {
          const stop = (): void => {
            dispose()
            resolve()
          }
          dispose = () => {
            process.off('SIGINT', stop)
            process.off('SIGTERM', stop)
          }
          process.once('SIGINT', stop)
          process.once('SIGTERM', stop)
        })
    return await Promise.race([stopped.then(() => 'stopped' as const), server.done.then(() => 'closed' as const)])
  } finally {
    dispose()
    await server.close()
  }
}
