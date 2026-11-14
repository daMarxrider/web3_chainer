# web3_chainer: cross-chain transfer optimiser (CLI + GUI)

## Context

The repo is empty. The goal is a tool that moves tokens from one blockchain to another automatically: it collects quotes from bridge aggregators, direct bridge protocols, liquidity networks and atomic-swap networks, picks the best route, signs and sends the transactions, tracks them until the funds arrive, and can chain several transfers so each leg starts when the previous one lands.

Decisions made with the user:

- **Trigger:** on-demand with best-route optimisation (cheapest or fastest), plus scheduled and conditional runs.
- **Tokens:** the destination token may differ from the source token. A saved "tokens to avoid" list is respected everywhere.
- **Chains:** EVM, Bitcoin-family, Solana, Lightning, Cosmos, Monero, as independent modules. A route only loads the modules it touches.
- **Permissionless rule:** only non-custodial services needing no account or KYC. Custodial exchangers are excluded. Services that need a free API key are built in but off by default.
- **Multi-hop:** if start and end have no direct connection, a route through intermediates is found automatically.
- **Chaining:** a pipeline of legs, each starting after the previous one completes.
- **Whole-wallet bridging:** every token or a selection ("select all" checkbox); several wallets supported.
- **Wallets:** the user chooses per wallet between local keys (seed or private key) and WalletConnect. Chains used only as a stop on the route get an auto-generated transit wallet.
- **Hands-off execution:** after one confirmation at the start, the whole run is automatic with a live status view in CLI and GUI.
- **Test mode:** a configured route can be tried on testnets where they exist.
- **Saved routes:** a route (including a whole-wallet sweep) can be worked out now and stored to run at a later time.
- **Form:** CLI and GUI. GUI defaults to a Windows XP look, with a modern theme selectable on first launch.
- **Platforms:** Windows, Linux, macOS, Android (no iOS).
- **Install scripts:** one script per desktop system (Linux, macOS, Windows) that installs every dependency; none for Android.

## Status

- **Milestone 1: done** (core library and CLI for EVM chains through LI.FI).
- **Milestone 2: done** (chained transfers with resume, automatic multi-hop routing, live status, plan files, testnet mode).
- **Install scripts: written** for Linux, macOS and Windows. The Linux script passes in clean Arch, Debian, Ubuntu and Fedora containers (`scripts/test-install-linux.sh`). The macOS and Windows scripts have not been run: there is no Mac or Windows machine here.
- Milestones 3-9: not started.

Verified so far:

- unit tests (`npm test`), live quotes, a live balance scan, and all traffic through Tor;
- real signing and sending against a local test chain;
- real bridge transfers on testnets (14 Nov 2026): 5 USDC Arc Testnet -> Arbitrum Sepolia, and a two-leg plan Arc Testnet -> Arbitrum Sepolia, then Arc Testnet -> Base Sepolia. Token approval, sending, status tracking and the received amounts were confirmed by reading the destination balances;
- the multi-hop search against live data (it found Arc Testnet -> Base Sepolia -> Ethereum Sepolia).

Not yet done: any mainnet transfer (the user does these), and a live run where a leg forwards what the previous leg delivered, which needs gas ETH on a second testnet; the faucets for that require a mainnet balance or an account. That behaviour is covered by unit tests only.

Testing notes: Circle's faucet (faucet.circle.com) gives 20 test USDC per address every two hours without an account, and on Arc Testnet USDC is also the gas token, so one faucet request is enough to test from there. LI.FI allows 75 route searches and 50 transaction builds per two hours without an API key.

Deviations from the original plan, decided while building:

- npm workspaces instead of pnpm (pnpm is not installed; npm needs nothing extra).
- Node's built-in test runner instead of vitest, and Node runs the TypeScript directly, so there is no build step for the CLI.
- Test mode maps a route onto testnets only when every chain in it has one (currently Ethereum, Optimism, Arbitrum and Base, via their Sepolia networks); otherwise it says so and points to `--dry-run`, because a dry leg in the middle would leave later legs without funds. Test runs are journalled separately; the wallet is shared with mainnet.
- CLI names: `chainer pipeline run <plan.yaml>`, `chainer status [id]`, `chainer resume <id>`.
- LI.FI is queried through its multi-route endpoint (every bridge in one request); the transaction is only built for the route that is executed.
- LI.FI's bridge allow-list defaults to all of its bridges, since every one is non-custodial and needs no account; `lifi.allowBridges` / `lifi.denyBridges` in the settings narrow it.

## Stack

**TypeScript throughout**, in an npm workspace. Nearly every bridge SDK and chain library is TypeScript-first, and one codebase reaches every target:

