import type { Key } from './input.js'
import type { ScreenId } from './menu.js'

// The one table of keys. The footer, the `?` overlay and the help page read
// it, and every listener in the TUI binds through it: useKeys takes handlers
// keyed by the ids below, so a handler for a key the table does not have, or
// a table entry with no handler, fails typecheck. A test holds every file to
// binding through useKeys and checks that what each screen binds is what its
// listing shows.
//
// The table used to be documentation only, written beside the bindings. It
// drifted the way documentation does: import-tm advertised a space key that
// nothing bound, export-tm showed another screen's form keys, and the stats
// screen's s, the file picker's s and the help page's paging were bound and
// listed nowhere.
//
// Entries are grouped by the listener that binds them, not by screen. A group
// is matched in the order written here, first match with a live handler wins,
// and the screens choose which groups appear in their listing below.

export type Match = (input: string, key: Key) => boolean

/** A key answered by a listener, which must hand useKeys a handler for it. */
export interface BoundKey {
  keys: string
  does: string
  match: Match
}

/**
 * A key a text field or list widget answers on its own, through its submit
 * or select callback. Listed so the hints tell the whole story, but there is
 * no listener of ours to bind it.
 */
export interface WidgetKey {
  keys: string
  does: string
  widget: true
}

export type KeyEntry = BoundKey | WidgetKey

export interface KeyHelp {
  keys: string
  does: string
}

// Letters are matched without ctrl or meta, so ctrl+c, ctrl+d and ctrl+k never
// also count as c, d or k on whatever screen is open.
const plain = (key: Key) => !key.ctrl && !key.meta
const char =
  (...chars: string[]): Match =>
  (input, key) =>
    plain(key) && chars.includes(input)
const any =
  (...matches: Match[]): Match =>
  (input, key) =>
    matches.some((m) => m(input, key))
const esc: Match = (_i, key) => key.escape
const enter: Match = (_i, key) => key.return
const tab: Match = (_i, key) => key.tab
const up: Match = (_i, key) => key.upArrow
const down: Match = (_i, key) => key.downArrow
const left: Match = (_i, key) => key.leftArrow
const right: Match = (_i, key) => key.rightArrow
const space = char(' ')
const vertical = any(up, down)
const horizontal = any(left, right)
const arrows = any(vertical, horizontal)
const erase: Match = (_i, key) => key.backspace || key.delete
// Typed text, pasted chunks included. The keys above report an empty input,
// so this never takes an arrow, a tab or enter.
const printable: Match = (input, key) => input !== '' && plain(key)

const widget = (keys: string, does: string): WidgetKey => ({ keys, does, widget: true })

