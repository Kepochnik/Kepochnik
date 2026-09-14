import assert from "node:assert/strict";
import { test } from "node:test";
import { confettiBlock, confettiFrames } from "../src/diploma/confetti.js";
import { SEAL, classOf, diplomaLine, diplomaReceipt, diplomaSvg, holderStub, type DiplomaFacts } from "../src/diploma/diploma.js";
import { GRADE_RULES, grade, progressBps } from "../src/diploma/grades.js";
import { buildYearbook, yearbookReceipt } from "../src/diploma/yearbook.js";
import { renderReceipt } from "../src/receipt.js";

const ETH = 10n ** 18n;

test("grades follow the documented thresholds", () => {
  const base = { graduationThreshold: 4n * ETH, sellableTokens: 1n, graduated: false, phase: 0 };
  assert.equal(grade({ ...base, realQuoteReserve: 0n }, null).grade, "FRESHMAN");
  assert.equal(grade({ ...base, realQuoteReserve: ETH }, null).grade, "SOPHOMORE");
  assert.equal(grade({ ...base, realQuoteReserve: 2n * ETH }, null).grade, "JUNIOR");
  assert.equal(grade({ ...base, realQuoteReserve: 3n * ETH }, null).grade, "SENIOR");
  assert.equal(grade({ ...base, realQuoteReserve: 3n * ETH, phase: 2 }, null).grade, "GRADUATED");
  assert.equal(grade({ ...base, realQuoteReserve: 4n * ETH, phase: 1 }, null).grade, "SWEPT");
  assert.equal(progressBps({ ...base, realQuoteReserve: 5n * ETH }), 10_000);
  assert.equal(progressBps({ ...base, realQuoteReserve: ETH, graduationThreshold: 0n }), 0);
});

test("eta is remaining over pace, dropout needs silence under half fill", () => {
  const facts = { realQuoteReserve: 2n * ETH, graduationThreshold: 4n * ETH, sellableTokens: 1n, graduated: false, phase: 0 };
  const hot = grade(facts, { netQuoteIn: ETH, buys: 10, sells: 2, windowSeconds: 3600, secondsSinceLastBuy: 60 });
  assert.equal(hot.grade, "JUNIOR");
  assert.equal(hot.paceQuotePerHour, ETH);
  assert.equal(hot.etaSeconds, 7200);
  const bleeding = grade(facts, { netQuoteIn: -ETH, buys: 1, sells: 5, windowSeconds: 3600, secondsSinceLastBuy: 60 });
  assert.equal(bleeding.etaSeconds, null);
  assert.match(bleeding.reason, /net outflow/);
  const dead = grade({ ...facts, realQuoteReserve: ETH }, { netQuoteIn: 0n, buys: 0, sells: 0, windowSeconds: 24 * 3600, secondsSinceLastBuy: null });
  assert.equal(dead.grade, "DROPOUT");
  const quietSenior = grade({ ...facts, realQuoteReserve: 3n * ETH }, { netQuoteIn: 0n, buys: 0, sells: 0, windowSeconds: 24 * 3600, secondsSinceLastBuy: GRADE_RULES.dropoutSilenceSeconds + 1 });
  assert.equal(quietSenior.grade, "SENIOR", "a senior never drops out on silence alone");
});

