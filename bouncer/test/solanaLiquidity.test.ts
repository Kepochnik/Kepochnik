/**
 * Whether a Solana pool's liquidity can be pulled out from under you.
 *
 * Every test here is written from the direction of the wrong answer, because
 * on this question the wrong answer is always the reassuring one: a zero that
 * reads as "nothing is locked", or a pool type nobody read reported as if it
 * had been.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58Decode, base58Encode } from "../src/chain/base58.js";
import { TOKEN_PROGRAM, type AccountInfo, type SolanaRpc } from "../src/chain/solana.js";
import { CPMM_PROGRAM, WHIRLPOOL_PROGRAM } from "../src/chain/solanaDerived.js";
import { associatedTokenAddress, readSolanaLock, solanaLockInWords } from "../src/chain/solanaLiquidity.js";
import type { SolanaPool } from "../src/chain/solanaPools.js";

const POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const LP_MINT = "8HoQnePLqPj4M7PUDzfw8e3Ymdwgc7NLGnaTUapubyvu";
const OTHER_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

const cpmmPool: SolanaPool = {
  address: POOL,
  program: CPMM_PROGRAM,
  name: "Raydium CPMM",
  concentrated: false,
  tokenReserve: 1_000n,
  quoteMint: "So11111111111111111111111111111111111111112",
  quoteSymbol: "SOL",
  quoteDecimals: 9,
  quoteReserve: 1_000n,
};

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((value >> BigInt(8 * i)) & 0xffn);
  return out;
}

/** A CPMM pool account: LP mint at 136, its decimals at 330, the LP it ever issued at 333. */
function poolAccount(lpMint: string, issued: bigint, decimals = 9, owner = CPMM_PROGRAM): AccountInfo {
  const data = new Uint8Array(400);
  data.set(base58Decode(lpMint), 136);
  data[330] = decimals;
  data.set(u64le(issued), 333);
  return { owner, lamports: 1, executable: false, data };
}

/** An SPL mint: supply at 36, decimals at 44, initialised at 45. */
function mintAccount(supply: bigint): AccountInfo {
  const data = new Uint8Array(82);
  data.set(u64le(supply), 36);
  data[44] = 9;
  data[45] = 1;
  return { owner: TOKEN_PROGRAM, lamports: 1, executable: false, data };
}

/** An SPL token account: its mint at 0, its balance at 64. */
function tokenAccount(mint: string, amount: bigint): AccountInfo {
  const data = new Uint8Array(165);
  data.set(base58Decode(mint), 0);
  data.set(u64le(amount), 64);
  return { owner: TOKEN_PROGRAM, lamports: 1, executable: false, data };
}

/** An endpoint that answers from a table of addresses, and refuses nothing else. */
function rpcFor(pool: AccountInfo | null, accounts: Record<string, AccountInfo>): SolanaRpc {
  return {
    accountInfo: async () => pool,
    multipleAccounts: async (addresses: string[]) => addresses.map((a) => accounts[a] ?? null),
  } as unknown as SolanaRpc;
}

test("a burned LP token is measured exactly, from two numbers the chain already holds", async () => {
  // The pool says it issued a thousand; the mint says a hundred still exist.
  // The other nine hundred were destroyed and can never come back.
  const lock = await readSolanaLock(rpcFor(poolAccount(LP_MINT, 1_000n), { [LP_MINT]: mintAccount(100n) }), cpmmPool);
  assert.equal(lock.read, true);
  assert.equal(lock.burnedBps, 9_000);
  assert.equal(lock.strandedBps, 0);
  assert.equal(lock.freeBps, 1_000);
  assert.match(solanaLockInWords(lock), /90% burned/);
});

test("LP nobody burned is withdrawable, and says so with no hedging", async () => {
  const lock = await readSolanaLock(rpcFor(poolAccount(LP_MINT, 1_000n), { [LP_MINT]: mintAccount(1_000n) }), cpmmPool);
  assert.equal(lock.read, true);
  assert.equal(lock.burnedBps, 0);
  assert.equal(lock.freeBps, 10_000);
  assert.match(solanaLockInWords(lock), /100% withdrawable/);
});

