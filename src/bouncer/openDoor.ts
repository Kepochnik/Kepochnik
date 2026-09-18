/**
 * OPEN DOOR: the check for a token the launchpad did not make. A Pons
 * launch comes with rules the factory enforces; an ordinary ERC-20 comes
 * with whatever its author wrote. So the questions change: who can still
 * change the rules (owner, mint, pause, blacklist, fees, upgrade), can a
 * plain holder move their tokens right now, who holds the supply, who
 * deployed it and when it last traded. Function names are read off the
 * bytecode's dispatcher; every balance is re-read from the chain; the
 * explorer supplies what the chain cannot list (holders, creator, recent
 * transfers). Nothing here is a score. Each line is a fact with a source.
 */
import { decodeOutputs, encodeCall, selector, type FunctionAbi, type Hex } from "../chain/abi.js";
import type { BlockscoutClient, TokenHolder, TokenTransfer } from "../chain/blockscout.js";
import type { ChainConfig } from "../chain/chains.js";
import { pushedSelectors } from "../chain/code.js";
import { ERC20_FUNCTIONS, ZERO_ADDRESS } from "../chain/pons.js";
import type { TokenMeta } from "../chain/reader.js";
import { RpcError, type RpcClient } from "../chain/rpc.js";
import type { ContractId } from "./idCheck.js";

export type PowerKind = "mint" | "pause" | "blacklist" | "fees" | "limits" | "trading" | "upgrade" | "burn-others" | "exempt" | "sweep";

export interface Power {
  kind: PowerKind;
  /** The function signature whose selector sits in the dispatcher. */
  signature: string;
}

/** What each power lets its holder do, in plain words. */
export const POWER_MEANING: Record<PowerKind, string> = {
  mint: "create new tokens out of thin air, diluting every holder",
  pause: "freeze every transfer",
  blacklist: "block chosen wallets from selling",
  fees: "change the tax on buys and sells",
  limits: "change or remove per-wallet and per-trade caps",
  trading: "switch trading on or off",
  upgrade: "replace the contract's code",
  "burn-others": "destroy tokens held by other wallets",
  exempt: "exempt chosen wallets from fees or limits",
  sweep: "pull tokens or coins that sit in the contract",
};

/**
 * Signatures worth knowing about. The list is deliberately broad on the
 * names token generators use; a miss means "not seen", never "not there".
 */
