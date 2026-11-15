# Open questions

Answered 15 Nov 2026: NEAR Intents and Chainflip stay LI.FI-only (no direct integration); Maya stays on by default, with thin pools priced into the ranking (done); the extra Bitcoin-family adapters were built on 15 Nov 2026 (Dogecoin, Bitcoin Cash, Dash; Zcash not, see question 9).

Still open:

## Things only you can do

5. **Funds for one live Solana and Bitcoin test.** Both adapters are tested with fake nodes only. A live check needs a few cents on devnet and testnet4, and the faucets need a web login (the Solana devnet RPC faucet is closed). If you want it: fund an address I print, then I run a self-transfer on each. Not urgent.
6. **First real mainnet transfer through THORChain** (a few dollars, `--dry-run` first), same as for the other providers.

9. **Zcash.** Which data source may I use? There is no keyless address-indexed API. Options: a lightwalletd server over gRPC (zec.rocks), a paid or keyed indexer (off by default, like the other keyed services), or leaving Zcash out. Transparent-address signing (ZIP-243) would be added with it.
10. **Dogecoin, Dash and Bitcoin Cash live test.** Same as 5: a few DOGE, DASH or BCH sent to an address I print, then a self-transfer. The BlockCypher keyless limit is about 100 requests an hour; heavy use needs a key (a setting, off by default).
11. **BlockCypher broadcasts without a key.** Its docs say a token is required for POST calls (broadcasting a transaction); today the keyless call still works. Your rule says services needing a free key are built in but off by default. Options: keep BlockCypher keyless for Dogecoin and Dash broadcasts as it works now (current state), or require a key for broadcasting (a setting) and refuse Dogecoin and Dash sends without one. I did not decide this for you.

## Legal work postponed to the next session (as agreed)

7. Default RPC endpoints (EVM and Solana) terms; which LI.FI document governs the keyless API; the LI.FI email (needs your yes and the name to sign with).
8. litecoinspace.org's served terms could not be read (script-rendered page); it stays as the default Litecoin API under your "no terms means no restriction" rule.
