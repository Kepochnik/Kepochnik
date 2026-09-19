/**
 * OPEN DOOR: the check for a token the launchpad did not make. A Pons launch
 * comes with rules the factory enforces; an ordinary ERC-20 comes with
 * whatever its author wrote. So the questions change: who can still change
 * the rules (owner, mint, pause, blacklist, fees, upgrade), can a plain
 * holder move their tokens right now, can they move them INTO THE POOL,
 * which is the only transfer that is a sale, who holds the supply, where it
 * trades, who deployed it and when it last moved.
 *
 * Two rules run through the whole file. First, a fact the chain refused to
 * give is never printed as a fact: every read that can fail has a third
 * state, and a rate-limited probe is never reported as a reverting token.
 * Second, a share of supply is only a number when the supply is known;
 * otherwise it is null and the slip says so rather than printing 0.0%.
 */
import { decodeOutputs, encodeCall, selector, type FunctionAbi, type Hex } from "../chain/abi.js";
import type { BlockscoutClient, TokenHolder, TokenTransfer } from "../chain/blockscout.js";
import type { ChainConfig } from "../chain/chains.js";
import { canPrice, depth, readMarket, readPools, type Market, type MarketPool } from "../chain/market.js";
import { nameHolders, readPoolLock, type PoolLock } from "../chain/liquidity.js";
import { readSelectors } from "../chain/code.js";
import { ERC20_EVENTS, ERC20_FUNCTIONS, ZERO_ADDRESS } from "../chain/pons.js";
import { eventTopic } from "../chain/abi.js";
import type { TokenMeta } from "../chain/reader.js";
import { RpcError, type RpcClient } from "../chain/rpc.js";
import type { ContractId } from "./idCheck.js";

export type PowerKind = "mint" | "pause" | "blacklist" | "fees" | "limits" | "trading" | "upgrade" | "burn-others" | "exempt" | "sweep";

export interface Power {
  kind: PowerKind;
  /** The function signature whose selector sits in the dispatcher. */
  signature: string;
}

/** What each power lets whoever may call it do, in plain words. */
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
 * burnFrom(address,uint256) is deliberately absent: it is the standard
 * ERC20Burnable function that spends an allowance the holder granted, so
 * calling it a power to destroy other people's tokens would be false.
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
  "burn-others": ["burn(address,uint256)", "burnTokens(address,uint256)"],
  exempt: ["excludeFromFees(address,bool)", "excludeFromFee(address)", "excludeFromFee(address,bool)", "setExcludedFromFees(address,bool)", "excludeFromLimits(address,bool)", "setExcludedFromMaxTransaction(address,bool)", "excludeMultipleAccountsFromFees(address[],bool)", "setFeeExempt(address,bool)", "setIsExcludedFromFee(address,bool)", "excludeFromMaxTransaction(address,bool)", "setExcludeFromMaxWallet(address,bool)"],
  sweep: ["manualSwap()", "manualswap()", "manualSend()", "manualsend()", "clearStuckBalance()", "clearStuckBalance(uint256)", "withdrawStuckETH()", "withdrawStuckEth()", "withdrawStuckTokens(address)", "withdrawStuckTokens(address,uint256)", "rescueTokens(address)", "rescueTokens(address,uint256)", "rescueETH()", "rescueETH(uint256)", "claimStuckTokens(address)", "sweep(address)", "recoverERC20(address,uint256)"],
};

const OWNER_FUNCTIONS = {
  owner: { name: "owner", inputs: [], outputs: ["address"] },
  getOwner: { name: "getOwner", inputs: [], outputs: ["address"] },
  paused: { name: "paused", inputs: [], outputs: ["bool"] },
  transfer: { name: "transfer", inputs: ["address", "uint256"], outputs: ["bool"] },
} as const satisfies Record<string, FunctionAbi>;

/** Boolean views token generators use for "is trading open"; the first one the code carries is read. */
const TRADING_VIEWS = ["tradingOpen()", "tradingEnabled()", "tradingActive()", "isTradingEnabled()", "tradingIsEnabled()", "launched()", "tradingLive()", "tradingStarted()"];
const RENOUNCE_SIGNATURES = ["renounceOwnership()", "transferOwnership(address)"];
const TRANSFER_SIGNATURE = "transfer(address,uint256)";

/** Recipient used in the fresh-wallet simulation: a fixed, otherwise unused address. */
export const PROBE_RECIPIENT = "0x000000000000000000000000000000000000b0ce";