export const POWER_SIGNATURES: Record<PowerKind, string[]> = {
  mint: ["mint(address,uint256)", "mint(uint256)", "mint(address)", "mintTo(address,uint256)", "issue(uint256)", "issue(address,uint256)"],
  pause: ["pause()", "unpause()", "setPaused(bool)", "pauseTransfers(bool)"],
  blacklist: [
    "blacklist(address)", "blacklist(address,bool)", "addBlacklist(address)", "addToBlacklist(address)", "setBlacklist(address,bool)", "setBlacklisted(address,bool)", "blacklistAddress(address,bool)", "setIsBlacklisted(address,bool)", "blockAccount(address)", "blockAddress(address)", "setBots(address[],bool)", "addBots(address[])", "addBot(address)", "setBot(address,bool)", "delBot(address)", "blacklistAccount(address,bool)", "setBlacklistEnabled(bool)", "banAddress(address)", "setBanned(address,bool)", "blacklistBots(address[])", "multiBlacklist(address[])", "blacklistMultipleWallets(address[])", "addSniper(address)", "setSniper(address,bool)",
  ],
  fees: [
    "setFee(uint256)", "setFees(uint256,uint256)", "setFees(uint256,uint256,uint256)", "setTaxes(uint256,uint256)", "setTax(uint256)", "setBuyFee(uint256)", "setSellFee(uint256)", "setBuyTax(uint256)", "setSellTax(uint256)", "updateFees(uint256,uint256)", "updateBuyFees(uint256,uint256)", "updateSellFees(uint256,uint256)", "updateBuyFees(uint256,uint256,uint256)", "updateSellFees(uint256,uint256,uint256)", "setTaxFee(uint256)", "setTaxFeePercent(uint256)", "setLiquidityFeePercent(uint256)", "setFeePercent(uint256)", "setTransferFee(uint256)", "setTransferTax(uint256)", "reduceFee(uint256)", "reduceFees(uint256,uint256)", "changeFees(uint256,uint256)", "setSellFeePercent(uint256)", "setBuyFeePercent(uint256)", "setMarketingFee(uint256)", "setFeeRate(uint256)", "updateTaxes(uint256,uint256)", "setTradingFees(uint256,uint256)",
  ],
  limits: [
    "setMaxTxAmount(uint256)", "setMaxTx(uint256)", "setMaxTxPercent(uint256)", "setMaxWallet(uint256)", "setMaxWalletAmount(uint256)", "setMaxWalletPercent(uint256)", "setMaxWalletSize(uint256)", "updateMaxTxnAmount(uint256)", "updateMaxWalletAmount(uint256)", "removeLimits()", "removeAllLimits()", "setLimits(uint256,uint256)", "setMaxBuy(uint256)", "setMaxSell(uint256)", "setMaxTransaction(uint256)", "setCooldownEnabled(bool)", "setTransferDelayEnabled(bool)", "setLimitsInEffect(bool)",
  ],
  trading: ["enableTrading()", "openTrading()", "startTrading()", "setTradingEnabled(bool)", "setTrading(bool)", "setTradingOpen(bool)", "enableTrading(bool)", "tradingStatus(bool)", "setTradingStatus(bool)", "toggleTrading()", "activateTrading()", "setTradingActive(bool)", "setLaunched(bool)"],
  upgrade: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)", "setImplementation(address)", "changeImplementation(address)"],
  "burn-others": ["burn(address,uint256)", "burnFrom(address,uint256)", "burnTokens(address,uint256)"],
  exempt: ["excludeFromFees(address,bool)", "excludeFromFee(address)", "excludeFromFee(address,bool)", "setExcludedFromFees(address,bool)", "excludeFromLimits(address,bool)", "setExcludedFromMaxTransaction(address,bool)", "excludeMultipleAccountsFromFees(address[],bool)", "setFeeExempt(address,bool)", "setIsExcludedFromFee(address,bool)", "excludeFromMaxTransaction(address,bool)", "setExcludeFromMaxWallet(address,bool)"],
  sweep: ["manualSwap()", "manualswap()", "manualSend()", "manualsend()", "clearStuckBalance()", "clearStuckBalance(uint256)", "withdrawStuckETH()", "withdrawStuckEth()", "withdrawStuckTokens(address)", "withdrawStuckTokens(address,uint256)", "rescueTokens(address)", "rescueTokens(address,uint256)", "rescueETH()", "rescueETH(uint256)", "claimStuckTokens(address)", "sweep(address)", "recoverERC20(address,uint256)"],
};

const V3_FACTORY_FUNCTIONS = {
  getPool: { name: "getPool", inputs: ["address", "address", "uint24"], outputs: ["address"] },
} as const satisfies Record<string, FunctionAbi>;
const V3_FEE_TIERS = [100n, 500n, 3_000n, 10_000n];

const OWNER_FUNCTIONS = {
  owner: { name: "owner", inputs: [], outputs: ["address"] },
  getOwner: { name: "getOwner", inputs: [], outputs: ["address"] },
  paused: { name: "paused", inputs: [], outputs: ["bool"] },
  transfer: { name: "transfer", inputs: ["address", "uint256"], outputs: ["bool"] },
} as const satisfies Record<string, FunctionAbi>;

/** Boolean views token generators use for "is trading open"; the first one the code carries is read. */
const TRADING_VIEWS = ["tradingOpen()", "tradingEnabled()", "tradingActive()", "isTradingEnabled()", "tradingIsEnabled()", "launched()", "tradingLive()", "tradingStarted()"];
const RENOUNCE_SIGNATURES = ["renounceOwnership()", "transferOwnership(address)"];

