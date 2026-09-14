/**
 * BOUNCER in the browser. Same read path as the CLI (bundled by esbuild),
 * a fake fetch for demo mode, and a hash route per address so a slip can
 * be linked: #/t/0x… (live) or #/demo/0x…
 */
import { doorCard } from "../../src/bouncer/card.js";
import { coverChargeLine } from "../../src/bouncer/coverCharge.js";
import { DEMO, DEMO_IMPOSTOR, demoRpc } from "../../src/bouncer/demo.js";
import { devReportLine } from "../../src/bouncer/devReport.js";
import { readDoor, slipJson, type DoorSlip } from "../../src/bouncer/door.js";
import { MASCOT_SVG_INNER } from "../../src/bouncer/mascot.js";
import { PHASE_LABEL, ROBINHOOD_CHAIN_ID, ROBINHOOD_EXPLORER, ROBINHOOD_PUBLIC_RPC } from "../../src/chain/pons.js";
import { RpcClient } from "../../src/chain/rpc.js";
import { formatBps, formatDuration, formatUnits, isoUtc, shortAddress } from "../../src/format.js";

type Mode = "demo" | "live";
const REPO = "github.com/Kepochnik/bouncer";
const MARK = "$BOUNCER";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const out = $("out");
const status = $("status");
const form = $<HTMLFormElement>("form");
const q = $<HTMLInputElement>("q");
const go = $<HTMLButtonElement>("go");
const rpcInput = $<HTMLInputElement>("rpc");
const settings = $("settings");
const toast = $("toast");

let mode: Mode = "demo";
let ticker: number | null = null;
let current: DoorSlip | null = null;

function storage(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setMode(next: Mode, silent = false): void {
  mode = next;
  $("mode-demo").setAttribute("aria-pressed", String(next === "demo"));
  $("mode-live").setAttribute("aria-pressed", String(next === "live"));
  settings.classList.toggle("open", next === "live");
  renderChips();
  if (!silent) storage("bouncer.mode", next);
}

function rpcFor(m: Mode): RpcClient {
  if (m === "demo") return demoRpc();
  const url = rpcInput.value.trim() || ROBINHOOD_PUBLIC_RPC;
  return new RpcClient({ urls: [url], expectedChainId: ROBINHOOD_CHAIN_ID, minSpacingMs: 120 });
}

const EXAMPLES: { label: string; hint: string; address: string }[] = [
  { label: "FRESH", hint: "9 s old, cover charge open", address: DEMO.tokens.fresh.token },
  { label: "SPRINT", hint: "graduated in 212 s", address: DEMO.tokens.sprint.token },
  { label: "LATE", hint: "paste the curve instead", address: DEMO.tokens.late.curve },
  { label: "SPRINT?", hint: "an impostor with the same name", address: DEMO_IMPOSTOR.token },
];

function renderChips(): void {
  const chips = $("chips");
  chips.innerHTML = mode === "demo" ? "<span>try:</span>" : "<span>live: paste any Pons V2 token or curve address</span>";
  if (mode !== "demo") return;
  for (const e of EXAMPLES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.innerHTML = `${esc(e.label)}<em>${esc(e.hint)}</em>`;
    b.addEventListener("click", () => {
      q.value = e.address;
      location.hash = `#/demo/${e.address}`;
    });
    chips.appendChild(b);
  }
}

function showToast(text: string): void {
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1600);
}

async function check(address: string, m: Mode): Promise<void> {
  if (ticker) { clearInterval(ticker); ticker = null; }
  const input = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(input)) {
    out.innerHTML = `<div class="error"><strong>That is not an address.</strong><p>Paste a 20-byte hex address: the token or its bonding curve, 0x followed by 40 hex characters.</p></div>`;
    return;
  }
  go.disabled = true;
  status.innerHTML = `<span class="dot"></span> reading chain ${ROBINHOOD_CHAIN_ID} at the door… ${m === "demo" ? "(demo chain, every address invented)" : "(live, one block pinned)"}`;
  out.innerHTML = "";
  try {
    const rpc = rpcFor(m);
    const slip = await readDoor(rpc, input, m === "demo" ? { devHours: 8, chunkSize: 100_000, launchSearchBlocks: 400_000 } : { devHours: 24 });
    current = slip;
    status.textContent = `${m === "demo" ? "DEMO · " : ""}block ${slip.at.block} · ${isoUtc(slip.at.timestamp)} · ${slip.notes.length} door note${slip.notes.length === 1 ? "" : "s"}`;
    renderSlip(slip, m);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cors = /fetch|network|failed|CORS|load/i.test(message) && m === "live";
    status.textContent = "";
    out.innerHTML = `<div class="error"><strong>Could not read the chain.</strong><p>${esc(message)}</p>${
      cors
        ? `<p>The browser could not reach the RPC. The public endpoint may not allow browser requests: paste an RPC URL that does under <em>live</em>, or run <code>npx bouncer door ${esc(input)}</code> from the repo. Demo mode works offline.</p>`
        : ""
    }</div>`;
  } finally {
    go.disabled = false;
  }
}

