import { append, h, closeDialog, ownPop, replace, showDialog } from './dom.ts'
import { engine } from './engine.ts'
import { icon, type icons } from './icons.ts'
import { prefs, savePrefs } from './prefs.ts'
import { addressBookScreen } from './screens/addressbook.ts'
import { balancesScreen } from './screens/balances.ts'
import { historyScreen } from './screens/history.ts'
import { plansScreen } from './screens/plans.ts'
import { savedScreen } from './screens/saved.ts'
import { schedulesScreen } from './screens/schedules.ts'
import { sweepScreen } from './screens/sweep.ts'
import { startScheduler, stopScheduler } from './scheduler.ts'
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
  { id: 'sweep', label: 'Bridge wallet', icon: 'sweep', render: sweepScreen },
  { id: 'plans', label: 'Pipelines', icon: 'plan', render: plansScreen },
  { id: 'saved', label: 'Saved routes', icon: 'saved', render: savedScreen },
  { id: 'schedules', label: 'Schedules', icon: 'clock', render: schedulesScreen },
  { id: 'book', label: 'Address book', icon: 'book', render: addressBookScreen },
  { id: 'history', label: 'History', icon: 'history', render: historyScreen },
  { id: 'settings', label: 'Settings', icon: 'settings', render: settingsScreen },
]

let showing = 'balances'

/** On a phone these three sit in the tab strip; every other screen and Lock are under More. */
const TABS = new Set(['balances', 'transfer', 'history'])

/** The back button's listener of the open main window (Android's back button, or the browser's). */
let onBack: ((e: PopStateEvent) => void) | undefined

export function mainWindow(root: HTMLElement, onLock: () => void): void {
  const session = engine.requireSession()
  let sheet = h('main', { class: 'sheet', id: 'sheet', tabindex: '-1' })
  const list = h('nav', { class: 'sheetlist', 'aria-label': 'Screens' })

  const open = async (id: string) => {
    showing = id
    for (const b of list.querySelectorAll<HTMLButtonElement>('button[data-id]')) b.toggleAttribute('aria-current', b.dataset.id === id)
    moreTab.toggleAttribute('aria-current', !TABS.has(id))
    // A fresh sheet per screen: a screen still loading when another is opened finishes into its own,
    // detached sheet and cannot replace the newer screen.
    const fresh = h('main', { class: 'sheet', id: 'sheet', tabindex: '-1' })
    sheet.replaceWith(fresh)
    sheet = fresh
    const screen = SCREENS.find((s) => s.id === id)!
    sheet.dataset.screen = id
    const mine = sheet
    try {
      await screen.render(mine)
    } catch (err) {
      replace(mine, h('p', { class: 'form-error', role: 'alert' }, (err as Error).message))
    }
  }
  /** Opens a screen as a step the back button returns from. */
  const go = (id: string) => {
    if (id !== showing) history.pushState({ screen: id }, '')
    return open(id)
  }
  const lock = () => {
    if (onBack) removeEventListener('popstate', onBack)
    onBack = undefined
    stopScheduler()
    engine.lock()
    onLock()
  }

  // Back closes the dialog on top if there is one (each open dialog is a history step, see
  // showDialog), otherwise returns to the previous screen.
  if (onBack) removeEventListener('popstate', onBack)
  onBack = (e: PopStateEvent) => {
    if (ownPop()) return
    const dialogs = [...root.querySelectorAll<HTMLDialogElement>('dialog[open]')]
    if (dialogs.length > 0) return dialogs.at(-1)!.close()
    const id = (e.state as { screen?: string } | null)?.screen
    void open(SCREENS.some((s) => s.id === id) ? id! : 'balances')
  }
  addEventListener('popstate', onBack)
  history.replaceState({ screen: showing }, '')

  /** Phone: the screens that are not tabs, and Lock, in a sheet that rises from the bottom. */
  const openMore = () => {
    const pick = (fn: () => void) => async () => {
      await closeDialog(dlg)
      fn()
    }
    const item = (label: string, ic: keyof typeof icons, current: boolean, fn: () => void) =>
      h('button', { class: 'more-item', type: 'button', 'aria-current': current ? 'page' : undefined, onClick: pick(fn) }, icon(ic), h('span', {}, label))
    const dlg = h(
      'dialog',
      { class: 'window dialog more-sheet', 'aria-labelledby': 'more-title' },
      h('header', { class: 'titlebar' }, h('span', { class: 'title', id: 'more-title' }, 'More')),
      h(
        'nav',
        { class: 'more-list', 'aria-label': 'More screens' },
        SCREENS.filter((s) => !TABS.has(s.id)).map((s) => item(s.label, s.icon, s.id === showing, () => void go(s.id))),
        item('Lock', 'lock', false, lock),
      ),
    )
    dlg.addEventListener('close', () => dlg.remove())
    // A tap on the dimmed backdrop lands on the dialog element itself.
    dlg.addEventListener('click', (e) => e.target === dlg && dlg.close())
    root.append(dlg)
    showDialog(dlg)
    dlg.querySelector<HTMLElement>('[aria-current]')?.focus()
  }

  for (const s of SCREENS) {
    append(list, [h('button', { class: TABS.has(s.id) ? 'sheet-item' : 'sheet-item in-more', type: 'button', dataset: { id: s.id }, onClick: () => void go(s.id) }, icon(s.icon), h('span', {}, s.label))])
  }
  const moreTab = h('button', { class: 'sheet-item more-tab', type: 'button', 'aria-haspopup': 'dialog', onClick: openMore }, icon('more'), h('span', {}, 'More'))
  append(list, [moreTab, h('button', { class: 'sheet-item lock in-more', type: 'button', onClick: lock }, icon('lock'), h('span', {}, 'Lock'))])

  const lamp = h('span', { class: 'lamp', dataset: { state: currentJob().state }, 'aria-hidden': 'true' })
  const jobText = h('span', { class: 'job-text' }, currentJob().text)
  onJob((j) => {
    lamp.dataset.state = j.state
    jobText.textContent = j.text
  })
  // The network switch sits in the status strip on a desktop and in the title bar on a phone.
  const modeButton = (where: string) =>
    h(
      'button',
      { class: `seg seg-button mode ${where}`, type: 'button', title: 'Switch between real and test networks', onClick: async () => {
        await savePrefs({ testMode: !prefs().testMode })
        mainWindow(root, onLock)
      } },
      h('span', { class: 'lamp', dataset: { state: prefs().testMode ? 'test' : 'real' }, 'aria-hidden': 'true' }),
      prefs().testMode ? 'Test networks' : 'Real networks',
    )

  const status = h(
    'footer',
    { class: 'statusbar', role: 'status' },
    h('span', { class: 'seg grow wallet-seg' }, `Wallet ${session.walletName}`),
    modeButton('mode-strip'),
    h('span', { class: 'seg job' }, lamp, jobText),
  )

  const win = h(
    'div',
    { class: 'desktop' },
    h('div', { class: 'window main', role: 'application', 'aria-label': 'chainer' }, titlebar('chainer', h('span', { class: 'title-meta' }, prefs().testMode ? 'Test networks' : 'Real networks'), modeButton('mode-top')), h('div', { class: 'window-body' }, list, sheet), status),
  )
  replace(root, win)
  void open(showing)
  // Schedules run while the app is open and unlocked.
  startScheduler()
}
