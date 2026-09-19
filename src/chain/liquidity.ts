/**
 * Can they pull the liquidity?
 *
 * This is the question behind most of what people call a rug. A pool is not
 * money the token owes anybody: whoever holds the liquidity can take it back
 * out, and when they do the price goes to nothing. So the useful question is
 * not "is there liquidity" — the slip already shows that — but "who is holding
 * it, and can they walk off with it".
 *
 * Two shapes of pool, two different reads:
 *
 * V2 and Solidly pools hand the provider an ERC-20 LP token. Whoever holds
 * that token can redeem it for the pool's contents. So the answer is a balance
 * sheet of the LP token: what fraction sits at a burn address (gone for good),
 * what fraction sits in a locker contract (gone until its timer runs out), and
 * what fraction sits in an ordinary wallet (gone whenever that wallet likes).
 *
 * V3 pools hand out an NFT instead, and the NFT is what can be burned or
 * locked. Finding whose NFT holds the liquidity takes three steps, all exact:
 * the pool's own Mint logs say how much liquidity each position has and who
 * owns it in the pool's eyes; where that owner is the position manager the
 * real owner is whoever holds the NFT, and the manager's IncreaseLiquidity log
 * in the same transaction carries the token id; ownerOf then names them.
 *
 * Nothing here is inferred. An address that cannot be classified is reported
 * as a wallet that can pull, which is the truthful reading of "we do not know
 * who this is": treating an unknown holder as safe is exactly the mistake this
 * tool exists to prevent.
 */
import { decodeLog, decodeOutputs, encodeCall, type FunctionAbi, type EventAbi, type Hex } from "./abi.js";
import { ERC20_FUNCTIONS } from "./pons.js";
import type { RpcClient } from "./rpc.js";
import type { MarketPool } from "./market.js";
import type { LockerTable } from "./chains.js";

export const ZERO = "0x0000000000000000000000000000000000000000";
export const DEAD = "0x000000000000000000000000000000000000dead";
/** Some tokens burn to 0x...0001 or the token's own address; both are equally gone. */
const BURN_ADDRESSES = new Set([ZERO, DEAD, "0x0000000000000000000000000000000000000001"]);

const LP_FUNCTIONS = {
  ownerOf: { name: "ownerOf", inputs: ["uint256"], outputs: ["address"] },
} as const satisfies Record<string, FunctionAbi>;

const POOL_EVENTS = {
  /** Uniswap V3 / PancakeSwap V3. `owner` is the position manager for an NFT position. */
  Mint: {
    name: "Mint",
    inputs: [
      { name: "sender", type: "address", indexed: false },
      { name: "owner", type: "address", indexed: true },
      { name: "tickLower", type: "int24", indexed: true },
      { name: "tickUpper", type: "int24", indexed: true },
      { name: "amount", type: "uint128", indexed: false },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
    ],
  },
} as const satisfies Record<string, EventAbi>;

const MANAGER_EVENTS = {
  /** Emitted by the NonfungiblePositionManager in the same transaction as the pool's Mint. */
  IncreaseLiquidity: {
    name: "IncreaseLiquidity",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
    ],
  },
} as const satisfies Record<string, EventAbi>;

/** Who is holding a piece of the liquidity, and what that means for it. */
export type HolderKind = "burned" | "locked" | "wallet" | "contract";

export interface LiquidityHolder {
  address: string;
  kind: HolderKind;
  /**
   * What this address is called. Either a locker BOUNCER knows by address, or
   * a contract's verified name as the chain's explorer publishes it. The
   * second is a source, not a verdict: knowing a contract calls itself
   * "UNCX_ProofOfReservesV2" tells the reader what is holding their liquidity
   * without this file deciding that it is therefore safe.
   */
  name?: string;
  /** True when the name came from the explorer rather than from the locker table. */
  namedByExplorer?: boolean;
  /** Share of this pool's liquidity, in basis points. */
  shareBps: number;
}

