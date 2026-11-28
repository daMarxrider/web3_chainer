import { addAccount, newMnemonic } from '@chainer/core'
import { append, h, replace } from './dom.ts'
import { engine } from './engine.ts'
import { disableFingerprint, fingerprintPassword, fingerprintStatus } from './fingerprint.ts'
import { icon } from './icons.ts'
import { savePrefs, prefs, THEMES, type ThemeName } from './prefs.ts'

export const DISCLAIMER = [
  ['Loss of funds.', 'The author is not liable for any loss of money or tokens, including losses caused by bugs or errors in this software, by failures or changes in the bridges, exchanges, networks and other third-party services it talks to, or by price movements, fees and slippage.'],
  ['How you use it.', "The author is not liable for losses or other consequences of incorrect or improper use, such as wrong addresses or amounts, lost passwords or seed phrases, or use that breaks the law or a third party's terms. You are responsible for complying with the laws and tax rules that apply to you."],
  ['No advice, no service.', 'This is a tool you run yourself. The author does not hold your funds, does not execute transactions for you and gives no financial, legal or tax advice.'],
] as const

export function disclaimerBlock(): HTMLElement {
  return h(
    'div',
    { class: 'prose disclaimer' },
    h('p', {}, 'This software is provided "as is", without warranty of any kind. You use it entirely at your own risk.'),
    h('ul', {}, DISCLAIMER.map(([lead, rest]) => h('li', {}, h('strong', {}, lead), ' ', rest))),
    h('p', {}, 'Blockchain transactions cannot be reversed. Try a route with a dry run or in test mode first, and never send more than you can afford to lose.'),
  )
}

/** A window whose looks come from the theme it is drawn in: the picker shows the real thing, not a picture. */
function themePreview(theme: ThemeName, label: string, blurb: string, chosen: boolean, pick: () => void): HTMLElement {
  return h(
    'label',
    { class: 'theme-choice', dataset: { chosen: String(chosen) } },
    h('input', { type: 'radio', name: 'theme', value: theme, checked: chosen, onChange: pick }),
    h(
      'span',
      { class: 'theme-preview', 'data-theme': theme, 'aria-hidden': 'true' },
      h('span', { class: 'mini-desktop' }, h('span', { class: 'mini-window' }, h('span', { class: 'mini-title' }), h('span', { class: 'mini-body' }, h('span', { class: 'mini-row' }), h('span', { class: 'mini-row short' }), h('span', { class: 'mini-row' })))),
    ),
    h('span', { class: 'theme-name' }, label),
    h('span', { class: 'theme-blurb' }, blurb),
  )
}

