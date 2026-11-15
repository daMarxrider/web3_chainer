# web3_chainer: cross-chain transfer optimiser (CLI + GUI)

## Context

The repo is empty. The goal is a tool that moves tokens from one blockchain to another automatically: it collects quotes from bridge aggregators, direct bridge protocols, liquidity networks and atomic-swap networks, picks the best route, signs and sends the transactions, tracks them until the funds arrive, and can chain several transfers so each leg starts when the previous one lands.

Decisions made with the user:

- **Trigger:** on-demand with best-route optimisation (cheapest or fastest), plus scheduled and conditional runs.
- **Tokens:** the destination token may differ from the source token. A saved "tokens to avoid" list is respected everywhere.
- **Chains:** EVM, Bitcoin-family, Solana, Lightning, Cosmos, as independent modules. A route only loads the modules it touches.
- **Permissionless rule:** only non-custodial services needing no account or KYC. Custodial exchangers are excluded. Services that need a free API key are built in but off by default.
- **Multi-hop:** if start and end have no direct connection, a route through intermediates is found automatically.
- **Chaining:** a pipeline of legs, each starting after the previous one completes.
- **Whole-wallet bridging:** every token or a selection ("select all" checkbox); several wallets supported.
- **Wallets:** the user chooses per wallet between local keys (seed or private key) and WalletConnect. Chains used only as a stop on the route get an auto-generated transit wallet.
- **Hands-off execution:** after one confirmation at the start, the whole run is automatic with a live status view in CLI and GUI.
- **Test mode:** a configured route can be tried on testnets where they exist.
- **Saved routes:** a route (including a whole-wallet sweep) can be worked out now and stored to run at a later time.
- **Form:** CLI and GUI. GUI defaults to a "Retro" early-2000s look, with a modern theme selectable on first launch.
- **Platforms:** Windows, Linux, macOS, Android (no iOS).
- **Install scripts:** one script per desktop system (Linux, macOS, Windows) that installs every dependency; none for Android.

## Status

- **Milestone 1: done** (core library and CLI for EVM chains through LI.FI).
- **Milestone 2: done** (chained transfers with resume, automatic multi-hop routing, live status, plan files, testnet mode).
- **Install scripts: written** for Linux, macOS and Windows. The Linux script passes in clean Arch, Debian, Ubuntu and Fedora containers (`scripts/test-install-linux.sh`). The macOS and Windows scripts have not been run: there is no Mac or Windows machine here.
- Milestones 3-9: not started.

Verified so far:

- unit tests (`npm test`), live quotes, a live balance scan;
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
- LI.FI's bridge allow-list defaults to all of its bridges, since every one is non-custodial and needs no account; `lifi.allowBridges` / `lifi.denyBridges` in the settings narrow it. The default deny list is `paxos` and `unit` (owner decisions).
- **Geo restrictions:** `packages/core/src/geo.ts` keeps, per LI.FI bridge key, the countries and regions its terms exclude (or the only country it allows), the terms it comes from and a note. A route that uses such a bridge needs a location confirmation: the user must accept a form stating that they are currently in none of the listed places (the CLI asks for a typed `yes`; `--yes` never skips it; test-network runs skip it). The accepted bridge keys are stored in the run (`geoAccepted`); a leg never picks a restricted bridge that is not in that list, so a changed route cannot slip through. Plans choose bridges at run time, so they ask once for all restricted bridges and carry on without them if declined; `chainer resume` asks again because the location may have changed. **The GUI must show the same form as a modal warning with the same text (`geoNotices`, `geoStatement`) and block the run until it is accepted; unattended scheduled runs may only use bridges whose confirmation is stored with the schedule and re-confirmed on each app start.** Keep `GEO_RESTRICTIONS` in step with the review table below. LI.FI's own US-person and sanctions rule applies to every route and is covered by the README notice, not by this form.

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
  - `evm` (viem), `solana` (@solana/kit), `bitcoin` (UTXO; also LTC, DOGE, BCH, DASH, ZEC transparent), `cosmos` (cosmjs), `lightning`.
- **`BridgeProvider`** (one per route source): `getQuotes(request)`, `buildActions(quote)`, `getStatus(transfer)`.
  - Actions are plain data ("sign this EVM tx", "send X to deposit address Y with memo Z"). Providers never touch keys.
  - Each provider declares: non-custodial, needs API key, needs helper daemon, platforms. A registry check enforces the permissionless rule.
- **`Signer`**: `LocalSigner` (keys in the app) or `WalletConnectSigner`. Adapters ask the signer; they do not know which kind it is.

### Route sources