function renderSlip(slip: DoorSlip, m: Mode): void {
  const meta = slip.id.meta;
  const explorer = `${ROBINHOOD_EXPLORER}/address/${slip.subject}`;
  const sym = meta ? esc(meta.symbol) : shortAddress(slip.subject);
  const name = meta ? esc(meta.name) : slip.id.token.code.empty ? "no contract at this address" : "unregistered contract";
  const notes = slip.notes
    .map((n) => `<div class="note"><span class="lvl ${n.level}">${n.level}</span><span>${esc(n.text)}</span></div>`)
    .join("");

  const t = slip.id.token;
  const idFlags = (c: typeof t) => {
    const f: string[] = [];
    if (c.proxyImplementation) f.push(`<span class="flag bad">EIP-1967 proxy → ${shortAddress(c.proxyImplementation)}</span>`);
    if (c.code.minimalProxyTarget) f.push(`<span class="flag bad">EIP-1167 proxy</span>`);
    if (c.code.opcodes.selfdestruct) f.push(`<span class="flag bad">SELFDESTRUCT ×${c.code.opcodes.selfdestruct}</span>`);
    if (c.code.opcodes.delegatecall) f.push(`<span class="flag bad">DELEGATECALL ×${c.code.opcodes.delegatecall}</span>`);
    if (c.code.opcodes.callcode) f.push(`<span class="flag bad">CALLCODE</span>`);
    if (c.code.opcodes.create || c.code.opcodes.create2) f.push(`<span class="flag">CREATE</span>`);
    if (!f.length && !c.code.empty) f.push(`<span class="flag ok">no SELFDESTRUCT · no DELEGATECALL · no proxy</span>`);
    return f.join("");
  };
  const idSection = `<section class="sec"><h2>ID check</h2><dl class="kv">
    <dt>factory record</dt><dd>${slip.id.registered ? `<span class="flag ok">registered</span> the Pons V2 factory deployed this token${slip.id.resolvedAs === "curve" ? " (resolved from its curve)" : ""}` : `<span class="flag bad">none</span> the factory has never seen this address`}</dd>
    <dt>token code</dt><dd>${t.code.empty ? "empty (no contract)" : `${t.code.bytes} bytes`}<br>${idFlags(t)}</dd>
    ${slip.id.curve ? `<dt>curve code</dt><dd>${slip.id.curve.code.bytes} bytes<br>${idFlags(slip.id.curve)}</dd>` : ""}
    ${slip.id.launch ? `<dt>deployer</dt><dd><span class="mono">${esc(slip.id.launch.deployer.toLowerCase())}</span></dd><dt>phase</dt><dd>${PHASE_LABEL[slip.id.launch.phase]}</dd>` : ""}
    <dt>explorer</dt><dd><a href="${explorer}" target="_blank" rel="noopener">${m === "demo" ? "blockscout (demo address, will be empty)" : "blockscout"}</a></dd>
  </dl></section>`;

  let coverSection = "";
  if (slip.cover) {
    const c = slip.cover;
    const buys = c.observed
      .map(
        (b) =>
          `<tr class="${b.creatorWallet ? "exempt" : ""}"><td>${b.secondsAfterLaunch.toFixed(1)} s</td><td>${shortAddress(b.buyer)}${b.creatorWallet ? ' <span class="flag">creator · exempt</span>' : ""}</td><td>${formatUnits(b.quoteIn, slip.rules?.quote.decimals ?? 18)} ${esc(slip.rules?.quote.symbol ?? "")}</td><td>${(b.chargeBps / 100).toFixed(1)}%</td></tr>`,
      )
      .join("");
    coverSection = `<section class="sec"><h2>Cover charge</h2>
      <div class="big"><b id="cd" class="${c.status}">${c.status === "open" ? `${c.secondsLeft}s` : c.status === "closed" ? "CLOSED" : "OFF"}</b><span id="cd-note">${c.status === "open" ? "left on the door tax" : c.status === "closed" ? `${formatDuration(Math.max(0, c.head.timestamp - c.windowEndsAt))} ago` : "disabled for this launch"}</span></div>
      ${c.status === "open" ? `<div class="bar"><i id="cd-bar" style="width:${Math.round((c.secondsLeft / c.terms.seconds) * 100)}%"></i></div>` : ""}
      <dl class="kv">
        <dt>terms</dt><dd>${formatBps(c.terms.startBps)} of a buy's quote in the launch second, decaying to 0 over ${c.terms.seconds} s${c.termsChangedSinceLaunch ? ' <span class="flag bad">factory retuned since launch</span>' : ""}</dd>
        <dt>launched</dt><dd>${isoUtc(c.launch.timestamp)} · block ${c.launch.block}</dd>
        <dt>door</dt><dd>${esc(coverChargeLine(c))}</dd>
      </dl>
      ${c.observed.length ? `<div class="tbl"><table class="buys"><thead><tr><th>after launch</th><th>buyer</th><th>spent</th><th>paid at the door</th></tr></thead><tbody>${buys}</tbody></table></div>` : `<p style="color:var(--muted);font-size:13px;margin:8px 0 0">No buys landed inside the window.</p>`}
    </section>`;
  } else if (slip.id.registered) {
    coverSection = `<section class="sec"><h2>Cover charge</h2><p style="color:var(--muted);margin:0">Launch is older than the search window; the door tax is long closed and was not read.</p></section>`;
  }

  const r = slip.rules;
  const rulesSection = r
    ? `<section class="sec"><h2>House rules</h2><ol class="rules">${r.rules.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></section>`
    : "";

  const d = slip.dev;
  const devSection = d
    ? `<section class="sec wide"><h2>Dev report card</h2>
      <dl class="kv"><dt>deployer</dt><dd><span class="mono">${esc(d.deployer)}</span></dd><dt>in window</dt><dd>${esc(devReportLine(d))}</dd></dl>
      ${
        d.launches.length
          ? `<div class="tbl"><table class="buys"><thead><tr><th>ticker</th><th>launched</th><th>phase</th><th>creator tax</th><th>launch → sweep</th></tr></thead><tbody>${d.launches
              .map(
                (l) =>
                  `<tr><td>${esc(l.symbol)}${l.token === slip.subject ? " · this one" : ""}</td><td>${isoUtc(l.launchedAt).slice(0, 16).replace("T", " ")}</td><td>${PHASE_LABEL[l.phase]}</td><td>${formatBps(l.creatorTaxBps)}</td><td>${l.secondsToSweep === null ? "—" : formatDuration(l.secondsToSweep)}</td></tr>`,
              )
              .join("")}</tbody></table></div>${d.truncated ? `<p style="color:var(--muted);font-size:13px">${d.counts.launched - d.launches.length} older launches counted but not listed.</p>` : ""}`
          : ""
      }
    </section>`
    : "";

  out.innerHTML = `<div class="slip">
    <div class="stamp-row">
      <div class="who"><div class="sym">${sym}</div><div class="name">${name}</div><div class="addr">${esc(slip.subject)}</div><div class="at">${m === "demo" ? "DEMO CHAIN · " : ""}block ${slip.at.block} · ${isoUtc(slip.at.timestamp)}</div>
        <div class="actions" style="margin-top:14px">
          <button class="ghost" id="act-card" type="button">Show card</button>
          <button class="ghost" id="act-json" type="button">Copy JSON</button>
          <button class="ghost" id="act-link" type="button">Copy link</button>
        </div>
      </div>
      <div class="stamp ${slip.stamp === "ON THE LIST" ? "" : "no"}">${slip.stamp}</div>
    </div>
    <div class="card-wrap" id="card"></div>
    <div class="notes"><h2>Door notes</h2>${notes || `<div class="note"><span class="lvl info">info</span><span>Nothing to say. The list has this token and nothing on it needs a second look.</span></div>`}</div>
    <div class="grid">${idSection}${coverSection}${rulesSection}${devSection}</div>
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
    const url = `${location.origin}${location.pathname}#/${m === "demo" ? "demo" : "t"}/${slip.subject}`;
    try { await navigator.clipboard.writeText(url); showToast("Link copied"); } catch { showToast(url); }
  });

  if (slip.cover?.status === "open") {
    const c = slip.cover;
    const started = Date.now();
    ticker = window.setInterval(() => {
      const left = Math.max(0, c.secondsLeft - Math.floor((Date.now() - started) / 1000));
      const cd = document.getElementById("cd");
      const bar = document.getElementById("cd-bar");
      const note = document.getElementById("cd-note");
      if (!cd) { if (ticker) clearInterval(ticker); return; }
      cd.textContent = left > 0 ? `${left}s` : "CLOSED";
      if (bar) bar.style.width = `${Math.round((left / c.terms.seconds) * 100)}%`;
      if (left <= 0) {
        cd.className = "closed";
        if (note) note.textContent = "window closed since you loaded this slip; check again for what landed";
        if (ticker) clearInterval(ticker);
        ticker = null;
      }
    }, 1000);
  }
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function route(): void {
  const m = location.hash.match(/^#\/(t|demo)\/(0x[0-9a-fA-F]{40})$/);
  if (!m) return;
  const wanted: Mode = m[1] === "demo" ? "demo" : "live";
  if (wanted !== mode) setMode(wanted, true);
  q.value = m[2];
  void check(m[2], wanted);
}

function boot(): void {
  $<HTMLImageElement>("mark").src = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">${MASCOT_SVG_INNER}</svg>`)}`;
  rpcInput.value = storage("bouncer.rpc") ?? "";
  rpcInput.addEventListener("change", () => storage("bouncer.rpc", rpcInput.value.trim()));
  $("mode-demo").addEventListener("click", () => setMode("demo"));
  $("mode-live").addEventListener("click", () => setMode("live"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const address = q.value.trim();
    location.hash = `#/${mode === "demo" ? "demo" : "t"}/${address}`;
    // Same hash twice does not fire hashchange; run directly.
    void check(address, mode);
  });
  window.addEventListener("hashchange", route);
  setMode((storage("bouncer.mode") as Mode | null) ?? "demo", true);
  if (location.hash) route();
  else {
    q.value = DEMO.tokens.fresh.token;
    void check(DEMO.tokens.fresh.token, "demo");
  }
}

boot();
