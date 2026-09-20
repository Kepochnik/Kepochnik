/**
 * JSON-RPC over fetch. Read methods only: the client exposes eth_call,
 * eth_getLogs, block lookups and chain identity. There is deliberately no
 * eth_sendRawTransaction, eth_sign or account method on this surface.
 */
import type { Hex, RawLog } from "./abi.js";

export interface RpcOptions {
  urls: string[];
  expectedChainId: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Minimum spacing between requests; public endpoints rate-limit bursts. */
  minSpacingMs?: number;
  /** Retries on 429 / -32005 style rate limits, with backoff. */
  rateLimitRetries?: number;
  /**
   * Remember answers to reads pinned to a block, for the life of this client.
   *
   * The page reads the same token three times — the chain only, then with
   * the market and the explorer, then everything — so a reader sees
   * something true before the slowest server has answered. Pinned to one
   * block, the second and third passes ask most of the same questions and
   * must get the same answers, so asking again is pure waste: 54 requests
   * where 26 would do.
   *
   * Only reads with an explicit block number are remembered. Anything
   * against "latest", "pending", "safe" or "finalized" is asked every time,
   * because the whole point of those tags is that the answer moves. Give
   * each read its own client; a client that outlives one read would start
   * serving yesterday's chain.
   */
  memo?: boolean;
}

export interface RpcRequest {
  method: string;
  params: unknown[];
}

export interface BlockHeader {
  number: number;
  timestamp: number;
  hash: string;
}

export interface LogFilter {
  address?: string | string[];
  topics?: (string | string[] | null)[];
  fromBlock: number;
  toBlock: number;
}

const READ_ONLY_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionReceipt",
  "eth_getStorageAt",
]);

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
    /** "application" when the node answered with a JSON-RPC error, "transport" when the request itself failed. */
    readonly kind: "transport" | "application" = "transport",
  ) {
    super(message);
    this.name = "RpcError";
  }

  /**
   * True when the node ran the call and the EVM reverted. That is a fact about
   * the contract; every other error is a fact about the network, and the two
   * must never be confused: a rate-limited probe is not a trapping token.
   */
  get isRevert(): boolean {
    if (this.kind !== "application") return false;
    if (typeof this.data === "string" && this.data.startsWith("0x")) return true;
    if (this.code === 3) return true;
    return /execution reverted|execution error|invalid opcode|out of gas/i.test(this.message);
  }

  /** True when the endpoint is asking us to slow down, whether it said so in HTTP or in JSON-RPC. */
  get isRateLimit(): boolean {
    return this.code === 429 || this.code === -32005 || /rate limited|rate limit|too many requests/i.test(this.message);
  }
}

export class RpcClient {
  private readonly urls: string[];
  private readonly expectedChainId: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly minSpacingMs: number;
  private readonly rateLimitRetries: number;
  private activeIndex = 0;
  /**
   * Calls, milliseconds and failures per method. The Solana side got this
   * after three wrong diagnoses in a row, and it found the answer on the
   * first run; a Base door that takes minutes deserves the same treatment
   * rather than another plausible story.
   */
  private readonly counters = new Map<string, { calls: number; ms: number; failures: number }>();
  /** One entry per request that reached the wire; see slowest(). Bounded so a log walk cannot grow it without limit. */
  private readonly requestLog: { label: string; size: number; ms: number }[] = [];
  private nextId = 1;
  /** See RpcOptions.memo. Null when off, which is the default. */
  private readonly memo: Map<string, { ok: true; value: unknown } | { ok: false; error: RpcError }> | null;
  private verifiedChain = false;
  private lastRequestAt = 0;

  constructor(options: RpcOptions) {
    if (options.urls.length === 0) throw new Error("at least one RPC url is required");
    this.urls = options.urls;
    this.expectedChainId = options.expectedChainId;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.minSpacingMs = options.minSpacingMs ?? (options.fetchImpl ? 0 : 120);
    this.rateLimitRetries = options.rateLimitRetries ?? 3;
    this.memo = options.memo ? new Map() : null;
  }

  /** How many reads the memo answered without asking anybody. */
  memoHits = 0;