export interface HolderShare {
  address: string;
  value: bigint;
  /** Share of total supply in basis points, or null when the supply could not be read. */
  bps: number | null;
  isContract: boolean;
  /** True when the address has code only because its owner signed an EIP-7702 delegation: a wallet, not a contract. */
  delegated: boolean;
  /** The explorer's label for the holder (a verified contract's name, a tag), when it has one. */
  name: string | null;
  role: "deployer" | "owner" | "token" | "burn" | null;
}

/**
 * One simulated transfer. `status` has three values on purpose: a call the
 * node refused to run is "unread", never "reverts". `target` says what was
 * proven: moving tokens to a fresh wallet is not the same as selling.
 */
export interface TransferProbe {
  from: string;
  to: string;
  target: "fresh-wallet" | "pool";
  status: "ok" | "reverts" | "unread";
  /** The revert reason when the EVM reverted, or the transport error when the call could not be run. */
  reason: string | null;
  /** Where the sending wallet came from, so the notes can say so. */
  source: "holder" | "deployer";
}

export interface OpenDoor {
  /** Full four-byte constants the code pushes: the size of its dispatcher, and the closest readable thing to a function count. */
  selectors: number;
  /** Every PUSH1–PUSH4 constant, which is what signatures are matched against. Padded jump destinations live here too. */
  constants: number;
  /** Which bytecode the surface was read from. "implementation-unreadable" means the code that actually runs could not be fetched. */
  surfaceFrom: "token" | "implementation" | "implementation-unreadable";
  powers: Power[];
  /** Whether renounceOwnership / transferOwnership exist, i.e. the standard Ownable shape. */
  ownable: boolean;
  /** owner() as the chain returns it; null when the code has no such view OR the read failed, which `ownerUnread` tells apart. */
  owner: { address: string; renounced: boolean; isContract: boolean } | null;
  /** True when the code has an owner view but the chain would not answer it. */
  ownerUnread: boolean;
  paused: boolean | null;
  /** The value of the first trading-switch view the code has, when any. */
  tradingOpen: { view: string; open: boolean } | null;
  /** Transfer simulations (eth_call, nothing is sent). Empty when the token has no transfer function. */
  probes: TransferProbe[];
  /** Why no transfer was simulated, when none was. */
  probesSkipped: string | null;
  verified: boolean | null;
  deployer: { address: string; creationTx: string | null; createdAtBlock: number | null; createdAt: number | null; balance: bigint; bps: number | null } | null;
  ownerBalance: { balance: bigint; bps: number | null } | null;
  /** Explorer flags and price feed. isScam is null when the flag could not be read, never a cheerful false. */
  explorer: { isScam: boolean | null; priceUsd: number | null; volume24hUsd: number | null; marketCapUsd: number | null; tokenType: string | null } | null;
  /** Why the explorer could not be read, when it could not. */
  explorerError: string | null;
  /** Pools on the chain's known DEX factories, paired with the wrapped native coin; null when the chain lists none. */
  pools: MarketPool[] | null;
  /** What a sale of the reference position would pay, priced on the deepest pool that can be priced. */
  market: Market | null;
  /**
   * Who is holding the liquidity of the deepest pool, and whether they can walk
   * off with it. Null when there is no pool, or when the caller did not ask.
   */
  liquidity: PoolLock | null;
  holders: {
    count: number | null;
    transfers: number | null;
    top: HolderShare[];
    /** How many rows the explorer returned, so the caller can say the shares are computed over one page. */
    rows: number;
    /** Shares in basis points, or null when the supply is unknown or no row of that kind was returned. */
    top10WalletsBps: number | null;
    contractsBps: number | null;
    burnedBps: number | null;
  } | null;
  activity: { lastTransferAt: number | null; lastTransferBlock: number | null; recent: number; recentWallets: number } | null;
}

export interface OpenDoorOptions {
  blockscout?: BlockscoutClient | null;
  /** The chain's DEX table; pools are skipped when absent. */
  dex?: ChainConfig["dex"];
  /** How many holders to simulate a transfer from (default 3). */
  probeHolders?: number;
  /** Token amount the sale is priced for; default 1% of supply, matching the launchpad exit door. */
  position?: bigint;
  /** How far back to look for holders in Transfer logs when there is no explorer; default about an hour. */
  recentBlocks?: number;
  /** Contracts that hold liquidity with a timer; see LockerTable. */
  lockers?: ChainConfig["lockers"];
  /**
   * Whether to read who holds the liquidity. It costs a log scan and a few
   * calls, so the caller decides; default on when a DEX table exists.
   */
  liquidity?: boolean;
  /** How far back to look for the mints that opened the V3 positions. */
  liquidityFromBlock?: number;
  /** A resolved Uniswap V4 singleton; V4 pools are skipped when absent. */
  v4PoolManager?: string;
}

