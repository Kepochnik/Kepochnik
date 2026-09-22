/**
 * BOUNCER in the browser. Same read path as the CLI (bundled by esbuild),
 * a fake fetch for demo mode, a chain selector, and a hash route per view
 * so anything can be linked:
 *   #/t/0x…            the slip (live)        #/demo/0x…         the slip (demo chain)
 *   #/dev/0x…          dev report card        #/wallet/0xT/0xW   a position
 *   #/tx/0x…           a trade receipt        #/plan             the launch planner
 * Add ?chain=arc-testnet to any live route.
 */
import { BlockscoutClient } from "../../src/chain/blockscout.js";
import { TOPIC_TAG,TOPIC_BLURB, TOPIC_ORDER, TOPIC_QUESTION, topicOf } from "../../src/bouncer/topics.js";
import { doorCoverage, splCoverage, qualify, type Coverage } from "../../src/bouncer/coverage.js";
import { missingVenues, tradeVenues } from "../../src/bouncer/trade.js";
import { CHAINS, chainByKey, type ChainConfig } from "../../src/chain/chains.js";
import { PHASE_LABEL } from "../../src/chain/pons.js";
import { PonsReader } from "../../src/chain/reader.js";
import { RpcClient, type BlockHeader } from "../../src/chain/rpc.js";
import { SolanaRpc } from "../../src/chain/solana.js";
import { isSolanaAddress } from "../../src/chain/base58.js";
import { addressFamily, readChainSearch, searchTicker, searchableChains, whichChains, type ChainSearch } from "../../src/chain/whichChain.js";
import { readSplDoor, type SplSlip } from "../../src/bouncer/spl.js";
import { findBlockByTimestamp } from "../../src/chain/tape.js";
import { doorCard, splCard } from "../../src/bouncer/card.js";
import { coverChargeLine } from "../../src/bouncer/coverCharge.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_IMPOSTOR, DEMO_PLAIN, DEMO_V1, demoBlockscoutFetch, demoRpc } from "../../src/bouncer/demo.js";
import { devReportLine, readDevReport, type DevReport } from "../../src/bouncer/devReport.js";
import { findLaunchBlock, impostorOf, readDoor, slipJson, type DoorNote, type DoorSlip } from "../../src/bouncer/door.js";
import { lookalikeLine, registeredLookalikes } from "../../src/bouncer/lookalike.js";
import { MASCOT_SVG_INNER } from "../../src/bouncer/mascot.js";
import { oneCrewLine } from "../../src/bouncer/oneCrew.js";
import { moveProbes, POWER_MEANING, powerKinds, sellProbes } from "../../src/bouncer/openDoor.js";
import { readLaunchPlan, type LaunchPlan } from "../../src/bouncer/planner.js";
import { readPosition, type Position } from "../../src/bouncer/position.js";
import { roomLine } from "../../src/bouncer/room.js";
import { readBoard, type Board } from "../../src/bouncer/leaderboard.js";
import { readWatchEvents, type WatchEvent } from "../../src/bouncer/watch.js";
import { readTradeReceipt, type TradeReceipt } from "../../src/bouncer/txReceipt.js";
import { formatBps, formatDuration, formatUnits, isoUtc, shortAddress } from "../../src/format.js";

type Mode = "demo" | "live";
type View = "door" | "dev" | "wallet" | "tx" | "plan" | "board";
type Level = "stop" | "watch" | "info";
const LEVEL_WORD: Record<Level, string> = { stop: "Stop", watch: "Careful", info: "Note" };
const REPO = "github.com/Kepochnik/bouncer";
const MARK = "$BOUNCER";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
/** The claude.ai preview sandbox blocks every network request a page makes; live mode cannot work there. */
/**
 * The demo is gone from the interface.
 *
 * Not from the codebase: `#/demo/…` still routes, because every offline
 * check in this repo reads the demo chain through it — the three renders,
 * the journeys, the whole layout pass run with no network at all, and
 * deleting the route would mean the only way to test the page is against
 * a live chain from a runner. What IS gone is every way to reach it from
 * the page: the demo/live toggle, the "you are looking at an invented
 * example chain" strip, and the demo token the page used to open on.
 *
 * A reader arrives on a live chain and stays there.
 */
const SANDBOXED = /(^|\.)claude\.ai$|claudeusercontent|anthropic/.test(location.hostname);
const HOSTED = "https://kepochnik.github.io/bouncer/";
/** Set this to your deployed bouncer-proxy URL to make it the default for everyone who opens the site. */
const DEFAULT_PROXY = "https://bouncer-proxy.tarasenkosanja12.workers.dev";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const out = $("out");
const status = $("status");
const form = $<HTMLFormElement>("form");
const q = $<HTMLInputElement>("q");
const go = $<HTMLButtonElement>("go");
const rpcInput = $<HTMLInputElement>("rpc");
const proxyInput = $<HTMLInputElement>("proxy");
const factoryInput = $<HTMLInputElement>("factory");
const chainSelect = $<HTMLSelectElement>("chain");
const settings = $("settings");
const sourcePill = $("source-pill");
const sourceText = $("source-text");
const settingsToggle = $<HTMLButtonElement>("settings-toggle");
const toast = $("toast");

let mode: Mode = "demo";
let view: View = "door";
let ticker: number | null = null;
let watcher: number | null = null;

function storage(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The chain the page is reading.
 *
 * "auto" means nobody has been asked to know the answer yet: the address
 * itself decides, and `autoChain` holds what the search found. Until a
 * search has run there is no chain, and `chain()` must not invent one —
 * the callers that need a name before then ask `chainOrNull()` and say
 * "find the chain" instead of naming one at random.
 */
let autoChain: ChainConfig | null = null;
/** Which address the current `autoChain` was found for, so a new paste searches again. */
let resolvedFor: { address: string; chain: string } = { address: "", chain: "" };

function chainOrNull(): ChainConfig | null {
  if (mode === "demo") return CHAINS.robinhood;
  if (chainSelect.value === "auto") return autoChain;
  return chainByKey(chainSelect.value);
}

function chain(): ChainConfig {
  return chainOrNull() ?? CHAINS.robinhood;
}

function setMode(next: Mode, silent = false): void {
  mode = next;
  chainSelect.disabled = false;
  // The strip says what this page is doing, and on a chain nobody has
  // chosen yet it says that instead of naming one. In the claude.ai
  // preview the sandbox blocks every request, so it says so rather than
  // letting somebody paste an address into a box that cannot answer.
  sourcePill.textContent = SANDBOXED ? "No network" : "Live";
  sourcePill.classList.toggle("live", !SANDBOXED);
  sourceText.innerHTML = SANDBOXED
    ? `This preview on claude.ai cannot reach the internet, so nothing here can be read. Use the <a href="${HOSTED}">hosted site</a>, the Chrome extension or the CLI.`
    : chainOrNull()
      ? `Reading ${esc(chainOrNull()!.name)} from your browser${chainOrNull()!.family === "solana" ? ", slot by slot" : " at one block"}. Nothing is cached.`
      : "Paste an address and BOUNCER finds the chain it lives on. Read from your browser at one block, nothing cached.";
  renderChips();
  if (!silent) storage("bouncer.mode", next);
}

function setView(next: View): void {
  view = next;
  const labels: Record<View, string> = {
    door: "Token address",
    dev: "Deployer address",
    wallet: "Token and wallet",
    tx: "Transaction hash",
    plan: "Plan a launch",
    board: "Tonight's board",
  };
  $("door-label").textContent = labels[next];
}

/** One box, any input: a token or curve, a transaction hash, or "token wallet". */
function detect(raw: string): { view: View; parts: string[] } | null {
  const parts = raw.trim().split(/[\s,]+/).filter(Boolean);
  // A Solana mint is base58 and has no 0x, so it can only be a door subject.
  // Base58 and no 0x: only a Solana mint looks like that, so the menu does
  // not get a say — including when the menu has not been asked yet.
  if (parts.length === 1 && mode === "live" && (chainSelect.value === "auto" || chain().family === "solana") && isSolanaAddress(parts[0]) && !ADDR.test(parts[0])) return { view: "door", parts };
  if (parts.length === 2 && ADDR.test(parts[0]) && ADDR.test(parts[1])) return { view: "wallet", parts };
  if (parts.length === 1 && ADDR.test(parts[0])) return { view: "door", parts };
  if (parts.length === 1 && /^0x[0-9a-fA-F]{64}$/.test(parts[0])) return { view: "tx", parts };
  if (parts.length === 1 && /^0x/.test(parts[0]) && mode === "demo" && /^0xdemo/i.test(parts[0])) return { view: "tx", parts };
  // A name, not an address. The door route handles it: on a live chain it
  // searches the explorer, and everywhere else it says what it needs. This
  // used to fall through to null, and null is how "cashcat" became "that is
  // not what this tab needs".
  if (raw.trim() && mode === "live" && /^\$?[a-z0-9 ._-]{2,32}$/i.test(raw.trim())) return { view: "door", parts: [raw.trim()] };
  return null;
}

/**
 * The chain picker: a listbox that drives the native <select>.
 *
 * A <select> cannot draw a mark beside an option, and the marks are the
 * point — a reader scanning for "the blue circle one" beats a reader
 * reading six names. So the visible control is a listbox and the select
 * stays underneath as the value: every existing reader and writer of
 * `chainSelect.value`, the route, the storage key and the change handler
 * all carry on untouched, and a page whose script never ran still has a
 * working form control rather than a dead button.
 */
/**
 * The one way to change the selected chain.
 *
 * route() used to assign chainSelect.value straight from the URL. The
 * select changed, the picker's button did not — it repaints on `change`,
 * and assigning a value fires nothing — so the header could read "Find
 * the chain" while the page was pinned to Solana. A control that lies
 * about its own state is worse than no control.
 */
let repaintPicker: (() => void) | null = null;

function selectChain(key: string): void {
  if (chainSelect.value === key) return;
  chainSelect.value = key;
  repaintPicker?.();
  paintSelectedChain();
}

function chainMark(key: string): string {
  if (key === "auto") return `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.6 2.2"/></svg>`;
  const c = CHAINS[key];
  return c ? `<svg viewBox="0 0 16 16" aria-hidden="true">${c.mark}</svg>` : "";
}

function chainTint(key: string): string {
  return key === "auto" ? "var(--dim)" : (CHAINS[key]?.tint ?? "var(--dim)");
}

function setUpPicker(): void {
  const btn = $<HTMLButtonElement>("picker-btn");
  const menu = $<HTMLUListElement>("picker-menu");
  const markEl = $("picker-mark");
  const nameEl = $("picker-name");
  const options = [...chainSelect.options].map((o) => ({ value: o.value, label: o.textContent ?? o.value }));

  const paint = (): void => {
    const key = chainSelect.value;
    markEl.innerHTML = chainMark(key);
    markEl.style.color = chainTint(key);
    nameEl.textContent = options.find((o) => o.value === key)?.label ?? key;
  };

  const draw = (): void => {
    menu.innerHTML = options
      .map(
        (o) => `<li role="option" data-value="${esc(o.value)}" aria-selected="${o.value === chainSelect.value}" tabindex="-1">
          <span class="picker-mark" style="color:${esc(chainTint(o.value))}">${chainMark(o.value)}</span>
          <span>${esc(o.label)}</span>
          ${o.value === chainSelect.value ? '<span class="tick" aria-hidden="true">&#10003;</span>' : ""}
        </li>`,
      )
      .join("");
  };

  let open = false;
  const items = (): HTMLLIElement[] => [...menu.querySelectorAll<HTMLLIElement>("li")];
  const highlight = (i: number): void => {
    const list = items();
    list.forEach((el, n) => el.classList.toggle("on", n === i));
    list[i]?.scrollIntoView({ block: "nearest" });
  };
  const at = (): number => items().findIndex((el) => el.classList.contains("on"));

  const show = (): void => {
    draw();
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    open = true;
    highlight(Math.max(0, options.findIndex((o) => o.value === chainSelect.value)));
  };
  const hide = (): void => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    open = false;
  };
  const choose = (value: string): void => {
    chainSelect.value = value;
    // The one that everything else in this file is already listening for.
    chainSelect.dispatchEvent(new Event("change", { bubbles: true }));
    paint();
    hide();
    btn.focus();
  };

  btn.addEventListener("click", () => (open ? hide() : show()));
  menu.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-value]");
    if (li) choose(li.dataset.value!);
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!open) return show();
    }
    if (!open) return;
    const list = items();
    if (e.key === "ArrowDown") highlight(Math.min(list.length - 1, at() + 1));
    else if (e.key === "ArrowUp") highlight(Math.max(0, at() - 1));
    else if (e.key === "Home") highlight(0);
    else if (e.key === "End") highlight(list.length - 1);
    else if (e.key === "Enter" || e.key === " ") choose(list[Math.max(0, at())].dataset.value!);
    else if (e.key === "Escape") hide();
  });
  document.addEventListener("click", (e) => {
    if (open && !$("picker").contains(e.target as Node)) hide();
  });
  chainSelect.addEventListener("change", paint);
  repaintPicker = paint;
  paint();
}

function proxyBase(): string {
  return (proxyInput.value.trim() || DEFAULT_PROXY).replace(/\/$/, "");
}

/**
 * A client per read, never one shared across reads.
 *
 * With `memo` on it remembers every answer pinned to a block number, which
 * is what lets the page's three renders share one set of reads instead of
 * asking the chain the same questions three times. That memory must not
 * outlive the read it belongs to, or the next paste would be answered off
 * the last one's chain.
 */
function rpcForChain(c: ChainConfig, memo = false): RpcClient {
  const url = rpcInput.value.trim();
  const proxy = proxyBase();
  const urls = url ? [url] : proxy ? [`${proxy}/rpc/${c.key}`, ...c.rpc] : c.rpc;
  return new RpcClient({ urls, expectedChainId: c.chainId, minSpacingMs: 120, memo });
}

function rpcFor(memo = false): RpcClient {
  if (mode === "demo") return demoRpc(memo);
  return rpcForChain(chain(), memo);
}

/**
 * One explorer client per read, with `memo` on for the same reason the RPC
 * client has it: the page reads a token three times, and the explorer is
 * the slowest thing in the read. Without it the second and third passes
 * ask the same four questions again — including, on Base, one that sat on
 * a timeout for the full six seconds and learned nothing.
 */
function blockscoutForChain(c: ChainConfig, memo = false): BlockscoutClient | null {
  if (!c.blockscout) return null;
  const proxy = proxyBase();
  return new BlockscoutClient({ baseUrl: proxy ? `${proxy}/api/${c.key}` : c.blockscout, memo });
}

function blockscoutFor(memo = false): BlockscoutClient | null {
  if (mode === "demo") return new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch(), memo });
  const c = chain();
  if (!c.blockscout) return null;
  const proxy = proxyBase();
  return new BlockscoutClient({ baseUrl: proxy ? `${proxy}/api/${c.key}` : c.blockscout, memo });
}

function factoryFor(): string | undefined {
  const c = chain();
  // A chain with no launchpad still has tokens on it. Refusing every address
  // because there is no factory to check against would throw away every answer
  // that needs no factory, which on Base and BNB Chain is all of them.
  const f = (mode === "live" ? factoryInput.value.trim() : "") || c.factory || "";
  return f ? f.toLowerCase() : undefined;
}

/** One client per read, memoizing, for the reason given on rpcFor. */
function solanaRpcFor(memo = false): SolanaRpc {
  const c = chain();
  const url = rpcInput.value.trim();
  const proxy = proxyBase();
  const urls = url ? [url] : proxy ? [`${proxy}/rpc/${c.key}`, ...c.rpc] : c.rpc;
  return new SolanaRpc({ urls, minSpacingMs: 120, memo });
}

const EXAMPLES: { label: string; hint: string; hash: string }[] = [
  { label: "A fresh launch", hint: "9 s old, door tax still open", hash: `#/demo/${DEMO.tokens.fresh.token}` },
  { label: "A graduated token", hint: "filled its curve in 212 s", hash: `#/demo/${DEMO.tokens.sprint.token}` },
  { label: "A fake copy", hint: "same name, not from the factory", hash: `#/demo/${DEMO_IMPOSTOR.token}` },
  { label: "An ordinary token", hint: "not a launch: owner keeps mint, pause, blacklist", hash: `#/demo/${DEMO_PLAIN.token}` },
  { label: "A dev on the move", hint: "sold and moved tokens, watch on", hash: `#/demo/${DEMO.tokens.late.token}?watch=1` },
  { label: "A trade receipt", hint: "one buy, itemised", hash: `#/tx/0xdemoFRESH${DEMO.tokens.fresh.launched + 22}?chain=demo` },
  { label: "A Pons V1 token", hint: "the older launchpad, caps still on", hash: `#/demo/${DEMO_V1.token}` },
];

function renderChips(): void {
  const chips = $("chips");
  chips.innerHTML = "";
  if (mode === "demo") {
    const label = document.createElement("span");
    label.textContent = "Try an example:";
    chips.appendChild(label);
    for (const e of EXAMPLES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.innerHTML = `${esc(e.label)}<em>${esc(e.hint)}</em>`;
      b.addEventListener("click", () => {
        location.hash = e.hash;
      });
      chips.appendChild(b);
    }
  }
  const more = document.createElement("div");
  more.className = "more";
  // With "auto" and no search run yet there is no chain to name, and
  // writing one into the link would be picking for the reader.
  const c = mode === "demo" ? "demo" : chainSelect.value === "auto" ? (chainOrNull()?.key ?? "auto") : chain().key;
  more.innerHTML = `<span>More:</span><a href="#/board?chain=${c}">Tonight's board</a><a href="#/plan?tax=100&chain=${c}">Plan a launch</a><span>Paste "token wallet" (two addresses) to see one wallet's bag.</span>`;
  chips.appendChild(more);
}

/**
 * The headline is an invitation, and an invitation that stays on screen
 * after you have accepted it is furniture. Once a slip is on the page the
 * hero shrinks to a line, so a second check starts where the answer is
 * rather than a screen above it.
 *
 * Driven by an observer rather than by each renderer: there are a dozen
 * places that fill #out, and the one that gets forgotten is the one that
 * leaves the page in the wrong state.
 */
new MutationObserver(() => {
  document.body.classList.toggle("answered", (document.getElementById("out")?.childElementCount ?? 0) > 0);
}).observe(document.getElementById("out") as Node, { childList: true });

/**
 * Copy-on-click for any element carrying data-copy. Delegated at the document
 * rather than wired per render: a slip rebuilds its whole subtree and a
 * listener attached to the old nodes goes with them.
 */
