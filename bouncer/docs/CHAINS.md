# BOUNCER · chains

Pons V2 was written to run on more than one chain, and it does: Radian is a faithful port of the Pons V2 contracts on Circle's Arc, quoted in native USDC. BOUNCER reads both with the same code; only the table below differs.

| key | chain | id | RPC | explorer (Blockscout) | factory | launchpad | native quote |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `robinhood` | Robinhood Chain | 4663 | `https://rpc.mainnet.chain.robinhood.com` | `https://robinhoodchain.blockscout.com` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | Pons V2 | ETH, 18 |
| `arc-testnet` | Arc Testnet | 5042002 | `https://rpc.testnet.arc.network`, `https://rpc.testnet.arc.io` | `https://testnet.arcscan.app` | `0x90022cC2107De9c070F889E3A67009FcA270E4E2` | Radian (Pons V2 port) | USDC, 18 native |
| `arc` | Arc | 5042 | `https://rpc.arc-scan.org` (independent; Circle's official endpoint goes here once published) | not known yet | not published yet: `--factory 0x…` | Radian (Pons V2 port) | USDC, 18 native |

Notes.

- **Native USDC on Arc.** Gas and the zero pair token are USDC, counted on chain in 18-decimal native units (`msg.value`), while the ERC-20 view of USDC shows 6 decimals. BOUNCER labels amounts from the chain table, so a curve quoted in native USDC prints as `20 USDC`, not `20000000000000000000`.
- **Robinhood Chain DEX table.** Ordinary tokens are looked up on the Uniswap V3 factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` (the one Pons V1 tokens name in `dexFactory()`) against WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`. The canonical `0x1F98…F984` address has no code on this chain. Ramses V3 pools also exist on the chain and are not in the table yet.
- **Pons V1 factories.** `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (current) and `0x0c37a24F5D23A486FA692d1500881d698B1F77a4` (older; deployed $PONS itself, position #109216 in the 1% WETH pool). A token is read from the older one only when its own `launchFactory()` names it.
- **Radian's factory** is `PonsV2LaunchFactory` from `src/v2/` of the Radian repository, unchanged source, so every read BOUNCER makes on Robinhood Chain (records, curve state, events, anti-snipe terms, launch configs, the hook policy, the PoolManager slots) works there. Radian's own additions (`RadianLaunchRouter`, `RadianExecutor`, the Wall treasury, Proof-of-Fee) are not read; a launch made through the router still lands in the factory's records.
- **Arc mainnet** opens on 2026-09-16. Until Radian publishes its mainnet factory, `--chain arc` needs `--factory`; on the site, paste it under live settings. The crew check and lookalikes need a Blockscout URL, which the table does not have for mainnet yet.
- **Block rate.** Robinhood Chain produces ~10 blocks a second, Arc about one; "the last 24 h" is always pinned to block timestamps, the rate is only used for search-window estimates.

Adding a chain is one entry in `src/chain/chains.ts` and a test.
