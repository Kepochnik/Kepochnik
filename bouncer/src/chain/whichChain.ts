/**
 * WHICH CHAIN: given an address and nothing else, where does it live?
 *
 * Picking the network from a dropdown asks a reader to already know the
 * answer to a question they came here with. Worse, picking it WRONG is
 * silent: most addresses hold nothing on most chains, so the wrong choice
 * reads as "no contract here" rather than "you are looking in the wrong
 * place", and a reader concludes the token is fake when it is merely
 * elsewhere.
 *
 * So ask every chain at once and let the chain answer.
 *
 * Two rules, and both exist because the easy version of this is dangerous.
 *
 * ONE: several chains can legitimately answer. An address is derived from
 * the deployer and their nonce, so the same pair produces the SAME address
 * on every EVM chain — that is not a corner case, it is how a deployer gets
 * a matching address across networks, and it is also how somebody puts a
 * real token on one chain and a trap at the same address on another. This
 * function never picks between them. It returns everything it found, with
 * enough of each to tell them apart, and the caller asks. A tool whose
 * whole job is "do not trust that this address is what you were told"
 * cannot quietly decide which address you meant.
 *
 * TWO: a chain that could not be reached is not a chain without the token.
 * An RPC that times out and an RPC that says "no code here" are opposite
 * answers, and collapsing them tells a reader their token does not exist
 * because somebody's node was rebooting. Unreachable chains come back in
 * their own list, and the caller has to say so.
 */
import { CHAINS, type ChainConfig } from "./chains.js";
import { decodeOutputs, encodeCall, type FunctionAbi, type Hex } from "./abi.js";
import { ERC20_FUNCTIONS } from "./pons.js";
import { RpcError, type RpcClient } from "./rpc.js";

export interface ChainHit {
  chain: ChainConfig;
  /** Bytes of runtime bytecode. Two chains answering with different sizes are different contracts. */
  codeSize: number;
  /** Name and symbol, when the address answered the ERC-20 views. Null means it is a contract but not a readable token. */
  token: { name: string; symbol: string } | null;
}

export interface ChainSearch {
  /** Every chain that has a contract at this address, in the order the chain list gives. */
  hits: ChainHit[];
  /** Chains that could not answer at all. NOT the same as a chain with nothing there. */
  unreachable: { chain: ChainConfig; reason: string }[];
  /** Chains that answered, with no contract at this address. */
  empty: ChainConfig[];
}

/** The EVM chains worth asking, in the order a reader should see them. */
export function searchableChains(): ChainConfig[] {
  return Object.values(CHAINS).filter((c) => c.family === "evm");
}

function decodeString(answer: unknown | RpcError, fn: FunctionAbi): string | null {
  if (answer instanceof RpcError || typeof answer !== "string") return null;
  try {
    const [value] = decodeOutputs(fn, answer as Hex) as [string];
    return typeof value === "string" && value.length ? value : null;
  } catch {
    return null;
  }
}

/**
 * One settled batch per chain, all of them at once: does this address hold
 * code, and if so what does it call itself.
 *
 * Settled, because a chain that reverts `symbol()` still has a contract
 * there and still belongs in the answer — one bad slot must not throw away
 * the getCode beside it. Pinned to nothing: this runs before any head block
 * is known, and it has to, or finding the chain would cost a round trip
 * before the round trip that finds the chain.
 */
export async function whichChains(address: string, clientFor: (chain: ChainConfig) => RpcClient, chains = searchableChains()): Promise<ChainSearch> {
  const results = await Promise.all(
    chains.map(async (chain): Promise<{ chain: ChainConfig; hit: ChainHit | null; reason: string | null }> => {
      try {
        const [code, name, symbol] = await clientFor(chain).sendBatchSettled([
          { method: "eth_getCode", params: [address, "latest"] },
          { method: "eth_call", params: [{ to: address, data: encodeCall(ERC20_FUNCTIONS.name, []) }, "latest"] },
          { method: "eth_call", params: [{ to: address, data: encodeCall(ERC20_FUNCTIONS.symbol, []) }, "latest"] },
        ]);
        // The code slot is the one that decides. If IT failed, the chain did
        // not answer the question asked — that is unreachable, not empty.
        if (code instanceof RpcError) return { chain, hit: null, reason: code.message };
        if (typeof code !== "string") return { chain, hit: null, reason: "the endpoint answered with something that is not bytecode" };
        const codeSize = Math.max(0, (code.length - 2) / 2);
        if (codeSize === 0) return { chain, hit: null, reason: null };
        const n = decodeString(name, ERC20_FUNCTIONS.name);
        const s = decodeString(symbol, ERC20_FUNCTIONS.symbol);
        return { chain, hit: { chain, codeSize, token: n !== null && s !== null ? { name: n, symbol: s } : null }, reason: null };
      } catch (error) {
        return { chain, hit: null, reason: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return {
    hits: results.filter((r) => r.hit).map((r) => r.hit!),
    unreachable: results.filter((r) => !r.hit && r.reason !== null).map((r) => ({ chain: r.chain, reason: r.reason! })),
    empty: results.filter((r) => !r.hit && r.reason === null).map((r) => r.chain),
  };
}

/**
 * What the caller should do with a search.
 *
 * `one` is the only case that proceeds without asking. `several` always
 * asks, however tempting the tie-break looks — "the one with the bigger
 * contract" and "the one you used last time" are both guesses, and a guess
 * here points a reader at a token that is not the one they meant.
 */
export type ChainVerdict =
  | { kind: "one"; chain: ChainConfig; search: ChainSearch }
  | { kind: "several"; search: ChainSearch }
  | { kind: "none"; search: ChainSearch };

export function readChainSearch(search: ChainSearch): ChainVerdict {
  if (search.hits.length === 1) return { kind: "one", chain: search.hits[0].chain, search };
  if (search.hits.length > 1) return { kind: "several", search };
  return { kind: "none", search };
}