document.addEventListener("click", async (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-copy]");
  if (!target) return;
  const text = target.dataset.copy ?? "";
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied");
  } catch {
    showToast(text);
  }
});

function showToast(text: string): void {
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1600);
}

function busy(text: string): void {
  go.disabled = true;
  stopWatch();
  status.innerHTML = `<span class="dot"></span> ${esc(text)} ${mode === "demo" ? "(demo chain, every address invented)" : `(${esc(chain().name)}, ${chain().family === "solana" ? "read slot by slot" : "one block pinned"})`}`;
  out.innerHTML = "";
  if (ticker) { clearInterval(ticker); ticker = null; }
}

function failed(error: unknown, input: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const network = /fetch|network|failed|CORS|load|abort/i.test(message) && mode === "live";
  status.textContent = "";
  out.innerHTML = `<div class="error"><strong>Could not read the chain.</strong><p>${esc(message)}</p>${
    SANDBOXED
      ? `<p>This is the claude.ai preview: the sandbox blocks every request a page makes, so no RPC can be reached from here, whatever its settings. Real tokens work on the <a href="${HOSTED}">hosted site</a>, in the <a href="https://github.com/Kepochnik/bouncer#browser-extension">Chrome extension</a> (it can call any RPC), or in the CLI: <code>npx bouncer door ${esc(input)} --chain ${esc(chain().key)}</code>.</p>`
      : network ? `<p>The browser could not reach the RPC. Public endpoints often refuse requests from websites. Three ways out: deploy the read-only <a href="https://github.com/Kepochnik/bouncer/tree/main/proxy">proxy</a> (3 minutes, free) and paste its URL under Settings → Proxy URL; the <a href="https://github.com/Kepochnik/bouncer#browser-extension">Chrome extension</a> (it can call any RPC); or the CLI: <code>npx bouncer door ${esc(input)} --chain ${esc(chain().key)}</code>. Demo mode works offline.</p>` : ""
  }</div>`;
}

function done(text: string): void {
  go.disabled = false;
  status.textContent = `${mode === "demo" ? "DEMO · " : `${chain().name} · `}${text}`;
}

/**
 * Finished, with nothing to add.
 *
 * The status line and the slip's own footer printed the same chain, the
 * same block and the same timestamp, one above the other, forty pixels
 * apart. The views that have no slip still need the line; the two that do
 * end here instead.
 */
function ready(): void {
  go.disabled = false;
  status.textContent = "";
}

// ---------------------------------------------------------------- views

/** Addresses the demo chain knows; anything else is a real address and needs a real chain. */
function isDemoAddress(address: string): boolean {
  const a = address.toLowerCase();
  return Object.values(DEMO.tokens).some((t) => t.token === a || t.curve === a || t.deployer === a) || a === DEMO_IMPOSTOR.token || a === DEMO_PLAIN.token || a === DEMO_V1.token || a === DEMO_V1.deployer || a === "0x000000000000000000000000000000000000dead";
}

/**
 * Rising sequence number, so a slow read cannot land on a newer one.
 *
 * The door now renders twice: fast first, complete second. If you paste a
 * second address while the first is still finishing its log scans, the
 * first one's late result must not overwrite the second one's page.
 */
let doorRun = 0;

/**
 * The reads that make a door slow, measured rather than guessed. On Base,
 * USDC, one door:
 *
 *   eth_getLogs                15 calls, 13136 ms
 *   eth_getTransactionReceipt  58 calls,  2649 ms
 *   everything else                       ~1920 ms
 *
 * Eighteen seconds, and 89% of it is one section: who holds the pool's
 * liquidity — log scans for the pool's Mint events, then a receipt each to
 * trace a position to the wallet holding its NFT. The dev history, the room
 * and the lookalike search are log scans too.
 *
 * Everything a reader needs for the verdict — the code, the owner, the
 * powers, the pools, the holders — is under two seconds. So the page stops
 * waiting for the slow half before showing the fast one.
 */
const SLOW_SECTIONS = { skipLiquidity: true, skipDev: true, skipRoom: true, skipCrew: true, skipLookalikes: true } as const;

/**
 * And the render before that one: the chain on its own.
 *
 * The explorer is a different server and the slowest thing in the check —
 * measured on Robinhood Chain, one /addresses read is about four seconds,
 * against a quarter-second for a round trip to the node. Pool discovery and
 * the sale simulation both wait on reads of their own. None of the three is
 * needed to say what the code can do and who holds the keys, so the first
 * render does not wait for them.
 */
const OPENING_SECTIONS = { ...SLOW_SECTIONS, skipMarket: true, skipExplorer: true, skipProbes: true, skipOwnerWallet: true } as const;

/**
 * Somebody typed a name, not an address.
 *
 * Reported from the live site: "я вбил cashcat" — and the box answered
 * "paste a 20-byte hex address", which is a dead end dressed as an
 * instruction. Nobody is handed a contract address by the person shilling
 * a token; they are handed a ticker. Turning that ticker into candidates
 * is the explorer's job and it already has the endpoint.
 *
 * Every hit is offered, never auto-opened, and the addresses are shown.
 * Tickers are not unique — that is the whole reason the lookalike check
 * exists — so picking one for the reader would be guessing on the one
 * question this tool exists to answer.
 */
async function runSearch(query: string): Promise<void> {
  // Every chain with an explorer, not whichever one the menu fell back to.
  //
  // Under "Find the chain" this searched the fallback and nothing else, so
  // typing BONK returned Robinhood Chain results while the token itself
  // sat on Solana. A search that silently covers one network out of six is
  // worse than none: the empty answer reads as "this does not exist".
  const pinned = chainSelect.value === "auto" ? null : chain();
  const asked = pinned ? [pinned] : Object.values(CHAINS);
  busy(pinned ? `looking for "${query}" on ${pinned.name}…` : `looking for "${query}" on every chain with an explorer…`);
  const found = await searchTicker(query, (c) => blockscoutForChain(c), asked);
  const hits = found.hits.slice(0, 18);
  status.textContent = "";
  if (!hits.length) {
    const asked_ = asked.filter((c) => !found.unsearched.some((u) => u.chain.key === c.key));
    out.innerHTML = `<div class="error"><strong>Nothing called "${esc(query)}" on the chains BOUNCER could search.</strong>
      <p>${asked_.length ? `Searched and found nothing: ${esc(asked_.map((c) => c.name).join(", "))}.` : ""}
      ${found.unsearched.length ? `<b>Not searched, so it could still be on one of these:</b> ${esc(found.unsearched.map((u) => `${u.chain.name} (${u.reason})`).join("; "))}.` : ""}
      A token too new to be indexed is only found by its contract address.</p></div>`;
    return;
  }
  const rows = hits
    .map(
      (h) => `<li><button class="hit" type="button" data-go="${esc(h.address)}" data-chain="${esc(h.chain.key)}">
        <span class="hit-sym">${esc(h.symbol || "—")}</span>
        <span class="hit-chain" style="color:${esc(h.chain.tint)}">${chainMark(h.chain.key)}${esc(h.chain.name)}</span>
        <span class="hit-name">${esc(h.name || "no name")}</span>
        <span class="hit-addr mono">${esc(h.address)}</span>
      </button></li>`,
    )
    .join("");
  const gaps = found.unsearched.length
    ? `<p class="buy-gap"><b>Not searched:</b> ${esc(found.unsearched.map((u) => `${u.chain.name} (${u.reason})`).join("; "))}. A match there would not be in this list.</p>`
    : "";
  out.innerHTML = `<section class="found">
    <h2>${hits.length} token${hits.length === 1 ? "" : "s"} called something like "${esc(query)}"</h2>
    <p class="qblurb">BOUNCER will not pick for you. A ticker is not unique and anyone can deploy one — which is the whole reason this tool exists. Check the address and the chain against what the team posted, then open it.</p>
    <ul class="hits">${rows}</ul>
    ${gaps}
  </section>`;
  for (const button of out.querySelectorAll<HTMLButtonElement>("[data-go]")) {
    button.addEventListener("click", () => {
      // The chain the hit was found on, never the one the menu is showing.
      location.hash = `#/t/${button.dataset.go}?chain=${button.dataset.chain}`;
    });
  }
}

/** The placeholder and the hint line, for whatever the menu is set to. */
function paintSelectedChain(): void {
  if (chainSelect.value === "auto") {
    q.placeholder = "0x… or a Solana mint — BOUNCER finds the chain";
    $("chain-hint").textContent = `BOUNCER asks every chain it knows where this address lives: ${searchableChains().map((c) => c.name).join(", ")}, and Solana by the shape of the address. Pick one from the menu to skip the search and read it directly.`;
    return;
  }
  const c = chainByKey(chainSelect.value);
  // The box asks for a different thing on a chain that does not use hex addresses.
  q.placeholder = c.family === "solana" ? "a Solana mint address (base58, like EPjFWdd5…yTDt1v)" : "0x… (a token, its curve, a wallet or a transaction hash)";
  $("chain-hint").textContent = `${c.name}${c.chainId ? ` (${c.chainId})` : ""}${c.launchpad ? ` · ${c.launchpad}` : " · no launchpad known here"} · RPC ${c.rpc[0]}${c.blockscout ? ` · explorer ${c.blockscout}` : " · no explorer known, the funder check and same-name search are off"}${c.notes ? ` · ${c.notes}` : ""}`;
}

/** Repaints the chrome that names the chain, after a search settles it. */
function paintChain(): void {
  const c = chainOrNull();
  setMode(mode, true);
}

/**
 * Work out which chain an address lives on, before reading it.
 *
 * Returns true when the read may go ahead. When it returns false it has
 * already put the reason on screen — either several chains answered and
 * the reader has to choose, or none did and the page has to say which
 * chains were asked and which never replied.
 */
async function resolveChain(address: string): Promise<boolean> {
  if (autoChain && autoChain.key === resolvedFor.chain && resolvedFor.address === address.toLowerCase()) return true;
  busy("finding the chain this address lives on…");
  let search: ChainSearch;
  try {
    search = await whichChains(address, (c) => rpcForChain(c), searchableChains());
  } catch (error) {
    bad(`The chains could not be asked where this address lives: ${error instanceof Error ? error.message : String(error)}. Pick one from the menu and BOUNCER will read it directly.`);
    return false;
  }
  const verdict = readChainSearch(search);
  if (verdict.kind === "one") {
    autoChain = verdict.chain;
    resolvedFor = { address: address.toLowerCase(), chain: verdict.chain.key };
    paintChain();
    return true;
  }
  if (verdict.kind === "several") {
    renderChainChoice(address, search);
    return false;
  }
  renderChainMiss(address, search);
  return false;
}

/**
 * Several chains hold a contract at this address, so the page asks.
 *
 * It does not rank them and it does not pre-select one. The identical
 * address on two chains is the shape of a particular trick — a real token
 * on one, something else at the same address on another — and a tool that
 * quietly picked the likelier one would be answering the question the
 * reader came here to ask.
 */
function renderChainChoice(address: string, search: ChainSearch): void {
  const rows = search.hits
    .map(
      // Its own classes, not the ticker search's: a check asserts every
      // `.hit-addr` on the page is a bare 0x address, and this one names a
      // chain. Two different lists should not share a name.
      (h) => `<button class="chain-hit" data-chain="${esc(h.chain.key)}">
        <span class="hit-name">${esc(h.token ? `${h.token.name} · ${h.token.symbol}` : "a contract, which does not name itself")}</span>
        <span class="chain-hit-where">${esc(h.chain.name)} · ${h.codeSize.toLocaleString()} bytes of code</span>
      </button>`,
    )
    .join("");
  out.innerHTML = `<section class="found">
    <h2>${search.hits.length} chains have a contract at this address</h2>
    <p class="qblurb">That is not a glitch. A contract's address comes from who deployed it and how many times they had deployed before, so the same pair lands on the same address on every chain — which is also how somebody puts a real token on one chain and something else at the matching address on another. Which one did you mean?</p>
    <div class="hits">${rows}</div>
    <p class="buy-gap"><span class="mono">${esc(address)}</span></p>
  </section>`;
  for (const button of out.querySelectorAll<HTMLButtonElement>("[data-chain]")) {
    button.addEventListener("click", () => {
      location.hash = `#/t/${address.toLowerCase()}?chain=${button.dataset.chain}`;
    });
  }
}

/** Nothing anywhere — and which chains were actually asked. */
function renderChainMiss(address: string, search: ChainSearch): void {
  const asked = search.empty.map((c) => c.name).join(", ");
  const broke = search.unreachable.map((u) => `${u.chain.name} (${u.reason})`).join("; ");
  out.innerHTML = `<section class="found">
    <h2>No contract at this address on any chain BOUNCER could read</h2>
    <p class="qblurb">${asked ? `Asked and answered nothing: ${esc(asked)}.` : ""} ${
      broke
        ? `<b>These did not answer, so this address could still be on one of them:</b> ${esc(broke)}. Pick that chain from the menu and BOUNCER will read it directly, with no clock on it.`
        : "An address with no code is a wallet, not a token — or the token has not been deployed yet."
    }</p>
    <p class="buy-gap"><span class="mono">${esc(address)}</span></p>
  </section>`;
}