| # | Source | Kind | Adds |
|---|---|---|---|
| 1 | LI.FI (bridge allow-list) | aggregator | EVM, Solana, Bitcoin, Sui, Tron |
| 2 | NEAR Intents 1Click | intents | BTC, ZEC, LTC, DOGE, XRP, TON, Cardano and more |
| 3 | THORChain | liquidity network | native BTC, LTC, DOGE, BCH (XMR filtered out) |
| 4 | Maya Protocol | liquidity network | Zcash, Dash, Arbitrum (shares code with THORChain) |
| 5 | Chainflip | liquidity network | native BTC, ETH, SOL |
| 6 | Circle CCTP, Across | direct bridges | cheap USDC, fast EVM |
| 7 | Garden Finance, Atomiq | atomic swaps via API/SDK | BTC <-> EVM, Solana, Starknet; work on Android |
| 8 | Boltz | atomic swaps via API | Lightning <-> BTC, Liquid, Rootstock, USDT |
| 9 | Skip Go | aggregator | Cosmos / IBC |
| 10 | BasicSwap, Komodo DeFi Framework | atomic swaps via helper daemon | UTXO coins (no Monero); desktop only unless a mobile build exists |
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
- **`settings`** (persisted): theme, tokens to avoid, address book (labelled addresses, validated against their chain), RPC endpoint per chain, destination gas top-up, API keys, hop limit, slippage, max amount per transfer.
- **Safety rails:** confirmation showing route, fees and destination before signing (`--yes` to skip), `--dry-run` that stops before signing.

### Settings options in detail

- **Own RPC nodes:** per-chain endpoint override; public defaults otherwise.
- **Destination gas top-up:** if the destination wallet has no native gas token, a small extra amount is routed into it.

### WalletConnect

Technically possible: the app acts as the dApp side, shows a QR code (GUI, and in the terminal for the CLI), and an external wallet signs. Limits to accept:

- It is optional: the user can always provide a private key or seed instead.
- Every transaction from the connected wallet is approved by hand. Transit wallets take over after the first leg, so a multi-hop run needs one approval per source token; scheduled runs cannot be unattended.
- Coverage is good for EVM and Solana, patchy for Bitcoin, none for Lightning.
- It depends on the Reown relay and needs a project ID, which requires a free registration. The ID is a setting, with the same "needs an account" warning as API keys.

## Left out on purpose

Decided on 14 Nov 2026 to keep the legal risk for the author low:

- **Monero is not supported**, as source, destination or stop-over. Route sources that list it (THORChain once its pool is live, BasicSwap) must have XMR filtered out by a built-in rule the user cannot switch off; eigenwallet (BTC <-> XMR only) is not integrated.
- **No proxy, VPN or Tor support.** The app has no proxy setting and does not install, bundle or start any of them. The proxy setting built in milestone 1 was removed. Anyone who wants one sets it up on their own system, outside the app.
- **The default theme is "Retro"**, an original early-2000s desktop look written for this project. It uses no Microsoft names, logos, wallpapers, icons, sounds or fonts, does not copy the Windows XP visual style pixel for pixel, and does not use the XP.css library.
- **Disclaimer.** The README and `chainer --help` state that the author is not liable for losses from bugs or misuse; the GUI must show the same text on first launch and in its About screen.
- **The README says so.** Its "Not supported, and why" section lists Monero and built-in proxy, VPN or Tor routing with the reason, so users are not left guessing. It gives no instructions or hints for doing either outside the app.
- Wording everywhere stays functional (cost, speed, self-custody); never "anonymous" or "untraceable".

Atomic-swap daemons (BasicSwap, Komodo DeFi Framework) are wrapped as helper processes, not reimplemented; swaps take tens of minutes to hours and must stay online until completion or refund, so they are marked slow and the GUI warns before starting. Their automation APIs, maintenance state and licences are checked when that milestone starts.

## Third-party terms

Checked on 14 Nov 2026 for everything the app uses at that point:

- **npm packages** (viem, @scure/bip39, yaml, TypeScript and their dependencies): all MIT, ISC or Apache-2.0, which are compatible with GPLv3.
- **LI.FI** (terms dated 4 Sep 2025): keyless use of the public API is allowed within its limits. Users must not be US persons or sanctioned (sections 2.5, 2.6). Whoever integrates it must tell users that the integration is independent of LI.FI, that the contracts are non-custodial and that LI.FI does not warrant third-party contracts (2.2), is responsible for legal compliance (2.4), must remove the integration on reasonable request (2.8), and indemnifies LI.FI against claims from its use (4.1). The README carries the required notice; the GUI must show it too. LI.FI's commercial API (with a key) is for companies only, not private individuals.
- **PublicNode** (default RPC for several chains): automated access and use inside applications are allowed; reselling access and evading rate limits are not.
- **mempool.space** (default Bitcoin and testnet4 data and broadcast API, Esplora-compatible): Terms of Service updated 10 Jul 2024 (source file `frontend/src/app/components/terms-of-service` in the `mempool/mempool` repository, because the served page is a script-rendered shell). The terms cover the website and its API as one "Website", offered as is, with no warranty or liability; they contain no rate-limit, automation or country rule for API reads, only a sanctions-country exclusion for the paid Accelerator. Allowed. The software is AGPL; the app only calls the public API.
- **litecoinspace.org** (default Litecoin API): runs the same open-source software as mempool.space; the served terms page could not be read (script-rendered shell) and the operator's own text may differ. Kept as the default under the owner's rule that missing or unreadable terms do not restrict use; recheck when terms are next reviewed. Blockstream's `blockstream.info` was not added because its terms page could not be read either and one default is enough.
- **THORChain** (direct route source, milestone 3): the Terms of Use of 19 Jan 2026 (`thorchain.org/terms-of-use`, saved in `docs/terms-evidence/thorchain/`) cover only the thorchain.org site and the swap.thorchain.org interface; they say expressly that they do not apply to the protocol, public networks, wallets or nodes. The app calls a public THORNode (`gateway.liquify.com/chain/thorchain_api`, named in the THORChain developer docs) and sends deposits to the vault addresses it lists. Liquify publishes no terms (saved in `docs/terms-evidence/liquify/`); its documented limit is 50,000 requests per day per IP, no key. Allowed. A custom node can replace it via `chainer config` later (not built yet).
- **Maya Protocol** (direct route source): no terms, legal or privacy page on `mayaprotocol.com`, `docs.mayaprotocol.com` or `mayascan.org` (saved in `docs/terms-evidence/maya/`); the node API (`mayanode.mayachain.info`) has none either. Under the owner's rule it stays included. Revisit if terms appear. Its pools are thin (a test quote of 0.1 ETH to BTC showed 34 % slippage), so it rarely wins a ranking; ARB and DASH/ZEC pools are its reason to exist.
- **Solana public RPC** (`api.mainnet-beta.solana.com`, `solana-rpc.publicnode.com`, the endpoints LI.FI lists): not yet reviewed, same open task as the EVM public RPC endpoints (open task 2, legal work for the next session).
- **npm packages added for Solana and Bitcoin** (@solana/kit, @solana-program/system, /token, /memo, @scure/btc-signer, @scure/bip32, @noble/curves, @noble/hashes, @scure/base): MIT or Apache-2.0, compatible with GPLv3.
- **Install and test tooling** (Node.js, Homebrew, winget, distribution packages, Docker Hub base images): installed or downloaded on the user's machine, never redistributed by this project.

### LI.FI bridge terms review

LI.FI lists 38 bridges (`https://li.quest/v1/tools`). They are reviewed in batches. Decided by the project owner: a bridge whose terms are missing, unpublished or undocumented stays in the default allow-list (no terms means no restriction on contract use); only terms that actually forbid this kind of use would exclude one. All 38 are now reviewed; the default list is every bridge not marked Excluded or Pending.

