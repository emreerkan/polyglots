import { mountEditor } from '../../../../app/src/glossary/editor/page/editor.js'
import { EDITOR_CSS } from '../../../../app/src/glossary/editor/page/styles.js'
import { localeDisplayName, resolveLocale } from '../../../../app/src/wporg/locales.js'
import { exportUrl, webHost, type Saved, type Start, type WebEnv } from './web-host.js'

// The page's behaviour: the start screen and the browser services the host
// needs. The editor itself is the one the local server serves; only the host
// differs. Plain DOM, as the rest of the site.

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`Missing ${sel}`)
  return el
}

function storage(): WebEnv['storage'] {
  // Reading the property itself can throw when site data is blocked.
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

const readText = (file: File): Promise<string> => file.text()

function pickFile(accept: string): Promise<{ name: string; text: string } | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return resolve(undefined)
      readText(file).then((text) => resolve({ name: file.name, text }), () => resolve(undefined))
    })
    input.addEventListener('cancel', () => resolve(undefined))
    input.click()
  })
}

function download(name: string, text: string): void {
  // No BOM: the CSV is written as GlotPress writes it.
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function start(): void {
  const style = document.createElement('style')
  style.textContent = EDITOR_CSS
  document.head.append(style)

  const panel = $<HTMLElement>('[data-ge-start]')
  const root = $<HTMLElement>('[data-ge-root]')
  const error = $<HTMLElement>('[data-ge-error]')
  const cont = $<HTMLElement>('[data-ge-continue]')
  const select = $<HTMLSelectElement>('[data-ge-locale]')
  const link = $<HTMLAnchorElement>('[data-ge-export-link]')
  const drop = $<HTMLElement>('[data-ge-drop]')
  const fileInput = $<HTMLInputElement>('[data-ge-file]')

  const showLink = (): void => {
    link.href = exportUrl(select.value)
  }
  showLink()
  select.addEventListener('change', showLink)

  const env: WebEnv = {
    storage: storage(),
    download,
    pick: pickFile,
    start: (saved: Saved | undefined) =>
      new Promise<Start>((resolve) => {
        const finish = (choice: Start): void => {
          cleanup()
          panel.hidden = true
          root.hidden = false
          resolve(choice)
        }
        const onFile = async (file: File | undefined): Promise<void> => {
          if (!file) return
          try {
            finish({ kind: 'file', name: file.name, text: await readText(file) })
          } catch {
            showError('That file could not be read.')
          }
        }
        const onChange = (): void => void onFile(fileInput.files?.[0])
        const onNew = (): void => finish({ kind: 'new', locale: select.value })
        const onContinue = (): void => finish({ kind: 'saved' })
        const onOver = (e: DragEvent): void => {
          e.preventDefault()
          drop.classList.add('over')
        }
        const onLeave = (): void => drop.classList.remove('over')
        const onDrop = (e: DragEvent): void => {
          e.preventDefault()
          onLeave()
          void onFile(e.dataTransfer?.files[0])
        }
        const newBtn = $<HTMLElement>('[data-ge-new]')
        const contBtn = $<HTMLElement>('[data-ge-continue-btn]')
        fileInput.addEventListener('change', onChange)
        newBtn.addEventListener('click', onNew)
        contBtn.addEventListener('click', onContinue)
        drop.addEventListener('dragover', onOver)
        drop.addEventListener('dragleave', onLeave)
        drop.addEventListener('drop', onDrop)
        function cleanup(): void {
          fileInput.removeEventListener('change', onChange)
          newBtn.removeEventListener('click', onNew)
          contBtn.removeEventListener('click', onContinue)
          drop.removeEventListener('dragover', onOver)
          drop.removeEventListener('dragleave', onLeave)
          drop.removeEventListener('drop', onDrop)
          fileInput.value = ''
        }

        cont.hidden = saved === undefined
        if (saved) {
          const n = saved.rows.length
          const what = saved.file ?? `a new ${localeDisplayName(resolveLocale(saved.locale)?.id ?? saved.locale)} glossary`
          $<HTMLElement>('[data-ge-continue-text]').textContent = `${what}, ${n} ${n === 1 ? 'row' : 'rows'}. It is kept in this browser until you export it.`
        }
        root.hidden = true
        panel.hidden = false
      }),
  }

  function showError(text: string): void {
    error.textContent = text
    error.hidden = text === ''
  }

  // A file that is not a glossary export makes the load throw after the start
  // screen has gone, so the loop brings it back with the reason and tries
  // again rather than leaving the person on an error with no way forward.
  void (async () => {
    for (;;) {
      try {
        await mountEditor(root, webHost(env))
        return
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e))
      }
    }
  })()
}
