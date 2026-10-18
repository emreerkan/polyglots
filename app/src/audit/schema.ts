import { z } from 'zod'
import { excerpt } from '../logs/excerpt.js'

export const AUDIT_CATEGORIES = [
  'meaning',
  'glossary',
  'title-case',
  'register',
  'fluency',
  'placeholder',
  'other',
] as const

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]

export const auditBatchJsonSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          problem: { type: 'boolean' },
          // Empty for a clean entry, which is most of them: the prompt asks for
          // that, so the schema has to allow it. A flagged entry is guaranteed
          // something readable to write by readableNotes, not by a minItems here.
          categories: { type: 'array', items: { type: 'string', enum: [...AUDIT_CATEGORIES] } },
          reason: { type: 'string' },
          // Only in the JSON schema, which steers one result. The zod schema stays
          // permissive on purpose: rejecting there fails the whole batch and marks
          // every entry in it unreviewed over one malformed result.
          fix: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
        required: ['id', 'problem', 'categories', 'reason'],
      },
    },
  },
  required: ['results'],
} as const

export const auditBatchSchema = z.object({
  results: z.array(
    z.object({
      id: z.number().int().min(1),
      problem: z.boolean(),
      categories: z.array(z.enum(AUDIT_CATEGORIES)),
      reason: z.string(),
      fix: z.array(z.string()).min(1).optional(),
    }),
  ),
})

export type AuditResult = z.infer<typeof auditBatchSchema>['results'][number]

export class AuditError extends Error {
  override readonly name = 'AuditError'
}

export interface AuditCandidateId {
  id: number
  key: string
}

export function mapAuditResults(candidates: AuditCandidateId[], payload: unknown): AuditResult[] {
  const parsed = auditBatchSchema.safeParse(payload)
  if (!parsed.success) {
    throw new AuditError(`claude output failed schema validation: ${excerpt(parsed.error.message, 500)}`)
  }

  const byId = new Map<number, AuditResult>()
  for (const result of parsed.data.results) {
    if (!candidates.some((c) => c.id === result.id)) {
      throw new AuditError(`claude output has unknown id ${result.id} for a batch of ${candidates.length}`)
    }
    if (byId.has(result.id)) throw new AuditError(`claude output has a duplicate id ${result.id}`)
    byId.set(result.id, result)
  }

  const missing = candidates.filter((c) => !byId.has(c.id)).map((c) => c.key)
  if (missing.length > 0) {
    throw new AuditError(`claude output is missing ${missing.map((k) => JSON.stringify(k)).join(', ')}`)
  }

  return candidates.map((c) => byId.get(c.id)!)
}
