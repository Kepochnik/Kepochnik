/**
 * LOOKALIKE: how many tokens carry this name or ticker, which the factory
 * knows, and which came first. Candidates come from the explorer's token
 * search; every one is checked against the factory record, and the ones
 * the factory made are ordered by launch block. A ticker is not an
 * identity; the launch block and the factory record are.
 */
import type { BlockscoutClient } from "../chain/blockscout.js";
import { PonsReader, NotAPonsLaunch } from "../chain/reader.js";
import type { RpcClient } from "../chain/rpc.js";
import { GraduationPhase } from "../chain/pons.js";
import { findLaunchBlock } from "./door.js";

export interface Lookalike {
  address: string;
  name: string;
  symbol: string;
  registered: boolean;
  phase: GraduationPhase | null;
  launchBlock: number | null;
}

export interface LookalikeReport {
  query: string;
  subject: string;
  candidates: Lookalike[];
  registeredCount: number;
  /** The registered lookalike with the lowest launch block, if any launch block was found. */
  earliest: Lookalike | null;
  subjectIsEarliest: boolean | null;
}

export async function readLookalikes(rpc: RpcClient, blockscout: BlockscoutClient, subject: string, symbol: string, block: number, factory: string, searchBlocks: number, limit = 8, subjectRegistered = true): Promise<LookalikeReport> {
  const hits = await blockscout.searchTokens(symbol);
  const reader = new PonsReader(rpc, factory);
  const candidates: Lookalike[] = [];
  const wanted = symbol.toUpperCase();
  for (const hit of hits.filter((h) => h.symbol.toUpperCase() === wanted).slice(0, limit)) {
    let registered = false;
    let phase: GraduationPhase | null = null;
    try {
      const record = await reader.launchedToken(hit.address, block);
      registered = true;
      phase = record.phase;
    } catch (error) {
      if (!(error instanceof NotAPonsLaunch)) throw error;
    }
    const launchBlock = registered ? await findLaunchBlock(rpc, hit.address, block, searchBlocks, factory) : null;
    candidates.push({ address: hit.address, name: hit.name, symbol: hit.symbol, registered, phase, launchBlock });
  }
  if (!candidates.some((c) => c.address === subject.toLowerCase())) {
    // The explorer may lag the chain by a few blocks; the subject is always a candidate.
    candidates.unshift({ address: subject.toLowerCase(), name: "", symbol, registered: subjectRegistered, phase: null, launchBlock: null });
  }
  const dated = candidates.filter((c) => c.registered && c.launchBlock !== null).sort((a, b) => a.launchBlock! - b.launchBlock!);
  const earliest = dated[0] ?? null;
  return {
    query: symbol,
    subject: subject.toLowerCase(),
    candidates,
    registeredCount: candidates.filter((c) => c.registered).length,
    earliest,
    subjectIsEarliest: earliest ? earliest.address === subject.toLowerCase() : null,
  };
}

/** The registered launches that carry the subject's ticker when the subject itself is not one: the impostor test. */
export function registeredLookalikes(l: LookalikeReport): Lookalike[] {
  return l.candidates.filter((c) => c.address !== l.subject && c.registered);
}

export function lookalikeLine(l: LookalikeReport): string {
  const others = l.candidates.filter((c) => c.address !== l.subject);
  if (!others.length) return `only token called ${l.query} the explorer knows`;
  const reg = others.filter((c) => c.registered).length;
  return `${others.length} other token${others.length === 1 ? "" : "s"} called ${l.query} (${reg} launched on this factory)${l.subjectIsEarliest === null ? "" : l.subjectIsEarliest ? " · this one came first" : " · this one is not the first"}`;
}