| Bridge (LI.FI key) | Terms read | Verdict | Notes |
|---|---|---|---|
| Arbitrum Bridge (`arbitrum`) | Offchain Labs Terms of Service, revised 11 Mar 2026 (`arbitrum.io/tos`) | Allowed | 18+, sanctions compliance (OFAC, HMT; embargoed regions), no US-person ban, no account or KYC, non-custodial, Offchain Labs takes no fee on the bridge. The terms govern Offchain Labs' website interface, APIs and SDKs; the app only calls the public bridge contracts via LI.FI and never uses their website. Broad user indemnity (section on Indemnification) and "scrape" ban apply to their site content, not to contract calls. Binding arbitration, New Jersey. The non-circumvention clause only applies after Offchain Labs blocks a user. |
| Across (`across`) | Risk Labs Terms of Service, dated 21 Oct 2026 (`across.to/terms-of-service`) | Allowed, only through LI.FI | Operator Risk Labs (Cayman foundation). Adults only; no sanctioned persons or restricted territories (US comprehensive sanctions); no US-person ban; no account or KYC; non-custodial; trade fees go to LPs and relayers, not Risk Labs. Section 4.1 bans using a VPN or anonymiser to get around such restrictions (consistent with the no-proxy decision). Section 1.4 binds anyone who uses the Across API, SDKs or tooling: end-user terms incorporating theirs, attribution, a revenue share on collected fees, no competing service. The app does not call the Across API, only LI.FI, so 1.4 binds LI.FI, not this project. A direct Across integration would fall under 1.4 and needs a separate review first. $100 liability cap, indemnity, JAMS arbitration in New York. |
| Gnosis Bridge (`gnosis`) | Gnosis Ltd "Terms of use" (`docs.gnosischain.com/terms-conditions`, April 2023), the only terms linked from `bridge.gnosischain.com`; bridge decision log (`docs.gnosischain.com/bridges/management/decisions`, updated 29 Oct 2026) | Allowed | The linked terms cover only the docs website ("the Site"), not the bridge or its contracts, so no terms bind a contract-only user; the bridge is run by a governance board through Safe multisig transactions. No account, KYC, age or location rule that reaches the app. Operational risk, not legal: the governance board halted outflows (Gnosis Chain to Ethereum, about 21 major tokens plus xDAI) on 3 Nov 2025 (until 7 Nov) and 1 Jun 2026 (until 3 Jun) after unrelated exploits, and two validator keys were compromised in 2026 (Apr, Jun). Transfers through it can therefore be delayed or frozen. |
| Omni Bridge (`omni`) | None found: no web app URL, no operator named and no terms in the NEAR docs or the `Near-One/omni-bridge` repo (MIT licence) | Allowed (no terms exist) | Nothing to review. The app domains tried (`omni.bridge`, `app.omni.bridge`) do not resolve. Decided by the project owner: no terms means no restriction on contract use. Revisit if the operator publishes terms. |
| Celer: CCTP + Celer Standard / Fast (`celercircle`, `celercirclefast`) | None published: the footer "Terms" and "Privacy" labels on `celer.network` do nothing, and the only PDF found (`celer.network/doc/tos.pdf`) now returns 404; the Internet Archive copy of 22 Oct 2021 holds website terms of use only, with no country list or bot clause | Allowed (no terms exist) | No cBridge or Celer IM terms exist to read. Decided by the project owner: no terms means no restriction on contract use. The USDC leg also falls under Circle's CCTP terms, reviewed with `cctp`. |
| Allbridge (`allbridge`) | Allbridge Terms and Conditions, 9 Jun 2023 (`allbridge.io/assets/docs/Allbridge - Terms and Conditions.pdf`); the Core app links no terms | Allowed | Singapore company, 18+, Singapore law and courts, no KYC, no US-person ban, no explicit sanctions clause, $-cap of fees paid in 6 months. Section 16.1.5 bans bots and automated devices used to "exploit the Services and Website", and "Services" includes the bridge, read literally this could cover an automated client; the project owner decided it is meant against misuse ("exploit"), not against ordinary use of the bridge contracts, so it stays in. The document predates a July 2026 incident after which Allbridge discontinued its liquidity pools (transfers now run via Circle CCTP v2, xReserve and LayerZero OFT) and may be stale. |
| Squid (`squid`) | Ceiba Network Inc. Terms of Service, effective 4 Aug 2026 (`squidrouter.com/terms`) | Allowed, only through LI.FI | "Services" means Ceiba's API and SDK, so the terms bind whoever calls that API, here LI.FI, not this project. 18+; sanctions lists (UN, Panama, US, UK, EU...) and embargoed Cuba, Iran, North Korea, Syria; no US-person ban; non-custodial; section 3.6(xii) bans bots or tools other than Ceiba's own software, which again binds the API caller. Broad indemnity, claims time-barred after 6 months, CECAP arbitration in Panama City under Panama law. A direct Squid integration would need its own review. |
| Mayan Swift and Wormhole (`mayan`, `mayanWH`) | Sand Lake Labs, Ltd. (Mayan Finance) Terms of Service, August 2025 (`mayan.finance/terms-of-use`) | Allowed | Terms cover the website "Interface"; the Protocol (contracts, some proprietary) is separate and "one, but not the exclusive, means" of access. 18+; no sanctioned persons or US-sanctioned territories; no KYC; non-custodial; no bot clause. $100 cap, broad indemnity, JAMS arbitration in New York. The site terms do not bind contract-only use. |
| CCTP + Mayan, CCTPv2 + Mayan (`mayanMCTP`, `mayanFastMCTP`) | Mayan terms as above; Circle's CCTP terms read with `cctp` | Allowed | Same reasoning as Mayan and `cctp`. |
| Stargate V2 Fast and Economy (`stargateV2`, `stargateV2Bus`) | Stargate Foundation Terms of Use, 17 Sep 2025 (`stargate.finance/terms`) | Allowed | Cover the website and its Aori-powered swap interface only; the protocol is source-available code on public chains. 18+; no sanctioned persons or comprehensive-sanctions territories; section 3 bans VPNs to dodge those limits (fits the no-proxy decision); no US-person ban; no KYC; non-custodial. Section 6(e) and (i) ban bots and scraping of the Website, and section 3 requires API rate limits and attribution for its API; the app does neither, it only calls contracts via LI.FI. $50 cap, indemnity, Cayman law, CI-MAC arbitration in Grand Cayman. |
| Circle CCTP (`cctp`) | Circle Technology Services MSA with CCTP Schedule, 6 Mar 2025 (`console.circle.com/legal/cctp-terms`); Circle USDC Bridge terms, 1 Sep 2026 (`circle.com/legal/usdc-bridge-terms`) | Allowed | The MSA binds Circle developer-console and API customers (onboarding, sanctions representations, no scraping or excessive load); the CCTP contracts are "not directly controlled by Circle" and are permissionless. Fast Transfer needs Circle onboarding (Fast Transfer Addendum 2(a)); that is between Circle and LI.FI, not this project. The USDC Bridge terms cover only Circle's own frontend (18+, sanctions, no VPN, $250 cap, JAMS New York); the app never uses it. Circle can change or end CCTP without notice (Schedule 1(i)) and can block wallet addresses (1(f)). |
| Symbiosis (`symbiosis`) | Symbiosis Foundation Terms of Use, "September 2026" (`symbiosis.finance/terms-of-use`) | Allowed | Cover the website-hosted Interface only; the protocol is open source and "not our proprietary property". 18+; the Interface bars US persons and restricted territories (Cuba, Iran, North Korea, Syria, Crimea) and VPN evasion, which binds Interface users, not contract calls via LI.FI. No KYC, no bot clause. No liability cap, broad indemnity, LCIA arbitration in London under Seychelles law; the document is internally inconsistent (two sections 4, no section 8, Cayman vs Seychelles). |
| Polygon PoS Bridge (`polygon`) | Polygon Labs UI (Cayman) Ltd. Terms of Use, 10 Nov 2026 (`polygon.technology/terms-of-use`) | Allowed | Cover Polygon Labs' Interfaces (Portal included) and Features (Agglayer, SDKs, APIs, widgets); Polygon Labs states it controls no blockchain or contract (2(a)). 18+; sanctions representations; no US-person ban; no KYC. Section 4(b) bans scraping the Interfaces with bots. $100 cap, broad indemnity, Cayman law and CIMAC arbitration. The app only calls the bridge contracts via LI.FI. |
| Glacis (`glacis`) | Glacis Labs, Inc. ZeroDelta Terms of Service, 24 Aug 2026 (`glacislabs.com/terms`) | Allowed | Cover website, docs and the ZeroDelta, AirLift and Glacis Core products "including interfaces, APIs, SDKs and smart contracts"; Core contracts are open source and their licence controls on conflict (10). 18+, sanctions bans, no US-person ban; KYB only for institutional features. Section 9 bans "automated means" to access the Services without consent; read literally this could reach contract calls, but the context is scraping and harvesting, so the project owner's rule applies and it stays in. $100 / 3-month-fees cap, indemnity, New York courts (no arbitration). |
| Chainflip (`chainflip`) | None found: `chainflip.io` links only a privacy policy and a legal notice (Chainflip Labs GmbH, Berlin, section 5 TMG); `swap.chainflip.io` shows no terms | Allowed (no terms found) | The legal notice is an imprint, not terms of use. Decided by the project owner: no terms means no restriction on contract use. Revisit if Chainflip publishes terms. The app does not integrate Chainflip directly yet (milestone 3). |
| GasZip (`gasZipBridge`) | Size Research, Inc. Terms of Service, 1 Feb 2024 (`gas.zip/terms-of-service`) | Allowed | Cover the Website only. They say the Website is for people "located in the United States" aged 18+ and ban robots and automatic devices on the Website; the contracts and the LayerZero transport are not covered. Odd for a global service, so it is a risk to watch, but it binds the site, not contract calls via LI.FI. No liability cap, indemnity, New York law, AAA arbitration at the company's option, 6-month claim deadline. |
| Relay (`relaydepository`) | Uneven Labs, Inc. Terms of Use, 9 Nov 2026 (`relay.link/terms`, text supplied by the project owner because the site blocks automated fetching) | Allowed, only through LI.FI | Cover the website, Relay APIs, RelayKit and Deposit Addresses; the open-source Relay Protocol is outside the conduct rules (2.3, 4.2 last sentence). 18+; sanctions and comprehensive-sanctions territories, no VPN evasion (1.2); no US-person ban; no KYC (API keys may need identifying info, 4.6); no general bot ban. Real points: Relay may block wallets and hold or refuse transactions on its own screening, with no reason given (1.3, 9.5); unsupported-exchange transfers can be unrecoverable (14.4). Section 1.1 says anyone using Relay through a Business User's product is bound by these Terms, and LI.FI is the Business User; a project that passes LI.FI routes on to its own users could count as a Downstream Integrator (4.4, 4.8: notice to users, flow-down terms, sanctions cooperation). That is a question for the LI.FI email. Section 4.7 bans collecting Relay quotes to rank providers or train routing, but showing a live quote beside others for a real transaction is allowed. $100 or fees-paid cap, Delaware law, AAA arbitration. A direct Relay API integration needs its own review. |
| Unit (`unit`) | Hyperunit Terms of Service, last revised Nov 2024 (`docs.hyperunit.xyz/legal/terms-of-service`) | Excluded (owner decision, 15 Nov 2026) | The Unit Protocol is a set of operator-run MPC vaults, so there is no permissionless contract path separate from the service, and the terms say they also govern protocol use (section 6). Prohibited Jurisdictions include the United States (1.1), enforced by IP geofencing and VPN blocking; section 2.4(c) bans bots and automation software, 2.4(g) scraping. Together that clearly forbids an automated client for US users, which a global app cannot exclude. The owner excluded it on a second ground: it is operator-run and not permissionless, which this project requires of every service. $100 cap, JAMS New York. |
| Polymer Fast and Standard (`polymer`, `polymerStandard`) | None found: no terms or legal link on `polymerlabs.org` or `docs.polymerlabs.org`; search only returns unrelated companies | Allowed (no terms found) | Standard is built on Circle CCTP (see `cctp`). Decided by the project owner: no terms means no restriction on contract use. Revisit if Polymer publishes terms. |
| Hyperliquid and Hyperliquid Native (`hyperliquidSA`, `hyperliquidNative`) | No readable terms: the docs legal pages (`hyperliquid.gitbook.io/.../terms-of-use`) return 404, the full docs export contains none, and `app.hyperliquid.xyz` is a script-rendered app whose terms I could not fetch | Allowed (no terms found) | Decided by the project owner: no terms means no restriction on contract use. Hyperliquid's own app may show a terms dialog I could not read; third-party Hyperliquid front ends (and Unit, see above) exclude US users, so expect similar wording. Revisit if the owner pastes the app's terms. |
| LI.FI Intents and Smart Deposits (`lifiIntents`, `smartDeposits`) | No separate terms: `li.fi/legal` lists only the T&C (4 Sep 2025), RWA supplement and Commercial API Terms (13 May 2026), and the intents docs name no terms for the order server (`order.li.fi`) | Allowed | Operated by LI.FI itself, so the same position as the LI.FI entry in this section applies; open task 3 (which LI.FI document governs a keyless client) and the planned LI.FI email cover it. Solvers fill the orders, so fill speed and availability depend on third parties. |
| Garden (`garden`) | Garden Finance Terms of Service, last updated 19 Nov 2025 (`garden.finance/terms.pdf`) | Allowed, with the geo-restriction confirmation | Cover the website and "Online Platform" only; Garden says it provides an interface to a decentralized protocol and holds no custody (3-6). The restricted-country list (8) is far wider than usual: United States, the European Union, Canada, China, Russia, UAE, Singapore, Hong Kong and others, and users must not use a VPN (21h). Read literally this bars the project owner (Germany) from Garden's platform; the app never uses that platform and only calls the protocol via LI.FI, so under the owner's rule it stays in. No bot clause. BVI law and courts, $100 cap, indemnity. The owner decided to keep it in with the location form: its geo entry (United States, EU, Canada and the rest of section 8) must be confirmed before every use. |
| MegaETH Gateway (`megaeth`) | None found: `docs.megaeth.com` has no legal pages; the pre-deposit site (`predeposit.megaeth.com`, which links a Terms of Use) returned 503 | Allowed (no terms found) | The canonical bridge is the OP Stack Standard Bridge. Decided by the project owner: no terms means no restriction on contract use. Operational note: the Nov 2025 pre-deposit bridge was refunded after a misconfigured multisig and cap resets. |
| Superset (`superset`) | Superset Protocol Labs LLC (the text also names Superset Technologies, Inc.) Terms, version 0.1, updated 20 Apr 2026 (`superset.finance/terms`) | Allowed | Cover the app.superset.finance Site and interface; the protocol is separate, open source and "as is". 18+; OFAC and comprehensive-sanctions bans; bars "a person barred from using Services under the laws of the United States" (1.6(d)(i)), not all US persons; no KYC beyond accurate registration data. Section 3.2(e) bans scrapers on the Site, 4(h) bans bypassing automated-access instructions. $100 cap, indemnity, NAM arbitration, Delaware law. The product may not be live yet (the site only offers contact forms). |
| Paxos Labs Transit (`paxos`) | Paxos Labs Inc. Terms of Use, "© 2025", no effective date (`paxoslabs.com/legal/paxos-labs-terms-of-use`) | Excluded (owner decision, 15 Nov 2026) | Cover the Website, Ancillary Services and the "Platform" ("our proprietary blockchain services"); Transit is not named anywhere in them. Prohibited Uses include robots and automatic devices and "unauthorized integrations or smart-contract calls" to the Services, which is the closest wording yet to a contract-call ban; "unauthorized" is undefined and Transit is not shown to be inside the Services, so it was a close call; the owner excluded it. It is in the default deny list. 18+; Cuba, Iran, North Korea, Syria, Russia and Crimea residents, sanctioned persons and crypto-restricting jurisdictions barred, no VPN; no US-person ban. $100 cap, broad indemnity, JAMS New York. |
| Layerswap (`layerswap`) | Layerswap Labs, Inc. Terms of Service, 5 May 2025 (`learn.layerswap.io/user-docs/more-information/terms-of-services`) | Allowed | Cover the website and App for transfers between blockchains and centralized exchanges; the terms do not mention contracts or an API. 18+; listed restricted states, OFAC, Commerce and EU lists, no VPN evasion; no US-person ban; no KYC. Section 2.v bans automated systems that send more requests than a human could with a normal browser; one swap per user action stays far below that. No liability cap, indemnity, Delaware law, AAA arbitration (30-day opt-out). Exchange legs carry the exchange's own terms and risks. |
| Frax Bridge (`frax`) | None found: no terms or legal page reachable on `frax.com` or in search | Allowed (no terms found) | Fraxferry is a permissioned bridge whose escrow contracts can be paused by its captain, first officer and owner (L2Beat), so transfers can be halted. Decided by the project owner: no terms means no restriction on contract use. Revisit if Frax publishes terms. |
| Centrifuge (`centrifuge`) | Centrifuge website Terms of Use (`centrifuge.io/terms`, undated), found with `curl` after the review's fetcher got HTTP 403 | Allowed | Cover the website and its subdomains only, which the terms call informational. They say purchases of tokens and pool investments need onboarding, that services may not be available in the reader's jurisdiction, and that the materials are not directed at people where that would break local law; no country list, no age or sanctions clause, no bot clause, no arbitration. Centrifuge says it does not originate assets or manage money; asset managers run the products, and those may carry their own investor restrictions that the bridge route does not remove. Evidence in `docs/terms-evidence/centrifuge/`. |
| Eco (`eco`) | Eco, Inc. Terms of Service, updated 23 Jul 2026 (`eco.com/legal/tos`) | Allowed | Cover only the eco.com site and docs. The Eco Protocol (Routes) has "separate licenses, terms, and disclosures", Eco Portal has its own terms, and APIs and SDKs need a separate Integration Agreement. 18+, sanctions bans, no US-person ban, no KYC, no indemnity. Section 3 bans automated scraping of the Site, section 8 bans circumventing rate limits. $100 cap, Delaware law, JAMS New York. A direct Eco integration would need the Portal and Integration Agreement terms read first. |
| M0 (`m0`) | M0 Foundation Website Terms of Use, last updated May 2024 (`m0.org/terms-of-use`); disclosures quoted from `docs.m0.org` (the pages returned 404 when fetched, see evidence) | Allowed | Swiss foundation. The terms cover only the M0 website and Governance Interface and say they do not apply to $M or the Protocol Actors; the Foundation did not deploy the protocol and anyone may call the contracts directly (3.2). Website users must not be in the listed Prohibited Jurisdictions (Belarus, Burundi, Central African Republic, Congo, Crimea, Donetsk, Luhansk, North Korea, Guinea, Guinea-Bissau, Iran, Iraq, Lebanon, Libya, Mali, Myanmar, South Sudan, Russia, Somalia, Sudan, Syria, Venezuela, Yemen, Zimbabwe) or under UN, US, EU or Swiss sanctions (1). No age, KYC, bot, indemnity or liability-cap clause (liability only for gross negligence and wilful misconduct, 7); Swiss law, arbitration in Zurich. The M0 docs say $M is not offered to US persons without an exemption and describe the protocol as a layer for permissioned institutional actors; moving the token is not restricted by anything read, but minting is not for the public. Evidence in `docs/terms-evidence/m0/`. |
| NEAR Intents (`near`) | Intents Technology Limited (BVI) 1Click API Terms of Use, 7 Oct 2026 (`docs.near-intents.org/.../1click-terms-of-service` and `.../security-compliance/terms-of-service`); the front-end terms at `near-intents.org/terms-of-service` are an empty application shell (see evidence) | Allowed, only through LI.FI | The terms bind registered API developers (API key, possible KYB, flow-down terms for their users, rate limits, no proxy or wrapper services, data caching of 24 hours at most, no AI training on the data, 2.7, 2.8, 4.1); end users are not parties (4.2, 19). The Protocol and front ends are separate; the PoA Bridge is run by Intents Technology (7.7). That binds LI.FI as the API caller, not this project, unless this project counts as a downstream distributor of LI.FI's routes (the same open question as Relay). Restricted Persons and Restricted Jurisdictions are barred and VPNs banned (9.1, 9.2), but the jurisdiction list sits in an access policy that is not published and can change without notice, so the geo entry uses the usual sanctioned list; every quote is screened against AML lists and may be refused. Fees are non-refundable even if a transaction fails (6.4). $1,000 or fees-paid cap, BVI law, BVIIAC arbitration, 12-month claim deadline. A direct NEAR Intents integration (milestone 3) needs its own review, including the 1Click terms' API-key and business-use requirements (9.3), which exclude private individuals. NEAR Intents halted service after a 3.8 million dollar loss in 2026. |

