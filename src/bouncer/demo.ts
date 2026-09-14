/**
 * Synthetic chain for `--demo`: five Pons launches (two graduations, one
 * curve still filling, one dropout, one launched nine seconds ago with its
 * cover charge still open) and one contract that is not a Pons launch at
 * all. Served by a fake fetch. Every address is invented and the output is
 * labelled DEMO. It never touches a network.
 */
import { encodeWord, eventTopic, selector } from "../chain/abi.js";
import { EIP1967_IMPLEMENTATION_SLOT } from "../chain/code.js";
import { keccak256Hex } from "../chain/keccak.js";
import { poolIdFor } from "./exitDoor.js";
import { CURVE_EVENTS, ERC20_EVENTS, FACTORY_EVENTS, PONS_V2_FACTORY, ROBINHOOD_CHAIN_ID, ZERO_ADDRESS } from "../chain/pons.js";
import { RpcClient } from "../chain/rpc.js";
import { addressTopic } from "../chain/tape.js";

export interface DemoToken {
  token: string;
  curve: string;
  deployer: string;
  name: string;
  symbol: string;
  launched: number;
  swept?: number;
  graduated?: number;
  raised: bigint;
  supplyToPool?: bigint;
  positionId?: bigint;
  taxBps: bigint;
  real: bigint;
  tokenReserve: bigint;
  /** Buys on the curve: [block offset from launch, buyer, quoteIn wei, extra door tax bps]. */
  buys: [number, string, bigint, number?][];
  sells: [number, string, bigint][];
  /** Creator fee recipient moves since launch, as [block offset, new recipient]. */
  recipientMoves?: [number, string][];
  /** Buyback flips since launch, as [block offset, enabled]. */
  buybackFlips?: [number, boolean][];
  /** ERC-20 transfers the token logged, as [block offset, from, to, amount]. */
  transfers?: [number, string, string, bigint][];
}

const ETH = 10n ** 18n;
const HEAD = 31_337_500;

const DEV_A = "0x0000000000000000000000000000000000d0e5e1";
const DEV_B = "0x00000000000000000000000000000000000000b7";
const DEV_C = "0x000000000000000000000000000000000000c0c0";
const buyer = (n: number) => `0x${(0xb000 + n).toString(16).padStart(40, "0")}`;

export const DEMO_POOL_MANAGER = "0x00000000000000000000000000000000000900a1";
export const DEMO_HOOK = "0x0000000000000000000000000000000000900c00";
/** The wallet that funded two of FRESH's first buyers minutes before launch. */
export const DEMO_FUNDER = "0x000000000000000000000000000000000000feed";
export const DEMO_BLOCKSCOUT = "https://demo.blockscout.invalid";

/** Not a Pons launch: an upgradeable proxy token somebody named after a real one. */
export const DEMO_IMPOSTOR = { token: "0x00000000000000000000000000000000000bad01", implementation: "0x00000000000000000000000000000000000bad02" };

/** FRESH: launched nine seconds before the head; dev buy at the door, one sniper paid 61%. */
const freshBuys: [number, string, bigint, number?][] = [[1, DEV_C, 400n * 10n ** 15n], [22, buyer(900), 300n * 10n ** 15n, 6_000], [70, buyer(901), 100n * 10n ** 15n, 1_900]];

/** SPRINT: launched, dev bought 61%, eight wallets in the first minute, swept in 212 s. */
const sprintBuys: [number, string, bigint][] = [[3, DEV_A, 2_600n * 10n ** 15n]];
for (let i = 1; i <= 8; i++) sprintBuys.push([100 + i * 250, buyer(i), 200n * 10n ** 15n]);

/** SLOW: 40 buyers over 62 minutes, dev funded 8%. */
const slowBuys: [number, string, bigint][] = [[10, DEV_B, 340n * 10n ** 15n]];
for (let i = 1; i <= 39; i++) slowBuys.push([600 + i * 900, buyer(100 + i), 100n * 10n ** 15n]);

