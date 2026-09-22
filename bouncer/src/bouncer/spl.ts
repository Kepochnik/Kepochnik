/**
 * THE DOOR on Solana. Same promise as everywhere else: every line is a fact
 * read at one slot, nothing is scored and nothing is advised.
 *
 * What differs is that the two questions that matter most are answered by
 * fields rather than by reading bytecode. A mint account says who may print
 * more of the token, and who may freeze a holder's account. Freezing is how a
 * holder is stopped from selling on Solana, so a live freeze authority is the
 * single most important thing on the slip, and it is not a heuristic.
 *
 * Token-2022 adds the rest: a transfer fee is a real sell tax with a named
 * authority who can raise it, a transfer hook runs somebody's program on every
 * transfer, and a permanent delegate can move a holder's tokens without asking.
 */
import { base58Encode, isSolanaAddress } from "../chain/base58.js";
import type { ChainConfig } from "../chain/chains.js";
import { readSolanaMarket, type HolderScan, type SolanaMarket } from "../chain/solanaPools.js";
import {
  METADATA_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  metadataAddress,
  parseMetadata,
  parseMint,
  tokenAccountOwner,
  type AccountInfo,
  type Metaplex,
  type SolanaRpc,
  type SplMint,
  type TokenExtension,
} from "../chain/solana.js";
import type { Receipt } from "../receipt.js";
import type { DoorNote } from "./door.js";

export interface SplHolder {
  /** The token account. */
  account: string;
  /** Its owner, when the owner could be read; twenty accounts can be three people. */
  owner: string | null;
  amount: bigint;
  bps: number | null;
}

export interface SplSlip {
  chain: { key: string; name: string; family: "solana" };
  /**
   * `slot` is when the reading started. `span` is what it actually covered.
   *
   * They are not the same and the page used to print only the first, under
   * a promise that everything was read at one block. On Solana nothing
   * pins a slot: each request is served at whatever slot its node had
   * reached, so a slip is a range, and `span` is that range measured
   * rather than assumed. Null when no response reported a context slot.
   */
  at: { slot: number; timestamp: number | null; span?: { first: number; last: number; spread: number } | null };
  subject: string;
  /** ON THE LIST is not a stamp Solana can earn here: there is no launchpad registry to be on. */
  stamp: "NOT A LAUNCH" | "NOT ON THE LIST";
  /** Null when the address is not an SPL mint: a wallet, a program, a token account. */
  mint: SplMint | null;
  /** What the address turned out to be, when it is not a mint. */
  whatItIs: string | null;
  metadata: Metaplex | null;
  /** True when the name and symbol come from a Token-2022 extension rather than Metaplex. */
  metadataInline: boolean;
  holders: { top: SplHolder[]; top10Bps: number | null; distinctOwners: number | null } | null;
  /** Where it trades and what a sale would pay: the bonding curve, or the pools. */
  market: SolanaMarket | null;
  notes: DoorNote[];
  skipped: { section: string; reason: string }[];
}

export interface SplOptions {
  /** How many of the largest accounts to resolve to owners; 20 is what the node returns. */
  topHolders?: number;
  /** How long one optional section may take before it is reported unread. */
  deadlineMs?: number;
  /** Skip the market read (a handful of extra calls). */
  skipMarket?: boolean;
  /**
   * Skip the holder list. getTokenLargestAccounts is the slowest read on
   * this chain and the one free endpoints refuse most often, and none of
   * what a reader wants first — can they print more, can they freeze you,
   * what does a transfer cost — depends on it.
   */
  skipHolders?: boolean;
  /** The market read is several round trips; it gets its own, longer deadline. */
  marketDeadlineMs?: number;
}

