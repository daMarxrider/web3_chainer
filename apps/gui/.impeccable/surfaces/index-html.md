---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: []
---

# Surface brief: apps/gui (the chainer app)

Mode: Operate. Visitor: a self-custody holder moving funds between chains, on desktop first and on a phone. The first build is a vertical slice: shell, first launch, wallet unlock, Balances, Transfer (form, ranked routes, confirm, live progress), both themes.

## Task and constraints

- Task: see what the wallet holds, pick a transfer, compare ranked routes by what arrives, confirm once, watch it run, resume it later.
- The GUI exposes what the core and CLI already do; it adds no behaviour. Every state the CLI prints (geo confirmation, test mode, gas top-up, stop-over gas) has a place.
- Two themes on one DOM: Retro (default) and Modern. Themes are CSS only, chosen on first launch, changeable in Settings.
- Retro is original: no Microsoft names, logos, wallpapers, icons, sounds or fonts, no copy of the XP style, no XP.css. Modern is plain.
- Plain TypeScript and Vite, no UI framework. Responsive down to a phone.
- Unresolved: History and the other screens' layouts, WalletConnect, Android packaging.

## Direction contract

THESIS: The app is a workstation for moving money: a desk of real windows and instruments, where a route is read like a spec sheet and a transfer runs like a job on a status panel. It refuses the category default of a centred card with a token-swap widget and a big gradient button.

OWN-WORLD: Retro is a late-90s engineering workstation, not a game console: a mist-teal desktop with a faint tiled node-and-edge pattern, windows with 1px bevels (light top-left, dark bottom-right), indigo-to-steel title bars on a diagonal, cool grey-green window faces, recessed white fields, tabbed property sheets, a segmented status strip along the bottom (wallet, network mode, job state), amber and green LED lamps for state, tabular numerals everywhere, system font stack only. Modern is the same layout in flat light/dark neutrals, one blue accent, 8px radii, hairline borders. The window-and-sheet component language is recognisable with all content removed.

STORY: The user opens the app, understands which wallet and which network (real or test) they are on, picks tokens and a destination, reads three or four ranked routes as net amount, worst case, fees, time, and any region restriction, confirms once, and watches a job panel advance step by step; after a crash they reopen it and the job resumes.

FIRST VIEWPORT: A desktop with one main window: left a narrow sheet list (Balances, Transfer, History, Settings placeholders for later), right the Balances sheet showing the wallet's tokens in a recessed table with value and chain, and a Transfer button in the window's own toolbar; the status strip at the bottom shows wallet name, real/test mode and an idle job lamp. On a phone the same window fills the screen with the sheet list becoming a bottom tab strip.

FORM: Window-and-sheet workstation (Retro) with a flat-neutral twin (Modern); position 1 of 1, pinned by the brief: "default GUI theme is an original Retro look" and "modern theme selectable on first launch". seed: none (pinned)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
