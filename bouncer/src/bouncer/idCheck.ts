/**
 * ID CHECK: is this address a token the Pons V2 factory itself deployed, and
 * what does its bytecode contain? The factory keeps a record for every
 * launch it made and deploys the token contract itself, so "registered in
 * the factory" is the whole genuineness test: no name matching, no list of
 * trusted deployers. The bytecode scan is the second question, asked of
 * every address, Pons or not: can this contract change or disappear?
 */
import { decodeOutputs, encodeCall, isAddress, normalizeAddress, selector, type FunctionAbi, type Hex } from "../chain/abi.js";
import { EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT, pushedSelectors, scanBytecode, storageWordAddress, storageWordIsSet, type CodeScan } from "../chain/code.js";
import { CURVE_FUNCTIONS, ERC20_FUNCTIONS, FACTORY_FUNCTIONS, PONS_V2_FACTORY, V1_FACTORY_FUNCTIONS, ZERO_ADDRESS, decodeLaunchedToken, decodeV1LaunchedToken, type LaunchedToken } from "../chain/pons.js";
import { NotAPonsLaunch, PonsReader, type TokenMeta } from "../chain/reader.js";
import { RpcError, type RpcClient } from "../chain/rpc.js";
import { ReadBatch } from "../chain/batch.js";
import { readV1Launch, type V1Launch } from "./v1.js";

export interface ContractId {
  address: string;
  code: CodeScan;
  /**
   * The runtime bytecode exactly as the node returned it. Carried so the
   * open-door check can read the function surface off it instead of asking
   * for the same code a second time; "0x" for an address with no code.
   */
  runtime: Hex;
  /** EIP-1967 implementation slot, when set: an upgradeable proxy. */
  proxyImplementation: string | null;
  proxyBeacon: string | null;
}

export interface IdCheck {
  /** The address that was asked about, lower-cased. */
  input: string;
  /** How the input was resolved: given a token, given its curve, or neither. */
  resolvedAs: "token" | "curve" | "unknown";
  registered: boolean;
  /** Which launchpad generation the factory record came from. */
  launchpad: "v2" | "v1" | null;
  launch: LaunchedToken | null;
  v1: V1Launch | null;
  token: ContractId;
  meta: TokenMeta | null;
  curve: ContractId | null;
  /**
   * The factory the token itself names in launchFactory(), when its code has
   * that view. Proof only when the factory is one the chain table lists and
   * that factory's record confirms it; otherwise just a claim, kept so the
   * door can say so.
   */
  claimedFactory: string | null;
}

export interface IdCheckOptions {
  factoryV1?: string;
  olderFactoriesV1?: string[];
  native?: { symbol: string; decimals: number };
  /** Set on a chain whose launchpad factory address is not published: the launch lookup is not asked at all. */
  skipLaunchLookup?: boolean;
}

const LAUNCH_FACTORY_VIEW: FunctionAbi = { name: "launchFactory", inputs: [], outputs: ["address"] };