export const KEYS = {
  // The frame's own, heard over overlays and under a closed gate.
  global: {
    quit: { keys: 'ctrl+c', does: 'quit, asking first while a run is going', match: (input, key) => key.ctrl && input === 'c' },
    palette: { keys: 'ctrl+k  :', does: 'go to any screen', match: (input, key) => (key.ctrl && input === 'k') || char(':')(input, key) },
    help: { keys: '?', does: 'help for this screen', match: char('?') },
    locale: { keys: 'l', does: 'change the locale', match: char('l') },
    stopStats: { keys: 'x', does: 'stop the stats server while it serves', match: char('x') },
    scroll: { keys: 'pgup pgdn', does: 'scroll a screen taller than the window', match: (_input, key) => key.pageUp || key.pageDown },
  },
  // q is "leave": back one level on every screen, quit on home, and stop on
  // a run, which is the CLI's q too.
  back: {
    esc: { keys: 'esc', does: 'back', match: esc },
    q: { keys: 'q', does: 'back; quits from home; stops a run', match: char('q') },
  },
  // Enter once a one-shot job has finished, or failed and can be retried.
  finished: {
    close: { keys: 'enter', does: 'back to the menu once it is done', match: enter },
  },
  // On a finished or stopped review or translation: the next file, from the
  // same folder, with the choices just made. Its own group rather than a second
  // id under finished, because every screen that binds finished would then
  // have to answer a key that means nothing on a one-shot job.
  another: {
    file: { keys: 'a', does: 'another file with the same settings', match: char('a') },
  },
  // The problem report offered under a finished run that had a problem, on
  // review, translate and a batch's summary. Bound only while the offer is on
  // screen, so s and v mean nothing on a finished screen without one. esc is
  // the offer's while it shows, and the screen's way back again once the offer
  // is answered or dismissed.
  problemReport: {
    send: { keys: 's', does: 'after a run with a problem: send a problem report', match: char('s') },
    see: { keys: 'v', does: 'see what a problem report sends', match: char('v') },
    dismiss: { keys: 'esc', does: 'no problem report; from its list or contact line, back to the offer', match: esc },
  },
  retry: {
    again: { keys: 'enter', does: 'try again after a failure', match: enter },
  },
  // On a screen that needs a locale when none is configured.
  needsLocale: {
    setup: { keys: 'enter', does: 'open setup to choose a locale', match: enter },
  },
  menu: {
    open: { keys: 'enter', does: 'open', match: enter },
    move: { keys: '←↑↓→', does: 'move', match: arrows },
    // Any letter: the handler opens the card that carries it, or declines.
    hotkey: { keys: 'letter', does: 'open the card with that key', match: (input, key) => input.length === 1 && plain(key) },
  },
  home: {
    provider: { keys: 'p', does: 'switch review provider', match: char('p') },
  },
  homeTab: {
    setup: { keys: 'tab', does: 'setup status', match: tab },
  },
  setupStatus: {
    leave: { keys: 'esc  q', does: 'from the setup status, back to the cards', match: any(esc, (input) => input === 'q') },
    move: { keys: '←↑↓→', does: 'choose a setup step', match: arrows },
    open: { keys: 'enter', does: 'open the wizard at that step', match: enter },
  },
  helpPage: {
    line: { keys: '↑↓', does: 'scroll', match: vertical },
    page: { keys: 'pgup pgdn  space', does: 'scroll a page', match: (input, key) => key.pageUp || key.pageDown || input === ' ' },
  },
  about: {
    close: { keys: 'enter', does: 'back', match: enter },
  },
  interface: {
    move: { keys: '↑↓', does: 'move', match: vertical },
    toggle: { keys: 'space  enter', does: 'toggle', match: any(enter, space) },
  },
  replyTemplates: {
    move: { keys: '↑↓', does: 'choose a template', match: vertical },
    create: { keys: 'n', does: 'new template from a starter', match: char('n') },
    edit: { keys: 'e', does: 'edit the template', match: char('e') },
    remove: { keys: 'd', does: 'delete the template', match: char('d') },
    preview: { keys: 'v', does: 'preview with problems or clean', match: char('v') },
  },
  // Asked before a template is deleted. Its own group so y and n mean only
  // this while the question is on screen.
  // Inside the template editor, where every printable key is text. Only
  // chords and esc are left to bind.
  templateEditor: {
    save: { keys: 'ctrl+s', does: 'save the template', match: (input, key) => key.ctrl && input === 's' },
    close: { keys: 'esc', does: 'close the editor, asking first if anything changed', match: esc },
  },
  templateUnsaved: {
    save: { keys: 'y', does: 'save the changes', match: char('y') },
    discard: { keys: 'n', does: 'throw the changes away', match: char('n') },
    keep: { keys: 'esc', does: 'back to editing', match: esc },
  },
  templateDelete: {
    yes: { keys: 'y', does: 'delete it', match: char('y') },
    no: { keys: 'n  esc', does: 'keep it', match: any(char('n'), esc) },
  },
  usageStats: {
    move: { keys: '↑↓', does: 'choose a setting', match: vertical },
    toggle: { keys: 'space  enter', does: 'change the chosen setting', match: any(enter, space) },
    reset: { keys: 'r', does: 'forget the install id', match: char('r') },
  },
  agents: {
    recheck: { keys: 'r', does: 're-check', match: char('r') },
    debug: { keys: 'd', does: 'turn debug mode on or off', match: char('d') },
    effort: { keys: 'e', does: "change codex's effort", match: char('e') },
  },
  localModels: {
    recheck: { keys: 'r', does: 're-check', match: char('r') },
    move: { keys: '↑↓', does: 'move', match: vertical },
    choose: { keys: 'enter', does: 'choose', match: enter },
  },
  picker: {
    sort: { keys: 's', does: 'change how the files are sorted', match: char('s') },
  },
  // Marking files for one batch, in the review and translate pickers only.
  marks: {
    toggle: { keys: 'space', does: 'mark or unmark a file for one batch', match: space },
    all: { keys: '*', does: 'mark every file in this folder, or unmark them', match: char('*') },
  },
  // The options form on translate, review and fetch.
  runForm: {
    move: { keys: '↑↓  tab', does: 'move between fields', match: any(vertical, tab) },
    change: { keys: '←→  space', does: 'change a choice', match: any(horizontal, space) },
    select: { keys: 'enter', does: 'start', match: enter },
  },
  run: {
    pause: { keys: 'p', does: 'pause after the current batch', match: char('p') },
    resume: { keys: 'r', does: 'resume', match: char('r') },
    stop: { keys: 'q', does: 'stop after the current batch', match: char('q') },
  },
  translateResult: {
    open: { keys: 'o', does: 'open the result', match: char('o') },
  },
  reviewResult: {
    open: { keys: 'o', does: 'open the problems file', match: char('o') },
    // The reply when the locale has a template, the requester message when it
    // has none: the screen shows one of the two, never both, so one key copies
    // whichever is there. t cycles through the locale's templates.
    copy: { keys: 'c', does: 'copy the reply or the report', match: char('c') },
    template: { keys: 't', does: 'next reply template', match: char('t') },
  },
  fetchList: {
    add: { keys: 'enter', does: 'add a project; on an empty line, continue', match: enter },
    done: { keys: 'ctrl+d', does: 'continue', match: (input, key) => key.ctrl && input === 'd' },
    erase: { keys: 'backspace', does: 'delete a character, then the line above', match: erase },
    type: { keys: 'type', does: 'a slug or a translate.wordpress.org URL', match: printable },
  },
  fetchGet: {
    choose: { keys: '←↑↓→  space', does: 'waiting or untranslated strings', match: any(arrows, space) },
    readme: { keys: 'r', does: "a plugin's readme too, or its code only", match: char('r') },
    check: { keys: 'enter', does: 'check the list', match: enter },
  },
  // The end of a batch: one reply, or one requester message, per reviewed
  // line, shown one at a time, since each goes to a different request thread
  // and a copy must carry exactly one of them.
  batchResult: {
    copy: { keys: 'c', does: 'copy the reply or message shown', match: char('c') },
    template: { keys: 't', does: 'next reply template', match: char('t') },
  },
  // A batch's file list, while it runs and on its summary. The cursor picks
  // the file enter opens, and on the summary the reply shown is that file's,
  // so one cursor serves both rather than a second one for the replies that
  // could stand on a different line from the file it would open.
  batchFiles: {
    move: { keys: '↑↓', does: 'move between files', match: vertical },
    inspect: { keys: 'enter', does: "open a file's own progress", match: enter },
  },
  fetchResolved: {
    next: { keys: 'enter', does: 'continue to the options', match: enter },
  },
  // Import TM's first question: the vault's memory, or a file of one's own.
  importChoice: {
    move: { keys: '↑↓', does: 'fetch from polyglots-data or import a file', match: vertical },
    choose: { keys: 'enter', does: 'go on with the one chosen', match: enter },
  },
  tmFetch: {
    start: { keys: 'y', does: 'after the summary: download and import', match: char('y') },
  },
  stats: {
    write: { keys: 'w', does: 'write a standalone HTML copy', match: char('w') },
    open: { keys: 'o', does: 'open the page in a browser', match: char('o') },
    stop: { keys: 'x', does: 'stop serving the page', match: char('x') },
    serve: { keys: 's', does: 'serve it again once stopped', match: char('s') },
  },
  statsExport: {
    open: { keys: 'o', does: 'open the written copy', match: char('o') },
  },
  exportFormat: {
    format: { keys: '↑↓  space', does: 'switch format', match: any(vertical, space) },
    next: { keys: 'enter', does: 'continue', match: enter },
  },
  // Where a file goes: a name field, with tab for the folder picker, because
  // the field types any printable key.
  target: {
    folder: { keys: 'tab', does: 'choose the folder', match: tab },
  },
  localeRules: {
    move: { keys: '↑↓', does: 'move', match: vertical },
    open: { keys: 'enter', does: 'open a section', match: enter },
    save: { keys: 's', does: 'save the rules file', match: char('s') },
  },
  // The rules fetch's summary: the file it would write, read before it is
  // written. Its own group so y means nothing on the rest of the screen.
  rulesFetch: {
    scroll: { keys: '↑↓', does: 'scroll the fetched summary', match: vertical },
    write: { keys: 'y', does: 'write the fetched rules file', match: char('y') },
  },
  ruleList: {
    move: { keys: '↑↓', does: 'move through the built-in rules', match: vertical },
    toggle: { keys: 'space  enter', does: 'turn a rule on or off', match: any(enter, space) },
  },
  ratio: {
    change: { keys: '←→', does: 'change the glossary match ratio', match: horizontal },
    reset: { keys: 'r', does: 'back to the built-in ratio', match: char('r') },
  },
  nouns: {
    move: { keys: '↑↓', does: 'choose a proper noun list', match: vertical },
    open: { keys: 'enter', does: 'open the list', match: enter },
  },
  formality: {
    choose: { keys: '↑↓', does: 'choose not set, formal or informal', match: vertical },
  },
  register: {
    move: { keys: '↑↓', does: 'choose the review or the draft register', match: vertical },
    open: { keys: 'enter', does: 'edit that register', match: enter },
  },
  sentenceEnd: {
    move: { keys: '↑↓', does: 'move through the sentence-end settings', match: vertical },
    open: { keys: 'space  enter', does: 'turn "no final mark" on or off, or open a setting', match: any(enter, space) },
  },
  leave: {
    save: { keys: 's', does: 'with unsaved changes: save them', match: char('s') },
    discard: { keys: 'd', does: 'with unsaved changes: leave without saving', match: char('d') },
  },
  listEditor: {
    move: { keys: '↑↓', does: 'move through a list', match: vertical },
    add: { keys: 'a', does: 'add to the list', match: char('a') },
    edit: { keys: 'enter', does: 'edit the highlighted item', match: enter },
    remove: { keys: 'd', does: 'delete the highlighted item', match: char('d') },
  },
  form: {
    previous: { keys: '↑  shift+tab', does: 'previous field', match: any(up, (_i, key) => key.tab && key.shift) },
    next: { keys: '↓  tab', does: 'next field', match: any(down, tab) },
  },
  wizard: {
    skip: { keys: 'esc', does: 'skip this step', match: esc },
    move: { keys: '↑↓', does: 'move', match: vertical },
    choose: { keys: 'enter', does: 'choose and continue', match: enter },
  },
  helpOverlay: {
    close: { keys: 'esc  ?  q  enter', does: 'close', match: any(esc, enter, (input) => input === '?' || input === 'q') },
  },
  palette: {
    close: { keys: 'esc', does: 'close', match: esc },
    move: { keys: '↑↓', does: 'choose', match: vertical },
  },
  // The list under a locale search, in the setup locale step and in the
  // locale picker. Its own group because the search component binds it, and
  // the wizard's move would otherwise be bound twice on the locale step.
  localeSearch: {
    move: { keys: '↑↓', does: 'choose a locale', match: vertical },
  },
  quitPrompt: {
    quit: { keys: 'y', does: 'quit anyway', match: (input) => input === 'y' || input === 'Y' },
    stay: { keys: 'n  esc', does: 'keep going', match: (input, key) => input === 'n' || input === 'N' || key.escape },
  },
  // The offer made after a change to a locale with nothing set up yet.
  localeSetup: {
    yes: { keys: 'y', does: 'set up the locale', match: (input) => input === 'y' || input === 'Y' },
    no: { keys: 'n  esc', does: 'not now', match: (input, key) => input === 'n' || input === 'N' || key.escape },
  },
  // Answered by a text field's submit or a list's select, not by a listener.
  fields: {
    pickAndSplit: widget('enter', 'pick and split'),
    importFile: widget('enter', 'import'),
    sync: widget('enter', 'sync'),
    saveKey: widget('enter', 'save and go to the next key'),
    templateName: widget('enter', 'create the template with that name'),
    guidanceText: widget('type  ←→↑↓  enter  ctrl+x', 'in guidance, capitalization or a register: edit the text, enter a new line, ctrl+x clear it all, ctrl+z undo'),
    templateText: widget('type  ←→↑↓  enter  ctrl+x', 'edit the text: enter a new line, ctrl+x clear it all, ctrl+z undo, ctrl+y redo'),
    write: widget('enter', 'write the file'),
    submitForm: widget('enter', 'save the form'),
  },
} as const satisfies Record<string, Record<string, KeyEntry>>

