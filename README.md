<p align="center"><img src="assets/bouncer-gorilla.png" width="128" alt="BOUNCER: a pixel gorilla in wraparound shades and a black tee, arms crossed, earpiece in" /></p>

<h1 align="center">BOUNCER</h1>

<p align="center"><strong>Check the list before you pay the cover.</strong><br/>Read-only door check for Pons V2 launches on Robinhood Chain, and for Radian (the Pons V2 port) on Circle's Arc.</p>

<p align="center">
  <img alt="tests 40 passing" src="https://img.shields.io/badge/tests-40_passing-c9a227?style=flat-square&labelColor=0e0d10" />
  <img alt="node 22+" src="https://img.shields.io/badge/node-22%2B-c9a227?style=flat-square&labelColor=0e0d10" />
  <img alt="runtime deps 0" src="https://img.shields.io/badge/runtime_deps-0-c9a227?style=flat-square&labelColor=0e0d10" />
  <img alt="Robinhood Chain 4663" src="https://img.shields.io/badge/Robinhood_Chain-4663-c9a227?style=flat-square&labelColor=0e0d10" />
  <img alt="Arc 5042" src="https://img.shields.io/badge/Arc-5042-c9a227?style=flat-square&labelColor=0e0d10" />
  <img alt="signing none" src="https://img.shields.io/badge/signing-none-c9a227?style=flat-square&labelColor=0e0d10" />
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-c9a227?style=flat-square&labelColor=0e0d10" /></a>
</p>

<p align="center"><a href="#sixty-seconds">Sixty seconds</a> · <a href="#the-slip">The slip</a> · <a href="#the-site">The site</a> · <a href="#commands">Commands</a> · <a href="#arc">Arc</a> · <a href="#telegram-bot">Bot</a> · <a href="#browser-extension">Extension</a> · <a href="docs/RULES.md">Rules</a> · <a href="docs/CHAINS.md">Chains</a> · <a href="docs/LIMITATIONS.md">Limitations</a></p>

> **Official CA:** not launched yet. When it is, the address goes here first, then everywhere else. Anything claiming to be `$BOUNCER` before this line changes is not.

---

## Why

Twenty-five thousand tokens launch on Pons every day. Each one has a door: a 99% anti-snipe tax that decays to zero over the first fifteen seconds, a creator tax of up to 10% on every trade, a fee recipient the creator can move, a "buyback" that vests back to the creator instead of burning, and a deployer with a history. None of that is on the chart. All of it is on the chain.

BOUNCER reads it and prints a slip: **ID check** (did the factory really deploy this token, and can its code change), **cover charge** (is the door tax still open, what did the buys inside the window actually pay), **house rules** (the terms in plain words), **the room** (who bought, how much the creator funded, buys landing in the same block), the **exit door** (what 10 / 25 / 50 / 100% of a position fetches right now, on the curve or in the graduated pool), **one crew** (which of the first buyers were funded by the same hand), **lookalikes** (other tokens with the same ticker, and which came first) and the **dev report card** (what this deployer launched before and how it went). The stamp says `ON THE LIST` or `NOT ON THE LIST`. The notes say what to read before paying.

