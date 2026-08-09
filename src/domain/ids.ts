import * as Crypto from 'expo-crypto';

/**
 * All primary keys are client-generated UUIDs. This is what makes widget writes
 * idempotent: the widget mints the id, the app inserts with `on conflict do nothing`,
 * and a replayed or half-drained queue can never duplicate an event.
 */
export function newId(): string {
  return Crypto.randomUUID();
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
export const ROOM_CODE_LENGTH = 6;

/** Human-readable room code. Ambiguous glyphs are excluded so codes survive being read aloud. */
export function generateRoomCode(): string {
  const bytes = Crypto.getRandomBytes(ROOM_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(input: string): boolean {
  const code = normalizeRoomCode(input);
  return (
    code.length === ROOM_CODE_LENGTH &&
    code.split('').every((char) => ROOM_CODE_ALPHABET.includes(char))
  );
}
