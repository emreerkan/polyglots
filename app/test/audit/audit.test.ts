import { describe, expect, it, vi } from 'vitest'
import type { AuditEntry, GlossaryEntry } from '../../src/types.js'
import { AgentError, buildAgentArgs, readAgentOutput } from '../../src/agent/run.js'
import { tmKey } from '../../src/audit/rules/index.js'
import { auditEntries } from '../../src/audit/audit.js'
import { createRunControl } from '../../src/run-control.js'
import { buildAuditPrompt } from '../../src/audit/prompt.js'
import { mapAuditResults } from '../../src/audit/schema.js'
import { useLocaleFixture } from '../locale-fixture.js'

// The Turkish entries here are reviewed under the Turkish rules file, which is
// where Turkish rules come from now that polyglots ships no locale data.
useLocaleFixture('tr_TR.yaml')

const GLOSSARY: GlossaryEntry[] = [
  { locale: 'tr', sourceTerm: 'sidebar', translation: 'kenar çubuğu', partOfSpeech: 'noun' },
]

function entry(key: string, msgid: string, msgstr: string): AuditEntry {
  return { key, msgid, msgstr: [msgstr], comments: [], references: [], fuzzy: false }
}

const clean = entry('a', 'Save all changes', 'Tüm değişiklikleri kaydet')
const hardError = entry('b', '%s comments', 'yorumlar')
const suspect = entry('c', 'Sidebar', 'Yan menü')

function base(overrides = {}) {
  return { locale: 'tr', nplurals: 2, glossary: GLOSSARY, mcpConfigPath: '/tmp/mcp.json', ...overrides }
}

