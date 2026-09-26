# Gas refund calibration

`FuelStation` measures the gas of a buy with `gasleft()`, but part of every
transaction happens outside that window: the 21,000 intrinsic cost, calldata,
and the bookkeeping and ETH payout after the measurement. Two constants cover it.

| Constant | Value | Covers |
| --- | --- | --- |
| `GAS_OVERHEAD` | 50,000 | intrinsic gas, calldata, post-measurement writes, the event, the payout |
| `FIRST_REFUND_GAS` | 17,100 | a wallet's first refund from a tank: its usage slot goes 0 → non-zero (22,100 instead of 5,000) |

The L1 data fee is not estimated: it comes from Arbitrum's `ArbGasInfo`
precompile (`getCurrentTxL1GasFees()` at `0x6C`) for the exact transaction.

## Measured on anvil (browser, real wallet flow)

`script/LocalDemo.s.sol` + `web/index.html`, two buys of 0.01 ETH by the same wallet:

| Buy | Gas paid (receipt) | Refunded (event) | Coverage |
| --- | --- | --- | --- |
| first | 0.0000692 ETH | 0.0000692 ETH | 100% |
| repeat | 0.0000424 ETH | 0.0000425 ETH | 100.2% |

Before calibration (`GAS_OVERHEAD = 35,000`, no first-refund term) the first
buy was covered at 72%.

Re-check on mainnet after deployment with a few real buys: Arbitrum charges L2
gas at the base fee, and the L1 fee comes from the precompile, so coverage
should match. If it drifts, the constants are the only knob.

## Why wallets need extra gas headroom

Wallets estimate gas at a zero gas price. At zero price no refund is due, so the
estimate skips the refund bookkeeping and payout (~60k gas). The station
protects itself (`REFUND_GAS_RESERVE`): if too little gas is left it completes
the buy without a refund instead of running out of gas. The FUEL web app adds
120k gas of headroom to every buy so the refund path always runs; unused gas is
not charged.