export type Group = keyof typeof KEYS

/** The ids in a group that a listener must answer: everything but widget keys. */
export type BoundId<G extends Group> = {
  [K in keyof (typeof KEYS)[G]]: (typeof KEYS)[G][K] extends BoundKey ? K : never
}[keyof (typeof KEYS)[G]]

const GROUP_OF = new Map<KeyEntry, Group>(
  (Object.entries(KEYS) as Array<[Group, Record<string, KeyEntry>]>).flatMap(([group, entries]) =>
    Object.values(entries).map((e): [KeyEntry, Group] => [e, group]),
  ),
)

/** The group an entry belongs to, for the drift test's messages. */
export function groupOf(entry: KeyEntry): Group {
  const group = GROUP_OF.get(entry)
  if (!group) throw new Error(`not an entry of the key table: ${entry.keys} ${entry.does}`)
  return group
}

const help = ({ keys, does }: KeyEntry): KeyHelp => ({ keys, does })

export const GLOBAL_KEYS: KeyHelp[] = [KEYS.global.help, KEYS.global.palette, KEYS.global.locale, KEYS.back.esc, KEYS.back.q, KEYS.global.quit, KEYS.global.stopStats, KEYS.global.scroll].map(
  help,
)

/**
 * What each screen lists. `shown` leads, and the footer has room for the
 * first three of it; `more` is for the `?` overlay and the help page only,
 * so a key added to the listing does not push a more useful one off the
 * footer.
 */