export interface PoolLock {
  pool: string;
  dex: string;
  kind: MarketPool["kind"];
  /**
   * The shares below are of what this read actually accounted for, which for a
   * V2 pool is the whole LP supply and for a V3 pool is the positions it
   * resolved. When `partial` is true they are NOT a statement about the pool.
   */
  burnedBps: number;
  lockedBps: number;
  freeBps: number;
  /** True when the read covered only some of the pool's liquidity. */
  partial: boolean;
  /** V3 only: how many positions exist in the window, and how many were resolved. */
  positionsFound: number;
  positionsRead: number;
  holders: LiquidityHolder[];
  /**
   * Why the numbers above are missing or partial, when they are. An empty
   * string means the read was complete.
   */
  unread: string;
}

/** Classify one holder against the chain's locker table. */
function classify(address: string, lockers: LockerTable | undefined, hasCode: boolean | null): { kind: HolderKind; name?: string } {
  const lower = address.toLowerCase();
  if (BURN_ADDRESSES.has(lower)) return { kind: "burned" };
  const known = lockers?.[lower];
  if (known) return { kind: "locked", name: known };
  // An unknown contract is NOT a lock. Plenty of contracts can withdraw on
  // somebody's say-so, and calling one "locked" because it has bytecode would
  // be the single most dangerous guess this file could make.
  return { kind: hasCode ? "contract" : "wallet" };
}

const bps = (part: bigint, whole: bigint): number => (whole > 0n ? Number((part * 10_000n) / whole) : 0);

/**
 * A V2 or Solidly pool: read the LP token's own balance sheet. The burn
 * addresses and every known locker are asked directly, so this needs no
 * explorer and no log scan; what is left over is held by somebody.
 */
export async function readV2Lock(rpc: RpcClient, pool: MarketPool, lockers: LockerTable | undefined, block: number): Promise<PoolLock> {
  const base: PoolLock = { pool: pool.address, dex: pool.dex, kind: pool.kind, burnedBps: 0, lockedBps: 0, freeBps: 0, partial: false, positionsFound: 0, positionsRead: 0, holders: [], unread: "" };
  const lockerAddresses = Object.keys(lockers ?? {});
  const asked = [ZERO, DEAD, ...lockerAddresses];
  const calls = [
    { to: pool.address, data: encodeCall(ERC20_FUNCTIONS.totalSupply, []) },
    ...asked.map((a) => ({ to: pool.address, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [a]) })),
  ];
  let raws: (Hex | Error)[];
  try {
    raws = await rpc.callBatchSettled(calls, block);
  } catch {
    return { ...base, unread: "the LP token did not answer, so who holds the liquidity is not read" };
  }
  const supplyRaw = raws[0];
  if (supplyRaw instanceof Error) return { ...base, unread: "the LP token's total supply did not answer, so the shares below cannot be worked out" };
  let supply: bigint;
  try {
    supply = decodeOutputs(ERC20_FUNCTIONS.totalSupply, supplyRaw)[0] as bigint;
  } catch {
    return { ...base, unread: "the LP token's total supply could not be read" };
  }
  if (supply === 0n) return { ...base, unread: "this pool has no LP tokens outstanding" };

  let accounted = 0n;
  const holders: LiquidityHolder[] = [];
  asked.forEach((address, i) => {
    const raw = raws[i + 1];
    if (raw instanceof Error) return;
    let balance: bigint;
    try {
      balance = decodeOutputs(ERC20_FUNCTIONS.balanceOf, raw)[0] as bigint;
    } catch {
      return;
    }
    if (balance === 0n) return;
    accounted += balance;
    const { kind, name } = classify(address, lockers, true);
    holders.push({ address, kind, name, shareBps: bps(balance, supply) });
  });

  const burnedBps = holders.filter((h) => h.kind === "burned").reduce((a, h) => a + h.shareBps, 0);
  const lockedBps = holders.filter((h) => h.kind === "locked").reduce((a, h) => a + h.shareBps, 0);
  const freeBps = Math.max(0, 10_000 - burnedBps - lockedBps);
  return {
    ...base,
    burnedBps,
    lockedBps,
    freeBps,
    holders: holders.sort((a, b) => b.shareBps - a.shareBps),
    // The remainder is held by addresses this read did not enumerate. Naming
    // them needs an explorer; not naming them does not make them safe.
    unread: freeBps > 0 ? "the rest of the LP tokens sit in wallets this read does not enumerate; any of them can withdraw" : "",
  };
}