### Included services

Some bridges are in the default list because no terms could be read, not because terms were read and approved. Under the project owner's rule (no terms means no restriction on contract use) they stay included, and the saved responses in [`docs/terms-evidence/`](terms-evidence/README.md) are the justification: they show, with date and HTTP status, what was found when the terms were looked for. The same folder holds the copies for services whose terms were found only after a retry.

| Bridge (LI.FI key) | Why it is included | Evidence (`docs/terms-evidence/`) |
|---|---|---|
| Omni Bridge (`omni`) | No operator, no terms; app domains do not resolve | `omni/` |
| Celer (`celercircle`, `celercirclefast`) | Terms PDF returns 404; the archived 2021 copy covers the website only | `celer/` |
| Chainflip (`chainflip`) | Only an imprint; the swap app shows no terms | `chainflip/` |
| Hyperliquid (`hyperliquidSA`, `hyperliquidNative`) | Docs terms pages return 404; the app's terms are not in the response | `hyperliquid/` |
| MegaETH Gateway (`megaeth`) | Pre-deposit site paused (503); docs have no legal pages | `megaeth/` |
| Frax Bridge (`frax`) | Every path returns the same application shell | `frax/` |
| Polymer (`polymer`, `polymerStandard`) | No terms or legal link anywhere on the site or the docs | `polymer/` |
| Relay (`relaydepository`) | Terms page blocked automated reading; the owner supplied the 9 Nov 2026 text, which was read and recorded above | `relay/` |
| Centrifuge (`centrifuge`) | Terms found on retry; website-only | `centrifuge/` |