describe('auditEntries', () => {
  // The rules proved it broken, so the model's job is to fix it, not to argue.
  it('sends a rule-condemned entry to the model to be repaired', async () => {
    const adjudicate = vi.fn(async (batch: { id: number }[]) =>
      batch.map((c) => ({ id: c.id, problem: true, categories: ['placeholder'] as never[], reason: 'lost %s', fix: ['%s yorum'] })),
    )
    const verdicts = await auditEntries({ entries: [hardError], ...base(), adjudicate })

    expect(adjudicate).toHaveBeenCalledTimes(1)
    expect(verdicts[0]).toMatchObject({ key: 'b', problem: true, text: ['%s yorum'], repairedBy: 'model' })
  })

  it('does not let the model clear what the rules proved broken', async () => {
    const adjudicate = vi.fn(async (batch: { id: number }[]) =>
      batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'looks fine to me' })),
    )
    const verdicts = await auditEntries({ entries: [hardError], ...base(), adjudicate })

    expect(verdicts[0]).toMatchObject({ key: 'b', problem: true })
    expect(verdicts[0]!.findings.map((f) => f.rule)).toContain('placeholder')
  })

  it('takes the fix even when the model wrongly cleared a rule-condemned entry', async () => {
    const adjudicate = vi.fn(async (batch: { id: number }[]) =>
      batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok', fix: ['%s yorum'] })),
    )
    const verdicts = await auditEntries({ entries: [hardError], ...base(), adjudicate })
    expect(verdicts[0]!.text).toEqual(['%s yorum'])
  })

  it('records why a bad fix was thrown away rather than silently dropping it', async () => {
    const adjudicate = vi.fn(async (batch: { id: number }[]) =>
      batch.map((c) => ({ id: c.id, problem: true, categories: ['placeholder'] as never[], reason: 'lost %s', fix: ['hala yorumlar'] })),
    )
    const verdicts = await auditEntries({ entries: [hardError], ...base(), adjudicate })

    expect(verdicts[0]!.text).toBeUndefined()
    expect(verdicts[0]!.findings.map((f) => f.message).join(' ')).toMatch(/rejected/i)
  })

  it('ignores a fix on an entry that had nothing wrong with it', async () => {
    const adjudicate = vi.fn(async (batch: { id: number }[]) =>
      batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok', fix: ['Başka bir şey'] })),
    )
    const verdicts = await auditEntries({ entries: [clean], ...base(), adjudicate })
    expect(verdicts[0]!.text).toBeUndefined()
  })

  it('sends suspects to the AI carrying their rule findings as hints', async () => {
    const adjudicate = vi.fn().mockResolvedValue([{ id: 1, problem: false, categories: [], reason: 'inflected form' }])
    await auditEntries({ entries: [suspect], ...base(), adjudicate })

    expect(adjudicate).toHaveBeenCalledTimes(1)
    const [batch] = adjudicate.mock.calls[0]!
    expect(batch).toHaveLength(1)
    expect(batch[0]).toMatchObject({ id: 1, key: 'c', msgid: 'Sidebar', msgstr: ['Yan menü'] })
    expect(batch[0].hints.map((h: { rule: string }) => h.rule)).toContain('glossary')
  })

  it('forwards the entry references to the adjudicator', async () => {
    const withRefs = { ...suspect, references: ['includes/admin-menu.php:42'] }
    const adjudicate = vi.fn().mockResolvedValue([{ id: 1, problem: false, categories: [], reason: 'ok' }])
    await auditEntries({ entries: [withRefs], ...base(), adjudicate })
    expect(adjudicate.mock.calls[0]![0][0]).toMatchObject({ references: ['includes/admin-menu.php:42'] })
  })

  it('lets the AI clear a suspect the rules raised', async () => {
    const adjudicate = vi.fn().mockResolvedValue([{ id: 1, problem: false, categories: [], reason: 'correct form' }])
    const [verdict] = await auditEntries({ entries: [suspect], ...base(), adjudicate })

    expect(verdict).toMatchObject({ key: 'c', problem: false })
  })

  it('lets the AI confirm a suspect, keeping both the rule finding and its own', async () => {
    const adjudicate = vi
      .fn()
      .mockResolvedValue([{ id: 1, problem: true, categories: ['glossary'], reason: 'ignores the approved term' }])
    const [verdict] = await auditEntries({ entries: [suspect], ...base(), adjudicate })

    expect(verdict!.problem).toBe(true)
    expect(verdict!.findings.map((f) => f.rule)).toEqual(['glossary', 'ai:glossary'])
    expect(verdict!.reason).toContain('ignores the approved term')
  })

  it('sends clean entries to the AI too, so meaning errors are caught', async () => {
    const adjudicate = vi
      .fn()
      .mockResolvedValue([{ id: 1, problem: true, categories: ['meaning'], reason: 'says the opposite' }])
    const [verdict] = await auditEntries({ entries: [clean], ...base(), adjudicate })

    expect(adjudicate).toHaveBeenCalledTimes(1)
    expect(verdict).toMatchObject({ key: 'a', problem: true })
    expect(verdict!.findings.map((f) => f.rule)).toEqual(['ai:meaning'])
  })

  it('never calls the AI when noAi is set', async () => {
    const adjudicate = vi.fn()
    const verdicts = await auditEntries({ entries: [clean, suspect], ...base({ noAi: true }), adjudicate })

    expect(adjudicate).not.toHaveBeenCalled()
    expect(verdicts.find((v) => v.key === 'a')!.problem).toBe(false)
    expect(verdicts).toHaveLength(2)
  })

  // Without the model nothing adjudicates a suspect, so a soft finding must not
  // masquerade as a confirmed problem.
  it('separates hard errors from soft findings under noAi', async () => {
    const adjudicate = vi.fn()
    const verdicts = await auditEntries({ entries: [clean, hardError, suspect], ...base({ noAi: true }), adjudicate })
    const byKey = new Map(verdicts.map((v) => [v.key, v]))

    expect(byKey.get('b')).toMatchObject({ problem: true })
    expect(byKey.get('b')!.needsReview).toBeFalsy()
    expect(byKey.get('c')).toMatchObject({ problem: false, needsReview: true })
    expect(byKey.get('a')).toMatchObject({ problem: false })
    expect(byKey.get('a')!.needsReview).toBeFalsy()
  })

  it('never marks a verdict needsReview when the model is in the loop', async () => {
    const adjudicate = vi.fn().mockResolvedValue([{ id: 1, problem: false, categories: [], reason: 'ok' }])
    const [verdict] = await auditEntries({ entries: [suspect], ...base(), adjudicate })
    expect(verdict!.needsReview).toBeFalsy()
  })

  it('batches candidates by batchSize', async () => {
    const many = Array.from({ length: 5 }, (_, i) => entry(`k${i}`, `Source ${i}`, `Çeviri ${i}`))
    const adjudicate = vi
      .fn()
      .mockImplementation(async (batch: { id: number }[]) =>
        batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' })),
      )
    await auditEntries({ entries: many, ...base({ batchSize: 2 }), adjudicate })

    expect(adjudicate.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([2, 2, 1])
  })

  it('retries a failed batch once, then marks those entries unreviewed problems', async () => {
    const adjudicate = vi.fn().mockRejectedValue(new Error('claude exited with exit code 1'))
    const [verdict] = await auditEntries({ entries: [clean], ...base(), adjudicate })

    expect(adjudicate).toHaveBeenCalledTimes(2)
    expect(verdict).toMatchObject({ key: 'a', problem: true, unreviewed: true })
    expect(verdict!.reason).toContain('could not be reviewed')
  })

  // The UI showed "0 flagged by rules" forever because nothing reported the rule
  // pass, and 0/0 because a batch only announced itself once it had finished.
  /**
   * The options handed to the adjudicator are assembled field by field, and
   * `provider` was left out of that list. Every review that recorded
   * `antigravity` therefore spawned `claude`, cached Claude's verdicts under
   * antigravity's key, and spent the wrong subscription. Nothing caught it
   * because every other test here injects an adjudicator and never looks at
   * what it was handed.
   */
  /**
   * An agent that issues tool calls one at a time spends most of a batch on
   * them: a 10-entry batch made 30 sequential MCP calls and never reached an
   * answer inside five minutes. The glossary terms a source contains are known
   * before the prompt is built, so stating them costs nothing and removes the
   * commonest reason to call a tool.
   */
  it('states the binding glossary terms in the prompt', async () => {
    const prompts: string[] = []
    const adjudicate = vi.fn(async (batch: { id: number }[], _opts: unknown, ) => {
      return batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' }))
    })
    let built = ''
    await auditEntries({
      entries: [entry('a', 'Open the sidebar', 'Kenar çubuğunu aç')],
      ...base(),
      adjudicate: async (batch, opts) => {
        built = buildAuditPrompt(batch, 'tr', 2)
        prompts.push(built)
        return adjudicate(batch, opts)
      },
    })
    // The payload key, not the guidance, which now also mentions the word.
    expect(built).toContain('"glossary":')
    expect(built).toContain('sidebar')
    expect(built).toContain('kenar çubuğu')
  })

  // A source touching no glossary term must not gain an empty field.
  it('leaves the field out when the source touches no term', async () => {
    let built = ''
    await auditEntries({
      entries: [entry('a', 'Zzzz qqqq', 'Zzzz qqqq')],
      ...base(),
      adjudicate: async (batch) => {
        built = buildAuditPrompt(batch, 'tr', 2)
        return batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' }))
      },
    })
    expect(built).not.toContain('"glossary":')
  })

  /**
   * tm_lookup was 44% of every tool call an agent made on a real run, and the
   * answer for an exact source is known before the prompt is built.
   */
  it('states what the memory holds for an exact source', async () => {
    let built = ''
    await auditEntries({
      entries: [entry('a', 'Post', 'Gönderi')],
      ...base(),
      tm: new Map([[tmKey('Post'), ['Yazı']]]),
      adjudicate: async (batch) => {
        built = buildAuditPrompt(batch, 'tr', 2)
        return batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' }))
      },
    })
    expect(built).toContain('"memory":["Yazı"]')
  })

  it('says nothing about a source the memory has never seen', async () => {
    let built = ''
    await auditEntries({
      entries: [entry('a', 'Post', 'Gönderi')],
      ...base(),
      tm: new Map([[tmKey('Other'), ['Başka']]]),
      adjudicate: async (batch) => {
        built = buildAuditPrompt(batch, 'tr', 2)
        return batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' }))
      },
    })
    // The payload key, not the guidance, which names the field too.
    expect(built).not.toContain('"memory":')
  })

  it('tells the adjudicator which agent to drive', async () => {
    const seen: Array<Record<string, unknown>> = []
    const adjudicate = vi.fn(async (batch: { id: number }[], opts: { provider?: string }) => {
      seen.push(opts as Record<string, unknown>)
      return batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' }))
    })
    await auditEntries({ entries: [clean], ...base(), provider: 'antigravity', adjudicate })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.provider).toBe('antigravity')
    // The argv the runner would build from those options is the proof that
    // matters: the name alone could still be read as the default.
    expect(buildAgentArgs({}, seen[0]! as never)).not.toContain('--mcp-config')
  })

  it('leaves the agent unnamed when the caller named none', async () => {
    const seen: Array<Record<string, unknown>> = []
    const adjudicate = vi.fn(async (batch: { id: number }[], opts: { provider?: string }) => {
      seen.push(opts as Record<string, unknown>)
      return batch.map((c) => ({ id: c.id, problem: false, categories: [] as never[], reason: 'ok' }))
    })
    await auditEntries({ entries: [clean], ...base(), adjudicate })
    expect(seen[0]!.provider).toBeUndefined()
    expect(buildAgentArgs({}, seen[0]! as never)).toContain('--mcp-config')
  })

  it('reports what the rules decided before any AI call', async () => {
    const seen: unknown[] = []
    const adjudicate = vi
      .fn()
      .mockImplementation(async (batch: { id: number }[]) =>
        batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' })),
      )
    await auditEntries({
      entries: [clean, hardError, suspect],
      ...base(),
      adjudicate,
      onRules: (r) => seen.push(r),
    })
    expect(seen).toEqual([{ flagged: 1, suspects: 1, memoryApproved: 0, memoryRepaired: 0 }])
  })

  /**
   * With --no-ai nothing becomes a candidate: every entry is decided on the
   * spot, so a suspect count read from the candidate list is structurally zero
   * however many entries the rules doubted. The rules-only run is exactly the
   * one whose whole output is those doubts, and the screen reported none.
   */
  it('counts entries the rules doubt on a rules-only run', async () => {
    const seen: { flagged: number; suspects: number }[] = []
    const verdicts = await auditEntries({
      entries: [clean, hardError, suspect],
      ...base(),
      noAi: true,
      onRules: (r) => seen.push(r),
    })

    const needing = verdicts.filter((v) => v.needsReview).length
    expect(needing).toBeGreaterThan(0)
    expect(seen).toEqual([{ flagged: 1, suspects: needing, memoryApproved: 0, memoryRepaired: 0 }])
  })

  // A whitespace repair is settled, not an open question, so it must not swell
  // the count of entries the user is told the model still has to weigh.
  it('does not count a mechanical repair among the suspects it reports', async () => {
    const seen: unknown[] = []
    const adjudicate = vi
      .fn()
      .mockImplementation(async (batch: { id: number }[]) =>
        batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' })),
      )
    await auditEntries({
      entries: [entry('d', 'Save ', 'Kaydet')],
      ...base(),
      adjudicate,
      onRules: (r) => seen.push(r),
    })
    expect(seen).toEqual([{ flagged: 0, suspects: 0, memoryApproved: 0, memoryRepaired: 0 }])
  })

  it('announces a batch before running it, not after', async () => {
    const order: string[] = []
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => {
      order.push('adjudicate')
      return batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' }))
    })
    await auditEntries({
      entries: [clean, suspect],
      ...base({ batchSize: 1 }),
      adjudicate,
      onBatchStart: () => order.push('start'),
      onBatch: () => {
        order.push('done')
      },
    })
    expect(order).toEqual(['start', 'adjudicate', 'done', 'start', 'adjudicate', 'done'])
  })

  it('hands each batch verdicts over as they are decided', async () => {
    const batches: string[][] = []
    const adjudicate = vi
      .fn()
      .mockImplementation(async (batch: { id: number }[]) =>
        batch.map((c) => ({ id: c.id, problem: true, categories: ['meaning'], reason: 'nope' })),
      )
    await auditEntries({
      entries: [clean, suspect],
      ...base({ batchSize: 1 }),
      adjudicate,
      onBatch: (p) => {
        batches.push(p.verdicts.map((v) => v.key))
      },
    })
    expect(batches).toEqual([['a'], ['c']])
  })

  it('waits for a slow onBatch before starting the next batch', async () => {
    const order: string[] = []
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => {
      order.push('adjudicate')
      return batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' }))
    })
    await auditEntries({
      entries: [clean, suspect],
      ...base({ batchSize: 1 }),
      adjudicate,
      onBatch: async () => {
        await new Promise((r) => setTimeout(r, 5))
        order.push('saved')
      },
    })
    expect(order).toEqual(['adjudicate', 'saved', 'adjudicate', 'saved'])
  })

  it('reports why a batch failed so the run can say so', async () => {
    const seen: Array<string | undefined> = []
    const adjudicate = vi.fn().mockRejectedValue(new Error('claude exited with exit code 1'))
    await auditEntries({
      entries: [clean],
      ...base(),
      adjudicate,
      onBatch: (p) => {
        seen.push(p.failed)
      },
    })
    expect(seen[0]).toMatch(/exit code 1/)
  })

  // Every failed attempt, with how long it took, including a first attempt the
  // retry then rescued: that one costs nothing in the output but says how often
  // the agent is unreliable, which nothing else records.
  it('reports each failed attempt, even when the retry succeeds', async () => {
    const seen: Array<{ failed?: string; attempts?: Array<{ attempt: number; reason: string; ms: number }> }> = []
    const adjudicate = vi
      .fn()
      .mockRejectedValueOnce(new Error('antigravity timed out after 1200000ms'))
      .mockImplementation(async (batch: { id: number }[]) => batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' })))
    await auditEntries({ entries: [clean], ...base(), adjudicate, onBatch: (p) => void seen.push(p) })
    expect(seen[0]!.failed).toBeUndefined()
    expect(seen[0]!.attempts).toEqual([{ attempt: 1, reason: 'antigravity timed out after 1200000ms', ms: expect.any(Number) }])
  })

  it('reports both attempts of a batch that failed', async () => {
    const seen: Array<{ attempts?: Array<{ attempt: number; reason: string }> }> = []
    const adjudicate = vi.fn().mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('second'))
    await auditEntries({ entries: [clean], ...base(), adjudicate, onBatch: (p) => void seen.push(p) })
    expect(seen[0]!.attempts?.map((a) => [a.attempt, a.reason])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ])
  })

  it('reports batch progress', async () => {
    const events: unknown[] = []
    const adjudicate = vi
      .fn()
      .mockImplementation(async (batch: { id: number }[]) =>
        batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' })),
      )
    await auditEntries({
      entries: [clean, suspect],
      ...base({ batchSize: 1 }),
      adjudicate,
      onBatch: (e) => {
        events.push(e)
      },
    })

    expect(events).toEqual([
      { index: 1, of: 2, size: 1, problems: 0, verdicts: [expect.objectContaining({ key: 'a' })] },
      { index: 2, of: 2, size: 1, problems: 0, verdicts: [expect.objectContaining({ key: 'c' })] },
    ])
  })

  it('preserves input order in the returned verdicts', async () => {
    const adjudicate = vi
      .fn()
      .mockImplementation(async (batch: { id: number }[]) =>
        batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' })),
      )
    const verdicts = await auditEntries({ entries: [clean, hardError, suspect], ...base(), adjudicate })
    expect(verdicts.map((v) => v.key)).toEqual(['a', 'b', 'c'])
  })

  // An entry whose only fault is a dropped trailing space is a hard error today,
  // which means it never reaches the model and can never be fixed at all.
  it('repairs whitespace itself and lets the fixed text clear the rules', async () => {
    const dropped = entry('w', 'Save changes ', 'Değişiklikleri kaydet')
    const adjudicate = vi
      .fn()
      .mockResolvedValue([{ id: 1, problem: false, categories: [], reason: 'ok' }])
    const verdicts = await auditEntries({ entries: [dropped], ...base(), adjudicate })

    // It went to the model as an ordinary candidate, not as a condemned entry.
    expect(adjudicate).toHaveBeenCalledTimes(1)
    expect(verdicts[0]).toMatchObject({ key: 'w', text: ['Değişiklikleri kaydet '], repairedBy: 'rules' })
  })

  it('reports the mechanical repair as a finding, so the file says what changed', async () => {
    const dropped = entry('w', 'Save changes ', 'Değişiklikleri kaydet')
    const verdicts = await auditEntries({ entries: [dropped], ...base({ noAi: true }) })
    expect(verdicts[0]!.findings.map((f) => f.rule)).toContain('repaired')
  })

  // Clearing the entry does not un-make the repair. The note is the only record
  // that the text in the file is not what was submitted, and the only thing a
  // resumed run can find the entry by.
  it('keeps the repair note on an entry the model cleared', async () => {
    const dropped = entry('w', 'Save changes ', 'Değişiklikleri kaydet')
    const adjudicate = vi.fn().mockResolvedValue([{ id: 1, problem: false, categories: [], reason: 'ok' }])
    const verdicts = await auditEntries({ entries: [dropped], ...base(), adjudicate })

    expect(verdicts[0]).toMatchObject({ problem: false, text: ['Değişiklikleri kaydet '] })
    expect(verdicts[0]!.findings.map((f) => f.rule)).toEqual(['repaired'])
  })

  it('judges the repaired text, not the submitted text', async () => {
    // Whitespace is the entry's only fault, so after repair nothing is wrong.
    const dropped = entry('w', 'Save changes ', 'Değişiklikleri kaydet')
    const verdicts = await auditEntries({ entries: [dropped], ...base({ noAi: true }) })
    expect(verdicts[0]!.findings.map((f) => f.rule)).not.toContain('whitespace')
  })

  it('leaves an entry it cannot mechanically repair without text', async () => {
    const adjudicate = vi.fn().mockResolvedValue([{ id: 1, problem: false, categories: [], reason: 'ok' }])
    const verdicts = await auditEntries({ entries: [clean], ...base(), adjudicate })
    expect(verdicts[0]!.text).toBeUndefined()
    expect(verdicts[0]!.repairedBy).toBeUndefined()
  })
})