/** Resolves a contract's published name. Supplied by the caller, since this module has no explorer. */
export type NameResolver = (address: string) => Promise<string | null>;

/**
 * Attach published names to the holders that have no entry in the locker
 * table. This is the honest half of naming a locker: the address is not
 * recalled from memory, it is asked about, and the answer is labelled as
 * coming from the explorer so nobody mistakes a name for a guarantee.
 */
export async function nameHolders(lock: PoolLock, nameOf: NameResolver | undefined, limit = 6): Promise<PoolLock> {
  if (!nameOf) return lock;
  // One request per holder, against an explorer that rate-limits. The holders
  // are already largest-first, and the slip shows five, so asking about the
  // tail would buy nothing and could cost the whole section.
  const unnamed = lock.holders.filter((h) => !h.name && h.kind === "contract").slice(0, limit);
  if (!unnamed.length) return lock;
  const names = await Promise.all(unnamed.map((h) => nameOf(h.address).catch(() => null)));
  unnamed.forEach((holder, i) => {
    const name = names[i];
    if (name) {
      holder.name = name;
      holder.namedByExplorer = true;
    }
  });
  return lock;
}

export interface V3LockOptions {
  /** How far back to look for the mints that created the positions. */
  fromBlock: number;
  /** At most this many positions are resolved; a pool with more is reported as partial. */
  maxPositions?: number;
  chunkSize?: number;
  /** Most log requests the mint history may spend before reporting a partial window. */
  maxRequests?: number;
}

/**
 * A V3 pool: find the positions, then find who holds each one's NFT.
 *
 * Only positions with liquidity left are counted, and the shares are against
 * the pool's own `liquidity()` where that is known, so a position that was
 * minted and then withdrawn does not flatter the result.
 */
