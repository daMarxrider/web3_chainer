import { isFreezable, isNative, popularTokens, searchTokens, type Chain, type RatedToken, type Token, type TokenIndex } from '@chainer/core'
import { amount, h, replace } from './dom.ts'
import { engine } from './engine.ts'

export interface Held {
  token: Token
  balance: bigint
}

const TRUST_TAG: Partial<Record<RatedToken['trust'], [string, string]>> = {
  screened: ['not on list', 'Not on the Uniswap token list; LI.FI’s screening found nothing against it. Check the contract address.'],
  unknown: ['unchecked', 'Neither on the token list nor checked by LI.FI’s screening. Check the contract address.'],
  flagged: ['flagged', 'Flagged by LI.FI’s token screening as a likely scam. It cannot be sent from here.'],
}

const FREEZE_TAG = 'Its issuer can freeze or blacklist addresses holding it, which would lock the funds there.'

/**
 * What to tell the user about a token that is not on the list; nothing for listed tokens. Where the
 * list does not cover the chain (or could not be loaded), a token that passed LI.FI's screening is not
 * warned about: the list cannot say anything there, and a warning on every token would be ignored.
 */
export function trustNote(rated: RatedToken, chain: Chain, listCovers: boolean): string | undefined {
  if (rated.trust === 'listed') return undefined
  if (rated.trust === 'screened' && !listCovers) return undefined
  const where = `${rated.token.symbol} on ${chain.name} (${rated.token.address})`
  return rated.trust === 'screened' ? `${where} is not on the Uniswap token list. Make sure it is the token you mean.` : `${where} is neither on the token list nor checked by LI.FI. Make sure it is the token you mean.`
}

/**
 * A text field with a list of tokens under it: the chain's coin, majors and stablecoins when empty
 * (and what the wallet holds, for the sending side), matches by symbol, name or address while typing.
 * Tokens on the curated list come first; look-alikes are tagged; flagged ones are never offered.
 */