test("LP parked at the incinerator counts, and LP at an account for another mint does not", async () => {
  const ata = associatedTokenAddress(INCINERATOR, LP_MINT);
  assert.ok(ata, "the incinerator's LP account address must be derivable, not searched for");

  const held = await readSolanaLock(
    rpcFor(poolAccount(LP_MINT, 1_000n), { [LP_MINT]: mintAccount(1_000n), [ata]: tokenAccount(LP_MINT, 500n) }),
    cpmmPool,
  );
  assert.equal(held.burnedBps, 0, "sending LP away is not burning it, and must not be reported as burning");
  assert.equal(held.strandedBps, 5_000);
  assert.equal(held.freeBps, 5_000);
  assert.match(held.unread, /incinerator/);

  // The same derived address, holding a different mint. Counting it would
  // credit this pool with somebody else's tokens.
  const wrong = await readSolanaLock(
    rpcFor(poolAccount(LP_MINT, 1_000n), { [LP_MINT]: mintAccount(1_000n), [ata]: tokenAccount(OTHER_MINT, 500n) }),
    cpmmPool,
  );
  assert.equal(wrong.strandedBps, 0);
  assert.equal(wrong.freeBps, 10_000);
});

test("a Whirlpool is not read, and must never look like a pool with nothing locked", async () => {
  const whirlpool: SolanaPool = { ...cpmmPool, program: WHIRLPOOL_PROGRAM, name: "Orca Whirlpool (spacing 64)", concentrated: true };
  let called = false;
  const rpc = {
    accountInfo: async () => { called = true; return null; },
    multipleAccounts: async () => { called = true; return []; },
  } as unknown as SolanaRpc;

  const lock = await readSolanaLock(rpc, whirlpool);
  assert.equal(lock.read, false, "a share of nothing counted is not a share");
  assert.equal(called, false, "and it must not spend a round trip finding that out");
  assert.match(lock.unread, /NFT positions/);
  assert.match(solanaLockInWords(lock), /NFT positions/);
  // The zeroes are there because the type demands numbers. Nothing may read
  // them without checking `read` first.
  assert.equal(lock.burnedBps + lock.strandedBps + lock.freeBps, 0);
});

test("an endpoint that will not answer gives an unread lock, never a confident one", async () => {
  const noPool = await readSolanaLock(rpcFor(null, {}), cpmmPool);
  assert.equal(noPool.read, false);
  assert.match(noPool.unread, /did not answer/);

  const noMint = await readSolanaLock(rpcFor(poolAccount(LP_MINT, 1_000n), {}), cpmmPool);
  assert.equal(noMint.read, false);
  assert.equal(noMint.lpMint, LP_MINT);

  const thrown = {
    accountInfo: async () => poolAccount(LP_MINT, 1_000n),
    multipleAccounts: async () => { throw new Error("429"); },
  } as unknown as SolanaRpc;
  const rateLimited = await readSolanaLock(thrown, cpmmPool);
  assert.equal(rateLimited.read, false);
  assert.match(rateLimited.unread, /did not answer/);
});

test("a pool that issued no LP is not 100% burned", async () => {
  // Dividing by the issued supply when it is zero is how a dead pool turns
  // into the most reassuring line on the slip.
  const lock = await readSolanaLock(rpcFor(poolAccount(LP_MINT, 0n), { [LP_MINT]: mintAccount(0n) }), cpmmPool);
  assert.equal(lock.read, false);
  assert.equal(lock.burnedBps, 0);
  assert.match(lock.unread, /no LP tokens issued/);
});

test("the LP mint address is read from the layout, not assumed", async () => {
  // If the offset were wrong, this would come back as some other pubkey in the
  // account — which is exactly what a silently shifted layout looks like.
  const lock = await readSolanaLock(rpcFor(poolAccount(LP_MINT, 10n), { [LP_MINT]: mintAccount(10n) }), cpmmPool);
  assert.equal(lock.lpMint, LP_MINT);
  assert.equal(base58Encode(base58Decode(lock.lpMint!)), LP_MINT);
});

