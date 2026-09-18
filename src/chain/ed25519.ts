/**
 * Just enough ed25519 to answer one question: are these 32 bytes a point on
 * the curve? Solana's program addresses are defined as the hashes that are
 * NOT, so deriving one means hashing with a bump seed until the answer is no.
 * Nothing here signs or verifies anything; there is no private key in this
 * package and no code that could use one.
 */
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/**
 * Decompresses the y coordinate the way ed25519 does and reports whether a
 * matching x exists. A 32-byte string with no such x is off the curve, which
 * is exactly what a program-derived address is.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;

  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  if (v === 0n) return false;

  // x = u * v^3 * (u * v^7)^((p-5)/8)
  const v3 = (v * v % P) * v % P;
  const v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * modPow((u * v7) % P, (P - 5n) / 8n, P) % P;

  const check = (v * x % P) * x % P;
  if (check === u) {
    // x is the root
  } else if (check === (P - u) % P) {
    x = (x * SQRT_M1) % P;
  } else {
    return false;
  }
  // x === 0 with a set sign bit is the one encoding ed25519 rejects.
  if (x === 0n && sign === 1n) return false;
  return true;
}