/** First launch: theme and disclaimer, then a wallet. Resolves when a wallet exists and the disclaimer is accepted. */
export function firstLaunch(root: HTMLElement): Promise<void> {
  return new Promise((done) => {
    const step = (n: 1 | 2) => (n === 1 ? stepWelcome() : stepWallet())

    const stepWelcome = () => {
      let theme: ThemeName = prefs().theme
      const accept = h('input', { type: 'checkbox', id: 'accept', onChange: () => (go.disabled = !accept.checked) })
      const go = h('button', { class: 'btn primary', type: 'button', disabled: true, onClick: async () => { await savePrefs({ theme, disclaimerAccepted: true }); step(2) } }, 'Continue')
      const win = h(
        'section',
        { class: 'window wizard', 'aria-labelledby': 'w-title' },
        titlebar('Welcome to chainer'),
        h(
          'div',
          { class: 'wizard-body' },
          h('h1', { id: 'w-title' }, 'Move tokens between chains, with your own keys'),
          h('p', { class: 'lede' }, 'chainer compares routes from several services that never hold your funds, shows what actually arrives, and runs the transfer from this device. Choose how it looks first; you can change it later in Settings.'),
          h('fieldset', { class: 'theme-picker' }, h('legend', {}, 'Look'), THEMES.map((t) => themePreview(t.id, t.label, t.blurb, theme === t.id, () => (theme = t.id, void savePrefs({ theme }))))),
          h('h2', {}, 'Before you start'),
          disclaimerBlock(),
          h('label', { class: 'check', for: 'accept' }, accept, h('span', {}, 'I have read this and I accept it.')),
          h('div', { class: 'actions' }, go),
        ),
      )
      replace(root, h('div', { class: 'desktop' }, win))
      win.querySelector<HTMLInputElement>('input[name=theme]:checked')?.focus()
    }

    const stepWallet = () => {
      const msg = h('p', { class: 'form-error', role: 'alert' })
      const secret = h('textarea', { name: 'secret', rows: 3, autocomplete: 'off', spellcheck: 'false', placeholder: 'Twelve or more words, or a 0x… private key', hidden: true })
      const mode = { value: 'create' as 'create' | 'import' }
      const pw = h('input', { type: 'password', name: 'password', autocomplete: 'new-password', minlength: 8, required: true })
      const pw2 = h('input', { type: 'password', name: 'password2', autocomplete: 'new-password', required: true })
      const importBtn = h('button', { class: 'btn', type: 'button' }, 'Import a seed phrase or key')
      const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create wallet')
      importBtn.addEventListener('click', () => {
        mode.value = mode.value === 'create' ? 'import' : 'create'
        secret.hidden = mode.value === 'create'
        importBtn.textContent = mode.value === 'create' ? 'Import a seed phrase or key' : 'Make a new wallet instead'
        submit.textContent = mode.value === 'create' ? 'Create wallet' : 'Import wallet'
      })
      const form = h(
        'form',
        { class: 'form', onSubmit: async (e: Event) => {
          e.preventDefault()
          msg.textContent = ''
          try {
            if (pw.value !== pw2.value) throw new Error('The passwords do not match')
            if (mode.value === 'import') {
              if (!secret.value.trim()) throw new Error('Paste a seed phrase or a private key')
              await addAccount(engine.store, 'main', secret.value, pw.value)
              done()
              return
            }
            const phrase = newMnemonic()
            await addAccount(engine.store, 'main', phrase, pw.value)
            showPhrase(phrase)
          } catch (err) {
            msg.textContent = (err as Error).message
          }
        } },
        h('p', { class: 'lede' }, 'Your wallet is stored encrypted on this device with a password. Nothing is sent anywhere. A wallet made from a seed phrase has an address on every supported chain.'),
        h('label', { class: 'row' }, h('span', { class: 'label' }, 'Password'), pw),
        h('label', { class: 'row' }, h('span', { class: 'label' }, 'Repeat password'), pw2),
        h('label', { class: 'row', hidden: false }, h('span', { class: 'label' }, 'Seed phrase or key'), secret),
        msg,
        h('div', { class: 'actions' }, importBtn, submit),
      )
      secret.closest('label')!.hidden = true
      importBtn.addEventListener('click', () => (secret.closest('label')!.hidden = mode.value === 'create'))
      replace(root, h('div', { class: 'desktop' }, h('section', { class: 'window wizard', 'aria-labelledby': 'w2' }, titlebar('Set up your wallet'), h('div', { class: 'wizard-body' }, h('h1', { id: 'w2' }, 'Create or import a wallet'), form))))
      pw.focus()
    }

    const showPhrase = (phrase: string) => {
      const ok = h('input', { type: 'checkbox', id: 'wrote', onChange: () => (go.disabled = !ok.checked) })
      const go = h('button', { class: 'btn primary', type: 'button', disabled: true, onClick: () => done() }, 'Open the wallet')
      replace(
        root,
        h(
          'div',
          { class: 'desktop' },
          h('section', { class: 'window wizard', 'aria-labelledby': 'w3' }, titlebar('Your seed phrase'), h('div', { class: 'wizard-body' },
            h('h1', { id: 'w3' }, 'Write this down and keep it offline'),
            h('p', { class: 'lede' }, 'It is the only backup of this wallet and is not shown again. Anyone who has these words can take everything in the wallet.'),
            h('ol', { class: 'phrase' }, phrase.split(' ').map((w) => h('li', {}, h('span', {}, w)))),
            h('label', { class: 'check', for: 'wrote' }, ok, h('span', {}, 'I have written the words down somewhere safe.')),
            h('div', { class: 'actions' }, go),
          )),
        ),
      )
    }

    step(prefs().disclaimerAccepted ? 2 : 1)
  })
}

