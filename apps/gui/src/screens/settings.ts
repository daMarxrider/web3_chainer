import { h, replace } from '../dom.ts'
import { engine } from '../engine.ts'
import { disableFingerprint, enableFingerprint, fingerprintStatus } from '../fingerprint.ts'
import { prefs, savePrefs, THEMES, type ThemeName } from '../prefs.ts'

/** Look, network mode and defaults. Everything here is stored on this device. */
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
  const gasMode = h('select', { name: 'gasMode', id: 's-gasmode' }, [['multiplier', 'A multiple of the estimated gas cost'], ['fixed', 'A fixed value'], ['off', 'Off']].map(([v, l]) => h('option', { value: v, selected: s.gasTopUp.mode === v }, l)))
  const gasMult = h('input', { name: 'gasMult', id: 's-gasmult', inputmode: 'decimal', value: String(s.gasTopUp.multiplier), class: 'num narrow' })
  const gasFixed = h('input', { name: 'gasFixed', id: 's-gasfixed', inputmode: 'decimal', value: String(s.gasTopUp.fixedUsd), class: 'num narrow' })
  const avoid = h('input', { name: 'avoid', id: 's-avoid', value: s.avoidTokens.join(', '), placeholder: 'USDT, SHIB', autocomplete: 'off' })
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
        const gm = Number(gasMult.value)
        if (!(gm >= 0.5 && gm <= 20)) throw new Error('The gas multiplier must be between 0.5 and 20')
        const gf = Number(gasFixed.value)
        if (!(gf >= 0.1 && gf <= 50)) throw new Error('The fixed gas value must be between $0.10 and $50')
        await engine.saveSettings({ ...engine.settings, prefer: prefer.value as 'cheapest' | 'fastest', slippage: sl, maxHops: mh, maxUsdPerTransfer: lim, avoidTokens: avoid.value.split(',').map((x) => x.trim()).filter(Boolean), gasTopUp: { mode: gasMode.value as 'off' | 'multiplier' | 'fixed', multiplier: gm, fixedUsd: gf } })
        flash('Saved')
      } catch (e2) {
        err.textContent = (e2 as Error).message
      }
    } },
    h('label', { class: 'row', for: 's-prefer' }, h('span', { class: 'label' }, 'Rank routes by'), prefer),
    h('label', { class: 'row', for: 's-slippage' }, h('span', { class: 'label' }, 'Slippage, percent'), slippage),
    h('label', { class: 'row', for: 's-hops' }, h('span', { class: 'label' }, 'Most legs per route'), hops),
    h('label', { class: 'row', for: 's-limit' }, h('span', { class: 'label' }, 'Limit per transfer, USD'), limit),
    h('label', { class: 'row', for: 's-avoid' }, h('span', { class: 'label' }, 'Never route through'), avoid),
    h('p', { class: 'hint' }, 'Gas: a small extra transfer is sent ahead to a chain a route stops on when its next leg would have no coin to pay with, and after a transfer to a recipient who has none of the destination chain’s coin. Both are shown and confirmed with the transfer.'),
    h('label', { class: 'row', for: 's-gasmode' }, h('span', { class: 'label' }, 'Gas top-up'), gasMode),
    h('label', { class: 'row', for: 's-gasmult' }, h('span', { class: 'label' }, 'Multiplier'), gasMult),
    h('label', { class: 'row', for: 's-gasfixed' }, h('span', { class: 'label' }, 'Fixed value, USD'), gasFixed),
    err,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save')),
  )

  // Fingerprint unlock, for the wallet that is open; only where the device has a fingerprint set up.
  const wallet = engine.requireSession().walletName
  const finger = await fingerprintStatus(wallet).catch(() => ({ available: false, enabled: false }))
  const fingerBox = h('input', { type: 'checkbox', name: 'fingerprint', checked: finger.enabled, onChange: async () => {
    fingerBox.disabled = true
    try {
      if (fingerBox.checked) {
        const r = await enableFingerprint(wallet, engine.requireSession().password)
        fingerBox.checked = r.ok
        flash(r.ok ? 'Fingerprint unlock on' : (r.message ?? 'Fingerprint unlock could not be turned on'))
      } else {
        await disableFingerprint(wallet)
        flash('Fingerprint unlock off')
      }
    } catch (e) {
      fingerBox.checked = !fingerBox.checked
      flash((e as Error).message)
    }
    fingerBox.disabled = false
  } })
  const fingerGroup = finger.available
    ? h('fieldset', { class: 'group' }, h('legend', {}, 'Fingerprint'), h('p', { class: 'hint' }, 'On by default. The password is kept on this phone, encrypted with a key that only your fingerprint opens. Adding a fingerprint to the phone turns this off until you turn it on again here.'), h('label', { class: 'check block' }, fingerBox, h('span', {}, `Unlock wallet ${wallet} with a fingerprint`)))
    : null

  replace(
    sheet,
    h('h1', { class: 'sheet-title' }, 'Settings'),
    saved,
    h('fieldset', { class: 'group' }, h('legend', {}, 'Look'), THEMES.map((t) => themeRadio(t.id, t.label, t.blurb))),
    h('fieldset', { class: 'group' }, h('legend', {}, 'Networks'), h('p', { class: 'hint' }, 'Test networks use test funds and keep their own run history. Switch here, or with the Real networks / Test networks button: in the status strip on a desktop, at the top on a phone.'), h('label', { class: 'check block' }, h('input', { type: 'checkbox', name: 'test', checked: prefs().testMode, onChange: async (e: Event) => { await savePrefs({ testMode: (e.target as HTMLInputElement).checked }); flash(prefs().testMode ? 'Test networks on. Reopen a screen to see them.' : 'Real networks on.') } }), h('span', {}, 'Use test networks'))),
    fingerGroup,
    h('fieldset', { class: 'group' }, h('legend', {}, 'Defaults'), form),
  )
}
