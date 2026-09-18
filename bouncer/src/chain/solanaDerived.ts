/**
 * Finding Solana pools without asking the endpoint to search.
 *
 * The live read profile said this plainly: getAccountInfo answers in about a
 * hundred milliseconds, and getTokenLargestAccounts — the call the pool search
 * was built on — is refused by every free endpoint and costs twenty-six
 * seconds of certain failure. So the search has to stop being a search.
 *
 * Both of the DEXes here put their pool state at a program-derived address
 * computed from the pair itself, which means the address can be worked out
 * locally and simply read. Same trick as the pump.fun bonding curve, which has
 * worked from the first try for exactly this reason.
 *
 * On the constants below. They are recalled, not verified, which is the thing
 * this codebase refuses to do for a locker table — and the reason it is fine
 * here is that being wrong has a different consequence. A wrong locker address
 * tells somebody their money is safe. A wrong program or config address
 * derives to an account that does not exist, or to one that fails the checks
 * below, and the answer is "no pool found". Every derived pool is validated
 * against the chain before it counts: the account must exist, be owned by the
 * program that was asked for, and name our mint on one side of its pair. A
 * constant that is wrong finds nothing; it cannot invent a pool.
 */
import { base58Decode, base58Encode } from "./base58.js";
import { findProgramAddress, type AccountInfo, type SolanaRpc } from "./solana.js";
// Type only, and deliberately so: solanaPools imports this module for the
// derivation, so anything imported back from it at run time would be a cycle,
// and the constants below would be read before they exist.
import type { SolanaPool } from "./solanaPools.js";

/** The two quote assets a Solana pool is valued against here. */
export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
/** Orca's mainnet Whirlpools config. Wrong means nothing is found, never a wrong pool. */
export const WHIRLPOOLS_CONFIG = "2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ";
export const CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

/** Tick spacings Orca actually deploys. Each is one derivation and one read. */
const TICK_SPACINGS = [1, 2, 4, 8, 16, 64, 96, 128, 256];
/** Raydium's CPMM fee configs are themselves derived, by a small index. */
const CPMM_CONFIG_INDEXES = [0, 1, 2, 3];

const enc = new TextEncoder();

