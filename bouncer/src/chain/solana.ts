/**
 * Solana, read-only.
 *
 * The questions BOUNCER asks are the same on every chain, but on Solana most of
 * them are answered by a field rather than inferred from bytecode. An SPL mint
 * account states outright whether anyone can print more tokens and whether
 * anyone can freeze yours; a Token-2022 mint states whether a transfer costs a
 * fee, runs somebody's program, or can be reversed by a permanent delegate.
 * That makes the answers here stronger than their EVM equivalents, not weaker:
 * nothing below is a guess about what a dispatcher might contain.
 *
 * As on the EVM side, the method list is an allow-list of reads. There is no
 * transaction path, no signer and no key in this file.
 */
import { base58Decode, base58Encode } from "./base58.js";
import { isOnCurve } from "./ed25519.js";
import { sha256 } from "./sha256.js";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

const READ_ONLY_METHODS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenSupply",
  "getTokenLargestAccounts",
  "getSlot",
  "getBlockTime",
  "getHealth",
  "getVersion",
  "getSignaturesForAddress",
  "getEpochInfo",
]);

export class SolanaRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "SolanaRpcError";
  }
}

export interface SolanaRpcOptions {
  urls: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  minSpacingMs?: number;
  retries?: number;
}

export interface AccountInfo {
  /** The program that owns the account, which is what says an SPL mint is an SPL mint. */
  owner: string;
  lamports: number;
  executable: boolean;
  data: Uint8Array;
}

export class SolanaRpc {
  private readonly urls: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly minSpacingMs: number;
  private readonly retries: number;
  private activeIndex = 0;
  private nextId = 1;
  private lastRequestAt = 0;

  constructor(options: SolanaRpcOptions) {
    if (!options.urls.length) throw new Error("at least one RPC url is required");
    this.urls = options.urls;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.minSpacingMs = options.minSpacingMs ?? (options.fetchImpl ? 0 : 120);
    this.retries = options.retries ?? 2;
  }