const BURN_ADDRESSES = new Set([ZERO_ADDRESS, "0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000001"]);

export async function readOpenDoor(rpc: RpcClient, token: ContractId, meta: TokenMeta | null, block: number, options: OpenDoorOptions = {}): Promise<OpenDoor> {
  const address = token.address.toLowerCase();

  // ---- the function surface, from the code that actually runs
  let surfaceFrom: OpenDoor["surfaceFrom"] = "token";
  let code = await rpc.getCode(address, block);
  const implementation = token.proxyImplementation ?? token.proxyBeacon ?? token.code.minimalProxyTarget;
  if (implementation) {
    surfaceFrom = "implementation-unreadable";
    try {
      const implCode = await rpc.getCode(implementation, block);
      if (implCode.length > 2) {
        code = implCode;
        surfaceFrom = "implementation";
      }
    } catch {
      // stays unreadable: the caller must not read an empty surface as "no powers"
    }
  }
  const { all: present, push4 } = readSelectors(code);
  const has = (signature: string) => present.has(selector(signature));
  const powers: Power[] = [];
  for (const kind of Object.keys(POWER_SIGNATURES) as PowerKind[]) {
    for (const signature of POWER_SIGNATURES[kind]) if (has(signature)) powers.push({ kind, signature });
  }
  const ownable = RENOUNCE_SIGNATURES.some(has);

  // ---- who is in charge, and is the door open. The owner views are one call
  // each and cost nothing to try, so they are asked whether or not the
  // bytecode heuristic saw them: a dispatcher shape it does not recognise
  // must not turn into "this token has no owner".
  const ownerRead = await readOwner(rpc, address, block);
  const owner = ownerRead.owner;
  const paused = await readBool(rpc, address, OWNER_FUNCTIONS.paused, block);
  let tradingOpen: OpenDoor["tradingOpen"] = null;
  for (const view of TRADING_VIEWS) {
    if (!has(view)) continue;
    const open = await readBool(rpc, address, { name: view.slice(0, -2), inputs: [], outputs: ["bool"] }, block);
    if (open !== null) tradingOpen = { view, open };
    break;
  }

  // ---- shares of supply are only numbers when the supply is a number
  const supply = meta?.totalSupply ?? null;
  const bps = (v: bigint): number | null => (supply !== null && supply > 0n ? Number((v * 10_000n) / supply) : null);

  // ---- the explorer's holder list, started here rather than below, because
  // the market read needs it: a DEX the chain's table does not list is found
  // by asking the token's largest contract holders whether they are pools.
  // Started, not awaited — the calls above it have nothing to do with it.
  const holderList = options.blockscout ? options.blockscout.tokenHolders(address, 50).catch(() => null) : Promise.resolve(null);

  // ---- where it trades, read before the probes so a sale can be simulated into the pool
  let pools: MarketPool[] | null = null;
  let market: Market | null = null;
  let liquidity: PoolLock | null = null;
  if (options.dex) {
    try {
      pools = await readPools(rpc, address, options.dex, block, meta?.decimals ?? 18, {
        v4PoolManager: options.v4PoolManager,
        v4FromBlock: options.liquidityFromBlock,
        // The promise, not its value. Awaiting it here would put an explorer
        // round trip in front of every factory read that could have been
        // running meanwhile; readPools needs it only at the end.
        //
        // Contracts only, and only the twenty largest: a wallet is not a pool,
        // the list is largest-first, and a pool is a large holder by
        // definition, so the tail is two calls each for a certain revert.
        candidates: holderList.then((listed) => (listed ?? []).filter((h) => h.isContract && !h.delegated).slice(0, 20).map((h) => ({ address: h.address, name: h.name }))),
      });
      const position = options.position ?? (supply !== null && supply > 0n ? supply / 100n : 0n);
      if (position > 0n) market = readMarket(pools, position, meta?.decimals ?? 18, options.dex.wethSymbol);
    } catch {
      pools = null;
    }
    // Who holds the deepest pool's liquidity. Only the deepest: it is the one a
    // sale would go through, and reading every pool would multiply the cost for
    // an answer nobody asked. A failure here costs this section, not the slip.
    //
    // The exception is a pool whose ownership cannot be read at all — a V4 row
    // inside the singleton, or a venue found by holder discovery that answers
    // no known shape. Those are now allowed to be the deepest, and stopping at
    // one would empty a section that the pool behind it can still answer. So:
    // the deepest readable pool, and the note says how much of the liquidity
    // it actually covers.
    const readable = (pools ?? []).filter((p) => p.kind === "v2" || p.kind === "v3" || p.kind === "solidly");
    const deepest = readable[0] ?? pools?.[0] ?? null;
    if (deepest && options.liquidity !== false) {
      try {
        liquidity = await readPoolLock(rpc, deepest, options.lockers, options.dex.v3PositionManager, block, {
          fromBlock: Math.max(0, options.liquidityFromBlock ?? block - 500_000),
        });
        // A contract holding the liquidity is worth naming when the chain's
        // explorer publishes a verified name for it. That is where a locker
        // gets identified without a table of addresses recalled rather than
        // checked — and it stays a name, not a verdict.
        const bs = options.blockscout;
        if (bs) {
          // The holder list is already in hand and already carries the
          // explorer's names, so most lookups here are free. Only an address
          // the list does not mention — an NFT owner on a V3 pool, say —
          // costs a request, and those are capped and raced against a
          // deadline: a name is a nicety, and a throttled explorer must not
          // be able to hold up the section it is decorating.
          const byAddress = new Map((await holderList.catch(() => null) ?? []).filter((h) => h.name).map((h) => [h.address.toLowerCase(), h.name as string]));
          // Ten, not four. Capping by position was wrong and a live run caught
          // it: the holders are sorted by share, and on $PONS the only two
          // contracts the explorer had names for were the fifth and sixth,
          // holding 0.01% and 0%. A cap of four dropped exactly the names that
          // existed. The deadline below is the real bound on cost; the cap is
          // only there to stop a pathological list.
          const named = nameHolders(liquidity, async (address) => {
            const known = byAddress.get(address.toLowerCase());
            if (known) return known;
            return (await bs.addressInfo(address)).name;
          }, 10);
          liquidity = await Promise.race([named, new Promise<PoolLock>((resolve) => setTimeout(() => resolve(liquidity as PoolLock), 4_000))]);
        }
        // How much of the market this pool actually is. Depth, not count: a
        // reader needs to know whether "all of it can be withdrawn" is about
        // the pool they would sell into or about a rounding error beside it.
        const total = (pools ?? []).reduce((a, p) => a + (depth(p) > 0n ? depth(p) : 0n), 0n);
        const mine = depth(deepest) > 0n ? depth(deepest) : 0n;
        liquidity.shareOfLiquidityBps = total > 0n ? Number((mine * 10_000n) / total) : 10_000;
      } catch {
        liquidity = null;
      }
    }
  }

  // ---- the explorer's part: holders, creator, recent transfers, source
  let holders: OpenDoor["holders"] = null;
  let deployer: OpenDoor["deployer"] = null;
  let activity: OpenDoor["activity"] = null;
  let verified: boolean | null = null;
  let explorer: OpenDoor["explorer"] = null;
  let explorerError: string | null = null;
  let topHolders: TokenHolder[] = [];
  const note = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    explorerError = explorerError ? `${explorerError}; ${text}` : text;
  };
  const bs = options.blockscout;
  if (bs) {
    let info: { isScam: boolean; isVerified: boolean; creator: string | null; creationTx: string | null } | null = null;
    try {
      const read = await bs.addressInfo(address);
      info = read;
      verified = read.isVerified;
      if (read.creator) {
        let createdAtBlock: number | null = null;
        let createdAt: number | null = null;
        if (read.creationTx) {
          try {
            const receipt = (await rpc.send("eth_getTransactionReceipt", [read.creationTx])) as { blockNumber: string } | null;
            if (receipt?.blockNumber) {
              createdAtBlock = Number(BigInt(receipt.blockNumber));
              createdAt = (await rpc.getBlock(createdAtBlock)).timestamp;
            }
          } catch {
            // the creation block is a nicety
          }
        }
        const balance = await readBalance(rpc, address, read.creator, block).catch(() => null);
        deployer = { address: read.creator, creationTx: read.creationTx, createdAtBlock, createdAt, balance: balance ?? 0n, bps: balance === null ? null : bps(balance) };
      }
    } catch (error) {
      note(error);
    }
    try {
      const [listed, tokenInfo] = await Promise.all([
        holderList,
        bs.tokenInfo(address).catch(() => ({ holders: null, transfers: null, type: null, priceUsd: null, volume24hUsd: null, marketCapUsd: null })),
      ]);
      // The same read the market section used, not a second one. It was
      // started before that section and is long since resolved.
      if (!listed) throw new Error("the explorer did not return the token's holders");
      const list = listed;
      topHolders = list;
      explorer = {
        isScam: info ? info.isScam : null,
        priceUsd: tokenInfo.priceUsd,
        volume24hUsd: tokenInfo.volume24hUsd,
        marketCapUsd: tokenInfo.marketCapUsd,
        tokenType: tokenInfo.type,
      };
      const top: HolderShare[] = list.map((h) => ({
        address: h.address,
        value: h.value,
        bps: bps(h.value),
        isContract: h.isContract && !h.delegated,
        delegated: h.delegated,
        name: h.name,
        role: h.address === deployer?.address ? "deployer" : owner && h.address === owner.address ? "owner" : h.address === address ? "token" : BURN_ADDRESSES.has(h.address) ? "burn" : null,
      }));
      const wallets = top.filter((h) => !h.isContract && h.role !== "burn" && h.role !== "token");
      const share = (rows: HolderShare[]) => {
        if (supply === null || supply <= 0n || !rows.length) return null;
        return rows.reduce((a, h) => a + (h.bps ?? 0), 0);
      };
      holders = {
        count: tokenInfo.holders,
        transfers: tokenInfo.transfers,
        top,
        rows: top.length,
        top10WalletsBps: share(wallets.slice(0, 10)),
        contractsBps: share(top.filter((h) => h.isContract || h.role === "token")),
        burnedBps: share(top.filter((h) => h.role === "burn")),
      };
    } catch (error) {
      note(error);
      holders = null;
    }
    if (explorer === null && info) explorer = { isScam: info.isScam, priceUsd: null, volume24hUsd: null, marketCapUsd: null, tokenType: null };
    try {
      activity = summariseActivity(await bs.tokenTransfers(address));
    } catch (error) {
      note(error);
      activity = null;
    }
  }

  const ownerBalance =
    owner && !owner.renounced
      ? await readBalance(rpc, address, owner.address, block)
          .then((balance) => ({ balance, bps: bps(balance) }))
          .catch(() => null)
      : null;

  // ---- can a holder move it, and can they move it into the pool
  const probes: TransferProbe[] = [];
  let probesSkipped: string | null = null;
  if (!has(TRANSFER_SIGNATURE)) {
    probesSkipped =
      surfaceFrom === "implementation-unreadable"
        ? "the code that actually runs could not be read, so no transfer was simulated"
        : "this contract has no transfer(address,uint256) function, so it is not an ERC-20 and no transfer was simulated";
  } else {
    const candidates = await probeCandidates(rpc, address, block, topHolders, deployer?.address ?? null, owner?.address ?? null, options.probeHolders ?? 3, options.recentBlocks);
    if (!candidates.length) {
      probesSkipped = "no wallet with a readable balance to simulate from";
    } else {
      // Aim the sale at the deepest pool that actually holds the quote asset.
      const deepest = (pools ?? []).filter((p) => (p.quoteReserve ?? 0n) > 0n || canPrice(p))[0] ?? null;
      for (const c of candidates) {
        probes.push(await probeTransfer(rpc, address, c.address, PROBE_RECIPIENT, "fresh-wallet", c.source, block));
        if (deepest) probes.push(await probeTransfer(rpc, address, c.address, deepest.address, "pool", c.source, block));
      }
    }
  }

  return {
    selectors: push4.size,
    constants: present.size,
    surfaceFrom,
    powers,
    ownable,
    owner,
    ownerUnread: ownerRead.unread,
    paused,
    tradingOpen,
    probes,
    probesSkipped,
    verified,
    deployer,
    ownerBalance,
    explorer,
    explorerError,
    pools,
    market,
    liquidity,
    holders,
    activity,
  };
}

