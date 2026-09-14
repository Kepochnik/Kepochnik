/**
 * THE BOARD: who ran the door tonight. Two boards over one block window.
 * Deployers: launches, graduations, the serial launchers with nothing to
 * show. Cover charge: every CurveBuy the chain logged in the window, the
 * part of each tax above the curve's own creator rate (what the door took),
 * summed per curve and per payer. No names, no scores: counts and sums,
 * pinned to the window's blocks.
 */
import { decodeOutputs, encodeCall } from "../chain/abi.js";
import { CURVE_EVENTS, CURVE_FUNCTIONS, FACTORY_EVENTS, PONS_V2_FACTORY } from "../chain/pons.js";
import type { RpcClient } from "../chain/rpc.js";
import { readTape, readTapeAdaptive } from "../chain/tape.js";

export interface DevRow {
  deployer: string;
  launched: number;
  swept: number;
  graduated: number;
  tokens: string[];
}

export interface CoverRow {
  curve: string;
  token: string | null;
  creatorTaxBps: bigint;
  buys: number;
  taxedBuys: number;
  coverCollected: bigint;
  highestBps: number;
}

export interface PayerRow {
  wallet: string;
  buys: number;
  coverPaid: bigint;
}

export interface Board {
  window: { fromBlock: number; toBlock: number };
  launches: number;
  graduations: number;
  deployers: number;
  topDeployers: DevRow[];
  serial: DevRow[];
  coverTotal: bigint;
  taxedBuys: number;
  topCurves: CoverRow[];
  topPayers: PayerRow[];
  chunks: number;
}

export interface BoardOptions {
  fromBlock: number;
  toBlock: number;
  factory?: string;
  top?: number;
  /** Chunk for the chain-wide CurveBuy read; the adaptive reader halves it on range errors. */
  chunkSize?: number;
  /** Skip the chain-wide cover read (the dev board alone is cheap). */
  skipCover?: boolean;
}

export async function readBoard(rpc: RpcClient, options: BoardOptions): Promise<Board> {
  const factory = options.factory ?? PONS_V2_FACTORY;
  const top = options.top ?? 10;
  const ledger = await readTapeAdaptive(
    rpc,
    { fromBlock: options.fromBlock, toBlock: options.toBlock, address: factory, events: [FACTORY_EVENTS.TokenLaunched, FACTORY_EVENTS.LaunchSwept, FACTORY_EVENTS.PoolGraduated, FACTORY_EVENTS.PoolGraduatedLegacy] },
    { startChunk: options.chunkSize ?? 5_000, maxChunk: options.chunkSize ?? 20_000 },
  );
  const byDeployer = new Map<string, DevRow>();
  const tokenToDeployer = new Map<string, string>();
  const curveToToken = new Map<string, string>();
  let launches = 0;
  let graduations = 0;
  for (const l of ledger.logs) {
    const token = String(l.args.token).toLowerCase();
    if (l.name === "TokenLaunched") {
      const deployer = String(l.args.deployer).toLowerCase();
      launches++;
      tokenToDeployer.set(token, deployer);
      curveToToken.set(String(l.args.curve).toLowerCase(), token);
      const row = byDeployer.get(deployer) ?? { deployer, launched: 0, swept: 0, graduated: 0, tokens: [] };
      row.launched++;
      row.tokens.push(token);
      byDeployer.set(deployer, row);
    } else if (l.name === "LaunchSwept") {
      const d = tokenToDeployer.get(token);
      if (d) byDeployer.get(d)!.swept++;
    } else if (l.name === "PoolGraduated") {
      graduations++;
      const d = tokenToDeployer.get(token);
      if (d) byDeployer.get(d)!.graduated++;
    }
  }
  const rows = [...byDeployer.values()];
  const topDeployers = rows.slice().sort((a, b) => b.graduated - a.graduated || b.launched - a.launched).slice(0, top);
  const serial = rows.filter((r) => r.launched >= 5 && r.graduated === 0).sort((a, b) => b.launched - a.launched).slice(0, top);

  let coverTotal = 0n;
  let taxedBuys = 0;
  let topCurves: CoverRow[] = [];
  let topPayers: PayerRow[] = [];
  let chunks = ledger.chunks;
  if (!options.skipCover) {
    const buys = await readTapeAdaptive(
      rpc,
      { fromBlock: options.fromBlock, toBlock: options.toBlock, events: [CURVE_EVENTS.CurveBuy] },
      { startChunk: Math.min(options.chunkSize ?? 2_000, 2_000), maxChunk: options.chunkSize ?? 10_000 },
    );
    chunks += buys.chunks;
    const curves = [...new Set(buys.logs.map((l) => l.address.toLowerCase()))];
    const rates = new Map<string, bigint>();
    for (let i = 0; i < curves.length; i += 50) {
      const slice = curves.slice(i, i + 50);
      const raw = await rpc.callBatch(slice.map((c) => ({ to: c, data: encodeCall(CURVE_FUNCTIONS.creatorTaxBps, []) })), options.toBlock).catch(() => null);
      slice.forEach((c, j) => {
        try {
          rates.set(c, raw ? (decodeOutputs(CURVE_FUNCTIONS.creatorTaxBps, raw[j])[0] as bigint) : 0n);
        } catch {
          rates.set(c, 0n);
        }
      });
    }
    const perCurve = new Map<string, CoverRow>();
    const perPayer = new Map<string, PayerRow>();
    for (const l of buys.logs) {
      const curve = l.address.toLowerCase();
      const rate = rates.get(curve) ?? 0n;
      const quoteIn = l.args.quoteIn as bigint;
      const tax = l.args.tax as bigint;
      const creatorPart = (quoteIn * rate) / 10_000n;
      const cover = tax > creatorPart ? tax - creatorPart : 0n;
      const row = perCurve.get(curve) ?? { curve, token: curveToToken.get(curve) ?? null, creatorTaxBps: rate, buys: 0, taxedBuys: 0, coverCollected: 0n, highestBps: 0 };
      row.buys++;
      if (cover > 0n) {
        row.taxedBuys++;
        row.coverCollected += cover;
        row.highestBps = Math.max(row.highestBps, quoteIn === 0n ? 0 : Number((cover * 10_000n) / quoteIn));
        taxedBuys++;
        coverTotal += cover;
        const buyer = String(l.args.buyer).toLowerCase();
        const p = perPayer.get(buyer) ?? { wallet: buyer, buys: 0, coverPaid: 0n };
        p.buys++;
        p.coverPaid += cover;
        perPayer.set(buyer, p);
      }
      perCurve.set(curve, row);
    }
    topCurves = [...perCurve.values()].filter((r) => r.coverCollected > 0n).sort((a, b) => (b.coverCollected > a.coverCollected ? 1 : -1)).slice(0, top);
    topPayers = [...perPayer.values()].sort((a, b) => (b.coverPaid > a.coverPaid ? 1 : -1)).slice(0, top);
  }
  return { window: { fromBlock: options.fromBlock, toBlock: options.toBlock }, launches, graduations, deployers: rows.length, topDeployers, serial, coverTotal, taxedBuys, topCurves, topPayers, chunks };
}

export { readTape };