  get activeUrl(): string {
    return this.urls[this.activeIndex];
  }

  async chainId(): Promise<number> {
    const hex = (await this.send("eth_chainId", [])) as string;
    return Number(BigInt(hex));
  }

  async assertChain(): Promise<void> {
    if (this.verifiedChain) return;
    const id = await this.chainId();
    if (id !== this.expectedChainId) {
      throw new RpcError(`endpoint ${this.activeUrl} reports chain ${id}, expected ${this.expectedChainId}`);
    }
    this.verifiedChain = true;
  }

  async blockNumber(): Promise<number> {
    const hex = (await this.send("eth_blockNumber", [])) as string;
    return Number(BigInt(hex));
  }

  /**
   * The head block and the chain-identity check in one round trip.
   *
   * Every read starts here, and it used to cost three: eth_chainId, then
   * eth_blockNumber, then eth_getBlockByNumber for that number. The first two
   * answers are not needed to ask the third, and "latest" already returns the
   * number, so all three were one batch pretending to be a queue.
   */
  async head(): Promise<BlockHeader> {
    if (this.verifiedChain) return this.getBlock("latest");
    const [idHex, raw] = await this.sendBatch([
      { method: "eth_chainId", params: [] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
    ]);
    const id = Number(BigInt(idHex as string));
    if (id !== this.expectedChainId) {
      throw new RpcError(`endpoint ${this.activeUrl} reports chain ${id}, expected ${this.expectedChainId}`);
    }
    this.verifiedChain = true;
    return toHeader(raw, "latest");
  }

  async getBlock(blockNumber: number | "latest"): Promise<BlockHeader> {
    const tag = blockNumber === "latest" ? "latest" : toHex(blockNumber);
    return toHeader(await this.send("eth_getBlockByNumber", [tag, false]), tag);
  }

  async call(to: string, data: Hex, blockNumber: number | "latest" = "latest"): Promise<Hex> {
    const tag = blockNumber === "latest" ? "latest" : toHex(blockNumber);
    const result = (await this.send("eth_call", [{ to, data }, tag])) as string;
    return result as Hex;
  }

  /** Several eth_call reads pinned to one block, sent as one JSON-RPC batch. */
  async callBatch(calls: { to: string; data: Hex }[], blockNumber: number): Promise<Hex[]> {
    const tag = toHex(blockNumber);
    const results = await this.sendBatch(
      calls.map((call) => ({ method: "eth_call", params: [{ to: call.to, data: call.data }, tag] })),
    );
    return results as Hex[];
  }

  /** Runtime bytecode at an address, pinned to a block. "0x" for an EOA. */
  async getCode(address: string, blockNumber: number | "latest" = "latest"): Promise<Hex> {
    const tag = blockNumber === "latest" ? "latest" : toHex(blockNumber);
    return (await this.send("eth_getCode", [address, tag])) as Hex;
  }

  /** One storage word, pinned to a block. Used only to read the EIP-1967 proxy slots. */
  async getStorageAt(address: string, slot: Hex, blockNumber: number | "latest" = "latest"): Promise<Hex> {
    const tag = blockNumber === "latest" ? "latest" : toHex(blockNumber);
    return (await this.send("eth_getStorageAt", [address, slot, tag])) as Hex;
  }

  async getLogs(filter: LogFilter): Promise<RawLog[]> {
    const params = {
      address: filter.address,
      topics: filter.topics,
      fromBlock: toHex(filter.fromBlock),
      toBlock: toHex(filter.toBlock),
    };
    return (await this.send("eth_getLogs", [params])) as RawLog[];
  }

  /**
   * Public endpoints cap the block span of one eth_getLogs request. This
   * walks the range in chunks and never invents data for a chunk that fails:
   * the error propagates so the caller can report "unknown", not "zero".
   */
  async getLogsChunked(filter: LogFilter, chunkSize: number): Promise<RawLog[]> {
    const logs: RawLog[] = [];
    for (let from = filter.fromBlock; from <= filter.toBlock; from += chunkSize) {
      const to = Math.min(from + chunkSize - 1, filter.toBlock);
      logs.push(...(await this.getLogs({ ...filter, fromBlock: from, toBlock: to })));
    }
    return logs;
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    const [result] = await this.sendBatch([{ method, params }]);
    return result;
  }

  /**
   * Like sendBatch, but a call the node answered with an error comes back as
   * that error instead of discarding every other answer in the batch. One
   * contract without a slot0() must not cost the caller the reserves of three
   * pools that were read perfectly well.
   */
  async sendBatchSettled(requests: RpcRequest[]): Promise<(unknown | RpcError)[]> {
    return this.dispatch(requests, true);
  }

  /** Several eth_call reads pinned to one block, each answered or failed on its own. */
  async callBatchSettled(calls: { to: string; data: Hex }[], blockNumber: number): Promise<(Hex | RpcError)[]> {
    const tag = toHex(blockNumber);
    const answers = await this.sendBatchSettled(calls.map((call) => ({ method: "eth_call", params: [{ to: call.to, data: call.data }, tag] })));
    return answers.map((a) => (a instanceof RpcError ? a : (a as Hex)));
  }

  async sendBatch(requests: RpcRequest[]): Promise<unknown[]> {
    return this.dispatch(requests, false);
  }

  /**
   * The slowest individual requests, newest cost first.
   *
   * The per-method numbers cannot answer "which request was slow", because a
   * batch's time is charged to every method in it: 86 eth_calls and 8.3
   * seconds could be one heavy batch or twenty light ones, and those call for
   * opposite fixes. This records each request as it lands, so the next
   * profile names the batch instead of the method.
   */
  slowest(limit = 8): { label: string; size: number; ms: number }[] {
    return [...this.requestLog].sort((a, b) => b.ms - a.ms).slice(0, limit);
  }

  /** Per-method call counts and total milliseconds, for working out where a slow read went. */
  stats(): { method: string; calls: number; ms: number; failures: number }[] {
    return [...this.counters.entries()].map(([method, v]) => ({ method, ...v })).sort((a, b) => b.ms - a.ms);
  }

  private record(requests: RpcRequest[], ms: number, failed: boolean): void {
    if (this.requestLog.length < 400) {
      const counts = new Map<string, number>();
      for (const r of requests) counts.set(r.method, (counts.get(r.method) ?? 0) + 1);
      const label = [...counts].map(([m, n]) => (n === 1 ? m : `${m} ×${n}`)).join(" + ");
      this.requestLog.push({ label: failed ? `${label} (failed)` : label, size: requests.length, ms });
    }
    // A batch is one round trip shared by its members, so the time is charged
    // once to each method in it rather than multiplied by the batch size.
    const methods = new Set(requests.map((r) => r.method));
    for (const method of methods) {
      const entry = this.counters.get(method) ?? { calls: 0, ms: 0, failures: 0 };
      entry.calls += requests.filter((r) => r.method === method).length;
      entry.ms += ms;
      if (failed) entry.failures += 1;
      this.counters.set(method, entry);
    }
  }

  /**
   * The memo sits in front of the wire, not behind it: a batch of ten where
   * seven are already known sends three, and a batch where all ten are known
   * sends nothing at all and costs no round trip.
   */
  private async dispatch(requests: RpcRequest[], settled: boolean): Promise<unknown[]> {
    if (!this.memo) return this.fetchAll(requests, settled);
    const keys = requests.map((request) => memoKey(request));
    const answers: unknown[] = new Array(requests.length);
    const missing: number[] = [];
    for (let i = 0; i < requests.length; i++) {
      const key = keys[i];
      const hit = key === null ? undefined : this.memo.get(key);
      if (!hit) {
        missing.push(i);
        continue;
      }
      this.memoHits++;
      if (hit.ok) answers[i] = hit.value;
      // A revert at a pinned block is deterministic, so it is remembered too
      // — and handed back the way this caller asked for it.
      else if (settled) answers[i] = hit.error;
      else throw hit.error;
    }
    if (missing.length) {
      const fresh = await this.fetchAll(
        missing.map((i) => requests[i]),
        settled,
      );
      missing.forEach((target, j) => {
        const value = fresh[j];
        answers[target] = value;
        const key = keys[target];
        if (key !== null) this.memo!.set(key, value instanceof RpcError ? { ok: false, error: value } : { ok: true, value });
      });
    }
    return answers;
  }

  private async fetchAll(requests: RpcRequest[], settled: boolean): Promise<unknown[]> {
    for (const request of requests) {
      if (!READ_ONLY_METHODS.has(request.method)) {
        throw new RpcError(`refusing non-read method ${request.method}`);
      }
    }
    const payload = requests.map((request) => ({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: request.method,
      params: request.params,
    }));

    let lastError: unknown;
    const startedAt = Date.now();
    const attempts = this.urls.length * (this.rateLimitRetries + 1);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const url = this.urls[this.activeIndex];
      try {
        await this.pace();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (compatible; bouncer/0.1; +https://github.com/Kepochnik/bouncer)" },
          body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (response.status === 429) throw new RpcError(`${url} rate limited (429)`, 429);
        if (!response.ok) throw new RpcError(`${url} responded ${response.status}`);
        const body = (await response.json()) as unknown;
        const items = Array.isArray(body) ? body : [body];
        const byId = new Map<number, { result?: unknown; error?: { code: number; message: string; data?: unknown } }>();
        for (const item of items as { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }[]) {
          byId.set(item.id, item);
        }
        const answers = payload.map((request) => {
          const item = byId.get(request.id);
          if (!item) throw new RpcError(`missing response for ${request.method}`);
          if (item.error) {
            const failure = new RpcError(item.error.message, item.error.code, item.error.data, "application");
            // A rate limit is the endpoint talking, not the contract: it has to
            // reach the retry loop rather than be handed back as one call's answer.
            if (settled && !failure.isRateLimit) return failure;
            throw failure;
          }
          return item.result;
        });
        // Recorded only once the answer is actually in hand. Recording before
        // this line counted a batch again on every retry, which is how the
        // profile reported 286 receipt calls for a read that asks for at most
        // sixty — an instrument that lies is worse than no instrument.
        this.record(requests, Date.now() - startedAt, false);
        return answers;
      } catch (error) {
        lastError = error;
        if (error instanceof RpcError && error.isRateLimit) {
          // Back off, and move on: an endpoint that is rate-limiting this caller
          // will still be rate-limiting it in a second, while a sibling is idle.
          if (this.urls.length > 1) this.activeIndex = (this.activeIndex + 1) % this.urls.length;
          await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** Math.min(attempt, 4)));
          continue;
        }
        // A revert is the node's answer, not a failure to reach it: deterministic,
        // so retrying it on another endpoint only spends round trips to get the
        // same reply, and rotating the endpoint would blame the network for it.
        if (error instanceof RpcError && error.isRevert) throw error;
        this.activeIndex = (this.activeIndex + 1) % this.urls.length;
        this.verifiedChain = false;
      }
    }
    this.record(requests, Date.now() - startedAt, true);
    throw lastError instanceof Error ? lastError : new RpcError(String(lastError));
  }

  private async pace(): Promise<void> {
    if (this.minSpacingMs <= 0) return;
    const wait = this.lastRequestAt + this.minSpacingMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
  }
}

/**
 * The key a read is remembered under, or null for a read that must not be.
 *
 * A block tag that moves makes the answer move with it, and there is no
 * version of this cache that can be right about "latest".
 */
const MOVING_TAGS = ['"latest"', '"pending"', '"safe"', '"finalized"', '"earliest"'];

function memoKey(request: RpcRequest): string | null {
  const params = JSON.stringify(request.params);
  for (const tag of MOVING_TAGS) if (params.includes(tag)) return null;
  return `${request.method}|${params}`;
}

function toHeader(raw: unknown, tag: string): BlockHeader {
  const block = raw as { number: string; timestamp: string; hash: string } | null;
  if (!block) throw new RpcError(`block ${tag} not found`);
  return { number: Number(BigInt(block.number)), timestamp: Number(BigInt(block.timestamp)), hash: block.hash };
}

export function toHex(value: number | bigint): Hex {
  return `0x${value.toString(16)}`;
}
