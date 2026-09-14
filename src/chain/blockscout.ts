/**
 * The smallest possible Blockscout v2 client: GET only, JSON only, one
 * base URL per chain. Used for two things the RPC cannot answer cheaply:
 * where a wallet's first native funds came from (ONE CREW) and which tokens
 * carry a given name or symbol (LOOKALIKE). Everything it returns is
 * cross-checked against the factory before it reaches a slip.
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

export class BlockscoutClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BlockscoutOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`blockscout ${response.status} for ${path}`);
      return (await response.json()) as T;
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

  /** Whether the explorer holds verified source for the address. */
  async isVerified(address: string): Promise<boolean | null> {
    try {
      const body = await this.get<{ is_verified?: boolean; is_fully_verified?: boolean }>(`/api/v2/smart-contracts/${address}`);
      return Boolean(body.is_verified ?? body.is_fully_verified);
    } catch {
      return null;
    }
  }
}

interface BlockscoutTx {
  hash: string;
  value?: string;
  block_number?: number;
  block?: number;
  from?: { hash: string };
  to?: { hash: string } | null;
}