Recheck these when the project next reviews terms; if a service publishes terms that forbid this kind of use, it moves to the deny list.

Rule for later milestones: before a route source, daemon or library is integrated, its terms and licence are read and the result is added here; the README's third-party section lists every service the app contacts. Known in advance: the API-key services (1inch, Rango, SwapKit) have commercial terms that may exclude private individuals.

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

- First launch: theme picker (Retro default, Modern), then wallet setup.
- Screens: Balances, Transfer (form -> ranked routes -> confirm -> live progress), Bridge Wallet (token table with checkboxes and "select all"), Pipeline builder, Saved routes, Schedules, Address book, History, Settings.
- The README carries step-by-step usage for CLI and GUI plus one screenshot per theme (`docs/screenshots/`); the screenshots are retaken whenever a change alters how the GUI looks.
- Themes are CSS only: an original "Retro" stylesheet written for this project and a plain modern one; the choice is stored and changeable later.
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
- covers every dependency the project has at that point: Node.js and the npm packages now; later the Rust toolchain and the system libraries Tauri needs for the GUI, and the atomic-swap helper daemons;
- finishes by running the tests and `chainer --help` to confirm the setup works;
- is updated in the same commit as any change that adds a dependency.

## Milestones

1. **Core + CLI, EVM only:** workspace, multi-account wallet, settings store (incl. avoid list, RPC overrides), EVM adapter, LI.FI, optimizer for direct routes, `quote` and `send`, journal.
2. **Chaining and multi-hop:** pipeline engine, YAML plans, resume, graph search, live status view, test mode.
3. **More chains:** Solana and Bitcoin-family adapters; NEAR Intents, THORChain, Maya, Chainflip.
4. **Direct bridges and API atomic swaps:** CCTP, Across, Garden, Atomiq.
5. **Sweep, saved routes, address book, gas top-up, transit wallets, scheduler.**
6. **GUI:** Tauri app, both themes, all screens; desktop builds, then Android. README gets the GUI steps and a screenshot per theme.
7. **Daemon-based atomic swaps:** BasicSwap and Komodo wrappers (if maintained), with Monero filtered out.
8. **Lightning and Cosmos:** Lightning adapter + Boltz; Cosmos adapter + Skip Go.
9. **WalletConnect and API-key providers:** WalletConnect signer; 1inch Fusion+, Rango, SwapKit.