// Pausing is for a subscription that ran out of quota mid-run, so it has to stop
// between calls, never inside one: a batch abandoned in flight is quota already
// spent for nothing.
describe('auditEntries under a run control', () => {
  const four = () => Array.from({ length: 4 }, (_, i) => entry(`k${i}`, `Source ${i}`, `Çeviri ${i}`))
  const ok = (batch: { id: number }[]) => batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' }))

  it('runs to the end when nothing asks it to stop', async () => {
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => ok(batch))
    await auditEntries({ entries: four(), ...base({ batchSize: 1 }), adjudicate, control: createRunControl() })
    expect(adjudicate).toHaveBeenCalledTimes(4)
  })

  it('finishes the batch it is in before it parks', async () => {
    const control = createRunControl()
    const finished: number[] = []
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => {
      control.pause()
      return ok(batch)
    })

    const run = auditEntries({
      entries: four(),
      ...base({ batchSize: 1 }),
      adjudicate,
      control,
      onBatch: (b: { index: number }) => {
        finished.push(b.index)
      },
    })
    await new Promise((r) => setTimeout(r, 30))

    // The batch that was in flight completed and was reported; the next never started.
    expect(finished).toEqual([1])
    expect(adjudicate).toHaveBeenCalledTimes(1)

    control.stop()
    await run
  })

  it('carries on from where it parked when resumed', async () => {
    const control = createRunControl()
    let seen = 0
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => {
      if (++seen === 1) control.pause()
      return ok(batch)
    })

    const run = auditEntries({ entries: four(), ...base({ batchSize: 1 }), adjudicate, control })
    await new Promise((r) => setTimeout(r, 20))
    expect(adjudicate).toHaveBeenCalledTimes(1)

    control.resume()
    await run
    expect(adjudicate).toHaveBeenCalledTimes(4)
  })

  it('stops at the next boundary when told to quit', async () => {
    const control = createRunControl()
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => {
      control.stop()
      return ok(batch)
    })
    await auditEntries({ entries: four(), ...base({ batchSize: 1 }), adjudicate, control })
    expect(adjudicate).toHaveBeenCalledTimes(1)
  })

  // The caller needs the exact number to report, not an estimate: entries it never
  // attempted must never be counted approvable.
  it('says exactly how many entries it never got to', async () => {
    const control = createRunControl()
    const stopped: number[] = []
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => {
      control.stop()
      return ok(batch)
    })
    await auditEntries({
      entries: four(),
      ...base({ batchSize: 1 }),
      adjudicate,
      control,
      onStopped: (info: { pending: number }) => stopped.push(info.pending),
    })
    expect(stopped).toEqual([3])
  })

  // The breaker stopping a run is a problem worth a report; the person
  // stopping it is not, and only this says which happened.
  it('says the person stopped it when the stop came from the control', async () => {
    const control = createRunControl()
    const reasons: string[] = []
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => {
      control.stop()
      return ok(batch)
    })
    await auditEntries({
      entries: four(),
      ...base({ batchSize: 1 }),
      adjudicate,
      control,
      onStopped: (info: { reason: string }) => reasons.push(info.reason),
    })
    expect(reasons).toEqual(['operator'])
  })

  it('says nothing about stopping on a run that finished', async () => {
    const stopped: number[] = []
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => ok(batch))
    await auditEntries({
      entries: four(),
      ...base({ batchSize: 1 }),
      adjudicate,
      control: createRunControl(),
      onStopped: (info: { pending: number }) => stopped.push(info.pending),
    })
    expect(stopped).toEqual([])
  })

  it('returns only the verdicts it actually decided', async () => {
    const control = createRunControl()
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => {
      control.stop()
      return ok(batch)
    })
    const verdicts = await auditEntries({ entries: four(), ...base({ batchSize: 1 }), adjudicate, control })
    expect(verdicts.map((v) => v.key)).toEqual(['k0'])
  })
})