export const DEMO = {
  head: HEAD,
  genesisTimestamp: 1_789_430_400 - HEAD * 0.1,
  threshold: 42n * 10n ** 17n,
  tokens: {
    sprint: { token: "0x00c0ffee0000000000000000000000000000600d", curve: "0x0000c0a70000000000000000000000000000600d", deployer: DEV_A, name: "Sprint", symbol: "SPRINT", launched: HEAD - 2_600, swept: HEAD - 2_600 + 2_120, graduated: HEAD - 2_600 + 2_121, raised: 42n * 10n ** 17n, supplyToPool: 2n * 10n ** 26n, positionId: 4663n, taxBps: 300n, real: 42n * 10n ** 17n, tokenReserve: 0n, buys: sprintBuys, sells: [], recipientMoves: [[2_300, "0x000000000000000000000000000000000000f0f0"]] } as DemoToken,
    slow: { token: "0x0000000000000000000000000000000000005107", curve: "0x0000c0a70000000000000000000000000000a107", deployer: DEV_B, name: "Slow and Steady", symbol: "SLOW", launched: HEAD - 40_000, swept: HEAD - 2_800, graduated: HEAD - 2_799, raised: 42n * 10n ** 17n, supplyToPool: 2n * 10n ** 26n, positionId: 4664n, taxBps: 100n, real: 42n * 10n ** 17n, tokenReserve: 0n, buys: slowBuys, sells: [[20_000, buyer(105), 50n * 10n ** 15n]] } as DemoToken,
    late: { token: "0x00000000000000000000000000000000000000a7", curve: "0x0000c0a7000000000000000000000000000000a7", deployer: DEV_B, name: "Late Bloomer", symbol: "LATE", launched: HEAD - 17_500, raised: 0n, taxBps: 200n, real: 31n * 10n ** 17n, tokenReserve: 3n * 10n ** 26n, buys: Array.from({ length: 60 }, (_, i) => [i * 290, buyer(200 + (i % 25)), 50n * 10n ** 15n] as [number, string, bigint]), sells: [[9_000, buyer(201), 20n * 10n ** 15n], [15_000, buyer(202), 20n * 10n ** 15n], [17_450, DEV_B, 40n * 10n ** 15n]], buybackFlips: [[17_470, false]], transfers: [[17_400, DEV_B, "0x0000000000000000000000000000000000000ca5", 10n ** 25n], [17_450, DEV_B, "0x0000c0a7000000000000000000000000000000a7", 2n * 10n ** 24n]] } as DemoToken,
    fresh: { token: "0x00000000000000000000000000000000000f2e54", curve: "0x0000c0a7000000000000000000000000000f2e54", deployer: DEV_C, name: "Fresh Off The Curve", symbol: "FRESH", launched: HEAD - 90, raised: 0n, taxBps: 1_000n, real: 8n * 10n ** 17n, tokenReserve: 8n * 10n ** 26n, buys: freshBuys, sells: [[85, buyer(900), 120n * 10n ** 15n], [88, buyer(901), 40n * 10n ** 15n]] } as DemoToken,
    nap: { token: "0x0000000000000000000000000000000000000d0e", curve: "0x0000c0a70000000000000000000000000000ad0e", deployer: DEV_B, name: "Nap Time", symbol: "NAP", launched: HEAD - 237_500, raised: 0n, taxBps: 500n, real: 3n * 10n ** 17n, tokenReserve: 9n * 10n ** 26n, buys: [[5, DEV_B, 300n * 10n ** 15n]], sells: [] } as DemoToken,
  },
};

function encodeString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [encodeWord("uint256", 32n), encodeWord("uint256", BigInt(bytes.length)), hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")].join("");
}

function blockTime(block: number): number {
  return DEMO.genesisTimestamp + block * 0.1;
}

