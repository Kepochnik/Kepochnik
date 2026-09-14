import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256Hex } from "../src/chain/keccak.js";
import { decodeLog, decodeOutputs, encodeCall, eventTopic, selector } from "../src/chain/abi.js";
import { CURVE_EVENTS, ERC20_EVENTS, ERC20_FUNCTIONS, FACTORY_EVENTS, FACTORY_FUNCTIONS, curveAmountOut, decodeLaunchedToken } from "../src/chain/pons.js";
import { RpcClient } from "../src/chain/rpc.js";

test("keccak256 matches the published test vectors", () => {
  assert.equal(keccak256Hex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256Hex("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  // 136 bytes exactly fills one rate block, 137 forces a second block; both must hash cleanly.
  const boundary = [135, 136, 137].map((n) => keccak256Hex("a".repeat(n)));
  assert.equal(new Set(boundary).size, 3);
  for (const hash of boundary) assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(keccak256Hex("a".repeat(137)), keccak256Hex("a".repeat(137)));
});

test("selectors and topics match well-known Ethereum values", () => {
  assert.equal(selector("balanceOf(address)"), "0x70a08231");
  assert.equal(selector("transfer(address,uint256)"), "0xa9059cbb");
  assert.equal(
    eventTopic(ERC20_EVENTS.Transfer),
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  );
});

test("encodeCall pads address arguments to one word", () => {
  const data = encodeCall(ERC20_FUNCTIONS.balanceOf, ["0x78F13072B0F6EBC7fD0B5359c9B4E09C6160cff8"]);
  assert.equal(data, "0x70a0823100000000000000000000000078f13072b0f6ebc7fd0b5359c9b4e09c6160cff8");
});

test("decodeOutputs reads static tuples and strings", () => {
  const words = [
    "0000000000000000000000000000000000000000000000000000000000000020",
    "0000000000000000000000000000000000000000000000000000000000000006",
    "484f504f55540000000000000000000000000000000000000000000000000000",
  ];
  assert.deepEqual(decodeOutputs(ERC20_FUNCTIONS.symbol, `0x${words.join("")}`), ["HOPOUT"]);

  const launched = decodeOutputs(FACTORY_FUNCTIONS.getLaunchedToken, `0x${[
    "000000000000000000000000" + "78f13072b0f6ebc7fd0b5359c9b4e09c6160cff8",
    "000000000000000000000000" + "1111111111111111111111111111111111111111",
    "000000000000000000000000" + "2222222222222222222222222222222222222222",
    "000000000000000000000000" + "3333333333333333333333333333333333333333",
    "0000000000000000000000000000000000000000000000000000000000000000",
    (4n * 10n ** 18n).toString(16).padStart(64, "0"),
    (10000n).toString(16).padStart(64, "0"),
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc4", // int24 -60
    (500n).toString(16).padStart(64, "0"),
    "0000000000000000000000000000000000000000000000000000000000000001",
    "0000000000000000000000000000000000000000000000000000000000000002",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000001",
  ].join("")}`);
  const record = decodeLaunchedToken(launched);
  assert.equal(record.token, "0x78f13072b0f6ebc7fd0b5359c9b4e09c6160cff8");
  assert.equal(record.tickSpacing, -60n);
  assert.equal(record.creatorTaxBps, 500n);
  assert.equal(record.buybackEnabled, true);
  assert.equal(record.phase, 2);
  assert.equal(record.exists, true);
});

test("decodeLog splits indexed topics from data words", () => {
  const log = {
    address: PONS_FACTORY_FOR_TEST,
    topics: [
      eventTopic(FACTORY_EVENTS.TokenLaunched),
      "0x00000000000000000000000078f13072b0f6ebc7fd0b5359c9b4e09c6160cff8",
      "0x0000000000000000000000001111111111111111111111111111111111111111",
      "0x0000000000000000000000002222222222222222222222222222222222222222",
    ],
    data: `0x${[
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0000000000000000000000000000000000000000000000000000000000000001",
      (4n * 10n ** 18n).toString(16).padStart(64, "0"),
    ].join("")}`,
    blockNumber: "0x10",
    transactionHash: "0xabc",
    logIndex: "0x2",
  };
  const decoded = decodeLog<{ token: string; deployer: string; graduationThreshold: bigint }>(FACTORY_EVENTS.TokenLaunched, log);
  assert.equal(decoded.args.token, "0x78f13072b0f6ebc7fd0b5359c9b4e09c6160cff8");
  assert.equal(decoded.args.deployer, "0x2222222222222222222222222222222222222222");
  assert.equal(decoded.args.graduationThreshold, 4n * 10n ** 18n);
  assert.equal(decoded.blockNumber, 16);
  assert.throws(() => decodeLog(CURVE_EVENTS.CurveBuy, log), /does not match CurveBuy/);
});

test("curveAmountOut follows the constant-product formula with an input fee", () => {
  // 1 ETH into 10 ETH / 1,000,000 token reserves at 1% fee.
  const out = curveAmountOut(10n ** 18n, 10n * 10n ** 18n, 1_000_000n * 10n ** 18n, 100n);
  assert.equal(out, 90_081_892_629_663_330_300_272n); // 9.9e45 / 1.099e23, checked by hand
  assert.equal(curveAmountOut(0n, 1n, 1n, 100n), 0n);
  assert.equal(curveAmountOut(1n, 1n, 1n, 10_000n), 0n);
});

test("RpcClient refuses write methods and verifies the chain id", async () => {
  const client = new RpcClient({
    urls: ["https://example.invalid"],
    expectedChainId: 4663,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = body.method === "eth_chainId" ? "0x1" : "0x0";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    }) as typeof fetch,
  });
  await assert.rejects(client.send("eth_sendRawTransaction", ["0x"]), /refusing non-read method/);
  await assert.rejects(client.assertChain(), /reports chain 1, expected 4663/);
});

const PONS_FACTORY_FOR_TEST = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