async function runDoor(address: string): Promise<void> {
  // On "auto" the ADDRESS decides the family, and nothing else.
  //
  // This used to ask chainOrNull(), which on "auto" hands back whatever
  // the LAST read settled on. Check one Solana mint and every EVM address
  // pasted afterwards went to the Solana reader and came back "paste a
  // Solana mint address" — with the menu still showing Find the chain.
  // A remembered answer belongs to the address it was found for.
  if (mode === "live") {
    const auto = chainSelect.value === "auto";
    const family = auto ? addressFamily(address, isSolanaAddress) : chainByKey(chainSelect.value).family;
    if (family === "solana") {
      if (auto) {
        autoChain = CHAINS.solana;
        resolvedFor = { address: address.trim().toLowerCase(), chain: CHAINS.solana.key };
        paintChain();
      }
      return await runSolanaDoor(address);
    }
    // An EVM address under auto: forget a chain found for some other one,
    // so the strip stops naming it while this read is still being placed.
    if (auto && autoChain && resolvedFor.address !== address.trim().toLowerCase()) {
      autoChain = null;
      paintChain();
    }
  }
  if (!ADDR.test(address)) {
    // A ticker, most likely. Say so and go looking rather than refusing.
    if (mode === "live" && /^[a-z0-9$ ._-]{2,32}$/i.test(address)) return await runSearch(address.replace(/^\$/, ""));
    return bad("Paste a 20-byte hex address — 0x followed by 40 hex characters — or a token's name to search for it.");
  }
  if (mode === "live" && chainSelect.value === "auto" && !(await resolveChain(address))) return;
  if (mode === "demo" && !isDemoAddress(address)) {
    // A real address pasted into the demo: the demo chain would call it an impostor. Go live instead.
    setMode("live");
    showToast(`Real address: switched to live on ${chain().name}`);
    location.hash = `#/t/${address.toLowerCase()}?chain=${chain().key}`;
    return;
  }
  const run = ++doorRun;
  busy("reading the chain at the door…");
  const options = mode === "demo"
    ? { chain: CHAINS.robinhood, factory: factoryFor(), blockscout: blockscoutFor(true), devHours: 8, chunkSize: 100_000, launchSearchBlocks: 400_000 }
    : { chain: chain(), factory: factoryFor(), blockscout: blockscoutFor(true), devHours: 24 };

  // Three renders off one paste, each drawn the moment its own reads land.
  //
  // The opening one asks the chain and nothing else: four round trips for
  // what the code can do and who holds the keys. No explorer, no pool
  // discovery, no sale simulation — three different servers and three
  // different kinds of read, none of which the first true sentence needs.
  // It carries no verdict word, because a verdict off a quarter of the
  // evidence is one that changes while you read it.
  //
  // The fast one and the whole thing run alongside it, not after it — see
  // the note above the passes below. One client for all three, so a read
  // one of them starts is a read the others join rather than repeat, and
  // one block for all three, so they are three views of the same moment
  // rather than three different ones.
  const rpc = rpcFor(true);
  // The explorer starts now, not when the pass that needs it starts.
  //
  // It is the slowest thing in the read — about three seconds for one
  // /addresses call on Robinhood Chain, against a chain answering every
  // request in under two hundred milliseconds — and the opening render
  // deliberately does not wait for it. That left it starting a second and a
  // half late for no reason. Started here it runs UNDER the opening render
  // instead of after it, and the memo hands the same request to whoever
  // asks next, finished or still in flight.
  if (options.blockscout) options.blockscout.prewarm(BlockscoutClient.doorPaths(address.toLowerCase()));
  let at: BlockHeader | undefined;

  // Renders only ever move forward. The three passes run together now, and
  // on a chain where the slow half is cheap they can land out of order —
  // drawing the smaller slip over the bigger one would take answers off the
  // screen a reader had already been given.
  const RANK: Record<Stage, number> = { opening: 0, fast: 1, done: 2 };
  let drawn: Stage | null = null;
  const draw = (slip: DoorSlip, stage: Stage) => {
    if (run !== doorRun) return false;
    if (drawn !== null && RANK[stage] <= RANK[drawn]) return true;
    if (drawn === null) renderSlip(slip, { stage });
    else keepPlace(() => renderSlip(slip, { stage }));
    drawn = stage;
    if (stage === "done") ready();
    else status.textContent = `${mode === "demo" ? "DEMO · " : `${chain().name} · `}block ${slip.at.block} · ${STILL_READING[stage]}…`;
    return true;
  };

  try {
    at = await rpc.head();
  } catch (error) {
    return failed(error, address);
  }

  // All three at once.
  //
  // They used to queue — opening, then fast, then full — and the bill was
  // plain in the last measurement: on Robinhood Chain the verdict landed at
  // 3.7 s and the complete slip at 5.7, while the chain answered every
  // request in under two hundred milliseconds. The opening render took a
  // second and a half of that, and the fast pass did not start its own
  // reads until it was done, although it wanted most of the same ones.
  //
  // What makes running them together free rather than three times as
  // expensive is that both clients hand a second caller a read that is
  // still IN FLIGHT, not just one that has already come back. The passes
  // ask overlapping questions; each question goes out once. What is left
  // is the work that is genuinely different — the explorer, the pool
  // discovery, the log scan — and that now happens side by side instead of
  // end to end.
  // The slow half starts a quarter of a second behind the other two.
  //
  // Measured, both ways. Sequential: verdict 3.7 s, complete 5.7. All three
  // at once: complete 4.5, but the verdict slipped to 4.4 — the log scan
  // competes for the six connections a browser gives an origin, and the
  // pass a reader is actually waiting on lost the race to the one they are
  // not. Together is right for the total; the stagger is what keeps the
  // verdict from paying for it.
  //
  // A quarter of a second is enough for the reads that matter to be on the
  // wire first, and short enough to cost the total almost nothing: the slow
  // half is a log scan measured in seconds.
  const SLOW_HALF_HEAD_START_MS = 250;
  const passes: [Stage, Promise<DoorSlip>][] = [
    ["opening", readDoor(rpc, address, { ...options, ...OPENING_SECTIONS, at })],
    ["fast", readDoor(rpc, address, { ...options, ...SLOW_SECTIONS, at })],
    [
      "done",
      new Promise<void>((resolve) => setTimeout(resolve, SLOW_HALF_HEAD_START_MS)).then(() => {
        // Paste a second address inside that quarter second and the first
        // one's slow half should never start. It would only be thrown away.
        if (run !== doorRun) throw new Error("superseded");
        return readDoor(rpc, address, { ...options, at });
      }),
    ],
  ];
  // Started, so a rejection before its await is a value and not a page crash.
  for (const [, p] of passes) p.catch(() => {});

  let lastError: unknown = null;
  for (const [stage, pass] of passes) {
    try {
      const slip = await pass;
      if (!draw(slip, stage)) return;
    } catch (error) {
      lastError = error;
      // An earlier pass failing is not worth reporting on its own: the ones
      // after it ask the same questions and will say what went wrong.
    }
  }
  if (run !== doorRun) return;
  if (drawn === null) failed(lastError, address);
  else if (drawn !== "done") {
    // Something is on screen and the slow half did not arrive. It stays, and
    // says what is missing.
    status.textContent = `${chain().name} · the slower sections did not answer: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
  }
  go.disabled = false;
}

async function runDev(address: string): Promise<void> {
  if (!ADDR.test(address)) return bad("Paste the deployer's address.");
  busy("reading the deployer's launches…");
  try {
    const rpc = rpcFor();
    const head = await rpc.getBlock("latest");
    const fromBlock = mode === "demo" ? Math.max(0, head.number - 300_000) : await findBlockByTimestamp(rpc, head.timestamp - 24 * 3600, head.number);
    const d = await readDevReport(rpc, address, { fromBlock, toBlock: head.number, factory: factoryFor(), chunking: mode === "demo" ? { startChunk: 100_000, maxChunk: 100_000 } : undefined });
    done(`block ${head.number} · last ${mode === "demo" ? "8" : "24"} h`);
    out.innerHTML = `<div class="slip">${devSection(d, null, true)}</div>`;
  } catch (error) {
    failed(error, address);
  } finally {
    go.disabled = false;
  }
}

async function runWallet(token: string, wallet: string): Promise<void> {
  if (!ADDR.test(token) || !ADDR.test(wallet)) return bad("Paste the token address and the wallet address.");
  busy("reading the wallet's trades…");
  try {
    const rpc = rpcFor();
    const factory = factoryFor();
    const head = await rpc.blockNumber();
    const launch = await new PonsReader(rpc, factory).launchedToken(token, head);
    const launchBlock = await findLaunchBlock(rpc, launch.token, head, mode === "demo" ? 400_000 : Math.round(30 * 86_400 * chain().blocksPerSecond), factory, mode === "demo" ? 100_000 : undefined);
    const p = await readPosition(rpc, launch, wallet, launchBlock ?? 0, head, factory, mode === "demo" ? 100_000 : undefined);
    done(`block ${head}`);
    renderPosition(p, head);
  } catch (error) {
    failed(error, token);
  } finally {
    go.disabled = false;
  }
}

async function runTx(hash: string): Promise<void> {
  if (!hash.startsWith("0x")) return bad("Paste a transaction hash.");
  busy("decoding the trade…");
  try {
    const receipts = await readTradeReceipt(rpcFor(), hash, factoryFor());
    done(`block ${receipts[0].block}`);
    out.innerHTML = `<div class="slip">${receipts.map(receiptSection).join("")}</div>`;
  } catch (error) {
    failed(error, hash);
  } finally {
    go.disabled = false;
  }
}

async function runPlan(taxBps: number, params: URLSearchParams): Promise<void> {
  busy("reading the factory's terms…");
  try {
    const rpc = rpcFor();
    const c = chain();
    const buy = params.get("buy");
    const plan = await readLaunchPlan(rpc, {
      factory: factoryFor(),
      block: await rpc.blockNumber(),
      nativeSymbol: c.native.symbol,
      creatorTaxBps: BigInt(taxBps),
      configId: Number(params.get("config") ?? 0),
      pairToken: params.get("quote") ?? undefined,
      sampleBuy: buy ? BigInt(Math.round(Number(buy) * 1e6)) * 10n ** 12n : undefined,
    });
    done(`block ${plan.block} · config ${plan.configId}`);
    renderPlan(plan);
  } catch (error) {
    failed(error, "plan");
  } finally {
    go.disabled = false;
  }
}

async function runBoard(hours: number): Promise<void> {
  busy("reading the window…");
  try {
    const rpc = rpcFor();
    const head = await rpc.getBlock("latest");
    const fromBlock = mode === "demo" ? Math.max(0, head.number - 300_000) : await findBlockByTimestamp(rpc, head.timestamp - hours * 3600, head.number);
    const b = await readBoard(rpc, { fromBlock, toBlock: head.number, factory: factoryFor(), top: 10, chunkSize: mode === "demo" ? 100_000 : undefined });
    done(`blocks ${b.window.fromBlock}–${b.window.toBlock} · ${b.chunks} log reads`);
    renderBoard(b, hours);
  } catch (error) {
    failed(error, "board");
  } finally {
    go.disabled = false;
  }
}

function renderBoard(b: Board, hours: number): void {
  const qd = chain().native;
  const amt = (v: bigint) => `${formatUnits(v, qd.decimals)} ${esc(qd.symbol)}`;
  const link = (a: string) => `<a href="#/${mode === "demo" ? "demo" : "t"}/${a}${routeChain()}">${shortAddress(a)}</a>`;
  const dev = (a: string) => `<a href="#/dev/${a}${routeChain()}">${shortAddress(a)}</a>`;
  out.innerHTML = `<div class="slip">
    <div class="stamp-row"><div class="who"><div class="sym">THE BOARD</div><div class="name">${esc(chain().name)} · last ${hours} h · blocks ${b.window.fromBlock}–${b.window.toBlock}</div></div>
      <div class="stamp">${b.launches} LAUNCHES</div></div>
    <div class="grid">
      <section class="sec"><h2>Tonight</h2><div class="exit-grid">
        <div><span>launches</span><b class="num">${b.launches}</b></div>
        <div><span>graduations</span><b class="num">${b.graduations}</b></div>
        <div><span>deployers</span><b class="num">${b.deployers}</b></div>
        <div><span>cover collected</span><b class="num">${formatUnits(b.coverTotal, qd.decimals, 3)}</b><span>${esc(qd.symbol)} · ${b.taxedBuys} buys</span></div>
      </div><p style="margin:0;color:var(--dim);font-size:12px">Cover charge = the part of a buy's tax above the curve's own creator rate, as the curve's CurveBuy event reports it. Counts, not scores.</p></section>
      <section class="sec"><h2>Deployers</h2>${b.topDeployers.length ? `<div class="tbl"><table class="buys"><thead><tr><th>deployer</th><th>launched</th><th>graduated</th><th>swept, no pool</th></tr></thead><tbody>${b.topDeployers.map((r) => `<tr><td>${dev(r.deployer)}</td><td>${r.launched}</td><td>${r.graduated}</td><td>${Math.max(0, r.swept - r.graduated)}</td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--muted);margin:0">No launches in the window.</p>`}
        ${b.serial.length ? `<h2 style="margin-top:14px">Serial, no graduation</h2><div class="tbl"><table class="buys"><tbody>${b.serial.map((r) => `<tr><td>${dev(r.deployer)}</td><td>${r.launched} launched, none graduated</td></tr>`).join("")}</tbody></table></div>` : ""}</section>
      <section class="sec"><h2>Cover charge by curve</h2>${b.topCurves.length ? `<div class="tbl"><table class="buys"><thead><tr><th>token</th><th>collected</th><th>buys</th><th>highest</th><th>creator tax</th></tr></thead><tbody>${b.topCurves.map((r) => `<tr><td>${link(r.token ?? r.curve)}</td><td>${amt(r.coverCollected)}</td><td>${r.taxedBuys}</td><td>${(r.highestBps / 100).toFixed(1)}%</td><td>${formatBps(r.creatorTaxBps)}</td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--muted);margin:0">No buy in the window paid above the creator rate.</p>`}</section>
      <section class="sec"><h2>Cover charge by wallet</h2>${b.topPayers.length ? `<div class="tbl"><table class="buys"><thead><tr><th>wallet</th><th>paid at the door</th><th>buys</th></tr></thead><tbody>${b.topPayers.map((r) => `<tr><td>${shortAddress(r.wallet)}</td><td>${amt(r.coverPaid)}</td><td>${r.buys}</td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--muted);margin:0">Nobody paid at the door in the window.</p>`}</section>
    </div></div>`;
}

function stopWatch(): void {
  if (watcher) { clearInterval(watcher); watcher = null; }
}

/** DEV MOVED / CREW EXIT in this tab: polls the head every 15 s and appends events. */
function startWatch(slip: DoorSlip, panel: HTMLElement, button: HTMLButtonElement): void {
  const launch = slip.id.launch!;
  const crew = slip.crew?.crews.flatMap((c) => c.wallets) ?? [];
  const list = panel.querySelector<HTMLElement>(".events")!;
  let cursor = mode === "demo" ? Math.max(0, slip.at.block - 300_000) : slip.at.block + 1;
  let rounds = 0;
  const add = (html: string, quiet = false) => {
    const el = document.createElement("div");
    el.className = `event${quiet ? " quiet" : ""}`;
    el.innerHTML = html;
    list.prepend(el);
    while (list.children.length > 40) list.lastElementChild?.remove();
  };
  const tick = async () => {
    try {
      const rpc = rpcFor();
      const head = await rpc.blockNumber();
      if (head < cursor) return;
      const events: WatchEvent[] = await readWatchEvents(rpc, launch, { fromBlock: cursor, toBlock: head, crew, factory: factoryFor(), quote: slip.rules?.quote ?? chain().native, chunkSize: mode === "demo" ? 100_000 : undefined });
      cursor = head + 1;
      rounds++;
      for (const e of events) {
        add(`<span class="b">${e.block}</span><span class="k">${esc(e.kind)}</span><span>${esc(e.text)}</span>`);
        try { if (Notification.permission === "granted") new Notification(`BOUNCER · ${slip.id.meta?.symbol ?? "watch"}`, { body: `${e.kind}: ${e.text}` }); } catch { /* no notifications here */ }
      }
      if (!events.length && rounds % 4 === 1) add(`<span class="b">${head}</span><span class="k" style="color:var(--dim)">quiet</span><span>no moves up to block ${head}</span>`, true);
    } catch (error) {
      add(`<span class="b">·</span><span class="k" style="color:var(--stop)">error</span><span>${esc(error instanceof Error ? error.message : String(error))}</span>`);
    }
  };
  button.setAttribute("aria-pressed", "true");
  button.textContent = "Watching · click to stop";
  try { if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission(); } catch { /* fine */ }
  void tick();
  watcher = window.setInterval(() => void tick(), mode === "demo" ? 5_000 : 15_000);
}

function bad(text: string): void {
  out.innerHTML = `<div class="error"><strong>That is not what this tab needs.</strong><p>${esc(text)}</p></div>`;
}

// ---------------------------------------------------------------- render

function summarySentence(slip: DoorSlip): string {
  if (slip.id.v1) {
    const v = slip.id.v1;
    const parts = ["Real Pons V1 launch: fixed supply, trading in a Uniswap V3 pool since block one, liquidity locked"];
    if (v.restrictionBlocksLeft > 0 && v.config) parts.push(`launch caps are on for ${v.restrictionBlocksLeft} more blocks (max ${formatBps(v.config.maxWalletBps)} per wallet)`);
    parts.push(v.status.graduated ? "graduated" : `${formatUnits(v.status.pairedPrincipal, v.quote.decimals)} of ${formatUnits(v.status.threshold, v.quote.decimals)} ${v.quote.symbol} towards graduation`);
    return sentence(parts);
  }
  if (!slip.id.registered) return openDoorSentence(slip);
  const parts: string[] = [`Real ${slip.chain.launchpad ?? "launchpad"} launch`];
  const c = slip.cover;
  if (c?.status === "open") parts.push(`the door tax is still on for ${c.secondsLeft} s (up to ${formatBps(c.terms.startBps)} of a buy goes to the creator)`);
  else if (c?.status === "closed") parts.push("the door tax has ended");
  if (slip.rules) parts.push(`every trade pays ${formatBps(slip.rules.totalTradeBps)} in fees`);
  if (slip.room && slip.room.buys > 0) parts.push(`the creator funded ${(slip.room.devShareBps / 100).toFixed(0)}% of what was bought`);
  if (slip.crew?.crews.length) parts.push(`${slip.crew.crews[0].wallets.length} early buyers share a funder`);
  if (slip.dev) parts.push(slip.dev.counts.launched <= 1 ? "first launch from this dev" : `this dev launched ${slip.dev.counts.launched} tokens, ${slip.dev.counts.graduated} graduated`);
  if (slip.rules?.phase === 2 || slip.rules?.phase === 3) parts.push("graduated, pool locked");
  // Through the clause limit, like every other lead. This one built its own
  // string and so ignored it, which is why the top of the page went on
  // printing five sentences after the limit was set to stop exactly that.
  return sentence(parts);
}

/**
 * THE VERDICT, and the five questions under it.
 *
 * A slip used to open with a flat list called "What to know", ordered by how
 * loud each note was. That is the right order for one note and the wrong
 * shape for twenty. A reader arrives with questions already in a fixed order
 * — is this even the token I meant, can they take it away, can I sell, what
 * would I get, who else is in here — and the page should answer them in that
 * order rather than hand over a pile sorted by volume.
 *
 * The grouping itself lives in the core (src/bouncer/topics.ts), so the CLI,
 * the site, the extension and the MCP server cannot drift apart on it.
 */

/**
 * The one word at the top. Loudest note wins; nothing loud means nothing was
 * found, which is not the same as safe.
 *
 * On the opening render there is no word yet. The page has the code and the
 * keys by then, and that is worth putting on screen a second early — but a
 * verdict read off half the evidence is a verdict that changes while you are
 * reading it, and a STOP that turns into a CLEAR teaches a reader to ignore
 * the next one. So the first render says READING and means it.
 */
type VerdictKind = "stop" | "watch" | "clear" | "reading" | "incomplete";

function verdictOf(notes: DoorNote[], stage: Stage = "done", coverage?: Coverage): { word: string; kind: VerdictKind; line: string } {
  if (stage === "opening") return { word: "READING", kind: "reading", line: "What the code can do and who holds the keys is below. The rest is still being read; there is no verdict until it is in." };
  const stop = notes.filter((n) => n.level === "stop").length;
  const watch = notes.filter((n) => n.level === "watch").length;
  const base: { word: string; kind: "stop" | "watch" | "clear"; line: string } = stop
    ? { word: "STOP", kind: "stop", line: `${stop} thing${stop === 1 ? "" : "s"} here can cost you money outright.` }
    : watch
      ? { word: "WATCH", kind: "watch", line: `Nothing outright dangerous, ${watch} thing${watch === 1 ? "" : "s"} worth reading before you buy.` }
      : { word: "CLEAR", kind: "clear", line: "Nothing in what was read stands out. That is not a promise about the price." };
  if (!coverage) return base;
  const kind = qualify(base.kind, coverage);
  // Only CLEAR can be qualified away, and the replacement has to explain
  // itself in the same breath: a reader who sees a word they have not seen
  // before, with no reason attached, reads it as a worse STOP.
  if (kind === "incomplete") {
    return { word: "INCOMPLETE", kind, line: `Nothing stood out in what was read — but ${coverage.line.replace(/^./, (c) => c.toLowerCase())} Until that is filled in, this is not a clean result.` };
  }
  // A STOP or a WATCH keeps its word and its count. What it must not keep
  // is the impression that the count is the whole list.
  if (coverage.state === "thin") {
    // Sentence case, because this lands after a full stop. It read
    // "…can cost you money outright. a simulated sale could not be read",
    // which is the kind of seam that makes a reader trust the next
    // sentence slightly less without being able to say why.
    const said = coverage.line.replace(/^./, (c) => c.toUpperCase());
    return { ...base, kind, line: `${base.line} ${said} There may be more.` };
  }
  return { ...base, kind, line: base.line };
}

/**
 * The completeness band: what this reading covered, directly under the word.
 *
 * Under, and not in a strip at the bottom, because the bottom is where the
 * refusals already were. They were there in full — section and reason, both
 * accurate — while the headline said the token looked fine, and the audit
 * that found this read the headline and stopped, exactly as a reader does.
 * Position is the fix; the text was never the problem.
 *
 * It shows nothing at all on a complete reading. A band that is always there
 * is furniture, and furniture is invisible by the second visit — so the one
 * time it matters it would not be seen either.
 */
function coverageBand(coverage: Coverage, stage: Stage): string {
  if (stage !== "done" || coverage.state === "complete") return "";
  // The holes first, then the standing limits. The limits do not open the
  // band — they are true of every reading and would make it permanent —
  // but once it IS open they are the other half of "what this does not
  // tell you", and a reader looking at one gap should see the rest.
  const row = (g: (typeof coverage.gaps)[number], limit: boolean) =>
    `<li class="cgap${g.decisive && !limit ? " cgap-hard" : ""}${limit ? " cgap-limit" : ""}">
        <span class="cgl">${esc(g.label)}</span>
        <span class="cgr">${esc(g.reason ?? "did not answer")}</span>
        <span class="cgt">${limit ? "not offered" : esc(TOPIC_TAG[g.topic])}</span>
      </li>`;
  const rows = [...coverage.gaps.map((g) => row(g, false)), ...coverage.limits.map((g) => row(g, true))].join("");
  // The retry is offered only where pressing it could work. A button that
  // cannot change the answer is a button that teaches a reader the answer
  // never changes.
  const retry = coverage.retryable
    ? `<button class="ghost" id="act-retry" type="button">Read the missing parts again</button>`
    : "";
  return `<section class="cov cov-${coverage.state}" data-coverage="${coverage.state}">
    <div class="covhead">
      <span class="covword">${coverage.state === "thin" ? "INCOMPLETE CHECK" : "PARTIAL CHECK"}</span>
      <span class="covcount">${coverage.read} of ${coverage.asked} checks answered</span>
      ${retry}
    </div>
    <ul class="cgaps">${rows}</ul>
  </section>`;
}

/**
 * How far along a render is. The page draws three times off one paste:
 *
 *   opening  the chain only — what the code can do, who holds the keys
 *   fast     + where it trades, who holds it, whether a sale goes through
 *   done     + who holds the liquidity, the dev history, the room
 *
 * Measured in round trips (npm run depth-check): four, eight and twelve. The
 * point of the first one is that a reader sees a true thing about the token
 * before the slowest server involved has answered anything at all.
 */
type Stage = "opening" | "fast" | "done";

/** Solana has no sale simulation; it has a holder list and pools. */
const SOL_STILL_READING = "still reading who holds it and where it trades";

/** What a stage has not asked for yet, in the reader's words. */
const STILL_READING: Record<Stage, string> = {
  opening: "still reading where it trades, who holds it, and whether a sale goes through",
  fast: "still reading who holds the liquidity and the dev history",
  done: "",
};

/**
 * The poster at the top of every slip: who it is, one word, one sentence, and
 * the count. Everything below is detail for somebody who wants it.
 */
function verdictBlock(opts: {
  sym: string;
  name: string;
  address: string;
  stamp: string;
  at: string;
  notes: DoorNote[];
  lead: string;
  /** How far along this render is; anything but "done" means the tallies will change. */
  stage?: Stage;
  /** What is still being read, when it is not what the EVM door reads. */
  stillReading?: string;
  /** What this reading covered. Absent on the demo slips, which are complete by construction. */
  coverage?: Coverage;
  /**
   * The four numbers that decide it, rendered inside the block rather than
   * under it. They are the verdict said in figures; a separate row with its
   * own margin made one idea look like two.
   */
  tiles?: string;
  actions: string;
}): string {
  const stage = opts.stage ?? "done";
  const v = verdictOf(opts.notes, stage, opts.coverage);
  const stampClass = opts.stamp === "ON THE LIST" ? "yes" : opts.stamp === "NOT A LAUNCH" ? "mid" : "no";
  // The level counts are gone from here.
  //
  // They read "5 careful · 9 note" — fourteen — above a ledger showing two
  // rows and eight folded, and a separate strip holding the other four. A
  // number a reader cannot arrive at by counting what is in front of them
  // is not a summary, it is a contradiction they have to resolve. The
  // ledger is sorted by severity and says its own totals; the one thing
  // this footer still has to say is that the totals are not final yet.
  const pending = stage === "done" ? "" : `<span class="vpend">${esc(opts.stillReading ?? STILL_READING[stage])}</span>`;
  // Two counts, and both can be arrived at by counting what is on screen:
  // the ledger's rows and the unread strip's. The old tallies counted by
  // severity across both, which produced a fourteen nobody could find.
  const findings = opts.notes.filter((n) => topicOf(n.code) !== "unread").length;
  // One tally, because there used to be two and they disagreed. The cell
  // said "2 unreadable" — notes in the strip — while the band below said
  // "3 of 4 checks answered", and a reader cannot reconcile two numbers
  // counting different things without being told which is which. The
  // band counts CHECKS and owns the subject; this cell counts findings
  // and says nothing about coverage.
  const counts = findings ? `${findings} finding${findings === 1 ? "" : "s"}` : "nothing to flag";
  // `data-pending` is the machine-readable half of that, and it is a
  // contract: speed-check decides a slip is COMPLETE by the absence of this
  // marker. Restyling the visible chip away without it would have made
  // "complete" fire the moment a verdict appeared, so the headline number
  // would have improved by two seconds while nothing got faster. The
  // scripts assert the marker exists rather than trusting its absence.
  return `<section class="verdict v-${v.kind}"${stage === "done" ? "" : ' data-pending="1"'}>
    <div class="vtop">
      <div class="vcell">
        <div class="vlevel">VERDICT</div>
        <div class="vword" aria-label="Verdict">${v.word}</div>
        <div class="vcounts">${counts}</div>
      </div>
      <div class="vsay">
        <div class="vwho">
          <span class="vsym">${opts.sym}</span>
          <span class="vname">${opts.name}</span>
          <span class="vstamp ${stampClass}">${opts.stamp}</span>
        </div>
        <p class="vlead">${esc(opts.lead)}</p>
        <p class="vsub">${esc(v.line)}${pending}</p>
      </div>
    </div>
    ${opts.coverage ? coverageBand(opts.coverage, stage) : ""}
    ${opts.tiles ?? ""}
    <div class="vfoot">
      <button class="vaddr" type="button" data-copy="${esc(opts.address)}" title="Copy the address">${esc(opts.address)}</button>
      <span class="vat">${opts.at}</span>
      <div class="vacts">${opts.actions}</div>
    </div>
  </section>`;
}

/**
 * The five questions, each with the notes that answer it. A question nobody
 * has an answer for is not shown — an empty card reads as "checked and fine",
 * and nothing here checked it.
 *
 * "What BOUNCER could not read" is never one of the cards. It is its own
 * strip below them, because a gap folded in among findings reads as a clean
 * result, and that is the one mistake this whole project is built to avoid.
 */
/**
 * Dims the explanations a sentence carries in brackets.
 *
 * "The code carries mint (create new tokens out of thin air, diluting
 * every holder); pause (freeze every transfer); blacklist (block chosen
 * wallets from selling)" is three lines, and two of them are a glossary.
 * That glossary is the point of this project — somebody who has never read
 * a token contract should not have to know what "mint" means — so deleting
 * it would be deleting the reason the page exists.
 *
 * Hierarchy instead of deletion: the claim reads at full weight, the
 * glossary sits behind it. A reader who knows the words skims past them; a
 * reader who does not still has them, in place, no click required.
 *
 * Only prose in brackets is dimmed. An address or a figure in brackets is
 * evidence, not explanation, and dimming it would bury the thing somebody
 * came to check.
 */
function glossed(text: string): string {
  return esc(text).replace(/\(([^()]*\s[^()]*)\)/g, (whole, inner: string) =>
    /0x|\d\s*%|block\s*\d/i.test(inner) ? whole : `<span class="gloss">(${inner})</span>`,
  );
}

function answerCards(notes: DoorNote[]): string {
  // Worst first, and the topic is a tag on the row rather than a heading
  // over a card. Five cards meant five headings, five paragraphs explaining
  // what each heading meant, and a STOP that looked exactly as important as
  // a note about the ticker. One ledger, sorted, says which line to read
  // first by putting it first.
  const RANKED: Record<Level, number> = { stop: 0, watch: 1, info: 2 };
  const mine = notes
    .filter((n) => topicOf(n.code) !== "unread")
    .map((n, i) => ({ n, i, topic: topicOf(n.code) }))
    .sort((a, b) => RANKED[a.n.level] - RANKED[b.n.level] || TOPIC_ORDER.indexOf(a.topic) - TOPIC_ORDER.indexOf(b.topic) || a.i - b.i);
  if (!mine.length) return "";

  // Two cells: the level, which is the thing to scan down, and the line.
  // The topic rides inside the line in brackets rather than taking a
  // column of its own — it says which question this answers, not how much
  // it matters, and only one of those deserves a column.
  const row = (x: (typeof mine)[number]) => `<li class="find lv-${x.n.level}">
    <span class="find-level">${x.n.level.toUpperCase()}</span>
    <span class="find-text"><span class="find-topic">[${esc(TOPIC_TAG[x.topic] ?? x.topic)}]</span> ${glossed(x.n.text)}</span>
  </li>`;

  const loud = mine.filter((x) => x.n.level !== "info");
  const quiet = mine.filter((x) => x.n.level === "info");
  // The quiet ones are true and worth having; they are not worth the top of
  // the page. Folded, with a count, so the eye lands on what can cost money.
  const rest = quiet.length
    ? `<details class="find-rest"><summary>${quiet.length} more worth knowing, none of them dangerous</summary><ul class="finds">${quiet.map(row).join("")}</ul></details>`
    : "";
  return `<section class="findings">
    <ul class="finds">${loud.map(row).join("")}</ul>
    ${rest}
  </section>`;
}

/** What did not answer. Its own strip, always, never folded in with the findings. */
function unreadStrip(notes: DoorNote[], skipped: { section: string; reason: string }[]): string {
  const mine = notes.filter((n) => topicOf(n.code) === "unread");
  // No rows, no strip. The guard used to let `skipped` open the box on its
  // own, and every skipped section already becomes a note — so the only way
  // that branch could fire was with a heading saying something went unread
  // above a list saying nothing did.
  if (!mine.length) return "";
  void skipped;
  const rows = mine.map((n) => `<li>${esc(n.text)}</li>`).join("");
  // Still its own block, still always announced, and still never folded in
  // among the findings — a gap listed as a finding reads as a clean result,
  // which is the one mistake this project is built to avoid.
  //
  // But it was the loudest thing on the page after the verdict: a striped
  // box with a heading, a paragraph and four long sentences, sitting above
  // findings that can cost somebody money. The claim it has to make is "N
  // things could not be read", and that claim is in the summary, on screen,
  // always. The four sentences are one click away.
  return `<details class="unread">
    <summary><span class="unread-n">${mine.length}</span> ${mine.length === 1 ? "question BOUNCER could not answer" : "questions BOUNCER could not answer"}<span class="chev" aria-hidden="true"></span></summary>
    <div class="unread-body">
      <p class="what">${esc(TOPIC_BLURB.unread)}</p>
      <ul>${rows}</ul>
    </div>
  </details>`;
}

/**
 * Where to buy it, if the slip has not put you off.
 *
 * Below the verdict and below the answers, never beside them, and the same
 * quiet treatment whatever the verdict says: a buy button that gets louder
 * on a CLEAR is an opinion, and this tool does not have opinions.
 *
 * A venue with no link for this chain is named rather than dropped. Leaving
 * it out silently made BasedBot look broken on every chain but Robinhood,
 * when the truth was that nobody had a working URL for it there.
 */
/**
 * Where to buy it, when there is an "it".
 *
 * `sellable` is the gate, and it was missing. A contract with no readable
 * name, no transfer function and no market still got two buy links under
 * it — and the venue they opened showed "this symbol doesn't exist", which
 * is the same answer the slip already had and had not passed on. Offering
 * to buy a thing this page could not identify is the one recommendation it
 * has no business making.
 */
function buyStrip(chainKey: string, address: string, sellable = true, verdict: "stop" | "watch" | "clear" | "reading" = "clear"): string {
  if (!sellable) {
    return `<section class="buy">
      <div class="buy-head"><h2>Buy it</h2></div>
      <p class="qblurb">No links here. BOUNCER could not establish that this address is a token you can hold or sell, and sending you to a venue to buy it anyway would be the one piece of advice on this page that is not read off the chain.</p>
    </section>`;
  }
  const venues = tradeVenues(chainKey, address);
  if (!venues.length) return "";
  const links = venues
    .map(
      (v) =>
        `<a class="buy-link" href="${esc(v.url)}" target="_blank" rel="noopener nofollow sponsored">
          <span class="buy-name">${esc(v.name)}</span>
          <span class="buy-what">${esc(v.what)}</span>
          <span class="buy-go" aria-hidden="true">↗</span>
        </a>`,
    )
    .join("");
  const missing = missingVenues(chainKey);
  const gap = missing.length
    ? `<p class="buy-gap">${esc(missing.join(" and "))} ${missing.length === 1 ? "is" : "are"} not linked on this chain: BOUNCER has no confirmed address for ${missing.length === 1 ? "it" : "them"} here, and a guessed link is a dead one.</p>`
    : "";
  // The strip takes the verdict's word for it. A neutral "buy it" heading
  // under a red STOP reads as the page arguing with itself, and a reader who
  // scrolled straight here should meet the finding, not the links.
  const head = verdict === "stop" ? "Buy it anyway?" : "Buy it";
  const lead =
    verdict === "stop"
      ? "The slip above says STOP: something here can cost you money outright. The links are not hidden — this page does not decide for anybody — but read the red lines first, because nothing on the other side of them will."
      : verdict === "watch"
        ? "The slip above has things worth reading first. These open the token on someone else's venue; BOUNCER cannot trade and holds no key."
        : "BOUNCER cannot trade and holds no key. These open the token on someone else's venue. Read the slip above first; nothing here changes what it says.";
  return `<section class="buy${verdict === "stop" ? " buy-stop" : ""}">
    <div class="buy-head"><h2>${head}</h2></div>
    <p class="qblurb">${lead}</p>
    <div class="buy-links">${links}</div>
    ${gap}
  </section>`;
}

/**
 * One collapsible section of a slip. Shared by every renderer: it used to be a
 * local inside renderSlip, which meant the Solana slip referred to a name that
 * did not exist there and threw for every visitor.
 */
/**
 * One collapsed section of evidence.
 *
 * The explanation used to sit in the summary, so eleven closed sections
 * printed eleven sentences describing what each section would contain —
 * scaffolding about the page, not facts about the token, on screen forever
 * and re-read never. It moved inside: a reader who opens the section is
 * the one who wanted to know what it covers.
 */
function section(id: string, title: string, what: string, body: string, open: boolean): string {
  return `<details class="sec" id="${id}"${open ? " open" : ""}><summary><h2>${title}</h2><span class="chev" aria-hidden="true"></span></summary><div class="body"><p class="what">${what}</p>${body}</div></details>`;
}

async function runSolanaDoor(address: string): Promise<void> {
  if (!isSolanaAddress(address)) return bad("Paste a Solana mint address: 32 bytes written in base58, which looks like EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.");
  const run = ++doorRun;
  busy("reading the mint account…");

  // Two renders, for the same reason the EVM door has three. The mint
  // account and its metadata come back in one request; they carry the three
  // answers that matter most on this chain — can they print more, can they
  // freeze you, what does a transfer cost. The holder list and the pools are
  // several reads each, and getTokenLargestAccounts is both the slowest of
  // them and the one free endpoints refuse most often.
  // One client for both passes, so the second gets the first one's answers
  // for nothing — the mint account and its metadata are read once.
  const rpc = solanaRpcFor(true);
  let opened = false;
  try {
    const first = await readSplDoor(rpc, address, chain(), { skipHolders: true, skipMarket: true });
    if (run !== doorRun) return;
    renderSplSlip(first, { stage: "opening" });
    opened = true;
    status.textContent = `${chain().name} · slot ${first.at.slot} · ${SOL_STILL_READING}…`;
  } catch {
    // The full read below asks the same questions and will say what went wrong.
  }

  try {
    const slip = await readSplDoor(rpc, address, chain());
    if (run !== doorRun) return;
    if (opened) keepPlace(() => renderSplSlip(slip));
    else renderSplSlip(slip);
    ready();
  } catch (error) {
    if (run !== doorRun) return;
    if (opened) {
      go.disabled = false;
      status.textContent = `${chain().name} · the slower sections did not answer: ${error instanceof Error ? error.message : String(error)}`;
    } else {
      failed(error, address);
    }
  } finally {
    go.disabled = false;
  }
}

/**
 * When a Solana reading was taken, said truthfully.
 *
 * "slot N" was the slot the reading STARTED at, printed beside a claim
 * that everything was read at one block. On Solana nothing pins a slot:
 * the sections go out as separate requests and each is served at whatever
 * slot its node had reached, so the honest unit is a range. A spread of a
 * few slots is a second of wall clock and not worth a word; a wide one
 * means the holder list and the pool balance below it describe different
 * moments, and a reader comparing them should know before they do.
 */
function solanaWhen(slip: SplSlip): string {
  const span = slip.at.span;
  if (!span || span.spread === 0) return `slot ${slip.at.slot}`;
  if (span.spread <= 4) return `slot ${span.last}`;
  return `slots ${span.first}–${span.last} · ${span.spread} apart`;
}

function renderSplSlip(slip: SplSlip, opts: { stage?: Stage } = {}): void {
  // Last render only; see renderSlip for why a mid-read slip must not be
  // reported as an incomplete check.
  const stage0 = opts.stage ?? "done";
  const coverage = stage0 === "done" ? splCoverage(slip) : undefined;
  noteRender(stage0, verdictOf(slip.notes as DoorNote[], stage0, coverage).word);
  const m = slip.mint;
  const sym = slip.metadata?.symbol ? esc(slip.metadata.symbol) : shortSol(slip.subject);
  const name = slip.metadata?.name ? esc(slip.metadata.name) : slip.whatItIs ? esc(slip.whatItIs) : "no on-chain name";
  const ext = (kind: string) => m?.extensions.find((e) => e.kind === kind);
  const fee = ext("transfer-fee");
  const frozenByDefault = ext("default-account-state");
  const blocked = Boolean(m?.freezeAuthority) || Boolean(ext("non-transferable")) || (frozenByDefault?.kind === "default-account-state" && frozenByDefault.frozen);
  const tiles = m
    ? `<div class="tiles">
        <div class="tile"><div class="l">Can they freeze you?</div><div class="v ${m.freezeAuthority ? "bad" : ""}">${m.freezeAuthority ? "YES" : "NO"}</div><div class="s">${m.freezeAuthority ? `${esc(shortSol(m.freezeAuthority))} can stop any holder selling` : "the freeze authority is not set and cannot come back"}</div></div>
        <div class="tile"><div class="l">Can they print more?</div><div class="v ${m.mintAuthority ? "bad" : ""}">${m.mintAuthority ? "YES" : "NO"}</div><div class="s">${m.mintAuthority ? `${esc(shortSol(m.mintAuthority))} holds the mint authority` : "the supply is fixed for good"}</div></div>
        <div class="tile"><div class="l">Tax per transfer</div><div class="v ${fee?.kind === "transfer-fee" && fee.feeBps >= 500 ? "bad" : ""}">${fee?.kind === "transfer-fee" ? `${(fee.feeBps / 100).toFixed(2)}%` : "0%"}</div><div class="s">${fee?.kind === "transfer-fee" ? (fee.nextFeeBps !== fee.feeBps ? `changing to ${(fee.nextFeeBps / 100).toFixed(2)}% at epoch ${fee.nextFeeEpoch}` : fee.feeAuthority ? "and it can still be changed" : "fixed for good") : "no Token-2022 transfer fee"}</div></div>
        <div class="tile"><div class="l">Top 10 holders</div><div class="v ${slip.holders && slip.holders.top10Bps !== null && slip.holders.top10Bps >= 5_000 ? "bad" : ""}">${slip.holders && slip.holders.top10Bps !== null ? `${(slip.holders.top10Bps / 100).toFixed(0)}%` : "—"}</div><div class="s">${slip.holders?.distinctOwners ? `of supply · ${slip.holders.distinctOwners} distinct wallets` : "not read"}</div></div>
      </div>`
    : "";
  const explorer = chain().explorerUrl;
  const link = (addr: string) => (explorer ? `<a href="${esc(explorer)}/account/${esc(addr)}" target="_blank" rel="noopener"><span class="mono">${esc(shortSol(addr))}</span></a>` : `<span class="mono">${esc(shortSol(addr))}</span>`);
  const idBody = m
    ? `<dl class="kv">
        <dt>chain</dt><dd>${esc(slip.chain.name)} · no launchpad known here, so this is the ordinary-token check</dd>
        <dt>program</dt><dd>${m.token2022 ? "Token-2022, which is where fees, hooks and delegates live" : "SPL Token, the classic program with no extensions"}</dd>
        <dt>supply</dt><dd>${esc(formatSupply(m.supply, m.decimals))} · ${m.decimals} decimals</dd>
        <dt>mint authority</dt><dd>${m.mintAuthority ? `${link(m.mintAuthority)} <span class="flag bad">can print more</span>` : '<span class="flag ok">none</span> the supply is fixed'}</dd>
        <dt>freeze authority</dt><dd>${m.freezeAuthority ? `${link(m.freezeAuthority)} <span class="flag bad">can stop a holder selling</span>` : '<span class="flag ok">none</span> holders cannot be frozen'}</dd>
        ${slip.metadata ? `<dt>name</dt><dd>${esc(slip.metadata.name)} (${esc(slip.metadata.symbol)}) · ${slip.metadata.isMutable ? '<span class="flag bad">can be renamed</span>' : '<span class="flag ok">frozen</span>'} · ${slip.metadataInline ? "from the Token-2022 extension" : "from Metaplex"}</dd>` : ""}
      </dl>`
    : `<dl class="kv"><dt>what it is</dt><dd>${esc(slip.whatItIs ?? "not an SPL mint")}</dd></dl>`;
  const extBody = m && m.extensions.length
    ? `<div class="tbl"><table class="buys"><thead><tr><th>extension</th><th>what it means for a holder</th></tr></thead><tbody>${m.extensions
        .map((e) => `<tr><td><span class="mono">${esc(e.kind)}</span></td><td>${esc(SPL_EXTENSION_MEANING[e.kind] ?? "not read here")}</td></tr>`)
        .join("")}</tbody></table></div>`
    : "";
  const holdersBodyText = slip.holders && slip.holders.top.length
    ? `<dl class="kv"><dt>distinct wallets</dt><dd>${slip.holders.distinctOwners ?? "unknown"} among the ${slip.holders.top.length} largest accounts</dd>
        <dt>top 10</dt><dd>${slip.holders.top10Bps === null ? "unknown" : `${(slip.holders.top10Bps / 100).toFixed(1)}% of supply`}</dd></dl>
      <div class="tbl"><table class="buys"><thead><tr><th>#</th><th>wallet</th><th>share</th></tr></thead><tbody>${slip.holders.top
        .slice(0, 15)
        .map((h, i) => `<tr><td>${i + 1}</td><td>${h.owner ? link(h.owner) : `${link(h.account)} <span class="flag">account</span>`}</td><td>${h.bps === null ? "unknown" : `${(h.bps / 100).toFixed(2)}%`}</td></tr>`)
        .join("")}</tbody></table></div>`
    : "";

  out.innerHTML = `<div class="slip">
    ${verdictBlock({
      sym,
      name,
      address: slip.subject,
      stamp: slip.stamp,
      at: `${esc(slip.chain.name)} · ${esc(solanaWhen(slip))}${slip.at.timestamp ? ` · ${isoUtc(slip.at.timestamp)}` : ""}`,
      notes: slip.notes as DoorNote[],
      lead: splSentence(slip, blocked),
      stage: stage0,
      coverage,
      tiles,
      stillReading: SOL_STILL_READING,
      actions: `<button class="ghost primary" id="act-share" type="button">Copy card</button><button class="ghost" id="act-link" type="button">Copy link</button><button class="ghost" id="act-json" type="button">JSON</button>`,
    })}
    ${answerCards(slip.notes as DoorNote[])}
    ${unreadStrip(slip.notes as DoorNote[], slip.skipped)}
    ${buyStrip(slip.chain.key, slip.subject, Boolean(slip.mint), verdictOf(slip.notes as DoorNote[], "done", coverage).kind)}
    <div class="stack">
      ${section("s-id", "Is it real?", "What this address actually is, who can print more of it, and who can freeze what you hold.", idBody, false)}
      ${extBody ? section("s-ext", "Token-2022 extensions", "The rules the token program itself enforces on every transfer.", extBody, false) : ""}
      ${holdersBodyText ? section("s-holders", "Who holds it", "The largest token accounts and the wallets behind them.", holdersBodyText, false) : ""}
    </div>
  </div>`;
  // Copy card, on the renderer that draws the button.
  //
  // This handler was registered in renderSlip — the EVM one — against a
  // DoorSlip, which meant two things at once: pressing Copy card on an
  // EVM token ran it a SECOND time and overwrote the good card with an
  // SPL card built from a slip that has no mint, and pressing it on a
  // Solana token did nothing at all, because the button the Solana
  // renderer draws had no listener on the page it was drawn on.
  // flow-check only asked whether a PNG reached the clipboard, and one
  // always did.
  $("act-share").addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const sym = slip.metadata?.symbol ?? slip.subject.slice(0, 10);
      noteCard("spl", slip.metadata?.symbol ?? slip.subject);
      const svg = splCard(slip, { repoUrl: REPO, ticker: MARK, mascotSvg: MASCOT_SVG_INNER, checkUrl: shareBase(), lead: splSentence(slip, blocked) });
      const how = await copyCardImage(svg, `bouncer-${sym.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
      showToast(how === "copied" ? "Card copied — paste it anywhere" : "Your browser would not take an image; the card was downloaded instead");
    } finally {
      button.disabled = false;
    }
  });
  $("act-json").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(slipJson(slip)); showToast("JSON copied"); } catch { showToast("Clipboard blocked; use the CLI --format json"); }
  });
  $("act-link").addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}#/t/${slip.subject}?chain=${chain().key}`;
    try { await navigator.clipboard.writeText(url); showToast("Link copied"); } catch { showToast(url); }
  });
  wireRetry();
}