function launchedRecord(t: DemoToken): string {
  const phase = t.graduated ? 2n : t.swept ? 1n : 0n;
  return [
    encodeWord("address", t.token), encodeWord("address", t.curve), encodeWord("address", t.deployer), encodeWord("address", t.deployer),
    encodeWord("address", ZERO_ADDRESS), encodeWord("uint256", DEMO.threshold), encodeWord("uint24", 10_000n), encodeWord("int24", 200n),
    encodeWord("uint16", t.taxBps), encodeWord("bool", true), encodeWord("uint8", phase),
    encodeWord("uint256", t.graduated ? t.raised : 0n), encodeWord("uint256", t.graduated ? (t.supplyToPool ?? 0n) : 0n),
    encodeWord("uint256", t.swept ? BigInt(Math.round(blockTime(t.swept))) : 0n), encodeWord("bool", true),
  ].join("");
}

function factoryLogs(from: number, to: number) {
  const logs: unknown[] = [];
  for (const t of Object.values(DEMO.tokens)) {
    if (t.launched >= from && t.launched <= to) {
      logs.push({ address: PONS_V2_FACTORY, topics: [eventTopic(FACTORY_EVENTS.TokenLaunched), addressTopic(t.token), addressTopic(t.curve), addressTopic(t.deployer)], data: `0x${encodeWord("address", ZERO_ADDRESS)}${encodeWord("uint256", 1n)}${encodeWord("uint256", DEMO.threshold)}`, blockNumber: `0x${t.launched.toString(16)}`, transactionHash: `0xdemo${t.symbol.toLowerCase()}launch`, logIndex: "0x0" });
    }
    if (t.swept && t.swept >= from && t.swept <= to) {
      logs.push({ address: PONS_V2_FACTORY, topics: [eventTopic(FACTORY_EVENTS.LaunchSwept), addressTopic(t.token)], data: `0x${encodeWord("uint256", t.raised)}${encodeWord("uint256", t.supplyToPool ?? 0n)}`, blockNumber: `0x${t.swept.toString(16)}`, transactionHash: `0xdemo${t.symbol.toLowerCase()}sweep`, logIndex: "0x1" });
    }
    for (const [offset, enabled] of t.buybackFlips ?? []) {
      const b = t.launched + offset;
      if (b < from || b > to) continue;
      logs.push({ address: PONS_V2_FACTORY, topics: [eventTopic(FACTORY_EVENTS.BuybackEnabledUpdated), addressTopic(t.token), addressTopic(t.deployer)], data: `0x${encodeWord("bool", enabled)}`, blockNumber: `0x${b.toString(16)}`, transactionHash: `0xdemo${t.symbol.toLowerCase()}buyback${b}`, logIndex: "0x4" });
    }
    for (const [offset, to_] of t.recipientMoves ?? []) {
      const b = t.launched + offset;
      if (b < from || b > to) continue;
      logs.push({ address: PONS_V2_FACTORY, topics: [eventTopic(FACTORY_EVENTS.CreatorFeeRecipientUpdated), addressTopic(t.token), addressTopic(t.deployer), addressTopic(to_)], data: "0x", blockNumber: `0x${b.toString(16)}`, transactionHash: `0xdemo${t.symbol.toLowerCase()}move`, logIndex: "0x3" });
    }
    if (t.graduated && t.graduated >= from && t.graduated <= to) {
      logs.push({ address: PONS_V2_FACTORY, topics: [eventTopic(FACTORY_EVENTS.PoolGraduated), addressTopic(t.token)], data: `0x${encodeWord("uint256", t.positionId ?? 0n)}${encodeWord("uint256", t.supplyToPool ?? 0n)}${encodeWord("uint256", t.raised)}`, blockNumber: `0x${t.graduated.toString(16)}`, transactionHash: `0xdemo${t.symbol.toLowerCase()}grad`, logIndex: "0x2" });
    }
  }
  return logs;
}

