# BOUNCER privacy policy

_Last updated: 2026-09-16_

BOUNCER (the browser extension, the website and the command-line tool) is a read-only tool that shows public blockchain information about a token address.

**What we collect:** nothing. BOUNCER has no server of its own, no analytics, no accounts, no cookies of its own and no telemetry.

**What leaves your browser:** when you check an address, the extension sends read-only requests (JSON-RPC and explorer API calls) containing that address to the blockchain endpoint you selected (by default the public RPC and Blockscout explorer of the chosen chain, or a proxy URL you configured). Those services see the request like any other blockchain read. BOUNCER never sends anything anywhere else.

**What stays in your browser:** your settings (chain, RPC URL, proxy URL, demo/live mode) in the extension's own storage. Remove the extension and they are gone.

**Page access:** the content script runs on a few token-listing sites only to read the page URL and pin a badge. It does not read page content, forms, wallets or storage, and it never modifies requests.

**Keys and transactions:** BOUNCER holds no keys, never asks to connect a wallet and cannot sign or send transactions; its RPC client refuses every write method.

**Contact:** open an issue at https://github.com/Kepochnik/bouncer/issues
