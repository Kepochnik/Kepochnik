/**
 * The smallest ABI codec that covers what a read-only Pons V2 reader needs:
 * static types (address, uintN, intN, bool, bytes32), strings, and flat
 * tuples of static types. Nothing here can build a transaction.
 */
import { bytesToHex, hexToBytes, keccak256 } from "./keccak.js";

export type StaticType =
  | "address"
  | "bool"
  | "bytes32"
  | `uint${number}`
  | `int${number}`;

export type AbiType = StaticType | "string";

export type Hex = `0x${string}`;

export interface EventParam {
  name: string;
  type: StaticType;
  indexed: boolean;
}

export interface EventAbi {
  name: string;
  inputs: EventParam[];
}

export interface FunctionAbi {
  name: string;
  inputs: StaticType[];
  outputs: AbiType[];
}

export function selector(signature: string): Hex {
  return `0x${bytesToHex(keccak256(signature).slice(0, 4))}`;
}

export function eventSignature(event: EventAbi): string {
  return `${event.name}(${event.inputs.map((input) => input.type).join(",")})`;
}

export function eventTopic(event: EventAbi): Hex {
  return `0x${bytesToHex(keccak256(eventSignature(event)))}`;
}

export function functionSignature(fn: FunctionAbi): string {
  return `${fn.name}(${fn.inputs.join(",")})`;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function encodeWord(type: StaticType, value: unknown): string {
  if (type === "address") {
    const address = normalizeAddress(String(value));
    return address.slice(2).padStart(64, "0");
  }
  if (type === "bool") {
    return (value ? 1n : 0n).toString(16).padStart(64, "0");
  }
  if (type === "bytes32") {
    const hex = String(value).toLowerCase().replace(/^0x/, "");
    if (hex.length !== 64) throw new Error(`bytes32 expects 32 bytes, got ${hex.length / 2}`);
    return hex;
  }
  if (type.startsWith("uint")) {
    const big = toBigInt(value);
    if (big < 0n) throw new Error(`negative value for ${type}`);
    return big.toString(16).padStart(64, "0");
  }
  if (type.startsWith("int")) {
    const big = toBigInt(value);
    const twos = big < 0n ? (1n << 256n) + big : big;
    return twos.toString(16).padStart(64, "0");
  }
  throw new Error(`unsupported static type ${type}`);
}

export function encodeCall(fn: FunctionAbi, args: unknown[]): Hex {
  if (args.length !== fn.inputs.length) {
    throw new Error(`${fn.name} expects ${fn.inputs.length} args, got ${args.length}`);
  }
  const words = fn.inputs.map((type, index) => encodeWord(type, args[index]));
  return `${selector(functionSignature(fn))}${words.join("")}` as Hex;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export function decodeWord(type: StaticType, word: string): unknown {
  if (word.length !== 64) throw new Error(`expected a 32-byte word, got ${word.length / 2} bytes`);
  if (type === "address") return `0x${word.slice(24)}`.toLowerCase();
  if (type === "bool") return BigInt(`0x${word}`) !== 0n;
  if (type === "bytes32") return `0x${word}`;
  if (type.startsWith("uint")) return BigInt(`0x${word}`);
  if (type.startsWith("int")) {
    // Every intN is sign-extended to a full 256-bit word in the ABI.
    const raw = BigInt(`0x${word}`);
    return raw >= 1n << 255n ? raw - (1n << 256n) : raw;
  }
  throw new Error(`unsupported static type ${type}`);
}

export function decodeOutputs(fn: FunctionAbi, data: Hex): unknown[] {
  const hex = data.slice(2);
  if (hex.length === 0) throw new Error(`${fn.name}: empty return data`);
  const words = hex.match(/.{64}/g) ?? [];
  const values: unknown[] = [];
  for (let i = 0; i < fn.outputs.length; i++) {
    const type = fn.outputs[i];
    const word = words[i];
    if (word === undefined) throw new Error(`${fn.name}: return data too short`);
    if (type === "string") {
      const offset = Number(BigInt(`0x${word}`)) * 2;
      const length = Number(BigInt(`0x${hex.slice(offset, offset + 64)}`));
      const bytes = hexToBytes(hex.slice(offset + 64, offset + 64 + length * 2));
      values.push(new TextDecoder().decode(bytes));
    } else {
      values.push(decodeWord(type, word));
    }
  }
  return values;
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export interface DecodedLog<T = Record<string, unknown>> {
  name: string;
  address: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  args: T;
}

export function decodeLog<T = Record<string, unknown>>(event: EventAbi, log: RawLog): DecodedLog<T> {
  const expectedTopic = eventTopic(event);
  if ((log.topics[0] ?? "").toLowerCase() !== expectedTopic) {
    throw new Error(`log topic does not match ${event.name}`);
  }
  const args: Record<string, unknown> = {};
  let topicIndex = 1;
  const dataWords = log.data.slice(2).match(/.{64}/g) ?? [];
  let dataIndex = 0;
  for (const input of event.inputs) {
    if (input.indexed) {
      const topic = log.topics[topicIndex++];
      if (!topic) throw new Error(`${event.name}: missing indexed topic ${input.name}`);
      args[input.name] = decodeWord(input.type, topic.slice(2));
    } else {
      const word = dataWords[dataIndex++];
      if (!word) throw new Error(`${event.name}: missing data word ${input.name}`);
      args[input.name] = decodeWord(input.type, word);
    }
  }
  return {
    name: event.name,
    address: log.address.toLowerCase(),
    blockNumber: Number(BigInt(log.blockNumber)),
    transactionHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
    args: args as T,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function normalizeAddress(value: string): Hex {
  if (!isAddress(value)) throw new Error(`not an EVM address: ${value}`);
  return value.toLowerCase() as Hex;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`non-integer number ${value}`);
    return BigInt(value);
  }
  if (typeof value === "string") return BigInt(value);
  throw new Error(`cannot convert ${typeof value} to bigint`);
}
