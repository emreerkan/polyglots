import type { ReviewChoice } from '../types.js'

// The review providers the setup wizard can offer, as data. A row is
// everything the wizard says about one, so adding a provider is a row here
// plus its discovery, not a change to any screen. codex is a row now.
//
// Only providers the tool can actually drive belong here. The wizard filters
// these down further to what discovery found installed and signed in.

export interface ProviderOption {
  id: ReviewChoice
  label: string
  // What using it costs, said plainly, because the person choosing is about
  // to spend it on every review.
  cost: string
  // Agents are offered when discovery says they are usable; the local
  // reviewer when a local model server answers; no AI always, since there is
  // nothing for it to find.
  needs: 'agent' | 'local-server' | 'nothing'
}

export const REVIEW_PROVIDERS: readonly ProviderOption[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    cost: 'Uses your Claude subscription or API credits.',
    needs: 'agent',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    cost: "Uses your Google account's Antigravity quota.",
    needs: 'agent',
  },
  {
    id: 'codex',
    label: 'Codex',
    cost: "Uses your ChatGPT plan's Codex limits.",
    needs: 'agent',
  },
  {
    id: 'local',
    label: 'Local model (experimental)',
    cost: 'Free; runs on this machine, slower, and less thorough than an agent.',
    needs: 'local-server',
  },
  // Last, so enter on the first row still picks an agent for everyone who has
  // one. The cost line says what is given up, because the person choosing it
  // should know the rules are a floor, not a reviewer.
  {
    id: 'none',
    label: 'No AI',
    cost: 'Free; nothing leaves this machine but wp.org lookups. Runs the rules only: meaning and tone are yours to judge.',
    needs: 'nothing',
  },
]

export interface DraftEngineOption {
  id: 'deepl' | 'openai' | 'local' | 'none'
  label: string
  cost: string
}

export const DRAFT_ENGINES: readonly DraftEngineOption[] = [
  { id: 'deepl', label: 'DeepL', cost: 'Needs a DeepL API key. New free accounts get 1M characters once; older ones keep 500k a month.' },
  { id: 'openai', label: 'OpenAI', cost: 'Needs an OpenAI API key, billed per token.' },
  { id: 'local', label: 'Local model', cost: 'Free; drafts with the model on your local server.' },
  {
    id: 'none',
    label: 'Translation memory only',
    cost: 'Free; fills what your memory already holds and leaves the rest untranslated for you.',
  },
]
