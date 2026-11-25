import { append, h, replace } from './dom.ts'
import { engine } from './engine.ts'
import { icon, type icons } from './icons.ts'
import { prefs, savePrefs } from './prefs.ts'
import { balancesScreen } from './screens/balances.ts'
import { settingsScreen } from './screens/settings.ts'
import { transferScreen } from './screens/transfer.ts'
import { currentJob, onJob } from './status.ts'
import { titlebar } from './firstlaunch.ts'

interface Screen {
  id: string
  label: string
  icon: keyof typeof icons
  render(sheet: HTMLElement): void | Promise<void>
}

const SCREENS: Screen[] = [
  { id: 'balances', label: 'Balances', icon: 'balances', render: balancesScreen },
  { id: 'transfer', label: 'Transfer', icon: 'transfer', render: transferScreen },
  { id: 'settings', label: 'Settings', icon: 'settings', render: settingsScreen },
]

let showing = 'balances'

export function mainWindow(root: HTMLElement, onLock: () => void): void {
  const session = engine.requireSession()
  const sheet = h('main', { class: 'sheet', id: 'sheet', tabindex: '-1' })
  const list = h('nav', { class: 'sheetlist', 'aria-label': 'Screens' })

  const open = async (id: string) => {
    showing = id
    for (const b of list.querySelectorAll('button')) b.toggleAttribute('aria-current', b.dataset.id === id)
    replace(sheet)
    const screen = SCREENS.find((s) => s.id === id)!
    sheet.dataset.screen = id
    try {
      await screen.render(sheet)
    } catch (err) {
      replace(sheet, h('p', { class: 'form-error', role: 'alert' }, (err as Error).message))
    }
  }
  for (const s of SCREENS) {
    append(list, [h('button', { class: 'sheet-item', type: 'button', dataset: { id: s.id }, onClick: () => void open(s.id) }, icon(s.icon), h('span', {}, s.label))])
  }
  append(list, [h('button', { class: 'sheet-item lock', type: 'button', onClick: () => { engine.lock(); onLock() } }, icon('lock'), h('span', {}, 'Lock'))])

  const lamp = h('span', { class: 'lamp', dataset: { state: currentJob().state }, 'aria-hidden': 'true' })
  const jobText = h('span', { class: 'job-text' }, currentJob().text)
  onJob((j) => {
    lamp.dataset.state = j.state
    jobText.textContent = j.text
  })
  const modeBtn = h(
    'button',
    { class: 'seg seg-button mode', type: 'button', title: 'Switch between real and test networks', onClick: async () => {
      await savePrefs({ testMode: !prefs().testMode })
      mainWindow(root, onLock)
    } },
    h('span', { class: 'lamp', dataset: { state: prefs().testMode ? 'test' : 'real' }, 'aria-hidden': 'true' }),
    prefs().testMode ? 'Test networks' : 'Real networks',
  )

  const status = h(
    'footer',
    { class: 'statusbar', role: 'status' },
    h('span', { class: 'seg grow' }, `Wallet ${session.walletName}`),
    modeBtn,
    h('span', { class: 'seg job' }, lamp, jobText),
  )

  const win = h(
    'div',
    { class: 'desktop' },
    h('div', { class: 'window main', role: 'application', 'aria-label': 'chainer' }, titlebar('chainer', h('span', { class: 'title-meta' }, prefs().testMode ? 'test networks' : 'real networks')), h('div', { class: 'window-body' }, list, sheet), status),
  )
  replace(root, win)
  void open(showing)
}
