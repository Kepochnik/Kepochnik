import assert from "node:assert/strict";
import { test } from "node:test";
import { base58Encode } from "../src/chain/base58.js";
import { TOKEN_PROGRAM, SolanaRpc } from "../src/chain/solana.js";
import { readSplDoor } from "../src/bouncer/spl.js";
import { CHAINS } from "../src/chain/chains.js";
import { splCoverage, doorCoverage, qualify, plainReason, type Coverage } from "../src/bouncer/coverage.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_PLAIN, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";
import { readDoor } from "../src/bouncer/door.js";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { PONS_V2_FACTORY } from "../src/chain/pons.js";

const key = (byte: number) => new Uint8Array(32).fill(byte);

/** The demo chain, read for real through the recorded fixtures. */
const demoSlip = (token: string) =>
  readDoor(demoRpc(), token, {
    chain: CHAINS.robinhood,
    factory: PONS_V2_FACTORY,
    chunkSize: 100_000,
    launchSearchBlocks: 400_000,
    skipDev: true,
    blockscout: new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() }),
  });

/**
 * The audit's own case, reproduced: a mint that reads fine on a node that
 * refuses everything heavier with a 403. That is what a free Solana endpoint
 * does to getTokenLargestAccounts, and it is what happened to BONK.
 */
async function bonkOnARefusingNode() {
  const rpc = new SolanaRpc({
    urls: ["https://a.invalid"],
    minSpacingMs: 0,
    retries: 0,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      if (body.method === "getSlot") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 });
      if (body.method === "getBlockTime") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1_700_000_000 }), { status: 200 });
      if (body.method === "getAccountInfo" || body.method === "getMultipleAccounts") {
        const mint = Buffer.alloc(82);
        mint[45] = 1; // initialized, and no mint or freeze authority: nothing to flag
        const value = { owner: TOKEN_PROGRAM, lamports: 1, executable: false, data: [mint.toString("base64"), "base64"] };
        const result = body.method === "getAccountInfo" ? { value } : { value: [value, null] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
      }
      // Everything else — the holder list, the pools — is refused outright.
      return new Response("Forbidden", { status: 403 });
    }) as unknown as typeof fetch,
  });
  return readSplDoor(rpc, base58Encode(key(7)), CHAINS.solana, { deadlineMs: 1_500, marketDeadlineMs: 1_500 });
}

test("a token whose holders and pools were refused is never called CLEAR", async () => {
  const slip = await bonkOnARefusingNode();
  assert.ok(slip.mint, "the mint itself was readable");
  const cov = splCoverage(slip);

  // The bug, stated as an assertion: nothing loud was found, so the old page
  // said CLEAR — over a reading that never saw who holds it or where it
  // trades.
  assert.equal(cov.state, "thin", `holders and market both refused should be thin; got ${cov.state}: ${cov.line}`);
  assert.equal(qualify("clear", cov), "incomplete", "CLEAR is a claim about coverage and must not survive a decisive gap");

  // And the other direction, which matters just as much: a found danger is
  // still found. A gap must not launder a STOP into a softer word.
  assert.equal(qualify("stop", cov), "stop");
  assert.equal(qualify("watch", cov), "watch");
});

test("the gaps name the missing reads, in words, beside the question they belonged to", async () => {
  const slip = await bonkOnARefusingNode();
  const cov = splCoverage(slip);
  const holders = cov.gaps.find((c) => c.id === "holders");
  const market = cov.gaps.find((c) => c.id === "market");
  assert.ok(holders, `the holder list must be listed as a gap; got ${cov.gaps.map((g) => g.id).join(", ")}`);
  assert.ok(market, "the market read must be listed as a gap");
  assert.equal(holders!.topic, "room", "a missing holder list belongs under 'who is already inside'");
  assert.equal(market!.topic, "exit", "a missing market belongs under 'what would you actually get out'");
  assert.match(holders!.reason ?? "", /403|refused/i, "the reason has to survive to the reader");
  assert.ok(!/non-200|jsonrpc/i.test(holders!.reason ?? ""), `the reason must be in plain words; got ${holders!.reason}`);
  assert.ok(cov.retryable, "a 403 on a public node is exactly the case where pressing again can work");
});

