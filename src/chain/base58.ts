/**
 * Base58 in the Bitcoin alphabet, which is how Solana writes every address.
 * Decoding is a base conversion plus one rule that is easy to miss: a leading
 * '1' is a leading zero byte, not a digit, and dropping those would turn one
 * account into a different one.
 */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) INDEX.set(ALPHABET[i], i);

export function base58Decode(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);
  let value = 0n;
  for (const char of text) {
    const digit = INDEX.get(char);
    if (digit === undefined) throw new Error(`not base58: ${JSON.stringify(char)} in ${text.slice(0, 64)}`);
    value = value * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (value > 0n) {
    body.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  let leadingZeros = 0;
  for (const char of text) {
    if (char !== "1") break;
    leadingZeros++;
  }
  return new Uint8Array([...new Array(leadingZeros).fill(0), ...body]);
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** A Solana address is 32 bytes written in base58; anything else is not one. */
export function isSolanaAddress(text: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return false;
  try {
    return base58Decode(text).length === 32;
  } catch {
    return false;
  }
}
