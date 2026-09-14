# Rules

Every number DIPLOMA prints is arithmetic on values read from Robinhood Chain at a named block. This page lists the arithmetic so nobody has to trust the tool.

## Transcript (`diploma print`)

| Field | Definition | Source |
| --- | --- | --- |
| launched | block of `TokenLaunched(token, curve, deployer, pairToken, launchConfigId, graduationThreshold)` | Pons V2 factory logs |
| curve swept | block of `LaunchSwept(token, quoteOut, tokenOut)`: trading on the curve ended here | factory logs |
| pool seeded | block of `PoolGraduated(token, positionId, tokenAmount, pairTokenAmount)` or the legacy `PoolGraduated(token, poolId)` | factory logs |
| time to graduate | `timestamp(curve swept) - timestamp(launched)` | block headers |
| quote in | Σ `CurveBuy.quoteIn - fee - tax` between launch and sweep | curve logs |
| quote out | Σ `CurveSell.quoteOut` between launch and sweep | curve logs |
| buyers | distinct `CurveBuy.buyer` (a buy whose `recipient` is the deployer counts for the deployer) | curve logs |
| dev funded | quote in from the deployer ÷ quote in | curve logs, factory record |
| first minute | quote in within 60 s of launch ÷ quote in; 60 s is converted to blocks using the measured seconds-per-block between launch and sweep | curve logs, block headers |
| first buyers | buyers in order of first `CurveBuy`, with ordinal | curve logs |
| raised | `PoolGraduated.pairTokenAmount` (or `LaunchSwept.quoteOut` for the legacy shape) in the pair asset's own units and decimals | factory logs, pair token `decimals()` |
| creator tax, buyback vault | `getLaunchedToken(token).creatorTaxBps`, `.buybackEnabled` | factory |

A holder stub (`--holder <address>`) is the roster entry for that address: ordinal, first buy block, quote spent, number of buys. It says nothing about what the address holds now.

## Grade (`diploma grade`)

| Grade | Rule |
| --- | --- |
| FRESHMAN | fill < 25% |
| SOPHOMORE | 25% ≤ fill < 50% |
| JUNIOR | 50% ≤ fill < 75% |
| SENIOR | fill ≥ 75% |
| DROPOUT | fill < 50% and no `CurveBuy` on the curve for 6 hours (or none inside the window) |
| SWEPT | curve drained, pool not seeded yet |
| GRADUATED | pool seeded |

fill = `realQuoteReserve() / graduationThreshold()` read from the curve at one block. The contract itself graduates on the token side (`sellableTokens() == 0`), which the curve authors document as equivalent.

pace = net quote inflow over the trailing window (`--window`, default 1 h) scaled to one hour. eta = remaining ÷ pace when pace is positive. It is arithmetic, not a forecast: half of Pons graduations complete within a few minutes of launch, so an eta on a curve that is still filling after an hour is describing a curve most graduations do not resemble.

## Yearbook (`diploma class`)

Counts `TokenLaunched`, `LaunchSwept` and `PoolGraduated` inside the block window. graduation rate = launched in window that graduated in window ÷ launched in window. Time-to-graduate uses block deltas times the measured seconds-per-block across the window. Nothing is sampled or extrapolated; if a chunk fails the command fails.

## What DIPLOMA never does

- rank live curves by fill (that is a sniper feed; graduations are shown after the fact)
- score, rate, predict or recommend
- hold keys, sign, or build a transaction
