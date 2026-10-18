// The menu tree as data. One definition drives the home cards, the Tools and
// Configuration submenus, the hotkeys, the command palette, the help overlay
// and the help page, so none of them can disagree about what a key does or
// what a screen is called. The list this replaced was JSX, and adding an item
// meant editing the menu, its tests' hop counts and the hint line separately.

/** Every screen the app can show. Leaves of the tree, plus the two submenus. */
export type ScreenId =
  | 'home'
  | 'translate'
  | 'review'
  | 'fetch'
  | 'stats'
  | 'tools'
  | 'config'
  | 'help'
  | 'about'
  | 'split'
  | 'import-tm'
  | 'export-tm'
  | 'sync-glossary'
  | 'locale-rules'
  | 'reply-templates'
  | 'agents'
  | 'local-models'
  | 'configure-keys'
  | 'setup'
  | 'interface'
  | 'usage-stats'

export interface MenuNode {
  id: ScreenId
  key: string
  label: string
  description: string
  // Three columns, one line. The ASCII twin is what a terminal without
  // Unicode gets, chosen per node rather than by substitution so each still
  // reads as a picture of the thing.
  icon: string
  asciiIcon: string
  // What the screen is for, in a sentence or two: the top of its `?` overlay
  // and its entry on the help page.
  help: string
  children?: MenuNode[]
}

export const TOOLS: MenuNode[] = [
  {
    id: 'split',
    key: 's',
    label: 'Split a .po into parts',
    description: 'Cut a large catalogue into chunks',
    icon: '<|>',
    asciiIcon: '<|>',
    help: 'Splits one .po file into parts of a fixed number of entries, so a long catalogue can be reviewed or shared in pieces.',
  },
  {
    id: 'import-tm',
    key: 'i',
    label: 'Import Translation Memory',
    description: 'Load .tmx or .po files into memory',
    icon: '→db',
    asciiIcon: '>db',
    help: "Imports approved translations from .tmx or .po files, or fetches the locale's published memory from polyglots-data, into the translation memory that drafts and reviews read from.",
  },
  {
    id: 'export-tm',
    key: 'e',
    label: 'Export Translation Memory',
    description: 'Write the memory out as .tmx or .po',
    icon: 'db→',
    asciiIcon: 'db>',
    help: 'Exports the translation memory for a locale as .tmx or .po, to back it up or share it.',
  },
]

export const CONFIGURATION: MenuNode[] = [
  {
    id: 'sync-glossary',
    key: 'g',
    label: 'Sync WordPress.org glossary',
    description: 'Fetch the locale glossary',
    icon: '[≡]',
    asciiIcon: '[=]',
    help: "Downloads the locale's glossary from translate.wordpress.org. Reviews check terms against it and drafts follow it.",
  },
  {
    id: 'locale-rules',
    key: 'r',
    label: 'Locale rules',
    description: 'Rules, nouns, mistakes, guidance',
    icon: '§§§',
    asciiIcon: '$$$',
    help: "Edits the locale's rules file: which built-in checks run, proper nouns, common mistakes, patterns and guidance for the reviewer.",
  },
  {
    id: 'reply-templates',
    key: 't',
    label: 'Reply templates',
    description: 'The comment posted on a PTE request',
    icon: '«@»',
    asciiIcon: '<@>',
    help: "Creates, previews and deletes the locale's reply templates: the whole comment posted back on a PTE request, filled in after every review with the requester, the verdict and the message for the requester.",
  },
  {
    id: 'agents',
    key: 'a',
    label: 'Check AI agents',
    description: 'Which review agents are ready',
    icon: '[✓]',
    asciiIcon: '[+]',
    help: 'Checks each review agent: installed, signed in and set up for polyglots. r re-checks.',
  },
  {
    id: 'local-models',
    key: 'm',
    label: 'Local models',
    description: 'Ollama and OpenAI-compatible servers',
    icon: '[▣]',
    asciiIcon: '[#]',
    help: 'Finds local model servers, picks the drafting model and checks that it is installed.',
  },
  {
    id: 'configure-keys',
    key: 'k',
    label: 'Configure API keys',
    description: 'DeepL and OpenAI keys',
    icon: 'o-┐',
    asciiIcon: 'o-+',
    help: 'Stores the DeepL and OpenAI keys used for machine drafts. A key set in the environment wins over a saved one.',
  },
  {
    id: 'setup',
    key: 'w',
    label: 'Setup wizard',
    description: 'Locale, provider, keys, glossary, rules',
    icon: '1›5',
    asciiIcon: '1>5',
    help: 'Walks through the six setup steps. Each can be skipped, and the wizard can be run again at any time.',
  },
  {
    id: 'interface',
    key: 'i',
    label: 'Interface settings',
    description: 'How this app behaves',
    icon: '[~]',
    asciiIcon: '[*]',
    help: 'Settings that belong to the interactive app only, kept apart from the config the CLI reads.',
  },
  {
    id: 'usage-stats',
    key: 'u',
    label: 'Usage statistics',
    description: 'Opt-in anonymous totals',
    icon: '(Σ)',
    asciiIcon: '(S)',
    help: 'Turns the weekly anonymous totals for the website on or off, and shows exactly what would be sent. Off unless turned on; DO_NOT_TRACK keeps it off.',
  },
]

