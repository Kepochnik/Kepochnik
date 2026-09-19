/**
 * The smallest possible Blockscout v2 client: GET only, JSON only, one
 * base URL per chain. Used for what the RPC cannot answer cheaply: where a
 * wallet's first native funds came from (ONE CREW), which tokens carry a
 * given name or symbol (LOOKALIKE), and, for a token the launchpad did not
 * make, who holds it, who deployed it and when it last moved (OPEN DOOR).
 * Balances that matter are re-read from the chain before they reach a slip.
 */
export interface BlockscoutOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface FundingSource {
  /** The address that sent the earliest incoming native transfer found. */
  from: string;
  value: bigint;
  block: number;
  hash: string;
}

export interface TokenSearchHit {
  address: string;
  name: string;
  symbol: string;
}

export interface TokenHolder {
  address: string;
  value: bigint;
  isContract: boolean;
  /**
   * True when the address has code only because its owner signed an EIP-7702
   * delegation. The explorer reports those as contracts; they are wallets, and
   * on a chain where many people use smart accounts, counting them as contracts
   * understates how concentrated a token is among actual holders.
   */
  delegated: boolean;
  /** The explorer's label for the holder (a verified contract's name, a tag), when it has one. */
  name: string | null;
}

export interface TokenInfo {
  holders: number | null;
  transfers: number | null;
  /** Token standard as the explorer indexed it ("ERC-20", "ERC-721", …). */
  type: string | null;
  /** Explorer's price feed, when it has one; null otherwise. Not read from the chain. */
  priceUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
}

export interface AddressInfo {
  isContract: boolean;
  isVerified: boolean;
  /** The explorer's scam flag, when it sets one. */
  isScam: boolean;
  name: string | null;
  /** Who deployed it and in which transaction, when the explorer indexed the creation. */
  creator: string | null;
  creationTx: string | null;
}

export interface TokenTransfer {
  from: string;
  to: string;
  value: bigint;
  block: number;
  timestamp: number | null;
  hash: string;
}

