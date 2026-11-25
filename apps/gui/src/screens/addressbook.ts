import { h, replace, shortAddress } from '../dom.ts'
import { engine } from '../engine.ts'

/** Named recipient addresses, each tied to the chain it was checked against. */
export async function addressBookScreen(sheet: HTMLElement): Promise<void> {
  const chains = await engine.pickerChains()
  const all = await engine.chains()
  const nameOf = (key: string) => all.find((c) => c.key === key)?.name ?? key
  const err = h('p', { class: 'form-error', role: 'alert' })
  const list = h('div', { class: 'table-wrap' })

  const label = h('input', { name: 'label', id: 'ab-label', placeholder: 'cold-storage', autocomplete: 'off', required: true })
  const chain = h('select', { name: 'chain', id: 'ab-chain' }, chains.map((c) => h('option', { value: c.key }, c.name)))
  const address = h('input', { name: 'address', id: 'ab-address', placeholder: 'address on that chain', autocomplete: 'off', spellcheck: 'false', required: true })

  const draw = async () => {
    const entries = await engine.addressBook()
    if (entries.length === 0) return replace(list, h('p', { class: 'empty' }, 'The address book is empty. Saved addresses can be used as the recipient of a transfer by typing their label.'))
    replace(
      list,
      h(
        'table',
        { class: 'data' },
        h('caption', { class: 'sr-only' }, 'Saved addresses'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Label'), h('th', { scope: 'col' }, 'Chain'), h('th', { scope: 'col' }, 'Address'), h('th', {}, h('span', { class: 'sr-only' }, 'Remove')))),
        h('tbody', {}, entries.map((e) => h('tr', {}, h('th', { scope: 'row' }, e.label), h('td', {}, nameOf(e.chainKey)), h('td', { class: 'mono', title: e.address }, shortAddress(e.address)), h('td', { class: 'num' }, h('button', { class: 'btn small', type: 'button', onClick: async () => { await engine.removeAddress(e.label, e.chainKey); void draw() } }, 'Remove'))))),
      ),
    )
  }

  const form = h(
    'form',
    { class: 'form', onSubmit: async (ev: Event) => {
      ev.preventDefault()
      err.textContent = ''
      try {
        await engine.addAddress(label.value, chain.value, address.value.trim())
        label.value = ''
        address.value = ''
        void draw()
      } catch (e2) {
        err.textContent = (e2 as Error).message
      }
    } },
    h('label', { class: 'row', for: 'ab-label' }, h('span', { class: 'label' }, 'Label'), label),
    h('label', { class: 'row', for: 'ab-chain' }, h('span', { class: 'label' }, 'Chain'), chain),
    h('label', { class: 'row', for: 'ab-address' }, h('span', { class: 'label' }, 'Address'), address),
    err,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save address')),
  )

  replace(sheet, h('h1', { class: 'sheet-title' }, 'Address book'), h('fieldset', { class: 'group' }, h('legend', {}, 'Add an address'), form, h('p', { class: 'hint' }, 'An address is only saved if it is valid on the chain you pick. A label can hold a different address on each chain.')), list)
  void draw()
}