/** Recipient used in the transfer simulation: a fixed, otherwise unused address. */
export const PROBE_RECIPIENT = "0x000000000000000000000000000000000000b0ce";

export interface HolderShare {
  address: string;
  value: bigint;
  bps: number;
  isContract: boolean;
  name: string | null;
  role: "deployer" | "owner" | "token" | "burn" | null;
}

export interface TransferProbe {
  from: string;
  ok: boolean;
  /** The revert reason when it failed, if the node gave one. */
  reason: string | null;
}

export interface Pool {
  dex: string;
  address: string;
  feeBps: number;
  /** Reserves read as balances of the pool, in the token and in the wrapped native coin. */
  tokenReserve: bigint;
  quoteReserve: bigint;
}

export interface OpenDoor {
  /** How many distinct four-byte constants the dispatcher carries. */
  selectors: number;
  /** Which bytecode the surface was read from: the token's own, or its proxy implementation's. */
  surfaceFrom: "token" | "implementation";
  powers: Power[];
  /** Whether renounceOwnership / transferOwnership exist, i.e. the standard Ownable shape. */
  ownable: boolean;
  /** owner() as the chain returns it, when the function exists; renounced when it is the zero address. */
  owner: { address: string; renounced: boolean; isContract: boolean } | null;
  paused: boolean | null;
  /** The value of the first trading-switch view the code has, when any. */
  tradingOpen: { view: string; open: boolean } | null;
  /** Transfer simulations from the largest plain-wallet holders (eth_call, nothing is sent). */
  probes: TransferProbe[];
  verified: boolean | null;
  deployer: { address: string; creationTx: string | null; createdAtBlock: number | null; createdAt: number | null; balance: bigint; bps: number } | null;
  ownerBalance: { balance: bigint; bps: number } | null;
  /** Explorer flags and price feed, when the explorer has them. */
  explorer: { isScam: boolean; priceUsd: number | null; volume24hUsd: number | null; marketCapUsd: number | null } | null;
  /** Pools on the chain's known V3-style DEX factories, paired with the wrapped native coin; null when the chain lists none. */
  pools: Pool[] | null;
  holders: {
    count: number | null;
    transfers: number | null;
    top: HolderShare[];
    /** Shares of total supply held by the top 10 wallets excluding contracts and burn addresses, and by contracts. */
    top10WalletsBps: number;
    contractsBps: number;
    burnedBps: number;
  } | null;
  activity: { lastTransferAt: number | null; lastTransferBlock: number | null; recent: number; recentWallets: number } | null;
}

export interface OpenDoorOptions {
  blockscout?: BlockscoutClient | null;
  /** The chain's DEX table; pools are skipped when absent. */
  dex?: ChainConfig["dex"];
  /** How many plain-wallet holders to simulate a transfer from (default 3). */
  probeHolders?: number;
}

const BURN_ADDRESSES = new Set([ZERO_ADDRESS, "0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000001"]);