export function tokenPicker(opts: { id: string; name?: string; value?: string; placeholder: string; required?: boolean; label?: string }) {
  const listId = `${opts.id}-list`
  const input = h('input', {
    id: opts.id,
    name: opts.name,
    value: opts.value ?? '',
    placeholder: opts.placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
    required: opts.required,
    'aria-label': opts.label,
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
  })
  const list = h('ul', { id: listId, class: 'combo-list', role: 'listbox', hidden: true })
  const el = h('span', { class: 'combo' }, input, list)

  let chain: Chain | undefined
  let tokens: Token[] = []
  let index: TokenIndex | undefined
  let held: Held[] = []
  let chosen: RatedToken | undefined
  let shown: RatedToken[] = []
  let active = -1
  let loading: Promise<void> = Promise.resolve()
  /** Why this chain's tokens could not be read; shown in the list instead of an unexplained empty one. */
  let tokensProblem: string | undefined
  const cache = new Map<string, Token[]>()

  const nameOf = (t: Token) => {
    if (isNative(t)) return `${chain!.name}’s own coin`
    const name = index?.name(t, chain!) ?? t.name
    return name && name !== t.symbol ? name : ''
  }
  const heldOf = (t: Token) => held.find((x) => x.token.address.toLowerCase() === t.address.toLowerCase())

  const option = (r: RatedToken, i: number) => {
    const tag = TRUST_TAG[r.trust]
    const bal = heldOf(r.token)
    return h(
      'li',
      { id: `${listId}-${i}`, class: 'combo-option', role: 'option', 'aria-selected': 'false', 'aria-disabled': r.trust === 'flagged' ? 'true' : undefined, dataset: { index: String(i) } },
      h('span', { class: 'sym' }, r.token.symbol),
      h('span', { class: 'name' }, nameOf(r.token)),
      h('span', { class: 'tags' }, tag ? h('span', { class: 'tag', title: tag[1] }, tag[0]) : null, isFreezable(r.token) ? h('span', { class: 'tag', title: FREEZE_TAG }, 'freezable') : null),
      h('span', { class: 'bal' }, bal ? amount(bal.balance, bal.token) : ''),
    )
  }
  const group = (label: string) => h('li', { class: 'combo-group', role: 'presentation' }, label)

  const render = () => {
    if (!chain || !index) return
    const q = input.value.trim()
    const parts: (HTMLElement | string)[] = []
    shown = []
    for (const problem of [tokensProblem, index.problem]) if (problem) parts.push(h('li', { class: 'combo-empty', role: 'presentation' }, problem))
    const add = (rs: RatedToken[]) => rs.map((r) => (shown.push(r), option(r, shown.length - 1)))
    if (!q) {
      const mine = held.map((x) => ({ token: x.token, trust: index!.trust(x.token, chain!) }))
      const popular = popularTokens(tokens, chain, index).filter((r) => !heldOf(r.token))
      if (mine.length) parts.push(group('In your wallet'), ...add(mine))
      if (popular.length) parts.push(group(`Popular on ${chain.name}`), ...add(popular))
    } else {
      const found = searchTokens(tokens, q, chain, index)
      const firstOff = found.findIndex((r) => r.trust !== 'listed')
      const on = firstOff < 0 ? found : found.slice(0, firstOff)
      const off = firstOff < 0 ? [] : found.slice(firstOff)
      if (on.length) parts.push(...add(on))
      if (off.length) parts.push(group(index.covers(chain) ? 'Not on the token list' : 'No curated list for this chain'), ...add(off))
      if (!found.length) parts.push(h('li', { class: 'combo-empty', role: 'presentation' }, /^0x[0-9a-f]{40}$/i.test(q) ? 'Not in the token list; the address is looked up when you search routes.' : `No token matches "${q}" on ${chain.name}.`))
    }
    replace(list, ...parts)
    active = -1
  }

  const open = () => {
    render()
    list.hidden = list.childElementCount === 0
    input.setAttribute('aria-expanded', String(!list.hidden))
  }
  const close = () => {
    list.hidden = true
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
    active = -1
  }
  const highlight = (i: number) => {
    const options = [...list.querySelectorAll<HTMLElement>('.combo-option')]
    if (!options.length) return
    active = (i + options.length) % options.length
    for (const [n, o] of options.entries()) o.setAttribute('aria-selected', String(n === active))
    input.setAttribute('aria-activedescendant', options[active]!.id)
    options[active]!.scrollIntoView({ block: 'nearest' })
  }
  const pick = (i: number) => {
    const r = shown[i]
    if (!r || r.trust === 'flagged') return
    input.value = r.token.symbol
    close()
    picking = true
    input.dispatchEvent(new Event('input', { bubbles: true }))
    picking = false
    chosen = r
  }

  input.addEventListener('focus', () => void loading.then(open))
  let picking = false
  input.addEventListener('input', () => {
    if (picking) return
    chosen = undefined
    if (document.activeElement === input) void loading.then(open)
  })
  input.addEventListener('blur', close)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (list.hidden) open()
      highlight(active + (e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Enter' && !list.hidden && active >= 0) {
      e.preventDefault()
      pick(active)
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault()
      close()
    }
  })
  // mousedown, not click: the input keeps its focus, so blur does not close the list first.
  list.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const li = (e.target as HTMLElement).closest<HTMLElement>('.combo-option')
    if (li) pick(Number(li.dataset.index))
  })

  return {
    el,
    input,
    /** Whether the curated list says enough about the current chain to judge its tokens by it. */
    covers(): boolean {
      return !!(chain && index?.covers(chain))
    },
    /** Loads the tokens of another chain; a token picked on the old chain is forgotten. */
    setChain(next: Chain) {
      if (chain?.key !== next.key) chosen = undefined
      chain = next
      loading = (async () => {
        index = await engine.tokenIndex()
        tokensProblem = undefined
        const known = cache.get(next.key)
        if (known) tokens = known
        else {
          try {
            tokens = await engine.tokens(next)
            cache.set(next.key, tokens)
          } catch (err) {
            tokens = []
            tokensProblem = `Could not load the tokens of ${next.name}: ${(err as Error).message}`
          }
        }
      })()
      return loading
    },
    setHeld(next: Held[]) {
      held = next
    },
    /**
     * The token meant by the field: the one picked from the list, else the best-trusted token with
     * that symbol or address on the chain, else a lookup (for addresses the list does not have).
     */
    async resolve(text: string, missing: string): Promise<RatedToken> {
      await loading
      if (!chain || !index) throw new Error('The token list is not loaded yet')
      const t = text.trim()
      if (chosen && chosen.token.symbol === t) return chosen
      const best = searchTokens(tokens, t, chain, index).find((r) => r.token.symbol.toLowerCase() === t.toLowerCase() || r.token.address.toLowerCase() === t.toLowerCase())
      const flaggedOnly = tokens.some((x) => x.symbol.toLowerCase() === t.toLowerCase() && x.screening === 'flagged')
      if (best) return best
      if (flaggedOnly) throw new Error(`${t} on ${chain.name} is flagged by LI.FI’s token screening as a likely scam, so it is not sent from here.`)
      const token = await engine.token(chain, t).catch((err: Error) => {
        throw /\b404\b|could not find/i.test(err.message) ? new Error(missing) : err
      })
      const rated = { token, trust: index.trust(token, chain) }
      if (rated.trust === 'flagged') throw new Error(`${token.symbol} on ${chain.name} is flagged by LI.FI’s token screening as a likely scam, so it is not sent from here.`)
      return rated
    },
  }
}
