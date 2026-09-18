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
import {
  METADATA_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  metadataAddress,
  parseMetadata,
  parseMint,
  tokenAccountOwner,
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
  at: { slot: number; timestamp: number | null };
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
  notes: DoorNote[];
  skipped: { section: string; reason: string }[];
}

export interface SplOptions {
  /** How many of the largest accounts to resolve to owners; 20 is what the node returns. */
  topHolders?: number;
}

export async function readSplDoor(rpc: SolanaRpc, input: string, chain: ChainConfig, options: SplOptions = {}): Promise<SplSlip> {
  if (!isSolanaAddress(input)) throw new Error(`${input} is not a Solana address`);
  const slot = await rpc.slot();
  const timestamp = await rpc.blockTime(slot);
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
    notes: [],
    skipped: [],
  };

  const account = await rpc.accountInfo(input);
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

  const attempt = async (section: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      slip.skipped.push({ section, reason: error instanceof Error ? error.message : String(error) });
    }
  };

  // ---- the name, from the extension when there is one and Metaplex otherwise
  const inline = slip.mint.extensions.find((e) => e.kind === "token-metadata");
  if (inline && inline.kind === "token-metadata") {
    slip.metadataInline = true;
    slip.metadata = { updateAuthority: inline.updateAuthority ?? "", mint: input, name: inline.name, symbol: inline.symbol, uri: inline.uri, sellerFeeBasisPoints: 0, primarySaleHappened: false, isMutable: inline.updateAuthority !== null };
  } else {
    await attempt("metadata", async () => {
      const pda = metadataAddress(input);
      if (!pda) return;
      const metaAccount = await rpc.accountInfo(pda);
      if (metaAccount && metaAccount.owner === METADATA_PROGRAM) slip.metadata = parseMetadata(metaAccount);
    });
  }

  // ---- who holds it, resolved from token accounts to the people behind them
  await attempt("holders", async () => {
    const largest = (await rpc.largestAccounts(input)).slice(0, options.topHolders ?? 20);
    if (!largest.length) {
      slip.holders = { top: [], top10Bps: null, distinctOwners: null };
      return;
    }
    const owners = await rpc.multipleAccounts(largest.map((a) => a.address));
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
  });

  slip.notes = splNotes(slip);
  return slip;
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

  for (const s of slip.skipped) notes.push({ level: "info", code: "skipped", text: `${s.section} could not be read: ${s.reason}` });
  notes.push({
    level: "info",
    code: "no-pools",
    text: `Where this trades and what a sale would pay are not read on ${slip.chain.name} yet: the pool layouts of Raydium, Orca and Meteora each need their own reader, and guessing at them would be worse than saying so.`,
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
