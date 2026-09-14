# Limitations

Written before launch so nobody finds them for us.

- **Public RPC limits.** `https://rpc.mainnet.chain.robinhood.com` is rate limited, caps `eth_getLogs` at 10,000 results per request and is not an archive node. DIPLOMA spaces requests, retries on 429 with backoff, reads in block chunks (`--chunk`) and pins every `eth_call` to a recent block. A very busy curve can still exceed the log cap for a chunk; lower `--chunk` or pass `--rpc` with a paid endpoint.
- **Windows, not history.** `print` looks back `--hours` (default 72) for the token's factory events. A graduation older than that needs a wider window; a launch older than the window produces a diploma with `transcript: unknown` rather than a guess.
- **Legacy graduations.** Older factory versions emitted `PoolGraduated(token, poolId)`. For those the diploma shows the pool id instead of a position id and takes `raised` from `LaunchSwept`.
- **Buyer attribution.** Buyers are attributed by the `buyer` field of `CurveBuy`; a buy routed through a contract shows the router unless its `recipient` is the deployer. Bundled wallets funded by one hand are counted as separate buyers. The transcript reports what the curve saw, not who was behind it.
- **First minute is a block window.** 60 seconds is converted to blocks with the seconds-per-block measured between launch and sweep, so it is exact to about one block.
- **Stock-quoted curves.** Thresholds and amounts are read in the pair asset's own decimals from the pair token contract; the label is its `symbol()`. There is no price conversion to USD anywhere.
- **Fees.** `quote in` is net of the curve fee and creator tax on each buy, matching the reserve the curve actually kept. Gas is not included.
- **Yearbook** only counts launches whose graduation also fell inside the window; a graduation whose launch is older is listed separately, not silently merged.
- **Grades are arithmetic on one block** and change on the next. A DROPOUT can wake up; a SENIOR can stall for a week.
- **Demo mode** is synthetic. Every address in it is invented and it is labelled DEMO on every screen.
- **No alerts, no web page, no bot** in v0.1. A `watch` loop in a terminal is the whole surface.