| Part | Tech | Runs on |
|---|---|---|
| `packages/core` | Pure TS, no Node-only APIs (works in Node and in a webview) | everywhere |
| `apps/cli` | Node CLI over `core` | Windows, Linux, macOS, Android (via Termux) |
| `apps/gui` | React + Vite, packaged with **Tauri 2** | Windows, Linux, macOS, Android |

The Tauri Rust side stays a thin shell (proxied HTTP, secure storage, launching helper daemons); all logic lives in `core`.

Build caveat: macOS builds need a Mac or a macOS CI runner. Linux, Windows and Android can be built from this Arch machine or CI.

## Architecture (`packages/core`)

Three small interfaces carry the design:

- **`ChainAdapter`** (one per chain family): `getBalances`, `send(action)`, `waitForConfirmation`, `validateAddress`. Loaded lazily, so ETH -> Solana never touches Bitcoin code.
  - `evm` (viem), `solana` (@solana/kit), `bitcoin` (UTXO; also LTC, DOGE, BCH, DASH, ZEC transparent), `cosmos` (cosmjs), `lightning`, `monero` (monero-ts).
- **`BridgeProvider`** (one per route source): `getQuotes(request)`, `buildActions(quote)`, `getStatus(transfer)`.
  - Actions are plain data ("sign this EVM tx", "send X to deposit address Y with memo Z"). Providers never touch keys.
  - Each provider declares: non-custodial, needs API key, needs helper daemon, platforms. A registry check enforces the permissionless rule.
- **`Signer`**: `LocalSigner` (keys in the app) or `WalletConnectSigner`. Adapters ask the signer; they do not know which kind it is.

### Route sources

| # | Source | Kind | Adds |
|---|---|---|---|
| 1 | LI.FI (bridge allow-list) | aggregator | EVM, Solana, Bitcoin, Sui, Tron |
| 2 | NEAR Intents 1Click | intents | BTC, ZEC, LTC, DOGE, XRP, TON, Cardano and more |
| 3 | THORChain | liquidity network | native BTC, LTC, DOGE, BCH; XMR when its pool goes live |
| 4 | Maya Protocol | liquidity network | Zcash, Dash, Arbitrum (shares code with THORChain) |
| 5 | Chainflip | liquidity network | native BTC, ETH, SOL |
| 6 | Circle CCTP, Across | direct bridges | cheap USDC, fast EVM |
| 7 | Garden Finance, Atomiq | atomic swaps via API/SDK | BTC <-> EVM, Solana, Starknet; work on Android |
| 8 | Boltz | atomic swaps via API | Lightning <-> BTC, Liquid, Rootstock, USDT |
| 9 | Skip Go | aggregator | Cosmos / IBC |
| 10 | eigenwallet, BasicSwap, Komodo DeFi Framework | atomic swaps via helper daemon | Monero and UTXO coins; desktop only unless a mobile build exists |
| 11 | 1inch Fusion+, Rango, SwapKit | need API key | **off by default**; pasting a key shows a warning that it requires an account with that service |

Pools, assets and pairs are read from each source at runtime, not hard-coded. Excluded after research: AthanorLabs ETH-XMR (archived Sep 2026), Serai (testnet only), Haveno (arbitrated escrow, not atomic).

### Other pieces

- **`optimizer`**: builds a graph of (chain, token) nodes with provider edges and searches it up to a hop limit (default 3, configurable), preferring hub assets (USDC, ETH, BTC). Candidates are normalised to net amount received and total ETA, then ranked by `cheapest` or `fastest`. Direct and multi-hop routes compete in one ranking. Tokens on the avoid list are never used as an intermediate or a destination.
- **`pipeline`**: ordered legs; a multi-hop route is a pipeline the optimizer generated. A leg's amount is fixed or "everything the previous leg delivered". Each leg is re-quoted right before it runs, with a minimum-output guard for the whole route. Every state change is journalled before and after each on-chain action, so a crash or backgrounded phone resumes. If a middle leg fails, the journal shows where the funds sit and offers a re-route.
- **`sweep`** (whole-wallet bridging): lists a wallet's balances, the user selects all or some, each token becomes its own pipeline.
  - Target per run: one chosen token, or "same token where it exists on the destination" with a fallback.
  - Tokens whose fees exceed their value or that have no route are skipped and reported.
  - The native gas token goes last, with enough held back for the other transfers.