export async function readSplDoor(rpc: SolanaRpc, input: string, chain: ChainConfig, options: SplOptions = {}): Promise<SplSlip> {
  if (!isSolanaAddress(input)) throw new Error(`${input} is not a Solana address`);
  // Three round trips in a row, and only one pair of them was related: the
  // slot, then that slot's time, then the account at the pasted address —
  // which has nothing to do with either. And the Metaplex metadata account,
  // read further down as a fourth, is just another account: getMultipleAccounts
  // fetches it beside the mint for the same one request.
  const metadataPda = metadataAddress(input);
  const [{ slot, timestamp }, accounts] = await Promise.all([
    (async () => {
      const at = await rpc.slot();
      return { slot: at, timestamp: await rpc.blockTime(at) };
    })(),
    rpc.multipleAccounts(metadataPda ? [input, metadataPda] : [input]).catch(async () => [await rpc.accountInfo(input), null]),
  ]);
  const slip: SplSlip = {
    chain: { key: chain.key, name: chain.name, family: "solana" },
    at: { slot, timestamp },
    subject: input,
    stamp: "NOT A LAUNCH",
    mint: null,
    whatItIs: null,
    metadata: null,
    metadataInline: false,
    holders: null,
    market: null,
    notes: [],
    skipped: [],
  };

  const account = accounts[0] ?? null;
  if (!account) {
    slip.stamp = "NOT ON THE LIST";
    slip.notes = [{ level: "stop", code: "no-account", text: `There is no account at this address on ${chain.name}.` }];
    return slip;
  }
  slip.mint = parseMint(account);
  if (!slip.mint) {
    slip.stamp = "NOT ON THE LIST";
    slip.whatItIs = describeAccount(account.owner, account.executable, account.data.length);
    slip.notes = [{ level: "stop", code: "not-a-mint", text: `This address is not a token: it is ${slip.whatItIs}. Paste the mint address, which is what a token is on Solana.` }];
    return slip;
  }

  const attempt = async (section: string, run: () => Promise<void>, deadlineMs?: number) => {
    try {
      await (deadlineMs ? withDeadline(run(), deadlineMs, section) : run());
    } catch (error) {
      slip.skipped.push({ section, reason: reasonFor(error) });
    }
  };

  // The name and the holder list do not depend on each other, and the holder
  // list is the slow one: a public endpoint can take ten seconds over the
  // largest accounts of a big mint. Run them together, and cap each, so one
  // slow read cannot decide how long the whole slip takes.
  // ---- the name, from the extension when there is one and Metaplex otherwise
  const inline = slip.mint.extensions.find((e) => e.kind === "token-metadata");
  if (inline && inline.kind === "token-metadata") {
    slip.metadataInline = true;
    slip.metadata = { updateAuthority: inline.updateAuthority ?? "", mint: input, name: inline.name, symbol: inline.symbol, uri: inline.uri, sellerFeeBasisPoints: 0, primarySaleHappened: false, isMutable: inline.updateAuthority !== null };
  }

  // Already in hand: it came back beside the mint. It only costs a read of
  // its own when the address could not be derived, which is the odd case.
  const readName = slip.metadata
    ? Promise.resolve()
    : attempt(
        "metadata",
        async () => {
          const metaAccount = metadataPda ? (accounts[1] ?? null) : null;
          if (metaAccount && metaAccount.owner === METADATA_PROGRAM) slip.metadata = parseMetadata(metaAccount);
        },
        options.deadlineMs ?? 8_000,
      );

  // The largest accounts and their contents answer two questions at once: who
  // holds this, and which of those holders is a pool. Read once, shared. They
  // used to be read twice, and since this client paces every request through
  // one queue, the duplicate was time taken from whichever section was still
  // waiting — which is how both of them ended up losing their deadlines.
  let scan: HolderScan | null = null;
  const readScan = options.skipHolders ? Promise.resolve() : attempt(
    "holders",
    async () => {
      const largest = (await rpc.largestAccounts(input)).slice(0, options.topHolders ?? 20);
      if (!largest.length) {
        scan = { largest: [], accounts: [] };
        return;
      }
      // Resolving accounts to the wallets behind them is a second read, and it
      // is the one most likely to be refused. Losing it must cost the owner
      // column, not the whole holder list.
      let owners: (AccountInfo | null)[] = [];
      try {
        owners = await rpc.multipleAccounts(largest.map((a) => a.address));
      } catch (error) {
        slip.skipped.push({ section: "holder owners", reason: error instanceof Error ? error.message : String(error) });
      }
      scan = { largest, accounts: owners };
    },
    options.deadlineMs ?? 15_000,
  );
  await readScan;

  const readHolders = (async () => {
    const found = scan as HolderScan | null;
    if (!found) return;
    const largest = found.largest;
    if (!largest.length) {
      slip.holders = { top: [], top10Bps: null, distinctOwners: null };
      return;
    }
    const owners = found.accounts;
    const supply = slip.mint!.supply;
    const top: SplHolder[] = largest.map((a, i) => ({
      account: a.address,
      owner: owners[i] ? tokenAccountOwner(owners[i]!) : null,
      amount: a.amount,
      bps: supply > 0n ? Number((a.amount * 10_000n) / supply) : null,
    }));
    const byOwner = new Map<string, number>();
    for (const h of top) {
      const key = h.owner ?? h.account;
      byOwner.set(key, (byOwner.get(key) ?? 0) + (h.bps ?? 0));
    }
    const ranked = [...byOwner.values()].sort((a, b) => b - a);
    slip.holders = {
      top,
      top10Bps: supply > 0n ? ranked.slice(0, 10).reduce((a, b) => a + b, 0) : null,
      distinctOwners: byOwner.size,
    };
  })();

  // Where it trades. This no longer depends on the scan above: the pools whose
  // address can be derived are read directly, and the scan only adds the ones
  // that cannot. So a refused getTokenLargestAccounts costs the holder list
  // and some venues, not the prices.
  const readMarket = options.skipMarket
    ? Promise.resolve()
    : attempt(
        "market",
        async () => {
          const supply = slip.mint!.supply;
          const position = supply > 0n ? supply / 100n : 0n;
          slip.market = await readSolanaMarket(rpc, input, position, slip.mint!.decimals, scan ?? undefined);
        },
        // Several round trips rather than one, and a public endpoint paces
        // them. The eight seconds the other sections get was killing this one
        // outright, which reads on the slip as "no venue" — the wrong answer.
        options.marketDeadlineMs ?? 25_000,
      );

  await Promise.all([readName, readHolders, readMarket]);
  // Measured after every read has landed, because that is the only point
  // at which the range is the whole range.
  slip.at.span = rpc.slotSpan();
  slip.notes = splNotes(slip);
  return slip;
}