test("confetti is deterministic per block and fits the width", () => {
  const a = confettiFrames(31337, { width: 40, height: 5, frames: 8 });
  const b = confettiFrames(31337, { width: 40, height: 5, frames: 8 });
  const c = confettiFrames(31338, { width: 40, height: 5, frames: 8 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 8);
  for (const frame of a) for (const line of frame) assert.equal([...line].length, 40);
  assert.ok(a.some((frame) => frame.some((line) => line.trim().length > 0)), "some confetti falls");
  const block = confettiBlock(31337, "$DIPLOMA graduated", { width: 40, height: 6 });
  assert.match(block, /\$DIPLOMA graduated/);
});

const facts: DiplomaFacts = {
  name: "Diploma", symbol: "DIPLOMA", token: "0x78f13072b0f6ebc7fd0b5359c9b4e09c6160cff8", deployer: "0x2222222222222222222222222222222222222222",
  pairToken: "0x0000000000000000000000000000000000000000", pairSymbol: "ETH", pairDecimals: 18,
  graduationBlock: 31_337_421, graduationTimestamp: 1_789_430_400, sweepBlock: 31_337_420, launchBlock: 31_300_000, launchTimestamp: 1_789_426_800,
  quoteRaised: 42n * 10n ** 17n, tokensToPool: 2n * 10n ** 26n, tokenDecimals: 18, positionId: 7n, poolId: null, creatorTaxBps: 300n, buybackEnabled: true, observedAtBlock: 31_400_000,
  transcript: {
    launchBlock: 31_300_000, sweepBlock: 31_337_420, launchTimestamp: 1_789_426_800, sweepTimestamp: 1_789_430_400, secondsToGraduate: 3600,
    totalQuoteIn: 42n * 10n ** 17n, totalQuoteOut: 0n, buys: 41, sells: 0, buyers: 41, devQuoteIn: 42n * 10n ** 16n, devShareBps: 1000, firstMinuteQuoteIn: 21n * 10n ** 16n, firstMinuteShareBps: 500,
    roster: [{ ordinal: 1, address: "0x2222222222222222222222222222222222222222", quoteIn: 42n * 10n ** 16n, buys: 1, firstBlock: 31_300_003, isDeployer: true }, { ordinal: 2, address: "0x000000000000000000000000000000000000b001", quoteIn: 10n ** 17n, buys: 1, firstBlock: 31_300_050, isDeployer: false }],
    chunks: 1,
  },
};

test("diploma receipt, line and svg carry the block, the seal and the class", () => {
  const receipt = diplomaReceipt(facts);
  const text = renderReceipt(receipt, "text");
  assert.match(text, /DIPLOMA · \$DIPLOMA/);
  assert.match(text, /class of 2026-09-15/);
  assert.match(text, /31337421/);
  assert.match(text, /4\.2 ETH/);
  assert.match(text, /3600 s/);
  assert.match(text, /dev funded {8}10\.0%/);
  assert.match(text, /#1 0x2222…2222 \(dev\)/);
  assert.match(text, /H-O-O-D on a keypad/);
  assert.equal(SEAL, "chain 4663 · H-O-O-D on a keypad");
  assert.equal(classOf(facts.graduationTimestamp), "2026-09-15");
  assert.match(diplomaLine(facts), /^🎓 \$DIPLOMA · block 31337421 · raised 4\.2 ETH · graduated in 60 min · 41 buyers · dev funded 10% · 5% bought in the first minute/);
  const stub = renderReceipt(holderStub(facts, "0x000000000000000000000000000000000000B001"), "text");
  assert.match(stub, /buyer #2 of 41/);
  const stranger = renderReceipt(holderStub(facts, "0x00000000000000000000000000000000000000ff"), "text");
  assert.match(stranger, /not on the curve roster/);
  const svg = diplomaSvg(facts, { repoUrl: "github.com/x/cap", ticker: "$DIPLOMA" });
  assert.match(svg, /^<svg xmlns/);
  assert.match(svg, /\$DIPLOMA<\/text>/);
  assert.match(svg, /4663/);
  assert.match(svg, /github\.com\/x\/cap/);
  assert.equal(diplomaSvg(facts), diplomaSvg(facts), "svg is deterministic");
  const json = JSON.parse(renderReceipt(receipt, "json"));
  assert.equal(json.meta.block, 31_337_421);
});

test("yearbook counts launches, graduations and time-to-graduate", () => {
  const ledger = {
    fromBlock: 1000, toBlock: 37_000, chunks: 1, graduationsOutsideWindow: [{ token: "0xold", block: 1200 }],
    launches: [
      { token: "0xa", curve: "0x1", deployer: "0xd", pairToken: "0x0000000000000000000000000000000000000000", launchConfigId: 1n, graduationThreshold: 4n * ETH, launchedAt: { block: 1000, logIndex: 0, tx: "0x" }, graduatedAt: { block: 7000, positionId: 1n, tokenAmount: 1n, pairTokenAmount: 4n * ETH, poolId: null } },
      { token: "0xb", curve: "0x2", deployer: "0xd", pairToken: "0x0000000000000000000000000000000000000000", launchConfigId: 1n, graduationThreshold: 4n * ETH, launchedAt: { block: 2000, logIndex: 0, tx: "0x" } },
      { token: "0xc", curve: "0x3", deployer: "0xd", pairToken: "0xstock", launchConfigId: 2n, graduationThreshold: 100n, launchedAt: { block: 3000, logIndex: 0, tx: "0x" }, graduatedAt: { block: 27_000, positionId: 2n, tokenAmount: 1n, pairTokenAmount: 100n, poolId: null } },
      { token: "0xe", curve: "0x4", deployer: "0xd", pairToken: "0x0000000000000000000000000000000000000000", launchConfigId: 1n, graduationThreshold: 4n * ETH, launchedAt: { block: 4000, logIndex: 0, tx: "0x" } },
    ],
  };
  // 36,000 blocks over 3,600 s => 0.1 s/block
  const book = buildYearbook(ledger, 1_000_000, 1_003_600);
  assert.equal(book.launched, 4);
  assert.equal(book.graduatedWithinWindow, 2);
  assert.equal(book.graduated, 3);
  assert.equal(book.graduationRate, "50.0%");
  assert.equal(book.secondsPerBlock, 0.1);
  assert.equal(book.fastestSeconds, 600); // 6000 blocks * 0.1 s
  assert.equal(book.slowestSeconds, 2400); // 24000 blocks
  assert.equal(book.medianSecondsToGraduate, 2400);
  assert.equal(book.byQuote[0].launched, 3);
  assert.equal(book.topRaised[0].token, "0xa");
  const text = renderReceipt(yearbookReceipt(book, (p) => (p.endsWith("0000") ? "ETH" : "STOCK")), "text");
  assert.match(text, /graduation rate {2}50\.0%/);
  assert.match(text, /dropout rate {5}50\.0%/);
  assert.match(text, /ETH {4}3 launched · 1 graduated/);
});
