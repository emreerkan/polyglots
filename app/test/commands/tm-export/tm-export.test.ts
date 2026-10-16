import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDb, upsertTm, findMemory } from '../../../src/storage/index.js'
import { exportTm } from '../../../src/commands/tm-export.js'
import { importTmx } from '../../../src/commands/tm-import.js'

describe('exportTm', () => {
  let home: string
  let db: Database.Database

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'polyglots-tm-export-'))
    db = openDb(join(home, 'polyglots.db'))
    upsertTm(db, [
      { source: 'Publish', target: 'Yayımla', locale: 'tr' },
      { source: 'Publish', target: 'Yayınla', locale: 'tr' },
      { source: 'Draft', target: 'Taslak', locale: 'tr', context: 'post status' },
      { source: 'Tools & tips', target: 'Araçlar ve ipuçları', locale: 'tr' },
      { source: 'Only German', target: 'Nur Deutsch', locale: 'de' },
    ])
  })

  afterEach(async () => {
    db.close()
    await rm(home, { recursive: true, force: true })
  })

  it('writes every wording to TMX, alternatives included', async () => {
    const file = join(home, 'memory.tmx')
    const result = await exportTm({ locale: 'tr', file, db })

    expect(result.entries).toBe(4)
    expect(result.dropped).toBe(0)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('<seg>Yayımla</seg>')
    expect(text).toContain('<seg>Yayınla</seg>')
    // The other locale is not this export's business.
    expect(text).not.toContain('Nur Deutsch')
  })

  it('escapes what XML cannot carry raw', async () => {
    const file = join(home, 'memory.tmx')
    await exportTm({ locale: 'tr', file, db })
    const text = await readFile(file, 'utf8')

    expect(text).toContain('Tools &amp; tips')
    expect(text).not.toMatch(/<seg>[^<]*&(?!amp;|lt;|gt;)/)
  })

  /**
   * A `.po` keys its entries by source and context, so it cannot hold two
   * translations of one source. The memory has 9,900 sources that do. The most
   * recent wins and the export says how many it had to drop, rather than
   * writing a file that silently holds less than it was asked for.
   */
  it('collapses alternatives for .po and reports how many it dropped', async () => {
    const file = join(home, 'memory.po')
    const result = await exportTm({ locale: 'tr', file, db })

    expect(result.entries).toBe(3)
    expect(result.dropped).toBe(1)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('msgid "Publish"')
    expect((text.match(/msgid "Publish"/g) ?? []).length).toBe(1)
    expect(text).toContain('msgctxt "post status"')
  })

  it('takes the format from the file name, and an explicit one wins', async () => {
    const asPo = join(home, 'named.po')
    await exportTm({ locale: 'tr', file: asPo, db })
    expect(await readFile(asPo, 'utf8')).toContain('msgid')

    const stillTmx = join(home, 'named2.po')
    await exportTm({ locale: 'tr', file: stillTmx, format: 'tmx', db })
    expect(await readFile(stillTmx, 'utf8')).toContain('<tmx')
  })

  // The pair has to survive a trip through both halves of the tool.
  it('round-trips through the importer', async () => {
    const file = join(home, 'memory.tmx')
    await exportTm({ locale: 'tr', file, db })

    const other = openDb(join(home, 'second.db'))
    try {
      await importTmx([file], { locale: 'tr', db: other })
      expect(findMemory(other, 'Publish', 'tr').map((e) => e.target).sort()).toEqual(['Yayımla', 'Yayınla'])
      expect(findMemory(other, 'Draft', 'tr', 'post status').map((e) => e.target)).toEqual(['Taslak'])
    } finally {
      other.close()
    }
  })

  /**
   * Weight, project and context are what the memory ranks and scopes by. An
   * export that left them off turned every long-text row normal on the way
   * back in, and filed every scoped row context-less, which the context
   * fallback in findMemory then hid from the round-trip test above.
   */
  it('keeps weight, project and context through an export and import', async () => {
    upsertTm(db, [
      { source: 'Readme line', target: 'Benioku satırı', locale: 'tr', weight: 'low', project: 'akismet' },
      { source: 'Normal line', target: 'Olağan satır', locale: 'tr', project: 'jetpack' },
    ])
    const file = join(home, 'memory.tmx')
    await exportTm({ locale: 'tr', file, db })

    const other = openDb(join(home, 'third.db'))
    try {
      await importTmx([file], { locale: 'tr', db: other })
      const rows = other
        .prepare<[], { source: string; context: string; project: string | null; weight: number }>(
          `SELECT source, context, project, weight FROM tm WHERE source IN ('Readme line', 'Normal line', 'Draft') ORDER BY source`,
        )
        .all()
      expect(rows).toEqual([
        { source: 'Draft', context: 'post status', project: null, weight: 1 },
        { source: 'Normal line', context: '', project: 'jetpack', weight: 1 },
        { source: 'Readme line', context: '', project: 'akismet', weight: 0 },
      ])
    } finally {
      other.close()
    }
  })

  it('returns the text without a file when none is named', async () => {
    const result = await exportTm({ locale: 'tr', db })
    expect(result.file).toBeUndefined()
    expect(result.text).toContain('<tmx')
  })
})
