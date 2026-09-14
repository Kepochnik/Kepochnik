/**
 * YOUR RECEIPT: one transaction hash, itemised. The receipt's CurveBuy or
 * CurveSell logs are decoded, the curve is resolved to its factory record,
 * and the quote is split into what went into the curve, the protocol fee,
 * the creator tax, and the part of the tax above the creator's own rate,
 * which is what the door charged. Effective price is what was paid per
 * token, fees included; the curve's marginal price after the trade comes
 * from its reserves at that block, when the endpoint still serves it.
 */
import { decodeLog, decodeOutputs, encodeCall, eventTopic, type RawLog } from "../chain/abi.js";
import { CURVE_EVENTS, CURVE_FUNCTIONS, type LaunchedToken } from "../chain/pons.js";
import { NotAPonsLaunch, PonsReader } from "../chain/reader.js";
import type { RpcClient } from "../chain/rpc.js";

export interface TradeReceipt {
  hash: string;
  block: number;
  kind: "buy" | "sell";
  curve: string;
  launch: LaunchedToken | null;
  wallet: string;
  quote: bigint;
  tokens: bigint;
  fee: bigint;
  tax: bigint;
  creatorTaxPart: bigint;
  coverChargePart: bigint;
  /** Quote per whole token, fees included. */
  effectivePrice: bigint;
  /** Curve marginal price after the trade at that block, or null when the endpoint cannot serve the block. */
  marginalPriceAfter: bigint | null;
}

export async function readTradeReceipt(rpc: RpcClient, hash: string, factory: string): Promise<TradeReceipt[]> {
  const receipt = (await rpc.send("eth_getTransactionReceipt", [hash])) as { blockNumber: string; logs: RawLog[]; from: string } | null;
  if (!receipt) throw new Error(`no receipt for ${hash}; is it on this chain?`);
  const block = Number(BigInt(receipt.blockNumber));
  const buyTopic = eventTopic(CURVE_EVENTS.CurveBuy);
  const sellTopic = eventTopic(CURVE_EVENTS.CurveSell);
  const reader = new PonsReader(rpc, factory);
  const out: TradeReceipt[] = [];
  for (const log of receipt.logs) {
    const topic = (log.topics[0] ?? "").toLowerCase();
    if (topic !== buyTopic && topic !== sellTopic) continue;
    const isBuy = topic === buyTopic;
    const decoded = decodeLog(isBuy ? CURVE_EVENTS.CurveBuy : CURVE_EVENTS.CurveSell, log);
    const curve = log.address.toLowerCase();
    let launch: LaunchedToken | null = null;
    try {
      const [tokenRaw] = await rpc.callBatch([{ to: curve, data: encodeCall(CURVE_FUNCTIONS.token, []) }], block);
      const [token] = decodeOutputs(CURVE_FUNCTIONS.token, tokenRaw) as [string];
      launch = await reader.launchedToken(token, block);
      if (launch.curve.toLowerCase() !== curve) launch = null;
    } catch (error) {
      if (!(error instanceof NotAPonsLaunch)) launch = null;
    }
    const quote = (isBuy ? decoded.args.quoteIn : decoded.args.quoteOut) as bigint;
    const tokens = (isBuy ? decoded.args.tokensOut : decoded.args.tokensIn) as bigint;
    const fee = decoded.args.fee as bigint;
    const tax = decoded.args.tax as bigint;
    const creatorTaxPart = launch ? (quote * launch.creatorTaxBps) / 10_000n : tax;
    const coverChargePart = tax > creatorTaxPart ? tax - creatorTaxPart : 0n;
    let marginalPriceAfter: bigint | null = null;
    try {
      const [reservesRaw] = await rpc.callBatch([{ to: curve, data: encodeCall(CURVE_FUNCTIONS.getReserves, []) }], block);
      const [q, t] = decodeOutputs(CURVE_FUNCTIONS.getReserves, reservesRaw) as [bigint, bigint];
      marginalPriceAfter = t === 0n ? null : (q * 10n ** 18n) / t;
    } catch {
      marginalPriceAfter = null;
    }
    out.push({
      hash,
      block,
      kind: isBuy ? "buy" : "sell",
      curve,
      launch,
      wallet: String(isBuy ? decoded.args.buyer : decoded.args.seller).toLowerCase(),
      quote,
      tokens,
      fee,
      tax,
      creatorTaxPart,
      coverChargePart,
      effectivePrice: tokens === 0n ? 0n : (quote * 10n ** 18n) / tokens,
      marginalPriceAfter,
    });
  }
  if (!out.length) throw new Error(`${hash} has no curve buy or sell in it`);
  return out;
}
