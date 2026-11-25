# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain TypeScript with Vite for the UI layer, no UI framework (user's choice, 25 Nov 2026). Runs inside a Tauri shell (desktop first, then Android) and talks to the shared TypeScript core in `packages/core`. Both themes are CSS only.

## Users

Self-custody holders: people who keep crypto in their own wallet, not on an exchange, and want to move it between chains cheaply and safely. In practice the project owner and similar users, comfortable with wallets and seed phrases, on desktop and on a phone. Confirmed 25 Nov 2026; the GUI is not aimed at complete newcomers or only at power users.

## Product Purpose

Move tokens between blockchains over the best available route, without custody: the app never holds funds, needs no account with any service, and every transfer is signed by the user's own key. It compares routes from several non-custodial sources (LI.FI, Circle CCTP, THORChain, Maya, optionally Atomiq), shows what the user receives, what it costs and how long it takes, then runs the transfer and follows it to the end. Success is a transfer the user understood before confirming and could resume after a crash or a closed laptop.

## Positioning

Only non-custodial, account-free routes, ranked by what actually arrives after gas and fees; multi-hop routes, whole-wallet sweeps, saved and scheduled routes, and a journal that makes every run resumable. Services with restricted regions are marked and need an explicit location confirmation. A neighbouring bridge aggregator that runs through one operator's frontend and account could not claim this.

## Operating Context

- The CLI (`chainer`) already implements everything: wallets, balances, quote, send, sweep, plans (pipelines), saved routes, schedules and a daemon, address book, gas top-up, transit wallets, geo confirmation, test mode. The GUI exposes the same functions; it does not invent new behaviour.
- Planned screens: Balances, Transfer (form, ranked routes, confirm, live progress), Bridge Wallet (token table with checkboxes and "select all"), Pipeline builder, Saved routes, Schedules, Address book, History, Settings.
- First launch: theme picker, then wallet setup, and the disclaimer text must be shown.
- Real transfers happen on main networks; a test mode maps them onto test networks with faucet funds, and the GUI should make test mode obvious.
- Runs can take from seconds to many minutes (slow bridges, Bitcoin confirmations), so progress and resumability are central.

## Capabilities and Constraints

- Wallet: BIP-39 seed (keys for every chain family) or one imported private key; local keys only, encrypted keystore, never logged or sent anywhere. WalletConnect is planned later.
- Chain families: EVM (many chains), Solana, Bitcoin-family (Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Dash).
- A confirmation before anything is signed shows route, fees and recipient; a dry-run mode stops before signing. The geo-restriction confirmation cannot be skipped.
- Settings include avoid list, RPC endpoint per chain, gas top-up (multiplier or fixed), hop limit, slippage, maximum amount per transfer, theme.
- Responsive: the same UI must work on a phone.
- No Monero, no proxy/VPN/Tor options, no mandatory fee, author disclaimed for losses (disclaimer text shown on first launch and in About).
- Undecided: WalletConnect UX, history/export format, desktop packaging beyond Linux.

## Brand Commitments

- Two themes, chosen on first launch and changeable later: an original "Retro" early-2000s desktop look (the default) and a plain modern theme. Retro must be an original design written for this project: no Microsoft names, logos, wallpapers, icons, sounds or fonts, no pixel copy of the Windows XP style, no XP.css.
- The product is called "chainer" (CLI command `chainer`, repository `web3_chainer`).
- Licence GPLv3.

## Evidence on Hand

- The working CLI and core, with live testnet runs documented in `docs/TESTNET.md` (direct CCTP, saved route, schedule).
- `docs/PLAN.md` (screens, themes, rules) and the README (usage, disclaimer, third-party services).
- No existing mockups, screenshots, logo or user testimonials. Do not fabricate any.

## Product Principles

1. The user's keys and funds never leave their control; the interface never suggests otherwise.
2. Show what arrives, not what is advertised: net amount, worst case, gas, time, and why a route was ranked first.
3. Nothing irreversible happens without one clear confirmation that states route, fees and recipient.
4. Long-running work must be visible and resumable; a closed window is not a lost transfer.
5. Say plainly what is risky or restricted (regions, test vs real, geo-restricted services) before it matters.

## Accessibility & Inclusion

No product-specific requirement beyond keyboard operation, legible text at the sizes it ships, and not relying on colour alone for state (run progress, errors, test mode).
