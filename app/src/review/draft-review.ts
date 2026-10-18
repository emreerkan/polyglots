import type { Locale, ReviewInput, ReviewResult } from '../types.js'
import { matchSourceEscaping } from '../po/escapes.js'
import {
  AgentError,
  MCP_TOOLS,
  buildAgentArgs as buildArgs,
  childEnv,
  readAgentOutput,
  spawnAgent,
  type AgentRunOptions,
} from '../agent/run.js'
import { buildReviewPrompt } from './prompt.js'
import { reviewBatchJsonSchema, reviewBatchSchema } from './schema.js'
import { excerpt } from '../logs/excerpt.js'

export const REVIEW_ALLOWED_TOOLS = MCP_TOOLS

export { childEnv }

export interface ReviewOptions extends AgentRunOptions {
  locale: Locale
  nplurals: number
  // The catalogue's Plural-Forms header, only above two forms.
  pluralForms?: string
}

export class ReviewError extends Error {
  override readonly name = 'ReviewError'
  readonly stderr: string
  readonly missingKeys: string[]

  constructor(message: string, details: { stderr?: string; missingKeys?: string[] } = {}) {
    super(message)
    this.stderr = details.stderr ?? ''
    this.missingKeys = details.missingKeys ?? []
  }
}

export function buildReviewArgs(opts: ReviewOptions): string[] {
  return buildArgs(reviewBatchJsonSchema, opts)
}

// Results are matched by the 1-based id assigned in the prompt, so the model
// never has to echo a gettext key (msgctxt keys contain \x04).
export function mapResults(inputs: ReviewInput[], payload: unknown, nplurals: number): ReviewResult[] {
  const parsed = reviewBatchSchema.safeParse(payload)
  if (!parsed.success) {
    throw new ReviewError(`agent output failed schema validation: ${excerpt(parsed.error.message, 500)}`)
  }

  const byId = new Map<number, (typeof parsed.data.results)[number]>()
  for (const result of parsed.data.results) {
    if (result.id > inputs.length || result.id < 1) {
      throw new ReviewError(`agent output has unknown id ${result.id} for a batch of ${inputs.length}`)
    }
    if (byId.has(result.id)) throw new ReviewError(`agent output has a duplicate id ${result.id}`)
    byId.set(result.id, result)
  }

  const missingKeys = inputs.filter((_, i) => !byId.has(i + 1)).map((input) => input.key)
  if (missingKeys.length > 0) {
    throw new ReviewError(`agent output is missing ${missingKeys.map((k) => JSON.stringify(k)).join(', ')}`, {
      missingKeys,
    })
  }

  return inputs.map((input, i) => {
    const raw = byId.get(i + 1)!
    const expected = input.msgidPlural === undefined ? 1 : nplurals
    // The agent sometimes returns the file's spelling of a quote rather than
    // the string's, leaving a backslash that belongs to nobody. The source is
    // the one text nobody retyped, so it decides.
    const source = `${input.msgid}${input.msgidPlural ?? ''}`
    const text = raw.text.map((form) => matchSourceEscaping(source, form))
    const result: ReviewResult = { key: input.key, text, fuzzy: raw.fuzzy, reason: raw.reason }
    if (result.text.length !== expected) {
      throw new ReviewError(
        `agent output for key ${JSON.stringify(input.key)} has ${result.text.length} text forms, expected ${expected}`,
      )
    }
    return result
  })
}

export async function reviewBatch(inputs: ReviewInput[], opts: ReviewOptions): Promise<ReviewResult[]> {
  if (inputs.length === 0) return []
  const prompt = buildReviewPrompt(inputs, opts.locale, opts.nplurals, opts.pluralForms)
  try {
    const output = await spawnAgent(buildReviewArgs(opts), prompt, opts)
    return mapResults(inputs, readAgentOutput(output, opts), opts.nplurals)
  } catch (err) {
    if (err instanceof AgentError) throw new ReviewError(err.message, { stderr: err.stderr })
    throw err
  }
}