For holders there is a **position** (one wallet on one launch: cost basis, fees and taxes paid, exit value now) and a **receipt** (one trade itemised: protocol fee, creator tax, cover charge). For creators there is a **launch planner** (what a launch looks like under today's factory terms, before anything is signed).

The gorilla is the meme. The slip is the product.

## Sixty seconds

Node 22.13 or newer. No runtime dependency: the ABI codec, keccak, JSON-RPC client and bytecode scanner are in `src/chain/`, small enough to read.

```bash
git clone https://github.com/Kepochnik/bouncer.git
cd bouncer
npm install
npm run demo          # three slips on a synthetic chain, labelled DEMO
npm run doctor        # rpc, chain id 4663, factory bytecode, anti-snipe terms
```

## The slip

```bash
node bin/bouncer.mjs door 0xTOKEN                  # or the curve address
node bin/bouncer.mjs door 0xTOKEN --format svg --output slip.svg
node bin/bouncer.mjs door 0xTOKEN --format json
```

A launch nine seconds old, cover charge still open, one wallet already paid 71% at the door:

<p align="center"><img src="assets/readme/door-fresh.png" width="100%" alt="bouncer door on the demo chain: FRESH, on the list, cover charge open with 6 s left, three buys in the window, house rules, door notes" /></p>

A contract named after a real launch that the factory has never seen:

<p align="center"><img src="assets/readme/door-impostor.png" width="100%" alt="bouncer door on an impostor: NOT ON THE LIST, upgradeable proxy, SELFDESTRUCT and DELEGATECALL as STOP notes" /></p>

The card (1200×630), for the reply under "graduating tonight":

<p align="center"><img src="assets/readme/card-fresh.png" width="100%" alt="BOUNCER card for FRESH: on the list, cover charge open, 11% per trade, dev report card, door notes, the gorilla" /></p>

<p align="center"><img src="assets/readme/card-impostor.png" width="100%" alt="BOUNCER card for the impostor: NOT ON THE LIST" /></p>

## Beyond the door

```bash
node bin/bouncer.mjs exit 0xTOKEN --amount 5000000          # exit door for a position
node bin/bouncer.mjs wallet 0xTOKEN 0xWALLET                # the bag: trades, cost basis, exit now
node bin/bouncer.mjs receipt 0xTXHASH                       # one trade itemised
node bin/bouncer.mjs plan --tax 300 --buy 0.1               # launch planner at today's terms
node bin/bouncer.mjs dev 0xDEPLOYER --hours 48              # dev report card alone
```

## The site

The same read path runs in the browser, bundled into one HTML file (`npm run site` → `site/dist/index.html`). Paste an address, get the slip, watch the cover charge count down. Demo mode needs no network; live mode reads the chain you pick from your browser through an RPC you choose. Tabs for the door, a deployer, a wallet, a receipt and the planner. Every view has a link: `#/t/0x…`, `#/dev/0x…`, `#/wallet/0xT/0xW`, `#/tx/0x…`, `#/plan?tax=300`, with `?chain=arc-testnet` for Arc.

<p align="center"><img src="assets/readme/site.png" width="100%" alt="the BOUNCER site: search at the door, the FRESH slip with stamp, door notes, ID check, cover charge countdown, house rules and dev report card" /></p>

Deploys to GitHub Pages from `main` with `.github/workflows/pages.yml`.

## Commands

| Command | What it reads | What it prints |
| --- | --- | --- |
| `bouncer doctor` | `eth_chainId`, latest block, factory bytecode, `snipeTaxStartBps()`, `snipeTaxSeconds()` | read-path health |
| `bouncer door <token\|curve>` | factory record, bytecode and EIP-1967 slots of token and curve, `TokenLaunched` for the token, factory retune logs, the curve's buys and sells since launch, curve state or PoolManager storage, fee-recipient and buyback logs, Blockscout funding sources and token search, the deployer's `TokenLaunched` logs over the window | the slip |
| `bouncer door … --format svg` | the same | the card |
| `bouncer dev <address> [--hours 24]` | the deployer's `TokenLaunched` logs, each launch's record and symbol | the dev report card alone |
| `bouncer exit <token> [--amount n]` | curve reserves and fees, or the pool's slot0 and liquidity via `extsload` | what selling 10 / 25 / 50 / 100% pays now |
| `bouncer wallet <token> <wallet>` | the wallet's `CurveBuy`/`CurveSell`, `balanceOf`, the exit door | trades, cost basis, fees and taxes paid, exit value, unrealised |
| `bouncer receipt <txhash>` | the transaction receipt's curve logs, the factory record, reserves at that block | one trade itemised, cover charge separated |
| `bouncer plan [--config 0] [--tax 100] [--quote 0x…] [--buy 0.1]` | launch config, pair economics, launch fee, tax ceiling, anti-snipe terms, hook policy | start and graduation price, curve vs pool split, FDV at graduation, creator's take, door charge on a sample buy |
| `bouncer demo` | nothing (synthetic chain) | three slips offline |

Every command takes `--chain robinhood|arc-testnet|arc`, `--factory <address>`, `--rpc <url>`, `--demo`, `--format text|markdown|json` and `--output <new file>` (never overwrites). `door` also takes `--hours`, `--launch-blocks` and `--no-dev --no-room --no-crew --no-lookalikes --no-blockscout`.

## Arc

Radian is a faithful port of the Pons V2 contracts on Circle's Arc, quoted in native USDC. The read path is identical, so BOUNCER runs there with `--chain arc-testnet` (chain 5042002, Radian's published factory) today and `--chain arc --factory 0x…` on mainnet (chain 5042, opens 2026-09-16) as soon as Radian publishes its mainnet factory. The site has the same selector. Amounts print in USDC; the table of chains, RPCs, explorers and factories is [docs/CHAINS.md](docs/CHAINS.md).

## Telegram bot

```bash
TELEGRAM_BOT_TOKEN=… BOUNCER_SITE_URL=https://kepochnik.github.io/bouncer node bin/bouncer-bot.mjs
```

Long polling, no webhook, no library, no state beyond which chain a chat picked. `/ca <token|curve>` prints the slip, `/dev <address>` the report card, `/exit <token> [tokens]` the exit door, `/chain arc-testnet` switches chain for that chat. The bot holds one secret, its own token, and can only read.

