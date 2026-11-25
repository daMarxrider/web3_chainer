import './styles/base.css'
import './styles/retro.css'
import './styles/modern.css'
import './styles/smoked.css'
import './styles/night.css'
import { mainWindow } from './app.ts'
import { engine } from './engine.ts'
import { firstLaunch, unlockWindow } from './firstlaunch.ts'
import { loadPrefs } from './prefs.ts'

async function boot(): Promise<void> {
  const root = document.getElementById('app')!
  await loadPrefs()
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
