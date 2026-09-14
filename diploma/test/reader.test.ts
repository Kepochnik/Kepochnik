import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeCall, encodeWord, selector, type Hex } from "../src/chain/abi.js";
import { CURVE_FUNCTIONS, ERC20_FUNCTIONS, FACTORY_FUNCTIONS, PONS_V2_FACTORY } from "../src/chain/pons.js";
import { NotAPonsLaunch, PonsReader } from "../src/chain/reader.js";
import { RpcClient } from "../src/chain/rpc.js";
import { formatBps, formatCompact, formatDuration, formatPercent, formatUnits } from "../src/format.js";

const TOKEN = "0x78f13072b0f6ebc7fd0b5359c9b4e09c6160cff8";
const CURVE = "0x1111111111111111111111111111111111111111";
const DEPLOYER = "0x2222222222222222222222222222222222222222";

function encodeString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    encodeWord("uint256", 32n),
    encodeWord("uint256", BigInt(bytes.length)),
    hex.padEnd(Math.ceil(hex.length / 64) * 64, "0"),
  ].join("");
}

/** A fake Robinhood Chain that answers the exact calls PonsReader makes. */
function fakeChain(): typeof fetch {
  const launched = [
    encodeWord("address", TOKEN), encodeWord("address", CURVE), encodeWord("address", DEPLOYER),
    encodeWord("address", DEPLOYER), encodeWord("address", "0x0000000000000000000000000000000000000000"),
    encodeWord("uint256", 42n * 10n ** 17n), encodeWord("uint24", 10_000n), encodeWord("int24", 200n),
    encodeWord("uint16", 300n), encodeWord("bool", true), encodeWord("uint8", 0n),
    encodeWord("uint256", 0n), encodeWord("uint256", 0n), encodeWord("uint256", 0n), encodeWord("bool", true),
  ].join("");
  const answers = new Map<string, string>([
    [`${PONS_V2_FACTORY}:${selector("getLaunchedToken(address)")}:${TOKEN}`, launched],
    [`${TOKEN}:${selector("name()")}`, encodeString("Hop Out")],
    [`${TOKEN}:${selector("symbol()")}`, encodeString("HOPOUT")],
    [`${TOKEN}:${selector("decimals()")}`, encodeWord("uint8", 18n)],
    [`${TOKEN}:${selector("totalSupply()")}`, encodeWord("uint256", 10n ** 27n)],
    [`${TOKEN}:${selector("balanceOf(address)")}:${DEPLOYER}`, encodeWord("uint256", 5n * 10n ** 25n)],
    [`${TOKEN}:${selector("balanceOf(address)")}:${CURVE}`, encodeWord("uint256", 7n * 10n ** 26n)],
    [`${CURVE}:${selector("getReserves()")}`, encodeWord("uint256", 3n * 10n ** 18n) + encodeWord("uint256", 7n * 10n ** 26n)],
    [`${CURVE}:${selector("realQuoteReserve()")}`, encodeWord("uint256", 21n * 10n ** 17n)],
    [`${CURVE}:${selector("graduationThreshold()")}`, encodeWord("uint256", 42n * 10n ** 17n)],
    [`${CURVE}:${selector("phantomQuote()")}`, encodeWord("uint256", 9n * 10n ** 17n)],
    [`${CURVE}:${selector("feeBps()")}`, encodeWord("uint256", 100n)],
    [`${CURVE}:${selector("creatorTaxBps()")}`, encodeWord("uint256", 300n)],
    [`${CURVE}:${selector("readyToGraduate()")}`, encodeWord("bool", false)],
    [`${CURVE}:${selector("graduated()")}`, encodeWord("bool", false)],
    [`${CURVE}:${selector("quoteFeeBalance()")}`, encodeWord("uint256", 10n ** 16n)],
    [`${CURVE}:${selector("creatorTaxBalance()")}`, encodeWord("uint256", 3n * 10n ** 16n)],
    [`${CURVE}:${selector("buybackQuoteBalance()")}`, encodeWord("uint256", 2n * 10n ** 16n)],
    [`${CURVE}:${selector("isNativeQuote()")}`, encodeWord("bool", true)],
  ]);

  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[] | { id: number; method: string; params: unknown[] };
    const requests = Array.isArray(body) ? body : [body];
    const responses = requests.map((request) => {
      let result: unknown;
      if (request.method === "eth_chainId") result = "0x1237";
      else if (request.method === "eth_blockNumber") result = "0x100";
      else if (request.method === "eth_getBlockByNumber") result = { number: "0x100", timestamp: "0x68c6f000", hash: "0xbeef" };
      else if (request.method === "eth_call") {
        const call = (request.params as [{ to: string; data: string }])[0];
        const sel = call.data.slice(0, 10);
        const arg = call.data.length > 10 ? `0x${call.data.slice(34)}` : "";
        const key = arg ? `${call.to}:${sel}:${arg}` : `${call.to}:${sel}`;
        const answer = answers.get(key);
        if (!answer) return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: `unexpected call ${key}` } };
        result = `0x${answer}`;
      } else return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown" } };
      return { jsonrpc: "2.0", id: request.id, result };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
  }) as typeof fetch;
}