export interface ScreenKeys {
  shown: KeyEntry[]
  more?: KeyEntry[]
  // What the footer leads with in each stage of a screen that has stages,
  // drawn from shown and more: a run screen's form keys do nothing while
  // the run goes, and its run keys nothing once it is done.
  stages?: Partial<Record<FooterStage, KeyEntry[]>>
}

/**
 * The stages a screen reports to the frame for its footer. `summary` is the
 * end of a batch, which has no single result to open or copy.
 */
export type FooterStage = 'pick' | 'options' | 'running' | 'done' | 'summary'

const { menu, runForm, run, finished, retry, picker, fields, marks, batchResult, batchFiles, problemReport } = KEYS
// What a batch's summary binds, in footer order. Translate's batch never has a
// reply to show, but it renders the same component, so its help lists them.
// Enter opens the file under the cursor, so esc and q are the way back, and
// the footer adds esc on its own.
const BATCH_DONE = [batchFiles.inspect, batchResult.copy, batchFiles.move, batchResult.template]
const MENU = [menu.move, menu.open, menu.hotkey]
const RUN = [run.pause, run.resume, run.stop]
const FORM = [runForm.move, runForm.change, runForm.select]
const REPORT = [problemReport.send, problemReport.see, problemReport.dismiss]
// A batch opens any file's own progress screen, the single run's component,
// and that screen's result keys come with it once the file has finished. So
// translate's help lists review's, and review's lists translate's open: the
// batch component draws both, by action, and fetch runs either.
const INSPECTED_REVIEW = [KEYS.reviewResult.open, KEYS.reviewResult.copy, KEYS.reviewResult.template]

