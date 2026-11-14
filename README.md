# web3_chainer

Moves tokens from one blockchain to another over the best available route, and follows the transfer until the funds arrive.

- **Finds the best route.** Compares every bridge it can reach for a transfer and ranks them cheapest or fastest. If two chains have no direct connection, it finds a route through other chains.
- **Chains transfers.** A plan can have several legs; each starts by itself once the previous one has arrived.
- **Permissionless only.** It uses only non-custodial services that need no account and no KYC. Your keys stay on your machine, encrypted.
- **Private if you want.** All traffic can go through Tor or another proxy.
- **Careful with funds.** Every step is written to a journal first, so a crash or a closed laptop never loses track of a transfer.

## Status

The command-line tool works today for EVM chains (Ethereum, Arbitrum, Base, Optimism, Polygon and about 55 more) through the [LI.FI](https://li.fi) bridge aggregator. It has been verified with real bridge transfers on test networks.

Still to come, in this order: Solana and Bitcoin, more route sources (NEAR Intents, THORChain, Maya, Chainflip, direct bridges, atomic swaps), whole-wallet bridging, saved routes and scheduling, the graphical app, Monero, Lightning and Cosmos, WalletConnect. The full plan and its progress are in [docs/PLAN.md](docs/PLAN.md).

> This is young software that moves real money. Try a route with `--dry-run` or `--testnet` first, and start with small amounts.

## Install

Clone the repository and run the script for your system. It installs every dependency (git, Tor, Node.js 24 or newer, the npm packages), runs the tests and adds the `chainer` command. It is safe to run again.

```sh
git clone https://github.com/daMarxrider/web3_chainer.git
cd web3_chainer
```

| System | Command |
|---|---|
| Linux (Arch, Debian, Ubuntu, Fedora) | `./scripts/install-linux.sh` |
| macOS | `./scripts/install-macos.sh` |
| Windows | `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1` |

The Linux script is tested on clean Arch, Debian, Ubuntu and Fedora systems. The macOS and Windows scripts have not been run on those systems yet.

On Android the command-line tool runs in [Termux](https://termux.dev) (`pkg install nodejs git`, then `npm ci` in the repository); there is no install script for it.

## Using the command line

### 1. Create or import a wallet

```sh
chainer wallet init        # new wallet; shows the seed phrase once, write it down
chainer wallet import      # or import a seed phrase or private key
chainer wallet list
```

The wallet is stored encrypted under a password you choose. You can add more wallets with `--name` and pick one per command with `--wallet`.

### 2. Look at what you have

```sh
chainer chains             # supported chains
chainer balances arbitrum  # your tokens on a chain
```

### 3. Compare routes

```sh
chainer quote 100 USDC arbitrum base             # same token on another chain
chainer quote 100 USDC arbitrum ETH optimism     # into a different token
chainer quote 100 USDC arbitrum base --prefer fastest
```

Nothing is sent. You get a table of routes with what you would receive, the worst case, gas and fees, and the expected time.

### 4. Send

```sh
chainer send 100 USDC arbitrum base
chainer send 100 USDC arbitrum base --to 0xRecipient...
chainer send 100 USDC arbitrum base --dry-run    # stops before signing
```

You confirm once. After that it runs by itself and shows live status until the funds have arrived.

### 5. Chain several transfers

Write a plan file:

```yaml
legs:
  - amount: 100
    from: USDC@arbitrum
    to: USDC@base
  - amount: all          # everything the previous leg delivered
    from: USDC@base
    to: ETH@optimism
```

```sh
chainer pipeline run plan.yaml --dry-run   # check it first
chainer pipeline run plan.yaml
```

### 6. Check on runs, or continue one

```sh
chainer status             # all runs
chainer status 8e96ae89    # one run in detail
chainer resume 8e96ae89    # continue a run that stopped or failed
```

Finished legs are never repeated. A leg that was interrupted in the middle of sending is never re-sent automatically; `resume` tells you to check the wallet's recent transactions first.

### Try it with test funds

`--testnet` runs a route on the test networks of Ethereum, Optimism, Arbitrum and Base (their Sepolia networks) with worthless test tokens:

```sh
chainer send 5 USDC base arbitrum --testnet
chainer status --testnet
```

### Settings

```sh
chainer config show
chainer config set prefer fastest               # default ranking: cheapest or fastest
chainer config set slippage 0.005               # 0.5 %
chainer config set maxUsdPerTransfer 500        # refuse larger transfers ("off" to disable)
chainer config set maxHops 3                    # most legs an automatic route may have
chainer config avoid add USDT                   # never route through or into this token
chainer config rpc arbitrum https://my-node...  # use your own RPC node ("default" to undo)
```

### Tor and proxies

With a proxy set, every request (route searches and blockchain calls) goes through it. If the proxy is down, chainer fails instead of connecting directly.

```sh
chainer config set proxy socks5://127.0.0.1:9050   # Tor's default port
chainer config set proxy off
```

The install script installs Tor but does not start it; start it with your system's service manager (`sudo systemctl start tor` on most Linux systems, `brew services start tor` on macOS).

### Scripting

Every command takes `--json`. `--yes` skips the confirmation, and the `CHAINER_PASSWORD` environment variable supplies the wallet password. `CHAINER_HOME` moves the data folder.

## Using the graphical app

The graphical app is not built yet. It is planned for Windows, Linux, macOS and Android, with the same features as the command line: balances, transfers with a ranked route list and live progress, whole-wallet bridging, a pipeline builder, saved routes, history and settings.

### Themes

The app will ask for a theme on first launch, and the choice can be changed later in the settings:

- **Windows XP** (the default)
- **Modern**

Step-by-step instructions and one screenshot per theme will be added here when the app exists.

## Where your data lives

Settings, the encrypted wallet file and the transfer journal are in `~/.config/chainer` on Linux and macOS and `%APPDATA%\chainer` on Windows. Back up your seed phrase separately; the wallet file is useless without its password.

## Development

```sh
npm ci
npm test            # unit tests
npm run typecheck
npm run chainer -- quote 100 USDC arbitrum base
./scripts/test-install-linux.sh   # install script on clean Arch, Debian, Ubuntu, Fedora
```

The code is TypeScript, run directly by Node.js without a build step. `packages/core` holds all logic; `apps/cli` is the command line on top of it.

## License

[GNU General Public License v3.0](LICENSE)