// Quota does not announce itself. It just starts failing every call, and a run
// that grinds on marks thousands of entries "needs a human look" for a reason
// that has nothing to do with the translations.
describe('auditEntries when the model keeps failing', () => {
  const ten = () => Array.from({ length: 10 }, (_, i) => entry(`k${i}`, `Source ${i}`, `Çeviri ${i}`))
  const ok = (batch: { id: number }[]) => batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' }))

  it('gives up after a run of failures rather than burning the rest of the file', async () => {
    const adjudicate = vi.fn().mockRejectedValue(new Error('claude exited with exit code 1'))
    await auditEntries({ entries: ten(), ...base({ batchSize: 1 }), adjudicate })

    // Three batches, each attempted twice, then it stops. Not ten.
    expect(adjudicate).toHaveBeenCalledTimes(6)
  })

  it('keeps going when a failure is isolated rather than systemic', async () => {
    let call = 0
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => {
      // Only the very first attempt fails; its retry succeeds.
      if (++call === 1) throw new Error('transient')
      return ok(batch)
    })
    await auditEntries({ entries: ten(), ...base({ batchSize: 1 }), adjudicate })

    expect(adjudicate).toHaveBeenCalledTimes(11)
  })

  /**
   * A refusal is retried like anything else, and 0.12.0 was wrong to single it
   * out. The reasoning then was that an agent asked the identical question
   * gives the identical answer, drawn from one batch that reached for a shell
   * on both attempts. It was the wrong lesson from the right observation: that
   * batch wanted to count its entries, which its own content provoked, and the
   * prompt now states the count. What is left is an agent that reaches for a
   * shell on its first turn, before it has read a single entry, on roughly one
   * batch in seven. Nothing about the prompt decides it.
   *
   * Each attempt spawns the CLI afresh, so a retry is a new conversation
   * sampled again rather than a replay, and a refusal costs four seconds
   * before it fails. Skipping the second attempt threw away a hundred entries
   * that the next spawn would most likely have judged.
   */
  it('retries a refusal, because the next spawn is a new conversation', async () => {
    // Built by reading a real denial rather than by hand, so that classifying
    // one again anywhere in the provider fails here rather than passing on a
    // default nobody set.
    let denial: unknown
    try {
      readAgentOutput(
        { stdout: JSON.stringify({ status: 'SUCCESS', structured_output: null, response: '' }), stderr: 'jetski: no output produced — a tool required the "command" permission' },
        { mcpConfigPath: '', provider: 'antigravity' },
      )
    } catch (err) {
      denial = err
    }
    expect(denial).toBeInstanceOf(AgentError)

    const adjudicate = vi.fn().mockRejectedValue(denial)
    await auditEntries({ entries: ten(), ...base({ batchSize: 1 }), adjudicate })

    // Three batches before the streak stops it, each attempted twice.
    expect(adjudicate).toHaveBeenCalledTimes(6)
  })

  it('says which batch to resume after, so the failures are re-attempted', async () => {
    let batches = 0
    const adjudicate = vi.fn().mockImplementation(async (batch: { id: number }[]) => {
      // Five batches land, then the quota wall.
      if (++batches > 5) throw new Error('claude exited with exit code 1')
      return ok(batch)
    })
    const stopped: { pending: number; lastGood: number }[] = []
    await auditEntries({
      entries: ten(),
      ...base({ batchSize: 1 }),
      adjudicate,
      onStopped: (info: { pending: number; lastGood: number }) => {
        stopped.push(info)
      },
    })

    // Resume after batch 5, and treat everything from 6 on as still to do,
    // including the three that failed.
    expect(stopped).toEqual([{ lastGood: 5, pending: 5, reason: 'breaker' }])
  })

  it('counts the whole failed streak as still to do, not as reviewed', async () => {
    const adjudicate = vi.fn().mockRejectedValue(new Error('claude exited with exit code 1'))
    const stopped: { pending: number; lastGood: number }[] = []
    await auditEntries({
      entries: ten(),
      ...base({ batchSize: 1 }),
      adjudicate,
      onStopped: (info: { pending: number; lastGood: number }) => {
        stopped.push(info)
      },
    })

    expect(stopped).toEqual([{ lastGood: 0, pending: 10, reason: 'breaker' }])
  })
})