- **Saved routes:** any transfer, sweep or pipeline can be saved under a name instead of being run, e.g. "send my whole wallet from Arbitrum to Base".
  - A saved route stores the intent (wallet, source, destination, token selection, target token) and the chosen path (providers, bridges, intermediate hops), not the quote: prices and fees are re-quoted along that path when it runs.
  - Run it by hand (`chainer route run <name>`, a "Run" button), or attach it to the scheduler for a set time or condition.
  - Amounts are resolved at run time, so "whole wallet" means whatever the wallet holds then.
  - If the stored path is no longer available, or its result falls below a minimum the user set when saving, the run stops and says so; an optional setting lets it fall back to the best route at that moment.
  - Saved routes can be tried in test mode first.
- **`scheduler`**: run a transfer, sweep or pipeline at a time, on a repeat, or when a condition holds (e.g. total fees below a limit). Runs while the GUI is open or under `chainer daemon`; unattended runs need a local-key wallet.
- **`wallet`**: a list of accounts. Each is a BIP-39 seed, an imported private key, or a WalletConnect session. Local keys are stored encrypted (OS keystore in the GUI, encrypted keystore file in the CLI), never leave the device, never logged.
- **Transit wallets:** when a route passes through a chain where the user has no wallet (they gave only single-chain private keys, or use WalletConnect), the app generates a wallet for that chain before the run starts.
  - Only allowed when gas top-up is on for that chain, or the arriving asset is the chain's own gas token, so the wallet can always pay to move funds onward.
  - The key is written to the encrypted keystore and referenced in the journal **before** any funds are sent to it; a crash can never strand funds in an unknown wallet.
  - Transit wallets are never auto-deleted. They are listed with their balances, and leftover gas can be swept out.
  - Side benefit: with WalletConnect only the first leg needs a manual approval; later legs are signed by transit wallets.
  - Seed-based accounts already have an address on every chain, so they need no transit wallet.
- **Live status:** the pipeline emits events (quoting, signing, submitted with tx ID, confirmations, bridge in progress, arrived, failed, retrying). The CLI renders them as a live-updating leg list (plain line output with `--json` or when not a terminal); the GUI shows the same in a progress window. After the single upfront confirmation nothing else prompts, except WalletConnect approvals.
- **Test mode:** each provider and adapter declares its testnet (if any). `--testnet` / a "Test this route" button maps the configured route onto testnets and runs it for real with faucet funds. Legs with no testnet are shown as untestable and run as a dry-run (quote and build, no signing), so the user sees exactly which parts were exercised. Testnet and mainnet wallets, journals and history are kept separate.
- **`settings`** (persisted): theme, tokens to avoid, address book (labelled addresses, validated against their chain), RPC endpoint per chain, Tor/SOCKS proxy, destination gas top-up, API keys, hop limit, slippage, max amount per transfer.
- **Safety rails:** confirmation showing route, fees and destination before signing (`--yes` to skip), `--dry-run` that stops before signing.

### Settings options in detail

- **Tor / proxy:** all API and RPC traffic goes through a SOCKS proxy (system Tor, or Orbot on Android). Status polling uses HTTP so nothing bypasses the proxy. Helper daemons get the same proxy passed to their own Tor settings.
- **Own RPC nodes:** per-chain endpoint override; public defaults otherwise.
- **Destination gas top-up:** if the destination wallet has no native gas token, a small extra amount is routed into it.

### WalletConnect

Technically possible: the app acts as the dApp side, shows a QR code (GUI, and in the terminal for the CLI), and an external wallet signs. Limits to accept:

- It is optional: the user can always provide a private key or seed instead.
- Every transaction from the connected wallet is approved by hand. Transit wallets take over after the first leg, so a multi-hop run needs one approval per source token; scheduled runs cannot be unattended.
- Coverage is good for EVM and Solana, patchy for Bitcoin, none for Monero or Lightning.
- It depends on the Reown relay and needs a project ID, which requires a free registration. The ID is a setting, with the same "needs an account" warning as API keys.

## Monero

Working permissionless routes today are atomic swaps: **eigenwallet** (BTC <-> XMR) and **BasicSwap** (XMR against BTC, LTC, BCH, DASH, DOGE, FIRO, PIVX, DCR). Both are wrapped as helper daemons; their cryptography is not reimplemented. From an EVM token the optimizer builds a multi-hop such as token -> BTC -> XMR.

Constraints: swaps take tens of minutes to hours and must stay online until completion or refund, so they are marked slow and the GUI warns before starting. BasicSwap uses core wallets and is desktop-only. THORChain's XMR pool is code-complete but not live as of Nov 2026; it will appear automatically once it is.

To verify when the milestone starts: the automation APIs of eigenwallet (`swap-controller-api`) and BasicSwap, and Komodo's maintenance state.

## Interfaces

**CLI** (`chainer`):

