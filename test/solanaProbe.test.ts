/**
 * Asking an endpoint what it serves.
 *
 * This module exists because of a wrong claim I published: that no free
 * endpoint serves getTokenLargestAccounts. It is served and it is throttled,
 * and those two have different fixes — wait or pay, versus use a different
 * endpoint. So the tests here are almost entirely about that distinction.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { probeEndpoint, probeInWords } from "../src/chain/solanaProbe.js";

/** A fetch that answers by method name, so each case can be aimed exactly. */
function fetchOf(answers: Record<string, { status?: number; body?: unknown }>, seen?: string[]): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const method = JSON.parse(String(init.body)).method as string;
    seen?.push(method);
    const answer = answers[method] ?? { body: { jsonrpc: "2.0", id: 1, result: {} } };
    return {
      status: answer.status ?? 200,
      ok: (answer.status ?? 200) < 400,
      json: async () => answer.body ?? { jsonrpc: "2.0", id: 1, result: {} },
    } as Response;
  }) as unknown as typeof fetch;
}

const verdictOf = (probes: Awaited<ReturnType<typeof probeEndpoint>>, method: string) => probes.find((p) => p.method === method)?.verdict;

test("a throttled method is throttled, not missing — the distinction the whole module is for", async () => {
  const probes = await probeEndpoint("https://example.invalid", {
    fetchImpl: fetchOf({ getTokenLargestAccounts: { status: 429 } }),
  });
  assert.equal(verdictOf(probes, "getTokenLargestAccounts"), "rate-limited");
  assert.equal(verdictOf(probes, "getAccountInfo"), "served");
  assert.match(probeInWords(probes), /a limit, not a missing feature/);
  assert.doesNotMatch(probeInWords(probes), /refused/, "nothing here was refused, and saying so would send the reader after the wrong fix");
});

test("a rate limit dressed as a JSON-RPC error is still a rate limit", async () => {
  // Several public endpoints answer 200 with an error body rather than a 429,
  // and reading that as "this endpoint does not support the method" is the
  // exact mistake this module was written after.
  const probes = await probeEndpoint("https://example.invalid", {
    fetchImpl: fetchOf({ getTokenLargestAccounts: { body: { error: { code: -32005, message: "Too many requests for a specific RPC call" } } } }),
  });
  assert.equal(verdictOf(probes, "getTokenLargestAccounts"), "rate-limited");
});

test("a method the endpoint will not serve at any rate is refused", async () => {
  const probes = await probeEndpoint("https://example.invalid", {
    fetchImpl: fetchOf({
      getTokenLargestAccounts: { body: { error: { code: -32601, message: "Method not found" } } },
      getSignaturesForAddress: { body: { error: { message: "This method is disabled on this endpoint" } } },
      getTokenAccountsByOwner: { status: 403 },
    }),
  });
  assert.equal(verdictOf(probes, "getTokenLargestAccounts"), "refused");
  assert.equal(verdictOf(probes, "getSignaturesForAddress"), "refused", "the prose form is what endpoints actually send");
  assert.equal(verdictOf(probes, "getTokenAccountsByOwner"), "refused");
  assert.match(probeInWords(probes), /will not serve them at any rate/);
});

test("an endpoint that does not reply is not an endpoint that refused", async () => {
  const probes = await probeEndpoint("https://example.invalid", {
    timeoutMs: 5,
    fetchImpl: (async () => {
      throw new Error("The operation was aborted");
    }) as unknown as typeof fetch,
  });
  assert.ok(probes.every((p) => p.verdict === "no answer"));
  assert.match(probes[0].detail, /no reply in 5 ms/);
});

test("the probes go one at a time, so a burst is not mistaken for a limit", async () => {
  // Firing all of them at once at a rate-limiting endpoint would measure the
  // burst and report methods it serves perfectly well as throttled.
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = (async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return { status: 200, ok: true, json: async () => ({ result: {} }) } as Response;
  }) as unknown as typeof fetch;
  await probeEndpoint("https://example.invalid", { fetchImpl });
  assert.equal(peak, 1);
});

test("every read BOUNCER makes is probed, and each says what it costs the slip", async () => {
  const seen: string[] = [];
  const probes = await probeEndpoint("https://example.invalid", { fetchImpl: fetchOf({}, seen) });
  for (const required of ["getSlot", "getAccountInfo", "getMultipleAccounts", "getTokenSupply", "getTokenLargestAccounts", "getTokenAccountsByOwner"]) {
    assert.ok(seen.includes(required), `${required} is a read BOUNCER makes and must be probed`);
  }
  assert.match(probeInWords(probes), /served all \d+ reads/);
});
