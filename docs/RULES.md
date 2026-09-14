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

The stamp is `ON THE LIST` when the factory record exists and `NOT ON THE LIST` otherwise. It is not a score. A launch with five WATCH notes is still on the list; the notes are what to read before paying the cover.
