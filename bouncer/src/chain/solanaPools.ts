/**
 * Where a Solana token trades, and what a sale would actually pay.
 *
 * Two questions, answered by two different reads, because Solana's venues do
 * not share a shape the way Uniswap forks do.
 *
 * A pump.fun token before it graduates has no pool at all: it trades against a
 * bonding curve whose whole state lives in one account at a program-derived
 * address. That account is exact arithmetic — virtual reserves, a constant
 * product, a published fee — so the sale can be priced to the lamport from a
 * single read. This is the case people paste most, and it is the one where
 * "not read" would be least excusable.
 *
 * Everything else trades in a pool, and the pool is found without the
 * expensive scan people normally use. `getProgramAccounts` is how you would
 * normally search for a pool by mint; public endpoints disable it, and for
 * good reason. Instead: the largest accounts holding the mint are already
 * known, a pool's vault is one of them, and a vault's authority is the pool.
 * Ask that authority for its token accounts and both sides of the pair come
 * back with their balances, no layout parsing at all.
 *
 * What is deliberately NOT done: pricing a concentrated pool. Orca Whirlpools,
 * Raydium CLMM and Meteora DLMM keep their liquidity in ranges, so the vault
 * balances are not what a trade moves through, and a constant-product formula
 * over them would overstate the proceeds worst on exactly the large sale that
 * matters. Those pools are reported with their reserves and left unpriced, the
 * same way a Solidly stable pool is on the EVM side.
 */
import { base58Decode, base58Encode } from "./base58.js";
import { findProgramAddress, type AccountInfo, type SolanaRpc } from "./solana.js";

export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/** Pool programs whose vaults are owned by the pool account itself. */
export const POOL_PROGRAMS: Record<string, { name: string; concentrated: boolean }> = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": { name: "Raydium AMM v4", concentrated: false },
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: { name: "Raydium CPMM", concentrated: false },
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: { name: "Raydium CLMM", concentrated: true },
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: { name: "Orca Whirlpool", concentrated: true },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: { name: "Meteora DLMM", concentrated: true },
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: { name: "Meteora Dynamic AMM", concentrated: false },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: { name: "pump.fun AMM", concentrated: false },
};

/** The bonding curve of a pump.fun token that has not graduated. */
export interface PumpCurve {
  address: string;
  virtualSol: bigint;
  virtualTokens: bigint;
  realSol: bigint;
  realTokens: bigint;
  /** True once the curve has filled and the liquidity has moved to a pool. */
  complete: boolean;
}

export interface SolanaPool {
  /** The pool account. */
  address: string;
  program: string;
  name: string;
  concentrated: boolean;
  /** The pool's balance of the subject token, in its own units. */
  tokenReserve: bigint;
  /** The other side of the pair. */
  quoteMint: string;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteReserve: bigint;
}

export interface SolanaSaleQuote {
  shareBps: number;
  tokensIn: bigint;
  /** Lamports (or quote units) out, fee included. */
  out: bigint;
  /** What the sale realises against the marginal price, in bps. 10 000 means no impact. */
  realisedBps: number;
}

export interface SolanaMarket {
  curve: PumpCurve | null;
  pools: SolanaPool[];
  /** The venue a sale would use. */
  best: { kind: "curve" | "pool"; name: string } | null;
  /** Quote units per whole token at the marginal price, or null when nothing could be priced. */
  spot: number | null;
  quoteSymbol: string;
  quotes: SolanaSaleQuote[];
  /** What the numbers above do and do not include, in one sentence. */
  note: string;
}

const enc = new TextEncoder();
const u64 = (data: Uint8Array, offset: number): bigint => {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  return value;
};

/** The curve account's address for a mint. Derived locally; nothing is trusted. */
export function pumpCurveAddress(mint: string): string | null {
  // base58Decode throws on a character that is not in the alphabet, and this is
  // reached with whatever somebody pasted. A bad address is "no curve here",
  // never an exception that takes the rest of the slip with it.
  let key: Uint8Array;
  try {
    key = base58Decode(mint);
  } catch {
    return null;
  }
  if (key.length !== 32) return null;
  return findProgramAddress([enc.encode("bonding-curve"), key], PUMP_PROGRAM)?.address ?? null;
}

/**
 * The curve layout: an 8-byte Anchor discriminator, then five u64s and a flag.
 * A shorter account is not a curve, and is read as one at nobody's peril.
 */
export function parsePumpCurve(address: string, account: AccountInfo): PumpCurve | null {
  if (account.owner !== PUMP_PROGRAM) return null;
  if (account.data.length < 49) return null;
  return {
    address,
    virtualTokens: u64(account.data, 8),
    virtualSol: u64(account.data, 16),
    realTokens: u64(account.data, 24),
    realSol: u64(account.data, 32),
    complete: account.data[48] === 1,
  };
}

/** The 1% pump.fun takes on a sale, in basis points. */
const PUMP_FEE_BPS = 100n;

/**
 * Selling into the curve: constant product over the VIRTUAL reserves, which is
 * what the program itself uses, then the fee. Returning the real reserves here
 * would be a different and wrong number.
 */
