/**
 * Where a Solana token trades and what a sale pays. The arithmetic here is
 * checked against the shape the programs themselves use, and the refusals are
 * checked as hard as the answers: a concentrated pool priced with a
 * constant-product formula would flatter a large sale exactly when it matters.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountInfo, SolanaRpc } from "../src/chain/solana.js";
import {
  PUMP_PROGRAM,
  USDC,
  WSOL,
  parsePumpCurve,
  pumpCurveAddress,
  quoteCurveSale,
  quotePoolSale,
  readSolanaMarket,
  readSolanaPools,
  marketNote,
  type SolanaPool,
} from "../src/chain/solanaPools.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const RAYDIUM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";


function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** A pump.fun curve account: discriminator, five u64s, then the completion flag. */
function curveAccount(vTokens: bigint, vSol: bigint, rTokens: bigint, rSol: bigint, complete = false): AccountInfo {
  const data = new Uint8Array(49);
  data.set(u64le(vTokens), 8);
  data.set(u64le(vSol), 16);
  data.set(u64le(rTokens), 24);
  data.set(u64le(rSol), 32);
  data[48] = complete ? 1 : 0;
  return { owner: PUMP_PROGRAM, lamports: 1, executable: false, data };
}

test("the curve address is derived locally and is a real off-curve address", () => {
  const address = pumpCurveAddress(MINT);
  assert.ok(address, "a valid mint must produce a curve address");
  assert.notEqual(address, MINT);
  // Deriving twice must agree; a bump search that wandered would not.
  assert.equal(pumpCurveAddress(MINT), address);
  assert.equal(pumpCurveAddress("not base58 at all!!"), null);
});

test("a curve is only read out of an account the pump program owns", () => {
  const good = curveAccount(1_000_000n, 1_000n, 500_000n, 500n);
  assert.ok(parsePumpCurve("x", good));
  // The same bytes under another program are not a curve, and reading them as
  // one would invent reserves for a token that has none.
  assert.equal(parsePumpCurve("x", { ...good, owner: RAYDIUM }), null);
  assert.equal(parsePumpCurve("x", { ...good, data: good.data.slice(0, 40) }), null);
});

test("selling into the curve uses the virtual reserves and takes the 1% fee", () => {
  const curve = parsePumpCurve("x", curveAccount(1_000_000_000_000n, 30_000_000_000n, 800_000_000_000n, 30_000_000_000n))!;
  // Constant product over the virtual reserves, then 1%.
  const tokensIn = 10_000_000_000n; // 1% of the virtual token reserve
  const k = curve.virtualSol * curve.virtualTokens;
  const gross = curve.virtualSol - k / (curve.virtualTokens + tokensIn);
  assert.equal(quoteCurveSale(curve, tokensIn), gross - gross / 100n);
  assert.equal(quoteCurveSale(curve, 0n), 0n, "selling nothing pays nothing");
});

test("the curve never promises more SOL than it actually holds", () => {
  // Virtual reserves are larger than real ones by design, so a big enough sale
  // computes more than the curve could pay. It must be capped, not printed.
  const curve = parsePumpCurve("x", curveAccount(1_000_000_000_000n, 30_000_000_000n, 800_000_000_000n, 2_000_000_000n))!;
  const out = quoteCurveSale(curve, 900_000_000_000n);
  assert.ok(out <= curve.realSol, `a quote of ${out} exceeds the ${curve.realSol} lamports the curve holds`);
});

test("a bigger sale into the curve gets a worse price per token", () => {
  const curve = parsePumpCurve("x", curveAccount(1_000_000_000_000n, 30_000_000_000n, 900_000_000_000n, 30_000_000_000n))!;
  const small = quoteCurveSale(curve, 1_000_000_000n);
  const large = quoteCurveSale(curve, 100_000_000_000n);
  const perTokenSmall = Number(small) / 1e9;
  const perTokenLarge = Number(large) / 1e11;
  assert.ok(perTokenLarge < perTokenSmall, "constant product must charge for size");
});

test("a constant-product pool prices a sale; the fee comes off the input", () => {
  const pool: SolanaPool = {
    address: "p", program: RAYDIUM, name: "Raydium AMM v4", concentrated: false,
    tokenReserve: 1_000_000_000_000n, quoteMint: WSOL, quoteSymbol: "SOL", quoteDecimals: 9, quoteReserve: 100_000_000_000n,
  };
  const out = quotePoolSale(pool, 10_000_000_000n);
  assert.ok(out > 0n && out < pool.quoteReserve);
  assert.equal(quotePoolSale({ ...pool, quoteReserve: 0n }, 10n), 0n, "an empty side pays nothing rather than dividing by it");
});

