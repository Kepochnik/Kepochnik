import assert from "node:assert/strict";
import { test } from "node:test";
import { chunksFor, handleCommand } from "../src/bot/telegram.js";
import { CHAINS } from "../src/chain/chains.js";
import { BlockscoutClient } from "../src/chain/blockscout.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_PLAIN, demoBlockscoutFetch, demoRpc } from "../src/bouncer/demo.js";

/**
 * The bot had no tests at all. Everything below was found by running its
 * commands rather than by reading them.
 */
const options = {
  token: "test",
  demo: true,
  rpcFor: () => demoRpc(),
  blockscoutFor: () => new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() }),
  factoryFor: (chain: (typeof CHAINS)[string]) => chain.factory,
} as never;

const ask = (text: string) => handleCommand(text, CHAINS.robinhood, () => {}, options, { chatId: 1, watches: [] });

test("a reply is split on line boundaries, never through one", () => {
  // Telegram's hard limit is 4096 and a door slip is about ten thousand,
  // so a reply has to be split. It used to split on character count
  // alone, which cut a 124-column box drawing mid-row: one message ended
  // "…LETE CHECK" and the next began with the rest of that line, each in
  // its own code fence. Three messages of broken table for the bot's
  // main command.
  const lines = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(4, "0")} ${"x".repeat(100)}`);
  const text = lines.join("\n");
  const chunks = chunksFor(text);
  assert.ok(chunks.length > 1, "this fixture is meant to need splitting");
  for (const c of chunks) assert.ok(c.length <= 3_800, `a chunk is ${c.length} characters, over what Telegram takes`);
  // Rejoined, it is the original: nothing lost, nothing cut.
  assert.equal(chunks.join("\n"), text);
  // And every chunk is whole lines.
  for (const c of chunks) for (const line of c.split("\n")) assert.ok(lines.includes(line), `a chunk contains a partial line: ${JSON.stringify(line.slice(0, 40))}`);
});

test("a line too long to fit is wrapped rather than dropped", () => {
  const long = "y".repeat(9_000);
  const chunks = chunksFor(long);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.join(""), long, "no character may be lost");
});

test("content can never close the code fence it is wrapped in", () => {
  // A token can be named anything. A fence inside the content would end
  // the one the bot wraps each chunk in and let Telegram interpret the
  // rest of a slip as markup.
  const chunks = chunksFor("safe line\n```\nrm -rf /\n```\nmore");
  assert.ok(!chunks.join("\n").includes("```"), "a code fence survived into a message");
  assert.match(chunks.join("\n"), /rm -rf/, "and the content itself is still there");
});

test("every command answers, and an unknown one stays quiet", async () => {
  for (const [text, expect] of [
    ["/start", /BOUNCER/i],
    ["/help", /BOUNCER/i],
    ["/chain", /robinhood/i],
    ["/door", /usage/i],
    ["/dev", /usage/i],
    ["/exit", /usage/i],
    ["/watches", /.+/],
  ] as [string, RegExp][]) {
    const reply = await ask(text);
    assert.ok(typeof reply === "string" && reply.length, `${text} answered with nothing`);
    assert.match(reply, expect, `${text} answered "${String(reply).slice(0, 60)}"`);
  }
  // Chatter in a group must not make the bot talk.
  for (const quiet of ["hello", "", "gm", "/nosuchcommand"]) {
    assert.equal(await ask(quiet), null, `"${quiet}" should have been ignored`);
  }
});

test("a real slip comes back whole, and fits in messages Telegram takes", async () => {
  const reply = await ask(`/door ${DEMO_PLAIN.token}`);
  assert.ok(typeof reply === "string");
  assert.match(reply!, /BOUNCER/);
  assert.ok(reply!.length > 1_000, "a door slip should be substantial");
  for (const c of chunksFor(reply!)) assert.ok(c.length <= 3_800);
});

