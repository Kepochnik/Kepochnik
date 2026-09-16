# Chrome Web Store listing · BOUNCER

Everything the Developer Dashboard asks for, ready to paste. The zip to upload is `site/dist/bouncer-extension.zip` (built by `npm run site`).

## Store listing

**Name:** BOUNCER · door check for Pons launches

**Summary (132 chars max):**
Check a Pons token before you buy: real or fake, door tax, fees, who's inside, the dev's history. Read-only, no wallet.

**Category:** Productivity (or Developer Tools)

**Language:** English

**Description:**

BOUNCER is a read-only door check for token launches on Pons (Robinhood Chain) and Radian (Arc). Open it on any token page and it reads the chain at one block and tells you, in plain words:

- Is it real? Did the launchpad's factory deploy this token, and can its code change later (proxy, self-destruct)?
- Door tax: is the 99% anti-snipe tax still on, for how many seconds, and what did the buys inside the window actually pay?
- Fees and rules: what every trade costs, where the creator's cut goes, what "buyback" really does (it vests back to the creator, it does not burn).
- Cash out now: what selling 10 / 25 / 50 / 100% of a position pays right now.
- Who is inside: distinct buyers, how much the creator's own wallets put in, buys landing in the same block.
- Same funder: which early buyers got their money from the same address before the launch.
- Same name: other tokens with this ticker, and which launched first.
- This dev before: everything the deployer launched in the last 24 h and how it went.
- Watch: get told in the popup when the dev sells or moves tokens.

Nothing is scored, predicted or advised. Every number comes from the chain at the block shown, and you can re-run it.

No wallet connection. Nothing to sign. The extension holds no keys and cannot send transactions: its RPC client refuses every write method by construction. Open source (MIT): github.com/Kepochnik/bouncer

## Privacy practices (answers for the dashboard)

**Single purpose:** Show a read-only report about a token address found on the current tab or pasted by the user, by reading public blockchain data.

**Permission justifications:**
- `activeTab`: to read the URL of the current tab when the user clicks the icon, so the popup can pre-fill the token address found in it. Nothing is read from page content.
- `storage`: to remember the user's own settings (chain, RPC URL, proxy URL, demo/live) between popups.
- `host_permissions` (chain RPC and explorer hosts): to read public blockchain data (JSON-RPC and Blockscout) directly from the popup.
- `optional_host_permissions` (`https://*/*`): requested only when the user types a custom RPC or proxy URL, so the popup can call it.
- Content script on ponsfamily.com, gmgn.ai, dexscreener.com and the Blockscout explorers: pins a small badge linking to the report for the address in the page URL. It reads the URL only; it never reads or changes page content, storage or requests.

**Remote code:** none. All scripts ship in the package.

**Data usage:** The extension does not collect, transmit or sell any user data. Token addresses the user checks are sent only to the blockchain RPC / explorer the user selected, as part of the read request itself. Settings stay in the browser's extension storage.

**Privacy policy URL:** https://kepochnik.github.io/kepochnik/privacy.html (or the same file in the repo: extension/store/PRIVACY.md)

## Graphics

- Icon 128×128: `extension/icon-128.png`
- Screenshot 1280×800: `extension/store/screenshot-1280x800.png`
- Small promo tile 440×280: `extension/store/tile-440x280.png`

Regenerate with `node scripts/store-assets.mjs` after a design change.