/** An RPC that presents one vault whose authority is a pool of the given program. */
function poolRpc(program: string, tokenReserve: bigint, quoteReserve: bigint, quoteMint = WSOL): SolanaRpc {
  const vault = "vault11111111111111111111111111111111111111";
  const pool = "pool111111111111111111111111111111111111111";
  const tokenAccount = (mintBytes: string): AccountInfo => {
    const data = new Uint8Array(72);
    // mint(32) owner(32) amount(8) — the owner is what makes this a pool vault
    data.set(base58Bytes(mintBytes), 0);
    data.set(base58Bytes(pool), 32);
    return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: 1, executable: false, data };
  };
  return {
    largestAccounts: async () => [{ address: vault, amount: tokenReserve }],
    multipleAccounts: async (addresses: string[]) =>
      addresses.map((a) => (a === vault ? tokenAccount(MINT) : { owner: program, lamports: 1, executable: false, data: new Uint8Array(200) })),
    tokenAccountsByOwner: async () => [
      { address: "v1", mint: MINT, amount: tokenReserve },
      { address: "v2", mint: quoteMint, amount: quoteReserve },
    ],
    accountInfo: async () => null,
  } as unknown as SolanaRpc;
}

function base58Bytes(text: string): Uint8Array {
  // The test only needs 32 distinct bytes per label, not a real decode.
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = text.charCodeAt(i % text.length);
  return out;
}

test("a pool is found through its vault's authority, with no program scan", async () => {
  const pools = await readSolanaPools(poolRpc(RAYDIUM, 1_000_000_000_000n, 50_000_000_000n), MINT);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].name, "Raydium AMM v4");
  assert.equal(pools[0].quoteSymbol, "SOL");
  assert.equal(pools[0].quoteReserve, 50_000_000_000n);
});

test("a concentrated pool is reported but deliberately left unpriced", async () => {
  const market = await readSolanaMarket(poolRpc(WHIRLPOOL, 1_000_000_000_000n, 50_000_000_000n), MINT, 1_000_000_000n, 6);
  assert.equal(market.pools.length, 1);
  assert.equal(market.pools[0].concentrated, true);
  assert.equal(market.quotes.length, 0, "vault balances are not what a trade moves through in a ranged pool");
  assert.equal(market.spot, null);
  assert.match(market.note, /concentrated/);
});

test("an ordinary wallet holding the mint is not mistaken for a pool", async () => {
  const rpc = poolRpc("11111111111111111111111111111111", 1_000_000_000_000n, 50_000_000_000n);
  assert.deepEqual(await readSolanaPools(rpc, MINT), []);
});

test("a pool against a pair BOUNCER cannot value is skipped rather than guessed at", async () => {
  const rpc = poolRpc(RAYDIUM, 1_000_000_000_000n, 50_000_000_000n, "SomeOtherMint1111111111111111111111111111111");
  assert.deepEqual(await readSolanaPools(rpc, MINT), []);
});

test("a USDC pair is priced in USDC, not silently called SOL", async () => {
  const pools = await readSolanaPools(poolRpc(RAYDIUM, 1_000_000_000_000n, 50_000_000n, USDC), MINT);
  assert.equal(pools[0].quoteSymbol, "USDC");
  assert.equal(pools[0].quoteDecimals, 6);
});

const pool = (name: string, program: string, concentrated: boolean, quoteReserve: bigint): SolanaPool => ({
  address: name, program, name, concentrated,
  tokenReserve: 1_000_000_000_000n, quoteMint: WSOL, quoteSymbol: "SOL", quoteDecimals: 9, quoteReserve,
});

test("a sale that empties the pool is flagged as that, not offered as a price", async () => {
  // Straight from the live run: 75 million USDC priced into a pool holding
  // 473 SOL returned the same number at 10%, 25%, 50% and 100%. That is the
  // pool saying it is too small for the position, and it must not read as
  // four quotes. A tiny token side makes every size drain it.
  const market = await readSolanaMarket(poolRpc(RAYDIUM, 1_000n, 1_000_000_000n), MINT, 1_000_000_000_000_000n, 6);
  assert.ok(market.quotes.length > 0);
  assert.ok(market.quotes.every((q) => q.drainsPool), `each size should empty the pool; got ${JSON.stringify(market.quotes.map((q) => [q.shareBps, String(q.out)]))}`);
  assert.match(market.note, /too small for this position/);
});

test("a much deeper ranged pool is named, so the priced one is not read as the market", () => {
  // The live shape: nine Orca pools, the largest holding 195x the SOL of the
  // Raydium pool the quote came from. "Priced on the deepest constant-product
  // pool" is true on its own and misleading on its own.
  const orca = pool("Orca Whirlpool (spacing 128)", WHIRLPOOL, true, 92_552_120_772n);
  const cpmm = pool("Raydium CPMM", RAYDIUM, false, 473_163_103n);
  const note = marketNote([orca, cpmm], cpmm, []);
  assert.match(note, /deepest venue for this token is in fact a Orca Whirlpool/);
  assert.match(note, /196x more SOL/, "92552120772 / 473163103 rounds to 196");
  assert.match(note, /a floor from one pool/);

  // When the pool being priced IS the deepest, there is nothing to warn about.
  const alone = marketNote([cpmm], cpmm, []);
  assert.doesNotMatch(alone, /deepest venue/);

  // A ranged pool only slightly deeper is not worth the sentence either.
  const slightly = pool("Orca Whirlpool", WHIRLPOOL, true, 500_000_000n);
  assert.doesNotMatch(marketNote([slightly, cpmm], cpmm, []), /deepest venue/);
});
