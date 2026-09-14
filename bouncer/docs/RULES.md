# BOUNCER · rules

Every line on a slip comes from one of the reads below, pinned to one head block. Nothing is sampled, inferred from a name, or taken from a list of "known" deployers.

## ID check

| Fact | Read | Rule |
| --- | --- | --- |
| factory record | `getLaunchedToken(address)` on the Pons V2 factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | `exists == true` means the factory deployed this token itself, through `PonsV2LaunchDeployer`. That is the whole genuineness test: the factory only records launches it made. |
| curve input | `token()` on the pasted address, then the factory record of that token | If the record's `curve` equals the pasted address, the slip is for the token and says so. |
| token / curve code | `eth_getCode` | Runtime bytecode is walked opcode by opcode. PUSH1..PUSH32 immediates are skipped (bytes inside them are data, not opcodes). The Solidity CBOR metadata trailer (length in the last two bytes, map byte `0xa1..0xa3`) is skipped. Counts: `SELFDESTRUCT 0xff`, `DELEGATECALL 0xf4`, `CALLCODE 0xf2`, `CREATE 0xf0`, `CREATE2 0xf5`. |
| proxy | `eth_getStorageAt` at the EIP-1967 implementation and beacon slots; the 45-byte EIP-1167 pattern | A set slot or the minimal-proxy shape means the code behind the address can be swapped. |

A `STOP` note is written for every code finding on an address the factory does not know. On a registered launch the same finding is a `WATCH` note, because Pons deploys the same token contract for every launch; if it ever trips, read the code.

## Cover charge

The factory holds two anti-snipe terms that every new launch snapshots at creation: `snipeTaxStartBps` (default 9 900 = 99%) charged on a buy's quote leg in the launch second, and `snipeTaxSeconds` (default 15, max 60), the window across which the curve decays it to zero. The deployer and their creator fee recipient are exempted by the factory; wallets the creator declared at launch are exempted too. Everyone else buying inside the window pays it, to the creator.

| Fact | Read | Rule |
| --- | --- | --- |
| terms | `snipeTaxStartBps()`, `snipeTaxSeconds()` at the head block | Shown as "X% in the launch second, decaying to 0 over N s". |
| unchanged since launch | factory `SnipeTaxStartBpsUpdated` and `SnipeTaxSecondsUpdated` logs between the launch block and the head | Any such log means the launch snapshotted older terms than the ones shown; the slip says so. |
| launched | the token's `TokenLaunched` log (indexed by token), then the block header | Searched backwards from the head in growing chunks, up to 7 days by default. |
| status | head timestamp vs launch timestamp + window | `open` with seconds left, `closed`, or `disabled` when the start tax is 0. |
| observed buys | the curve's `CurveBuy` logs from the launch block across the window (twice the window in blocks, to be safe), seconds interpolated from the headers at both ends | For each buy inside the window: `(fee + tax) / quoteIn` in basis points, as the curve's own event reports it. Buys from the deployer or fee recipient are marked creator wallets. |

The exact shape of the decay lives in the curve contract; the slip shows the terms and what buys actually paid, not a curve of the tax over time.

## House rules

| Rule | Read |
| --- | --- |
| fee per curve trade | curve `feeBps()` (protocol) + record `creatorTaxBps` (creator), both on the quote leg |
| pool fee after graduation | record `poolFee` (Uniswap V4 fee in hundredths of a bip) |
| creator tax recipient, moved? | record `creatorFeeRecipient`; factory `CreatorFeeRecipientUpdated` logs for the token since launch |
| buyback | record `buybackEnabled`; `BuybackEnabledUpdated` logs. The vault vests bought-back tokens to creator and protocol over five years; the slip says "not burned" because it is not. |
| quote asset, fill | record `pairToken` (zero = ETH, else `symbol()`/`decimals()`); curve `realQuoteReserve()` vs `graduationThreshold()` |
| phase | record `phase`: curve, swept, pool, rescued |
| deployer holding | token `balanceOf(deployer)` / `totalSupply()` |

