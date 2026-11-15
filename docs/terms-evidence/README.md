# Terms evidence

Saved copies of the pages that were checked for legal terms of services included in the default bridge list, where reading the terms failed or turned up nothing. They back the "Included services" section in [../PLAN.md](../PLAN.md): a service stays included because its terms could not be found or read, and these files show what the check returned.

Captured 15 Nov 2026 (UTC) with plain `curl` and the user agent `chainer-terms-review`. Nothing here was fetched around a block: bot checks (Relay) and paused deployments (MegaETH) are saved as returned. For every URL there is `<name>.headers.txt` (status line and headers), `<name>.body` (the unmodified response; a failed request leaves `<name>.curl-error.txt` instead) and `<name>.wayback.json` (the Internet Archive's answer to "is there a snapshot"). `INDEX.txt` lists every request with time, status and nearest snapshot. Files named `wayback-*` are copies of Internet Archive snapshots, fetched unmodified.

| Service | URL | Result | What the saved file shows |
|---|---|---|---|
| Relay | `relay.link/terms` | HTTP 429 | Vercel security checkpoint instead of the terms. The owner pasted the 9 Nov 2026 text into the review session; it is not stored here. `wayback-2026-05-05_relay.link_terms.html` is the Internet Archive copy from 5 May 2026, an older version. |
| Hyperliquid | `hyperliquid.gitbook.io/.../legal/terms-of-use`, `.../hyperliquid-l1/terms-of-use` | HTTP 404 | The docs have no terms page. |
| Hyperliquid | `app.hyperliquid.xyz/terms` | HTTP 200 | The empty application shell of the trading app; the terms, if any, are rendered by scripts and are not in the response. |
| MegaETH | `predeposit.megaeth.com` | HTTP 503 | `DEPLOYMENT_PAUSED`. |
| MegaETH | `docs.megaeth.com/llms.txt` | HTTP 200 | The documentation index: no terms, legal or privacy page. |
| Frax | `frax.com/`, `frax.com/terms` | HTTP 200 | The same application shell for every path; no terms text. |
| Centrifuge | `app.centrifuge.io/` | HTTP 200 | Application shell, no terms. |
| Centrifuge | `centrifuge.io/terms` | HTTP 200 | Website Terms of Use (read after the first attempts failed: the review's automated fetcher got HTTP 403 on `centrifuge.io`, `curl` did not). They cover the website only. |
| Celer | `celer.network/doc/tos.pdf` | HTTP 404 | The only Celer terms document found is gone. `wayback-2021-10-22_celer.network_doc_tos.pdf` is the Internet Archive copy: website terms of use only. |
| Omni Bridge | `omni.bridge`, `app.omni.bridge` | no connection | The host names do not resolve (see the `.curl-error.txt` files). |
| Chainflip | `chainflip.io/legal-notice` | HTTP 200 | An imprint (Chainflip Labs GmbH), not terms of use. |
| Chainflip | `swap.chainflip.io/` | HTTP 200 | Application shell, no terms. |
| NEAR Intents | `near-intents.org/terms-of-service` | HTTP 200 | Application shell without text; the terms were read from `docs.near-intents.org` (also saved). |
| M0 | `docs.m0.org/home/resources/disclosures`, `.../portal/overview/disclosures` | see `INDEX.txt` | The disclosures pages the US-person statement was taken from. |
| Polymer | `polymerlabs.org/`, `docs.polymerlabs.org/` | HTTP 200 | No terms, legal or privacy link in either page. |
| Liquify (THORChain gateway) | `liquify.com`, `/terms`, `/terms-of-service`, `/legal`, `/privacy` | HTTP 200 for the home page, 404 for the rest | The home page links no terms, legal or privacy page (`portal.liquify.com` is a login; docs are on GitBook). `thorchain-docs.body` is the THORChain developer page that names `gateway.liquify.com` as the public node, with a limit of 50,000 requests per day per IP and no terms. |
| THORChain | `thorchain.org/terms-of-use` (saved as `thorchain/terms-of-use.html`) | HTTP 200 | Terms of Use dated 19 Jan 2026. They govern the thorchain.org site and the swap.thorchain.org interface only and say they "do not apply to the THORChain protocol itself, public blockchain networks, wallets, nodes". 18+, sanctions and prohibited-jurisdiction statements apply to the site. |
| Maya Protocol | `mayaprotocol.com`, `mayaprotocol.com/terms`, `docs.mayaprotocol.com`, `mayascan.org` | HTTP 200 for the home pages, 404 for `/terms` | None of the pages links a terms, legal or privacy page (`maya/`). |