## Browser extension

`extension/` is a Manifest V3 extension. On ponsfamily.com, gmgn.ai, dexscreener.com and the Blockscout explorers it pins a small `🦍 BOUNCER · check the list` badge that opens the slip for the address in the page URL; the popup takes any address (pre-filled from the current tab) and opens it on the site. It reads the URL and nothing else: no wallet, no page storage, no injected requests. Load it unpacked from `chrome://extensions` (Chrome, Brave, Arc, Edge) and set the site URL in the popup once.

## How it reads the chain

```mermaid
flowchart LR
  A[address] --> F["factory getLaunchedToken<br/>(or curve.token() first)"]
  F --> C["eth_getCode + EIP-1967 slots<br/>opcode walk"]
  F --> L["TokenLaunched for the token<br/>→ launch block + timestamp"]
  L --> T["factory terms + retune logs<br/>curve CurveBuy inside the window"]
  F --> H["curve state, fee-recipient and buyback logs"]
  F --> D["TokenLaunched by deployer<br/>over 24 h, adaptive chunks"]
  C & T & H & D --> S["slip: stamp + door notes<br/>text · markdown · json · svg"]
```

- Factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` on chain `4663`, public RPC `https://rpc.mainnet.chain.robinhood.com` (override with `RPC_URL`, fallbacks with `RPC_FALLBACK_URLS`).
- Every `eth_call` in one slip is pinned to one block. Logs are read in chunks the endpoint tolerates, with pacing and backoff on 429; narrow reads use adaptive chunking that halves on a range error. A chunk that fails is an error, never a zero.
- The rule for every line: [docs/RULES.md](docs/RULES.md). Known gaps: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Prior art, named

[PonsScan](https://github.com/argostroloji/ponsscan) and [PonsHQ](https://ponshq.com) show curve fill; [GRAID](https://github.com/0xfokki/graid) and [Augur](https://getaugur.xyz) score launches; [WORM](https://github.com/wormrobinhood/worm) runs a graduation feed; [HOP OUT](https://hopout.xyz) prices the exit from pool depth; [DIPLOMA](https://github.com/Kepochnik/diploma) prints the transcript after a graduation; [Radian](https://github.com/adrianhihi/radian) ported Pons V2 to Arc. BOUNCER stands at the door before any of that: it does not score, rank or predict. It reads the terms and the code and says what is true at one block.

## Read-only by construction

`npm run readonly-check` fails the build if anything in `src/` mentions `eth_sendRawTransaction`, `eth_sign`, `signTransaction`, a private key or a mnemonic. The RPC client refuses every method that is not on its read allow-list. The site has no wallet connect, no approval, no transaction path.

```text
No key. No signer. No transaction path.
```

## Project map

```text
bin/bouncer.mjs             CLI entry
src/cli.ts                  commands
src/chain/                  keccak, ABI codec, JSON-RPC client, Pons V2 constants, block-pinned reader, event tape (plain + adaptive), bytecode scanner
src/bouncer/idCheck.ts      factory record, curve → token, bytecode and proxy slots
src/bouncer/coverCharge.ts  anti-snipe terms, window, observed buys
src/bouncer/houseRules.ts   the terms in words
src/bouncer/devReport.ts    the deployer's launches over a window
src/bouncer/room.ts         who bought, dev share, first minute, shared blocks
src/bouncer/exitDoor.ts     sell quotes on the curve or the graduated pool
src/bouncer/oneCrew.ts      funding sources of the first buyers (Blockscout)
src/bouncer/lookalike.ts    same-ticker tokens and which came first (Blockscout + factory)
src/bouncer/position.ts     one wallet on one launch
src/bouncer/txReceipt.ts    one trade itemised
src/bouncer/planner.ts      the launch planner
src/bouncer/door.ts         one address in, one slip out; the door notes
src/bouncer/card.ts         the 1200×630 card
src/bouncer/demo.ts         synthetic chain and fake explorer for --demo
src/chain/chains.ts         Robinhood Chain, Arc Testnet, Arc
src/chain/blockscout.ts     the smallest Blockscout v2 client
src/bot/telegram.ts         the Telegram bot
extension/                  Manifest V3 browser extension
site/                       the browser app (index.html + src/app.ts), built by scripts/build-site.mjs
scripts/                    read-only check, mascot renderer, site build, terminal → SVG
test/                       offline tests against the demo chain
docs/                       RULES, LIMITATIONS, LAUNCH-KIT
```

## Tests

```bash
npm run check     # read-only check + build + 40 tests + site bundle, no network
```

## License

MIT. BOUNCER is independent of Robinhood, Pons, Radian, Circle and Uniswap and is not endorsed by them.