export const HOME: MenuNode[] = [
  // Review first: it has focus when the app opens, and reviewing submissions
  // is what the app is for.
  {
    id: 'review',
    key: 'r',
    label: 'Review a submitted .po',
    description: 'Rules plus your review agent',
    icon: '[✓]',
    asciiIcon: '[+]',
    help: 'Checks a submitted catalogue with the locale rules and the review agent, repairs what it can and writes the problems to a file. Mark several files with space to review them as one batch.',
  },
  {
    id: 'translate',
    key: 't',
    label: 'Translate a .po file',
    description: 'Draft with memory, glossary and MT',
    icon: 'a→b',
    asciiIcon: 'a>b',
    help: 'Fills untranslated entries from the translation memory first, then machine drafts, and marks the drafts fuzzy for a human to check. Mark several files with space to translate them as one batch.',
  },
  {
    id: 'fetch',
    key: 'f',
    label: 'Fetch from translate.wordpress.org',
    description: 'Waiting strings, by project',
    icon: '↓wp',
    asciiIcon: 'vwp',
    help: 'Downloads catalogues from translate.wordpress.org for a list of projects, filtered by status, and can review them as they arrive.',
  },
  {
    id: 'stats',
    key: 's',
    label: 'Review statistics',
    description: 'Open the stats page locally',
    icon: '▁▃▅',
    asciiIcon: '_-=',
    help: 'Serves the review statistics page from this machine while the app runs, and can write a standalone copy.',
  },
  {
    id: 'tools',
    key: 'o',
    label: 'Tools',
    description: 'Split, import and export TM',
    icon: '{ }',
    asciiIcon: '{ }',
    help: 'Splitting catalogues and moving translation memory in and out.',
    children: TOOLS,
  },
  {
    id: 'config',
    key: 'c',
    label: 'Configuration',
    description: 'Glossary, rules, agents, keys',
    icon: '[≡]',
    asciiIcon: '[=]',
    help: 'Glossary, locale rules, reply templates, agents, local models, API keys, setup, interface settings and usage statistics.',
    children: CONFIGURATION,
  },
  {
    id: 'help',
    key: 'h',
    label: 'Help',
    description: 'Every key, every screen',
    icon: '(?)',
    asciiIcon: '(?)',
    help: 'Every screen and every key, in one place.',
  },
  {
    id: 'about',
    key: 'a',
    label: 'About',
    description: 'Version, paths and links',
    icon: '(i)',
    asciiIcon: '(i)',
    help: 'Version, where polyglots keeps its files, and where to read more.',
  },
]

// Keys a menu level may not bind, because the frame or the home screen
// already does: `?` help, `:` palette, `l` locale, `q` back or quit, `p`
// provider on home, `x` stop stats.
export const RESERVED_KEYS: readonly string[] = ['?', ':', 'l', 'q', 'p', 'x']

/** Every node in the tree, depth first, with the path of keys that reaches it. */
export function walk(nodes: MenuNode[] = HOME, path: string[] = []): Array<{ node: MenuNode; keys: string[]; parent?: MenuNode }> {
  return nodes.flatMap((node) => [
    { node, keys: [...path, node.key] },
    ...(node.children ? walk(node.children, [...path, node.key]).map((e) => ({ ...e, parent: e.parent ?? node })) : []),
  ])
}

export function findNode(id: ScreenId): MenuNode | undefined {
  return walk().find((e) => e.node.id === id)?.node
}

/** The submenu a screen belongs to, so back from Split lands on Tools rather than home. */
export function parentOf(id: ScreenId): ScreenId {
  return walk().find((e) => e.node.id === id)?.parent?.id ?? 'home'
}
