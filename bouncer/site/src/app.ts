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
import { CHAINS, chainByKey, type ChainConfig } from "../../src/chain/chains.js";
import { PHASE_LABEL } from "../../src/chain/pons.js";
import { PonsReader } from "../../src/chain/reader.js";
import { RpcClient } from "../../src/chain/rpc.js";
import { findBlockByTimestamp } from "../../src/chain/tape.js";
import { doorCard } from "../../src/bouncer/card.js";
import { coverChargeLine } from "../../src/bouncer/coverCharge.js";
import { DEMO, DEMO_BLOCKSCOUT, DEMO_IMPOSTOR, DEMO_V1, demoBlockscoutFetch, demoRpc } from "../../src/bouncer/demo.js";
import { devReportLine, readDevReport, type DevReport } from "../../src/bouncer/devReport.js";
import { findLaunchBlock, readDoor, slipJson, type DoorSlip } from "../../src/bouncer/door.js";
import { lookalikeLine } from "../../src/bouncer/lookalike.js";
import { MASCOT_SVG_INNER } from "../../src/bouncer/mascot.js";
import { oneCrewLine } from "../../src/bouncer/oneCrew.js";
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
const SANDBOXED = /(^|\.)claude\.ai$|claudeusercontent|anthropic/.test(location.hostname);
const HOSTED = "https://kepochnik.github.io/bouncer/";
/** Set this to your deployed bouncer-proxy URL to make it the default for everyone who opens the site. */
const DEFAULT_PROXY = "";

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

function chain(): ChainConfig {
  return mode === "demo" ? CHAINS.robinhood : chainByKey(chainSelect.value);
}

function setMode(next: Mode, silent = false): void {
  mode = next;
  $("mode-demo").setAttribute("aria-pressed", String(next === "demo"));
  $("mode-live").setAttribute("aria-pressed", String(next === "live"));
  chainSelect.disabled = next === "demo";
  sourcePill.textContent = next === "demo" ? "Demo data" : `Live · ${chain().name}`;
  sourcePill.classList.toggle("live", next === "live");
  sourceText.innerHTML = next === "demo"
    ? SANDBOXED
      ? `You are looking at an invented example chain. This preview on claude.ai cannot reach the internet, so <b>Live</b> is off here: use the <a href="${HOSTED}">hosted site</a>, the Chrome extension or the CLI for real tokens.`
      : "You are looking at an invented example chain. Switch to <b>Live</b> to check a real token."
    : `Reading ${esc(chain().name)} from your browser at one block. Nothing is cached.`;
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
  if (parts.length === 2 && ADDR.test(parts[0]) && ADDR.test(parts[1])) return { view: "wallet", parts };
  if (parts.length === 1 && ADDR.test(parts[0])) return { view: "door", parts };
  if (parts.length === 1 && /^0x[0-9a-fA-F]{64}$/.test(parts[0])) return { view: "tx", parts };
  if (parts.length === 1 && /^0x/.test(parts[0]) && mode === "demo" && /^0xdemo/i.test(parts[0])) return { view: "tx", parts };
  return null;
}

function proxyBase(): string {
  return (proxyInput.value.trim() || DEFAULT_PROXY).replace(/\/$/, "");
}

function rpcFor(): RpcClient {
  if (mode === "demo") return demoRpc();
  const c = chain();
  const url = rpcInput.value.trim();
  const proxy = proxyBase();
  const urls = url ? [url] : proxy ? [`${proxy}/rpc/${c.key}`, ...c.rpc] : c.rpc;
  return new RpcClient({ urls, expectedChainId: c.chainId, minSpacingMs: 120 });
}

function blockscoutFor(): BlockscoutClient | null {
  if (mode === "demo") return new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() });
  const c = chain();
  if (!c.blockscout) return null;
  const proxy = proxyBase();
  return new BlockscoutClient({ baseUrl: proxy ? `${proxy}/api/${c.key}` : c.blockscout });
}