/**
 * Picks the wallets to simulate from, and re-reads their balances on chain:
 * the explorer's numbers are an index, and an index can be stale. The owner
 * and the deployer are excluded, because they are exactly the addresses a
 * honeypot exempts, so proving THEY can transfer proves nothing about anyone
 * else. Only when no other wallet is available does the deployer stand in,
 * and the probe records that it did.
 */
async function probeCandidates(
  rpc: RpcClient,
  token: string,
  block: number,
  holders: TokenHolder[],
  deployer: string | null,
  owner: string | null,
  want: number,
  recentBlocks?: number,
): Promise<{ address: string; source: TransferProbe["source"] }[]> {
  const excluded = new Set([token, deployer, owner].filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase()));
  let shortlist = holders
    .filter((h) => (!h.isContract || h.delegated) && !BURN_ADDRESSES.has(h.address) && !excluded.has(h.address) && h.value > 0n)
    .slice(0, Math.max(want * 3, 9))
    .map((h) => h.address);
  // No explorer, or one that would not answer: the chain still knows who was
  // sent this token recently. Without this the sale simulation, which is the
  // whole point of the check, would simply not run on a chain like BNB.
  if (!shortlist.length) shortlist = await recentRecipients(rpc, token, block, excluded, Math.max(want * 4, 12), recentBlocks);
  const out: { address: string; source: TransferProbe["source"] }[] = [];
  if (shortlist.length) {
    try {
      const balances = await rpc.callBatch(
        shortlist.map((who) => ({ to: token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [who]) })),
        block,
      );
      shortlist.forEach((who, i) => {
        try {
          const [balance] = decodeOutputs(ERC20_FUNCTIONS.balanceOf, balances[i]) as [bigint];
          if (balance > 0n) out.push({ address: who, source: "holder" });
        } catch {
          // a balance that will not decode is not a candidate
        }
      });
    } catch {
      // the batch failed; fall through to the explorer's own ordering
      for (const who of shortlist) out.push({ address: who, source: "holder" });
    }
  }
  if (!out.length && deployer) {
    const balance = await readBalance(rpc, token, deployer, block).catch(() => 0n);
    if (balance > 0n) out.push({ address: deployer, source: "deployer" });
  }
  return out.slice(0, want);
}