/**
 * Why a section is missing, in words a reader can act on. "Rate limited" and
 * "did not answer" look the same in a stack trace and mean different things to
 * somebody deciding whether to try again.
 */
function reasonFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b|rate limit|too many requests/i.test(message)) {
    return `the public endpoint rate-limited this read (${message}). Point BOUNCER at your own endpoint with RPC_URL_SOLANA to get it.`;
  }
  if (/blocked|forbidden|\b403\b/i.test(message)) return `the public endpoint refused this read (${message})`;
  return message;
}

/** Caps one read so a slow endpoint costs that section, not the whole slip. */
async function withDeadline<T>(work: Promise<T>, ms: number, section: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the endpoint did not answer within ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describeAccount(owner: string, executable: boolean, size: number): string {
  if (executable) return "an executable program";
  if (owner === "11111111111111111111111111111111") return "a wallet";
  if ((owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) && size >= 165) return "a token account, which is one wallet's holding of some token rather than the token itself";
  return `an account owned by the program ${short(owner)}`;
}

function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

function pct(bps: number | null): string {
  return bps === null ? "an unknown share" : `${(bps / 100).toFixed(1)}%`;
}

export function splNotes(slip: SplSlip): DoorNote[] {
  const notes: DoorNote[] = [];
  const m = slip.mint;
  if (!m) return notes;
  const ext = (kind: TokenExtension["kind"]) => m.extensions.find((e) => e.kind === kind);

  notes.push({
    level: "info",
    code: "spl",
    text: `An SPL token on ${slip.chain.name}${m.token2022 ? ", using the Token-2022 program, which is where transfer fees, hooks and delegates live" : ""}. There is no launchpad registry to be on here, so this is the ordinary-token check: who can still change the rules, and who holds it.`,
  });

  // ---- the two fields that decide whether you can keep and sell it
  if (m.freezeAuthority) {
    notes.push({
      level: "stop",
      code: "freeze-authority",
      text: `${short(m.freezeAuthority)} can freeze any holder's account for this token. A frozen account cannot send, so it cannot sell. This is the plainest way a Solana token traps its holders, and it is a field on the mint, not a guess.`,
    });
  } else {
    notes.push({ level: "info", code: "no-freeze", text: "Nobody can freeze a holder's account: the freeze authority is not set, and it cannot be added back." });
  }
  if (m.mintAuthority) {
    notes.push({
      level: "watch",
      code: "mint-authority",
      text: `${short(m.mintAuthority)} can print more of this token at will, diluting every holder. The supply shown is what exists now, not a cap.`,
    });
  } else {
    notes.push({ level: "info", code: "no-mint", text: "The supply is fixed: the mint authority is not set, so no more can ever be printed." });
  }

  const defaultState = ext("default-account-state");
  if (defaultState?.kind === "default-account-state" && defaultState.frozen) {
    notes.push({ level: "stop", code: "frozen-by-default", text: "Every new holder's account starts frozen, so a buyer cannot sell until somebody unfreezes them one by one." });
  }
  if (ext("non-transferable")) {
    notes.push({ level: "stop", code: "non-transferable", text: "This token is marked non-transferable: it cannot be sent to anyone, so it cannot be sold at all." });
  }
  const delegate = ext("permanent-delegate");
  if (delegate?.kind === "permanent-delegate") {
    notes.push({ level: "stop", code: "permanent-delegate", text: `${short(delegate.delegate)} is a permanent delegate: it can move or burn this token out of any holder's account without their signature.` });
  }
  const hook = ext("transfer-hook");
  if (hook?.kind === "transfer-hook" && hook.programId) {
    notes.push({
      level: "watch",
      code: "transfer-hook",
      text: `Every transfer runs the program ${short(hook.programId)} first, and whatever that program does is not read here. It can make a transfer fail on its own terms.${hook.authority ? ` ${short(hook.authority)} can point the hook at a different program.` : ""}`,
    });
  }
  const fee = ext("transfer-fee");
  if (fee?.kind === "transfer-fee") {
    const current = (fee.feeBps / 100).toFixed(2);
    const next = (fee.nextFeeBps / 100).toFixed(2);
    notes.push({
      level: fee.feeBps >= 500 || fee.nextFeeBps > fee.feeBps ? "watch" : "info",
      code: "transfer-fee",
      text:
        `Every transfer of this token pays ${current}% to the token itself${fee.nextFeeBps !== fee.feeBps ? `, changing to ${next}% at epoch ${fee.nextFeeEpoch}` : ""}. ` +
        (fee.feeAuthority ? `${short(fee.feeAuthority)} can change that fee.` : "The fee can no longer be changed: its authority is not set.") +
        (fee.withdrawAuthority ? ` ${short(fee.withdrawAuthority)} collects what has been withheld.` : ""),
    });
  }
  const pausable = ext("pausable");
  if (pausable?.kind === "pausable") {
    notes.push({ level: "watch", code: "pausable", text: `${pausable.authority ? short(pausable.authority) : "Somebody"} can pause every transfer of this token.` });
  }
  const close = ext("mint-close-authority");
  if (close?.kind === "mint-close-authority") {
    notes.push({ level: "watch", code: "mint-close", text: `${short(close.authority)} can close the mint account once the supply reaches zero.` });
  }
  const interest = ext("interest-bearing");
  if (interest?.kind === "interest-bearing") {
    notes.push({ level: "info", code: "interest-bearing", text: `The balance a wallet displays grows at ${(interest.rateBps / 100).toFixed(2)}% a year by rule, without any tokens being minted. What you hold is the raw amount, not the displayed one.` });
  }
  for (const e of m.extensions) {
    if (e.kind === "other") notes.push({ level: "info", code: "extension-unknown", text: `The mint carries a Token-2022 extension BOUNCER does not read (type ${e.type}); what it does is not covered here.` });
  }

  // ---- the name
  if (slip.metadata) {
    if (slip.metadata.isMutable) {
      notes.push({
        level: "watch",
        code: "metadata-mutable",
        text: `The name, symbol and artwork can still be changed${slip.metadata.updateAuthority ? ` by ${short(slip.metadata.updateAuthority)}` : ""}. A token can be renamed into something it is not after you buy it.`,
      });
    } else {
      notes.push({ level: "info", code: "metadata-frozen", text: "The name, symbol and artwork are frozen: nobody can rename this token." });
    }
  } else {
    notes.push({ level: "info", code: "no-metadata", text: "No Metaplex metadata account: this token has no on-chain name or symbol, only its mint address." });
  }

  // ---- who holds it
  const h = slip.holders;
  if (h && h.top.length) {
    if (h.top10Bps !== null && h.top10Bps >= 5_000) {
      notes.push({ level: "watch", code: "concentrated", text: `The 10 largest holders hold ${pct(h.top10Bps)} of supply, counted across the ${h.top.length} largest accounts and grouped by the wallet behind them.` });
    } else if (h.top10Bps !== null) {
      notes.push({ level: "info", code: "spread", text: `The 10 largest holders hold ${pct(h.top10Bps)} of supply, over ${h.distinctOwners} distinct wallets among the ${h.top.length} largest accounts.` });
    }
  } else if (h) {
    notes.push({ level: "watch", code: "no-holders", text: "The node returned no token accounts for this mint: nobody holds it." });
  }

  // ---- where it trades, and what walking out would actually pay
  const mk = slip.market;
  if (mk) {
    const sol = (v: bigint) => (Number(v) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 });
    if (mk.curve && !mk.curve.complete) {
      notes.push({
        level: "watch",
        code: "on-the-curve",
        text: `This has not graduated: it trades against a pump.fun bonding curve holding ${sol(mk.curve.realSol)} SOL, not a pool. The curve is the only place to sell, its price is set by arithmetic rather than by anyone bidding, and it takes 1% of every sale.`,
      });
    } else if (mk.curve?.complete && mk.pools.length === 0) {
      notes.push({ level: "watch", code: "graduated-no-pool", text: "The bonding curve has graduated, but no pool against SOL or USDC turned up among the largest accounts holding this mint. Until one does, there is nothing here to sell into." });
    }
    if (mk.pools.length) {
      const ranged = mk.pools.filter((p) => p.concentrated).length;
      notes.push({
        level: "info",
        code: "pools",
        text: `Trades in ${mk.pools.length} pool${mk.pools.length === 1 ? "" : "s"}: ${mk.pools.map((p) => p.name).join(", ")}.${ranged ? ` ${ranged} of them keep${ranged === 1 ? "s" : ""} liquidity in ranges, so their vault balances are not what a trade moves through and no sale is priced from them.` : ""}`,
      });
    }
    const whole = mk.quotes.find((q) => q.shareBps === 10_000);
    if (whole && whole.realisedBps > 0 && whole.realisedBps < 5_000) {
      notes.push({
        level: "watch",
        code: "exit-thin",
        text: `Selling 1% of supply now would get only ${(whole.realisedBps / 100).toFixed(0)}% of the quoted price: the venue is thin enough that the sale moves it against you.`,
      });
    }
    if (!mk.best) notes.push({ level: "watch", code: "no-venue", text: mk.note });

    // ---- can they pull the liquidity out from under you
    for (const lock of mk.locks) {
      if (!lock.read) {
        notes.push({ level: "watch", code: "sol-liquidity-unread", text: `${lock.unread}. Treat this pool's liquidity as withdrawable until you have checked it yourself.` });
        continue;
      }
      const held = lock.burnedBps + lock.strandedBps;
      // A pool holding a sliver of the token's liquidity is not what a sale
      // goes through, and shouting STOP about it teaches the reader to ignore
      // the word. The deepest venue on Solana is usually a Whirlpool nobody
      // can read, so this case is the common one, not the edge.
      const sliver = lock.shareOfLiquidityBps < 1_000;
      const size = sliver ? ` That pool holds ${pct(lock.shareOfLiquidityBps)} of this token's readable liquidity, so it is not where a sale of any size would go.` : "";
      if (held === 0) {
        notes.push({
          level: sliver ? "info" : "stop",
          code: "sol-liquidity-free",
          text: `Every LP token of the ${lock.name} pool is still held by somebody: none of it was burned and none sits at an address with no key. Whoever holds it can withdraw the pool, and then there is nothing to sell into.${size}`,
        });
      } else if (lock.freeBps >= 2_000) {
        notes.push({
          level: sliver ? "info" : "watch",
          code: "sol-liquidity-partly-free",
          text: `${pct(lock.freeBps)} of the ${lock.name} pool's LP tokens can still be withdrawn against (${pct(held)} is gone for good). Taking the rest out would thin the pool by that much.${size}`,
        });
      } else {
        notes.push({
          level: "info",
          code: "sol-liquidity-held",
          text: `${pct(held)} of the ${lock.name} pool's LP tokens are gone for good${lock.burnedBps ? ` (${pct(lock.burnedBps)} burned)` : ""}${lock.strandedBps ? ` (${pct(lock.strandedBps)} at an address with no key)` : ""}, so that share of the liquidity stays put. That is not a promise about the price.`,
        });
      }
    }
  }

  for (const s of slip.skipped) notes.push({ level: "info", code: "skipped", text: `${s.section} could not be read: ${s.reason}` });
  notes.push({
    level: "info",
    code: "venues-read",
    text: "Venues read here: the pump.fun bonding curve, and any Raydium, Orca, Meteora or pump.fun AMM pool that holds this mint among its largest accounts, paired against SOL or USDC. A pool against another pair, or on a venue not in that list, is not counted.",
  });
  return notes;
}

