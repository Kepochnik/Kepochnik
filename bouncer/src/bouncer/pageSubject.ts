/**
 * WHICH TOKEN IS THIS PAGE ABOUT, AND ON WHICH CHAIN?
 *
 * The extension answers this twice. The content script pins a badge to a
 * token page, and the popup opens the slip for whatever page you were on.
 * They each kept their own table of hosts, and they did not agree:
 *
 *   content.js      basescan.org → base, bscscan.com → bnb, solscan.io →
 *                   solana, and an aggregator's first path segment.
 *   popup-init.js   arcscan.app → arc, everything else → robinhood.
 *
 * So opening the popup on a Base token page read that address on Robinhood
 * Chain, where the same twenty bytes are a different contract or nothing at
 * all. The content script's own comment says why that is the worst outcome
 * available — "an unknown chain would send the reader to the wrong one" — and
 * the popup was doing exactly that, silently, with a confident verdict on top.
 * It could not read a Solana mint at all: its address pattern was EVM-only,
 * while the extension's own store listing promises Solana.
 *
 * One table, in the core, generated into the extension at build time. Two
 * hand-kept copies of a mapping is one copy too many, and this is the third
 * time that shape has produced a bug in this repo.
 */
import { CHAINS } from "../chain/chains.js";

export type SubjectKind = "evm" | "solana";

export interface PageSubject {
  /** A key in the chain table. */
  chain: string;
  address: string;
  kind: SubjectKind;
}

/**
 * Hosts that show one token, and the chain they are about.
 *
 * The chains' own explorers are derived from the chain table below, so a new
 * chain brings its explorer with it. Everything here is a third-party site
 * whose host the chain table has no reason to know.
 */
export const THIRD_PARTY_HOSTS: Readonly<Record<string, string>> = {
  "basescan.org": "base",
  "bscscan.com": "bnb",
  "solscan.io": "solana",
  "solana.fm": "solana",
  // Arc mainnet has no factory in the table, so a bare arcscan.app link is
  // read on the testnet BOUNCER can actually answer for rather than on a
  // chain where every read would come back empty.
  "arcscan.app": "arc-testnet",
  "ponsfamily.com": "robinhood",
};

/**
 * Sites that carry several chains and name the chain in the first path
 * segment: dexscreener.com/base/0x…, gmgn.ai/sol/token/….
 */
export const MULTI_CHAIN_HOSTS: readonly string[] = ["dexscreener.com", "gmgn.ai"];

/** First path segment → chain key, for the sites above. */
export const PATH_SEGMENTS: Readonly<Record<string, string>> = {
  base: "base",
  bsc: "bnb",
  bnb: "bnb",
  solana: "solana",
  sol: "solana",
  robinhood: "robinhood",
  arc: "arc-testnet",
};

/** Host → chain key, the chains' own explorers included. */
export function tokenPageHosts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chain of Object.values(CHAINS)) {
    for (const url of [chain.blockscout, chain.explorerUrl]) {
      if (!url) continue;
      try {
        out[new URL(url).hostname.replace(/^www\./, "")] = chain.key;
      } catch {
        /* a malformed entry in the table is not this function's to fix */
      }
    }
  }
  // Third-party hosts last, so a site that is also somebody's explorer keeps
  // the chain the table gave it.
  for (const [host, key] of Object.entries(THIRD_PARTY_HOSTS)) out[host] ??= key;
  return out;
}

const EVM = /0x[0-9a-fA-F]{40}/;
// base58, which is where the excluded 0, O, I and l come from. Anchored to a
// path segment that says what it is, because an unanchored 32-to-44 character
// run matches half the query strings on the web.
const SOLANA = /\/(?:token|account|address|mint)\/([1-9A-HJ-NP-Za-km-z]{32,44})/;

/**
 * The token a page is about, or null.
 *
 * Null when the chain cannot be named, even if an address is right there in
 * the URL: reading an address on the wrong chain produces a confident answer
 * about a different contract, which is worse than no answer at all.
 */
export function pageSubject(url: string): PageSubject | null {
  let host: string;
  let segments: string[];
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    // hostname, not host: host carries the port, and "basescan.org:8443"
    // matches nothing in the table. No explorer serves on a port today, so
    // this is not a bug anybody has hit — but a lookup keyed on a string that
    // can silently carry an extra field is a lookup waiting to miss.
    host = parsed.hostname.replace(/^www\./, "");
    segments = parsed.pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }

  let chain = tokenPageHosts()[host] ?? null;
  if (!chain && MULTI_CHAIN_HOSTS.includes(host)) chain = PATH_SEGMENTS[(segments[0] ?? "").toLowerCase()] ?? null;
  if (!chain) return null;

  const family = CHAINS[chain]?.family ?? "evm";
  if (family === "solana") {
    const mint = SOLANA.exec(url)?.[1];
    return mint ? { chain, address: mint, kind: "solana" } : null;
  }
  const address = EVM.exec(url)?.[0];
  return address ? { chain, address: address.toLowerCase(), kind: "evm" } : null;
}
