/**
 * ONE CREW: were the first buyers funded by the same hand? For each of the
 * first N wallets in the room, Blockscout answers where its earliest
 * incoming native transfer came from. Wallets sharing a funder form a crew;
 * the crew's share of everything bought on the curve is the number that
 * matters. Nothing here names a person: a funder is an address, often an
 * exchange hot wallet, and the slip says which is which only when the
 * chain's explorer labels it.
 */
import type { BlockscoutClient, FundingSource } from "../chain/blockscout.js";
import type { Room } from "./room.js";

export interface CrewWallet {
  address: string;
  funder: string | null;
  fundedAtBlock: number | null;
  quoteIn: bigint;
  creatorWallet: boolean;
}

export interface Crew {
  funder: string;
  wallets: string[];
  quoteIn: bigint;
  shareBps: number;
}

export interface OneCrew {
  checked: number;
  wallets: CrewWallet[];
  crews: Crew[];
  /** Largest crew's share of all quote bought on the curve, in bps. */
  largestCrewShareBps: number;
  /** Wallets whose funder is the deployer or fee recipient. */
  fundedByCreator: string[];
  unresolved: number;
}

export async function readOneCrew(blockscout: BlockscoutClient, room: Room, launchBlock: number, creatorWallets: string[], limit = 12): Promise<OneCrew> {
  const creators = new Set(creatorWallets.map((c) => c.toLowerCase()));
  const candidates = room.first.slice(0, limit);
  const wallets: CrewWallet[] = [];
  let unresolved = 0;
  for (const address of candidates) {
    const w = room.wallets.find((x) => x.address === address);
    let source: FundingSource | null = null;
    try {
      source = await blockscout.fundingSource(address, launchBlock + 1);
    } catch {
      unresolved++;
    }
    if (!source && !creators.has(address)) unresolved++;
    wallets.push({ address, funder: source?.from ?? null, fundedAtBlock: source?.block ?? null, quoteIn: w?.quoteIn ?? 0n, creatorWallet: creators.has(address) });
  }
  const byFunder = new Map<string, CrewWallet[]>();
  for (const w of wallets) if (w.funder) byFunder.set(w.funder, [...(byFunder.get(w.funder) ?? []), w]);
  const crews: Crew[] = [...byFunder.entries()]
    .filter(([, ws]) => ws.length > 1)
    .map(([funder, ws]) => {
      const quoteIn = ws.reduce((a, w) => a + w.quoteIn, 0n);
      return { funder, wallets: ws.map((w) => w.address), quoteIn, shareBps: room.totalQuoteIn === 0n ? 0 : Number((quoteIn * 10_000n) / room.totalQuoteIn) };
    })
    .sort((a, b) => b.shareBps - a.shareBps);
  return {
    checked: wallets.length,
    wallets,
    crews,
    largestCrewShareBps: crews[0]?.shareBps ?? 0,
    fundedByCreator: wallets.filter((w) => w.funder && creators.has(w.funder)).map((w) => w.address),
    unresolved,
  };
}

export function oneCrewLine(c: OneCrew): string {
  if (c.checked === 0) return "no buyers to check";
  if (!c.crews.length) return `${c.checked} first buyers checked · no shared funder${c.unresolved ? ` · ${c.unresolved} unresolved` : ""}`;
  const top = c.crews[0];
  return `${c.checked} first buyers checked · ${top.wallets.length} share a funder (${(top.shareBps / 100).toFixed(0)}% of the curve)${c.fundedByCreator.length ? ` · ${c.fundedByCreator.length} funded by the creator` : ""}`;
}