- `chainer wallet init | import | connect | list | addresses | balances`
- `chainer quote 100 USDC arbitrum SOL solana [--prefer cheapest|fastest] [--max-hops 3]`
- `chainer send ...` same arguments, plus `[--to addr|label] [--dry-run] [--yes]`
- `chainer sweep arbitrum base [--all | --tokens USDC,ARB] [--into USDC | --same-token]`
- `chainer pipeline run plan.yaml | resume | status`
- `chainer route save <name> ... | list | show | run | remove` for saved routes
- `chainer schedule add | list | remove`, `chainer daemon`
- `chainer config ...` for settings, avoid list and address book
- `--wallet <name>` and `--json` on everything

**GUI:**

- First launch: theme picker (XP default, Modern), then wallet setup.
- Screens: Balances, Transfer (form -> ranked routes -> confirm -> live progress), Bridge Wallet (token table with checkboxes and "select all"), Pipeline builder, Saved routes, Schedules, Address book, History, Settings.
- Themes are CSS only: `XP.css` for the XP look and a plain modern stylesheet; the choice is stored and changeable later.
- Responsive layout so the same UI works on a phone.

## Install scripts

One script per desktop system sets up everything needed to build and run the project, so a fresh machine needs a single command. There is no script for Android.

| System | Script |
|---|---|
| Linux | `scripts/install-linux.sh` (detects pacman, apt or dnf) |
| macOS | `scripts/install-macos.sh` (uses Homebrew, installing it if missing) |
| Windows | `scripts/install-windows.ps1` (uses winget) |

Each script:

- installs what is missing and skips what is already there, so it is safe to run again;
- covers every dependency the project has at that point: Node.js and the npm packages now; later the Rust toolchain and the system libraries Tauri needs for the GUI, Tor for the proxy option, and the atomic-swap helper daemons;
- finishes by running the tests and `chainer --help` to confirm the setup works;
- is updated in the same commit as any change that adds a dependency.

## Milestones

1. **Core + CLI, EVM only:** workspace, multi-account wallet, settings store (incl. avoid list, RPC overrides, proxy), EVM adapter, LI.FI, optimizer for direct routes, `quote` and `send`, journal.
2. **Chaining and multi-hop:** pipeline engine, YAML plans, resume, graph search, live status view, test mode.
3. **More chains:** Solana and Bitcoin-family adapters; NEAR Intents, THORChain, Maya, Chainflip.
4. **Direct bridges and API atomic swaps:** CCTP, Across, Garden, Atomiq.
5. **Sweep, saved routes, address book, gas top-up, transit wallets, scheduler.**
6. **GUI:** Tauri app, both themes, all screens; desktop builds, then Android.
7. **Monero:** Monero adapter, eigenwallet and BasicSwap wrappers, Komodo if maintained.
8. **Lightning and Cosmos:** Lightning adapter + Boltz; Cosmos adapter + Skip Go.
9. **WalletConnect and API-key providers:** WalletConnect signer; 1inch Fusion+, Rango, SwapKit.

The install scripts are written right after milestone 2 for the current dependencies and extended in every later milestone that adds one.

Each milestone is usable by itself. The initial commit goes on a `main` branch (the repo currently sits on an empty `master`).

## Verification

- **Unit tests (`npm test`):** optimizer ranking, graph search and avoid list; pipeline state machine and resume-after-crash; sweep ordering and skip rules; saved routes (re-quote at run time, stop when the path is gone or below the minimum); scheduler conditions; provider responses mocked from recorded fixtures.
- **Live read-only tests:** real quotes from each provider for a few pairs; no funds needed.
- **Testnet end-to-end:** Sepolia -> Base Sepolia through CCTP and Across, including a two-leg pipeline and a sweep; Bitcoin testnet and Monero stagenet for the atomic-swap daemons where they support it.
- **Mainnet:** most sources have no usable testnet, so the final check per provider is a few dollars sent on mainnet by the user, first with `--dry-run`, then for real. This needs the user's funded wallet.
- **Transit wallet crash test:** kill the process right after a transit wallet is created and again after funds reach it; confirm the key is in the keystore and `pipeline resume` moves the funds on.
- **Proxy check:** with Tor enabled, confirm no request leaves outside the proxy (run with direct network access blocked).
- **Install scripts:** `scripts/test-install-linux.sh` runs the Linux script on clean Arch, Debian, Ubuntu and Fedora systems. It needs no Docker or root: official base images are unpacked into folders and entered with `unshare` (util-linux, present on every distribution). Docker and Podman were not installed here, and `systemd-nspawn` needs root and is a separate package on Debian/Ubuntu. macOS and Windows need those systems or CI runners.
- **GUI:** `tauri dev` on Linux, walk the first-launch flow in both themes, run a testnet transfer and a sweep; then an Android build on an emulator or device.
