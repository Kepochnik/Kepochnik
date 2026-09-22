/**
 * Finding the chain is a safety feature, so its failures are safety
 * failures. These are the three that matter: naming one chain when two
 * answered, calling a dead endpoint an empty chain, and being fooled by
 * an address that answers name() while holding no code.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcClient } from "../src/chain/rpc.js";
import { CHAINS, type ChainConfig } from "../src/chain/chains.js";
import { addressFamily, readChainSearch, whichChains } from "../src/chain/whichChain.js";
import { encodeCall, decodeOutputs } from "../src/chain/abi.js";
import { ERC20_FUNCTIONS } from "../src/chain/pons.js";

const TOKEN = "0x00000000000000000000000000000000000000aa";
const NAME = encodeCall(ERC20_FUNCTIONS.name, []);
const SYMBOL = encodeCall(ERC20_FUNCTIONS.symbol, []);

/** A string ABI-encoded the way an ERC-20 view returns one. */
function abiString(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const padded = Buffer.concat([bytes, Buffer.alloc((32 - (bytes.length % 32)) % 32)]);
  return `0x${(32n).toString(16).padStart(64, "0")}${BigInt(bytes.length).toString(16).padStart(64, "0")}${padded.toString("hex")}`;
}

/**
 * A fake set of chains, each told what to answer: bytecode of a given size,
 * a token name, or a transport failure.
 */
function clients(plan: Record<string, { code?: number; name?: string; symbol?: string; dead?: string }>) {
  return (chain: ChainConfig) =>
    new RpcClient({
      urls: [`demo://${chain.key}`],
      expectedChainId: chain.chainId,
      minSpacingMs: 0,
      // One attempt per endpoint, so a "dead" chain fails fast in a test.
      requestBudgetMs: 500,
      timeoutMs: 200,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        const want = plan[chain.key] ?? {};
        if (want.dead) return new Response(want.dead, { status: 503 });
        const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
        const answer = (req: { id: number; method: string; params: unknown[] }) => {
          if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: `0x${chain.chainId.toString(16)}` };
          if (req.method === "eth_getCode") return { jsonrpc: "2.0", id: req.id, result: `0x${"ab".repeat(want.code ?? 0)}` };
          const data = (req.params[0] as { data: string }).data;
          if (data === NAME && want.name) return { jsonrpc: "2.0", id: req.id, result: abiString(want.name) };
          if (data === SYMBOL && want.symbol) return { jsonrpc: "2.0", id: req.id, result: abiString(want.symbol) };
          return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "execution reverted" } };
        };
        return new Response(JSON.stringify(body.map(answer)));
      }) as typeof fetch,
    });
}

const EVM = Object.values(CHAINS).filter((c) => c.family === "evm");

test("one chain holds the contract: no question to ask", async () => {
  const search = await whichChains(TOKEN, clients({ base: { code: 120, name: "Dollar", symbol: "USDC" } }), EVM);
  const verdict = readChainSearch(search);
  assert.equal(verdict.kind, "one");
  assert.equal(verdict.kind === "one" && verdict.chain.key, "base");
  assert.equal(search.hits[0].token?.symbol, "USDC");
  assert.equal(search.unreachable.length, 0, "every other chain answered, none of them failed");
});

test("the same address on two chains is never resolved by picking one", async () => {
  // This is the whole reason the search returns a list. A deployer's address
  // is derived from their nonce, so the identical address exists on every
  // chain they deploy from — and so does an impostor who wants it to.
  const search = await whichChains(
    TOKEN,
    clients({ base: { code: 120, name: "Dollar", symbol: "USDC" }, bnb: { code: 900, name: "Dollar", symbol: "USDC" } }),
    EVM,
  );
  const verdict = readChainSearch(search);
  assert.equal(verdict.kind, "several", "two contracts at one address is a question for the reader, not a tie-break");
  assert.deepEqual(search.hits.map((h) => h.chain.key).sort(), ["base", "bnb"]);
  // And enough to tell them apart without leaving the page.
  assert.notEqual(search.hits[0].codeSize, search.hits[1].codeSize, "different contracts, and the sizes say so");
});

test("a chain that could not answer is not a chain without the token", async () => {
  // The dangerous collapse: an endpoint times out, the search reports
  // nothing found, and a reader concludes their token is fake.
  const search = await whichChains(TOKEN, clients({ base: { dead: "upstream is down" } }), EVM);
  assert.equal(search.hits.length, 0);
  assert.deepEqual(
    search.unreachable.map((u) => u.chain.key),
    ["base"],
    "the chain that broke has to be named, not counted as empty",
  );
  assert.ok(!search.empty.some((c) => c.key === "base"), "a broken chain must never appear as one that answered");
  assert.equal(readChainSearch(search).kind, "none");
});

test("an address answering name() with no code behind it is not a hit", async () => {
  // Some endpoints answer eth_call for an address that holds nothing. The
  // code slot is what decides, and it says zero.
  const search = await whichChains(TOKEN, clients({ base: { code: 0, name: "Ghost", symbol: "GHOST" } }), EVM);
  assert.equal(search.hits.length, 0, "no bytecode, no contract, whatever the views say");
  assert.ok(search.empty.some((c) => c.key === "base"));
});