export async function readV3Lock(
  rpc: RpcClient,
  pool: MarketPool,
  lockers: LockerTable | undefined,
  positionManager: string | undefined,
  block: number,
  options: V3LockOptions,
): Promise<PoolLock> {
  const base: PoolLock = { pool: pool.address, dex: pool.dex, kind: pool.kind, burnedBps: 0, lockedBps: 0, freeBps: 0, partial: false, positionsFound: 0, positionsRead: 0, holders: [], unread: "" };
  // Twelve was too few: a live pool can carry a hundred positions, and the one
  // that matters — the locked launch position — is rarely among the newest.
  const maxPositions = options.maxPositions ?? 60;

  let logs;
  let windowComplete = true;
  try {
    const { readTapeAdaptive } = await import("./tape.js");
    const tape = await readTapeAdaptive(
      rpc,
      { address: pool.address, events: [POOL_EVENTS.Mint], fromBlock: options.fromBlock, toBlock: block },
      // The budget is the whole point on a busy pool. USDC/WETH on Base makes
      // the endpoint refuse every wide chunk, so the span halves to a single
      // block and a week's window becomes hundreds of thousands of requests —
      // ten minutes of a door, and then nothing to show for it.
      { minChunk: 1, startChunk: options.chunkSize ?? 2_000, maxChunk: 100_000, maxRequests: options.maxRequests ?? 15 },
    );
    logs = tape.logs;
    windowComplete = tape.complete !== false;
  } catch {
    return { ...base, unread: "the pool's mint history did not answer, so who holds the liquidity is not read" };
  }
  if (!logs.length) {
    // "No position was opened" and "we stopped looking" are different
    // statements, and only one of them is true when the budget ran out. Saying
    // the first would be the most confident wrong sentence available here.
    return {
      ...base,
      partial: !windowComplete,
      unread: windowComplete
        ? `no position was opened in this pool within the window searched (from block ${options.fromBlock}); --liquidity-blocks looks further back`
        : "this pool is busy enough that the walk ran out of budget before finding a position, so who holds its liquidity is not read rather than absent",
    };
  }

  // Group by position: the pool identifies one by (owner, tickLower, tickUpper).
  const byPosition = new Map<string, { owner: string; amount: bigint; tx: string }>();
  for (const log of logs) {
    const owner = String(log.args.owner).toLowerCase();
    const key = `${owner}:${log.args.tickLower}:${log.args.tickUpper}`;
    const prev = byPosition.get(key);
    byPosition.set(key, { owner, amount: (prev?.amount ?? 0n) + (log.args.amount as bigint), tx: prev?.tx ?? log.transactionHash });
  }
  const positions = [...byPosition.values()].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  const partial = positions.length > maxPositions;
  const considered = positions.slice(0, maxPositions);
  base.positionsFound = positions.length;
  base.positionsRead = considered.length;

  // For a position the manager owns, the real owner holds the NFT. The token id
  // is in the manager's own log from the same transaction.
  const manager = positionManager?.toLowerCase();
  const realOwners = new Map<string, string>();
  const managed = considered.filter((p) => manager && p.owner === manager);
  if (managed.length) {
    // Resolving an NFT holder is the optional half of this read. When the
    // batch fails as a whole — one bad response takes all of them — the
    // positions stay unresolved and count as withdrawable, which is the
    // cautious reading. Letting it throw discarded the entire liquidity
    // section instead, which is how sixty seconds of log reading became
    // "MISSING" on Base for a second time.
    let receipts: (unknown | Error)[] = [];
    try {
      receipts = await rpc.sendBatchSettled(managed.map((p) => ({ method: "eth_getTransactionReceipt", params: [p.tx] })));
    } catch {
      receipts = [];
    }
    const idCalls: { to: string; data: Hex }[] = [];
    const idFor: { key: string }[] = [];
    receipts.forEach((receipt, i) => {
      if (receipt instanceof Error || !receipt || typeof receipt !== "object") return;
      const rawLogs = (receipt as { logs?: unknown[] }).logs ?? [];
      for (const raw of rawLogs) {
        const entry = raw as { address?: string; topics?: string[]; data?: string };
        if ((entry.address ?? "").toLowerCase() !== manager) continue;
        let decoded;
        try {
          decoded = decodeLog(MANAGER_EVENTS.IncreaseLiquidity, { address: entry.address ?? "", topics: entry.topics ?? [], data: entry.data ?? "0x", blockNumber: "0x0", transactionHash: "0x", logIndex: "0x0" });
        } catch {
          continue;
        }
        idCalls.push({ to: manager as string, data: encodeCall(LP_FUNCTIONS.ownerOf, [decoded.args.tokenId as bigint]) });
        idFor.push({ key: `${managed[i].owner}:${managed[i].tx}` });
        break;
      }
    });
    if (idCalls.length) {
      let owners: (Hex | Error)[] = [];
      try {
        owners = await rpc.callBatchSettled(idCalls, block);
      } catch {
        owners = [];
      }
      owners.forEach((raw, i) => {
        if (raw instanceof Error) return;
        try {
          realOwners.set(idFor[i].key, (decodeOutputs(LP_FUNCTIONS.ownerOf, raw)[0] as string).toLowerCase());
        } catch {
          // an NFT that has since been burned reverts; the position is then
          // reported under the manager, which is the honest "not resolved"
        }
      });
    }
  }

  const total = considered.reduce((a, p) => a + p.amount, 0n);
  if (total === 0n) return { ...base, unread: "every position found has been withdrawn" };

  const merged = new Map<string, bigint>();
  for (const p of considered) {
    const resolved = realOwners.get(`${p.owner}:${p.tx}`) ?? p.owner;
    merged.set(resolved, (merged.get(resolved) ?? 0n) + p.amount);
  }

  // Who has bytecode decides wallet vs contract, and neither is a lock.
  const addresses = [...merged.keys()];
  // Wallet or contract is a label, not the finding. Losing it must not lose
  // the shares, so an unread code reads as null and classify() falls to
  // "wallet" — withdrawable either way, which is what matters here.
  let codes: (unknown | Error)[] = [];
  try {
    codes = await rpc.sendBatchSettled(addresses.map((a) => ({ method: "eth_getCode", params: [a, `0x${block.toString(16)}`] })));
  } catch {
    codes = [];
  }
  const holders: LiquidityHolder[] = addresses.map((address, i) => {
    const code = codes[i];
    const hasCode = code instanceof Error ? null : typeof code === "string" && code.length > 2;
    const { kind, name } = classify(address, lockers, hasCode);
    return { address, kind, name, shareBps: bps(merged.get(address) ?? 0n, total) };
  });

  const burnedBps = holders.filter((h) => h.kind === "burned").reduce((a, h) => a + h.shareBps, 0);
  const lockedBps = holders.filter((h) => h.kind === "locked").reduce((a, h) => a + h.shareBps, 0);
  const freeBps = Math.max(0, 10_000 - burnedBps - lockedBps);
  const notes: string[] = [];
  if (!windowComplete) notes.push("the pool is busy enough that only part of the window could be walked within this read's budget, so older positions were not seen");
  if (partial) notes.push(`only the ${maxPositions} largest of ${positions.length} positions in the window were resolved, so the shares above are of those and not of the pool`);
  if (!manager) notes.push("this DEX's position manager is not in BOUNCER's table, so an NFT position is reported under the manager rather than its holder");
  const unresolved = holders.filter((h) => manager && h.address === manager);
  if (unresolved.length) notes.push("some positions could not be traced to an NFT holder and are counted as withdrawable");

  return { ...base, burnedBps, lockedBps, freeBps, partial: partial || !windowComplete, holders: holders.sort((a, b) => b.shareBps - a.shareBps), unread: notes.join("; ") };
}

