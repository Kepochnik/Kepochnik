/**
 * ID CHECK: is this address a token the Pons V2 factory itself deployed, and
 * what does its bytecode contain? The factory keeps a record for every
 * launch it made and deploys the token contract itself, so "registered in
 * the factory" is the whole genuineness test: no name matching, no list of
 * trusted deployers. The bytecode scan is the second question, asked of
 * every address, Pons or not: can this contract change or disappear?
 */
import { decodeOutputs, encodeCall, isAddress, normalizeAddress } from "../chain/abi.js";
import { EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT, scanBytecode, storageWordAddress, storageWordIsSet, type CodeScan } from "../chain/code.js";
import { CURVE_FUNCTIONS, ERC20_FUNCTIONS, ZERO_ADDRESS, type LaunchedToken } from "../chain/pons.js";
import { NotAPonsLaunch, PonsReader, type TokenMeta } from "../chain/reader.js";
import type { RpcClient } from "../chain/rpc.js";
import { readV1Launch, type V1Launch } from "./v1.js";

export interface ContractId {
  address: string;
  code: CodeScan;
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
}

export interface IdCheckOptions {
  factoryV1?: string;
  native?: { symbol: string; decimals: number };
}

export async function readIdCheck(rpc: RpcClient, input: string, block: number, factory?: string, options: IdCheckOptions = {}): Promise<IdCheck> {
  if (!isAddress(input)) throw new Error(`${input} is not an address`);
  const address = normalizeAddress(input);
  const reader = new PonsReader(rpc, factory);

  let launch: LaunchedToken | null = null;
  let resolvedAs: IdCheck["resolvedAs"] = "unknown";
  try {
    launch = await reader.launchedToken(address, block);
    resolvedAs = "token";
  } catch (error) {
    if (!(error instanceof NotAPonsLaunch)) throw error;
    // Maybe the caller pasted the curve. A Pons curve knows its token.
    const viaCurve = await tokenOfCurve(rpc, address, block);
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

  let v1: V1Launch | null = null;
  if (!launch && options.factoryV1) {
    try {
      v1 = await readV1Launch(rpc, options.factoryV1, address, block, options.native ?? { symbol: "ETH", decimals: 18 });
      if (v1) resolvedAs = "token";
    } catch {
      v1 = null;
    }
  }

  const tokenAddress = launch ? launch.token.toLowerCase() : address;
  const token = await readContractId(rpc, tokenAddress, block);
  const curve = launch ? await readContractId(rpc, launch.curve.toLowerCase(), block) : null;
  const meta = token.code.empty ? null : await readMetaSafely(rpc, tokenAddress, block);

  return { input: address, resolvedAs, registered: launch !== null || v1 !== null, launchpad: launch ? "v2" : v1 ? "v1" : null, launch, v1, token, meta, curve };
}

export async function readContractId(rpc: RpcClient, address: string, block: number): Promise<ContractId> {
  const code = scanBytecode(await rpc.getCode(address, block));
  if (code.empty) return { address, code, proxyImplementation: null, proxyBeacon: null };
  const implementation = await rpc.getStorageAt(address, EIP1967_IMPLEMENTATION_SLOT, block);
  const beacon = await rpc.getStorageAt(address, EIP1967_BEACON_SLOT, block);
  return {
    address,
    code,
    proxyImplementation: storageWordIsSet(implementation) ? storageWordAddress(implementation) : null,
    proxyBeacon: storageWordIsSet(beacon) ? storageWordAddress(beacon) : null,
  };
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
