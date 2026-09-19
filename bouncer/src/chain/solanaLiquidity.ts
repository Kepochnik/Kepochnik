/**
 * Can they pull the liquidity out from under you — on Solana.
 *
 * The EVM answer traces LP tokens and NFT positions. Solana splits into two
 * cases that are not alike, and pretending they are would be the lie:
 *
 * - **Raydium CPMM** issues a real LP token. Burning it is not reversible, and
 *   the burn is measurable exactly: the pool account carries its own record of
 *   how much LP it ever issued, and the LP mint carries how much still exists.
 *   The gap between the two is LP that was destroyed. No table of addresses,
 *   no guessing — two numbers off the chain and a subtraction.
 * - **Orca Whirlpool** has no LP token at all. Liquidity is held as NFT
 *   positions, and finding their holders needs the very account search the
 *   free endpoints refuse. So this file does not read it, and says so, rather
 *   than reporting a zero that would read as "nothing is locked".
 *
 * The second case is the reason `read` exists on the result. A share is only
 * a share of something that was actually counted.
 */
import { base58Decode, base58Encode } from "./base58.js";
import { findProgramAddress, parseMint, TOKEN_PROGRAM, type AccountInfo, type SolanaRpc } from "./solana.js";
import { CPMM_PROGRAM } from "./solanaDerived.js";
import type { SolanaPool } from "./solanaPools.js";

/**
 * Where Raydium's CPMM pool account keeps what this read needs. These offsets
 * are recalled, and a wrong one here would not fail loudly — it would produce
 * a number, and the number would most likely say "burned". So the layout is
 * checked against itself before anything is believed: the pubkey at
 * `CPMM_LP_MINT` has to be a real SPL mint, and the decimals byte the pool
 * keeps next to the supply has to agree with that mint's own. Two independent
 * fields lining up by accident is not something a shifted layout does.
 */
const CPMM_LP_MINT = 136;
const CPMM_LP_DECIMALS = 330;
const CPMM_LP_SUPPLY = 333;

const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * Addresses that can hold a token and can never spend it. The incinerator is
 * a system address with no private key; the all-zero address is the same idea
 * written differently. Unlike a locker, neither is a judgement call.
 */
const BURN_OWNERS: Record<string, string> = {
  "1nc1nerator11111111111111111111111111111111": "the incinerator",
  "11111111111111111111111111111111": "the system address",
};

export interface SolanaPoolLock {
  pool: string;
  name: string;
  /**
   * True when the shares below were counted. False means this pool's
   * liquidity ownership was not read at all — they are zeroes, not findings.
   */
  read: boolean;
  /** LP destroyed outright, in basis points of everything the pool issued. */
  burnedBps: number;
  /** LP parked at an address with no key, in the same basis points. */
  strandedBps: number;
  /** Everything else: LP somebody still holds and can withdraw against. */
  freeBps: number;
  lpMint: string | null;
  /**
   * How much of the token's readable liquidity is in THIS pool, in basis
   * points of the quote assets held across every pool found.
   *
   * It matters more here than it looks. The deepest venue for a Solana token
   * is usually an Orca Whirlpool, whose ownership cannot be read at all, so
   * the pool this lock covers is often the deepest *Raydium* pool — which can
   * be a five-thousandth of the market. "Every LP token is still held by
   * somebody" is a fair warning about the pool people trade in and an alarm
   * about nothing when the pool holds 0.02% of the liquidity.
   */
  shareOfLiquidityBps: number;
  /** Why this is missing or partial. Empty when the read is complete. */
  unread: string;
}

function u64At(data: Uint8Array, offset: number): bigint {
  if (data.length < offset + 8) return 0n;
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  return value;
}

function pubkeyAt(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null;
  return base58Encode(data.slice(offset, offset + 32));
}

/** The associated token account an owner would hold this mint in. Derived, not searched. */
export function associatedTokenAddress(owner: string, mint: string): string | null {
  try {
    const pda = findProgramAddress([base58Decode(owner), base58Decode(TOKEN_PROGRAM), base58Decode(mint)], ASSOCIATED_TOKEN_PROGRAM);
    return pda?.address ?? null;
  } catch {
    return null;
  }
}

const bps = (part: bigint, whole: bigint): number => (whole === 0n ? 0 : Number((part * 10_000n) / whole));

/**
 * Who can take this pool's liquidity away. One `getMultipleAccounts` call:
 * the LP mint plus the burn addresses' token accounts.
 */