test("a contract that is not a readable token still counts as found", async () => {
  // A router, a multisig, an NFT: the reader pasted it and it is somewhere.
  // Saying "not on any chain" because symbol() reverted would be wrong.
  const search = await whichChains(TOKEN, clients({ arc: { code: 400 } }), EVM);
  assert.equal(readChainSearch(search).kind, "one");
  assert.equal(search.hits[0].token, null, "found, and honest that it does not name itself");
});

test("a slow chain is left behind, not waited for", async () => {
  // Measured live: one endpoint took 5080 ms and dragged a first paint to
  // 5.7 s on a page whose budget is two. The search costs the slowest chain
  // asked, so the slowest chain needs a bound — and being too slow is
  // reported the same way as being down, because for a reader waiting on an
  // answer those are the same thing.
  const slowOne = (chain: ChainConfig) =>
    new RpcClient({
      urls: [`demo://${chain.key}`],
      expectedChainId: chain.chainId,
      minSpacingMs: 0,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (chain.key === "arc") await new Promise((resolve) => setTimeout(resolve, 5_000));
        const body = JSON.parse(String(init?.body)) as { id: number; method: string }[];
        return new Response(
          JSON.stringify(
            body.map((r) =>
              r.method === "eth_chainId"
                ? { jsonrpc: "2.0", id: r.id, result: `0x${chain.chainId.toString(16)}` }
                : r.method === "eth_getCode"
                  ? { jsonrpc: "2.0", id: r.id, result: chain.key === "base" ? `0x${"ab".repeat(60)}` : "0x" }
                  : { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "execution reverted" } },
            ),
          ),
        );
      }) as typeof fetch,
    });

  const started = Date.now();
  const search = await whichChains(TOKEN, slowOne, EVM, 200);
  const spent = Date.now() - started;

  assert.ok(spent < 1_500, `one slow chain held the search for ${spent} ms`);
  assert.equal(readChainSearch(search).kind, "one", "the chains that did answer still settle it");
  assert.equal(search.hits[0].chain.key, "base");
  // And the one that was dropped is named, never silently counted as empty.
  const arc = search.unreachable.find((u) => u.chain.key === "arc");
  assert.ok(arc, "the chain that was left behind has to be reported");
  assert.match(arc.reason, /did not answer within/);
  assert.ok(!search.empty.some((c) => c.key === "arc"), "too slow is not the same as nothing there");
});

test("an endpoint answering for the wrong chain is never a hit", async () => {
  // The failure this whole feature exists to prevent, made by the feature
  // itself: a proxy route for Base pointed at BNB would have the search
  // report a token as living on Base when it has never been deployed there.
  // The client only checks its chain id inside head(), and the search runs
  // before a chain is chosen, so it cannot call head() — it has to ask.
  const liar = (chain: ChainConfig) =>
    new RpcClient({
      urls: [`demo://${chain.key}`],
      expectedChainId: chain.chainId,
      minSpacingMs: 0,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string }[];
        return new Response(
          JSON.stringify(
            body.map((r) =>
              r.method === "eth_chainId"
                ? // Base's endpoint answers with BNB's chain id.
                  { jsonrpc: "2.0", id: r.id, result: `0x${(chain.key === "base" ? CHAINS.bnb.chainId : chain.chainId).toString(16)}` }
                : r.method === "eth_getCode"
                  ? { jsonrpc: "2.0", id: r.id, result: chain.key === "base" ? `0x${"ab".repeat(80)}` : "0x" }
                  : { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "execution reverted" } },
            ),
          ),
        );
      }) as typeof fetch,
    });

  const search = await whichChains(TOKEN, liar, EVM);
  assert.equal(search.hits.length, 0, "bytecode from an endpoint on the wrong chain is not a token on this chain");
  const base = search.unreachable.find((u) => u.chain.key === "base");
  assert.ok(base, "and the reader has to be told the endpoint is misrouted, not that the chain is empty");
  assert.match(base.reason, /reports chain \d+, not \d+/);
  assert.ok(!search.empty.some((c) => c.key === "base"));
});

test("the address decides the family, not the last answer", async () => {
  // Reported from the live site with a screenshot: the menu said "Find the
  // chain", the strip said "Reading Solana", and a perfectly good EVM
  // address came back "paste a Solana mint address". The page had checked
  // a Solana mint earlier and was still answering for that one.
  const b58 = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  const evm = "0x6835dbf2d7d5852f84bf0a80de00cab3864f44b1";
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  assert.equal(addressFamily(evm, b58), "evm");
  assert.equal(addressFamily(mint, b58), "solana");
  // Whitespace either side is a paste, not a different address.
  assert.equal(addressFamily(`  ${evm}\n`, b58), "evm");
  // 0x and forty hex wins even where base58 would also match, which it
  // cannot here — but the order is the guarantee, so it is stated.
  assert.equal(addressFamily("not an address at all", b58), "neither");
  assert.equal(addressFamily("0x1234", b58), "neither");
});