export async function readIdCheck(rpc: RpcClient, input: string, block: number, factory?: string, options: IdCheckOptions = {}): Promise<IdCheck> {
  if (!isAddress(input)) throw new Error(`${input} is not an address`);
  const address = normalizeAddress(input);
  const reader = new PonsReader(rpc, factory);
  // The reader falls back to the published V2 factory when the caller names
  // none, and the batch below has to ask the same one the reader would.
  const v2Factory = factory || PONS_V2_FACTORY;

  // ---- every question that can be asked about the pasted address, at once
  //
  // These used to be seven round trips in a row: is it a V2 launch, is it a
  // curve, is it a V1 launch, then its code, then its two proxy slots, then
  // its name/symbol/decimals/supply. Not one of them needs another's answer,
  // and a round trip on a public endpoint is a quarter of a second, so the
  // door spent about a second and a half asking questions it could have
  // asked in one breath.
  //
  // Two of them are speculative. The V1 factory is asked even when the V2
  // record might turn up, and the code and metadata are read for the pasted
  // address even though a pasted CURVE would send them to the wrong one —
  // that case is re-read below. A wasted slot in a batch already going out
  // costs nothing; a round trip costs everyone who pastes an address.
  const opening = new ReadBatch(rpc, block);
  const v2Slot = options.skipLaunchLookup ? null : opening.call(v2Factory, encodeCall(FACTORY_FUNCTIONS.getLaunchedToken, [address]));
  const curveSlot = options.skipLaunchLookup ? null : opening.call(address, encodeCall(CURVE_FUNCTIONS.token, []));
  const v1Slot = options.factoryV1 ? opening.call(options.factoryV1, encodeCall(V1_FACTORY_FUNCTIONS.getLaunchedToken, [address])) : null;
  const idSlots = contractIdSlots(opening, address);
  const metaFields = metaSlots(opening, address);
  await opening.run();

  let launch: LaunchedToken | null = null;
  let resolvedAs: IdCheck["resolvedAs"] = "unknown";
  // A factory that answers with an error is not the same as a factory that
  // says no: the first is rethrown, exactly as the sequential version did.
  const v2Raw = opening.answer(v2Slot);
  if (v2Raw instanceof RpcError) throw v2Raw;
  if (v2Raw !== null) {
    const record = decodeLaunchedToken(decodeOutputs(FACTORY_FUNCTIONS.getLaunchedToken, v2Raw));
    if (record.exists) {
      launch = record;
      resolvedAs = "token";
    }
  }
  if (!launch) {
    // Maybe the caller pasted the curve. A Pons curve knows its token.
    const viaCurve = decodeAddress(CURVE_FUNCTIONS.token, opening.answer(curveSlot));
    if (viaCurve) {
      try {
        const record = await reader.launchedToken(viaCurve, block);
        if (record.curve.toLowerCase() === address) {
          launch = record;
          resolvedAs = "curve";
        }
      } catch (inner) {
        if (!(inner instanceof NotAPonsLaunch)) throw inner;
      }
    }
  }

  const native = options.native ?? { symbol: "ETH", decimals: 18 };
  let v1: V1Launch | null = null;
  if (!launch && options.factoryV1) {
    const v1Raw = opening.answer(v1Slot);
    try {
      // The record is already in hand; readV1Launch is only asked for the
      // rest of the terms, and only when there is a record to have terms.
      if (v1Raw !== null && !(v1Raw instanceof RpcError) && decodeV1LaunchedToken(decodeOutputs(V1_FACTORY_FUNCTIONS.getLaunchedToken, v1Raw)).exists) {
        v1 = await readV1Launch(rpc, options.factoryV1, address, block, native);
        if (v1) resolvedAs = "token";
      }
    } catch {
      v1 = null;
    }
  }

  const tokenAddress = launch ? launch.token.toLowerCase() : address;
  // The speculative reads were aimed at the pasted address. When that turned
  // out to be a curve, the token is somewhere else and they are re-read.
  const token = tokenAddress === address ? contractIdOf(opening, address, idSlots) : await readContractId(rpc, tokenAddress, block);
  const curve = launch ? await readContractId(rpc, launch.curve.toLowerCase(), block) : null;
  const meta = token.code.empty ? null : tokenAddress === address ? (metaOf(opening, metaFields) ?? (await readMetaSafely(rpc, tokenAddress, block))) : await readMetaSafely(rpc, tokenAddress, block);

  // A V1-style token carries the address of the factory that made it. Ask
  // that factory too, but only count it when the chain table knows it.
  let claimedFactory: string | null = null;
  if (!launch && !v1 && !token.code.empty && token.code.selectors.has(selector("launchFactory()"))) {
    claimedFactory = await launchFactoryOf(rpc, tokenAddress, block);
    const known = new Set([options.factoryV1, ...(options.olderFactoriesV1 ?? [])].filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase()));
    if (claimedFactory && known.has(claimedFactory) && claimedFactory !== options.factoryV1) {
      try {
        v1 = await readV1Launch(rpc, claimedFactory, address, block, native);
        if (v1) resolvedAs = "token";
      } catch {
        v1 = null;
      }
    }
  }

  return { input: address, resolvedAs, registered: launch !== null || v1 !== null, launchpad: launch ? "v2" : v1 ? "v1" : null, launch, v1, token, meta, curve, claimedFactory };
}

