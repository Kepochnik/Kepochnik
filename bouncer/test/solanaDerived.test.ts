/**
 * Pools found by arithmetic rather than by asking the endpoint to search.
 *
 * The constants in solanaDerived are recalled rather than verified, which is
 * only acceptable because a wrong one cannot invent a pool — it derives to an
 * address that holds nothing, or to an account that fails the checks. These
 * tests are mostly about that guarantee, because it is the whole argument for
 * the module existing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { base58Decode, base58Encode } from "../src/chain/base58.js";
import type { AccountInfo, SolanaRpc } from "../src/chain/solana.js";
import { CPMM_PROGRAM, WHIRLPOOL_PROGRAM, WSOL, deriveCandidates, readDerivedPools } from "../src/chain/solanaDerived.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";

test("candidates are derived locally, off the curve, and cover both venues", () => {
  const candidates = deriveCandidates(MINT);
  assert.ok(candidates.length > 0);
  assert.ok(candidates.some((c) => c.program === WHIRLPOOL_PROGRAM), "Orca must be among them");
  assert.ok(candidates.some((c) => c.program === CPMM_PROGRAM), "Raydium CPMM must be among them");
  // Every address is a real base58 pubkey, and deriving twice agrees.
  for (const c of candidates) assert.equal(base58Decode(c.address).length, 32);
  assert.deepEqual(deriveCandidates(MINT).map((c) => c.address), candidates.map((c) => c.address));
  // Distinct per venue and per tick spacing; a collision would mean the seeds
  // are not doing their job.
  assert.equal(new Set(candidates.map((c) => c.address)).size, candidates.length);
});

test("a mint that is not an address derives nothing rather than throwing", () => {
  assert.deepEqual(deriveCandidates("not an address"), []);
});

/** A pool account laid out the way the reader expects. */
function poolAccount(program: string, layout: { mintA: number; mintB: number; vaultA: number; vaultB: number }, mintA: string, mintB: string, vaultA: string, vaultB: string): AccountInfo {
  const data = new Uint8Array(400);
  data.set(base58Decode(mintA), layout.mintA);
  data.set(base58Decode(mintB), layout.mintB);
  data.set(base58Decode(vaultA), layout.vaultA);
  data.set(base58Decode(vaultB), layout.vaultB);
  return { owner: program, lamports: 1, executable: false, data };
}

function vaultAccount(amount: bigint): AccountInfo {
  const data = new Uint8Array(72);
  let v = amount;
  for (let i = 0; i < 8; i++) {
    data[64 + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: 1, executable: false, data };
}

const VAULT_A = base58Encode(new Uint8Array(32).fill(3));
const VAULT_B = base58Encode(new Uint8Array(32).fill(4));

test("a derived pool that checks out is read, with both sides", async () => {
  const candidates = deriveCandidates(MINT);
  const cpmm = candidates.find((c) => c.program === CPMM_PROGRAM)!;
  const rpc = {
    multipleAccounts: async (addresses: string[]) => {
      if (addresses[0] === cpmm.address || addresses.includes(cpmm.address)) {
        // first call: the candidate pool accounts
        if (addresses.length === candidates.length) {
          return addresses.map((a) => (a === cpmm.address ? poolAccount(CPMM_PROGRAM, cpmm.layout, MINT, WSOL, VAULT_A, VAULT_B) : null));
        }
      }
      // second call: the vaults, in [token, quote] order
      return addresses.map((a) => vaultAccount(a === VAULT_A ? 1_000_000_000_000n : 50_000_000_000n));
    },
  } as unknown as SolanaRpc;

  const pools = await readDerivedPools(rpc, MINT);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].name, "Raydium CPMM");
  assert.equal(pools[0].concentrated, false);
  assert.equal(pools[0].tokenReserve, 1_000_000_000_000n);
  assert.equal(pools[0].quoteReserve, 50_000_000_000n);
  assert.equal(pools[0].quoteSymbol, "SOL");
});

test("an account at a derived address that is not ours is rejected, not believed", async () => {
  const candidates = deriveCandidates(MINT);
  const cpmm = candidates.find((c) => c.program === CPMM_PROGRAM)!;
  const other = base58Encode(new Uint8Array(32).fill(9));

  // Three ways a wrong constant shows up, and none may produce a pool:
  // the address holds nothing; it holds somebody else's program; it holds a
  // real pool for a different pair.
  const cases: (AccountInfo | null)[] = [
    null,
    { owner: "SomeOtherProgram1111111111111111111111111111", lamports: 1, executable: false, data: new Uint8Array(400) },
    poolAccount(CPMM_PROGRAM, cpmm.layout, other, WSOL, VAULT_A, VAULT_B),
  ];
  for (const account of cases) {
    const rpc = { multipleAccounts: async (addresses: string[]) => addresses.map((a) => (a === cpmm.address ? account : null)) } as unknown as SolanaRpc;
    assert.deepEqual(await readDerivedPools(rpc, MINT), [], "a derived address that does not check out must yield no pool");
  }
});

test("a pool against a pair BOUNCER cannot value is dropped", async () => {
  const candidates = deriveCandidates(MINT);
  const cpmm = candidates.find((c) => c.program === CPMM_PROGRAM)!;
  const exotic = base58Encode(new Uint8Array(32).fill(11));
  const rpc = {
    multipleAccounts: async (addresses: string[]) =>
      addresses.map((a) => (a === cpmm.address ? poolAccount(CPMM_PROGRAM, cpmm.layout, MINT, exotic, VAULT_A, VAULT_B) : null)),
  } as unknown as SolanaRpc;
  assert.deepEqual(await readDerivedPools(rpc, MINT), []);
});

test("the whole search is two reads, whatever the number of candidates", async () => {
  let calls = 0;
  const candidates = deriveCandidates(MINT);
  const orca = candidates.find((c) => c.program === WHIRLPOOL_PROGRAM)!;
  const rpc = {
    multipleAccounts: async (addresses: string[]) => {
      calls++;
      if (calls === 1) return addresses.map((a) => (a === orca.address ? poolAccount(WHIRLPOOL_PROGRAM, orca.layout, MINT, WSOL, VAULT_A, VAULT_B) : null));
      return addresses.map((a) => vaultAccount(a === VAULT_A ? 5n : 7n));
    },
  } as unknown as SolanaRpc;
  const pools = await readDerivedPools(rpc, MINT);
  assert.equal(pools.length, 1);
  assert.equal(calls, 2, `getTokenLargestAccounts is what this exists to avoid; ${calls} reads means it crept back`);
});