/**
 * Wallets the token was sent to recently, read from its own Transfer logs.
 * Contracts are dropped: a pool receiving tokens is not a holder whose ability
 * to sell says anything. Everything here is one getLogs and two batches.
 */
async function recentRecipients(rpc: RpcClient, token: string, block: number, excluded: Set<string>, want: number, recentBlocks = 1_800): Promise<string[]> {
  let logs: { topics: string[] }[];
  try {
    logs = await rpc.getLogs({ address: token, topics: [eventTopic(ERC20_EVENTS.Transfer)], fromBlock: Math.max(0, block - recentBlocks), toBlock: block });
  } catch {
    return [];
  }
  const seen: string[] = [];
  for (let i = logs.length - 1; i >= 0 && seen.length < want * 3; i--) {
    const topic = logs[i].topics[2];
    if (!topic) continue;
    const who = `0x${topic.slice(-40)}`.toLowerCase();
    if (BURN_ADDRESSES.has(who) || excluded.has(who) || seen.includes(who)) continue;
    seen.push(who);
  }
  if (!seen.length) return [];
  const codes = await rpc.callBatchSettled(
    seen.map((who) => ({ to: token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [who]) })),
    block,
  );
  const withBalance: string[] = [];
  codes.forEach((raw, i) => {
    if (raw instanceof Error) return;
    try {
      if ((decodeOutputs(ERC20_FUNCTIONS.balanceOf, raw)[0] as bigint) > 0n) withBalance.push(seen[i]);
    } catch {
      // not a readable balance, not a candidate
    }
  });
  const out: string[] = [];
  for (const who of withBalance) {
    if (out.length >= want) break;
    try {
      if ((await rpc.getCode(who, block)).length <= 2) out.push(who);
    } catch {
      // an unread code size is not a reason to probe from an address
    }
  }
  return out;
}