  get activeUrl(): string {
    return this.urls[this.activeIndex];
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    if (!READ_ONLY_METHODS.has(method)) throw new SolanaRpcError(`refusing non-read method ${method}`);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.urls.length * this.retries; attempt++) {
      const url = this.urls[this.activeIndex];
      try {
        await this.pace();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (response.status === 429) throw new SolanaRpcError(`${url} rate limited (429)`, 429);
        if (!response.ok) throw new SolanaRpcError(`${url} responded ${response.status}`);
        const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string } };
        if (body.error) throw new SolanaRpcError(body.error.message, body.error.code);
        return body.result;
      } catch (error) {
        lastError = error;
        if (error instanceof SolanaRpcError && error.code === 429) {
          await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** Math.min(attempt, 4)));
          continue;
        }
        this.activeIndex = (this.activeIndex + 1) % this.urls.length;
      }
    }
    throw lastError instanceof Error ? lastError : new SolanaRpcError(String(lastError));
  }

  private async pace(): Promise<void> {
    if (this.minSpacingMs <= 0) return;
    const wait = this.lastRequestAt + this.minSpacingMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
  }

  async slot(): Promise<number> {
    return Number(await this.send("getSlot", [{ commitment: "confirmed" }]));
  }

  async blockTime(slot: number): Promise<number | null> {
    try {
      const value = await this.send("getBlockTime", [slot]);
      return value === null || value === undefined ? null : Number(value);
    } catch {
      return null;
    }
  }

  async accountInfo(address: string): Promise<AccountInfo | null> {
    const result = (await this.send("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }])) as { value: RawAccount | null } | null;
    return decodeAccount(result?.value ?? null);
  }

  async multipleAccounts(addresses: string[]): Promise<(AccountInfo | null)[]> {
    if (!addresses.length) return [];
    const out: (AccountInfo | null)[] = [];
    // The node caps a batch at 100 addresses.
    for (let i = 0; i < addresses.length; i += 100) {
      const slice = addresses.slice(i, i + 100);
      const result = (await this.send("getMultipleAccounts", [slice, { encoding: "base64", commitment: "confirmed" }])) as { value: (RawAccount | null)[] } | null;
      for (const value of result?.value ?? []) out.push(decodeAccount(value));
    }
    return out;
  }

  async tokenSupply(mint: string): Promise<{ amount: bigint; decimals: number } | null> {
    try {
      const result = (await this.send("getTokenSupply", [mint, { commitment: "confirmed" }])) as { value: { amount: string; decimals: number } } | null;
      if (!result?.value) return null;
      return { amount: BigInt(result.value.amount), decimals: Number(result.value.decimals) };
    } catch {
      return null;
    }
  }

  /** The 20 largest token accounts, which are accounts and not yet people: their owners are a second read. */
  async largestAccounts(mint: string): Promise<{ address: string; amount: bigint }[]> {
    const result = (await this.send("getTokenLargestAccounts", [mint, { commitment: "confirmed" }])) as { value: { address: string; amount: string }[] } | null;
    return (result?.value ?? []).map((v) => ({ address: v.address, amount: BigInt(v.amount) }));
  }
}

interface RawAccount {
  owner: string;
  lamports: number;
  executable: boolean;
  data: [string, string] | string;
}

function decodeAccount(raw: RawAccount | null): AccountInfo | null {
  if (!raw) return null;
  const encoded = Array.isArray(raw.data) ? raw.data[0] : raw.data;
  return { owner: raw.owner, lamports: Number(raw.lamports), executable: Boolean(raw.executable), data: base64ToBytes(encoded) };
}

function base64ToBytes(text: string): Uint8Array {
  if (!text) return new Uint8Array(0);
  if (typeof atob === "function") {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(text, "base64"));
}

// ---------------------------------------------------------------------------
// Account layouts
// ---------------------------------------------------------------------------

const MINT_SIZE = 82;
/** Where the extension type-length-value list starts on a Token-2022 mint. */
const TLV_START = 166;

export interface SplMint {
  /** Whoever can print more of this token, or null when nobody can. */
  mintAuthority: string | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  /** Whoever can freeze a holder's account, which is how a holder is stopped from selling. */
  freezeAuthority: string | null;
  /** True when the mint is owned by the Token-2022 program, which is where the extensions live. */
  token2022: boolean;
  extensions: TokenExtension[];
}

export type TokenExtension =
  | { kind: "transfer-fee"; feeBps: number; maximumFee: bigint; nextFeeBps: number; nextFeeEpoch: bigint; feeAuthority: string | null; withdrawAuthority: string | null }
  | { kind: "permanent-delegate"; delegate: string }
  | { kind: "transfer-hook"; programId: string | null; authority: string | null }
  | { kind: "mint-close-authority"; authority: string }
  | { kind: "default-account-state"; frozen: boolean }
  | { kind: "non-transferable" }
  | { kind: "pausable"; authority: string | null }
  | { kind: "interest-bearing"; rateBps: number; authority: string | null }
  | { kind: "metadata-pointer"; address: string | null }
  | { kind: "token-metadata"; name: string; symbol: string; uri: string; updateAuthority: string | null }
  | { kind: "other"; type: number };

/** Reads the SPL mint account. Returns null when the bytes are not a mint at all. */
export function parseMint(account: AccountInfo): SplMint | null {
  const d = account.data;
  if (d.length < MINT_SIZE) return null;
  if (account.owner !== TOKEN_PROGRAM && account.owner !== TOKEN_2022_PROGRAM) return null;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const mintAuthorityOption = view.getUint32(0, true);
  const freezeAuthorityOption = view.getUint32(46, true);
  const mint: SplMint = {
    mintAuthority: mintAuthorityOption === 1 ? base58Encode(d.slice(4, 36)) : null,
    supply: view.getBigUint64(36, true),
    decimals: d[44],
    isInitialized: d[45] === 1,
    freezeAuthority: freezeAuthorityOption === 1 ? base58Encode(d.slice(50, 82)) : null,
    token2022: account.owner === TOKEN_2022_PROGRAM,
    extensions: [],
  };
  if (mint.token2022 && d.length > TLV_START) mint.extensions = parseExtensions(d.slice(TLV_START));
  return mint;
}

/** Token-2022 extensions, as a type-length-value list. Unknown types are kept as their number rather than dropped. */
export function parseExtensions(tlv: Uint8Array): TokenExtension[] {
  const out: TokenExtension[] = [];
  const view = new DataView(tlv.buffer, tlv.byteOffset, tlv.byteLength);
  let offset = 0;
  while (offset + 4 <= tlv.length) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const start = offset + 4;
    if (type === 0 || start + length > tlv.length) break;
    const value = tlv.slice(start, start + length);
    out.push(parseExtension(type, value));
    offset = start + length;
  }
  return out;
}

function optionalKey(bytes: Uint8Array): string | null {
  if (bytes.length !== 32) return null;
  return bytes.every((b) => b === 0) ? null : base58Encode(bytes);
}