/**
 * The retry, wired wherever a completeness band drew one.
 *
 * It re-runs the route rather than re-running only the sections that
 * failed, and that is a deliberate trade. Re-reading one section means
 * splicing a fresh answer into a slip read at a different block or slot,
 * which is how a page ends up showing a holder list and a pool that never
 * coexisted. A whole re-read costs a couple of seconds and everything on
 * screen afterwards is one moment.
 *
 * The client's memo makes it cheaper than it sounds: the reads that
 * ANSWERED last time are still in hand, so what actually goes back out is
 * roughly the part that failed.
 */
function wireRetry(): void {
  const button = document.getElementById("act-retry") as HTMLButtonElement | null;
  if (!button) return;
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Reading again…";
    // Straight to route(), not through submit(): the address is already
    // resolved and in the URL, and going back through the box would
    // re-run chain detection on an address whose chain is settled.
    route();
  });
}

const SPL_EXTENSION_MEANING: Record<string, string> = {
  "transfer-fee": "every transfer pays a percentage to the token, and someone may be able to raise it",
  "permanent-delegate": "one address can move or burn your tokens without your signature",
  "transfer-hook": "someone's program runs on every transfer and can make it fail",
  "mint-close-authority": "the mint account can be closed once the supply is zero",
  "default-account-state": "new holders may start frozen, unable to sell until unfrozen",
  "non-transferable": "the token cannot be sent to anyone at all",
  pausable: "every transfer can be paused",
  "interest-bearing": "the displayed balance grows by rule; the real amount does not",
  "metadata-pointer": "where the name and symbol live",
  "token-metadata": "the name and symbol, stored on the mint itself",
};