describe('buildAuditPrompt', () => {
  const candidates = [
    { id: 1, key: 'c', msgid: 'Sidebar', msgstr: ['Yan menü'], comments: [], references: [], hints: [{ rule: 'glossary', severity: 'suspect' as const, message: 'glossary term not used' }] },
    { id: 2, key: 'a', msgid: 'Save all changes', msgstr: ['Tüm değişiklikleri kaydet'], comments: [], references: ['includes/admin-menu.php:42'], hints: [] },
  ]

  it('passes the source references through as the clue to a string\'s role', () => {
    expect(buildAuditPrompt(candidates, 'tr', 2)).toContain('admin-menu.php')
  })

  it('numbers every entry and includes the submitted translation', () => {
    const prompt = buildAuditPrompt(candidates, 'tr', 2)
    expect(prompt).toContain('"id":1')
    expect(prompt).toContain('"id":2')
    expect(prompt).toContain('Yan menü')
  })

  /**
   * A real batch of 100 was lost to this. antigravity pasted all 32KB of it
   * into a python heredoc whose entire body was len(lines), asked for a shell
   * it is not permitted to have, was soft-denied, and produced nothing at all.
   * It had to count because the prompt never told it the number. Saying it
   * costs one line and removes the reason to reach for a tool.
   */
  it('states how many entries there are, so nothing has to count them', () => {
    const prompt = buildAuditPrompt(candidates, 'tr', 2)
    expect(prompt).toContain('2 entries')
    expect(prompt).toMatch(/no shell/i)
  })

  it('passes rule hints through so the model can adjudicate them', () => {
    expect(buildAuditPrompt(candidates, 'tr', 2)).toContain('glossary term not used')
  })

  it('tells the model which proper-noun categories are legitimately capitalized', () => {
    const prompt = buildAuditPrompt(candidates, 'tr', 2)
    expect(prompt).toMatch(/institution/i)
    expect(prompt).toMatch(/place|person/i)
    // A work title (Suç ve Ceza) is correctly title-cased and no rule can tell it
    // from a calque, so the model is the only thing standing between it and a flag.
    expect(prompt).toMatch(/titles of works/i)
  })

  // The locale team tolerates capitalization in menu and screen names and in
  // help-page headings; without this the model flags every one of them.
  // Measured on 11,232 approved core translations: the mirrored arm fires on
  // 0.69% of them, the standalone arm on 2.69%, so they are not equal evidence.
  // Interpolated for German, "German does not use English Title Case" is simply
  // false, so the guidance has to follow the profile rather than the language name.
  it('omits the title-case guidance for a locale whose profile does not run it', () => {
    const prompt = buildAuditPrompt(candidates, 'de', 2)
    expect(prompt).not.toMatch(/does NOT use English Title Case/i)
    expect(prompt).not.toMatch(/mirrors the English source/i)
    expect(prompt).toContain('glossary_lookup')
    expect(prompt).toMatch(/placeholder/i)
  })

  it('keeps the title-case guidance for Turkish', () => {
    expect(buildAuditPrompt(candidates, 'tr', 2)).toMatch(/does NOT use English Title Case/i)
  })

  it('tells the model how much to trust each title-case arm', () => {
    const prompt = buildAuditPrompt(candidates, 'tr', 2)
    expect(prompt).toMatch(/mirrors the English source/i)
    expect(prompt).toMatch(/weaker|weak evidence|less reliable/i)
  })

  it('tells the model not to raise title-case for menu labels and section headings', () => {
    const prompt = buildAuditPrompt(candidates, 'tr', 2)
    expect(prompt).toMatch(/menu label|screen name|section name/i)
    expect(prompt).toMatch(/heading/i)
    expect(prompt).toMatch(/command|button/i)
  })

  it('states the locale team standards and names the lookup tools', () => {
    const prompt = buildAuditPrompt(candidates, 'tr', 2)
    expect(prompt).toMatch(/title case/i)
    expect(prompt).toContain('glossary_lookup')
    expect(prompt).toContain('consistency_lookup')
  })

  // The one check that was already decided mechanically must not be handed over
  // as one that was not: the model would adjudicate a settled repair, and the
  // pre-batch suspect count would include it.
  it('keeps the mechanical repair out of the checks it asks the model to adjudicate', () => {
    const prompt = buildAuditPrompt(
      [
        {
          id: 1,
          key: 'a',
          msgid: 'Save ',
          msgstr: ['Kaydet '],
          comments: [],
          references: [],
          hints: [{ rule: 'repaired', severity: 'suspect' as const, message: 'whitespace restored to match the source' }],
          repaired: { text: ['Kaydet '], repairedBy: 'rules' as const },
        },
      ],
      'tr',
      2,
    )
    expect(prompt).not.toContain('automatedChecks":')
    expect(prompt).toContain('"alreadyRepaired":true')
    expect(prompt).toMatch(/alreadyRepaired.*whitespace/i)
  })

  // The asymmetry is defined in code as severity === 'error'. Naming the rules in
  // prose instead means a new error rule silently stops being treated as settled.
  it('marks a condemned entry in the payload and phrases the instruction off it', () => {
    const prompt = buildAuditPrompt(
      [
        {
          id: 1,
          key: 'b',
          msgid: '%s comments',
          msgstr: ['yorumlar'],
          comments: [],
          references: [],
          hints: [{ rule: 'placeholder', severity: 'error' as const, message: 'lost %s' }],
          condemned: [{ rule: 'placeholder', severity: 'error' as const, message: 'lost %s' }],
        },
      ],
      'tr',
      2,
    )
    expect(prompt).toContain('"condemned":true')
    expect(prompt).toMatch(/"condemned"[\s\S]*already known to be broken/)
    expect(prompt).not.toMatch(/reports a placeholder, html or plural-count problem/)
  })

  it('asks the model for a corrected translation', () => {
    const prompt = buildAuditPrompt(
      [{ id: 1, key: 'a', msgid: 'Save', msgstr: ['Kaydet'], comments: [], references: [], hints: [] }],
      'tr',
      2,
    )
    expect(prompt).toMatch(/"fix"/)
    expect(prompt).toMatch(/leave "fix" out/i)
  })
})

