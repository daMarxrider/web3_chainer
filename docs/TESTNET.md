# Testing with testnet funds

How to get test funds and exercise every command without risking real money. Everything below was tried on 25 Nov 2026 unless it says "not tried".

## 1. Use a separate data folder and wallet

The CLI keeps wallets, settings and runs in one data folder (`CHAINER_HOME`). Use a dedicated one for testing so a test wallet never sits next to a real one:

```sh
export CHAINER_HOME=$HOME/.config/chainer-testnet
mkdir -p "$CHAINER_HOME" && chmod 700 "$CHAINER_HOME"
openssl rand -base64 18 > "$CHAINER_HOME/password"      # a throwaway password, test wallet only
export CHAINER_PASSWORD="$(cat "$CHAINER_HOME/password")"
chainer wallet init                                      # prints the seed phrase once
chainer wallet list                                      # your addresses on every chain
```

Never keep a real wallet's password in a file like this. `--testnet` runs are journalled apart from real ones, but the wallet itself is shared, so a separate folder is the safe habit.

Chain keys for test networks (use them as arguments with `--testnet`): `arct` Arc Testnet, `eths` Ethereum Sepolia, `arbs` Arbitrum Sepolia, `bast` Base Sepolia, `opst` OP Sepolia, `sold` Solana Devnet, `btct` Bitcoin Testnet4. `chainer chains --testnets` lists all.

## 2. Getting funds

### Circle testnet faucet: USDC, no account (tried, works)

- Page: `https://faucet.circle.com` (an anti-bot check runs invisibly; there was no challenge for a normal browser visit).
- Choose USDC (or EURC, cirBTC), pick the network, paste the address, press Send. **20 USDC per request, one request per asset and network every 2 hours.** The result page links the transaction.
- Networks: Arc Testnet, Ethereum Sepolia, Arbitrum Sepolia, Base Sepolia, OP Sepolia, Avalanche Fuji, Polygon Amoy, Unichain Sepolia, Linea Sepolia, Solana Devnet and about 25 more (the dropdown lists them).
- It sends **only stablecoins, never the chain's gas coin.** The exception is **Arc Testnet, where USDC is the gas token**, so one request there is enough to send transactions.
- For the faucet's API shape and the developer-console variant (native coins, but only for Circle Wallets): `https://developers.circle.com/api-reference/wallets/programmable-wallets/request-testnet-tokens`. It needs a Circle API key, so the app does not use it.

Confirm arrival:

```sh
chainer balances arct --testnet
```

### Gas coins on other test networks (not tried: these need an account, a captcha or mining)

You only need a gas coin on the **source** chain of a transfer. CCTP pays for the destination mint itself (Forwarding Service), so for CCTP tests Arc Testnet as the source is enough.

| Need | Option | What it asks for |
|---|---|---|
| Sepolia ETH | `https://sepolia-faucet.pk910.de` | Proof-of-work in the browser, no account |
| Sepolia ETH, Base / Arbitrum / OP Sepolia ETH | `https://www.alchemy.com/faucets/base-sepolia` (and the other chains), `https://faucet.quicknode.com`, `https://cloud.google.com/application/web3/faucet/ethereum/sepolia`, `https://console.optimism.io/faucet` | An account or sign-in with each provider |
| Chainlink faucets | `https://faucets.chain.link` | Wallet connection |

Pages load (HTTP 200) from the dev machine; their sign-in or mining steps are yours to do. Once you have Sepolia ETH, USDC on the L2s can also be had from Circle's faucet directly.

### Solana Devnet SOL (tried: needs your GitHub sign-in)

- `https://faucet.solana.com`: choose devnet, paste the address, pick 0.5, 1, 2.5 or 5 SOL, Confirm. Limit: 2 requests per 8 hours. **As of 25 Nov 2026 it answers "GitHub authentication is required",** so signing in with a GitHub account is a step only you can do. The RPC airdrop (`requestAirdrop` on `https://api.devnet.solana.com`) is closed.
- Devnet USDC: Circle faucet above, network "Solana Devnet" (its mint is `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).

### Bitcoin Testnet4 coins (tried: needs a mempool.space account)

- `https://mempool.space/testnet4/faucet`: amounts 5k, 50k or 500k sats to an address. The page says "To use the faucet, please sign up", so it needs a free account.
- Other faucets are listed on `https://bitcoinfaucet.uo1.net` and `https://coinfaucet.eu/en/btc-testnet4/` (not tried).
- Your testnet4 address is the `btct` column of `chainer wallet list --json`.

## 3. What was run, and what it showed

All with the testnet wallet above, funded with 20 USDC on Arc Testnet, LI.FI switched off (`"disabledProviders": ["lifi"]` in the test folder's `settings.json`) because LI.FI's testnet quotes are not realistic (it quoted 6.85 USDC out for 5 in) and would win the ranking over CCTP.

| Step | Command | Result |
|---|---|---|
| Quote | `chainer quote 5 USDC arct bast --testnet` | Direct CCTP fast and standard quotes (4.947 USDC out) |
| Direct CCTP, real | `chainer send 5 USDC arct bast --testnet --yes` | Approval, burn, attestation, mint on Base Sepolia in about 20 s; 4.94713 USDC arrived (checked with `chainer balances bast --testnet`) |
| Sweep, plan | `chainer sweep arct bast --testnet --dry-run` | Planned the whole USDC balance through CCTP |
| Saved route | `chainer route save t3 3 USDC arct bast --min 2.9`, then `chainer route run t3 --testnet --dry-run` and `--yes` | Saved, re-quoted along the saved path, ran for real, 2.94689 USDC arrived |
| Scheduler | `chainer schedule add t3 --at <past time>`, then `chainer daemon --once --testnet` | Ran the saved route unattended, schedule marked done |

Notes from these runs:

- Saved routes normally use main-network chain keys and `--testnet` maps `eth`, `opt`, `arb`, `bas` to their test networks. Arc has no main-network key here, so the route was saved with the test keys (`arct`, `bast`) directly and run with `--testnet`.
- "No gas top-up: no route for it" appeared because Base Sepolia ETH cannot be bought with test USDC; that message is expected on test networks.
- `schedule add` refuses `--testnet`; add the schedule without it and run the daemon with `--testnet`.

## 4. Not covered yet

- Atomiq: its liquidity-provider nodes timed out and its API answered 403 from the dev machine, so no quote was obtained. It needs Solana Devnet SOL and Testnet4 BTC above.
- Sweep and routes that stop on another chain (stop-over gas, transit wallets): needs gas coins on two test networks.
- THORChain, Maya and Solana / Bitcoin adapters live: need the Solana and Bitcoin test funds above.