function splSentence(slip: SplSlip, blocked: boolean): string {
  const m = slip.mint;
  if (!m) return `This address is not a token: it is ${slip.whatItIs ?? "not an SPL mint"}.`;
  const parts: string[] = [];
  if (m.freezeAuthority) parts.push("somebody can freeze your account, which is how a holder is stopped from selling");
  else parts.push("nobody can freeze your account");
  parts.push(m.mintAuthority ? "somebody can print more" : "the supply is fixed");
  const fee = m.extensions.find((e) => e.kind === "transfer-fee");
  if (fee?.kind === "transfer-fee") parts.push(`every transfer pays ${(fee.feeBps / 100).toFixed(2)}%${fee.nextFeeBps !== fee.feeBps ? `, rising to ${(fee.nextFeeBps / 100).toFixed(2)}%` : ""}`);
  if (m.extensions.some((e) => e.kind === "permanent-delegate")) parts.push("a permanent delegate can take your tokens");
  if (m.extensions.some((e) => e.kind === "transfer-hook")) parts.push("someone's program runs on every transfer");
  if (blocked && !m.freezeAuthority) parts.push("transfers are blocked by the token's own rules");
  if (slip.holders?.top10Bps != null) parts.push(`the 10 largest wallets hold ${(slip.holders.top10Bps / 100).toFixed(0)}%`);
  return parts.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(". ") + ".";
}

function shortSol(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

function formatSupply(value: bigint, decimals: number): string {
  const whole = value / 10n ** BigInt(decimals);
  return whole.toLocaleString("en-US");
}

function openDoorSentence(slip: DoorSlip): string {
  const t = slip.id.token;
  if (t.code.empty) return `There is no contract at this address on ${slip.chain.name}.`;
  if (t.code.delegatedTo) return `This is a wallet, not a token: its code is an EIP-7702 delegation its owner signed.`;
  const parts: string[] = [];
  const impostor = impostorOf(slip);
  if (impostor) parts.push(`an older ${slip.chain.launchpad ?? "launchpad"} launch is called ${slip.lookalikes!.query} and this is not it`);
  if (slip.known) parts.push(`this is ${slip.known.replace(/\.$/, "")}`);
  else parts.push(slip.chain.launchpad ? `not a ${slip.chain.launchpad} launch, checked as an ordinary token` : `checked as an ordinary token: no launchpad BOUNCER knows runs on ${slip.chain.name}`);
  if (t.proxyImplementation || t.code.minimalProxyTarget) parts.push("its code can be replaced (proxy)");
  if (t.code.opcodes.selfdestruct) parts.push("it can self-destruct");
  const o = slip.open;
  if (o) {
    if (o.surfaceFrom === "implementation-unreadable") {
      parts.push("the code it actually runs could not be read, so what it can do is unknown");
      return sentence(parts);
    }
    const kinds = powerKinds(o).filter((k) => k !== "exempt" && k !== "sweep");
    if (o.paused === true) parts.push("paused() is true");
    if (o.tradingOpen && !o.tradingOpen.open) parts.push("its trading switch is off");
    if (kinds.length) parts.push(`the code carries ${kinds.join(", ")}${o.owner && !o.owner.renounced ? " and ownership is not renounced" : o.owner?.renounced ? " but ownership is renounced" : ""}`);
    else if (o.owner?.renounced) parts.push("ownership renounced, no special powers seen");
    else if (o.owner) parts.push("has an owner but no mint, pause, blacklist or fee switch was seen");
    const sell = sellProbes(o);
    const move = moveProbes(o);
    const verdict = (ps: typeof sell, yes: string, no: string, some: string) => {
      const reverted = ps.filter((p) => p.status === "reverts").length;
      const ok = ps.filter((p) => p.status === "ok").length;
      if (!ok && !reverted) return null;
      if (reverted && !ok) return no;
      if (reverted) return some;
      return yes;
    };
    const sellSays = verdict(sell, "a 1-unit sale into the pool goes through", "a 1-unit sale into the pool reverts", "some wallets cannot send into the pool");
    if (sellSays) parts.push(sellSays);
    else {
      const moveSays = verdict(move, "a 1-unit transfer to a fresh wallet goes through", "a 1-unit transfer reverts", "some wallets cannot transfer");
      if (moveSays) parts.push(moveSays);
    }
    if (o.holders?.top10WalletsBps != null) parts.push(`the 10 largest wallets hold ${(o.holders.top10WalletsBps / 100).toFixed(0)}%`);
    if (o.deployer?.createdAt) parts.push(`deployed ${formatDuration(Math.max(0, slip.at.timestamp - o.deployer.createdAt))} ago`);
  }
  return sentence(parts);
}

/**
 * The lead, and only the lead.
 *
 * It used to print every clause the reader could want, which on an
 * ordinary token ran to five sentences — and the question cards under it
 * then said the same things again in the same words. A summary that is as
 * long as the thing it summarises is not a summary, it is a first draft.
 *
 * Two, now that the findings are a sorted ledger forty pixels below it.
 * Three meant the top of the page printed three sentences and then the
 * ledger printed the same three again, in the same words, in the same
 * order.
 *
 * Not one, because the first clause is always identity — "real Pons V2
 * launch", "not a launch, checked as an ordinary token" — and identity
 * alone tells a reader nothing about what to do next. Two is the name of
 * the thing plus the single most important fact about it; the ledger,
 * which is right there and sorted worst-first, carries all of it.
 */
const LEAD_CLAUSES = 2;

function sentence(parts: string[]): string {
  const kept = parts.slice(0, LEAD_CLAUSES);
  return kept.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(". ") + ".";
}

/**
 * Keeps what the reader had open across a re-render.
 *
 * The slip is rebuilt from scratch when the slow half arrives, and a
 * rebuild that silently closes the section somebody was reading, and jumps
 * them to the top, is worse than the wait it replaced.
 */
function keepPlace(render: () => void): void {
  const open = [...document.querySelectorAll<HTMLDetailsElement>("details.sec[open]")].map((d) => d.id).filter(Boolean);
  const y = window.scrollY;
  render();
  for (const id of open) document.getElementById(id)?.setAttribute("open", "");
  if (y) window.scrollTo({ top: y, behavior: "auto" });
}

/** Where the card tells a reader to go and check for themselves. */
function shareBase(): string {
  return `${location.host}${location.pathname}`.replace(/\/$/, "");
}

/**
 * The share card, as a PNG in the clipboard.
 *
 * "Copy" and not "download", because the thing people do with this is
 * paste it into a chat. A download puts a file in a folder and asks them
 * to go find it.
 *
 * The SVG is self-contained on purpose — no fetched fonts, no external
 * images — which is what makes this possible at all: an <img> with a data
 * URL of an SVG that referenced anything remote would taint the canvas and
 * the export would throw on read.
 *
 * Two things can refuse: a browser without ClipboardItem (Firefox, until
 * recently) and a page the user has not interacted with. Both fall back to
 * a download rather than to nothing.
 */
async function copyCardImage(svg: string, filename: string): Promise<"copied" | "downloaded"> {
  const scale = 2; // a 2400×1260 paste stays sharp on a retina screen
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const png = await new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 1200 * scale;
        canvas.height = 630 * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no 2d context"));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((out) => (out ? resolve(out) : reject(new Error("canvas produced nothing"))), "image/png");
      };
      img.onerror = () => reject(new Error("the card did not render"));
      img.src = url;
    });
    // ClipboardItem is the only way to put an image on the clipboard, and
    // Safari wants the promise handed to it rather than the resolved blob.
    const Item = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (Item && navigator.clipboard && "write" in navigator.clipboard) {
      await navigator.clipboard.write([new Item({ "image/png": png })]);
      return "copied";
    }
    download(png, filename);
    return "downloaded";
  } catch {
    download(blob, filename.replace(/\.png$/, ".svg"));
    return "downloaded";
  } finally {
    URL.revokeObjectURL(url);
  }
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * What the page has drawn, in order, with the millisecond it was drawn at.
 *
 * The staged render is a claim about time, and the only honest way to check
 * a claim about time is to have the thing being claimed about say when it
 * happened. Watching the DOM from outside does not work: a MutationObserver
 * reports after a microtask checkpoint, so three renders a millisecond
 * apart — which is exactly what the demo chain produces, having no network
 * to hide behind — arrive as one. The check called that a collapsed
 * staging, which was wrong about the page and right to complain about
 * itself.
 *
 * Bounded, because a page left open all day still renders on every watch
 * tick.
 */
declare global {
  interface Window {
    __bouncerRenders?: { stage: Stage; at: number; word: string }[];
    __bouncerWire?: { url: string; at: number; ms: number; ok: boolean; done: boolean; status: number; why: string }[];
    __bouncerCards?: { kind: string; ticker: string; at: number }[];
  }
}

/**
 * Every request the page makes, with when it left and how long it took.
 *
 * Twice now a slow read has been explained by reading the code, and twice
 * the explanation was wrong — once the log scan, once the eth_call count,
 * both confidently, both nowhere near it. The number that settled it each
 * time came from a per-request log, and the one in RpcClient stops at the
 * chain: the explorer is a different client on a different server, and on
 * the runs that hurt it is the one holding things up. A wrapper around
 * fetch sees both, in one clock, in the order they actually went out.
 *
 * It records and returns; it never changes an answer, a header or a
 * failure. Bounded, and read by scripts/speed-check.mjs to say WHERE a
 * cold read spent its seconds instead of only how many there were.
 */
{
  const inner = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const log = (window.__bouncerWire ??= []);
    const url = String(input instanceof Request ? input.url : input);
    const started = performance.now();
    // Recorded when it LEAVES, not when it comes back.
    //
    // The first version only logged on settle, which hid the one request a
    // reader most needs explained: the one that never answered. A read that
    // took six seconds showed five entries of a hundred and seventy
    // milliseconds each and nothing else, because whatever was holding it up
    // was still in the air when the log was read. `done: false` is the
    // entry that matters.
    const entry = { url, at: Math.round(started), ms: 0, ok: false, done: false, status: 0, why: "" };
    if (log.length < 400) log.push(entry);
    try {
      const response = await inner(input, init);
      entry.ms = Math.round(performance.now() - started);
      entry.ok = response.ok;
      // WHY it failed, not just that it did.
      //
      // A bare "!" next to /rpc/base had me reading the proxy's source
      // guessing between a blocked method, an oversized batch and an
      // upstream rate limit — three different fixes, and the log knew the
      // answer all along. A status is one number and it ends the argument.
      entry.status = response.status;
      entry.done = true;
      return response;
    } catch (error) {
      entry.ms = Math.round(performance.now() - started);
      // A throw is the network, not the server: no status exists, so say so
      // rather than leave a zero that reads like one.
      entry.why = error instanceof Error ? error.message : String(error);
      entry.done = true;
      throw error;
    }
  };
}