function curveLogs(t: DemoToken, from: number, to: number) {
  const buy = eventTopic(CURVE_EVENTS.CurveBuy);
  const sell = eventTopic(CURVE_EVENTS.CurveSell);
  const logs: unknown[] = [];
  let index = 0;
  for (const [offset, who, quoteIn, doorBps] of t.buys) {
    const b = t.launched + offset;
    if (b < from || b > to) continue;
    const fee = quoteIn / 100n;
    const tax = (quoteIn * (t.taxBps + BigInt(doorBps ?? 0))) / 10_000n;
    logs.push({ address: t.curve, topics: [buy, addressTopic(who), addressTopic(who)], data: `0x${encodeWord("uint256", quoteIn)}${encodeWord("uint256", 10n ** 24n)}${encodeWord("uint256", fee)}${encodeWord("uint256", tax)}`, blockNumber: `0x${b.toString(16)}`, transactionHash: `0xdemo${t.symbol}${b}`, logIndex: `0x${(index++).toString(16)}` });
  }
  for (const [offset, who, quoteOut] of t.sells) {
    const b = t.launched + offset;
    if (b < from || b > to) continue;
    logs.push({ address: t.curve, topics: [sell, addressTopic(who), addressTopic(who)], data: `0x${encodeWord("uint256", 10n ** 24n)}${encodeWord("uint256", quoteOut)}${encodeWord("uint256", quoteOut / 100n)}${encodeWord("uint256", 0n)}`, blockNumber: `0x${b.toString(16)}`, transactionHash: `0xdemo${t.symbol}${b}s`, logIndex: `0x${(index++).toString(16)}` });
  }
  return logs;
}

