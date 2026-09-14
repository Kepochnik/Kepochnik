/**
 * POSITION: one wallet, one launch, no wallet connect. The wallet's own
 * buys and sells on the curve (indexed by buyer/seller), its balance now,
 * what the exit door pays for it, and the fees and taxes it has already
 * paid. Cost basis is what left the wallet, fees included, minus what came
 * back on sells.
 */
import { decodeOutputs, encodeCall } from "../chain/abi.js";
import { CURVE_EVENTS, ERC20_FUNCTIONS, type LaunchedToken } from "../chain/pons.js";
import type { RpcClient } from "../chain/rpc.js";
import { addressTopic, readTape } from "../chain/tape.js";
import { readExitDoor, type ExitDoor } from "./exitDoor.js";

export interface PositionTrade {
  block: number;
  kind: "buy" | "sell";
  quote: bigint;
  tokens: bigint;
  fee: bigint;
  tax: bigint;
  tx: string;
}

export interface Position {
  wallet: string;
  token: string;
  balance: bigint;
  trades: PositionTrade[];
  spentQuote: bigint;
  receivedQuote: bigint;
  feesPaid: bigint;
  taxesPaid: bigint;
  costBasis: bigint;
  exit: ExitDoor;
  /** Net if the whole balance walked out now, minus cost basis. */
  unrealised: bigint;
}

export async function readPosition(rpc: RpcClient, launch: LaunchedToken, wallet: string, fromBlock: number, toBlock: number, factory: string, chunkSize = 2_000): Promise<Position> {
  const who = wallet.toLowerCase();
  const buys = await readTape(rpc, { fromBlock, toBlock, address: launch.curve, events: [CURVE_EVENTS.CurveBuy], topics: [addressTopic(who)], chunkSize });
  const sells = await readTape(rpc, { fromBlock, toBlock, address: launch.curve, events: [CURVE_EVENTS.CurveSell], topics: [addressTopic(who)], chunkSize });
  const trades: PositionTrade[] = [
    ...buys.logs.map((l) => ({ block: l.blockNumber, kind: "buy" as const, quote: l.args.quoteIn as bigint, tokens: l.args.tokensOut as bigint, fee: l.args.fee as bigint, tax: l.args.tax as bigint, tx: l.transactionHash })),
    ...sells.logs.map((l) => ({ block: l.blockNumber, kind: "sell" as const, quote: l.args.quoteOut as bigint, tokens: l.args.tokensIn as bigint, fee: l.args.fee as bigint, tax: l.args.tax as bigint, tx: l.transactionHash })),
  ].sort((a, b) => a.block - b.block);
  const [balanceRaw] = await rpc.callBatch([{ to: launch.token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [who]) }], toBlock);
  const [balance] = decodeOutputs(ERC20_FUNCTIONS.balanceOf, balanceRaw) as [bigint];
  const spentQuote = trades.filter((t) => t.kind === "buy").reduce((a, t) => a + t.quote, 0n);
  const receivedQuote = trades.filter((t) => t.kind === "sell").reduce((a, t) => a + t.quote, 0n);
  const feesPaid = trades.reduce((a, t) => a + t.fee, 0n);
  const taxesPaid = trades.reduce((a, t) => a + t.tax, 0n);
  const exit = await readExitDoor(rpc, launch, { position: balance, block: toBlock, factory });
  const whole = exit.quotes.find((q) => q.shareBps === 10_000);
  const costBasis = spentQuote - receivedQuote;
  return { wallet: who, token: launch.token.toLowerCase(), balance, trades, spentQuote, receivedQuote, feesPaid, taxesPaid, costBasis, exit, unrealised: (whole?.net ?? 0n) - costBasis };
}