/**
 * Every card this page builds, and what it was about.
 *
 * The copy path had two handlers bound to one button for months: the
 * good card went to the clipboard and an SPL card built from an EVM slip
 * went straight over it. flow-check watched the clipboard and saw a PNG
 * both times, so it passed — and the preview path, which the check can
 * read, was never the broken one.
 *
 * A clipboard image cannot be read back as text, so the page says what
 * it put there. One press, one entry, naming the token: a second handler
 * shows up as a second entry, and a card about the wrong token shows up
 * in the name.
 */
function noteCard(kind: "door" | "spl", ticker: string): void {
  const log = (window.__bouncerCards ??= []);
  if (log.length < 50) log.push({ kind, ticker, at: Math.round(performance.now()) });
}

function noteRender(stage: Stage, word: string): void {
  const log = (window.__bouncerRenders ??= []);
  if (log.length < 200) log.push({ stage, at: Math.round(performance.now()), word });
}

function renderSlip(slip: DoorSlip, opts: { stage?: Stage } = {}): void {
  const stage0 = opts.stage ?? "done";
  // Only on the last render. The EVM door paints three times off one paste,
  // and on the first two most sections genuinely have not been read yet —
  // reporting that as an incomplete CHECK would put an alarm on every
  // token for the first second and a half, which is the fastest way to
  // train a reader to ignore it. The stage line above already says what is
  // still coming.
  const coverage = stage0 === "done" ? doorCoverage(slip) : undefined;
  noteRender(stage0, verdictOf(slip.notes, stage0, coverage).word);
  const meta = slip.id.meta;
  const c0 = chain();
  const explorer = c0.blockscout ? `${c0.blockscout}/address/${slip.subject}` : null;
  const sym = meta ? esc(meta.symbol) : shortAddress(slip.subject);
  const name = meta ? esc(meta.name) : slip.known ? "known contract, not a launch" : slip.id.token.code.empty ? "no contract at this address" : "contract without a name";
  const o = slip.open;
  const tradesText = o ? tradesBody(slip) : "";
  const qd = slip.rules?.quote ?? slip.chain.native;
  const amt = (v: bigint) => `${formatUnits(v, qd.decimals)} ${esc(qd.symbol)}`;
  const c = slip.cover;
  const r = slip.rules;
  const room = slip.room;
  const e = slip.exit;
  const crew = slip.crew;
  const l = slip.lookalikes;
  const d = slip.dev;
  const t = slip.id.token;
  const registered = slip.id.registered;

  // ---- the four numbers people ask for first
  const v1 = slip.id.v1;
  const tiles = v1
    ? `<div class="tiles">
        <div class="tile"><div class="l">Launch caps</div><div class="v ${v1.restrictionBlocksLeft > 0 ? "open" : "closed"}">${v1.restrictionBlocksLeft > 0 ? `${v1.restrictionBlocksLeft}` : "OFF"}</div><div class="s">${v1.restrictionBlocksLeft > 0 ? `blocks left · max ${v1.config ? formatBps(v1.config.maxWalletBps) : "?"} per wallet` : "wallet and trade caps lifted"}</div></div>
        <div class="tile"><div class="l">Pool fee</div><div class="v">${Number(v1.record.poolFee) / 10_000}%</div><div class="s">Uniswap V3 · position #${v1.record.positionId} locked</div></div>
        <div class="tile"><div class="l">Towards graduation</div><div class="v">${v1.status.threshold === 0n ? "—" : `${Number((v1.status.pairedPrincipal * 100n) / v1.status.threshold)}%`}</div><div class="s">${formatUnits(v1.status.pairedPrincipal, v1.quote.decimals)} of ${formatUnits(v1.status.threshold, v1.quote.decimals)} ${esc(v1.quote.symbol)}${v1.status.graduated ? " · graduated" : ""}</div></div>
        <div class="tile"><div class="l">Dev bought at launch</div><div class="v">${formatUnits(v1.record.initialBuyAmount, v1.quote.decimals, 3)}</div><div class="s">${esc(v1.quote.symbol)} in the launch transaction</div></div>
      </div>`
    : registered
    ? `<div class="tiles">
        <div class="tile"><div class="l">Door tax</div><div class="v ${c?.status === "open" ? "open" : "closed"}" id="cd">${c ? (c.status === "open" ? `${c.secondsLeft}s` : c.status === "closed" ? "OFF" : "OFF") : "OFF"}</div><div class="s" id="cd-note">${c ? (c.status === "open" ? `left, then it is safe to buy` : c.status === "closed" ? `ended ${formatDuration(Math.max(0, c.head.timestamp - c.windowEndsAt))} ago` : "disabled for this launch") : "ended long ago"}</div></div>
        <div class="tile"><div class="l">Fee per trade</div><div class="v ${r && r.totalTradeBps >= 1_000n ? "bad" : ""}">${r ? formatBps(r.totalTradeBps) : "—"}</div><div class="s">${r ? `${formatBps(r.creatorTaxBps)} of it to the creator` : ""}</div></div>
        <div class="tile"><div class="l">${room && room.buys > 0 ? "Creator funded" : "Curve full"}</div><div class="v ${room && room.devShareBps >= 5_000 ? "bad" : ""}">${room && room.buys > 0 ? `${(room.devShareBps / 100).toFixed(0)}%` : r?.fill ? `${(r.fill.bps / 100).toFixed(0)}%` : "—"}</div><div class="s">${room && room.buys > 0 ? `of all buys · ${room.buyers} buyers` : r?.fill ? "of the way to graduation" : ""}</div></div>
        <div class="tile"><div class="l">This dev before</div><div class="v ${d && d.counts.launched >= 5 && d.counts.graduated === 0 ? "bad" : ""}">${d ? `${d.counts.launched}` : "—"}</div><div class="s">${d ? `launch${d.counts.launched === 1 ? "" : "es"} in ${mode === "demo" ? "8" : "24"} h · ${d.counts.graduated} graduated` : ""}</div></div>
      </div>`
    : o
    ? openDoorTiles(slip)
    : "";


  // ---- details, plain words first
  const idFlags = (x: typeof t) => {
    const f: string[] = [];
    if (x.proxyImplementation) f.push(`<span class="flag bad">upgradeable proxy → ${shortAddress(x.proxyImplementation)}</span>`);
    if (x.code.minimalProxyTarget) f.push(`<span class="flag bad">minimal proxy</span>`);
    if (x.code.opcodes.selfdestruct) f.push(`<span class="flag bad">can self-destruct ×${x.code.opcodes.selfdestruct}</span>`);
    if (x.code.opcodes.delegatecall) f.push(`<span class="flag bad">DELEGATECALL ×${x.code.opcodes.delegatecall}</span>`);
    if (x.code.opcodes.callcode) f.push(`<span class="flag bad">CALLCODE</span>`);
    if (x.code.opcodes.create || x.code.opcodes.create2) f.push(`<span class="flag">deploys contracts</span>`);
    if (!f.length && !x.code.empty) f.push(`<span class="flag ok">fixed code · no proxy · cannot self-destruct</span>`);
    return f.join("");
  };

  const idBody = `<dl class="kv">
    <dt>chain</dt><dd>${esc(slip.chain.name)}${slip.chain.launchpad ? ` · ${esc(slip.chain.launchpad)}` : ""}</dd>
    <dt>factory record</dt><dd>${registered ? `<span class="flag ok">yes</span> ${v1 ? "the Pons V1 factory" : "the launchpad's own factory"} deployed this token${slip.id.resolvedAs === "curve" ? " (you pasted its curve)" : ""}` : `<span class="flag ${o ? "" : "bad"}">none</span> ${slip.chain.launchpad ? `neither the ${esc(slip.chain.launchpad)} factory${slip.chain.key === "robinhood" ? " nor the Pons V1 factory" : ""} deployed this address` : `no launchpad BOUNCER knows runs on ${esc(slip.chain.name)}`}${o ? "; checked as an ordinary token below" : ""}`}</dd>
    <dt>token code</dt><dd>${t.code.empty ? "empty (no contract)" : `${t.code.bytes} bytes`}<br>${idFlags(t)}</dd>
    ${slip.id.curve ? `<dt>curve code</dt><dd>${slip.id.curve.code.bytes} bytes<br>${idFlags(slip.id.curve)}</dd>` : ""}
    ${v1 ? `<dt>launchpad</dt><dd>Pons V1</dd><dt>deployer</dt><dd><span class="mono">${esc(v1.record.deployer.toLowerCase())}</span></dd>` : ""}
    ${slip.id.launch ? `<dt>deployer</dt><dd><a href="#/dev/${slip.id.launch.deployer.toLowerCase()}${routeChain()}"><span class="mono">${esc(slip.id.launch.deployer.toLowerCase())}</span></a> <small style="color:var(--dim)">click for their history</small></dd><dt>stage</dt><dd>${({ curve: "on the bonding curve", swept: "curve closed, pool not created yet", pool: "graduated: trades in the locked Uniswap pool", rescued: "graduated (rescued)" } as Record<string, string>)[PHASE_LABEL[slip.id.launch.phase]] ?? PHASE_LABEL[slip.id.launch.phase]}</dd>` : ""}
    ${explorer ? `<dt>explorer</dt><dd><a href="${explorer}" target="_blank" rel="noopener">${mode === "demo" ? "open in Blockscout (demo address, will be empty)" : "open in Blockscout"}</a></dd>` : ""}
  </dl>`;

  let coverBody = "";
  if (c) {
    const buys = c.observed
      .map((b) => `<tr class="${b.creatorWallet ? "exempt" : ""}"><td>${b.secondsAfterLaunch.toFixed(1)} s</td><td>${shortAddress(b.buyer)}${b.creatorWallet ? ' <span class="flag">creator · exempt</span>' : ""}</td><td>${amt(b.quoteIn)}</td><td>${(b.chargeBps / 100).toFixed(1)}%</td></tr>`)
      .join("");
    coverBody = `${c.status === "open" ? `<div class="bar"><i id="cd-bar" style="width:${Math.round((c.secondsLeft / c.terms.seconds) * 100)}%"></i></div>` : ""}
      <dl class="kv">
        <dt>the rule</dt><dd>In the first ${c.terms.seconds} s after launch, a buy pays up to ${formatBps(c.terms.startBps)} of its money to the creator on top of normal fees, falling to zero over the window. The creator's own wallets never pay it.${c.termsChangedSinceLaunch ? ' <span class="flag bad">the factory changed these terms after this launch</span>' : ""}</dd>
        <dt>launched</dt><dd>${isoUtc(c.launch.timestamp)} · block ${c.launch.block}</dd>
        <dt>now</dt><dd>${esc(coverChargeLine(c))}</dd>
      </dl>
      ${c.observed.length ? `<div class="tbl"><table class="buys"><thead><tr><th>after launch</th><th>buyer</th><th>spent</th><th>paid at the door</th></tr></thead><tbody>${buys}</tbody></table></div>` : `<p style="color:var(--muted);font-size:13px;margin:8px 0 0">No buys landed inside the window.</p>`}`;
  } else if (registered) {
    coverBody = `<p style="color:var(--muted);margin:0">This launch is older than the search window; the door tax ended long ago and was not read.</p>`;
  }

  const rulesBody = r ? `<ol class="rules">${r.rules.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : "";

  const exitBody = e
    ? `<p style="margin:0 0 4px;color:var(--muted);font-size:13px">If you held ${formatUnits(e.position, 18, 0)} tokens (1% of supply) and sold now on the ${e.venue === "pool" ? "pool" : "curve"}${e.venue !== "closed" ? ` · ${formatBps(e.feeBps)} fee + ${formatBps(e.creatorTaxBps)} creator tax` : ""}:</p>
        ${e.quotes.length ? `<div class="exit-grid">${e.quotes.map((x) => `<div><span>sell ${x.shareBps / 100}%</span><b class="num">${formatUnits(x.net, qd.decimals)}</b><span>${esc(qd.symbol)} in hand</span><small>${(x.realisedBps / 100).toFixed(1)}% of the quoted price</small></div>`).join("")}</div>` : ""}
        <p style="margin:0;color:var(--dim);font-size:12px">${esc(e.note)}</p>
        <div class="wallet-row"><input id="wallet-q" placeholder="your wallet 0x… to see your own bag on this token" spellcheck="false"><button class="ghost" id="wallet-go" type="button">Show my bag</button></div>`
    : "";

  const roomBody = room
    ? `<dl class="kv">
        <dt>since launch</dt><dd>${esc(roomLine(room))}</dd>
        <dt>bought</dt><dd>${amt(room.totalQuoteIn)} after fees · ${room.buys} buys · ${room.sells} sells</dd></dl>
        ${room.wallets.length ? `<div class="tbl"><table class="buys"><thead><tr><th>wallet</th><th>in</th><th>out</th><th>buys</th></tr></thead><tbody>${room.wallets.slice(0, 8).map((w) => `<tr><td>${shortAddress(w.address)}${w.creatorWallet ? ' <span class="flag">creator</span>' : ""}</td><td>${amt(w.quoteIn)}</td><td>${w.quoteOut ? amt(w.quoteOut) : "—"}</td><td>${w.buys}</td></tr>`).join("")}</tbody></table></div>` : ""}`
    : "";

  const crewBody = crew
    ? `<dl class="kv"><dt>first buyers</dt><dd>${esc(oneCrewLine(crew))}</dd>
        ${crew.crews.slice(0, 3).map((cr, i) => `<dt>group ${i + 1}</dt><dd>${cr.wallets.length} wallets were all funded by <span class="mono">${shortAddress(cr.funder)}</span> before the launch · together ${(cr.shareBps / 100).toFixed(1)}% of all buys</dd>`).join("")}</dl>
        <div class="tbl"><table class="buys"><thead><tr><th>wallet</th><th>got its money from</th><th>bought</th></tr></thead><tbody>${crew.wallets.slice(0, 10).map((w) => `<tr><td>${shortAddress(w.address)}</td><td>${w.creatorWallet ? '<span class="flag">creator wallet</span>' : w.funder ? `${shortAddress(w.funder)} <small style="color:var(--dim)">@${w.fundedAtBlock}</small>` : '<span style="color:var(--dim)">not found</span>'}</td><td>${amt(w.quoteIn)}</td></tr>`).join("")}</tbody></table></div>`
    : "";

  const lookBody = l
    ? `<h3 class="cap">Tokens carrying this ticker</h3><dl class="kv"><dt>${esc(l.query)}</dt><dd>${esc(lookalikeLine(l))}</dd></dl>
        <h3 class="cap">Every one found <b>· the factory decides, not the name</b></h3><div class="tbl"><table class="buys"><thead><tr><th>address</th><th>from the factory?</th><th>stage</th><th>launch block</th></tr></thead><tbody>${l.candidates.slice(0, 8).map((x) => `<tr><td><a href="#/${mode === "demo" ? "demo" : "t"}/${x.address}${routeChain()}">${shortAddress(x.address)}</a>${x.address === l.subject ? " · this one" : ""}</td><td>${x.registered ? '<span class="flag ok">yes</span>' : '<span class="flag bad">no</span>'}</td><td>${x.phase !== null ? PHASE_LABEL[x.phase] : "—"}</td><td>${x.launchBlock ?? "—"}</td></tr>`).join("")}</tbody></table></div>`
    : "";

  const watchBody = `<div class="watchbar"><button class="ghost" id="act-watch" type="button" aria-pressed="false">Start watching</button><span style="color:var(--muted);font-size:13px">Checks every ${mode === "demo" ? "5" : "15"} s while this tab is open: the dev selling or moving tokens, the tax recipient changing, buyback switching, graduation${crew?.crews.length ? `, and ${crew.crews.flatMap((x) => x.wallets).length} grouped wallets leaving together` : ""}. Browser notifications if you allow them.</span></div><div class="events"></div>`;

  out.innerHTML = `<div class="slip">
    ${verdictBlock({
      sym,
      name,
      address: slip.subject,
      stamp: slip.stamp,
      at: `${mode === "demo" ? "DEMO · " : ""}${esc(slip.chain.name)} · block ${slip.at.block} · ${isoUtc(slip.at.timestamp)}`,
      notes: slip.notes,
      lead: summarySentence(slip),
      stage: stage0,
      coverage,
      tiles,
      actions: `<button class="ghost primary" id="act-share" type="button">Copy card</button><button class="ghost" id="act-card" type="button">Preview</button><button class="ghost" id="act-link" type="button">Copy link</button><button class="ghost" id="act-json" type="button">JSON</button>`,
    })}
    <div class="card-wrap" id="card"></div>
    ${answerCards(slip.notes)}
    ${unreadStrip(slip.notes, slip.skipped)}
    ${buyStrip(mode === "demo" ? "" : slip.chain.key, slip.subject, Boolean(slip.id.meta) && slip.open?.transferFunction !== false, verdictOf(slip.notes, "done", coverage).kind)}
    <h2 class="stack-head">The evidence</h2>
    <div class="stack">
      ${section("s-id", "Is it real?", "Did the launchpad's factory deploy this token, and can its code change later?", idBody, false)}
      ${o ? section("s-control", "Who controls it", "Which switches the code has (mint, pause, blacklist, fees), who holds the keys, and whether holders can move tokens right now.", controlBody(slip), false) : ""}
      ${o && tradesText ? section("s-trades", "Where it trades", "Pools on the chain's DEX factories and what they hold, plus the explorer's price feed.", tradesText, false) : ""}
      ${o && (o.holders || o.deployer || o.activity) ? section("s-holders", "Who holds it", "The largest wallets, the deployer's share, what sits in pools and contracts, and when it last moved.", holdersBody(slip), false) : ""}
      ${registered && !v1 ? section("s-cover", "Door tax", `The anti-snipe tax in the first ${c?.terms.seconds ?? 15} seconds, and who paid it.`, coverBody, c?.status === "open") : ""}
      ${r ? section("s-rules", "Fees and rules", "What every trade costs, where the creator's cut goes, what buyback really does.", rulesBody, false) : ""}
      ${v1 ? section("s-v1", "Rules (Pons V1)", "How this older kind of launch works: pool from block one, launch caps, locked liquidity.", `<ol class="rules">${v1.rules.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`, false) : ""}
      ${e ? section("s-exit", "Cash out now", "What you would actually get for selling part or all of a position right now.", exitBody, false) : ""}
      ${room ? section("s-room", "Who is inside", "Every buyer since launch, how much the creator's own wallets put in, buys landing in the same block.", roomBody, false) : ""}
      ${crew ? section("s-crew", "Same funder?", "Where the first buyers got their money. Wallets funded by one address before the launch are one group.", crewBody, false) : ""}
      ${l ? section("s-look", "Same name", "Other tokens with this ticker on the chain, and which one launched first.", lookBody, false) : ""}
      ${d ? section("s-dev", "This dev before", `Everything this deployer launched in the last ${mode === "demo" ? "8" : "24"} h and how it went.`, devSection(d, slip.subject, false, true), false) : ""}
      ${registered && !v1 ? section("s-watch", "Watch for changes", "Get told when the dev moves, right in this tab.", watchBody, new URLSearchParams(location.hash.split("?")[1] ?? "").get("watch") === "1") : ""}
    </div>
  </div>`;

  const cardSvg = () => {
    noteCard("door", slip.id.meta?.symbol ?? slip.subject);
    return doorCard(slip, { repoUrl: REPO, ticker: MARK, mascotSvg: MASCOT_SVG_INNER, checkUrl: shareBase(), lead: summarySentence(slip) });
  };
  $("act-card").addEventListener("click", () => {
    const wrap = $("card");
    if (!wrap.classList.contains("open")) wrap.innerHTML = cardSvg();
    wrap.classList.toggle("open");
  });
  $("act-share").addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const sym = slip.id.meta?.symbol ?? slip.subject.slice(0, 10);
      const how = await copyCardImage(cardSvg(), `bouncer-${sym.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
      showToast(how === "copied" ? "Card copied — paste it anywhere" : "Your browser would not take an image; the card was downloaded instead");
    } finally {
      button.disabled = false;
    }
  });
  $("act-json").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(slipJson(slip)); showToast("JSON copied"); } catch { showToast("Clipboard blocked; use the CLI --format json"); }
  });
  $("act-link").addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}#/${mode === "demo" ? "demo" : "t"}/${slip.subject}${routeChain()}`;
    try { await navigator.clipboard.writeText(url); showToast("Link copied"); } catch { showToast(url); }
  });
  wireRetry();
  const walletGo = document.getElementById("wallet-go");
  if (walletGo) {
    walletGo.addEventListener("click", () => {
      const w = (document.getElementById("wallet-q") as HTMLInputElement).value.trim();
      if (!ADDR.test(w)) { showToast("paste a wallet address"); return; }
      location.hash = `#/wallet/${slip.subject}/${w.toLowerCase()}?chain=${mode === "demo" ? "demo" : chain().key}`;
    });
  }
  const watchButton = document.getElementById("act-watch") as HTMLButtonElement | null;
  if (watchButton) {
    watchButton.addEventListener("click", () => {
      if (watcher) { stopWatch(); watchButton.setAttribute("aria-pressed", "false"); watchButton.textContent = "Start watching"; return; }
      startWatch(slip, $("s-watch"), watchButton);
    });
    if (new URLSearchParams(location.hash.split("?")[1] ?? "").get("watch") === "1") startWatch(slip, $("s-watch"), watchButton);
  }

  if (slip.cover?.status === "open") {
    const cc = slip.cover;
    const started = Date.now();
    ticker = window.setInterval(() => {
      const left = Math.max(0, cc.secondsLeft - Math.floor((Date.now() - started) / 1000));
      const cd = document.getElementById("cd");
      const bar = document.getElementById("cd-bar");
      const note = document.getElementById("cd-note");
      if (!cd) { if (ticker) clearInterval(ticker); return; }
      cd.textContent = left > 0 ? `${left}s` : "OFF";
      if (bar) bar.style.width = `${Math.round((left / cc.terms.seconds) * 100)}%`;
      if (left <= 0) {
        cd.className = "v closed";
        if (note) note.textContent = "ended while you were looking; check again to see who paid";
        if (ticker) clearInterval(ticker);
        ticker = null;
      }
    }, 1000);
  }
}