export function titlebar(title: string, ...extra: (Node | string)[]): HTMLElement {
  const bar = h('header', { class: 'titlebar' }, h('span', { class: 'mark' }), h('span', { class: 'title' }, title))
  append(bar, extra)
  const mark = bar.querySelector('.mark')!
  mark.innerHTML = icon('logo').innerHTML
  return bar
}

/** The window shown when a wallet exists but is locked. On Android a fingerprint can stand in for the password. */
export function unlockWindow(root: HTMLElement, names: string[]): Promise<string> {
  return new Promise((done) => {
    const msg = h('p', { class: 'form-error', role: 'alert' })
    const pw = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true })
    const which = h('select', { name: 'wallet', hidden: names.length < 2 }, names.map((n) => h('option', { value: n }, n)))
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Unlock')
    const finger = h('button', { class: 'btn', type: 'button', hidden: true, onClick: () => void byFingerprint() }, 'Use fingerprint')

    const unlockWith = async (password: string) => {
      await engine.unlock(which.value || undefined, password)
      done(which.value)
    }
    const byFingerprint = async () => {
      const wallet = which.value
      msg.textContent = ''
      finger.disabled = btn.disabled = true
      try {
        const r = await fingerprintPassword(wallet)
        if (r.ok) {
          try {
            return await unlockWith(r.password!)
          } catch {
            // The stored password no longer opens the wallet: drop it rather than keep failing.
            await disableFingerprint(wallet)
            finger.hidden = true
            msg.textContent = 'The password kept for the fingerprint no longer opens this wallet, so fingerprint unlock was turned off. Type the password; you can turn it on again in Settings.'
          }
        } else if (r.reason === 'invalidated') {
          finger.hidden = true
          msg.textContent = `${r.message}. Type the password; you can turn it on again in Settings.`
        } else if (r.reason !== 'cancelled') msg.textContent = r.message ?? 'Fingerprint unlock failed. Type the password.'
      } catch (err) {
        msg.textContent = (err as Error).message
      }
      finger.disabled = btn.disabled = false
      pw.focus()
    }
    /** Offers the fingerprint when it is on for the chosen wallet, and asks for it straight away. */
    const offerFingerprint = async (ask: boolean) => {
      const { enabled } = await fingerprintStatus(which.value).catch(() => ({ enabled: false }))
      finger.hidden = !enabled
      if (enabled && ask) void byFingerprint()
    }
    which.addEventListener('change', () => void offerFingerprint(true))

    const form = h(
      'form',
      { class: 'form', onSubmit: async (e: Event) => {
        e.preventDefault()
        msg.textContent = ''
        btn.disabled = true
        try {
          await unlockWith(pw.value)
        } catch (err) {
          msg.textContent = (err as Error).message
          btn.disabled = false
          pw.select()
        }
      } },
      names.length > 1 ? h('label', { class: 'row' }, h('span', { class: 'label' }, 'Wallet'), which) : null,
      h('label', { class: 'row' }, h('span', { class: 'label' }, 'Password'), pw),
      msg,
      h('div', { class: 'actions' }, finger, btn),
    )
    replace(root, h('div', { class: 'desktop' }, h('section', { class: 'window wizard narrow', 'aria-labelledby': 'u1' }, titlebar('chainer'), h('div', { class: 'wizard-body' }, h('h1', { id: 'u1' }, 'Unlock your wallet'), form))))
    pw.focus()
    void offerFingerprint(true)
  })
}
