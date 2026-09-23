import assert from "node:assert/strict";
import { test } from "node:test";
import { SolanaRpc, TOKEN_PROGRAM } from "../src/chain/solana.js";
import { RpcClient } from "../src/chain/rpc.js";
import { readSplDoor } from "../src/bouncer/spl.js";
import { CHAINS } from "../src/chain/chains.js";
import { base58Encode } from "../src/chain/base58.js";

const key = (byte: number) => new Uint8Array(32).fill(byte);
const deny = (async () => new Response("Forbidden", { status: 403 })) as unknown as typeof fetch;

test("a refused slot read costs the clock, not the token", async () => {
  // Found by pasting a real mint at a real endpoint. The node answered
  // getSlot with a 403, Promise.all rejected, and BOUNCER reported
  // nothing at all — over a mint account it could read perfectly well,
  // about a token whose mint authority was still set. "Somebody can print
  // more of this" is the answer somebody came for, and it was thrown away
  // to protect a timestamp.
  //
  // Nothing on Solana is pinned to the slot; it is metadata about the
  // reading. Metadata must never be able to destroy the reading.
  const rpc = new SolanaRpc({
    urls: ["https://a.invalid"],
    minSpacingMs: 0,
    retries: 0,
    fetchImpl: (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      if (body.method === "getSlot") return new Response("Forbidden", { status: 403 });
      if (body.method === "getAccountInfo" || body.method === "getMultipleAccounts") {
        const mint = Buffer.alloc(82);
        mint[45] = 1;
        mint[0] = 1;
        mint.set(key(9), 4); // a mint authority IS set
        const value = { owner: TOKEN_PROGRAM, lamports: 1, executable: false, data: [mint.toString("base64"), "base64"] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: body.method === "getAccountInfo" ? { value } : { value: [value, null] } }), { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }) as unknown as typeof fetch,
  });

  const slip = await readSplDoor(rpc, base58Encode(key(7)), CHAINS.solana, { deadlineMs: 1_200, marketDeadlineMs: 1_200 });
  assert.ok(slip.mint, "the mint was readable and the slip must carry it");
  assert.ok(slip.mint!.mintAuthority, "the finding the reader came for survives");
  // And the missing clock is disclosed rather than printed as slot zero.
  assert.ok(
    slip.skipped.some((s) => /slot/i.test(s.section)),
    `a reading with no clock has to say so: ${JSON.stringify(slip.skipped)}`,
  );
});

test("a failure names every endpoint that was tried, not just the last", async () => {
  // The message a real paste produced was "https://solana-rpc.publicnode.com
  // responded 403", which reads as "BOUNCER knows one node and it is
  // down" — when both nodes it knows had refused. Those call for
  // different next moves: wait and retry, or bring your own endpoint.
  const sol = new SolanaRpc({ urls: ["https://a.invalid", "https://b.invalid"], minSpacingMs: 0, retries: 0, fetchImpl: deny });
  await assert.rejects(
    () => sol.slot(),
    (e: Error) => {
      assert.match(e.message, /all 2 .*endpoints/i, `got "${e.message}"`);
      assert.ok(e.message.includes("a.invalid") && e.message.includes("b.invalid"), "both endpoints have to be named");
      assert.match(e.message, /403/, "and the reason must survive");
      return true;
    },
  );

  const evm = new RpcClient({ urls: ["https://c.invalid", "https://d.invalid"], expectedChainId: 1, fetchImpl: deny });
  await assert.rejects(
    () => evm.blockNumber(),
    (e: Error) => {
      assert.match(e.message, /all 2 endpoints/i, `got "${e.message}"`);
      assert.ok(e.message.includes("c.invalid") && e.message.includes("d.invalid"));
      return true;
    },
  );
});

test("a single-endpoint chain is not told it tried several", async () => {
  // The other direction: Arc mainnet has one endpoint, and "all 1
  // endpoints refused" would be a strange sentence dressed as a summary.
  const one = new SolanaRpc({ urls: ["https://only.invalid"], minSpacingMs: 0, retries: 0, fetchImpl: deny });
  await assert.rejects(
    () => one.slot(),
    (e: Error) => {
      assert.ok(!/all 1/i.test(e.message), `got "${e.message}"`);
      assert.match(e.message, /only\.invalid/);
      return true;
    },
  );
});

test("the terminal never claims every value was read when it was not", async () => {
  // Seen end to end in the CLI for the first time and it was wrong twice
  // over: no completeness state anywhere, and a footer reading "Every
  // value was read from Solana at the slot shown" printed over a reading
  // whose holders and pools had both been refused. The website had said
  // INCOMPLETE about the same slip for days.
  const { splReceipt } = await import("../src/bouncer/spl.js");
  const { renderReceipt } = await import("../src/receipt.js");
  const rpc = new SolanaRpc({
    urls: ["https://a.invalid"],
    minSpacingMs: 0,
    retries: 0,
    fetchImpl: (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      if (body.method === "getSlot") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 });
      if (body.method === "getBlockTime") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1_700_000_000 }), { status: 200 });
      if (body.method === "getAccountInfo" || body.method === "getMultipleAccounts") {
        const mint = Buffer.alloc(82);
        mint[45] = 1;
        const value = { owner: TOKEN_PROGRAM, lamports: 1, executable: false, data: [mint.toString("base64"), "base64"] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: body.method === "getAccountInfo" ? { value } : { value: [value, null] } }), { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }) as unknown as typeof fetch,
  });
  const slip = await readSplDoor(rpc, base58Encode(key(7)), CHAINS.solana, { deadlineMs: 1_200, marketDeadlineMs: 1_200 });
  const text = renderReceipt(splReceipt(slip), "text");

  assert.ok(!/Every value was read/i.test(text), "the footer must not claim a complete reading");
  assert.match(text, /INCOMPLETE CHECK/i, `the terminal has to carry the state the website carries:\n${text.slice(0, 600)}`);
  assert.match(text, /who holds it/i);
  assert.match(text, /where it trades/i);

  // And a reason a reader can act on, not an HTTP code on its own.
  assert.match(text, /refused the request \(403\)/i);

  // No nested-bracket wrapping: the client's message already explains
  // itself, and quoting it inside another explanation made two terminal
  // lines of brackets inside brackets.
  assert.ok(!/refused this read \(.*refused this read/i.test(text), "an error message was wrapped inside itself");
});