export function demoFetch(): typeof fetch {
  const byToken = new Map<string, DemoToken>();
  const byCurve = new Map<string, DemoToken>();
  for (const t of Object.values(DEMO.tokens)) {
    byToken.set(t.token, t);
    byCurve.set(t.curve, t);
  }
  const sel = (sig: string) => selector(sig);
  // Graduated demo pools: full-range V4 state (sqrtPriceX96, liquidity) that
  // reproduces the seeded reserves, at the storage slots extsload reads.
  const poolSlots = new Map<string, string>();
  for (const t of Object.values(DEMO.tokens)) {
    if (!t.graduated) continue;
    const { poolId, tokenIsCurrency0 } = poolIdFor(t.token, ZERO_ADDRESS, 10_000n, 200n, DEMO_HOOK);
    const token = t.supplyToPool ?? 0n;
    const quote = t.raised;
    const [amount0, amount1] = tokenIsCurrency0 ? [token, quote] : [quote, token];
    const sqrtPriceX96 = isqrt((amount1 * 2n ** 192n) / amount0);
    const liquidity = isqrt(amount0 * amount1);
    const stateSlot = keccak256Hex(hexToBytesLocal(`${poolId.slice(2)}${encodeWord("uint256", 6n)}`));
    poolSlots.set(stateSlot, `0x${encodeWord("uint256", sqrtPriceX96)}`);
    poolSlots.set(`0x${(BigInt(stateSlot) + 3n).toString(16).padStart(64, "0")}`, `0x${encodeWord("uint256", liquidity)}`);
  }

  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RpcJson | RpcJson[];
    const requests = Array.isArray(body) ? body : [body];
    const responses = requests.map((request) => {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
      const err = (message: string) => ({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } });
      switch (request.method) {
        case "eth_chainId": return ok(`0x${ROBINHOOD_CHAIN_ID.toString(16)}`);
        case "eth_blockNumber": return ok(`0x${DEMO.head.toString(16)}`);
        case "eth_getBlockByNumber": {
          const tag = (request.params as [string])[0];
          const n = tag === "latest" ? DEMO.head : Number(BigInt(tag));
          return ok({ number: `0x${n.toString(16)}`, timestamp: `0x${Math.round(blockTime(n)).toString(16)}`, hash: `0xdemo${n}` });
        }
        case "eth_getLogs": {
          const f = (request.params as [{ address?: string; fromBlock: string; toBlock: string; topics?: (string | string[] | null)[] }])[0];
          const from = Number(BigInt(f.fromBlock));
          const to = Number(BigInt(f.toBlock));
          const address = f.address ? String(f.address).toLowerCase() : undefined;
          const all = !address
            ? [...factoryLogs(from, to), ...Object.values(DEMO.tokens).flatMap((t) => [...curveLogs(t, from, to), ...tokenLogs(t, from, to)])]
            : address === PONS_V2_FACTORY
              ? factoryLogs(from, to)
              : byCurve.has(address)
                ? curveLogs(byCurve.get(address)!, from, to)
                : byToken.has(address)
                  ? tokenLogs(byToken.get(address)!, from, to)
                  : [];
          return ok((all as { topics: string[] }[]).filter((log) => matchesTopics(log.topics, f.topics)));
        }
        case "eth_getCode": {
          const who = (request.params as [string])[0].toLowerCase();
          if (who === PONS_V2_FACTORY) return ok(DEMO_CODE.factory);
          if (byToken.has(who)) return ok(DEMO_CODE.ponsToken);
          if (byCurve.has(who)) return ok(DEMO_CODE.ponsCurve);
          if (who === DEMO_IMPOSTOR.token) return ok(DEMO_CODE.impostor);
          return ok("0x");
        }
        case "eth_getTransactionReceipt": {
          const hash = (request.params as [string])[0];
          for (const t of Object.values(DEMO.tokens)) {
            const logs = curveLogs(t, 0, DEMO.head) as { transactionHash: string; blockNumber: string }[];
            const hit = logs.filter((l) => l.transactionHash === hash);
            if (hit.length) return ok({ transactionHash: hash, blockNumber: hit[0].blockNumber, from: hit[0], status: "0x1", logs: hit });
          }
          return ok(null);
        }
        case "eth_getStorageAt": {
          const [who, slot] = request.params as [string, string];
          if (who.toLowerCase() === DEMO_IMPOSTOR.token && slot === EIP1967_IMPLEMENTATION_SLOT) return ok(`0x${encodeWord("address", DEMO_IMPOSTOR.implementation)}`);
          return ok(`0x${"0".repeat(64)}`);
        }
        case "eth_call": {
          const call = (request.params as [{ to: string; data: string }])[0];
          const to = call.to.toLowerCase();
          const s = call.data.slice(0, 10);
          if (to === PONS_V2_FACTORY) {
            if (s === sel("getLaunchedToken(address)")) {
              const t = byToken.get(`0x${call.data.slice(34)}`);
              return ok(`0x${t ? launchedRecord(t) : new Array(15).fill(encodeWord("uint256", 0n)).join("")}`);
            }
            if (s === sel("snipeTaxStartBps()")) return ok(`0x${encodeWord("uint256", 9_900n)}`);
            if (s === sel("snipeTaxSeconds()")) return ok(`0x${encodeWord("uint256", 15n)}`);
            if (s === sel("maxCreatorTaxBps()")) return ok(`0x${encodeWord("uint256", 1_000n)}`);
            if (s === sel("poolManager()")) return ok(`0x${encodeWord("address", DEMO_POOL_MANAGER)}`);
            if (s === sel("memeHook()")) return ok(`0x${encodeWord("address", DEMO_HOOK)}`);
            if (s === sel("launchFee()")) return ok(`0x${encodeWord("uint256", 10n ** 15n)}`);
            if (s === sel("launchConfigCount()")) return ok(`0x${encodeWord("uint256", 1n)}`);
            if (s === sel("getLaunchConfig(uint256)")) {
              return ok(`0x${[encodeWord("uint256", 10n ** 27n), encodeWord("uint256", 100n), encodeWord("uint256", 9n * 10n ** 17n), encodeWord("uint256", DEMO.threshold), encodeWord("uint24", 10_000n), encodeWord("int24", 200n), encodeWord("bool", true)].join("")}`);
            }
            if (s === sel("pairTokenEconomics(address)")) return ok(`0x${[encodeWord("uint256", 0n), encodeWord("uint256", 0n), encodeWord("uint8", 18n)].join("")}`);
          }
          if (to === DEMO_HOOK && s === sel("currentFeePolicy()")) {
            return ok(`0x${[encodeWord("address", "0x0000000000000000000000000000000000000fee"), encodeWord("uint16", 3_000n), encodeWord("uint16", 5_000n), encodeWord("uint16", 100n), encodeWord("uint16", 300n)].join("")}`);
          }
          if (to === DEMO_POOL_MANAGER && s === sel("extsload(bytes32)")) {
            const slot = `0x${call.data.slice(10, 74)}`;
            const word = poolSlots.get(slot);
            return ok(word ?? `0x${"0".repeat(64)}`);
          }
          const t = byToken.get(to);
          if (t) {
            if (s === sel("name()")) return ok(`0x${encodeString(t.name)}`);
            if (s === sel("symbol()")) return ok(`0x${encodeString(t.symbol)}`);
            if (s === sel("decimals()")) return ok(`0x${encodeWord("uint8", 18n)}`);
            if (s === sel("totalSupply()")) return ok(`0x${encodeWord("uint256", 10n ** 27n)}`);
            if (s === sel("balanceOf(address)")) {
              const who = `0x${call.data.slice(34)}`;
              if (who === t.deployer) return ok(`0x${encodeWord("uint256", 3n * 10n ** 25n)}`);
              if (who === t.curve) return ok(`0x${encodeWord("uint256", t.tokenReserve)}`);
              return ok(`0x${encodeWord("uint256", 0n)}`);
            }
          }
          if (to === DEMO_IMPOSTOR.token) {
            if (s === sel("name()")) return ok(`0x${encodeString("Sprint")}`);
            if (s === sel("symbol()")) return ok(`0x${encodeString("SPRINT")}`);
            if (s === sel("decimals()")) return ok(`0x${encodeWord("uint8", 18n)}`);
            if (s === sel("totalSupply()")) return ok(`0x${encodeWord("uint256", 10n ** 27n)}`);
          }
          const c = byCurve.get(to);
          if (c) {
            const one = (v: bigint | boolean, type: "uint256" | "bool") => ok(`0x${encodeWord(type, v)}`);
            if (s === sel("token()")) return ok(`0x${encodeWord("address", c.token)}`);
            if (s === sel("getReserves()")) return ok(`0x${encodeWord("uint256", c.real + 9n * 10n ** 17n)}${encodeWord("uint256", c.tokenReserve)}`);
            if (s === sel("realQuoteReserve()")) return one(c.real, "uint256");
            if (s === sel("graduationThreshold()")) return one(DEMO.threshold, "uint256");
            if (s === sel("phantomQuote()")) return one(9n * 10n ** 17n, "uint256");
            if (s === sel("feeBps()")) return one(100n, "uint256");
            if (s === sel("creatorTaxBps()")) return one(c.taxBps, "uint256");
            if (s === sel("readyToGraduate()")) return one(c.tokenReserve === 0n, "bool");
            if (s === sel("graduated()")) return one(Boolean(c.swept), "bool");
            if (s === sel("quoteFeeBalance()")) return one(10n ** 16n, "uint256");
            if (s === sel("creatorTaxBalance()")) return one(3n * 10n ** 16n, "uint256");
            if (s === sel("buybackQuoteBalance()")) return one(2n * 10n ** 16n, "uint256");
            if (s === sel("isNativeQuote()")) return one(true, "bool");
          }
          return err(`demo chain has no answer for ${to} ${s}`);
        }
        default: return err(`demo chain does not serve ${request.method}`);
      }
    });
    return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

