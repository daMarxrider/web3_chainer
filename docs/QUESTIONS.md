# Open questions

Collected while working on my own; answer when convenient. Nothing here blocks the work that was done.

## Decisions

1. **NEAR Intents, direct integration.** The keyless 1Click quote endpoint works, but the 1Click API terms (7 Oct 2026, sections 9.3 and 2.7) are written for registered API developers and exclude private individuals, and an unauthenticated client would be a downstream user of that API. Options: (a) leave NEAR Intents reachable only through LI.FI (current state, no extra risk); (b) integrate it directly and show the "needs an account" warning, off by default like the API-key services. Recommendation: (a).
2. **Chainflip, direct integration.** Chainflip's deposit channels need a broker. Options: (a) keep using it through LI.FI only (current); (b) wait for a public keyless broker; (c) a user-supplied broker URL setting, off by default. Recommendation: (a).
3. **More Bitcoin-family coins** (Dogecoin, Bitcoin Cash, Dash, Zcash transparent). THORChain and Maya trade them. Worth it now, or after the GUI? Each needs its own address code, data source and terms check.
4. **Maya Protocol is on by default** although its pools are thin (34 % slippage on a 0.1 ETH test quote) and it publishes no terms. It only wins when its pool is deeper. Keep it on, or off by default? Recommendation: keep on (the ranking handles it).

## Things only you can do

5. **Funds for one live Solana and Bitcoin test.** Both adapters are tested with fake nodes only. A live check needs a few cents on devnet and testnet4, and the faucets need a web login (the Solana devnet RPC faucet is closed). If you want it: fund an address I print, then I run a self-transfer on each. Not urgent.
6. **First real mainnet transfer through THORChain** (a few dollars, `--dry-run` first), same as for the other providers.

## Legal work postponed to the next session (as agreed)

7. Default RPC endpoints (EVM and Solana) terms; which LI.FI document governs the keyless API; the LI.FI email (needs your yes and the name to sign with).
8. litecoinspace.org's served terms could not be read (script-rendered page); it stays as the default Litecoin API under your "no terms means no restriction" rule.