function u16le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}
function u16be(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

/** Solana sorts a pair by the raw bytes of the two mints. */
function sortPair(a: string, b: string): [string, string, boolean] {
  const x = base58Decode(a);
  const y = base58Decode(b);
  for (let i = 0; i < 32; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? [a, b, true] : [b, a, false];
  }
  return [a, b, true];
}

/** Every address worth reading for one token, with what each would be if it exists. */
export interface DerivedCandidate {
  address: string;
  program: string;
  name: string;
  concentrated: boolean;
  /** Where the two mints and the two vaults sit in this program's pool account. */
  layout: { mintA: number; mintB: number; vaultA: number; vaultB: number };
}

const WHIRLPOOL_LAYOUT = { mintA: 101, vaultA: 133, mintB: 181, vaultB: 213 };
const CPMM_LAYOUT = { vaultA: 72, vaultB: 104, mintA: 168, mintB: 200 };

/**
 * The addresses a pool for this pair would live at, if one exists. Nothing is
 * read here; this is arithmetic.
 */
export function deriveCandidates(mint: string, quotes: string[] = [WSOL, USDC]): DerivedCandidate[] {
  const out: DerivedCandidate[] = [];
  for (const quote of quotes) {
    let sorted: [string, string, boolean];
    try {
      sorted = sortPair(mint, quote);
    } catch {
      continue; // not a decodable address; nothing to derive
    }
    const [first, second] = sorted;
    const a = base58Decode(first);
    const b = base58Decode(second);

    for (const spacing of TICK_SPACINGS) {
      const pda = findProgramAddress([enc.encode("whirlpool"), base58Decode(WHIRLPOOLS_CONFIG), a, b, u16le(spacing)], WHIRLPOOL_PROGRAM);
      if (pda) out.push({ address: pda.address, program: WHIRLPOOL_PROGRAM, name: `Orca Whirlpool (spacing ${spacing})`, concentrated: true, layout: WHIRLPOOL_LAYOUT });
    }
    for (const index of CPMM_CONFIG_INDEXES) {
      const config = findProgramAddress([enc.encode("amm_config"), u16be(index)], CPMM_PROGRAM);
      if (!config) continue;
      const pda = findProgramAddress([enc.encode("pool"), base58Decode(config.address), a, b], CPMM_PROGRAM);
      if (pda) out.push({ address: pda.address, program: CPMM_PROGRAM, name: "Raydium CPMM", concentrated: false, layout: CPMM_LAYOUT });
    }
  }
  return out;
}

const QUOTES: Record<string, { symbol: string; decimals: number }> = {
  [WSOL]: { symbol: "SOL", decimals: 9 },
  [USDC]: { symbol: "USDC", decimals: 6 },
};

function pubkeyAt(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null;
  return base58Encode(data.slice(offset, offset + 32));
}

function u64At(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  return value;
}

/**
 * Read the derived addresses and keep the ones that are really pools for this
 * mint. Two getMultipleAccounts calls total, whatever the number of
 * candidates — the method that answers in a hundred milliseconds.
 */
export async function readDerivedPools(rpc: SolanaRpc, mint: string): Promise<SolanaPool[]> {
  const candidates = deriveCandidates(mint);
  if (!candidates.length) return [];
  const accounts = await rpc.multipleAccounts(candidates.map((c) => c.address));

  // Validate before believing. An account that does not exist, is owned by
  // something else, or does not name this mint is not this token's pool — and
  // that is exactly what a wrong constant above would produce.
  const live: { candidate: DerivedCandidate; account: AccountInfo; quoteMint: string; tokenIsA: boolean }[] = [];
  const vaultAddresses: string[] = [];
  candidates.forEach((candidate, i) => {
    const account = accounts[i];
    if (!account || account.owner !== candidate.program) return;
    const mintA = pubkeyAt(account.data, candidate.layout.mintA);
    const mintB = pubkeyAt(account.data, candidate.layout.mintB);
    if (mintA === null || mintB === null) return;
    const tokenIsA = mintA === mint;
    if (!tokenIsA && mintB !== mint) return; // the layout or the address was wrong; drop it
    const quoteMint = tokenIsA ? mintB : mintA;
    if (!QUOTES[quoteMint]) return;
    const vaultToken = pubkeyAt(account.data, tokenIsA ? candidate.layout.vaultA : candidate.layout.vaultB);
    const vaultQuote = pubkeyAt(account.data, tokenIsA ? candidate.layout.vaultB : candidate.layout.vaultA);
    if (!vaultToken || !vaultQuote) return;
    live.push({ candidate, account, quoteMint, tokenIsA });
    vaultAddresses.push(vaultToken, vaultQuote);
  });
  if (!live.length) return [];

  const vaults = await rpc.multipleAccounts(vaultAddresses);
  const pools: SolanaPool[] = [];
  live.forEach((entry, i) => {
    const tokenVault = vaults[i * 2];
    const quoteVault = vaults[i * 2 + 1];
    if (!tokenVault || !quoteVault) return;
    const quote = QUOTES[entry.quoteMint];
    pools.push({
      address: entry.candidate.address,
      program: entry.candidate.program,
      name: entry.candidate.name,
      concentrated: entry.candidate.concentrated,
      tokenReserve: u64At(tokenVault.data, 64),
      quoteMint: entry.quoteMint,
      quoteSymbol: quote.symbol,
      quoteDecimals: quote.decimals,
      quoteReserve: u64At(quoteVault.data, 64),
    });
  });
  return pools.sort((a, b) => (b.quoteReserve > a.quoteReserve ? 1 : b.quoteReserve < a.quoteReserve ? -1 : 0));
}
