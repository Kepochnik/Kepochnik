/**
 * Bytecode inspection without a disassembler dependency. Walks the runtime
 * code opcode by opcode, skipping PUSH immediates and the Solidity metadata
 * trailer, and counts the opcodes that let a contract change or vanish:
 * SELFDESTRUCT, DELEGATECALL, CALLCODE, CREATE, CREATE2. Also recognises the
 * EIP-1167 minimal proxy shape. Everything here is a fact about bytes; what
 * it means for a token is decided one layer up, in the door rules.
 */
import type { Hex } from "./abi.js";
import { hexToBytes, keccak256Hex } from "./keccak.js";

export interface OpcodeCounts {
  selfdestruct: number;
  delegatecall: number;
  callcode: number;
  create: number;
  create2: number;
}

export interface CodeScan {
  /** Runtime bytecode length in bytes, metadata trailer included. */
  bytes: number;
  /** keccak-256 of the full runtime bytecode, the EVM's own code hash. */
  codeHash: Hex;
  /** True when eth_getCode returned "0x": an EOA or a self-destructed contract. */
  empty: boolean;
  /** Bytes of CBOR metadata Solidity appended, 0 when no trailer was recognised. */
  metadataBytes: number;
  opcodes: OpcodeCounts;
  /** Implementation address when the code is an EIP-1167 minimal proxy. */
  minimalProxyTarget: string | null;
}

const OP_SELFDESTRUCT = 0xff;
const OP_DELEGATECALL = 0xf4;
const OP_CALLCODE = 0xf2;
const OP_CREATE = 0xf0;
const OP_CREATE2 = 0xf5;
const OP_PUSH1 = 0x60;
const OP_PUSH32 = 0x7f;

/** EIP-1967 storage slots, read to spot upgradeable proxies. */
export const EIP1967_IMPLEMENTATION_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const EIP1967_BEACON_SLOT: Hex = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

export function scanBytecode(code: Hex | string): CodeScan {
  const bytes = hexToBytes(code);
  const scan: CodeScan = {
    bytes: bytes.length,
    codeHash: keccak256Hex(bytes),
    empty: bytes.length === 0,
    metadataBytes: metadataTrailerLength(bytes),
    opcodes: { selfdestruct: 0, delegatecall: 0, callcode: 0, create: 0, create2: 0 },
    minimalProxyTarget: minimalProxyTarget(bytes),
  };
  const end = bytes.length - scan.metadataBytes;
  for (let i = 0; i < end; i++) {
    const op = bytes[i];
    if (op >= OP_PUSH1 && op <= OP_PUSH32) {
      i += op - OP_PUSH1 + 1;
      continue;
    }
    if (op === OP_SELFDESTRUCT) scan.opcodes.selfdestruct++;
    else if (op === OP_DELEGATECALL) scan.opcodes.delegatecall++;
    else if (op === OP_CALLCODE) scan.opcodes.callcode++;
    else if (op === OP_CREATE) scan.opcodes.create++;
    else if (op === OP_CREATE2) scan.opcodes.create2++;
  }
  return scan;
}

/**
 * Solidity ends runtime code with a CBOR map and a two-byte big-endian
 * length. The map starts with 0xa1..0xa3 (one to three keys). Anything else
 * is treated as "no trailer" and scanned as code.
 */
function metadataTrailerLength(bytes: Uint8Array): number {
  if (bytes.length < 4) return 0;
  const length = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  if (length === 0 || length + 2 > bytes.length) return 0;
  const first = bytes[bytes.length - 2 - length];
  return first >= 0xa1 && first <= 0xa3 ? length + 2 : 0;
}

const MINIMAL_PROXY_PREFIX = "363d3d373d3d3d363d73";
const MINIMAL_PROXY_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

function minimalProxyTarget(bytes: Uint8Array): string | null {
  if (bytes.length !== 45) return null;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  if (!hex.startsWith(MINIMAL_PROXY_PREFIX) || !hex.endsWith(MINIMAL_PROXY_SUFFIX)) return null;
  return `0x${hex.slice(MINIMAL_PROXY_PREFIX.length, MINIMAL_PROXY_PREFIX.length + 40)}`;
}

/** A storage word is "set" when it is not all zeros. */
export function storageWordIsSet(word: string): boolean {
  return /[1-9a-f]/i.test(word.replace(/^0x/, ""));
}

export function storageWordAddress(word: string): string {
  return `0x${word.replace(/^0x/, "").padStart(64, "0").slice(24)}`;
}