function factoryFor(): string {
  const c = chain();
  const f = (mode === "live" ? factoryInput.value.trim() : "") || c.factory || "";
  if (!f) throw new Error(`${c.name}: ${c.notes ?? "no factory known; paste it under live settings"}`);
  return f.toLowerCase();
}

const EXAMPLES: { label: string; hint: string; hash: string }[] = [
  { label: "A fresh launch", hint: "9 s old, door tax still open", hash: `#/demo/${DEMO.tokens.fresh.token}` },
  { label: "A graduated token", hint: "filled its curve in 212 s", hash: `#/demo/${DEMO.tokens.sprint.token}` },
  { label: "A fake copy", hint: "same name, not from the factory", hash: `#/demo/${DEMO_IMPOSTOR.token}` },
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
  const c = mode === "demo" ? "demo" : chain().key;
  more.innerHTML = `<span>More:</span><a href="#/board?chain=${c}">Tonight's board</a><a href="#/plan?tax=100&chain=${c}">Plan a launch</a><span>Paste "token wallet" (two addresses) to see one wallet's bag.</span>`;
  chips.appendChild(more);
}

function showToast(text: string): void {
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1600);
}

function busy(text: string): void {
  go.disabled = true;
  stopWatch();
  status.innerHTML = `<span class="dot"></span> ${esc(text)} ${mode === "demo" ? "(demo chain, every address invented)" : `(${esc(chain().name)}, one block pinned)`}`;
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

// ---------------------------------------------------------------- views

/** Addresses the demo chain knows; anything else is a real address and needs a real chain. */
function isDemoAddress(address: string): boolean {
  const a = address.toLowerCase();
  return Object.values(DEMO.tokens).some((t) => t.token === a || t.curve === a || t.deployer === a) || a === DEMO_IMPOSTOR.token || a === DEMO_V1.token || a === DEMO_V1.deployer || a === "0x000000000000000000000000000000000000dead";
}

async function runDoor(address: string): Promise<void> {
  if (!ADDR.test(address)) return bad("Paste a 20-byte hex address: the token or its bonding curve, 0x followed by 40 hex characters.");
  if (mode === "demo" && !isDemoAddress(address)) {
    // A real address pasted into the demo: the demo chain would call it an impostor. Go live instead.
    setMode("live");
    showToast(`Real address: switched to live on ${chain().name}`);
    location.hash = `#/t/${address.toLowerCase()}?chain=${chain().key}`;
    return;
  }
  busy("reading the chain at the door…");
  try {
    const slip = await readDoor(rpcFor(), address, mode === "demo"
      ? { chain: CHAINS.robinhood, factory: factoryFor(), blockscout: blockscoutFor(), devHours: 8, chunkSize: 100_000, launchSearchBlocks: 400_000 }
      : { chain: chain(), factory: factoryFor(), blockscout: blockscoutFor(), devHours: 24 });
    done(`block ${slip.at.block} · ${isoUtc(slip.at.timestamp)} · ${slip.notes.length} thing${slip.notes.length === 1 ? "" : "s"} to know`);
    renderSlip(slip);
  } catch (error) {
    failed(error, address);
  } finally {
    go.disabled = false;
  }
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
    return parts.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(". ") + ".";
  }
  if (!slip.id.registered) {
    const t = slip.id.token;
    if (t.code.empty) return `There is no contract at this address on ${slip.chain.name}.`;
    const flags: string[] = [];
    if (t.proxyImplementation || t.code.minimalProxyTarget) flags.push("its code can be swapped (proxy)");
    if (t.code.opcodes.selfdestruct) flags.push("it can self-destruct");
    if (t.code.opcodes.delegatecall) flags.push("it delegates calls");
    return `Not a ${slip.chain.launchpad} launch: the factory never deployed this contract${flags.length ? `, and ${flags.join(", ")}` : ""}. Anything sold under this name is not the token.`;
  }
  const parts: string[] = [`Real ${slip.chain.launchpad} launch`];
  const c = slip.cover;
  if (c?.status === "open") parts.push(`the door tax is still on for ${c.secondsLeft} s (up to ${formatBps(c.terms.startBps)} of a buy goes to the creator)`);
  else if (c?.status === "closed") parts.push("the door tax has ended");
  if (slip.rules) parts.push(`every trade pays ${formatBps(slip.rules.totalTradeBps)} in fees`);
  if (slip.room && slip.room.buys > 0) parts.push(`the creator funded ${(slip.room.devShareBps / 100).toFixed(0)}% of what was bought`);
  if (slip.crew?.crews.length) parts.push(`${slip.crew.crews[0].wallets.length} early buyers share a funder`);
  if (slip.dev) parts.push(slip.dev.counts.launched <= 1 ? "first launch from this dev" : `this dev launched ${slip.dev.counts.launched} tokens, ${slip.dev.counts.graduated} graduated`);
  if (slip.rules?.phase === 2 || slip.rules?.phase === 3) parts.push("graduated, pool locked");
  return parts.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(". ") + ".";
}

