# BOUNCER · chains

Two things vary, and both live in `src/chain/chains.ts`.

**The launchpad.** Pons V2 was written to run on more than one chain, and it does: Radian is a faithful port of it on Circle's Arc. Where a launchpad exists, its factory record is the whole genuineness test. Where none exists, every address is simply an ordinary token and is checked as one, which is most of what people paste anywhere.

**The family.** An EVM chain is read with `eth_call` and `eth_getLogs` against bytecode, where what a contract can do has to be inferred from its dispatcher. Solana is read with `getAccountInfo` against account layouts, where the two questions that matter most are explicit fields. The read paths are separate on purpose.

| key | chain | family | id | RPC | explorer | launchpad | native |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `robinhood` | Robinhood Chain | evm | 4663 | `rpc.mainnet.chain.robinhood.com` | Blockscout | Pons V2 (+ V1) | ETH |
| `base` | Base | evm | 8453 | `base-rpc.publicnode.com` and three more | Blockscout | none known | ETH |
| `bnb` | BNB Chain | evm | 56 | `bsc-rpc.publicnode.com` and three more | none | none known | BNB |
| `solana` | Solana | solana | — | `api.mainnet-beta.solana.com`, `solana-rpc.publicnode.com` | links only | none known | SOL |
| `arc-testnet` | Arc Testnet | evm | 5042002 | `rpc.testnet.arc.network` | Blockscout | Radian | USDC, 18 native |
| `arc` | Arc | evm | 5042 | `rpc.arc-scan.org` | none | Radian, factory unpublished | USDC, 18 native |

Where ordinary tokens trade, per chain. The fee tiers matter: PancakeSwap's middle tier is 0.25% where Uniswap's is 0.3%, and asking for the wrong one finds no pool at all.

| chain | wrapped native | V3-style | V2-style | Solidly-style |
| --- | --- | --- | --- | --- |
| `robinhood` | WETH `0x0Bd7D308…AD73` | Uniswap V3 `0x1f7d7550…2EfA` | — | — |
| `base` | WETH `0x4200…0006` | Uniswap V3 `0x33128a8f…FDfD` | Uniswap V2 `0x8909Dc15…8eC6` | Aerodrome `0x420DD381…40Da` |
| `bnb` | WBNB `0xbb4CdB9C…095c` | PancakeSwap V3 (0.01 / 0.05 / **0.25** / 1%), Uniswap V3 | PancakeSwap V2 | — |
| `solana` | — | pools not read yet | | |

Notes.

- **Native USDC on Arc.** Gas and the zero pair token are USDC, counted on chain in 18-decimal native units (`msg.value`), while the ERC-20 view of USDC shows 6 decimals. BOUNCER labels amounts from the chain table, so a curve quoted in native USDC prints as `20 USDC`, not `20000000000000000000`.
- **Robinhood Chain's V3 factory** is `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, the one Pons V1 tokens name in `dexFactory()`. The canonical `0x1F98…F984` address has no code on this chain. Ramses V3 pools also exist here and are not in the table yet.
- **Solana** is read as SPL. `getAccountInfo` on the mint gives the mint authority (who can print more) and the freeze authority (who can stop a holder selling) as fields, not inferences. A Token-2022 mint carries its extensions after the base 82 bytes, and those are where a transfer fee, a transfer hook, a permanent delegate, a default-frozen state and a pause switch live. The name comes from the Token-2022 metadata extension when it has one and from a Metaplex account otherwise, whose address is derived locally: SHA-256 over the seeds with a bump counted down from 255 until the result is off the ed25519 curve. Pools, prices and LP locks are not read on Solana yet, and the slip says so rather than leaving a blank where a number should be.
- **BNB Chain has no public Blockscout**, so holders, the deployer, the scam flag and the price feed are not read there. Everything the chain itself answers still is: the code's switches, the owner, whether a holder can sell into the pool, and the pools.
- **Adding a chain** means one entry in `CHAINS`: RPC endpoints, an explorer when there is one, the wrapped native token and whichever DEX factories exist. Nothing else in the read path is chain-specific.
- **Pons V1 factories.** `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (current) and `0x0c37a24F5D23A486FA692d1500881d698B1F77a4` (older; deployed $PONS itself, position #109216 in the 1% WETH pool). A token is read from the older one only when its own `launchFactory()` names it.
- **Radian's factory** is `PonsV2LaunchFactory` from `src/v2/` of the Radian repository, unchanged source, so every read BOUNCER makes on Robinhood Chain (records, curve state, events, anti-snipe terms, launch configs, the hook policy, the PoolManager slots) works there. Radian's own additions (`RadianLaunchRouter`, `RadianExecutor`, the Wall treasury, Proof-of-Fee) are not read; a launch made through the router still lands in the factory's records.
- **Arc mainnet** opens on 2026-09-16. Until Radian publishes its mainnet factory, `--chain arc` needs `--factory`; on the site, paste it under live settings. The crew check and lookalikes need a Blockscout URL, which the table does not have for mainnet yet.
- **Block rate.** Robinhood Chain produces ~10 blocks a second, Arc about one; "the last 24 h" is always pinned to block timestamps, the rate is only used for search-window estimates.

Adding a chain is one entry in `src/chain/chains.ts` and a test.