export async function readOpenDoor(rpc: RpcClient, token: ContractId, meta: TokenMeta | null, block: number, options: OpenDoorOptions = {}): Promise<OpenDoor> {
  const address = token.address.toLowerCase();
  // ---- the function surface, from the code that actually runs
  let surfaceFrom: OpenDoor["surfaceFrom"] = "token";
  let code = await rpc.getCode(address, block);
  const implementation = token.proxyImplementation ?? token.code.minimalProxyTarget;
  if (implementation) {
    try {
      const implCode = await rpc.getCode(implementation, block);
      if (implCode.length > 2) {
        code = implCode;
        surfaceFrom = "implementation";
      }
    } catch {
      // fall back to the proxy's own bytes
    }
  }
  const present = pushedSelectors(code);
  const has = (signature: string) => present.has(selector(signature));
  const powers: Power[] = [];
  for (const kind of Object.keys(POWER_SIGNATURES) as PowerKind[]) {
    for (const signature of POWER_SIGNATURES[kind]) if (has(signature)) powers.push({ kind, signature });
  }
  const ownable = RENOUNCE_SIGNATURES.some(has);

  // ---- who is in charge, and is the door open
  const owner = await readOwner(rpc, address, block, has);
  const paused = has("paused()") ? await readBool(rpc, address, OWNER_FUNCTIONS.paused, block) : null;
  let tradingOpen: OpenDoor["tradingOpen"] = null;
  for (const view of TRADING_VIEWS) {
    if (!has(view)) continue;
    const open = await readBool(rpc, address, { name: view.slice(0, -2), inputs: [], outputs: ["bool"] }, block);
    if (open !== null) tradingOpen = { view, open };
    break;
  }

  // ---- the explorer's part: holders, creator, recent transfers, source
  const supply = meta?.totalSupply ?? 0n;
  const bps = (v: bigint) => (supply > 0n ? Number((v * 10_000n) / supply) : 0);
  let holders: OpenDoor["holders"] = null;
  let deployer: OpenDoor["deployer"] = null;
  let activity: OpenDoor["activity"] = null;
  let verified: boolean | null = null;
  let explorer: OpenDoor["explorer"] = null;
  let topHolders: TokenHolder[] = [];
  const bs = options.blockscout;
  if (bs) {
    verified = await bs.isVerified(address);
    try {
      const info = await bs.addressInfo(address);
      explorer = { isScam: info.isScam, priceUsd: null, volume24hUsd: null, marketCapUsd: null };
      if (info.creator) {
        let createdAtBlock: number | null = null;
        let createdAt: number | null = null;
        if (info.creationTx) {
          try {
            const receipt = (await rpc.send("eth_getTransactionReceipt", [info.creationTx])) as { blockNumber: string } | null;
            if (receipt?.blockNumber) {
              createdAtBlock = Number(BigInt(receipt.blockNumber));
              createdAt = (await rpc.getBlock(createdAtBlock)).timestamp;
            }
          } catch {
            // the creation block is a nicety
          }
        }
        const balance = await readBalance(rpc, address, info.creator, block);
        deployer = { address: info.creator, creationTx: info.creationTx, createdAtBlock, createdAt, balance, bps: bps(balance) };
      }
    } catch {
      deployer = null;
    }
    try {
      const [list, info] = await Promise.all([bs.tokenHolders(address, 50), bs.tokenInfo(address).catch(() => ({ holders: null, transfers: null, type: null, priceUsd: null, volume24hUsd: null, marketCapUsd: null }))]);
      topHolders = list;
      explorer = { isScam: explorer?.isScam ?? false, priceUsd: info.priceUsd, volume24hUsd: info.volume24hUsd, marketCapUsd: info.marketCapUsd };
      const top: HolderShare[] = list.map((h) => ({
        address: h.address,
        value: h.value,
        bps: bps(h.value),
        isContract: h.isContract,
        name: h.name,
        role: h.address === deployer?.address ? "deployer" : owner && h.address === owner.address ? "owner" : h.address === address ? "token" : BURN_ADDRESSES.has(h.address) ? "burn" : null,
      }));
      const wallets = top.filter((h) => !h.isContract && h.role !== "burn" && h.role !== "token");
      holders = {
        count: info.holders,
        transfers: info.transfers,
        top,
        top10WalletsBps: wallets.slice(0, 10).reduce((a, h) => a + h.bps, 0),
        contractsBps: top.filter((h) => h.isContract || h.role === "token").reduce((a, h) => a + h.bps, 0),
        burnedBps: top.filter((h) => h.role === "burn").reduce((a, h) => a + h.bps, 0),
      };
    } catch {
      holders = null;
    }
    try {
      const transfers = await bs.tokenTransfers(address);
      activity = summariseActivity(transfers);
    } catch {
      activity = null;
    }
  }

  const ownerBalance = owner && !owner.renounced ? await readBalance(rpc, address, owner.address, block).then((balance) => ({ balance, bps: bps(balance) })).catch(() => null) : null;

  // ---- where it trades: pools on the chain's known DEX factories
  let pools: Pool[] | null = null;
  if (options.dex) {
    try {
      pools = await readPools(rpc, address, options.dex, block);
    } catch {
      pools = null;
    }
  }

  // ---- can a plain holder move tokens right now
  const probes: TransferProbe[] = [];
  const candidates = topHolders.filter((h) => !h.isContract && !BURN_ADDRESSES.has(h.address) && h.address !== address && h.value > 0n).map((h) => h.address);
  if (!candidates.length && deployer && deployer.balance > 0n) candidates.push(deployer.address);
  for (const from of candidates.slice(0, options.probeHolders ?? 3)) probes.push(await probeTransfer(rpc, address, from, block));

  return { selectors: present.size, surfaceFrom, powers, ownable, owner, paused, tradingOpen, probes, verified, deployer, ownerBalance, explorer, pools, holders, activity };
}