test("a check nothing can ever fill does not offer a retry", () => {
  // Unsupported is not unread. Solana has no sale simulation, and a button
  // promising to try again for one teaches a reader the button is a lie.
  const cov: Coverage = splCoverage({
    chain: { key: "solana", name: "Solana", family: "solana" },
    at: { slot: 1, timestamp: 1 },
    subject: "x",
    stamp: "NOT A LAUNCH",
    mint: { supply: 1n, decimals: 9, mintAuthority: null, freezeAuthority: null, program: TOKEN_PROGRAM, extensions: [] } as never,
    whatItIs: null,
    metadata: { name: "T", symbol: "T" } as never,
    metadataInline: false,
    holders: { top: [], top10Bps: 0, distinctOwners: 0 },
    market: {} as never,
    notes: [],
    skipped: [],
  });
  assert.equal(cov.retryable, false, "there is nothing here a retry could fill");
  // And it does not open the band either. A limit of the tool is true of
  // every reading of every token, so a band that appeared for it would be
  // on screen always — and a warning that is always on screen is furniture
  // by the second visit, which is how the one that matters gets missed.
  assert.equal(cov.state, "complete", "this reading has no holes; what is missing is missing from the tool");
  assert.equal(qualify("clear", cov), "clear", "a standing limit is disclosed, not held against the token");
  assert.equal(cov.gaps.length, 0, "a tool limit is not a gap in the reading");
  const probe = cov.limits.find((c) => c.id === "sale-probe");
  assert.ok(probe, `the limit is still listed, just not as a failure: ${JSON.stringify(cov.limits)}`);
  assert.equal(probe!.state, "unsupported");
});

test("a complete reading says so, and says nothing about gaps it does not have", async () => {
  const cov = doorCoverage(await demoSlip(DEMO_PLAIN.token));
  assert.equal(cov.gaps.filter((g) => g.state === "unread").length, 0, `the demo slip is fully read; got ${JSON.stringify(cov.gaps)}`);
  assert.ok(cov.asked > 0 && cov.read > 0);
  assert.equal(qualify("clear", cov), "clear");
});

test("a question that does not apply is not printed as a failure", async () => {
  // "NOT A LAUNCH" was the audit's P1 complaint in another form: an absent
  // launch record on a chain with no launchpad reads as a defect of the
  // token. It is neither a finding nor a gap — it is a question that was
  // never on the table.
  const cov = doorCoverage(await demoSlip(DEMO_PLAIN.token));
  const launch = cov.checks.find((c) => c.id === "launch");
  assert.ok(launch, "the launch record is still listed, so a reader knows it was considered");
  assert.ok(launch!.state !== "unread", `an inapplicable launch record must not read as a failed check; got ${launch!.state}`);
  assert.ok(!cov.gaps.some((g) => g.id === "launch" && g.state === "unread"));
});

test("every decisive gap is one a reader could act on", async () => {
  // A guard against the easy mistake in the other direction: marking
  // everything decisive turns the incomplete state into permanent noise and
  // a reader stops seeing it. The deployer's history and the ticker search
  // are worth reporting and do not decide whether you can get out.
  for (const token of [DEMO_PLAIN.token, DEMO.tokens.fresh.token, DEMO.tokens.sprint.token]) {
    const cov = doorCoverage(await demoSlip(token));
    for (const c of cov.checks) {
      if (c.id === "dev" || c.id === "lookalikes" || c.id === "launch") {
        assert.equal(c.decisive, false, `${c.id} must not be able to blank the verdict`);
      }
    }
  }
});

test("a refusal is translated once, in the core, so every surface says it the same way", () => {
  assert.match(plainReason("Non-200 response: 403"), /refused/i);
  assert.match(plainReason("Non-200 response: 429"), /rate.?limit/i);
  assert.match(plainReason("holders: timed out after 15000 ms"), /in time/i);
  assert.match(plainReason("Method not found (-32601)"), /does not offer/i);
  // Anything unrecognised survives verbatim rather than being flattened into
  // a vague phrase that hides what actually happened.
  assert.equal(plainReason("the pool contract answered with garbage"), "the pool contract answered with garbage");
});