test("a layout that does not check out is refused, not turned into a number", async () => {
  // This is the failure that matters. The offsets above are recalled, not
  // verified, and a shifted one does not throw — it reads some other eight
  // bytes as the issued supply, and almost any large number there reads as
  // "burned", which is the single most reassuring wrong line this tool could
  // print. Two independent fields have to agree before anything is believed.
  const mismatched = await readSolanaLock(rpcFor(poolAccount(LP_MINT, 1_000n, 6), { [LP_MINT]: mintAccount(0n) }), cpmmPool);
  assert.equal(mismatched.read, false, "the pool's LP decimals disagree with the mint's; the layout is not trusted");
  assert.equal(mismatched.burnedBps, 0, "and emphatically not reported as 100% burned");
  assert.match(mismatched.unread, /not reading this pool's layout correctly/);

  // The other shape of a wrong offset: the number read is smaller than the
  // supply that really exists, which the program cannot produce.
  const impossible = await readSolanaLock(rpcFor(poolAccount(LP_MINT, 10n), { [LP_MINT]: mintAccount(1_000n) }), cpmmPool);
  assert.equal(impossible.read, false);
  assert.match(impossible.unread, /more of this pool's LP token exists/);

  // And the pubkey at the LP mint offset has to be an SPL mint at all.
  const notAMint = await readSolanaLock(rpcFor(poolAccount(LP_MINT, 1_000n), { [LP_MINT]: tokenAccount(OTHER_MINT, 5n) }), cpmmPool);
  assert.equal(notAMint.read, false);
});

test("the share of liquidity a lock covers is carried, because the biggest pool is usually unreadable", async () => {
  // Measured live: the deepest venue for a graduated pump token was an Orca
  // Whirlpool with 5519x more SOL than the Raydium pool the lock could be
  // read from. "Every LP token is still held by somebody" is a fair warning
  // about the pool people trade in and an alarm about nothing when that pool
  // holds a five-thousandth of the market — so the share travels with the lock.
  const lock = await readSolanaLock(rpcFor(poolAccount(LP_MINT, 1_000n), { [LP_MINT]: mintAccount(1_000n) }), cpmmPool);
  assert.equal(lock.shareOfLiquidityBps, 10_000, "a lock read on its own covers everything it knows about");
});

test("a free pool that holds a sliver of the market is INFO, not STOP", async () => {
  // Measured live: the deepest venue for a graduated pump token was an Orca
  // Whirlpool with 5519x more SOL than the deepest Raydium pool — and Raydium
  // is the only one whose ownership can be read at all. Shouting STOP about a
  // pool holding a five-thousandth of the liquidity is how a reader learns to
  // ignore the word.
  const { splNotes } = await import("../src/bouncer/spl.js");
  const lock = {
    pool: POOL,
    name: "Raydium CPMM",
    read: true,
    burnedBps: 0,
    strandedBps: 0,
    freeBps: 10_000,
    lpMint: LP_MINT,
    shareOfLiquidityBps: 2,
    unread: "",
  };
  const slip = {
    chain: { key: "solana", name: "Solana", family: "solana" },
    subject: LP_MINT,
    mint: { decimals: 6, extensions: [], mintAuthority: null, freezeAuthority: null, supply: 1_000n, isInitialized: true, token2022: false },
    market: { curve: null, pools: [], best: null, spot: null, quoteSymbol: "SOL", quotes: [], locks: [lock], note: "" },
    holders: null,
    skipped: [],
  };
  const sliver = splNotes(slip as never).find((n) => n.code === "sol-liquidity-free");
  assert.ok(sliver);
  assert.equal(sliver.level, "info");
  assert.match(sliver.text, /0\.0% of this token/);

  // The same pool holding the market is the warning it was written to be.
  const whole = splNotes({ ...slip, market: { ...slip.market, locks: [{ ...lock, shareOfLiquidityBps: 10_000 }] } } as never).find((n) => n.code === "sol-liquidity-free");
  assert.ok(whole);
  assert.equal(whole.level, "stop");
  assert.doesNotMatch(whole.text, /of this token/, "the size caveat belongs only on the pool it is true of");
});
