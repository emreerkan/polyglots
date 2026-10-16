import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { reviewFile } from '../../src/commands/review.js'
import { openJobsDb } from '../../src/jobs/db.js'
import { localeRulesFile } from '../../src/rules/load.js'
import { evaluateInThreadForMeasurement, resetSandbox } from '../../src/rules/sandbox.js'
import { openDb, replaceGlossary } from '../../src/storage/index.js'

// The overhead of running every rules regex in the worker, measured rather
// than assumed: the spec accepts the synchronous design only if it adds under
// a second to a rules-only review of wp/dev. Skipped unless asked for, since
// it needs a real export and takes tens of seconds:
//
//   POLYGLOTS_MEASURE=<path to wp_dev.po> npx vitest run test/rules/sandbox-measure.test.ts
//
// POLYGLOTS_MEASURE_RULES names the rules file, the tr test fixture by default
// (point it at polyglots-data's locales/tr_TR/rules.yaml for the published
// one). A non-Turkish export is rewritten to Turkish plural forms, so the tr
// rules run over every entry; the op count is what costs, not the language.
const RULES = process.env.POLYGLOTS_MEASURE_RULES ?? fileURLToPath(new URL('../fixtures/locale/tr_TR.yaml', import.meta.url))

describe('sandbox overhead', () => {
  it.skipIf(!process.env.POLYGLOTS_MEASURE)('measures a rules-only review of wp_dev with the tr rules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polyglots-measure-'))
    try {
      const file = join(dir, 'wp_dev-tr.po')
      const po = readFileSync(process.env.POLYGLOTS_MEASURE!, 'utf8')
        .replace(/"Plural-Forms: [^"]*"/, '"Plural-Forms: nplurals=2; plural=n > 1;\\n"')
        .replace(/"Language: [^"]*"/, '"Language: tr\\n"')
      writeFileSync(file, po)
      const rules = localeRulesFile('tr')
      mkdirSync(dirname(rules), { recursive: true })
      copyFileSync(RULES, rules)
      const db = openDb(join(dir, 'polyglots.db'))
      replaceGlossary(db, 'tr', [{ sourceTerm: 'Settings', translation: 'Ayarlar', locale: 'tr' }])
      const jobsDb = openJobsDb(join(dir, 'jobs.db'))

      const run = async (inThread: boolean, outDir: string) => {
        resetSandbox()
        evaluateInThreadForMeasurement(inThread)
        const t0 = performance.now()
        const summary = await reviewFile({ file, locale: 'tr', db, jobsDb, noAi: true, outDir, fresh: true })
        const ms = performance.now() - t0
        return { ms, summary, out: summary.problemsFile ? readFileSync(summary.problemsFile, 'utf8') : '' }
      }
      // A first pass warms what both share (the po parser, the literal
      // sources, the casing tables) so neither measured run pays for it.
      await run(true, join(dir, 'warm'))
      const inThread = await run(true, join(dir, 'in-thread'))
      const sandboxed = await run(false, join(dir, 'sandboxed'))
      resetSandbox()
      db.close()
      jobsDb.close()

      console.log(
        `entries ${inThread.summary.total} (${inThread.summary.reviewed} reviewed, ${Object.values(inThread.summary.byRule).reduce((a, b) => a + b, 0)} findings): in-thread ${inThread.ms.toFixed(0)} ms, sandbox ${sandboxed.ms.toFixed(0)} ms, ` +
          `added ${(sandboxed.ms - inThread.ms).toFixed(0)} ms`,
      )
      // Same findings either way, or the sandbox is not evaluating what the
      // rules meant.
      expect(sandboxed.summary.byRule).toEqual(inThread.summary.byRule)
      expect(sandboxed.out.replace(/^"X-Polyglots[^\n]*\n/gm, '')).toBe(inThread.out.replace(/^"X-Polyglots[^\n]*\n/gm, ''))
      expect(sandboxed.summary.skippedRules).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
