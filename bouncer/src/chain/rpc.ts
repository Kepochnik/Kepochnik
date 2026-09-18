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
  private nextId = 1;
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
  }

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

  async getBlock(blockNumber: number | "latest"): Promise<BlockHeader> {
    const tag = blockNumber === "latest" ? "latest" : toHex(blockNumber);
    const block = (await this.send("eth_getBlockByNumber", [tag, false])) as {
      number: string;
      timestamp: string;
      hash: string;
    } | null;
    if (!block) throw new RpcError(`block ${tag} not found`);
    return {
      number: Number(BigInt(block.number)),
      timestamp: Number(BigInt(block.timestamp)),
      hash: block.hash,
    };
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

  private async dispatch(requests: RpcRequest[], settled: boolean): Promise<unknown[]> {
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
        return payload.map((request) => {
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
    throw lastError instanceof Error ? lastError : new RpcError(String(lastError));
  }

  private async pace(): Promise<void> {
    if (this.minSpacingMs <= 0) return;
    const wait = this.lastRequestAt + this.minSpacingMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
  }
}

export function toHex(value: number | bigint): Hex {
  return `0x${value.toString(16)}`;
}
