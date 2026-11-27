import './styles/base.css'
import './styles/retro.css'
import './styles/modern.css'
import './styles/smoked.css'
import './styles/night.css'
import './styles/ticket.css'
import { mainWindow } from './app.ts'
import { h, replace } from './dom.ts'
import { engine } from './engine.ts'
import { firstLaunch, titlebar, unlockWindow } from './firstlaunch.ts'
import { loadPrefs } from './prefs.ts'

/** Says which webview copies were kept as backups because the data folder held different files; resolves on OK. */
function movedNotice(root: HTMLElement, keys: string[]): Promise<void> {
  return new Promise((done) => {
    const win = h(
      'section',
      { class: 'window wizard', 'aria-labelledby': 'moved-title' },
      titlebar('Data moved'),
      h(
        'div',
        { class: 'wizard-body' },
        h('h1', { id: 'moved-title' }, 'Some files were kept as backups'),
        h('p', {}, 'This version keeps the wallet, settings and journal in the data folder shared with the command line. The data folder already held different copies of these, so those are used and the copies this app had are kept in the webview-backup folder inside the data folder:'),
        h('ul', {}, keys.map((k) => h('li', {}, h('code', {}, k)))),
        h('p', {}, 'Nothing was deleted. A wallet that only the backup holds can be imported again with its seed phrase or private key.'),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onClick: () => done() }, 'OK')),
      ),
    )
    replace(root, h('div', { class: 'desktop' }, win))
  })
}

async function boot(): Promise<void> {
  const root = document.getElementById('app')!
  const conflicts = await engine.moveWebviewData()
  await loadPrefs()
  if (conflicts.length > 0) await movedNotice(root, conflicts)
  await engine.load()

  const showLock = async () => {
    const accounts = await engine.accounts()
    await unlockWindow(root, accounts.map((a) => a.name))
    mainWindow(root, () => void showLock())
  }

  // A wallet is made on first launch; after that the app always opens on the unlock window.
  if ((await engine.accounts()).length === 0) await firstLaunch(root)
  await showLock()
}

boot().catch((err: Error) => {
  document.getElementById('app')!.textContent = `chainer could not start: ${err.message}`
})