function renderSlip(slip: DoorSlip): void {
  const meta = slip.id.meta;
  const c0 = chain();
  const explorer = c0.blockscout ? `${c0.blockscout}/address/${slip.subject}` : null;
  const sym = meta ? esc(meta.symbol) : shortAddress(slip.subject);
  const name = meta ? esc(meta.name) : slip.id.token.code.empty ? "no contract at this address" : "unregistered contract";
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
    : "";

  const notes = slip.notes.map((n) => `<div class="note"><span class="lvl ${n.level}">${LEVEL_WORD[n.level as Level]}</span><span>${esc(n.text)}</span></div>`).join("");

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
  const section = (id: string, title: string, what: string, body: string, open: boolean) =>
    `<details class="sec" id="${id}"${open ? " open" : ""}><summary><h2>${title}</h2><span class="what">${what}</span><span class="chev">▶</span></summary><div class="body">${body}</div></details>`;

  const idBody = `<dl class="kv">
    <dt>chain</dt><dd>${esc(slip.chain.name)} · ${esc(slip.chain.launchpad)}</dd>
    <dt>factory record</dt><dd>${registered ? `<span class="flag ok">yes</span> ${v1 ? "the Pons V1 factory" : "the launchpad's own factory"} deployed this token${slip.id.resolvedAs === "curve" ? " (you pasted its curve)" : ""}` : `<span class="flag bad">none</span> neither the ${esc(slip.chain.launchpad)} factory${slip.chain.key === "robinhood" ? " nor the Pons V1 factory" : ""} has seen this address`}</dd>
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
    ? `<dl class="kv"><dt>${esc(l.query)}</dt><dd>${esc(lookalikeLine(l))}</dd></dl>
        <div class="tbl"><table class="buys"><thead><tr><th>address</th><th>from the factory?</th><th>stage</th><th>launch block</th></tr></thead><tbody>${l.candidates.slice(0, 8).map((x) => `<tr><td><a href="#/${mode === "demo" ? "demo" : "t"}/${x.address}${routeChain()}">${shortAddress(x.address)}</a>${x.address === l.subject ? " · this one" : ""}</td><td>${x.registered ? '<span class="flag ok">yes</span>' : '<span class="flag bad">no</span>'}</td><td>${x.phase !== null ? PHASE_LABEL[x.phase] : "—"}</td><td>${x.launchBlock ?? "—"}</td></tr>`).join("")}</tbody></table></div>`
    : "";

  const watchBody = `<div class="watch"><button class="ghost" id="act-watch" type="button" aria-pressed="false">Start watching</button><span style="color:var(--muted);font-size:13px">Checks every ${mode === "demo" ? "5" : "15"} s while this tab is open: the dev selling or moving tokens, the tax recipient changing, buyback switching, graduation${crew?.crews.length ? `, and ${crew.crews.flatMap((x) => x.wallets).length} grouped wallets leaving together` : ""}. Browser notifications if you allow them.</span></div><div class="events"></div>`;

  out.innerHTML = `<div class="slip">
    <div class="summary">
      <div class="top">
        <div class="who"><div class="sym">${sym}</div><div class="name">${name}</div><div class="addr">${esc(slip.subject)}</div><div class="at">${mode === "demo" ? "DEMO · " : ""}${esc(slip.chain.name)} · block ${slip.at.block} · ${isoUtc(slip.at.timestamp)}</div></div>
        <div class="stamp ${slip.stamp === "ON THE LIST" ? "" : "no"}">${slip.stamp}</div>
      </div>
      <p class="lead">${esc(summarySentence(slip))}</p>
      ${tiles}
      <div class="actions" style="margin-top:16px">
        <button class="ghost" id="act-card" type="button">Show as image</button>
        <button class="ghost" id="act-json" type="button">Copy JSON</button>
        <button class="ghost" id="act-link" type="button">Copy link</button>
      </div>
    </div>
    <div class="card-wrap" id="card"></div>
    <div class="notes"><h2>What to know</h2>${notes || `<div class="note"><span class="lvl info">Note</span><span>Nothing stands out. The factory made this token and none of its terms needs a second look.</span></div>`}</div>
    <div class="stack">
      ${section("s-id", "Is it real?", "Did the launchpad's factory deploy this token, and can its code change later?", idBody, true)}
      ${registered && !v1 ? section("s-cover", "Door tax", `The anti-snipe tax in the first ${c?.terms.seconds ?? 15} seconds, and who paid it.`, coverBody, c?.status === "open") : ""}
      ${r ? section("s-rules", "Fees and rules", "What every trade costs, where the creator's cut goes, what buyback really does.", rulesBody, false) : ""}
      ${v1 ? section("s-v1", "Rules (Pons V1)", "How this older kind of launch works: pool from block one, launch caps, locked liquidity.", `<ol class="rules">${v1.rules.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`, true) : ""}
      ${e ? section("s-exit", "Cash out now", "What you would actually get for selling part or all of a position right now.", exitBody, false) : ""}
      ${room ? section("s-room", "Who is inside", "Every buyer since launch, how much the creator's own wallets put in, buys landing in the same block.", roomBody, false) : ""}
      ${crew ? section("s-crew", "Same funder?", "Where the first buyers got their money. Wallets funded by one address before the launch are one group.", crewBody, false) : ""}
      ${l ? section("s-look", "Same name", "Other tokens with this ticker on the chain, and which one launched first.", lookBody, false) : ""}
      ${d ? section("s-dev", "This dev before", `Everything this deployer launched in the last ${mode === "demo" ? "8" : "24"} h and how it went.`, devSection(d, slip.subject, false, true), false) : ""}
      ${registered && !v1 ? section("s-watch", "Watch for changes", "Get told when the dev moves, right in this tab.", watchBody, new URLSearchParams(location.hash.split("?")[1] ?? "").get("watch") === "1") : ""}
    </div>
  </div>`;

  $("act-card").addEventListener("click", () => {
    const wrap = $("card");
    if (!wrap.classList.contains("open")) wrap.innerHTML = doorCard(slip, { repoUrl: REPO, ticker: MARK, mascotSvg: MASCOT_SVG_INNER });
    wrap.classList.toggle("open");
  });
  $("act-json").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(slipJson(slip)); showToast("JSON copied"); } catch { showToast("Clipboard blocked; use the CLI --format json"); }
  });
  $("act-link").addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}#/${mode === "demo" ? "demo" : "t"}/${slip.subject}${routeChain()}`;
    try { await navigator.clipboard.writeText(url); showToast("Link copied"); } catch { showToast(url); }
  });
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
    if (chainParam && CHAINS[chainParam]) chainSelect.value = chainParam;
  }
  switch (parts[0]) {
    case "t":
    case "demo":
      setView("door");
      q.value = parts[1] ?? "";
      void runDoor(parts[1] ?? "");
      break;
    case "dev":
      setView("dev");
      q.value = parts[1] ?? "";
      void runDev(parts[1] ?? "");
      break;
    case "wallet":
      setView("wallet");
      q.value = `${parts[1] ?? ""} ${parts[2] ?? ""}`.trim();
      void runWallet(parts[1] ?? "", parts[2] ?? "");
      break;
    case "tx":
      setView("tx");
      q.value = parts[1] ?? "";
      void runTx(parts[1] ?? "");
      break;
    case "plan":
      setView("plan");
      q.value = params.get("tax") ?? "100";
      void runPlan(Number(params.get("tax") ?? 100), params);
      break;
    case "board":
      setView("board");
      q.value = params.get("hours") ?? "1";
      void runBoard(Number(params.get("hours") ?? 1) || 1);
      break;
  }
}

