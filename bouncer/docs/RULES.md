# BOUNCER · rules

Every line on a slip comes from one of the reads below, pinned to one head block. Nothing is sampled, inferred from a name, or taken from a list of "known" deployers.

## ID check

| Fact | Read | Rule |
| --- | --- | --- |
| factory record | `getLaunchedToken(address)` on the Pons V2 factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | `exists == true` means the factory deployed this token itself, through `PonsV2LaunchDeployer`. That is the whole genuineness test: the factory only records launches it made. |
| curve input | `token()` on the pasted address, then the factory record of that token | If the record's `curve` equals the pasted address, the slip is for the token and says so. |
| token / curve code | `eth_getCode` | Runtime bytecode is walked opcode by opcode. PUSH1..PUSH32 immediates are skipped (bytes inside them are data, not opcodes). The Solidity CBOR metadata trailer (length in the last two bytes, map byte `0xa1..0xa3`) is skipped. Counts: `SELFDESTRUCT 0xff`, `DELEGATECALL 0xf4`, `CALLCODE 0xf2`, `CREATE 0xf0`, `CREATE2 0xf5`. |
| proxy | `eth_getStorageAt` at the EIP-1967 implementation and beacon slots; the 45-byte EIP-1167 pattern | A set slot or the minimal-proxy shape means the code behind the address can be swapped. |

On an address the factory does not know, `SELFDESTRUCT` and `CALLCODE` are `STOP` notes (the code can vanish) and a proxy or `DELEGATECALL` is a `WATCH` note (the code can be replaced; many honest tokens are proxies, every rug can be too). On a registered launch every finding is a `WATCH` note, because Pons deploys the same token contract for every launch; if it ever trips, read the code.

A token missing from both factories is also asked for `launchFactory()`, the view a `PonsLauncherToken` carries. When it names a factory the chain table lists (the current V1 factory or an older deployment such as `0x0c37a24F5D23A486FA692d1500881d698B1F77a4`, which made $PONS), that factory's `getLaunchedToken` record is read and the token is on the list as a V1 launch. A factory the table does not list is a claim, noted as such (`claimed-factory`), never proof.

## Open door (any token)

Run for every contract the V2 factory did not make: ordinary tokens and V1 tokens alike.

| Fact | Read | Rule |
| --- | --- | --- |
| function surface | four-byte constants pushed by the runtime code (`PUSH1..PUSH4` immediates, metadata trailer skipped); for an EIP-1967 or EIP-1167 proxy, the implementation's code | Solidity and Vyper dispatchers compare the calldata selector against pushed constants, so the set is the contract's function surface. Matched against a catalogue of signatures token generators use: mint, pause, blacklist, fee, limit, trading switch, upgrade, burn-others, exempt, sweep. A match is a fact about a name in the code; who may call it is not readable from bytes. A miss means "not seen", never "not there". |
| owner | `owner()` (or `getOwner()`) when the surface has it; `eth_getCode` on the result | Zero or a burn address means renounced. A contract owner is named as such (multisig, timelock, or anything else). |
| switches | `paused()`; the first of `tradingOpen()`, `tradingEnabled()`, `tradingActive()`, … the surface has | Read as booleans; `paused == true` or trading `false` is a `STOP` note. |
| transfer simulation | `eth_call` of `transfer(0x…b0ce, 1)` with `from` set to each of the three largest plain-wallet holders (from the explorer), or the deployer when no holder list is available | Nothing is signed or sent. All revert: `STOP`. Some revert: `WATCH` (a blacklist looks like this; the revert reason is quoted). None revert: `INFO`. |
| deployer, age | explorer `creator_address_hash` and creation tx, then `eth_getTransactionReceipt` for the block; `balanceOf(deployer)` | The deployer's share is re-read from the chain. |
| holders | explorer top-50 holders; `holders_count`, `transfers_count` | Top-10-wallets share excludes contracts, burn addresses and the token itself; contracts' share and burned share are listed separately. ≥ 50% in ten wallets is a `WATCH` note. |
| pools | `getPool(token, WETH, fee)` on each factory in the chain's DEX table at 0.01 / 0.05 / 0.3 / 1%; then `balanceOf(pool)` on the token and on WETH | Reserves are the pool's balances at the block. Whether liquidity is locked is not read. |
| explorer feed | `exchange_rate`, `volume_24h`, `circulating_market_cap`, `is_scam` | Shown as the explorer's, never as the chain's. A scam flag is a `STOP` note. |
| activity | explorer's newest page of token transfers | Last transfer time; distinct wallets in the page. > 7 days quiet is a `WATCH` note. |

## Cover charge

The factory holds two anti-snipe terms that every new launch snapshots at creation: `snipeTaxStartBps` (9 900 = 99% as deployed) charged on a buy's quote leg in the launch second, and `snipeTaxSeconds` (15 as deployed, max 60; read as 3 s on 2026-09-18, so the owner does retune it), the window across which the curve decays it to zero. BOUNCER always reads the live values. The deployer and their creator fee recipient are exempted by the factory; wallets the creator declared at launch are exempted too. Everyone else buying inside the window pays it, to the creator.

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
| STOP | not-registered | no contract at the address |
| INFO | not-registered | not a launch; checked as an ordinary token (the note says so) |
| STOP | lookalike-impostor | a registered launch carries this ticker and this address is not it |
| WATCH | claimed-factory | the token names a launch factory the chain table does not list |
| INFO | known-address | a well-known non-launch contract from the chain table ($PONS, the factories) |
| STOP | code | SELFDESTRUCT / CALLCODE on an unregistered address |
| WATCH | code | proxy / DELEGATECALL on an unregistered address; any finding on a registered launch |
| STOP | paused | `paused()` is true |
| STOP | trading-closed | the trading switch is off |
| WATCH | owner-powers | owner not renounced and the code has mint / pause / blacklist / fee / limit / trading / upgrade functions |
| INFO | renounced-with-powers | such functions exist but ownership is renounced |
| WATCH | powers-no-owner | such functions exist and there is no `owner()` to say who may call them |
| INFO | owner-plain / renounced | an owner with no such functions / renounced with none |
| WATCH | unverified | no verified source on the explorer |
| STOP | explorer-scam | the explorer flags the address as a scam |
| STOP | transfer-reverts | every simulated transfer from the largest wallets reverts |
| WATCH | transfer-some-revert | some of them revert |
| INFO | transfer-ok | none revert |
| WATCH | concentrated | top 10 wallets hold ≥ 50% |
| INFO | spread / in-contracts / burned | holder facts |
| WATCH | deployer-holds / owner-holds | the deployer or owner holds ≥ 20% |
| INFO | pools / no-pool | pools on the DEX table and their WETH depth / none found |
| WATCH | pools-empty | a pool exists with no WETH in it |
| INFO | price | the explorer's price, 24 h volume and market cap |
| INFO | deployed | age and deployer |
| INFO | active | last transfer and wallets in the newest transfers |
| WATCH | quiet | no transfer for 7 days, or none indexed |
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

The stamp is `ON THE LIST` when a known factory's record exists, `NOT A LAUNCH` for any other contract (checked as an ordinary token), and `NOT ON THE LIST` when there is no contract at the address or a registered launch carries the same ticker. It is not a score. A launch with five WATCH notes is still on the list; the notes are what to read before paying the cover.