## Dev report card

`TokenLaunched` logs with the deployer in `topics[3]` over the window (24 h by default; block found by binary search on timestamps), read with adaptive chunking. For each launch (newest first, 40 detailed): factory record for phase, tax and sweep time, `symbol()`, launch block header. Counts cover every launch in the window even when older ones are not listed.

## The room

Every `CurveBuy` and `CurveSell` the curve logged from the launch block to the head (adaptive chunks; a curve's logs are few). Per wallet: first block, buys, sells, quote in (net of fee and tax), quote out. Dev share = quote in from the deployer and fee recipient over all quote in. First minute = quote in within 60 s of blocks after launch. Shared blocks = blocks in which more than one distinct wallet bought.

## Exit door

| Venue | Read | Arithmetic |
| --- | --- | --- |
| curve | `getReserves()`, `feeBps()`, `readyToGraduate()` | `PonsV2BondingCurveMath.getAmountOut(tokensIn, tokenReserve, quoteReserve, 0)`, then `fee = gross·feeBps/1e4`, `tax = gross·creatorTaxBps/1e4`, `net = gross − fee − tax`: the curve's own `sell()`. A full curve (`readyToGraduate`) reverts sells, so the venue is "closed" until `graduate()`. |
| pool | factory `poolManager()`, `memeHook()`; `PoolManager.extsload` of the pool's `slot0` (sqrtPriceX96) and `liquidity` at `keccak256(poolId ‖ 6)` and `+3`; hook `currentFeePolicy().hookFeeBps` | Pool id = `keccak256(abi.encode(currency0, currency1, poolFee, tickSpacing, hook))` with currencies sorted. Full-range virtual reserves `x = L·2^96/√P`, `y = L·√P/2^96`. The sale is priced as a constant-product swap on those reserves with the hook fee and the creator tax on the quote leg. An estimate: the hook policy is the live one, and any liquidity outside the locked full-range position is not modelled. |

Quotes are for 10 / 25 / 50 / 100% of a position (1% of supply by default, or `--amount`). "Realised" = net over what the same tokens would fetch at the marginal price.

## One crew

For each of the first 12 buyers: Blockscout `/api/v2/addresses/{wallet}/transactions?filter=to`, up to three pages, earliest incoming native transfer with value > 0 before the launch block. Wallets sharing that sender form a crew; a crew's share is its quote in over the curve's total. A wallet whose funder is the deployer or the fee recipient is listed separately. A wallet with no incoming native transfer found (funded by an ERC-20, a contract or an internal transaction) counts as unresolved, never as clean.

## Lookalikes

Blockscout `/api/v2/search?q=SYMBOL`, kept when the symbol matches exactly, at most 8. Each candidate: factory record (registered or not, phase) and, when registered, its `TokenLaunched` block. The earliest registered launch block wins "came first". The subject is always a candidate even when the explorer has not indexed it yet.

## Position and receipt

Position: the curve's `CurveBuy` with `buyer = wallet` and `CurveSell` with `seller = wallet` from the launch block; `balanceOf(wallet)` at the head; the exit door for that balance. Cost basis = quote spent on buys (fees included) − quote received on sells. Receipt: the transaction's own `CurveBuy`/`CurveSell` logs; creator tax part = `quote · creatorTaxBps / 1e4` from the factory record; cover charge = `tax − creator tax part` when positive.

## Launch planner

Factory `getLaunchConfig(id)`, `pairTokenEconomics(pairToken)` for ERC-20 quotes, `launchFee()`, `maxCreatorTaxBps()`, the anti-snipe terms, hook `currentFeePolicy()`. Reserved tokens `= supply · phantom / (phantom + threshold)` (the curve's `initialize`), start price `= phantom / supply`, graduation price `= (phantom + threshold) / reserved`, FDV at graduation `= graduation price · supply`, creator's take if the curve fills with no sells `= threshold · creatorTaxBps / 1e4`, door charge on a sample buy in the launch second `= buy · snipeTaxStartBps / 1e4`.

## Dev moved · crew exit (watch)

One block window, narrow reads, events not verdicts:

| Event | Read |
| --- | --- |
| dev-sold | the curve's `CurveSell` with `seller = deployer` |
| dev-transferred | the token's `Transfer` with `from = deployer`, except transfers to the curve (those are the sell above) |
| fee-recipient-moved | factory `CreatorFeeRecipientUpdated` for the token |
| buyback-changed | factory `BuybackEnabledUpdated` for the token |
| swept / graduated | factory `LaunchSwept` / `PoolGraduated` for the token |
| crew-exit | `CurveSell` with `seller` in the crew, or `Transfer` with `from` in the crew (not to the curve); reported once per window when at least two crew wallets left |

The crew is the set of first buyers ONE CREW found sharing a funder. The CLI polls every 5 s, the bot every 15 s, the site tab every 15 s; each keeps a cursor so an event is delivered once.

## The board

Factory `TokenLaunched`, `LaunchSwept`, `PoolGraduated` over the window (adaptive chunks), folded per deployer: launched, swept, graduated. "Serial" = 5 or more launches and no graduation. Cover charge: every `CurveBuy` on the chain in the window (no address filter, adaptive chunks), the curve's own `creatorTaxBps()` per curve seen, and `cover = tax − quoteIn · creatorTaxBps / 1e4` when positive, summed per curve and per buyer. Buys whose curve is not in the window's launches are still counted (the curve, not the token, is shown).

## Door notes

| Level | Code | When |
| --- | --- | --- |
| STOP | not-registered | no factory record |
| STOP | code | proxy / SELFDESTRUCT / DELEGATECALL / CALLCODE on an unregistered address |
| WATCH | code | the same on a registered launch |
| WATCH | cover-open | window still open |
| INFO | cover-closed | window closed; count of buys inside it and the highest charge paid |
| WATCH | terms-retuned | factory terms changed after the launch |
| INFO | launch-older | launch not found inside the search window |
| WATCH | high-tax | protocol fee + creator tax ≥ 10% |
| WATCH | fee-recipient-moved | ≥ 1 recipient change since launch |
| WATCH | dev-holds | deployer holds ≥ 20% of supply |
| INFO | buyback-vests | buyback enabled |
| INFO | swept-no-pool | phase swept |
| INFO | graduated | phase pool / rescued |
| INFO | dev-first | no other launch by the deployer in the window |
| WATCH | dev-serial | ≥ 5 launches in the window, none graduated |
| WATCH | dev-repeat | the same ticker launched more than once by the deployer |
| INFO | dev-graduated | ≥ 1 graduation in the window, with the median launch-to-sweep |
| WATCH | dev-funded | the creator's wallets funded ≥ 50% of everything bought on the curve |
| WATCH | bundled-blocks | ≥ 3 blocks with several distinct wallets buying at once |
| INFO | room-wide | ≥ 25 buyers and the creator funded < 20% |
| WATCH | one-crew | the largest crew of first buyers sharing a funder bought ≥ 25% of the curve |
| WATCH | crew-creator | first buyers whose funds came from the creator's wallets |
| INFO | crew-clean | ≥ 5 first buyers checked, no shared funder |
| WATCH | lookalike-later | a registered token with the same ticker launched earlier |
| INFO | lookalikes | other tokens with the same ticker exist |
| INFO | exit-closed | the curve is full and waiting for graduate(), or swept without a pool |
| INFO | exit-thin | selling 1% of supply realises < 50% of spot |
| INFO | skipped | a section could not be read; the reason is in the note |

The stamp is `ON THE LIST` when the factory record exists and `NOT ON THE LIST` otherwise. It is not a score. A launch with five WATCH notes is still on the list; the notes are what to read before paying the cover.
