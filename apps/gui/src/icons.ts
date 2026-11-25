/** Drawn for this app: 16px grid, 1.5 stroke, round caps. One family, no glyph stand-ins. */
const wrap = (body: string) =>
  `<svg class="icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const icons = {
  balances: wrap('<rect x="2" y="3" width="12" height="3" rx="0.5"/><rect x="2" y="7" width="12" height="3" rx="0.5"/><rect x="2" y="11" width="12" height="3" rx="0.5"/>'),
  transfer: wrap('<circle cx="3.5" cy="8" r="1.8"/><circle cx="12.5" cy="8" r="1.8"/><path d="M5.8 8h4.4M8.6 5.8L10.4 8 8.6 10.2"/>'),
  settings: wrap('<path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/>'),
  sweep: wrap('<path d="M2.5 4h6M2.5 8h6M2.5 12h6"/><path d="M10 8h4M12 6l2 2-2 2"/>'),
  plan: wrap('<circle cx="3" cy="8" r="1.6"/><circle cx="8" cy="4" r="1.6"/><circle cx="13" cy="8" r="1.6"/><circle cx="8" cy="12" r="1.6"/><path d="M4.4 7.2l2.2-2M9.4 4.8l2.2 2M11.8 9.2l-2.2 2M6.4 10.8l-2.2-2"/>'),
  saved: wrap('<path d="M4 2.5h8v11l-4-2.8-4 2.8z"/>'),
  clock: wrap('<circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2.2 1.6"/>'),
  book: wrap('<path d="M3 3.5A1.5 1.5 0 014.5 2H13v11H4.5A1.5 1.5 0 003 14.5z"/><path d="M3 3.5v11M6 5.5h4"/>'),
  history: wrap('<path d="M2.5 8a5.5 5.5 0 105.5-5.5"/><path d="M2.5 3v3h3M8 5v3.2l2 1.4"/>'),
  lock: wrap('<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5.2a2.5 2.5 0 015 0V7"/>'),
  refresh: wrap('<path d="M13 8a5 5 0 11-1.6-3.7M13 2.5v2.8h-2.8"/>'),
  warn: wrap('<path d="M8 2.5l6 10.5H2z"/><path d="M8 7v2.6M8 11.4v.1"/>'),
  check: wrap('<path d="M3 8.5l3.2 3L13 4.5"/>'),
  cross: wrap('<path d="M4 4l8 8M12 4l-8 8"/>'),
  arrow: wrap('<path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5"/>'),
  logo: `<svg class="icon logo" viewBox="0 0 32 32" width="20" height="20" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 21l6-10 8 8"/></g><g fill="currentColor" stroke="var(--logo-edge, #26306b)" stroke-width="1.6"><circle cx="9" cy="21" r="3.4"/><circle cx="15" cy="11" r="3.4"/><circle cx="23" cy="19" r="3.4"/></g></svg>`,
}

export function icon(name: keyof typeof icons): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'icon-wrap'
  span.innerHTML = icons[name]
  return span
}