export const SCREENS: Record<ScreenId, ScreenKeys> = {
  home: {
    shown: [...MENU, KEYS.homeTab.setup, KEYS.home.provider],
    more: [KEYS.setupStatus.move, KEYS.setupStatus.open, KEYS.setupStatus.leave],
  },
  tools: { shown: MENU },
  config: { shown: MENU },
  translate: {
    shown: [...FORM, ...RUN, KEYS.translateResult.open],
    more: [
      marks.toggle,
      marks.all,
      KEYS.another.file,
      picker.sort,
      finished.close,
      batchFiles.move,
      batchFiles.inspect,
      batchResult.copy,
      batchResult.template,
      ...INSPECTED_REVIEW,
      ...REPORT,
    ],
    stages: {
      pick: [marks.toggle, marks.all, picker.sort],
      options: FORM,
      running: RUN,
      done: [KEYS.translateResult.open, KEYS.another.file, finished.close],
      summary: [batchFiles.inspect, batchFiles.move],
    },
  },
  review: {
    shown: [...FORM, ...RUN, KEYS.reviewResult.open, KEYS.reviewResult.copy],
    more: [
      marks.toggle,
      marks.all,
      KEYS.reviewResult.template,
      KEYS.another.file,
      picker.sort,
      finished.close,
      batchFiles.move,
      batchFiles.inspect,
      batchResult.copy,
      batchResult.template,
      KEYS.translateResult.open,
      ...REPORT,
    ],
    stages: {
      pick: [marks.toggle, marks.all, picker.sort],
      options: FORM,
      running: RUN,
      // The footer has room for three: open, another file, and the way back.
      // Copy and the template key give way, because both are named on screen
      // beside the text they act on ("c to copy", "t for the next template").
      done: [KEYS.reviewResult.open, KEYS.another.file, finished.close, KEYS.reviewResult.copy, KEYS.reviewResult.template],
      summary: BATCH_DONE,
    },
  },
  fetch: {
    shown: [KEYS.fetchList.add, KEYS.fetchList.done, ...RUN],
    more: [
      KEYS.fetchList.type,
      KEYS.fetchList.erase,
      KEYS.fetchGet.choose,
      KEYS.fetchGet.readme,
      KEYS.fetchGet.check,
      KEYS.fetchResolved.next,
      ...FORM,
      finished.close,
      KEYS.needsLocale.setup,
      batchFiles.move,
      batchFiles.inspect,
      batchResult.copy,
      batchResult.template,
      ...INSPECTED_REVIEW,
      KEYS.translateResult.open,
      ...REPORT,
    ],
    stages: { options: FORM, running: RUN, done: BATCH_DONE },
  },
  stats: {
    shown: [KEYS.stats.open, KEYS.stats.write, KEYS.stats.stop],
    more: [KEYS.stats.serve, fields.write, KEYS.target.folder, KEYS.statsExport.open, picker.sort, finished.close, retry.again],
  },
  help: { shown: [KEYS.helpPage.line], more: [KEYS.helpPage.page] },
  about: { shown: [], more: [KEYS.about.close] },
  split: { shown: [fields.pickAndSplit], more: [picker.sort, finished.close] },
  'import-tm': {
    shown: [KEYS.importChoice.move, KEYS.importChoice.choose, fields.importFile],
    more: [KEYS.tmFetch.start, picker.sort, finished.close, KEYS.needsLocale.setup],
  },
  'export-tm': {
    shown: [KEYS.exportFormat.format, KEYS.exportFormat.next, KEYS.target.folder],
    more: [fields.write, picker.sort, finished.close, retry.again, KEYS.needsLocale.setup],
  },
  'sync-glossary': { shown: [fields.sync], more: [finished.close, retry.again] },
  'locale-rules': {
    shown: [KEYS.localeRules.move, KEYS.localeRules.open],
    more: [
      KEYS.localeRules.save,
      KEYS.rulesFetch.scroll,
      KEYS.rulesFetch.write,
      KEYS.leave.save,
      KEYS.leave.discard,
      KEYS.ruleList.move,
      KEYS.ruleList.toggle,
      KEYS.ratio.change,
      KEYS.ratio.reset,
      KEYS.nouns.move,
      KEYS.nouns.open,
      KEYS.formality.choose,
      KEYS.register.move,
      KEYS.register.open,
      KEYS.sentenceEnd.move,
      KEYS.sentenceEnd.open,
      KEYS.listEditor.move,
      KEYS.listEditor.add,
      KEYS.listEditor.edit,
      KEYS.listEditor.remove,
      KEYS.form.next,
      KEYS.form.previous,
      fields.submitForm,
      fields.guidanceText,
    ],
  },
  'reply-templates': {
    shown: [KEYS.replyTemplates.edit, KEYS.replyTemplates.create, KEYS.replyTemplates.remove, KEYS.replyTemplates.preview],
    more: [
      KEYS.replyTemplates.move,
      fields.templateName,
      fields.templateText,
      KEYS.templateEditor.save,
      KEYS.templateEditor.close,
      KEYS.templateUnsaved.save,
      KEYS.templateUnsaved.discard,
      KEYS.templateUnsaved.keep,
      KEYS.templateDelete.yes,
      KEYS.templateDelete.no,
      KEYS.needsLocale.setup,
    ],
  },
  agents: { shown: [KEYS.agents.recheck, KEYS.agents.debug, KEYS.agents.effort] },
  'local-models': { shown: [KEYS.localModels.recheck, KEYS.localModels.choose], more: [KEYS.localModels.move] },
  'configure-keys': { shown: [fields.saveKey], more: [finished.close] },
  setup: { shown: [KEYS.wizard.choose, KEYS.wizard.skip], more: [KEYS.wizard.move, KEYS.localeSearch.move] },
  interface: { shown: [KEYS.interface.move, KEYS.interface.toggle] },
  'usage-stats': { shown: [KEYS.usageStats.toggle, KEYS.usageStats.move, KEYS.usageStats.reset] },
}

