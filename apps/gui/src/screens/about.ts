import { version } from '../../../../package.json'
import { h, replace } from '../dom.ts'
import { withTimeout } from '../engine.ts'
import { disclaimerBlock } from '../firstlaunch.ts'
import { checkForUpdate, RELEASES_URL } from '../update.ts'

/** A link the user copies: the app has no way to hand a page to the system browser. */
function copyable(url: string): HTMLElement {
  const copy = h('button', { class: 'btn small', type: 'button', onClick: async () => {
    await navigator.clipboard.writeText(url)
    copy.textContent = 'Copied'
    setTimeout(() => (copy.textContent = 'Copy'), 1500)
  } }, 'Copy')
  return h('span', { class: 'copyable' }, h('code', {}, url), copy)
}

/** Who makes the app, which version runs, whether a newer one is out, and the disclaimer. */
export function aboutScreen(sheet: HTMLElement): void {
  const result = h('div', { class: 'update-result', role: 'status' })
  const check = h('button', { class: 'btn primary', type: 'button', onClick: async () => {
    check.disabled = true
    replace(result, h('p', { class: 'hint' }, 'Asking GitHub for the latest release…'))
    try {
      const r = await checkForUpdate(version, withTimeout)
      if (!r.newer) replace(result, h('p', {}, `You have the latest version, ${version}.`))
      else replace(result, h('p', {}, h('strong', {}, `Version ${r.version} is out.`), ` You have ${version}. Download it from its release page:`), copyable(r.url))
    } catch (err) {
      replace(result, h('p', { class: 'form-error', role: 'alert' }, `The check failed: ${(err as Error).message}. Try again later, or look at the releases page yourself:`), copyable(RELEASES_URL))
    } finally {
      check.disabled = false
    }
  } }, 'Check for updates')

  replace(
    sheet,
    h('h1', { class: 'sheet-title' }, 'About'),
    h(
      'fieldset',
      { class: 'group' },
      h('legend', {}, 'chainer'),
      h(
        'dl',
        { class: 'summary' },
        h('dt', {}, 'Version'),
        h('dd', {}, h('span', { class: 'num' }, version)),
        h('dt', {}, 'Developer'),
        h('dd', {}, 'DaMarxrider'),
        h('dt', {}, 'Licence'),
        h('dd', {}, 'GNU GPL v3, free software'),
        h('dt', {}, 'Source'),
        h('dd', {}, copyable(`https://github.com/daMarxrider/web3_chainer`)),
      ),
      h('p', { class: 'hint' }, 'chainer holds your keys on this device only and needs no account with any service.'),
    ),
    h('fieldset', { class: 'group' }, h('legend', {}, 'Updates'), h('p', { class: 'hint' }, 'Compares this version with the latest release on GitHub. Nothing is downloaded or installed by the check.'), h('div', { class: 'actions start' }, check), result),
    h('fieldset', { class: 'group' }, h('legend', {}, 'Disclaimer'), disclaimerBlock()),
  )
}
