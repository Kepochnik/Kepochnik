/**
 * Keccak-256 (the Ethereum variant, 0x01 padding — NOT NIST SHA3-256).
 *
 * Implemented with BigInt lanes for readability. It is only used to derive
 * function selectors and event topics at startup, so speed is irrelevant and
 * a dependency would be noise. Verified against the standard test vectors in
 * test/keccak.test.ts.
 */

const MASK64 = (1n << 64n) - 1n;

const ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets r[x][y], indexed as ROTATION[x + 5 * y].
const ROTATION: number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const RATE_BYTES = 136; // 1088-bit rate for Keccak-256

function rotl64(value: bigint, shift: number): bigint {
  if (shift === 0) return value;
  return ((value << BigInt(shift)) | (value >> BigInt(64 - shift))) & MASK64;
}

function keccakF1600(state: bigint[]): void {
  const c = new Array<bigint>(5);
  const d = new Array<bigint>(5);
  const b = new Array<bigint>(25);

  for (let round = 0; round < 24; round++) {
    // θ
    for (let x = 0; x < 5; x++) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) {
      state[i] ^= d[i % 5];
    }
    // ρ and π
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const from = x + 5 * y;
        const to = y + 5 * ((2 * x + 3 * y) % 5);
        b[to] = rotl64(state[from], ROTATION[from]);
      }
    }
    // χ
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y;
        state[i] = b[i] ^ (~b[((x + 1) % 5) + 5 * y] & MASK64 & b[((x + 2) % 5) + 5 * y]);
      }
    }
    // ι
    state[0] ^= ROUND_CONSTANTS[round];
  }
}

export function keccak256(input: Uint8Array | string): Uint8Array {
  const message = typeof input === "string" ? new TextEncoder().encode(input) : input;

  // Keccak padding: 0x01 ... 0x80 (a single 0x81 when one byte is left).
  const paddedLength = Math.ceil((message.length + 1) / RATE_BYTES) * RATE_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] ^= 0x01;
  padded[paddedLength - 1] ^= 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < paddedLength; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      let word = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        word = (word << 8n) | BigInt(padded[offset + lane * 8 + byte]);
      }
      state[lane] ^= word;
    }
    keccakF1600(state);
  }

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let word = state[lane];
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(word & 0xffn);
      word >>= 8n;
    }
  }
  return out;
}

export function keccak256Hex(input: Uint8Array | string): `0x${string}` {
  return `0x${bytesToHex(keccak256(input))}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