The install scripts are written right after milestone 2 for the current dependencies and extended in every later milestone that adds one.

Each milestone is usable by itself. The initial commit goes on a `main` branch (the repo currently sits on an empty `master`).

## Verification

- **Unit tests (`npm test`):** optimizer ranking, graph search and avoid list; pipeline state machine and resume-after-crash; sweep ordering and skip rules; saved routes (re-quote at run time, stop when the path is gone or below the minimum); scheduler conditions; provider responses mocked from recorded fixtures.
- **Live read-only tests:** real quotes from each provider for a few pairs; no funds needed.
- **Testnet end-to-end:** Sepolia -> Base Sepolia through CCTP and Across, including a two-leg pipeline and a sweep; Bitcoin testnet for the atomic-swap daemons where they support it.
- **Mainnet:** most sources have no usable testnet, so the final check per provider is a few dollars sent on mainnet by the user, first with `--dry-run`, then for real. This needs the user's funded wallet.
- **Transit wallet crash test:** kill the process right after a transit wallet is created and again after funds reach it; confirm the key is in the keystore and `pipeline resume` moves the funds on.
- **Install scripts:** `scripts/test-install-linux.sh` runs the Linux script on clean Arch, Debian, Ubuntu and Fedora systems. It needs no Docker or root: official base images are unpacked into folders and entered with `unshare` (util-linux, present on every distribution). Docker and Podman were not installed here, and `systemd-nspawn` needs root and is a separate package on Debian/Ubuntu. macOS and Windows need those systems or CI runners.
- **GUI:** `tauri dev` on Linux, walk the first-launch flow in both themes, run a testnet transfer and a sweep; then an Android build on an emulator or device.