/** Code and both EIP-1967 proxy slots: three questions, one round trip. */
function contractIdSlots(batch: ReadBatch, address: string): [number, number, number] {
  return [batch.getCode(address), batch.getStorageAt(address, EIP1967_IMPLEMENTATION_SLOT), batch.getStorageAt(address, EIP1967_BEACON_SLOT)];
}

function contractIdOf(batch: ReadBatch, address: string, [codeSlot, implSlot, beaconSlot]: [number, number, number]): ContractId {
  const code = scanBytecode(batch.hex(codeSlot) ?? "0x");
  if (code.empty) return { address, code, runtime: "0x", proxyImplementation: null, proxyBeacon: null };
  const implementation = batch.hex(implSlot);
  const beacon = batch.hex(beaconSlot);
  return {
    address,
    code,
    runtime: batch.hex(codeSlot) ?? "0x",
    proxyImplementation: implementation && storageWordIsSet(implementation) ? storageWordAddress(implementation) : null,
    proxyBeacon: beacon && storageWordIsSet(beacon) ? storageWordAddress(beacon) : null,
  };
}

function metaSlots(batch: ReadBatch, address: string): [number, number, number, number] {
  return [
    batch.call(address, encodeCall(ERC20_FUNCTIONS.name, [])),
    batch.call(address, encodeCall(ERC20_FUNCTIONS.symbol, [])),
    batch.call(address, encodeCall(ERC20_FUNCTIONS.decimals, [])),
    batch.call(address, encodeCall(ERC20_FUNCTIONS.totalSupply, [])),
  ];
}

/** The four ERC-20 views, or null when any of them did not come back readable. */
function metaOf(batch: ReadBatch, [nameSlot, symbolSlot, decimalsSlot, supplySlot]: [number, number, number, number]): TokenMeta | null {
  try {
    const raw = (slot: number): Hex => {
      const value = batch.hex(slot);
      if (value === null) throw new Error("unread");
      return value;
    };
    const [name] = decodeOutputs(ERC20_FUNCTIONS.name, raw(nameSlot)) as [string];
    const [symbol] = decodeOutputs(ERC20_FUNCTIONS.symbol, raw(symbolSlot)) as [string];
    const [decimals] = decodeOutputs(ERC20_FUNCTIONS.decimals, raw(decimalsSlot)) as [bigint];
    const [totalSupply] = decodeOutputs(ERC20_FUNCTIONS.totalSupply, raw(supplySlot)) as [bigint];
    return { name, symbol, decimals: Number(decimals), totalSupply };
  } catch {
    return null;
  }
}