/**
 * Strips control characters and clips a string that came from somewhere else.
 * A revert reason is written by the contract's author, and an explorer label by
 * whoever the explorer copied it from; neither gets to move the cursor around
 * the page or run on for a kilobyte. Escaping still happens separately.
 */
function clean(text: string, max = 160): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function pctText(bps: number | null): string {
  return bps === null ? "unknown" : `${(bps / 100).toFixed(1)}%`;
}

function money(value: number): string {
  if (!Number.isFinite(value)) return "unreadable";
  if (value === 0) return "$0";
  if (value >= 1) return `$${value.toFixed(2)}`;
  const digits = Math.min(18, Math.max(2, 2 - Math.floor(Math.log10(Math.abs(value)))));
  return `$${value.toFixed(digits)}`;
}

function usdShort(v: number): string {
  return v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`;
}

/** Turns one set of simulations into a tile value: YES, NO, a ratio, or an honest dash. */
function probeVerdict(probes: { status: "ok" | "reverts" | "unread" }[]): { value: string; bad: boolean; note: string } {
  if (!probes.length) return { value: "—", bad: false, note: "not simulated" };
  const ok = probes.filter((p) => p.status === "ok").length;
  const reverted = probes.filter((p) => p.status === "reverts").length;
  if (!ok && !reverted) return { value: "—", bad: false, note: "the node would not run the simulation" };
  if (reverted && !ok) return { value: "NO", bad: true, note: `reverts from ${reverted === 1 ? "the wallet tried" : `all ${reverted} wallets tried`}` };
  if (reverted) return { value: `${ok}/${ok + reverted}`, bad: true, note: "some wallets can, some cannot" };
  return { value: "YES", bad: false, note: `goes through from ${ok === 1 ? "the wallet tried" : `all ${ok} wallets tried`}` };
}

function openDoorTiles(slip: DoorSlip): string {
  const o = slip.open!;
  const kinds = powerKinds(o).filter((k) => k !== "exempt" && k !== "sweep");
  const unreadable = o.surfaceFrom === "implementation-unreadable";
  const ownerV = unreadable ? "?" : o.ownerUnread ? "?" : o.owner === null ? "NONE" : o.owner.renounced ? "GONE" : "KEYS";
  const ownerS = unreadable
    ? "the code it runs could not be read"
    : o.ownerUnread
      ? "owner() did not answer"
      : o.owner === null
        ? "no owner() function"
        : o.owner.renounced
          ? "ownership renounced"
          : `owner ${shortAddress(o.owner.address)}${o.owner.isContract ? " (contract)" : ""}`;
  const sell = probeVerdict(sellProbes(o));
  const h = o.holders;
  return `<div class="tiles">
    <div class="tile"><div class="l">Owner</div><div class="v ${!unreadable && o.owner && !o.owner.renounced && kinds.length ? "bad" : ""}">${ownerV}</div><div class="s">${esc(ownerS)}</div></div>
    <div class="tile"><div class="l">Code can</div><div class="v ${kinds.length ? "bad" : ""}">${unreadable ? "?" : kinds.length || "0"}</div><div class="s">${unreadable ? "the implementation could not be read" : kinds.length ? esc(kinds.join(", ")) : "no mint, pause, blacklist, fee or trading switch seen"}</div></div>
    <div class="tile"><div class="l">Transfer to the pool</div><div class="v ${sell.bad ? "bad" : ""}">${sell.value}</div><div class="s">${esc(sell.note)}</div></div>
    <div class="tile"><div class="l">Top 10 wallets</div><div class="v ${h && h.top10WalletsBps !== null && h.top10WalletsBps >= 5_000 ? "bad" : ""}">${h && h.top10WalletsBps !== null ? `${(h.top10WalletsBps / 100).toFixed(0)}%` : "—"}</div><div class="s">${h ? (h.top10WalletsBps === null ? "supply not readable" : `of supply · ${h.count ?? "?"} holders`) : "explorer not reachable"}</div></div>
  </div>`;
}

function controlBody(slip: DoorSlip): string {
  const o = slip.open!;
  // Three different kinds of thing live in this section and they used to
  // run into each other: what the chain answered, what the code CAN do,
  // and what actually happened when a transfer was tried. Each gets a
  // caption saying which it is.
  const powers = o.powers.length
    ? `<h3 class="cap">What the code can do <b>· read off the bytecode</b></h3><div class="tbl"><table class="buys"><thead><tr><th>function in the code</th><th>lets whoever may call it</th></tr></thead><tbody>${o.powers.map((p) => `<tr><td><span class="mono">${esc(p.signature)}</span></td><td>${esc(POWER_MEANING[p.kind])}</td></tr>`).join("")}</tbody></table></div><p style="color:var(--dim);font-size:12px;margin:6px 0 0">A name in the dispatcher is not a permission. Whether each is guarded by the owner, by a role, or by nothing at all is not readable from bytecode.</p>`
    : o.surfaceFrom === "implementation-unreadable"
      ? `<p style="color:var(--muted);font-size:13px;margin:8px 0 0">The code this proxy points at could not be read, so no function list is shown. Its switches are unknown, not absent.</p>`
      : `<p style="color:var(--muted);font-size:13px;margin:8px 0 0">No mint, pause, blacklist, fee, limit, trading or upgrade function was seen among the ${o.selectors} four-byte selectors in the code.</p>`;
  const probeRows = o.probes.length
    ? `<h3 class="cap">What happened when it was tried <b>· simulated, nothing signed</b></h3><div class="tbl"><table class="buys"><thead><tr><th>simulated</th><th>from</th><th>result</th></tr></thead><tbody>${o.probes
        .map(
          (p) =>
            `<tr><td>${p.target === "pool" ? "sale into the pool" : "transfer to a fresh wallet"}</td><td><span class="mono">${shortAddress(p.from)}</span>${p.source === "deployer" ? ' <span class="flag">deployer</span>' : ""}</td><td>${p.status === "ok" ? '<span class="flag ok">goes through</span>' : p.status === "reverts" ? `<span class="flag bad">reverts</span> ${esc(clean(p.reason ?? ""))}` : `<span class="flag">not run</span> ${esc(clean(p.reason ?? ""))}`}</td></tr>`,
        )
        .join("")}</tbody></table></div><p style="color:var(--dim);font-size:12px;margin:6px 0 0">Run with eth_call from wallets that hold the token; nothing was signed or sent. One unit, at this block: a fee on transfer, a cap on size, or a rule the owner flips tomorrow would not show up here.</p>`
    : o.probesSkipped
      ? `<p style="color:var(--muted);font-size:13px;margin:8px 0 0">No transfer was simulated: ${esc(o.probesSkipped)}.</p>`
      : "";
  return `<h3 class="cap">What the chain answered</h3><dl class="kv">
    <dt>owner</dt><dd>${o.ownerUnread ? "owner() is in the code but the chain would not answer it" : o.owner === null ? "no owner() function in the code" : o.owner.renounced ? '<span class="flag ok">renounced</span> nobody can call owner-only functions' : `<span class="mono">${esc(o.owner.address)}</span>${o.owner.isContract ? " (a contract)" : ""}${o.ownerBalance?.bps != null ? ` · holds ${pctText(o.ownerBalance.bps)}` : ""}${o.ownable ? "" : " · no renounceOwnership()"}`}</dd>
    ${o.paused !== null ? `<dt>paused</dt><dd>${o.paused ? '<span class="flag bad">yes</span>' : '<span class="flag ok">no</span>'}</dd>` : ""}
    ${o.tradingOpen ? `<dt>${esc(o.tradingOpen.view)}</dt><dd>${o.tradingOpen.open ? '<span class="flag ok">true</span> trading is open' : '<span class="flag bad">false</span> trading is switched off'}</dd>` : ""}
    <dt>source</dt><dd>${o.verified === null ? "explorer not reachable" : o.verified ? '<span class="flag ok">verified</span> the code can be read on the explorer' : '<span class="flag bad">not verified</span> only the bytes can be read'}</dd>
    <dt>read from</dt><dd>${o.surfaceFrom === "implementation" ? "the proxy's current implementation" : o.surfaceFrom === "implementation-unreadable" ? '<span class="flag bad">unreadable</span> this is a proxy and its implementation code did not load' : "the token's own bytecode"} · ${o.selectors} four-byte selectors${o.constants > o.selectors ? `, ${o.constants - o.selectors} shorter constants ignored` : ""}</dd>
  </dl>${powers}${probeRows}`;
}

function tradesBody(slip: DoorSlip): string {
  const o = slip.open!;
  const q = slip.chain.native;
  const dec = slip.id.meta?.decimals ?? 18;
  const explorer = chain().blockscout;
  const amount = (v: bigint | null, decimals: number, fraction: number) => (v === null ? "unread" : formatUnits(v, decimals, fraction));
  const pools = o.pools
    ? o.pools.length
      ? `<div class="tbl"><table class="buys"><thead><tr><th>pool</th><th>fee</th><th>W${esc(q.symbol)} inside</th><th>tokens inside</th></tr></thead><tbody>${o.pools.map((p) => `<tr><td>${explorer && mode !== "demo" ? `<a href="${esc(explorer)}/address/${esc(p.address)}" target="_blank" rel="noopener">${esc(p.dex)} · ${shortAddress(p.address)}</a>` : `${esc(p.dex)} · ${shortAddress(p.address)}`}</td><td>${(p.feeBps / 100).toFixed(2)}%</td><td>${amount(p.quoteReserve, q.decimals, 3)}</td><td>${amount(p.tokenReserve, dec, 0)}</td></tr>`).join("")}</tbody></table></div><p style="color:var(--dim);font-size:12px;margin:6px 0 0">Reserves are the pool's balances at this block. Whether the liquidity is locked is not read here, and pools on other venues or against other pairs are not counted.</p>`
      : `<p style="color:var(--muted);font-size:13px;margin:0">No W${esc(q.symbol)} pool on the chain's known DEX factories. It may trade on another DEX, in a Uniswap V4 pool, against another pair, or not at all.</p>`
    : "";
  const feed =
    o.explorer && o.explorer.priceUsd != null
      ? `<dl class="kv"><dt>explorer price</dt><dd>${money(o.explorer.priceUsd)}${o.explorer.volume24hUsd !== null ? ` · ${usdShort(o.explorer.volume24hUsd)} in 24 h` : ""}${o.explorer.marketCapUsd !== null ? ` · ${usdShort(o.explorer.marketCapUsd)} market cap` : ""} <small style="color:var(--dim)">the explorer's feed, not the chain's</small></dd></dl>`
      : "";
  return `${feed}${pools}`;
}

function holdersBody(slip: DoorSlip): string {
  const o = slip.open!;
  const h = o.holders;
  const role = (x: NonNullable<typeof h>["top"][number]) =>
    x.role === "deployer"
      ? '<span class="flag">deployer</span>'
      : x.role === "owner"
        ? '<span class="flag">owner</span>'
        : x.role === "burn"
          ? '<span class="flag ok">burn</span>'
          : x.role === "token"
            ? '<span class="flag">the token</span>'
            : x.delegated
              ? '<span class="flag">wallet · 7702</span>'
              : x.isContract
                ? `<span class="flag">${esc(x.name ?? "contract")}</span>`
                : "";
  const explorer = chain().blockscout;
  return `<h3 class="cap">The shares <b>· from the explorer's holder list</b></h3><dl class="kv">
    ${o.deployer ? `<dt>deployer</dt><dd><span class="mono">${esc(o.deployer.address)}</span> · holds ${pctText(o.deployer.bps)}${o.deployer.createdAt ? ` · deployed ${isoUtc(o.deployer.createdAt)} (${formatDuration(Math.max(0, slip.at.timestamp - o.deployer.createdAt))} ago)` : ""}</dd>` : ""}
    ${h ? `<dt>holders</dt><dd>${h.count ?? "unknown"}${h.transfers !== null ? ` · ${h.transfers} transfers indexed` : ""}</dd>
    <dt>top 10 wallets</dt><dd>${pctText(h.top10WalletsBps)} of supply, over the ${h.rows} rows the explorer returned. Contracts and burn addresses are not counted; wallets that delegated under EIP-7702 are.</dd>
    <dt>in contracts</dt><dd>${pctText(h.contractsBps)} (pools, lockers, vaults, the token itself)${h.burnedBps ? ` · burned ${pctText(h.burnedBps)}` : ""}</dd>` : ""}
    ${o.activity ? `<dt>last transfer</dt><dd>${o.activity.lastTransferAt ? `${formatDuration(Math.max(0, slip.at.timestamp - o.activity.lastTransferAt))} ago · ${o.activity.recentWallets} wallets in the last ${o.activity.recent} transfers` : "none indexed by the explorer"}</dd>` : ""}
  </dl>
  ${h && h.top.length ? `<h3 class="cap">The biggest wallets</h3><div class="tbl"><table class="buys"><thead><tr><th>#</th><th>holder</th><th>share</th></tr></thead><tbody>${h.top.slice(0, 15).map((x, i) => `<tr><td>${i + 1}</td><td>${explorer && mode !== "demo" ? `<a href="${esc(explorer)}/address/${esc(x.address)}" target="_blank" rel="noopener"><span class="mono">${shortAddress(x.address)}</span></a>` : `<span class="mono">${shortAddress(x.address)}</span>`} ${role(x)}</td><td>${pctText(x.bps)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
}

function devSection(d: DevReport, subject: string | null, standalone: boolean, bodyOnly = false): string {
  const inner = `<dl class="kv"><dt>deployer</dt><dd><span class="mono">${esc(d.deployer)}</span></dd><dt>in window</dt><dd>${esc(devReportLine(d))}</dd>${standalone ? `<dt>blocks</dt><dd>${d.window.fromBlock}–${d.window.toBlock}</dd>` : ""}</dl>
    ${d.launches.length ? `<div class="tbl"><table class="buys"><thead><tr><th>ticker</th><th>launched</th><th>stage</th><th>creator tax</th><th>launch → sweep</th></tr></thead><tbody>${d.launches
      .map((l) => `<tr><td><a href="#/${mode === "demo" ? "demo" : "t"}/${l.token}${routeChain()}">${esc(l.symbol)}</a>${l.token === subject ? " · this one" : ""}</td><td>${isoUtc(l.launchedAt).slice(0, 16).replace("T", " ")}</td><td>${PHASE_LABEL[l.phase]}</td><td>${formatBps(l.creatorTaxBps)}</td><td>${l.secondsToSweep === null ? "—" : formatDuration(l.secondsToSweep)}</td></tr>`)
      .join("")}</tbody></table></div>${d.truncated ? `<p style="color:var(--muted);font-size:13px">${d.counts.launched - d.launches.length} older launches counted but not listed.</p>` : ""}` : ""}`;
  return bodyOnly ? inner : `<section class="sec wide"><h2>This dev before</h2>${inner}</section>`;
}

