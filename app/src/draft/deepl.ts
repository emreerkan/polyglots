import { DeepLClient, QuotaExceededError, TooManyRequestsError } from 'deepl-node'
import { splitLocale } from '../wporg/locales.js'
import type { SourceLanguageCode, TargetLanguageCode, TranslateTextOptions } from 'deepl-node'
import { chunk } from '../batch.js'
import type { DraftEngine, DraftResult, Locale, TranslationUnit } from '../types.js'
import { DraftQuotaError, DraftRateLimitError } from './errors.js'
import { warnMissingPlaceholders, type WarningSink } from './placeholders.js'
import { formalityOf } from './prompt.js'

export interface DeepLClientLike {
  translateText(
    texts: string[],
    sourceLang: SourceLanguageCode | null,
    targetLang: TargetLanguageCode,
    options?: TranslateTextOptions,
  ): Promise<ReadonlyArray<{ readonly text: string }>>
}

export interface DeepLEngineOptions {
  apiKey: string
  client?: DeepLClientLike
  onWarning?: WarningSink
}

// DeepL's /v2/translate accepts at most 50 `text` parameters per request.
export const DEEPL_MAX_TEXTS_PER_REQUEST = 50

// DeepL rejects a region on every target except these families, and rejects the bare en/pt/zh codes.
export function toDeepLTarget(locale: Locale): TargetLanguageCode {
  // The slug only: nl/formal asks DeepL for nl, with the register as an option.
  const [lang = '', region] = splitLocale(locale).slug.toLowerCase().split(/[-_]/, 2)
  switch (lang) {
    case 'en':
      return region === 'us' || region === undefined ? 'en-US' : 'en-GB'
    case 'pt':
      return region === 'br' ? 'pt-BR' : 'pt-PT'
    case 'zh':
      return region === 'tw' || region === 'hk' || region === 'mo' || region === 'hant' ? 'zh-HANT' : 'zh-HANS'
    case 'es':
      return region === undefined || region === 'es' ? 'es' : 'es-419'
    default:
      return lang as TargetLanguageCode
  }
}

function mapDeepLError(err: unknown): unknown {
  if (err instanceof QuotaExceededError) return new DraftQuotaError('deepl', err.message, err)
  if (err instanceof TooManyRequestsError) return new DraftRateLimitError('deepl', err.message, err)
  return err
}

export function createDeepLEngine(opts: DeepLEngineOptions): DraftEngine {
  const client: DeepLClientLike = opts.client ?? new DeepLClient(opts.apiKey)

  return {
    name: 'deepl',
    async translate(units: TranslationUnit[], locale: Locale, nplurals: number): Promise<DraftResult[]> {
      if (units.length === 0) return []

      const texts = units.flatMap((u) => (u.msgidPlural === undefined ? [u.msgid] : [u.msgid, u.msgidPlural]))
      const target = toDeepLTarget(locale)
      // The rules file's formality, or a formal or informal set when the file
      // says nothing, is exactly what DeepL's formality option is for. "prefer_"
      // so a language DeepL has no formality for still works rather than
      // failing the batch. The draft cache needs nothing extra for this: a
      // file formality also adds a line to draftSystemPrompt, which is what
      // draftConfigHash hashes, so changing it prunes DeepL drafts too.
      const f = formalityOf(locale)
      const options: TranslateTextOptions = {
        preserveFormatting: true,
        ...(f === 'formal' ? { formality: 'prefer_more' as const } : f === 'informal' ? { formality: 'prefer_less' as const } : {}),
      }

      const translated: string[] = []
      for (const part of chunk(texts, DEEPL_MAX_TEXTS_PER_REQUEST)) {
        let out: ReadonlyArray<{ readonly text: string }>
        try {
          out = await client.translateText(part, 'en', target, options)
        } catch (err) {
          throw mapDeepLError(err)
        }
        if (out.length !== part.length) {
          throw new Error(`deepl: expected ${part.length} translations, got ${out.length}`)
        }
        for (const t of out) translated.push(t.text)
      }

      let i = 0
      return units.map((u) => {
        const singular = translated[i++]!
        warnMissingPlaceholders('deepl', u.key, u.msgid, singular, opts.onWarning)
        if (u.msgidPlural === undefined) return { key: u.key, drafts: [singular] }

        const plural = translated[i++]!
        warnMissingPlaceholders('deepl', u.key, u.msgidPlural, plural, opts.onWarning)
        const drafts = [singular, ...Array.from({ length: Math.max(nplurals - 1, 0) }, () => plural)]
        return { key: u.key, drafts }
      })
    },
  }
}
