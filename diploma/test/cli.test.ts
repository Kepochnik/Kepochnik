import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeWord } from "../src/chain/abi.js";
import { RpcClient } from "../src/chain/rpc.js";
import { flagNumber, flagString, parseArgs } from "../src/cli/args.js";
import { doctorReceipt, runDoctor } from "../src/cli/doctor.js";
import { renderReceipt, type Receipt } from "../src/receipt.js";

test("parseArgs handles commands, flags, inline values and positionals", () => {
  const parsed = parseArgs(["inspect", "0xabc", "--format", "json", "--verbose", "--rpc=https://x", "extra"]);
  assert.equal(parsed.command, "inspect");
  assert.deepEqual(parsed.positionals, ["0xabc", "extra"]);
  assert.equal(parsed.flags.format, "json");
  assert.equal(parsed.flags.verbose, true);
  assert.equal(parsed.flags.rpc, "https://x");
  assert.equal(flagString(parsed.flags, "verbose"), undefined);
  assert.equal(flagNumber(parsed.flags, "missing", 7), 7);
  assert.throws(() => flagNumber({ n: "abc" }, "n", 1), /expects a number/);
});

test("renderReceipt produces text, markdown and json with bigint-safe values", () => {
  const receipt: Receipt = {
    title: "demo receipt",
    subtitle: "synthetic",
    sections: [{ title: "curve", rows: [{ label: "real quote", value: 21n * 10n ** 17n, note: "wei" }, { label: "ready", value: false }] }],
    footnotes: ["No keys. No signing."],
    meta: { block: 256 },
  };
  const text = renderReceipt(receipt, "text");
  assert.match(text, /DEMO RECEIPT|demo receipt/);
  assert.match(text, /CURVE/);
  assert.match(text, /2100000000000000000 {2}\(wei\)/);
  assert.match(text, /ready {7}no/);
  const md = renderReceipt(receipt, "markdown");
  assert.match(md, /^## demo receipt/);
  assert.match(md, /\| real quote \| 2100000000000000000 _\(wei\)_ \|/);
  const json = JSON.parse(renderReceipt(receipt, "json")) as Receipt;
  assert.equal(json.sections[0].rows[0].value, "2100000000000000000");
  assert.equal(json.meta.block, 256);
});

test("doctor reports a healthy read path and encodes snipe tax terms", async () => {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[] | { id: number; method: string; params: unknown[] };
    const requests = Array.isArray(body) ? body : [body];
    let callIndex = 0;
    const responses = requests.map((r) => {
      let result: unknown = "0x1";
      if (r.method === "eth_chainId") result = "0x1237";
      if (r.method === "eth_getBlockByNumber") result = { number: "0x2a", timestamp: "0x68c6f000", hash: "0x00" };
      if (r.method === "eth_getCode") result = "0x6080";
      if (r.method === "eth_call") result = `0x${encodeWord("uint256", callIndex++ === 0 ? 9900n : 15n)}`;
      return { jsonrpc: "2.0", id: r.id, result };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["https://fake.invalid"], expectedChainId: 4663, fetchImpl });
  let tick = 0;
  const report = await runDoctor(rpc, () => (tick += 5));
  assert.equal(report.ok, true, report.errors.join("; "));
  assert.equal(report.chainId, 4663);
  assert.equal(report.latestBlock, 42);
  assert.equal(report.factoryHasCode, true);
  assert.equal(report.snipeTaxStartBps, 9900n);
  assert.equal(report.snipeTaxSeconds, 15n);
  assert.equal(report.latencyMs, 5);
  const text = renderReceipt(doctorReceipt(report, "tool"), "text");
  assert.match(text, /snipe tax start {3}99%/);
  assert.match(text, /signing {7}none/);
  for (const line of text.split("\n")) assert.equal(line.length, text.split("\n")[0].length, line);
});

test("doctor flags a wrong chain instead of throwing", async () => {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_chainId" ? "0x1" : "0x" }));
  }) as typeof fetch;
  const rpc = new RpcClient({ urls: ["https://fake.invalid"], expectedChainId: 4663, fetchImpl });
  const report = await runDoctor(rpc);
  assert.equal(report.ok, false);
  assert.match(report.errors[0], /chain id 1 is not Robinhood Chain/);
});