test("a bad address is answered, not thrown into the void", async () => {
  // runBot catches a throw and replies with its message, so these are
  // answered either way — but the reply has to say something a reader can
  // act on rather than a stack-trace phrase.
  for (const bad of ["/door notanaddress", "/dev 0x123", "/chain nosuchchain"]) {
    let said: string | null | undefined;
    try {
      said = await ask(bad);
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    assert.ok(said && said.length > 8, `"${bad}" produced nothing a user could read`);
    assert.ok(!/\bundefined\b|\[object/.test(said), `"${bad}" answered with debris: ${said}`);
  }
});

test("the command name is read the way people actually type it", async () => {
  // In a group chat Telegram appends the bot's name, and people shout.
  for (const text of [`/door@BouncerBot ${DEMO.tokens.fresh.token}`, `/DOOR ${DEMO.tokens.fresh.token}`]) {
    const reply = await ask(text);
    assert.ok(typeof reply === "string" && /BOUNCER/.test(reply), `${text} was not understood`);
  }
});

test("what the bot actually sends is split on lines, not just what a helper could split", async () => {
  // The first version of these tests called chunksFor() directly and
  // passed happily while send() went on using the old character splitter
  // — the helper was correct and unused. What matters is the bytes that
  // leave for Telegram, so this drives the real bot and reads them.
  const { runBot } = await import("../src/bot/telegram.js");
  const sent: string[] = [];
  let polls = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("getUpdates")) {
      polls++;
      // One message on the first poll, nothing afterwards.
      const result = polls === 1 ? [{ update_id: 1, message: { chat: { id: 7 }, text: `/door ${DEMO_PLAIN.token}` } }] : [];
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }
    if (u.includes("sendMessage")) {
      sent.push(JSON.parse(String(init?.body ?? "{}")).text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await runBot({ ...(options as object), fetchImpl, maxPolls: 2, pollTimeoutSeconds: 0, log: () => {} } as never);

  assert.ok(sent.length > 1, `a door slip is longer than Telegram takes and should have been split; got ${sent.length} message(s)`);
  for (const message of sent) {
    assert.ok(message.length <= 4_096, `a message of ${message.length} characters would be refused by Telegram`);
    // Each one is a whole fenced block with whole lines inside it.
    const body = message.replace(/^```\n?/, "").replace(/\n?```$/, "");
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      // A box drawing that was cut mid-row leaves a line with an opening
      // edge and no closing one. That is exactly what the old splitter did.
      if (line.startsWith("│")) assert.ok(line.endsWith("│"), `a box row was cut in half: ${JSON.stringify(line.slice(-40))}`);
      if (line.startsWith("┌") || line.startsWith("├") || line.startsWith("└")) {
        assert.match(line, /[┐┤┘]$/, `a box rule was cut in half: ${JSON.stringify(line.slice(-40))}`);
      }
    }
  }
});

/**
 * `/watch` called the factory and let NotAPonsLaunch escape, so the bot
 * could watch launchpad tokens and nothing else — and the website now tells
 * people to come here for exactly the token it could not watch.
 */
test("/watch follows an ordinary token, and says what it will be blind to", async () => {
  const watches: Parameters<typeof handleCommand>[4] = { chatId: 1, watches: [] };
  const reply = await handleCommand(`/watch ${DEMO_PLAIN.token}`, CHAINS.robinhood, () => {}, options, watches);
  assert.ok(typeof reply === "string", "an ordinary token got no answer at all");
  assert.match(reply!, /watching/i);
  assert.match(reply!, /no launchpad made this token/i, `the reply does not say what it cannot report: ${reply}`);
  assert.equal(watches.watches.length, 1, "the watch was announced but not registered");
  const w = watches.watches[0];
  assert.equal(w.launch, null, "an ordinary token must not carry a launch record");
  assert.ok(w.tape, "a tape watch with no tape inputs reads nothing");
  assert.ok(w.tape!.supply > 0n, "the share-of-supply column needs the supply");
  assert.ok(w.tape!.pools.length, "the pool was readable, so a sale should be tellable from a move");
  assert.equal(w.symbol, DEMO_PLAIN.symbol);
});

test("a tape watch survives a restart with its supply still a number", async () => {
  // The state file is JSON and a bigint is not, so the supply goes out as
  // "1000…n". A restart that read it back as that string would compare a
  // string against a bigint on the first tick and throw.
  const { tickWatches } = await import("../src/bot/telegram.js");
  const watches: Parameters<typeof handleCommand>[4] = { chatId: 1, watches: [] };
  await handleCommand(`/watch ${DEMO_PLAIN.token}`, CHAINS.robinhood, () => {}, options, watches);
  const wire = JSON.parse(JSON.stringify(watches.watches, (_k, v: unknown) => (typeof v === "bigint" ? `${v.toString()}n` : v))) as unknown[];
  assert.match(String((wire[0] as { tape: { supply: string } }).tape.supply), /n$/, "the fixture is meant to go out as a bigint marker");

  // And a tick over a live-looking window does not throw.
  const back = { ...watches.watches[0], cursor: 0 };
  const logs: string[] = [];
  await tickWatches([back], options, async () => {}, (line) => logs.push(line));
  assert.deepEqual(logs, [], `a tick on a tape watch failed: ${logs.join(" | ")}`);
});