export function quoteCurveSale(curve: PumpCurve, tokensIn: bigint): bigint {
  if (tokensIn <= 0n || curve.virtualTokens === 0n || curve.virtualSol === 0n) return 0n;
  const k = curve.virtualSol * curve.virtualTokens;
  const solAfter = k / (curve.virtualTokens + tokensIn);
  const gross = curve.virtualSol > solAfter ? curve.virtualSol - solAfter : 0n;
  // Never promise more than the curve actually holds.
  const capped = gross > curve.realSol ? curve.realSol : gross;
  return capped - (capped * PUMP_FEE_BPS) / 10_000n;
}

/** Constant product with a fee, for the pools that really are constant product. */
export function quotePoolSale(pool: SolanaPool, tokensIn: bigint, feeBps = 25n): bigint {
  if (tokensIn <= 0n || pool.tokenReserve === 0n || pool.quoteReserve === 0n) return 0n;
  const afterFee = tokensIn - (tokensIn * feeBps) / 10_000n;
  return (pool.quoteReserve * afterFee) / (pool.tokenReserve + afterFee);
}

interface TokenAccount {
  mint: string;
  amount: bigint;
}

/** The SPL token account layout: mint, owner, amount. */
function parseTokenAccount(account: AccountInfo): TokenAccount | null {
  if (account.data.length < 72) return null;
  return { mint: base58Encode(account.data.slice(0, 32)), amount: u64(account.data, 64) };
}

const QUOTES: Record<string, { symbol: string; decimals: number }> = {
  [WSOL]: { symbol: "SOL", decimals: 9 },
  [USDC]: { symbol: "USDC", decimals: 6 },
};

/**
 * Find the pools holding this mint, without a program scan.
 *
 * The largest accounts holding the mint include any pool's vault; a vault's
 * authority is the pool account; a pool account is owned by its program; and
 * the authority's own token accounts are both sides of the pair. Four cheap
 * reads instead of one expensive one that most endpoints refuse anyway.
 */
export interface HolderScan {
  /** The largest accounts holding the mint, as getTokenLargestAccounts returns them. */
  largest: { address: string; amount: bigint }[];
  /** Those accounts' contents, in the same order. */
  accounts: (AccountInfo | null)[];
}

export async function readSolanaPools(rpc: SolanaRpc, mint: string, scan?: HolderScan): Promise<SolanaPool[]> {
  // The holder list needs exactly these two reads as well. Doing them twice was
  // not just wasteful: this client paces every request through one queue, so a
  // duplicated round trip is time taken from whichever section is still
  // waiting, and both sections were losing their deadlines because of it.
  const largest = scan?.largest ?? (await rpc.largestAccounts(mint));
  if (!largest.length) return [];
  const accounts = scan?.accounts ?? (await rpc.multipleAccounts(largest.map((l) => l.address)));

  // A vault's authority. Most of these will be ordinary holders.
  const authorities: string[] = [];
  for (const account of accounts) {
    if (!account || account.data.length < 72) continue;
    const authority = base58Encode(account.data.slice(32, 64));
    if (!authorities.includes(authority)) authorities.push(authority);
  }
  if (!authorities.length) return [];

  const authorityAccounts = await rpc.multipleAccounts(authorities);
  const candidates: { authority: string; program: string; name: string; concentrated: boolean }[] = [];
  for (let i = 0; i < authorities.length; i++) {
    const account = authorityAccounts[i];
    if (!account) continue;
    const program = POOL_PROGRAMS[account.owner];
    if (!program) continue; // an ordinary wallet, not a pool
    candidates.push({ authority: authorities[i], program: account.owner, name: program.name, concentrated: program.concentrated });
  }
  // A busy mint can have many pool-shaped authorities among its largest
  // accounts. Six is plenty for finding the deepest, and bounds the work so
  // this section cannot become the slowest thing on the slip again.
  if (!candidates.length) return [];
  candidates.splice(6);

  // One request per pool, run together. Sequentially this was the slowest part
  // of the whole slip by a wide margin, and a slip nobody waits for is a slip
  // nobody reads.
  const sides = await Promise.all(
    candidates.map((c) => rpc.tokenAccountsByOwner(c.authority).catch(() => null)),
  );

  const pools: SolanaPool[] = [];
  candidates.forEach((c, i) => {
    const vaults = sides[i];
    if (!vaults) return; // this pool's sides could not be listed; the others are unaffected
    const ours = vaults.find((v) => v.mint === mint);
    const other = vaults.find((v) => v.mint !== mint && QUOTES[v.mint]);
    if (!ours || !other) return; // not a pair against something priceable
    const quote = QUOTES[other.mint];
    pools.push({
      address: c.authority,
      program: c.program,
      name: c.name,
      concentrated: c.concentrated,
      tokenReserve: ours.amount,
      quoteMint: other.mint,
      quoteSymbol: quote.symbol,
      quoteDecimals: quote.decimals,
      quoteReserve: other.amount,
    });
  });
  return pools.sort((a, b) => (b.quoteReserve > a.quoteReserve ? 1 : b.quoteReserve < a.quoteReserve ? -1 : 0));
}