function hexToBytesLocal(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A fake Blockscout for the demo chain: FRESH's two non-creator early
 * buyers were both funded by DEMO_FUNDER shortly before the launch; the
 * search knows every demo token by symbol, plus the impostor.
 */
export function demoBlockscoutFetch(): typeof fetch {
  const tokens = Object.values(DEMO.tokens);
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const m = url.pathname.match(/^\/api\/v2\/addresses\/(0x[0-9a-f]{40})\/transactions$/i);
    if (m) {
      const who = m[1].toLowerCase();
      const fresh = DEMO.tokens.fresh;
      const funded = new Set([buyer(900), buyer(901)]);
      const items = funded.has(who)
        ? [{ hash: `0xdemofund${who.slice(-4)}`, value: (10n ** 18n).toString(), block_number: fresh.launched - 400, from: { hash: DEMO_FUNDER }, to: { hash: who } }]
        : [];
      return json({ items, next_page_params: null });
    }
    if (url.pathname === "/api/v2/search") {
      const q = (url.searchParams.get("q") ?? "").toUpperCase();
      const items = tokens.filter((t) => t.symbol.toUpperCase() === q).map((t) => ({ type: "token", address: t.token, name: t.name, symbol: t.symbol }));
      if (q === "SPRINT") items.push({ type: "token", address: DEMO_IMPOSTOR.token, name: "Sprint", symbol: "SPRINT" });
      return json({ items });
    }
    const v = url.pathname.match(/^\/api\/v2\/smart-contracts\/(0x[0-9a-f]{40})$/i);
    if (v) return json({ is_verified: tokens.some((t) => t.token === v[1].toLowerCase() || t.curve === v[1].toLowerCase()) });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function tokenLogs(t: DemoToken, from: number, to: number) {
  const logs: unknown[] = [];
  let index = 0;
  for (const [offset, from_, to_, amount] of t.transfers ?? []) {
    const b = t.launched + offset;
    if (b < from || b > to) continue;
    logs.push({ address: t.token, topics: [eventTopic(ERC20_EVENTS.Transfer), addressTopic(from_), addressTopic(to_)], data: `0x${encodeWord("uint256", amount)}`, blockNumber: `0x${b.toString(16)}`, transactionHash: `0xdemo${t.symbol}xfer${b}`, logIndex: `0x${(index++).toString(16)}` });
  }
  return logs;
}

function matchesTopics(topics: string[], filter?: (string | string[] | null)[]): boolean {
  if (!filter) return true;
  return filter.every((want, i) => {
    if (want === null || want === undefined) return true;
    const have = (topics[i] ?? "").toLowerCase();
    return Array.isArray(want) ? want.some((w) => w.toLowerCase() === have) : want.toLowerCase() === have;
  });
}

/**
 * Synthetic runtime bytecode. The Pons shapes carry a PUSH32 whose immediate
 * contains 0xff and 0xf4 (so a naive byte scan would cry SELFDESTRUCT and
 * DELEGATECALL) and a Solidity metadata trailer with the same bytes inside
 * its IPFS hash. The impostor really does DELEGATECALL.
 */
const CBOR_TRAILER = "a2646970667358221220" + "ff".repeat(4) + "f4".repeat(4) + "ab".repeat(26) + "64736f6c6343000826" + "0035";
export const DEMO_CODE = {
  factory: `0x6080604052${"5b".repeat(40)}00${CBOR_TRAILER}`,
  ponsToken: `0x60806040527f${"ff".repeat(16)}${"f4".repeat(16)}5b${"5b".repeat(200)}00${CBOR_TRAILER}`,
  ponsCurve: `0x60806040527f${"00".repeat(32)}5b${"5b".repeat(900)}00${CBOR_TRAILER}`,
  impostor: `0x6080604052${"5b".repeat(20)}f4${"5b".repeat(20)}ff00${CBOR_TRAILER}`,
};

export function demoRpc(): RpcClient {
  return new RpcClient({ urls: ["demo://robinhood-chain"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl: demoFetch(), minSpacingMs: 0 });
}

export const DEMO_ETH = ETH;

interface RpcJson {
  id: number;
  method: string;
  params: unknown[];
}
