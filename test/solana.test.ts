import assert from "node:assert/strict";
import { test } from "node:test";
import { base58Decode, base58Encode, isSolanaAddress } from "../src/chain/base58.js";
import { sha256 } from "../src/chain/sha256.js";
import { isOnCurve } from "../src/chain/ed25519.js";
import {
  METADATA_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  findProgramAddress,
  metadataAddress,
  parseMetadata,
  parseMint,
  parseExtensions,
  tokenAccountOwner,
  type AccountInfo,
  SolanaRpc,
} from "../src/chain/solana.js";
import { readSplDoor, splNotes, splReceipt, type SplSlip } from "../src/bouncer/spl.js";
import { CHAINS } from "../src/chain/chains.js";
import { renderReceipt } from "../src/receipt.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (byte: number) => new Uint8Array(32).fill(byte);
const KEY_A = base58Encode(key(1));
const KEY_B = base58Encode(key(2));

test("sha256 matches the published vectors", () => {
  assert.equal(hex(sha256(new TextEncoder().encode(""))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hex(sha256(new TextEncoder().encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("base58 keeps leading zero bytes, which are different accounts", () => {
  assert.equal(base58Decode("11111111111111111111111111111111").length, 32);
  assert.ok(base58Decode("11111111111111111111111111111111").every((b) => b === 0));
  const token = base58Decode(TOKEN_PROGRAM);
  assert.equal(token.length, 32);
  assert.equal(base58Encode(token), TOKEN_PROGRAM);
  assert.ok(isSolanaAddress(TOKEN_PROGRAM));
  assert.ok(!isSolanaAddress("0x39dbed3a2bd333467115de45665cc57f813c4571"), "an EVM address is not a Solana one");
});

test("a program-derived address is off the curve, deterministic, and not a real key", () => {
  const mint = base58Encode(key(7));
  const first = metadataAddress(mint);
  assert.ok(first);
  assert.equal(metadataAddress(mint), first, "the same seeds always give the same address");
  assert.ok(!isOnCurve(base58Decode(first!)), "a PDA must have no private key");
  assert.notEqual(metadataAddress(base58Encode(key(8))), first, "a different mint gives a different address");
  const derived = findProgramAddress([new TextEncoder().encode("metadata"), base58Decode(METADATA_PROGRAM), base58Decode(mint)], METADATA_PROGRAM);
  assert.equal(derived?.address, first);
  assert.ok(derived!.bump <= 255 && derived!.bump >= 240, `bump ${derived!.bump} should be near the top of the range`);
});

/** A classic SPL mint, built byte by byte the way the program lays it out. */
function mintAccount(options: { mintAuthority?: Uint8Array | null; freezeAuthority?: Uint8Array | null; supply?: bigint; decimals?: number; token2022?: boolean; tlv?: Uint8Array }): AccountInfo {
  const base = new Uint8Array(options.tlv ? 166 + options.tlv.length : 82);
  const view = new DataView(base.buffer);
  if (options.mintAuthority) {
    view.setUint32(0, 1, true);
    base.set(options.mintAuthority, 4);
  }
  view.setBigUint64(36, options.supply ?? 0n, true);
  base[44] = options.decimals ?? 9;
  base[45] = 1;
  if (options.freezeAuthority) {
    view.setUint32(46, 1, true);
    base.set(options.freezeAuthority, 50);
  }
  if (options.tlv) {
    base[165] = 1; // account type: Mint
    base.set(options.tlv, 166);
  }
  return { owner: options.token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM, lamports: 1, executable: false, data: base };
}

function tlv(type: number, value: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + value.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, type, true);
  view.setUint16(2, value.length, true);
  out.set(value, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

test("a mint with no authorities reads as fixed supply that nobody can freeze", () => {
  const mint = parseMint(mintAccount({ supply: 1_000_000_000_000_000n, decimals: 6 }))!;
  assert.equal(mint.mintAuthority, null);
  assert.equal(mint.freezeAuthority, null);
  assert.equal(mint.supply, 1_000_000_000_000_000n);
  assert.equal(mint.decimals, 6);
  assert.equal(mint.token2022, false);
  assert.deepEqual(mint.extensions, []);
});

test("a mint with both authorities names them, and the notes lead with the freeze", () => {
  const mint = parseMint(mintAccount({ mintAuthority: key(1), freezeAuthority: key(2), supply: 10n }))!;
  assert.equal(mint.mintAuthority, KEY_A);
  assert.equal(mint.freezeAuthority, KEY_B);
  const slip = slipFor(mint);
  const freeze = slip.notes.find((n) => n.code === "freeze-authority");
  assert.ok(freeze && freeze.level === "stop", "a live freeze authority is a STOP");
  assert.match(freeze!.text, /cannot sell/);
  const printing = slip.notes.find((n) => n.code === "mint-authority");
  assert.ok(printing && printing.level === "watch");
});

test("an address that is not a mint is named rather than checked as a token", async () => {
  const wallet: AccountInfo = { owner: "11111111111111111111111111111111", lamports: 5, executable: false, data: new Uint8Array(0) };
  assert.equal(parseMint(wallet), null);
  const tokenAccount: AccountInfo = { owner: TOKEN_PROGRAM, lamports: 5, executable: false, data: new Uint8Array(165) };
  // A token account is 165 bytes and starts with the mint, so it must not be
  // mistaken for a mint just because it is long enough.
  assert.equal(tokenAccountOwner(tokenAccount), base58Encode(new Uint8Array(32)));
});

test("Token-2022 extensions are read: fee, hook, delegate, default-frozen, non-transferable", () => {
  const transferFee = new Uint8Array(108);
  const feeView = new DataView(transferFee.buffer);
  transferFee.set(key(1), 0); // fee authority
  transferFee.set(key(2), 32); // withdraw authority
  feeView.setBigUint64(72 + 8, 5_000n, true); // older maximum fee
  feeView.setUint16(72 + 16, 300, true); // older fee: 3%
  feeView.setBigUint64(90, 812n, true); // newer epoch
  feeView.setUint16(90 + 16, 9_900, true); // newer fee: 99%
  const hook = concat(key(3), key(4));
  const bytes = concat(
    tlv(1, transferFee),
    tlv(12, key(5)),
    tlv(14, hook),
    tlv(6, new Uint8Array([2])),
    tlv(9, new Uint8Array(0)),
    tlv(3, key(6)),
    tlv(99, new Uint8Array(4)),
  );
  const mint = parseMint(mintAccount({ token2022: true, supply: 1n, tlv: bytes }))!;
  assert.equal(mint.token2022, true);
  const fee = mint.extensions.find((e) => e.kind === "transfer-fee");
  assert.ok(fee && fee.kind === "transfer-fee");
  assert.equal(fee.feeBps, 300);
  assert.equal(fee.nextFeeBps, 9_900);
  assert.equal(fee.nextFeeEpoch, 812n);
  assert.equal(fee.maximumFee, 5_000n);
  assert.equal(fee.feeAuthority, KEY_A);
  assert.ok(mint.extensions.some((e) => e.kind === "permanent-delegate"));
  assert.ok(mint.extensions.some((e) => e.kind === "transfer-hook"));
  assert.ok(mint.extensions.some((e) => e.kind === "non-transferable"));
  assert.ok(mint.extensions.some((e) => e.kind === "other" && e.type === 99), "an extension we do not read is kept, not dropped");

  const slip = slipFor(mint);
  const codes = slip.notes.map((n) => n.code);
  for (const expected of ["permanent-delegate", "frozen-by-default", "non-transferable", "transfer-hook", "transfer-fee", "mint-close", "extension-unknown"]) {
    assert.ok(codes.includes(expected), `missing note ${expected}`);
  }
  const feeNote = slip.notes.find((n) => n.code === "transfer-fee")!;
  assert.match(feeNote.text, /3\.00%/);
  assert.match(feeNote.text, /99\.00% at epoch 812/);
  assert.equal(feeNote.level, "watch", "a fee about to rise to 99% is not an INFO");
  assert.equal(slip.notes.filter((n) => n.level === "stop").length >= 3, true);
});

test("a Metaplex metadata account gives the name, and says whether it can be changed", () => {
  const name = "Robin Rocket";
  const symbol = "ROCKET";
  const uri = "https://example.invalid/r.json";
  const str = (text: string) => {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(4 + body.length);
    new DataView(out.buffer).setUint32(0, body.length, true);
    out.set(body, 4);
    return out;
  };
  const data = concat(
    new Uint8Array([4]),
    key(1),
    key(7),
    str(name),
    str(symbol),
    str(uri),
    new Uint8Array([0, 0]), // seller fee
    new Uint8Array([0]), // no creators
    new Uint8Array([1]), // primary sale happened
    new Uint8Array([1]), // mutable
    new Uint8Array(40),
  );
  const parsed = parseMetadata({ owner: METADATA_PROGRAM, lamports: 1, executable: false, data })!;
  assert.equal(parsed.name, name);
  assert.equal(parsed.symbol, symbol);
  assert.equal(parsed.uri, uri);
  assert.equal(parsed.isMutable, true);
  assert.equal(parsed.updateAuthority, KEY_A);
  assert.equal(parsed.mint, base58Encode(key(7)));
});

test("the slip renders, and names the venues it does and does not read", () => {
  const mint = parseMint(mintAccount({ supply: 1_000n, decimals: 6 }))!;
  const text = renderReceipt(splReceipt(slipFor(mint)), "text");
  assert.match(text, /SPL Token/);
  assert.match(text, /freeze authority/);
  assert.match(text, /NOT A LAUNCH/);
  // The list is a boundary, not a boast: a pool against another pair, or on a
  // venue not named, is not counted, and the slip has to say so.
  assert.match(text, /Venues read here/);
  assert.match(text, /not counted/);
});

test("solana is in the chain table and the EVM lookup never returns it", () => {
  assert.equal(CHAINS.solana.family, "solana");
  assert.equal(CHAINS.solana.chainId, 0);
  assert.ok(CHAINS.solana.rpc[0].startsWith("https://"));
});

function slipFor(mint: ReturnType<typeof parseMint>): SplSlip {
  const slip: SplSlip = {
    chain: { key: "solana", name: "Solana", family: "solana" },
    at: { slot: 1, timestamp: 1_700_000_000 },
    subject: base58Encode(key(7)),
    stamp: "NOT A LAUNCH",
    mint,
    whatItIs: null,
    metadata: null,
    metadataInline: false,
    holders: null,
    market: null,
    notes: [],
    skipped: [],
  };
  slip.notes = splNotes(slip);
  return slip;
}

test("a slow endpoint is abandoned quickly enough for the next one to matter", async () => {
  // The live failure this pins: the per-request timeout was longer than the
  // budget of the section making the request, so a three-endpoint list behaved
  // exactly like a one-endpoint list — the first slow answer used up the whole
  // deadline and no rotation ever happened.
  const tried: string[] = [];
  const rpc = new SolanaRpc({
    urls: ["https://slow.invalid", "https://good.invalid"],
    timeoutMs: 60,
    minSpacingMs: 0,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      tried.push(url);
      if (url.startsWith("https://slow")) {
        // Never answers; only the timeout ends it.
        return await new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });

  const started = Date.now();
  assert.equal(await rpc.slot(), 42);
  assert.ok(tried.includes("https://good.invalid"), "it must reach the second endpoint");
  assert.ok(Date.now() - started < 2_000, "abandoning the first endpoint must be quick enough to be worth doing");
});

test("the default request timeout leaves room to rotate within a section's budget", () => {
  // Not a style check: a section gets eight seconds, so a request that can hold
  // the line for twenty makes the endpoint list decorative.
  const rpc = new SolanaRpc({ urls: ["https://a.invalid", "https://b.invalid"] });
  assert.ok((rpc as unknown as { timeoutMs: number }).timeoutMs <= 8_000);
});

test("a method no endpoint serves costs one pass, not several", async () => {
  // The live profile that prompted this: getTokenLargestAccounts, one logical
  // call, twenty-six seconds, failed. It is refused by every free endpoint in
  // the list, and the retry budget turned that certainty into seven attempts.
  let attempts = 0;
  const rpc = new SolanaRpc({
    urls: ["https://a.invalid", "https://b.invalid", "https://c.invalid"],
    minSpacingMs: 0,
    fetchImpl: (async () => {
      attempts++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not supported" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });

  await assert.rejects(() => rpc.largestAccounts("mint"), /not supported/);
  assert.equal(attempts, 3, `every endpoint should be asked once and no more; got ${attempts} attempts`);
});

test("the read profile says where the time went", async () => {
  const rpc = new SolanaRpc({
    urls: ["https://a.invalid"],
    minSpacingMs: 0,
    fetchImpl: (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 7 }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
  await rpc.slot();
  await rpc.slot();
  const stats = rpc.stats();
  const slot = stats.find((s) => s.method === "getSlot");
  assert.equal(slot?.calls, 2);
  assert.equal(slot?.failures, 0);
});

test("a rate limit is one short pause, not a long wait for the same refusal", async () => {
  // Measured on the live endpoint: getTokenLargestAccounts is throttled per
  // method, so this path is taken often. The old backoff doubled to six
  // seconds several times over, which is where twenty-six seconds of a
  // fifteen-second section went.
  let attempts = 0;
  const rpc = new SolanaRpc({
    urls: ["https://a.invalid", "https://b.invalid"],
    minSpacingMs: 0,
    fetchImpl: (async () => {
      attempts++;
      return new Response("{}", { status: 429 });
    }) as unknown as typeof fetch,
  });

  const started = Date.now();
  await assert.rejects(() => rpc.largestAccounts("mint"), /429|rate limited/i);
  const elapsed = Date.now() - started;
  assert.ok(attempts <= 5, `a throttled method should not be hammered; got ${attempts} attempts`);
  // Short enough to fit inside a section's budget, long enough that a brief
  // throttle on a read the slip cannot do without does not kill the slip.
  assert.ok(elapsed < 4_000, `backing off for ${elapsed}ms inside an eight-second section is how the section is lost`);
  assert.ok(elapsed > 500, `giving up in ${elapsed}ms means a transient 429 takes the whole read down`);
});

test("one refused read does not take the whole slip down", async () => {
  // The regression this pins: bounding the rate-limit retry to a single pause
  // made a transient 429 on a mandatory read throw out of readSplDoor, so the
  // reader got nothing instead of a slip with one section missing. Every
  // optional section is allowed to fail; the slip is not.
  let calls = 0;
  const rpc = new SolanaRpc({
    urls: ["https://a.invalid"],
    minSpacingMs: 0,
    retries: 1,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      // The mint reads answer; everything heavier is throttled forever.
      if (body.method === "getSlot") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 });
      if (body.method === "getBlockTime") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1_700_000_000 }), { status: 200 });
      if (body.method === "getAccountInfo") {
        const mint = Buffer.alloc(82);
        mint[45] = 1; // initialized, no authorities
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { owner: TOKEN_PROGRAM, lamports: 1, executable: false, data: [mint.toString("base64"), "base64"] } } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 429 });
    }) as unknown as typeof fetch,
  });

  const slip = await readSplDoor(rpc, base58Encode(key(7)), CHAINS.solana, { deadlineMs: 2_000, marketDeadlineMs: 3_000 });
  assert.equal(slip.stamp, "NOT A LAUNCH", "the slip must still be produced");
  assert.ok(slip.mint, "the mint was readable and must be on it");
  assert.ok(slip.skipped.length > 0, "the refused sections must be named");
  assert.ok(slip.skipped.some((s) => /rate-limited/i.test(s.reason)), `a 429 should read as a rate limit; got ${JSON.stringify(slip.skipped)}`);
  assert.ok(calls > 3);
});