/** The full listing, for the `?` overlay and the help page. */
export const SCREEN_KEYS = Object.fromEntries(
  (Object.entries(SCREENS) as Array<[ScreenId, ScreenKeys]>).map(([id, { shown, more = [] }]) => [id, [...shown, ...more].map(help)]),
) as Record<ScreenId, KeyHelp[]>

// What the footer has room for: the screen's first few keys, then the
// globals that matter most. The `?` overlay has the rest.
export function footerKeys(screen: ScreenId, serving = false, stage?: string): KeyHelp[] {
  // While the stats server runs, x stops it from any screen; the stats screen
  // lists x among its own keys already.
  const stats = serving && screen !== 'stats' ? [{ keys: 'x', does: 'stop stats' }] : []
  if (screen === 'home') {
    return [
      ...stats,
      { keys: '←↑↓→', does: 'move' },
      { keys: 'enter', does: 'open' },
      { keys: 'tab', does: 'setup' },
      { keys: 'p', does: 'provider' },
      { keys: '?', does: 'help' },
      { keys: '^K', does: 'go to' },
      { keys: 'q', does: 'quit' },
    ]
  }
  const { shown, stages } = SCREENS[screen]
  const own = (stages?.[stage as FooterStage] ?? shown).slice(0, 3).map(help)
  return [...stats, ...own, { keys: '?', does: 'help' }, ...(own.some((k) => k.keys === 'esc') ? [] : [{ keys: 'esc', does: 'back' }])]
}