export class BlockscoutClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BlockscoutOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Browsers drop the user-agent header silently; Node and workers send it, which keeps bot challenges away. */
  static readonly USER_AGENT = "Mozilla/5.0 (compatible; bouncer/0.3; +https://github.com/Kepochnik/bouncer)";

  /**
   * Calls and milliseconds per endpoint, the same way the RPC clients count.
   *
   * Added after a profile that did not add up: a door's fast half took 8.7
   * seconds and every RPC call in it summed to 4.6. The missing 4.1 seconds
   * were here and invisible, which is the same blind spot that cost an
   * afternoon of wrong guesses on the Solana side. A client this slip waits
   * on has to be countable.
   */
  private readonly counters = new Map<string, { calls: number; ms: number; failures: number }>();

  stats(): { path: string; calls: number; ms: number; failures: number }[] {
    return [...this.counters.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.ms - a.ms);
  }

  private record(path: string, ms: number, failed: boolean): void {
    // By endpoint shape, not by URL: "/tokens/0x…/holders" and the next
    // token's are the same call and belong in one row.
    const key = path.replace(/0x[0-9a-fA-F]{40,}/g, "{address}").replace(/\?.*$/, "").replace(/\/[1-9A-HJ-NP-Za-km-z]{32,44}(?=\/|$)/g, "/{mint}");
    const entry = this.counters.get(key) ?? { calls: 0, ms: 0, failures: 0 };
    entry.calls += 1;
    entry.ms += ms;
    if (failed) entry.failures += 1;
    this.counters.set(key, entry);
  }

  async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      // Browsers drop a user-agent set on fetch, so setting it there is at best
      // noise and at worst a preflight this endpoint has no reason to answer.
      if (typeof globalThis.window === "undefined") headers["user-agent"] = BlockscoutClient.USER_AGENT;
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "GET", headers, signal: controller.signal });
      if (!response.ok) throw new Error(`blockscout ${response.status} for ${path}`);
      const body = (await response.json()) as T;
      this.record(path, Date.now() - startedAt, false);
      return body;
    } catch (error) {
      // Recorded after the body, not before the request: a call that failed
      // parsing is a failure, and counting it as a success was exactly the
      // bug that made the EVM profiler lie about retries earlier today.
      this.record(path, Date.now() - startedAt, true);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Earliest incoming native transfer to `address` before `beforeBlock`,
   * walking at most `maxPages` pages of the address's transactions (newest
   * first). Fresh wallets have a handful of transactions, which is the case
   * that matters: a wallet funded once, minutes before a launch.
   */
  async fundingSource(address: string, beforeBlock: number, maxPages = 3): Promise<FundingSource | null> {
    let path = `/api/v2/addresses/${address}/transactions?filter=to`;
    let best: FundingSource | null = null;
    for (let page = 0; page < maxPages; page++) {
      const body = await this.get<{ items: BlockscoutTx[]; next_page_params: Record<string, string | number> | null }>(path);
      for (const tx of body.items ?? []) {
        const value = BigInt(tx.value ?? "0");
        const block = Number(tx.block_number ?? tx.block ?? 0);
        const to = (tx.to?.hash ?? "").toLowerCase();
        if (to !== address.toLowerCase() || value === 0n || block === 0 || block >= beforeBlock) continue;
        if (!best || block < best.block) best = { from: (tx.from?.hash ?? "").toLowerCase(), value, block, hash: tx.hash };
      }
      if (!body.next_page_params) break;
      const query = new URLSearchParams(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)]));
      path = `/api/v2/addresses/${address}/transactions?filter=to&${query.toString()}`;
    }
    return best;
  }

  /** Tokens whose name or symbol matches `query`, as Blockscout indexes them. */
  async searchTokens(query: string): Promise<TokenSearchHit[]> {
    const body = await this.get<{ items: { type: string; address?: string; address_hash?: string; name?: string; symbol?: string }[] }>(`/api/v2/search?q=${encodeURIComponent(query)}`);
    return (body.items ?? [])
      .filter((i) => i.type === "token" && (i.address || i.address_hash))
      .map((i) => ({ address: String(i.address ?? i.address_hash).toLowerCase(), name: i.name ?? "", symbol: i.symbol ?? "" }));
  }

  /** Largest holders first, as the explorer ranks them; `limit` caps the count, one page is 50. */
  async tokenHolders(token: string, limit = 50): Promise<TokenHolder[]> {
    const body = await this.get<{ items: BlockscoutHolder[] }>(`/api/v2/tokens/${token}/holders`);
    return (body.items ?? []).slice(0, limit).map((h) => ({
      address: (h.address?.hash ?? "").toLowerCase(),
      value: BigInt(h.value ?? "0"),
      isContract: Boolean(h.address?.is_contract),
      delegated: (h.address?.proxy_type ?? "").toLowerCase() === "eip7702",
      name: h.address?.name ?? h.address?.metadata?.tags?.[0]?.name ?? null,
    }));
  }

  /** Holder and transfer counts for a token; nulls when the explorer has not counted yet. */
  async tokenInfo(token: string): Promise<TokenInfo> {
    const info = await this.get<{ holders?: string | number; holders_count?: string | number; type?: string; exchange_rate?: string | null; volume_24h?: string | null; circulating_market_cap?: string | null }>(`/api/v2/tokens/${token}`);
    let transfers: number | null = null;
    let holders = numberOrNull(info.holders_count ?? info.holders);
    try {
      const counters = await this.get<{ token_holders_count?: string | number; transfers_count?: string | number }>(`/api/v2/tokens/${token}/counters`);
      transfers = numberOrNull(counters.transfers_count);
      holders = holders ?? numberOrNull(counters.token_holders_count);
    } catch {
      // counters are optional
    }
    return { holders, transfers, type: info.type ?? null, priceUsd: numberOrNull(info.exchange_rate ?? undefined), volume24hUsd: numberOrNull(info.volume_24h ?? undefined), marketCapUsd: numberOrNull(info.circulating_market_cap ?? undefined) };
  }

  /** What the explorer knows about an address: contract or not, verified, who created it. */
  async addressInfo(address: string): Promise<AddressInfo> {
    const body = await this.get<{ is_contract?: boolean; is_verified?: boolean; is_scam?: boolean; name?: string | null; creator_address_hash?: string | null; creation_transaction_hash?: string | null; creation_tx_hash?: string | null }>(`/api/v2/addresses/${address}`);
    return {
      isContract: Boolean(body.is_contract),
      isVerified: Boolean(body.is_verified),
      isScam: Boolean(body.is_scam),
      name: body.name ?? null,
      creator: body.creator_address_hash ? body.creator_address_hash.toLowerCase() : null,
      creationTx: body.creation_transaction_hash ?? body.creation_tx_hash ?? null,
    };
  }

  /** The newest token transfers the explorer indexed, newest first (one page). */
  async tokenTransfers(token: string): Promise<TokenTransfer[]> {
    const body = await this.get<{ items: BlockscoutTransfer[] }>(`/api/v2/tokens/${token}/transfers`);
    return (body.items ?? []).map((t) => ({
      from: (t.from?.hash ?? "").toLowerCase(),
      to: (t.to?.hash ?? "").toLowerCase(),
      value: BigInt(t.total?.value ?? "0"),
      block: Number(t.block_number ?? 0),
      timestamp: t.timestamp ? Math.floor(Date.parse(t.timestamp) / 1000) : null,
      hash: t.transaction_hash ?? t.tx_hash ?? "",
    }));
  }

  /** Whether the explorer holds verified source for the address. */
  async isVerified(address: string): Promise<boolean | null> {
    try {
      const body = await this.get<{ is_verified?: boolean; is_fully_verified?: boolean }>(`/api/v2/smart-contracts/${address}`);
      return Boolean(body.is_verified ?? body.is_fully_verified);
    } catch (error) {
      // 404 is the explorer answering "no verified source here"; anything else
      // means it did not answer, and the two must not read the same.
      if (error instanceof Error && /\b404\b/.test(error.message)) return false;
      return null;
    }
  }
}

function numberOrNull(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

interface BlockscoutHolder {
  address?: { hash: string; is_contract?: boolean; proxy_type?: string | null; name?: string | null; metadata?: { tags?: { name?: string }[] } | null };
  value?: string;
}

interface BlockscoutTransfer {
  from?: { hash: string };
  to?: { hash: string };
  total?: { value?: string };
  block_number?: number | string;
  timestamp?: string | null;
  transaction_hash?: string;
  tx_hash?: string;
}

interface BlockscoutTx {
  hash: string;
  value?: string;
  block_number?: number;
  block?: number;
  from?: { hash: string };
  to?: { hash: string } | null;
}