describe('mapAuditResults', () => {
  const candidates = [{ id: 1, key: 'a', msgid: 'x', msgstr: ['y'], comments: [], hints: [] }]

  it('validates and returns the results', () => {
    const out = mapAuditResults(candidates, {
      results: [{ id: 1, problem: true, categories: ['meaning'], reason: 'wrong' }],
    })
    expect(out).toEqual([{ id: 1, problem: true, categories: ['meaning'], reason: 'wrong' }])
  })

  it('throws when an id is missing from the response', () => {
    expect(() => mapAuditResults(candidates, { results: [] })).toThrow(/missing/i)
  })

  it('throws when the payload does not match the schema', () => {
    expect(() => mapAuditResults(candidates, { results: [{ id: 1 }] })).toThrow(/schema/i)
  })

  it('throws on an id outside the batch', () => {
    expect(() =>
      mapAuditResults(candidates, { results: [{ id: 9, problem: false, categories: [], reason: 'x' }] }),
    ).toThrow(/unknown id 9/)
  })

  it('carries a proposed fix through', () => {
    const payload = { results: [{ id: 1, problem: true, categories: ['placeholder'], reason: 'x', fix: ['%s yorum'] }] }
    expect(mapAuditResults([{ id: 1, key: 'a' }], payload)[0]).toMatchObject({ fix: ['%s yorum'] })
  })

  // Declining is a first-class answer, not a malformed response.
  it('accepts a result with no fix at all', () => {
    const payload = { results: [{ id: 1, problem: true, categories: ['meaning'], reason: 'x' }] }
    expect(mapAuditResults([{ id: 1, key: 'a' }], payload)[0]?.fix).toBeUndefined()
  })

  it('rejects a fix that is not an array of strings', () => {
    const payload = { results: [{ id: 1, problem: true, categories: [], reason: 'x', fix: 'just a string' }] }
    expect(() => mapAuditResults([{ id: 1, key: 'a' }], payload)).toThrow(/schema validation/)
  })
})