export async function readSolanaLock(rpc: SolanaRpc, pool: SolanaPool, poolAccount?: AccountInfo | null): Promise<SolanaPoolLock> {
  const base: SolanaPoolLock = { pool: pool.address, name: pool.name, read: false, burnedBps: 0, strandedBps: 0, freeBps: 0, lpMint: null, shareOfLiquidityBps: 10_000, unread: "" };

  if (pool.program !== CPMM_PROGRAM) {
    return {
      ...base,
      unread: pool.concentrated
        ? `${pool.name} holds liquidity as NFT positions rather than LP tokens, and finding who owns them needs an account search no free endpoint answers, so whether it can be withdrawn was not read`
        : `${pool.name} is not a pool type BOUNCER can read liquidity ownership from`,
    };
  }

  const account = poolAccount ?? (await rpc.accountInfo(pool.address));
  if (!account) return { ...base, unread: "the pool account did not answer, so who holds its liquidity was not read" };

  const lpMint = pubkeyAt(account.data, CPMM_LP_MINT);
  const issued = u64At(account.data, CPMM_LP_SUPPLY);
  if (!lpMint) return { ...base, unread: "the pool account was shorter than its layout, so the LP token was not found" };
  if (issued === 0n) return { ...base, lpMint, unread: "the pool records no LP tokens issued, so there is no share to work out" };

  const burnAccounts = Object.keys(BURN_OWNERS).map((owner) => ({ owner, address: associatedTokenAddress(owner, lpMint) }));
  const wanted = [lpMint, ...burnAccounts.map((b) => b.address).filter((a): a is string => a !== null)];
  let accounts: (AccountInfo | null)[];
  try {
    accounts = await rpc.multipleAccounts(wanted);
  } catch {
    return { ...base, lpMint, unread: "the LP token did not answer, so who holds this pool's liquidity was not read" };
  }

  const mintAccount = accounts[0];
  const mint = mintAccount ? parseMint(mintAccount) : null;
  if (!mint) return { ...base, lpMint, unread: "the LP token account could not be read, so how much of it still exists is unknown" };

  // Everything the pool ever handed out, minus everything that still exists,
  // is LP somebody destroyed. Deposits and withdrawals move both numbers
  // together, so only a burn opens a gap.
  const alive = mint.supply;

  // Two checks that cost nothing and turn a wrong offset into "not read".
  if (account.data[CPMM_LP_DECIMALS] !== mint.decimals) {
    return { ...base, lpMint, unread: "the pool's own record of its LP token disagrees with the LP token itself, so BOUNCER is not reading this pool's layout correctly and will not guess at it" };
  }
  if (alive > issued) {
    // Only the pool can mint LP, and it raises its own record when it does.
    // More LP existing than the pool ever issued means the number read is not
    // the one intended.
    return { ...base, lpMint, unread: "more of this pool's LP token exists than the pool records issuing, which means one of the two numbers is not what BOUNCER thinks it is" };
  }

  const burned = issued - alive;

  let stranded = 0n;
  const strandedAt: string[] = [];
  burnAccounts.forEach((entry, i) => {
    if (!entry.address) return;
    const held = accounts[i + 1];
    if (!held) return;
    // An SPL token account holds its balance at offset 64; the mint it belongs
    // to sits at offset 0, and checking it stops a derived address that turned
    // out to be something else from counting.
    if (pubkeyAt(held.data, 0) !== lpMint) return;
    const amount = u64At(held.data, 64);
    if (amount === 0n) return;
    stranded += amount;
    strandedAt.push(BURN_OWNERS[entry.owner]);
  });

  const burnedBps = bps(burned, issued);
  const strandedBps = bps(stranded, issued);
  return {
    ...base,
    read: true,
    lpMint,
    burnedBps,
    strandedBps,
    freeBps: Math.max(0, 10_000 - burnedBps - strandedBps),
    // Naming the wallets that hold the rest would need the account search the
    // endpoints refuse. Not naming them does not make them harmless.
    unread: strandedAt.length ? `${strandedAt.join(" and ")} hold${strandedAt.length === 1 ? "s" : ""} LP tokens that can never move` : "",
  };
}

/** One line a reader can act on. */
export function solanaLockInWords(lock: SolanaPoolLock): string {
  if (!lock.read) return lock.unread || "the liquidity could not be read";
  const pct = (b: number) => `${(b / 100).toFixed(b % 100 === 0 ? 0 : 1)}%`;
  const parts: string[] = [];
  if (lock.burnedBps > 0) parts.push(`${pct(lock.burnedBps)} burned`);
  if (lock.strandedBps > 0) parts.push(`${pct(lock.strandedBps)} at an address with no key`);
  if (lock.freeBps > 0) parts.push(`${pct(lock.freeBps)} withdrawable`);
  return `${lock.name}: ${parts.join(", ")}`;
}