test("a refused pool search is not the same answer as a token nobody trades", async () => {
  // The subtlest half of the audit's finding, and the one that survived the
  // first fix. The market section did not throw — it RETURNED, with an empty
  // pool list, because every read it needed came back 403. An empty pool
  // list renders as "no venue turned up", which is a statement about the
  // token, delivered in the same calm voice as a real one.
  const slip = await bonkOnARefusingNode();
  assert.ok(slip.market, "the section returned rather than throwing — that is the trap");
  assert.ok(slip.market!.unread, "and it has to admit the search never ran");
  assert.equal(slip.market!.pools.length, 0, "the empty list is still empty; what changed is that it no longer means anything");

  const cov = splCoverage(slip);
  const market = cov.checks.find((c) => c.id === "market");
  assert.equal(market!.state, "unread", "an empty list from a search that could not run is not a read");
  assert.match(market!.reason ?? "", /refused|403/i);
});

test("a transfer to the pool is never reported as a proven sale", async () => {
  // The audit's code-level note. A sale goes out through a router, which
  // pulls the tokens with transferFrom and then calls the pool's swap. The
  // probe sends one unit straight to the pool's address — the first step,
  // and the step traps break, but a token can allow it and still revert on
  // the router path. Claiming the one proves the other is the single
  // costliest thing this tool could get wrong, because the reader acts on
  // it with their own money.
  const slip = await demoSlip(DEMO_PLAIN.token);
  const cov = doorCoverage(slip);
  const probe = cov.checks.find((c) => c.id === "sale-probe");
  assert.equal(probe?.label, "a simulated transfer", "the check is named for what it does");

  const route = cov.limits.find((c) => c.id === "swap-route");
  assert.ok(route, `the router path must be disclosed as unsupported: ${JSON.stringify(cov.limits)}`);
  assert.match(route!.reason ?? "", /state override|router/i, "and it must say why, so a reader can go and check it elsewhere");

  for (const note of slip.notes) {
    if (note.code !== "sell-ok") continue;
    assert.match(note.text, /NOT a proven sale/, "the passing case is where the overclaim lives");
    assert.match(note.text, /router/, "and it has to name what was not simulated");
  }
});

test("an ordinary token's market and holders are read from the open door, not the launch fields", async () => {
  // Found by the "why this verdict" panel, which is the whole reason it
  // exists. `exit` and `room` are the launchpad's own curve and buyer
  // list, and both are null for every token a launchpad did not make. So
  // an ordinary token reported "where it trades" and "who holds it" as
  // questions that DO NOT APPLY — printed as N/A next to a tile reading
  // "explorer not reachable", which is the exact confusion between "we
  // did not look" and "there is nothing to look at" that this module was
  // written to stop.
  const slip = await demoSlip(DEMO_PLAIN.token);
  assert.equal(slip.exit, null, "the fixture has to be an ordinary token for this to mean anything");
  const cov = doorCoverage(slip);
  for (const id of ["market", "holders"]) {
    const c = cov.checks.find((x) => x.id === id);
    assert.ok(c, `${id} is missing from the coverage`);
    assert.notEqual(c!.state, "n/a", `${id} reads as inapplicable on a token that certainly has one`);
  }

  // And with the open door itself missing, they are unread rather than
  // silently fine — the other direction of the same mistake.
  const blind = { ...slip, exit: null, room: null, open: { ...slip.open!, pools: null, holders: null } } as typeof slip;
  const blindCov = doorCoverage(blind);
  for (const id of ["market", "holders"]) {
    const c = blindCov.checks.find((x) => x.id === id);
    assert.equal(c!.state, "unread", `${id} must be unread when nothing could read it`);
    assert.ok(c!.reason, `${id} must say why`);
  }
  assert.equal(blindCov.state, "thin", "two decisive checks unread is a thin reading");
});