/**
 * The memory used to inform the model and never replace it: every entry went
 * to a batch whatever the memory already said. On a real theme that sent the
 * model 244 of 1,359 entries whose answer was sitting on disk, either
 * approved word for word or approved in Turkish where the contributor had
 * left English.
 */
describe('auditEntries deciding from the memory', () => {
  const ok = (batch: { id: number }[]) => batch.map((c) => ({ id: c.id, problem: false, categories: [], reason: 'ok' }))
  const memoryOf = (pairs: [string, string][]) => new Map(pairs.map(([s, t]) => [tmKey(s), [t]]))
  const exactFor = (sources: string[]) => new Set(sources.map((s) => tmKey(s)))

  it('never sends an entry identical to its approved translation to the model', async () => {
    const adjudicate = vi.fn(async (batch: { id: number; key: string }[]) => ok(batch))
    const verdicts = await auditEntries({
      entries: [entry('a', 'Font Size', 'Yazı Tipi Boyutu'), entry('b', 'Save all changes', 'Tüm değişiklikleri kaydet')],
      ...base(),
      tm: memoryOf([['Font Size', 'Yazı Tipi Boyutu']]),
      memoryExact: exactFor(['Font Size']),
      adjudicate,
    })

    const sent = adjudicate.mock.calls.flatMap(([batch]) => batch.map((c) => c.key))
    expect(sent).toEqual(['b'])
    expect(verdicts.find((v) => v.key === 'a')).toMatchObject({ problem: false })
  })

  /**
   * An approved translation outranks a suspect rule: the title-case and
   * untranslated hits on an identical match were every one of them a label or
   * a brand the locale had already approved as written. It does not outrank
   * an error, which is a rule having proved the text broken.
   */
  it('lets the approval overrule a suspect rule, but not an error', async () => {
    const adjudicate = vi.fn(async (batch: { id: number; key: string }[]) => ok(batch))
    await auditEntries({
      entries: [entry('label', 'Font Size', 'Yazı Tipi Boyutu'), entry('broken', '%s comments', 'yorumlar')],
      ...base(),
      tm: memoryOf([
        ['Font Size', 'Yazı Tipi Boyutu'],
        ['%s comments', 'yorumlar'],
      ]),
      memoryExact: exactFor(['Font Size', '%s comments']),
      adjudicate,
    })

    const sent = adjudicate.mock.calls.flatMap(([batch]) => batch.map((c) => c.key))
    expect(sent).toEqual(['broken'])
  })

  it('repairs an entry left in English without asking the model', async () => {
    const adjudicate = vi.fn(async (batch: { id: number; key: string }[]) => ok(batch))
    const verdicts = await auditEntries({
      entries: [entry('a', 'Large', 'Large')],
      ...base(),
      tm: memoryOf([['Large', 'Geniş']]),
      memoryExact: exactFor(['Large']),
      adjudicate,
    })

    expect(adjudicate).not.toHaveBeenCalled()
    expect(verdicts[0]).toMatchObject({ problem: true, text: ['Geniş'], repairedBy: 'memory' })
  })

  // Approved as written: the contributor's capitals are kept, not replaced
  // with the memory's, because either is acceptable.
  it('approves a difference of case as written, without the model', async () => {
    const adjudicate = vi.fn(async (batch: { id: number; key: string }[]) => ok(batch))
    const verdicts = await auditEntries({
      entries: [entry('a', 'Hide Details', 'Ayrıntıları Gizle')],
      ...base(),
      tm: memoryOf([['Hide Details', 'Ayrıntıları gizle']]),
      memoryExact: exactFor(['Hide Details']),
      adjudicate,
    })

    expect(adjudicate).not.toHaveBeenCalled()
    expect(verdicts[0]).toMatchObject({ problem: false })
    expect(verdicts[0]!.text).toBeUndefined()
  })

  // The memory is still in the map for the prompt; only the decision needs
  // the context to have matched.
  it('decides nothing from a match that was not found under its own context', async () => {
    const adjudicate = vi.fn(async (batch: { id: number; key: string }[]) => ok(batch))
    await auditEntries({
      entries: [entry('a', 'Font Size', 'Yazı Tipi Boyutu')],
      ...base(),
      tm: memoryOf([['Font Size', 'Yazı Tipi Boyutu']]),
      memoryExact: new Set(),
      adjudicate,
    })

    expect(adjudicate).toHaveBeenCalledTimes(1)
  })

  // Said where the rules report their own counts, so a run that sends fewer
  // batches than its size suggests says why.
  it('reports how many the memory settled', async () => {
    const onRules = vi.fn()
    await auditEntries({
      entries: [entry('a', 'Font Size', 'Yazı Tipi Boyutu'), entry('b', 'Large', 'Large')],
      ...base({ noAi: true }),
      tm: memoryOf([
        ['Font Size', 'Yazı Tipi Boyutu'],
        ['Large', 'Geniş'],
      ]),
      memoryExact: exactFor(['Font Size', 'Large']),
      onRules,
    })

    expect(onRules).toHaveBeenCalledWith(expect.objectContaining({ memoryApproved: 1, memoryRepaired: 1 }))
  })
})