const SHARES = [1_000, 2_500, 5_000, 10_000];

/**
 * The market for one mint: the curve when it still has one, the pools
 * otherwise, and what selling a position would pay at each of four sizes.
 */
export async function readSolanaMarket(rpc: SolanaRpc, mint: string, position: bigint, tokenDecimals: number, scan?: HolderScan): Promise<SolanaMarket> {
  const empty: SolanaMarket = { curve: null, pools: [], best: null, spot: null, quoteSymbol: "SOL", quotes: [], note: "" };

  // The curve first: while it is live it IS the market, and it is one read.
  let curve: PumpCurve | null = null;
  const curveAddress = pumpCurveAddress(mint);
  if (curveAddress) {
    try {
      const account = await rpc.accountInfo(curveAddress);
      if (account) curve = parsePumpCurve(curveAddress, account);
    } catch {
      // the curve is simply unread; the pools below still answer
    }
  }

  if (curve && !curve.complete) {
    const scale = 10 ** tokenDecimals;
    const spot = curve.virtualTokens > 0n ? Number(curve.virtualSol) / 1e9 / (Number(curve.virtualTokens) / scale) : null;
    const quotes = position > 0n ? priced(SHARES.map((b) => ({ shareBps: b, tokensIn: (position * BigInt(b)) / 10_000n })), (t) => quoteCurveSale(curve, t), spot, tokenDecimals, 9) : [];
    return {
      curve,
      pools: [],
      best: { kind: "curve", name: "the pump.fun bonding curve" },
      spot,
      quoteSymbol: "SOL",
      quotes,
      note: "Priced on the pump.fun bonding curve's own virtual reserves, with its 1% fee, and capped at the SOL the curve actually holds. It has not graduated, so there is no pool yet.",
    };
  }

  let pools: SolanaPool[] = [];
  try {
    pools = await readSolanaPools(rpc, mint, scan);
  } catch {
    return { ...empty, curve, note: "The pools could not be read from this endpoint." };
  }
  if (!pools.length) {
    // Worth being exact about the method's blind spot. Pools are found by
    // looking at the twenty largest accounts holding the mint, which contains a
    // pool's vault for a token whose pools are among its biggest holders — true
    // of a memecoin, and false of a token like USDC whose largest accounts are
    // all exchanges. "No pool found" here is a statement about this search, not
    // about the token.
    const how = "Pools are found by walking the twenty largest accounts holding this mint and asking which of them belong to a DEX. For a token whose biggest holders are exchanges or treasuries rather than pools, that search comes up empty even though pools exist.";
    return { ...empty, curve, note: `${curve?.complete ? "The bonding curve has graduated, but no" : "No"} pool against SOL or USDC turned up. ${how}` };
  }

  const priceable = pools.filter((p) => !p.concentrated && p.tokenReserve > 0n && p.quoteReserve > 0n);
  const best = priceable[0] ?? null;
  if (!best) {
    return {
      ...empty,
      curve,
      pools,
      quoteSymbol: pools[0].quoteSymbol,
      note: `Found ${pools.length} pool${pools.length === 1 ? "" : "s"}, ${pools.every((p) => p.concentrated) ? "all of them concentrated" : "none of them priceable"}. A concentrated pool keeps its liquidity in ranges, so its vault balances are not what a trade moves through and pricing a sale from them would overstate it — the reserves are shown, the sale is not priced.`,
    };
  }
  const scale = 10 ** tokenDecimals;
  const spot = Number(best.quoteReserve) / 10 ** best.quoteDecimals / (Number(best.tokenReserve) / scale);
  const quotes = position > 0n ? priced(SHARES.map((b) => ({ shareBps: b, tokensIn: (position * BigInt(b)) / 10_000n })), (t) => quotePoolSale(best, t), spot, tokenDecimals, best.quoteDecimals) : [];
  const concentrated = pools.filter((p) => p.concentrated).length;
  return {
    curve,
    pools,
    best: { kind: "pool", name: best.name },
    spot,
    quoteSymbol: best.quoteSymbol,
    quotes,
    note: `Priced on the deepest constant-product pool (${best.name}) at a 0.25% fee${concentrated ? `; ${concentrated} concentrated pool${concentrated === 1 ? "" : "s"} found and deliberately not priced, since their vault balances are not what a trade moves through` : ""}. Pools against pairs other than SOL and USDC are not counted.`,
  };
}

function priced(
  sizes: { shareBps: number; tokensIn: bigint }[],
  sell: (tokensIn: bigint) => bigint,
  spot: number | null,
  tokenDecimals: number,
  quoteDecimals: number,
): SolanaSaleQuote[] {
  return sizes.map(({ shareBps, tokensIn }) => {
    const out = sell(tokensIn);
    const atSpot = spot === null ? 0 : (Number(tokensIn) / 10 ** tokenDecimals) * spot;
    const got = Number(out) / 10 ** quoteDecimals;
    return { shareBps, tokensIn, out, realisedBps: atSpot > 0 ? Math.round((got / atSpot) * 10_000) : 0 };
  });
}
