/**
 * What does this endpoint actually serve?
 *
 * Public Solana endpoints differ in which reads they answer, and the
 * difference decides whether a whole section of the slip exists. I got this
 * wrong in public once: I said no free endpoint serves `getTokenLargestAccounts`,
 * and a direct probe of eight of them disproved it — the method is served and
 * rate-limited, which is a completely different problem with a completely
 * different fix. So the tool stops reasoning about endpoints and asks them.
 *
 * Each method is tried against one URL, deliberately without the client's
 * failover: the question is what THIS endpoint does, and an answer that came
 * from a different one would be worse than no answer. Every probe is a read,
 * with arguments chosen so the answer is small whatever it is.
 */
export type MethodVerdict = "served" | "rate-limited" | "refused" | "no answer";

export interface MethodProbe {
  method: string;
  verdict: MethodVerdict;
  ms: number;
  /** What the endpoint said, when it said anything. */
  detail: string;
}

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * The reads BOUNCER makes, with the smallest arguments that still exercise
 * them. `what` says which part of a slip goes missing when one is refused,
 * because "getTokenLargestAccounts: refused" means nothing to somebody who
 * just wants to know why the holders table is empty.
 */
const PROBES: { method: string; params: unknown[]; what: string }[] = [
  { method: "getSlot", params: [{ commitment: "confirmed" }], what: "everything: this is the lightest read there is" },
  { method: "getAccountInfo", params: [USDC, { encoding: "base64", commitment: "confirmed" }], what: "the mint itself — who can print, who can freeze, the Token-2022 extensions" },
  { method: "getMultipleAccounts", params: [[USDC], { encoding: "base64", commitment: "confirmed" }], what: "pool discovery and the liquidity lock, which are derived addresses read in one call" },
  { method: "getTokenSupply", params: [USDC, { commitment: "confirmed" }], what: "the supply, and every share worked out against it" },
  { method: "getTokenLargestAccounts", params: [USDC, { commitment: "confirmed" }], what: "the holders table, and the vault walk that finds pools with no derivable address" },
  { method: "getTokenAccountsByOwner", params: [TOKEN_PROGRAM, { programId: TOKEN_PROGRAM }, { encoding: "base64", commitment: "confirmed" }], what: "reading both sides of a pool once its vault is found" },
  { method: "getSignaturesForAddress", params: [USDC, { limit: 1 }], what: "when the mint last moved" },
  { method: "getEpochInfo", params: [{ commitment: "confirmed" }], what: "nothing on a slip; it is here because an endpoint that refuses it is unusual" },
];

/** One read, against one URL, with no failover and no retry. */
async function probeOne(
  url: string,
  probe: { method: string; params: unknown[] },
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ verdict: MethodVerdict; ms: number; detail: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: probe.method, params: probe.params }),
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    // A throttle and a refusal look alike from a distance and are not alike at
    // all: one is solved by waiting or by paying, the other by using a
    // different endpoint. Saying the wrong one sends the reader after the
    // wrong fix, which is what happened here once already.
    if (response.status === 429) return { verdict: "rate-limited", ms, detail: "HTTP 429" };
    if (response.status === 403 || response.status === 401) return { verdict: "refused", ms, detail: `HTTP ${response.status}` };
    if (!response.ok) return { verdict: "no answer", ms, detail: `HTTP ${response.status}` };
    const body = (await response.json()) as { result?: unknown; error?: { code?: number; message?: string } };
    if (body.error) {
      const message = body.error.message ?? "an error with no message";
      if (/rate|limit|too many/i.test(message)) return { verdict: "rate-limited", ms, detail: message };
      // -32601 is "method not found"; the rest of the disabled-method messages
      // are prose, and the prose is what public endpoints actually send.
      if (body.error.code === -32601 || /disabled|not (supported|available|enabled)|excluded/i.test(message)) {
        return { verdict: "refused", ms, detail: message };
      }
      return { verdict: "no answer", ms, detail: message };
    }
    return { verdict: "served", ms, detail: "" };
  } catch (error) {
    const ms = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    return { verdict: "no answer", ms, detail: /abort/i.test(message) ? `no reply in ${timeoutMs} ms` : message };
  } finally {
    clearTimeout(timer);
  }
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Every read BOUNCER makes, asked of one endpoint, in order. */
export async function probeEndpoint(url: string, options: ProbeOptions = {}): Promise<MethodProbe[]> {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 7_000;
  const out: MethodProbe[] = [];
  // One at a time. Firing eight at once at an endpoint that rate-limits would
  // measure the burst rather than the endpoint, and report "rate-limited" for
  // methods it serves perfectly well.
  for (const probe of PROBES) {
    const result = await probeOne(url, probe, fetchImpl, timeoutMs);
    out.push({ method: probe.method, ...result });
  }
  return out;
}

/** What each probe means for the slip, for a reader who does not know the method names. */
export function whatItCosts(method: string): string {
  return PROBES.find((p) => p.method === method)?.what ?? "";
}

/** One line summarising an endpoint, for somebody deciding whether to point BOUNCER elsewhere. */
export function probeInWords(probes: MethodProbe[]): string {
  const served = probes.filter((p) => p.verdict === "served").length;
  const throttled = probes.filter((p) => p.verdict === "rate-limited");
  const refused = probes.filter((p) => p.verdict === "refused");
  if (served === probes.length) return `This endpoint served all ${probes.length} reads BOUNCER makes.`;
  const parts = [`${served} of ${probes.length} reads served`];
  if (throttled.length) parts.push(`${throttled.length} rate-limited (${throttled.map((p) => p.method).join(", ")}) — a limit, not a missing feature, so it may work on a quieter minute`);
  if (refused.length) parts.push(`${refused.length} refused outright (${refused.map((p) => p.method).join(", ")}) — this endpoint will not serve them at any rate`);
  return `${parts.join("; ")}.`;
}