/**
 * Asks each listed V3-style factory for a token/WETH pool at every fee
 * tier, then reads the reserves as the pool's two balances. One batch for
 * the lookups, one for the balances. A pool with nothing in it is listed
 * with zero reserves so the caller can say "exists, empty".
 */
export async function readPools(rpc: RpcClient, token: string, dex: NonNullable<ChainConfig["dex"]>, block: number): Promise<Pool[]> {
  const asks: { dex: string; fee: bigint }[] = [];
  const calls: { to: string; data: Hex }[] = [];
  for (const f of dex.v3Factories) {
    for (const fee of V3_FEE_TIERS) {
      asks.push({ dex: f.name, fee });
      calls.push({ to: f.address, data: encodeCall(V3_FACTORY_FUNCTIONS.getPool, [token, dex.weth, fee]) });
    }
  }
  const raws = await rpc.callBatch(calls, block);
  const found: Pool[] = [];
  raws.forEach((raw, i) => {
    try {
      const [pool] = decodeOutputs(V3_FACTORY_FUNCTIONS.getPool, raw) as [string];
      if (pool && pool !== ZERO_ADDRESS) found.push({ dex: asks[i].dex, address: pool, feeBps: Number(asks[i].fee) / 100, tokenReserve: 0n, quoteReserve: 0n });
    } catch {
      // a factory that is not a V3 factory answers garbage; skip it
    }
  });
  if (!found.length) return found;
  const balances = await rpc.callBatch(found.flatMap((p) => [{ to: token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [p.address]) }, { to: dex.weth, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [p.address]) }]), block);
  found.forEach((p, i) => {
    p.tokenReserve = decodeOutputs(ERC20_FUNCTIONS.balanceOf, balances[i * 2])[0] as bigint;
    p.quoteReserve = decodeOutputs(ERC20_FUNCTIONS.balanceOf, balances[i * 2 + 1])[0] as bigint;
  });
  return found.sort((a, b) => (b.quoteReserve > a.quoteReserve ? 1 : b.quoteReserve < a.quoteReserve ? -1 : 0));
}

async function readOwner(rpc: RpcClient, token: string, block: number, has: (s: string) => boolean): Promise<OpenDoor["owner"]> {
  const fn = has("owner()") ? OWNER_FUNCTIONS.owner : has("getOwner()") ? OWNER_FUNCTIONS.getOwner : null;
  if (!fn) return null;
  try {
    const [raw] = await rpc.callBatch([{ to: token, data: encodeCall(fn, []) }], block);
    const [address] = decodeOutputs(fn, raw) as [string];
    const renounced = address === ZERO_ADDRESS || BURN_ADDRESSES.has(address);
    const isContract = renounced ? false : (await rpc.getCode(address, block)).length > 2;
    return { address, renounced, isContract };
  } catch {
    return null;
  }
}

