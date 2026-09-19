/**
 * Real Solana mints, enumerated from the chain rather than from a list.
 *
 * On an EVM chain the Transfer log answers "what is trading right now"
 * directly. Solana has no such log, `getProgramAccounts` is disabled on every
 * public endpoint, and nothing else reverses a mint out of a pool: every
 * address BOUNCER derives goes mint -> pool, never back.
 *
 * There is one allow-listed read that does go backwards. An SPL token account
 * carries its mint in its first 32 bytes, and `getTokenAccountsByOwner`
 * returns every token account one owner holds. Raydium's CPMM keeps all of
 * its pool vaults under a single program-derived authority — so asking that
 * authority for its token accounts returns one entry per side of every CPMM
 * pool on Solana, each naming a mint that is pooled and tradeable today.
 *
 * Two things make this safe to be wrong about. The seed below is recalled,
 * and a wrong seed derives an address that owns nothing, so the failure is
 * "found none" rather than a wrong answer. And the mints this prints are only
 * candidates: everything BOUNCER then says about them is read from the chain.
 *
 * The response is asked for 32 bytes per account rather than the whole 165,
 * because a firehose is exactly how the EVM version of this script went wrong
 * an hour ago.
 *
 *   node scripts/solana-movers.mjs 4
 */
import { SolanaRpc, TOKEN_PROGRAM } from "../dist/src/chain/solana.js";
import { CHAINS } from "../dist/src/chain/chains.js";
import { findProgramAddress } from "../dist/src/chain/solana.js";
import { base58Encode } from "../dist/src/chain/base58.js";
import { CPMM_PROGRAM, USDC, WSOL } from "../dist/src/chain/solanaDerived.js";

const want = Number(process.argv[2] ?? 4);
const rpc = new SolanaRpc({ urls: CHAINS.solana.rpc });

const authority = findProgramAddress([new TextEncoder().encode("vault_and_lp_mint_auth_seed")], CPMM_PROGRAM);
if (!authority) {
  console.error("solana-movers: the CPMM vault authority did not derive");
  process.exit(3);
}

let accounts;
try {
  // Thirty-two bytes per account: the mint and nothing else.
  const result = await rpc.send("getTokenAccountsByOwner", [
    authority.address,
    { programId: TOKEN_PROGRAM },
    { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 32 } },
  ]);
  accounts = result?.value ?? [];
} catch (error) {
  console.error(`solana-movers: ${error instanceof Error ? error.message : error}`);
  process.exit(3);
}

if (!accounts.length) {
  console.error("solana-movers: the CPMM vault authority owns no token accounts — the seed is wrong, or the endpoint refused");
  process.exit(2);
}

// SOL and USDC are one side of nearly every pool and are not tokens anybody
// needs checked. What is left is the other side: the actual subjects.
const skip = new Set([WSOL, USDC]);
const seen = new Set();
const mints = [];
for (const entry of accounts) {
  const raw = entry?.account?.data?.[0];
  if (!raw) continue;
  const mint = base58Encode(Buffer.from(raw, "base64").subarray(0, 32));
  if (skip.has(mint) || seen.has(mint)) continue;
  seen.add(mint);
  mints.push(mint);
}
if (!mints.length) {
  console.error(`solana-movers: ${accounts.length} vaults, all of them SOL or USDC`);
  process.exit(2);
}
// Spread the picks across the list rather than taking the first few, which
// would always be the same oldest pools.
const stride = Math.max(1, Math.floor(mints.length / want));
for (let i = 0, taken = 0; i < mints.length && taken < want; i += stride, taken++) console.log(mints[i]);