function submit(): void {
  const v = q.value.trim();
  const c = mode === "demo" ? "demo" : chain().key;
  let hash: string;
  if (view === "plan") hash = `#/plan?tax=${encodeURIComponent(v || "100")}&chain=${c}`;
  else if (view === "board") hash = `#/board?hours=${encodeURIComponent(v || "1")}&chain=${c}`;
  else if (view === "dev" && ADDR.test(v)) hash = `#/dev/${v.toLowerCase()}?chain=${c}`;
  else {
    const found = detect(v);
    if (!found) return bad("Paste a token or curve address (0x + 40 hex characters), a transaction hash (0x + 64), or a token and a wallet address separated by a space.");
    if (found.view === "wallet") hash = `#/wallet/${found.parts[0].toLowerCase()}/${found.parts[1].toLowerCase()}?chain=${c}`;
    else if (found.view === "tx") hash = `#/tx/${found.parts[0]}?chain=${c}`;
    else hash = `#/${mode === "demo" ? "demo" : "t"}/${found.parts[0].toLowerCase()}${mode === "demo" ? "" : `?chain=${c}`}`;
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
  chainSelect.value = storage("bouncer.chain") ?? "robinhood";
  rpcInput.addEventListener("change", () => storage("bouncer.rpc", rpcInput.value.trim()));
  factoryInput.addEventListener("change", () => storage("bouncer.factory", factoryInput.value.trim()));
  chainSelect.addEventListener("change", () => {
    storage("bouncer.chain", chainSelect.value);
    const c = chainByKey(chainSelect.value);
    $("chain-hint").textContent = `${c.name} (${c.chainId}) · ${c.launchpad} · RPC ${c.rpc[0]}${c.blockscout ? ` · explorer ${c.blockscout}` : " · no explorer known, the funder check and same-name search are off"}${c.notes ? ` · ${c.notes}` : ""}`;
    if (mode === "live") setMode("live", true);
    renderChips();
  });
  $("mode-demo").addEventListener("click", () => setMode("demo"));
  $("mode-live").addEventListener("click", () => setMode("live"));
  if (SANDBOXED) {
    const live = $<HTMLButtonElement>("mode-live");
    live.disabled = true;
    live.title = "Live mode cannot run inside the claude.ai preview: the sandbox blocks network requests. Use the hosted site or the Chrome extension.";
  }
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
  setMode(SANDBOXED ? "demo" : ((storage("bouncer.mode") as Mode | null) ?? "demo"), true);
  setView("door");
  if (location.hash) route();
  else {
    q.value = DEMO.tokens.fresh.token;
    setMode("demo", true);
    void runDoor(DEMO.tokens.fresh.token);
  }
}

boot();
