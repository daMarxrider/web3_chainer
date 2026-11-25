import { h, replace } from '../dom.ts'
import { engine } from '../engine.ts'
import { disclaimerBlock } from '../firstlaunch.ts'
import { prefs, savePrefs, THEMES, type ThemeName } from '../prefs.ts'

/** Look, network mode, defaults and the disclaimer. Everything here is stored on this device. */
export async function settingsScreen(sheet: HTMLElement): Promise<void> {
  const s = engine.settings
  const saved = h('p', { class: 'hint', role: 'status' })
  const flash = (text: string) => {
    saved.textContent = text
    setTimeout(() => (saved.textContent = ''), 2500)
  }

  const themeRadio = (value: ThemeName, label: string, text: string) =>
    h('label', { class: 'check block' }, h('input', { type: 'radio', name: 'theme', value, checked: prefs().theme === value, onChange: async () => { await savePrefs({ theme: value }); flash(`${label} theme on`) } }), h('span', {}, h('strong', {}, label), ' ', text))

  const prefer = h('select', { name: 'prefer', id: 's-prefer' }, [['cheapest', 'Cheapest (most received)'], ['fastest', 'Fastest']].map(([v, l]) => h('option', { value: v, selected: s.prefer === v }, l)))
  const slippage = h('input', { name: 'slippage', id: 's-slippage', inputmode: 'decimal', value: String(s.slippage * 100), class: 'num narrow' })
  const hops = h('input', { name: 'hops', id: 's-hops', type: 'number', min: '1', max: '5', value: String(s.maxHops), class: 'num narrow' })
  const limit = h('input', { name: 'limit', id: 's-limit', inputmode: 'decimal', value: s.maxUsdPerTransfer === null ? '' : String(s.maxUsdPerTransfer), placeholder: 'no limit', class: 'num narrow' })
  const err = h('p', { class: 'form-error', role: 'alert' })

  const form = h(
    'form',
    { class: 'form', onSubmit: async (e: Event) => {
      e.preventDefault()
      err.textContent = ''
      try {
        const sl = Number(slippage.value) / 100
        if (!(sl > 0 && sl < 0.5)) throw new Error('Slippage must be between 0 and 50 percent')
        const mh = Number(hops.value)
        if (!Number.isInteger(mh) || mh < 1 || mh > 5) throw new Error('Most legs must be a whole number from 1 to 5')
        const lim = limit.value.trim() === '' ? null : Number(limit.value)
        if (lim !== null && !(lim > 0)) throw new Error('The limit must be a positive amount in dollars, or empty for none')
        await engine.saveSettings({ ...engine.settings, prefer: prefer.value as 'cheapest' | 'fastest', slippage: sl, maxHops: mh, maxUsdPerTransfer: lim })
        flash('Saved')
      } catch (e2) {
        err.textContent = (e2 as Error).message
      }
    } },
    h('label', { class: 'row', for: 's-prefer' }, h('span', { class: 'label' }, 'Rank routes by'), prefer),
    h('label', { class: 'row', for: 's-slippage' }, h('span', { class: 'label' }, 'Slippage, percent'), slippage),
    h('label', { class: 'row', for: 's-hops' }, h('span', { class: 'label' }, 'Most legs per route'), hops),
    h('label', { class: 'row', for: 's-limit' }, h('span', { class: 'label' }, 'Limit per transfer, USD'), limit),
    err,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save')),
  )

  replace(
    sheet,
    h('h1', { class: 'sheet-title' }, 'Settings'),
    saved,
    h('fieldset', { class: 'group' }, h('legend', {}, 'Look'), THEMES.map((t) => themeRadio(t.id, t.label, t.blurb))),
    h('fieldset', { class: 'group' }, h('legend', {}, 'Networks'), h('p', { class: 'hint' }, 'Test networks use test funds and keep their own run history. Switch with the network button in the status strip below, or here.'), h('label', { class: 'check block' }, h('input', { type: 'checkbox', name: 'test', checked: prefs().testMode, onChange: async (e: Event) => { await savePrefs({ testMode: (e.target as HTMLInputElement).checked }); flash(prefs().testMode ? 'Test networks on. Reopen a screen to see them.' : 'Real networks on.') } }), h('span', {}, 'Use test networks'))),
    h('fieldset', { class: 'group' }, h('legend', {}, 'Defaults'), form),
    h('fieldset', { class: 'group' }, h('legend', {}, 'About and disclaimer'), h('p', { class: 'hint' }, 'chainer is free software under the GNU GPL v3. It holds your keys on this device only.'), disclaimerBlock()),
  )
}
