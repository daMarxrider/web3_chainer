# Open questions

Answered 15 Nov 2026: NEAR Intents and Chainflip stay LI.FI-only (no direct integration); Maya stays on by default, with thin pools priced into the ranking (done); the extra Bitcoin-family adapters were built on 15 Nov 2026 (Dogecoin, Bitcoin Cash, Dash; Zcash left out on purpose; BlockCypher is off until the user enables it).

Still open:

## Things only you can do

5. **Funds for one live Solana and Bitcoin test.** Both adapters are tested with fake nodes only. A live check needs a few cents on devnet and testnet4, and the faucets need a web login (the Solana devnet RPC faucet is closed). If you want it: fund an address I print, then I run a self-transfer on each. Not urgent.
6. **First real mainnet transfer through THORChain** (a few dollars, `--dry-run` first), same as for the other providers.

9. **Dogecoin, Dash and Bitcoin Cash live test.** Same as 5: a few DOGE, DASH or BCH sent to an address I print, then a self-transfer. Dogecoin and Dash need `chainer config set blockcypher on` first; its keyless limit is about 100 requests an hour.

## Legal work postponed to the next session (as agreed)

7. LI.FI email and the remaining RPC gap. RPC terms are done (16 Nov 2026, see PLAN.md "RPC endpoints"); the SDK is not needed since LI.FI's docs allow keyless API use. Still open: (a) the LI.FI email (needs your yes and the name to sign with), now optional since the docs answer the main question, though the Relay and NEAR Intents downstream-distributor question remains; (b) seven small chains (Vana, Ronin, Morph, Etherlink, XDC, Flow EVM, Plasma) still use their own operator's endpoint, terms unread: keep, or read their terms too?
8. litecoinspace.org's served terms could not be read (script-rendered page); it stays as the default Litecoin API under your "no terms means no restriction" rule.