async function readBool(rpc: RpcClient, token: string, fn: FunctionAbi, block: number): Promise<boolean | null> {
  try {
    const [raw] = await rpc.callBatch([{ to: token, data: encodeCall(fn, []) }], block);
    const [value] = decodeOutputs(fn, raw) as [boolean];
    return value;
  } catch {
    return null;
  }
}

async function readBalance(rpc: RpcClient, token: string, who: string, block: number): Promise<bigint> {
  const [raw] = await rpc.callBatch([{ to: token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [who]) }], block);
  const [balance] = decodeOutputs(ERC20_FUNCTIONS.balanceOf, raw) as [bigint];
  return balance;
}

/**
 * eth_call of transfer(PROBE_RECIPIENT, 1) with `from` set to a real holder.
 * The node runs the token's code against the current state and reports
 * whether it would revert; nothing is signed or sent. A revert from a
 * plain wallet that holds tokens is what a paused, closed or blacklisting
 * token looks like from the outside.
 */
export async function probeTransfer(rpc: RpcClient, token: string, from: string, block: number): Promise<TransferProbe> {
  const data = encodeCall(OWNER_FUNCTIONS.transfer, [PROBE_RECIPIENT, 1n]);
  try {
    const raw = (await rpc.send("eth_call", [{ from, to: token, data }, toTag(block)])) as Hex;
    const ok = raw === "0x" || raw.length < 66 || BigInt(raw.slice(0, 66)) !== 0n;
    return { from, ok, reason: ok ? null : "transfer returned false" };
  } catch (error) {
    return { from, ok: false, reason: revertReason(error) };
  }
}

function toTag(block: number): string {
  return `0x${block.toString(16)}`;
}

function revertReason(error: unknown): string | null {
  if (error instanceof RpcError) {
    const data = typeof error.data === "string" ? error.data : "";
    // Error(string) is 0x08c379a0 + abi-encoded string.
    if (data.startsWith("0x08c379a0") && data.length >= 10 + 128) {
      try {
        const [text] = decodeOutputs({ name: "Error", inputs: [], outputs: ["string"] }, `0x${data.slice(10)}`) as [string];
        if (text) return text;
      } catch {
        // fall through to the message
      }
    }
    return error.message || null;
  }
  return error instanceof Error ? error.message : null;
}

function summariseActivity(transfers: TokenTransfer[]): OpenDoor["activity"] {
  if (!transfers.length) return { lastTransferAt: null, lastTransferBlock: null, recent: 0, recentWallets: 0 };
  const newest = transfers.reduce((a, b) => (b.block > a.block ? b : a), transfers[0]);
  const wallets = new Set<string>();
  for (const t of transfers) {
    wallets.add(t.from);
    wallets.add(t.to);
  }
  return { lastTransferAt: newest.timestamp, lastTransferBlock: newest.block || null, recent: transfers.length, recentWallets: wallets.size };
}

/** The distinct kinds of power the code carries, in the order they matter. */
export function powerKinds(o: OpenDoor): PowerKind[] {
  const order: PowerKind[] = ["upgrade", "mint", "pause", "blacklist", "trading", "fees", "limits", "burn-others", "exempt", "sweep"];
  const have = new Set(o.powers.map((p) => p.kind));
  return order.filter((k) => have.has(k));
}

/** One line for the receipt and the summary: who can still change the rules. */
export function controlLine(o: OpenDoor): string {
  const kinds = powerKinds(o);
  const named = kinds.filter((k) => k !== "exempt" && k !== "sweep");
  const what = named.length ? named.join(", ") : "no mint, pause, blacklist, fee or trading switch seen";
  if (o.owner === null) return `${what} · no owner() function`;
  if (o.owner.renounced) return `${what} · ownership renounced`;
  return `${what} · owner ${o.owner.address}${o.owner.isContract ? " (a contract)" : ""}`;
}