async function readOwner(rpc: RpcClient, token: string, block: number): Promise<{ owner: OpenDoor["owner"]; unread: boolean }> {
  for (const fn of [OWNER_FUNCTIONS.owner, OWNER_FUNCTIONS.getOwner]) {
    let address: string;
    try {
      const [raw] = await rpc.callBatch([{ to: token, data: encodeCall(fn, []) }], block);
      [address] = decodeOutputs(fn, raw) as [string];
    } catch (error) {
      // A revert means this token has no such view; anything else means the
      // chain would not answer, which is not the same thing at all.
      if (error instanceof RpcError && error.isRevert) continue;
      return { owner: null, unread: true };
    }
    const renounced = address === ZERO_ADDRESS || BURN_ADDRESSES.has(address);
    let isContract = false;
    if (!renounced) {
      try {
        isContract = (await rpc.getCode(address, block)).length > 2;
      } catch {
        // an unread code size does not make the owner disappear
      }
    }
    return { owner: { address, renounced, isContract }, unread: false };
  }
  return { owner: null, unread: false };
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
 * eth_call of transfer(to, 1) with `from` set to a real holder. The node runs
 * the token's code against the current state and reports whether it would
 * revert; nothing is signed or sent. Aimed at a fresh wallet it answers "can
 * tokens move at all"; aimed at the pool it answers the question people
 * actually have, because a sale is a transfer into the pool and the common
 * honeypot is a contract that allows the first and refuses the second.
 */
export async function probeTransfer(
  rpc: RpcClient,
  token: string,
  from: string,
  to: string,
  target: TransferProbe["target"],
  source: TransferProbe["source"],
  block: number,
): Promise<TransferProbe> {
  const data = encodeCall(OWNER_FUNCTIONS.transfer, [to, 1n]);
  try {
    const raw = (await rpc.send("eth_call", [{ from, to: token, data }, toTag(block)])) as Hex;
    // A standard ERC-20 returns a bool. Returning nothing is the old
    // non-standard shape (USDT and friends) and counts as success; anything
    // shorter than a word that is not empty is not an answer we can read.
    if (raw === "0x") return { from, to, target, status: "ok", reason: null, source };
    if (raw.length < 66) return { from, to, target, status: "unread", reason: "the call returned data too short to read", source };
    return BigInt(raw.slice(0, 66)) !== 0n
      ? { from, to, target, status: "ok", reason: null, source }
      : { from, to, target, status: "reverts", reason: "transfer returned false", source };
  } catch (error) {
    if (error instanceof RpcError && error.isRevert) return { from, to, target, status: "reverts", reason: revertReason(error), source };
    return { from, to, target, status: "unread", reason: error instanceof Error ? error.message : String(error), source };
  }
}

function toTag(block: number): string {
  return `0x${block.toString(16)}`;
}

/** The reason a revert carried, decoded when it is one of the two standard shapes. */
function revertReason(error: RpcError): string | null {
  const data = typeof error.data === "string" ? error.data : "";
  if (data.startsWith("0x08c379a0") && data.length >= 10 + 128) {
    try {
      const [text] = decodeOutputs({ name: "Error", inputs: [], outputs: ["string"] }, `0x${data.slice(10)}`) as [string];
      if (text) return text;
    } catch {
      // fall through to the message
    }
  }
  if (data.startsWith("0x4e487b71") && data.length >= 10 + 64) {
    return `panic 0x${BigInt(`0x${data.slice(10, 74)}`).toString(16)}`;
  }
  if (data.length > 10) return `custom error ${data.slice(0, 10)}`;
  const message = error.message.replace(/^execution reverted:?\s*/i, "").trim();
  return message || null;
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

/** The probes that aimed at the pool, i.e. the ones that simulated a sale. */
export function sellProbes(o: OpenDoor): TransferProbe[] {
  return o.probes.filter((p) => p.target === "pool");
}

/** The probes that aimed at a fresh wallet, i.e. the ones that only proved tokens can move. */
export function moveProbes(o: OpenDoor): TransferProbe[] {
  return o.probes.filter((p) => p.target === "fresh-wallet");
}

/** One line for the receipt and the summary: what the code can still do, and who holds the keys. */
export function controlLine(o: OpenDoor): string {
  const kinds = powerKinds(o).filter((k) => k !== "exempt" && k !== "sweep");
  const what = kinds.length ? kinds.join(", ") : "no mint, pause, blacklist, fee or trading switch seen";
  if (o.surfaceFrom === "implementation-unreadable") return "the code that actually runs could not be read";
  if (o.ownerUnread) return `${what} · owner() did not answer`;
  if (o.owner === null) return `${what} · no owner() function`;
  if (o.owner.renounced) return `${what} · ownership renounced`;
  return `${what} · owner ${o.owner.address}${o.owner.isContract ? " (a contract)" : ""}`;
}
