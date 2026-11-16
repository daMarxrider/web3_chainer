# RPC endpoint review, 16 Nov 2026

Pages fetched with `curl` (user agent `chainer-terms-review`), saved unmodified except where noted. `probe-*.txt` hold the answer of every host to `eth_chainId` (one line per host); the default list in `packages/core/src/rpc.ts` is built from the hosts that answered with the chain id LI.FI lists for the chain.

| File | Source | What it shows |
|---|---|---|
| `publicnode-terms.html` | `publicnode.com/terms` | "Automated Access": scripts, bots, indexers and AI agents may use the endpoints "for development and production purposes", no authorization needed; limits are enforced with HTTP 429 and exceeding them is no breach. Reselling access is banned. |
| `pocket-terms-of-use.html` | `pocket.network/terms/` (Pocket Network Foundation, revised 19 Nov 2024) | 18+, no sanctioned persons or territories (11). No bot or automation clause. |
| `pocket-api-portal.html`, `pocket-supported-chains.html` | `docs.pocket.network` | The public portal `api.pocket.network` is keyless; "suitable for development, testing, and moderate production use"; limits 2,000 requests per IP per minute. |
| `drpc-terms-of-service.html`, `drpc-rate-limiting.html` | `drpc.org/terms-of-use` (14 Jan 2025), `docs.drpc.org` | Terms bind account holders; the only automation rule (1.8) is about collecting data from the website. The rate-limit page documents "public nodes" and the free-node rules (25 requests per second, batches of 3, filters off). |
| `solana-clusters-wayback.html` | Internet Archive copy of `solana.com/docs/references/clusters` (the live site answers 429) | Public endpoints are rate-limited, available "for users and developers", production infrastructure should use a provider. Mainnet host is `api.mainnet.solana.com`. |
| `1rpc-terms-of-use.html` | `1rpc.io/tou` | Terms for 1RPC+ accounts, March 2023; the free tier is 200 requests a day. Not used. |
| `lifi-api-introduction.md`, `lifi-rate-limits.md` | `docs.li.fi` | "All LI.FI APIs do not require API key"; "Public routing endpoints allow keyless access subject to their limits". The SDK is not needed. |