export function splReceipt(slip: SplSlip): Receipt {
  const m = slip.mint;
  const name = slip.metadata?.symbol ? `${slip.metadata.symbol}${slip.metadata.name ? ` · ${slip.metadata.name}` : ""}` : slip.subject;
  const sections: Receipt["sections"] = [
    {
      title: "ID check",
      rows: [
        { label: "mint", value: slip.subject },
        { label: "chain", value: slip.chain.name },
        { label: "stamp", value: slip.stamp },
        ...(slip.whatItIs ? [{ label: "what it is", value: slip.whatItIs }] : []),
        ...(m
          ? [
              { label: "program", value: m.token2022 ? "Token-2022" : "SPL Token" },
              { label: "supply", value: formatAmount(m.supply, m.decimals), note: `${m.decimals} decimals` },
              { label: "mint authority", value: m.mintAuthority ?? "none", note: m.mintAuthority ? "can print more" : "supply is fixed" },
              { label: "freeze authority", value: m.freezeAuthority ?? "none", note: m.freezeAuthority ? "can stop a holder selling" : "holders cannot be frozen" },
            ]
          : []),
        ...(slip.metadata
          ? [
              { label: "name", value: `${slip.metadata.name} (${slip.metadata.symbol})`, note: slip.metadataInline ? "from the Token-2022 extension" : "from Metaplex" },
              { label: "renameable", value: slip.metadata.isMutable, note: slip.metadata.updateAuthority ? `update authority ${slip.metadata.updateAuthority}` : undefined },
            ]
          : []),
      ],
    },
  ];
  if (m && m.extensions.length) {
    sections.push({
      title: "Token-2022 extensions",
      rows: m.extensions.map((e) => ({ label: e.kind, value: describeExtension(e) })),
    });
  }
  if (slip.market) {
    const mk = slip.market;
    const dec = m?.decimals ?? 6;
    const amount = (v: bigint, d: number, frac = 4) => (Number(v) / 10 ** d).toLocaleString("en-US", { maximumFractionDigits: frac });
    sections.push({
      title: "Where it trades",
      rows: [
        { label: "venue", value: mk.best ? mk.best.name : "none found" },
        ...(mk.curve
          ? [
              {
                label: "bonding curve",
                value: mk.curve.complete ? "graduated" : `${amount(mk.curve.realSol, 9)} SOL in, ${amount(mk.curve.realTokens, dec, 0)} tokens left`,
                note: mk.curve.address,
              },
            ]
          : []),
        ...mk.pools.map((p) => ({
          label: `${p.name}${p.concentrated ? " (ranged)" : ""}`,
          value: `${amount(p.quoteReserve, p.quoteDecimals, 3)} ${p.quoteSymbol} · ${amount(p.tokenReserve, dec, 0)} tokens`,
          note: p.address,
        })),
        ...mk.locks.map((l) => ({
          label: `${l.name} liquidity`,
          value: l.read ? `${(l.burnedBps / 100).toFixed(1)}% burned · ${(l.strandedBps / 100).toFixed(1)}% at a keyless address · ${(l.freeBps / 100).toFixed(1)}% withdrawable` : "not read",
          note: l.unread || undefined,
        })),
        ...(mk.spot !== null ? [{ label: "spot", value: `${mk.spot.toPrecision(6)} ${mk.quoteSymbol} per token` }] : []),
        ...mk.quotes.map((q) => ({
          label: `sell ${q.shareBps / 100}%`,
          value: `${amount(q.out, mk.quoteSymbol === "SOL" ? 9 : 6, 6)} ${mk.quoteSymbol}`,
          note: `${(q.realisedBps / 100).toFixed(1)}% of the marginal price`,
        })),
        ...(mk.note ? [{ label: "method", value: mk.note }] : []),
      ],
    });
  }
  if (slip.holders && slip.holders.top.length) {
    sections.push({
      title: "Who holds it",
      rows: [
        { label: "distinct wallets", value: slip.holders.distinctOwners ?? "unknown", note: `among the ${slip.holders.top.length} largest accounts` },
        { label: "top 10", value: pct(slip.holders.top10Bps) },
        ...slip.holders.top.slice(0, 10).map((x, i) => ({ label: `#${i + 1}`, value: `${x.owner ?? x.account} · ${pct(x.bps)}`, note: x.owner ? undefined : "owner not read" })),
      ],
    });
  }
  sections.push({ title: "Door notes", rows: slip.notes.map((n) => ({ label: n.level.toUpperCase(), value: n.text })) });
  return {
    title: `BOUNCER · ${name}`,
    subtitle: `${slip.stamp} · ${slip.chain.name} · slot ${slip.at.slot}${slip.at.timestamp ? ` · ${new Date(slip.at.timestamp * 1000).toISOString().replace(/\.\d+Z$/, "Z")}` : ""}`,
    sections,
    footnotes: [
      `Every value was read from ${slip.chain.name} at the slot shown. Nothing is scored, predicted or advised.`,
      "On Solana the questions that matter most are fields on the mint account, not guesses about code: whether anyone can print more, and whether anyone can freeze what you hold.",
    ],
    meta: { stamp: slip.stamp, slot: slip.at.slot, subject: slip.subject, notes: slip.notes.length, chain: slip.chain.key },
  };
}

function describeExtension(e: TokenExtension): string {
  switch (e.kind) {
    case "transfer-fee":
      return `${(e.feeBps / 100).toFixed(2)}% per transfer, max ${e.maximumFee}, next ${(e.nextFeeBps / 100).toFixed(2)}% at epoch ${e.nextFeeEpoch}`;
    case "permanent-delegate":
      return `${e.delegate} can move anyone's tokens`;
    case "transfer-hook":
      return `${e.programId ?? "unset"} runs on every transfer`;
    case "mint-close-authority":
      return `${e.authority} can close the mint`;
    case "default-account-state":
      return e.frozen ? "new accounts start frozen" : "new accounts start usable";
    case "non-transferable":
      return "cannot be transferred at all";
    case "pausable":
      return `${e.authority ?? "unset"} can pause every transfer`;
    case "interest-bearing":
      return `${(e.rateBps / 100).toFixed(2)}% a year, displayed only`;
    case "metadata-pointer":
      return e.address ?? "unset";
    case "token-metadata":
      return `${e.name} (${e.symbol})`;
    default:
      return `type ${e.type}, not read here`;
  }
}

function formatAmount(value: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  return whole.toLocaleString("en-US");
}

export { base58Encode };