/** An address-returning view, decoded, with the zero address read as "no answer". */
function decodeAddress(fn: FunctionAbi, raw: Hex | RpcError | null): string | null {
  if (raw === null || raw instanceof RpcError) return null;
  try {
    const [value] = decodeOutputs(fn, raw) as [string];
    return value && value !== ZERO_ADDRESS ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function launchFactoryOf(rpc: RpcClient, token: string, block: number): Promise<string | null> {
  try {
    const [raw] = await rpc.callBatch([{ to: token, data: encodeCall(LAUNCH_FACTORY_VIEW, []) }], block);
    const [factory] = decodeOutputs(LAUNCH_FACTORY_VIEW, raw) as [string];
    return factory && factory !== ZERO_ADDRESS ? factory.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function readContractId(rpc: RpcClient, address: string, block: number): Promise<ContractId> {
  const batch = new ReadBatch(rpc, block);
  const slots = contractIdSlots(batch, address);
  await batch.run();
  return contractIdOf(batch, address, slots);
}

async function tokenOfCurve(rpc: RpcClient, curve: string, block: number): Promise<string | null> {
  try {
    const [raw] = await rpc.callBatch([{ to: curve, data: encodeCall(CURVE_FUNCTIONS.token, []) }], block);
    const [token] = decodeOutputs(CURVE_FUNCTIONS.token, raw) as [string];
    return token && token !== ZERO_ADDRESS ? token.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function readMetaSafely(rpc: RpcClient, token: string, block: number): Promise<TokenMeta | null> {
  const one = async (fn: (typeof ERC20_FUNCTIONS)[keyof typeof ERC20_FUNCTIONS]) => (await rpc.callBatch([{ to: token, data: encodeCall(fn, []) }], block))[0];
  try {
    const results = await rpc.callBatch(
      [
        { to: token, data: encodeCall(ERC20_FUNCTIONS.name, []) },
        { to: token, data: encodeCall(ERC20_FUNCTIONS.symbol, []) },
        { to: token, data: encodeCall(ERC20_FUNCTIONS.decimals, []) },
        { to: token, data: encodeCall(ERC20_FUNCTIONS.totalSupply, []) },
      ],
      block,
    );
    const [name] = decodeOutputs(ERC20_FUNCTIONS.name, results[0]) as [string];
    const [symbol] = decodeOutputs(ERC20_FUNCTIONS.symbol, results[1]) as [string];
    const [decimals] = decodeOutputs(ERC20_FUNCTIONS.decimals, results[2]) as [bigint];
    const [totalSupply] = decodeOutputs(ERC20_FUNCTIONS.totalSupply, results[3]) as [bigint];
    return { name, symbol, decimals: Number(decimals), totalSupply };
  } catch {
    // A batch can be refused by an endpoint that accepts single calls; one more try, one call at a time.
    try {
      const [name] = decodeOutputs(ERC20_FUNCTIONS.name, await one(ERC20_FUNCTIONS.name)) as [string];
      const [symbol] = decodeOutputs(ERC20_FUNCTIONS.symbol, await one(ERC20_FUNCTIONS.symbol)) as [string];
      const [decimals] = decodeOutputs(ERC20_FUNCTIONS.decimals, await one(ERC20_FUNCTIONS.decimals)) as [bigint];
      const [totalSupply] = decodeOutputs(ERC20_FUNCTIONS.totalSupply, await one(ERC20_FUNCTIONS.totalSupply)) as [bigint];
      return { name, symbol, decimals: Number(decimals), totalSupply };
    } catch {
      return null;
    }
  }
}

/** Facts the door rules read off an ID check; kept here so they are testable on their own. */
export function idFindings(id: IdCheck): string[] {
  const out: string[] = [];
  const t = id.token;
  if (t.code.empty) out.push("no bytecode at this address");
  if (t.proxyImplementation) out.push(`upgradeable proxy (EIP-1967 implementation ${t.proxyImplementation})`);
  if (t.proxyBeacon) out.push(`beacon proxy (EIP-1967 beacon ${t.proxyBeacon})`);
  if (t.code.minimalProxyTarget) out.push(`minimal proxy (EIP-1167) to ${t.code.minimalProxyTarget}`);
  if (t.code.opcodes.selfdestruct) out.push(`SELFDESTRUCT ×${t.code.opcodes.selfdestruct}`);
  if (t.code.opcodes.delegatecall) out.push(`DELEGATECALL ×${t.code.opcodes.delegatecall}`);
  if (t.code.opcodes.callcode) out.push(`CALLCODE ×${t.code.opcodes.callcode}`);
  if (t.code.opcodes.create2 || t.code.opcodes.create) out.push(`deploys contracts (CREATE ×${t.code.opcodes.create}, CREATE2 ×${t.code.opcodes.create2})`);
  return out;
}