function parseExtension(type: number, v: Uint8Array): TokenExtension {
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength);
  switch (type) {
    case 1: {
      // TransferFeeConfig: two authorities, the withheld total, then the fee in
      // force this epoch and the fee that takes over at a named epoch.
      if (v.length < 108) return { kind: "other", type };
      const older = 72;
      const newer = 90;
      return {
        kind: "transfer-fee",
        feeAuthority: optionalKey(v.slice(0, 32)),
        withdrawAuthority: optionalKey(v.slice(32, 64)),
        maximumFee: view.getBigUint64(older + 8, true),
        feeBps: view.getUint16(older + 16, true),
        nextFeeEpoch: view.getBigUint64(newer, true),
        nextFeeBps: view.getUint16(newer + 16, true),
      };
    }
    case 3:
      return v.length >= 32 ? { kind: "mint-close-authority", authority: base58Encode(v.slice(0, 32)) } : { kind: "other", type };
    case 6:
      // AccountState: 0 uninitialized, 1 initialized, 2 frozen.
      return { kind: "default-account-state", frozen: v[0] === 2 };
    case 9:
      return { kind: "non-transferable" };
    case 10:
      return v.length >= 34 ? { kind: "interest-bearing", authority: optionalKey(v.slice(0, 32)), rateBps: view.getInt16(v.length - 2, true) } : { kind: "other", type };
    case 12:
      return v.length >= 32 ? { kind: "permanent-delegate", delegate: base58Encode(v.slice(0, 32)) } : { kind: "other", type };
    case 14:
      return v.length >= 64 ? { kind: "transfer-hook", authority: optionalKey(v.slice(0, 32)), programId: optionalKey(v.slice(32, 64)) } : { kind: "other", type };
    case 18:
      return v.length >= 64 ? { kind: "metadata-pointer", address: optionalKey(v.slice(32, 64)) } : { kind: "other", type };
    case 19: {
      // TokenMetadata: update authority, mint, then three borsh strings.
      if (v.length < 64) return { kind: "other", type };
      let offset = 64;
      const read = () => {
        if (offset + 4 > v.length) return "";
        const length = view.getUint32(offset, true);
        offset += 4;
        const text = new TextDecoder().decode(v.slice(offset, offset + length));
        offset += length;
        return text;
      };
      return { kind: "token-metadata", updateAuthority: optionalKey(v.slice(0, 32)), name: read(), symbol: read(), uri: read() };
    }
    case 26:
      return { kind: "pausable", authority: optionalKey(v.slice(0, 32)) };
    default:
      return { kind: "other", type };
  }
}

/** A token account's owner sits at offset 32; that is how twenty accounts become however many people. */
export function tokenAccountOwner(account: AccountInfo): string | null {
  if (account.data.length < 72) return null;
  return base58Encode(account.data.slice(32, 64));
}

// ---------------------------------------------------------------------------
// Program-derived addresses
// ---------------------------------------------------------------------------

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/**
 * The Solana definition: hash the seeds, a bump and the program id, and take
 * the first result that is NOT a point on the ed25519 curve, counting the bump
 * down from 255. An address off the curve has no private key, which is the
 * whole point of one.
 */
export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } | null {
  const program = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, new Uint8Array([bump]), program, PDA_MARKER];
    let total = 0;
    for (const p of parts) total += p.length;
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      buffer.set(p, offset);
      offset += p.length;
    }
    const candidate = sha256(buffer);
    if (!isOnCurve(candidate)) return { address: base58Encode(candidate), bump };
  }
  return null;
}

/** Where Metaplex keeps the name and symbol of a classic SPL token. */
export function metadataAddress(mint: string): string | null {
  const seeds = [new TextEncoder().encode("metadata"), base58Decode(METADATA_PROGRAM), base58Decode(mint)];
  return findProgramAddress(seeds, METADATA_PROGRAM)?.address ?? null;
}

export interface Metaplex {
  updateAuthority: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  primarySaleHappened: boolean;
  /** False means the name, symbol and link are frozen; true means the update authority can change them. */
  isMutable: boolean;
}

/** Reads a Metaplex metadata account. Returns null when the bytes are not one. */
export function parseMetadata(account: AccountInfo): Metaplex | null {
  const d = account.data;
  if (d.length < 100 || d[0] !== 4) return null;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let offset = 1;
  const updateAuthority = base58Encode(d.slice(offset, offset + 32));
  offset += 32;
  const mint = base58Encode(d.slice(offset, offset + 32));
  offset += 32;
  const readString = (): string => {
    if (offset + 4 > d.length) return "";
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > 1_000 || offset + length > d.length) return "";
    const text = new TextDecoder().decode(d.slice(offset, offset + length));
    offset += length;
    // Metaplex pads its fixed-width strings with NUL bytes.
    return text.replace(/\0+$/, "");
  };
  const name = readString();
  const symbol = readString();
  const uri = readString();
  if (offset + 2 > d.length) return null;
  const sellerFeeBasisPoints = view.getUint16(offset, true);
  offset += 2;
  // creators: Option<Vec<Creator>>, each 32 + 1 + 1 bytes
  if (d[offset] === 1) {
    offset += 1;
    const count = view.getUint32(offset, true);
    offset += 4 + count * 34;
  } else {
    offset += 1;
  }
  if (offset + 2 > d.length) return null;
  return { updateAuthority, mint, name, symbol, uri, sellerFeeBasisPoints, primarySaleHappened: d[offset] === 1, isMutable: d[offset + 1] === 1 };
}