function renderPosition(p: Position, head: number): void {
  const qd = chain().native;
  const amt = (v: bigint) => `${formatUnits(v, qd.decimals)} ${esc(qd.symbol)}`;
  const whole = p.exit.quotes.find((x) => x.shareBps === 10_000);
  const sign = p.unrealised < 0n ? "−" : "+";
  const absU = p.unrealised < 0n ? -p.unrealised : p.unrealised;
  out.innerHTML = `<div class="slip">
    <div class="stamp-row"><div class="who"><div class="sym">THE BAG</div><div class="name"><span class="mono">${esc(p.wallet)}</span> on <a href="#/${mode === "demo" ? "demo" : "t"}/${p.token}${routeChain()}">${shortAddress(p.token)}</a></div><div class="at">block ${head} · ${p.exit.venue}</div></div>
      <div class="stamp ${p.unrealised < 0n ? "no" : ""}">${sign}${formatUnits(absU, qd.decimals, 3)} ${esc(qd.symbol)}</div></div>
    <div class="grid">
      <section class="sec"><h2>Position</h2><dl class="kv">
        <dt>balance</dt><dd class="num">${formatUnits(p.balance, 18, 0)} tokens</dd>
        <dt>spent</dt><dd>${amt(p.spentQuote)} over ${p.trades.filter((t) => t.kind === "buy").length} buys</dd>
        <dt>received</dt><dd>${amt(p.receivedQuote)} over ${p.trades.filter((t) => t.kind === "sell").length} sells</dd>
        <dt>fees paid</dt><dd>${amt(p.feesPaid)}</dd>
        <dt>taxes paid</dt><dd>${amt(p.taxesPaid)} <small style="color:var(--dim)">creator tax plus any cover charge</small></dd>
        <dt>cost basis</dt><dd>${amt(p.costBasis)}</dd>
        <dt>exit now</dt><dd>${whole ? amt(whole.net) : "n/a"}</dd>
        <dt>unrealised</dt><dd>${sign}${amt(absU)}</dd>
      </dl><p style="margin:10px 0 0;color:var(--dim);font-size:12px">${esc(p.exit.note)}</p></section>
      <section class="sec"><h2>Trades</h2>${p.trades.length ? `<div class="tbl"><table class="buys"><thead><tr><th>block</th><th>side</th><th>quote</th><th>tokens</th><th>fee + tax</th></tr></thead><tbody>${p.trades.slice(0, 20).map((t) => `<tr><td>${t.block}</td><td>${t.kind}</td><td>${amt(t.quote)}</td><td>${formatUnits(t.tokens, 18, 0)}</td><td>${formatUnits(t.fee + t.tax, qd.decimals)}</td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--muted);margin:0">No curve trades by this wallet on this launch.</p>`}</section>
    </div></div>`;
}

function receiptSection(r: TradeReceipt): string {
  const qd = chain().native;
  const amt = (v: bigint) => `${formatUnits(v, qd.decimals)} ${esc(qd.symbol)}`;
  const share = (v: bigint) => (r.quote === 0n ? "0" : (Number((v * 10_000n) / r.quote) / 100).toFixed(1));
  return `<div class="stamp-row"><div class="who"><div class="sym">${r.kind.toUpperCase()}</div><div class="name">${r.launch ? `<a href="#/${mode === "demo" ? "demo" : "t"}/${r.launch.token.toLowerCase()}${routeChain()}">${shortAddress(r.launch.token)}</a>` : `curve ${shortAddress(r.curve)} (no factory record)`} · by <span class="mono">${shortAddress(r.wallet)}</span></div><div class="addr">${esc(r.hash)}</div><div class="at">block ${r.block}</div></div>
      <div class="stamp ${r.coverChargePart > 0n ? "no" : ""}">${r.coverChargePart > 0n ? `${share(r.coverChargePart)}% COVER` : "NO COVER"}</div></div>
    <section class="sec wide"><h2>Itemised</h2><dl class="kv">
      <dt>${r.kind === "buy" ? "paid" : "received"}</dt><dd>${amt(r.quote)}</dd>
      <dt>tokens</dt><dd class="num">${formatUnits(r.tokens, 18, 0)}</dd>
      <dt>protocol fee</dt><dd>${amt(r.fee)} · ${share(r.fee)}%</dd>
      <dt>creator tax</dt><dd>${amt(r.creatorTaxPart)} · ${share(r.creatorTaxPart)}%${r.launch ? ` <small style="color:var(--dim)">rate ${formatBps(r.launch.creatorTaxBps)}</small>` : ""}</dd>
      <dt>cover charge</dt><dd>${amt(r.coverChargePart)} · ${share(r.coverChargePart)}% <small style="color:var(--dim)">the part of the tax above the creator's rate: paid at the door</small></dd>
      <dt>effective price</dt><dd>${formatUnits(r.effectivePrice, qd.decimals, 12)} ${esc(qd.symbol)} per token, fees included</dd>
      <dt>curve price after</dt><dd>${r.marginalPriceAfter === null ? "not served by this RPC for that block" : `${formatUnits(r.marginalPriceAfter, qd.decimals, 12)} ${esc(qd.symbol)} per token`}</dd>
    </dl></section>`;
}

function renderPlan(plan: LaunchPlan): void {
  const qd = plan.quote;
  const c = chain();
  const u = (v: bigint, f = 4) => `${formatUnits(v, qd.decimals, f)} ${esc(qd.symbol)}`;
  out.innerHTML = `<div class="slip">
    <div class="stamp-row"><div class="who"><div class="sym">PLAN</div><div class="name">${esc(c.name)} · ${esc(c.launchpad)} · config ${plan.configId}${plan.configEnabled ? "" : " (disabled)"} · quote ${esc(qd.symbol)}</div><div class="at">block ${plan.block}</div>
      <form class="row" id="plan-form" style="margin-top:12px"><input class="short" id="plan-tax" placeholder="creator tax bps" value="${plan.creatorTaxBps}"><input class="short" id="plan-buy" placeholder="sample buy (${esc(qd.symbol)})" value="${formatUnits(plan.sampleBuy, qd.decimals)}"><input class="short" id="plan-quote" placeholder="quote token 0x… (blank = ${esc(c.native.symbol)})" value="${plan.pairToken === "0x0000000000000000000000000000000000000000" ? "" : plan.pairToken}"><button class="ghost" type="submit">Recalculate</button></form></div>
      <div class="stamp">${formatBps(plan.creatorTaxBps)} TAX</div></div>
    <div class="grid">
      <section class="sec"><h2>Terms today</h2><dl class="kv">
        <dt>launch fee</dt><dd>${formatUnits(plan.launchFee, c.native.decimals)} ${esc(c.native.symbol)} to the protocol</dd>
        <dt>supply</dt><dd class="num">${formatUnits(plan.supply, 18, 0)}</dd>
        <dt>curve</dt><dd>phantom ${u(plan.phantomQuote)} · graduates at ${u(plan.graduationThreshold)}</dd>
        <dt>creator tax</dt><dd>${formatBps(plan.creatorTaxBps)} of every curve trade (ceiling ${formatBps(plan.maxCreatorTaxBps)})</dd>
        <dt>curve fee</dt><dd>${formatBps(plan.curveFeeBps)} · protocol ${formatBps(plan.protocolFeeShareBps)} / buyback ${formatBps(plan.buybackBurnBps)} of the rest / creator</dd>
        <dt>after graduation</dt><dd>pool fee ${Number(plan.poolFeePpm) / 10_000}% · hook fee ${formatBps(plan.hookFeeBps)}</dd>
        <dt>cover charge</dt><dd>${formatBps(plan.snipe.startBps)} in the launch second, 0 after ${plan.snipe.seconds} s</dd>
      </dl></section>
      <section class="sec"><h2>What the curve does</h2><dl class="kv">
        <dt>start price</dt><dd>${formatUnits(plan.startPrice, qd.decimals, 12)} ${esc(qd.symbol)}</dd>
        <dt>graduation price</dt><dd>${formatUnits(plan.graduationPrice, qd.decimals, 12)} ${esc(qd.symbol)} · ${(Number((plan.graduationPrice * 100n) / (plan.startPrice || 1n)) / 100).toFixed(2)}× the start</dd>
        <dt>sold on the curve</dt><dd class="num">${formatUnits(plan.tokensSoldOnCurve, 18, 0)} tokens (${(Number((plan.tokensSoldOnCurve * 10_000n) / (plan.supply || 1n)) / 100).toFixed(1)}%)</dd>
        <dt>seeded into the pool</dt><dd class="num">${formatUnits(plan.tokensToPool, 18, 0)} tokens + ${u(plan.graduationThreshold)} · locked</dd>
        <dt>FDV at graduation</dt><dd>${u(plan.fdvAtGraduation, 2)}</dd>
        <dt>creator earns</dt><dd>${u((plan.graduationThreshold * plan.creatorTaxBps) / 10_000n)} if the curve fills with no sells</dd>
        <dt>${u(plan.sampleBuy)} at second 0</dt><dd>pays ${u(plan.sampleDoorCharge)} to the creator as cover charge, unless the wallet is on the exemption list</dd>
      </dl></section>
    </div>
    <p style="color:var(--dim);font:12px var(--mono);margin:0">Read from the factory and the hook at block ${plan.block}; the curve arithmetic is the contract's own. The factory owner can retune terms before you launch.</p>
  </div>`;
  $("plan-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const tax = $<HTMLInputElement>("plan-tax").value.trim() || "100";
    const buy = $<HTMLInputElement>("plan-buy").value.trim();
    const quote = $<HTMLInputElement>("plan-quote").value.trim();
    const params = new URLSearchParams();
    params.set("tax", tax);
    if (buy) params.set("buy", buy);
    if (quote) params.set("quote", quote);
    params.set("chain", mode === "demo" ? "demo" : chain().key);
    location.hash = `#/plan?${params.toString()}`;
  });
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function routeChain(): string {
  return mode === "demo" ? "" : `?chain=${chain().key}`;
}

// ---------------------------------------------------------------- routing

/**
 * Start a view's read, and give the button back whatever happens.
 *
 * `busy()` is the only thing that disables Check it, and every view was
 * expected to re-enable it on the way out — which works until one path
 * forgets. runSearch forgot on BOTH of its successful exits: find some
 * candidates, or find none, and the control stayed dead until the page
 * was reloaded. An audit found it; nothing in the code guaranteed it.
 *
 * One `finally`, at the one place every view is started from, covers
 * success, an empty result, a thrown error, a rejected promise and a
 * path somebody adds next year without reading this comment.
 *
 * It is also where a read stops being current. Every view guards its own
 * renders with `doorRun`, but a view that refuses an address answers and
 * returns BEFORE taking a number — so switching the chain mid-read let
 * the old chain's slow half finish and paint itself over the new page.
 * The header read Solana and the report under it was the Robinhood one,
 * and it stayed. Bumping here means a route change invalidates whatever
 * was in flight, whichever view it belonged to and however it ends.
 *
 * It takes the work UNSTARTED, and that is the whole reason it is a
 * function and not a promise. `start(runDoor(a))` evaluates runDoor
 * first, so the bump lands AFTER the new view has taken its number and
 * immediately makes the new view stale — every render discarded, the
 * page stuck on its spinner. The bump has to happen between the old run
 * and the new one, which means before the call, which means the call
 * has to still be in our hands when we get here.
 */
function start(begin: () => Promise<void>): void {
  doorRun++;
  void begin()
    .catch((error: unknown) => {
      // A view that throws past its own handling still has to say so
      // rather than leave a spinner and a dead button.
      failed(error, q.value.trim());
    })
    .finally(() => {
      go.disabled = false;
    });
}

function route(): void {
  const raw = location.hash.replace(/^#/, "");
  const [path, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return;
  const chainParam = params.get("chain");
  const wantDemo = parts[0] === "demo" || chainParam === "demo";
  if (wantDemo && mode !== "demo") setMode("demo", true);
  if (!wantDemo && parts[0] !== "demo") {
    if (mode !== "live") setMode("live", true);
    if (chainParam && CHAINS[chainParam]) selectChain(chainParam);
  }
  switch (parts[0]) {
    case "t":
    case "demo":
      setView("door");
      q.value = parts[1] ?? "";
      start(() => runDoor(parts[1] ?? ""));
      break;
    case "dev":
      setView("dev");
      q.value = parts[1] ?? "";
      start(() => runDev(parts[1] ?? ""));
      break;
    case "wallet":
      setView("wallet");
      q.value = `${parts[1] ?? ""} ${parts[2] ?? ""}`.trim();
      start(() => runWallet(parts[1] ?? "", parts[2] ?? ""));
      break;
    case "tx":
      setView("tx");
      q.value = parts[1] ?? "";
      start(() => runTx(parts[1] ?? ""));
      break;
    case "plan":
      setView("plan");
      q.value = params.get("tax") ?? "100";
      start(() => runPlan(Number(params.get("tax") ?? 100), params));
      break;
    case "board":
      setView("board");
      q.value = params.get("hours") ?? "1";
      start(() => runBoard(Number(params.get("hours") ?? 1) || 1));
      break;
  }
}

function submit(): void {
  const v = q.value.trim();
  // With "auto", the link may only name a chain that was found FOR THE
  // ADDRESS BEING SUBMITTED.
  //
  // It used to name whatever the last read settled on. route() reads that
  // straight back into the menu, so checking one Solana mint wrote
  // ?chain=solana into the next link, pinned the picker to Solana, and
  // every EVM address after it came back "paste a Solana mint address" —
  // with the header still reading Find the chain until the value landed.
  // One check, and the tool stopped working for every other chain.
  const same = chainSelect.value === "auto" && autoChain && resolvedFor.address === v.trim().toLowerCase();
  const c = mode === "demo" ? "demo" : chainSelect.value === "auto" ? (same ? autoChain!.key : "auto") : chain().key;
  let hash: string;
  if (view === "plan") hash = `#/plan?tax=${encodeURIComponent(v || "100")}&chain=${c}`;
  else if (view === "board") hash = `#/board?hours=${encodeURIComponent(v || "1")}&chain=${c}`;
  else if (view === "dev" && ADDR.test(v)) hash = `#/dev/${v.toLowerCase()}?chain=${c}`;
  else {
    const found = detect(v);
    if (!found) return bad(chainOrNull()?.family === "solana" && mode === "live" ? "Paste a Solana mint address: 32 bytes in base58, like EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v." : "Paste a token or curve address (0x + 40 hex characters), a transaction hash (0x + 64), or a token and a wallet address separated by a space.");
    if (found.view === "wallet") hash = `#/wallet/${found.parts[0].toLowerCase()}/${found.parts[1].toLowerCase()}?chain=${c}`;
    else if (found.view === "tx") hash = `#/tx/${found.parts[0]}?chain=${c}`;
    // base58 is case-sensitive: lower-casing a Solana mint makes it a different account.
    // base58 is case-sensitive, and with the chain not yet known the shape
    // of the address is what says whether lower-casing is safe.
    else hash = `#/${mode === "demo" ? "demo" : "t"}/${mode === "live" && isSolanaAddress(found.parts[0]) && !ADDR.test(found.parts[0]) ? found.parts[0] : found.parts[0].toLowerCase()}${mode === "demo" ? "" : `?chain=${c}`}`;
  }
  if (location.hash === hash) route();
  else location.hash = hash;
}

function boot(): void {
  $<HTMLImageElement>("mark").src = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">${MASCOT_SVG_INNER}</svg>`)}`;
  rpcInput.value = storage("bouncer.rpc") ?? "";
  proxyInput.value = storage("bouncer.proxy") ?? "";
  proxyInput.addEventListener("change", () => storage("bouncer.proxy", proxyInput.value.trim()));
  factoryInput.value = storage("bouncer.factory") ?? "";
  // "auto" by default: the address knows which chain it is on, and asking
  // a reader to know it first is asking them the question they came with.
  chainSelect.value = storage("bouncer.chain") ?? "auto";
  paintSelectedChain();
  setUpPicker();
  rpcInput.addEventListener("change", () => storage("bouncer.rpc", rpcInput.value.trim()));
  factoryInput.addEventListener("change", () => storage("bouncer.factory", factoryInput.value.trim()));
  chainSelect.addEventListener("change", () => {
    storage("bouncer.chain", chainSelect.value);
    // Back to auto: forget whatever the last search settled on, or the next
    // paste would be read on the chain the last one happened to live on.
    if (chainSelect.value === "auto") {
      autoChain = null;
      resolvedFor = { address: "", chain: "" };
    }
    paintSelectedChain();
    if (mode === "live") setMode("live", true);
    renderChips();
    // A report on screen belongs to the chain it was read from.
    //
    // Changing the menu used to leave it there, so picking Solana while a
    // Robinhood slip was open gave a header saying Solana above a report
    // about Robinhood — with every number in it read from the other
    // chain. Re-read the same subject on the chain now chosen; if it is
    // not there, the slip says so, which is the honest answer and not the
    // one the stale report was giving.
    const showing = q.value.trim();
    if (view === "door" && showing && out.innerHTML.trim()) {
      const to = chainSelect.value === "auto" ? "auto" : chainSelect.value;
      const next = `#/t/${isSolanaAddress(showing) && !ADDR.test(showing) ? showing : showing.toLowerCase()}?chain=${to}`;
      if (location.hash !== next) location.hash = next;
      else void route();
    }
  });
  settingsToggle.addEventListener("click", () => {
    const open = !settings.classList.contains("open");
    settings.classList.toggle("open", open);
    settingsToggle.setAttribute("aria-expanded", String(open));
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  window.addEventListener("hashchange", route);
  setMode("live", true);
  setView("door");
  if (location.hash) route();
  else {
    // An empty box, and the cursor in it.
    //
    // It used to open on an invented token, which meant the first thing
    // anybody saw was a full slip about a coin that does not exist —
    // impressive for a second and misleading for as long as it took them
    // to notice the word DEMO. A tool that reads the chain should start
    // by asking which address.
    q.focus();
  }
}

boot();
