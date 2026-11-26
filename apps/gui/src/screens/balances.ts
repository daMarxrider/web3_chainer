import { amount, h, replace, shortAddress, usd } from '../dom.ts'
import { engine } from '../engine.ts'
import { icon } from '../icons.ts'
import { prefs, savePrefs } from '../prefs.ts'

/** Tokens the wallet holds on one chain. */
export async function balancesScreen(sheet: HTMLElement): Promise<void> {
  const chains = await engine.pickerChains()
  const remembered = prefs().lastChain
  const start = chains.find((c) => c.key === remembered) ?? chains.find((c) => c.key === (engine.testMode ? 'bast' : 'eth')) ?? chains[0]!

  const select = h('select', { name: 'chain', 'aria-label': 'Chain' }, chains.map((c) => h('option', { value: c.key, selected: c.key === start.key }, c.name)))
  const table = h('div', { class: 'table-wrap' })
  const note = h('p', { class: 'hint', role: 'status' })
  const receive = h('div', { class: 'address-card' })

  const load = async () => {
    const chain = chains.find((c) => c.key === select.value)!
    void savePrefs({ lastChain: chain.key })
    refresh.disabled = true
    replace(table, h('p', { class: 'empty' }, 'Reading balances…'))
    note.textContent = ''
    try {
      const address = engine.ownAddress(chain)
      const copy = h('button', { class: 'btn small', type: 'button', onClick: async () => {
        await navigator.clipboard.writeText(address)
        copy.textContent = 'Copied'
        setTimeout(() => (copy.textContent = 'Copy'), 1500)
      } }, 'Copy')
      replace(receive, h('span', { class: 'label' }, `Your address on ${chain.name}`), h('code', {}, address), copy)
      const held = await engine.balances(chain)
      note.textContent = `${engine.requireSession().walletName}, ${shortAddress(address)} on ${chain.name}`
      if (held.length === 0) return replace(table, h('p', { class: 'empty' }, `No tokens found on ${chain.name}.`))
      const total = held.reduce((s, x) => s + (x.token.screening === 'flagged' ? 0 : (x.usd ?? 0)), 0) // scam tokens often carry made-up prices
      replace(
        table,
        h(
          'table',
          { class: 'data' },
          h('caption', { class: 'sr-only' }, `Tokens held on ${chain.name}`),
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Token'), h('th', { scope: 'col', class: 'num' }, 'Balance'), h('th', { scope: 'col', class: 'num' }, 'Value'), h('th', { scope: 'col', class: 'addr' }, 'Contract'))),
          h('tbody', {}, held.map((x) => h('tr', {}, h('th', { scope: 'row' }, x.token.symbol, x.token.screening === 'flagged' ? h('span', { class: 'tag', title: 'Flagged by LI.FI’s token screening as a likely scam (often an unsolicited airdrop). Do not interact with it; it cannot be sent from here.' }, 'flagged') : null), h('td', { class: 'num' }, amount(x.balance, x.token)), h('td', { class: 'num' }, usd(x.usd)), h('td', { class: 'addr' }, x.token.address.startsWith('0x0000') ? 'native coin' : shortAddress(x.token.address))))),
          h('tfoot', {}, h('tr', {}, h('th', { scope: 'row', colspan: 2 }, 'Total on this chain'), h('td', { class: 'num' }, usd(total)), h('td', {}))),
        ),
      )
    } catch (err) {
      replace(table, h('p', { class: 'form-error', role: 'alert' }, `Could not read balances: ${(err as Error).message}`))
    } finally {
      refresh.disabled = false
    }
  }
  const refresh = h('button', { class: 'btn', type: 'button', onClick: () => void load() }, icon('refresh'), 'Refresh')
  select.addEventListener('change', () => void load())

  replace(
    sheet,
    h('h1', { class: 'sheet-title' }, 'Balances'),
    h('div', { class: 'toolbar' }, h('label', { class: 'inline' }, h('span', {}, 'Chain'), select), refresh),
    note,
    receive,
    table,
  )
  void load()
}
