import { mountEditor } from './editor.js'
import { localHost } from './local-host.js'
import { EDITOR_CSS } from './styles.js'

// The bundle's entry, kept apart from editor.ts so tests and the website can
// import mountEditor without it running against whatever document they have.
// The page the local server sends is an empty #root; the styles travel in the
// bundle so the server inlines one string, not two.
const style = document.createElement('style')
style.textContent = EDITOR_CSS
document.head.append(style)

// mountEditor draws its own error when the load fails; the rejection carries
// nothing more for the page to show.
mountEditor(document.getElementById('root') ?? document.body, localHost()).catch(() => {})