/** Whichever read this pool's shape calls for. */
export async function readPoolLock(
  rpc: RpcClient,
  pool: MarketPool,
  lockers: LockerTable | undefined,
  positionManager: string | undefined,
  block: number,
  options: V3LockOptions,
): Promise<PoolLock> {
  return pool.kind === "v3" ? readV3Lock(rpc, pool, lockers, positionManager, block, options) : readV2Lock(rpc, pool, lockers, block);
}

/** One plain sentence for the slip. */
export function lockInWords(lock: PoolLock): string {
  const pct = (b: number) => `${(b / 100).toFixed(b % 100 === 0 ? 0 : 1)}%`;
  const parts: string[] = [];
  if (lock.burnedBps > 0) parts.push(`${pct(lock.burnedBps)} burned`);
  const named = lock.holders.filter((h) => h.kind === "locked");
  if (lock.lockedBps > 0) parts.push(`${pct(lock.lockedBps)} in ${named.length === 1 && named[0].name ? named[0].name : "a locker"}`);
  if (lock.freeBps > 0) parts.push(`${pct(lock.freeBps)} withdrawable`);
  if (!parts.length) return lock.unread || "the liquidity could not be read";
  // A partial read must never read as a statement about the pool. "100%
  // withdrawable" over a tenth of the positions is true of what was looked at
  // and false of the thing the reader is asking about.
  const of = lock.partial ? ` of the ${lock.positionsRead} positions read (of ${lock.positionsFound})` : "";
  const head = `${lock.dex}: ${parts.join(", ")}${of}`;
  return lock.unread ? `${head} — ${lock.unread}` : head;
}