test("PonsReader.snapshot pins every read to one block and decodes the curve", async () => {
  const rpc = new RpcClient({ urls: ["https://fake.invalid"], expectedChainId: 4663, fetchImpl: fakeChain() });
  const reader = new PonsReader(rpc);
  const snap = await reader.snapshot(TOKEN);
  assert.equal(snap.chainId, 4663);
  assert.equal(snap.block.number, 256);
  assert.equal(snap.token.symbol, "HOPOUT");
  assert.equal(snap.token.name, "Hop Out");
  assert.equal(snap.launch.creatorTaxBps, 300n);
  assert.equal(snap.launch.tickSpacing, 200n);
  assert.equal(snap.deployerBalance, 5n * 10n ** 25n);
  assert.ok(snap.curve);
  assert.equal(snap.curve!.realQuoteReserve, 21n * 10n ** 17n);
  assert.equal(snap.curve!.graduationThreshold, 42n * 10n ** 17n);
  assert.equal(snap.curve!.isNativeQuote, true);
});

test("PonsReader reports a non-launch as NotAPonsLaunch instead of zeros", async () => {
  const zeroRecord = new Array(15).fill(encodeWord("uint256", 0n)).join("");
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string }[] | { id: number; method: string };
    const requests = Array.isArray(body) ? body : [body];
    const responses = requests.map((r) => ({
      jsonrpc: "2.0",
      id: r.id,
      result: r.method === "eth_call" ? `0x${zeroRecord}` : r.method === "eth_chainId" ? "0x1237" : "0x1",
    }));
    return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["https://fake.invalid"], expectedChainId: 4663, fetchImpl });
  await assert.rejects(new PonsReader(rpc).launchedToken("0x3333333333333333333333333333333333333333", 1), NotAPonsLaunch);
});

test("format helpers keep bigint precision", () => {
  assert.equal(formatUnits(1_234_567_890_000_000_000_000n, 18), "1,234.5678");
  assert.equal(formatUnits(5n * 10n ** 17n, 18), "0.5");
  assert.equal(formatUnits(0n, 18), "0");
  assert.equal(formatCompact(700_000_000n * 10n ** 18n, 18), "700.00M");
  assert.equal(formatBps(300n), "3%");
  assert.equal(formatBps(1250n), "12.5%");
  assert.equal(formatPercent(21n, 42n), "50.0%");
  assert.equal(formatPercent(1n, 3n, 2), "33.33%");
  assert.equal(formatDuration(90_061), "1d 1h");
  assert.equal(formatDuration(59), "59s");
  // encodeCall/selector sanity for the fixtures above
  assert.equal(encodeCall(ERC20_FUNCTIONS.decimals, []), selector("decimals()"));
  assert.equal(encodeCall(CURVE_FUNCTIONS.readyToGraduate, []), selector("readyToGraduate()"));
  assert.equal((encodeCall(FACTORY_FUNCTIONS.getLaunchedToken, [TOKEN]) as Hex).length, 10 + 64);
});
