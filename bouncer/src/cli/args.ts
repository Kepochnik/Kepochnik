/** Tiny argv parser: `cmd --flag value --bool positional`. No dependency needed. */

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
      const key = rawKey.trim();
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

export function flagString(flags: Record<string, string | true>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

export function flagNumber(flags: Record<string, string | true>, key: string, fallback: number): number {
  const value = flagString(flags, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} expects a number, got ${value}`);
  return parsed;
}

/**
 * Every flag this tool reads.
 *
 * Kept here rather than discovered from use, because the parser cannot
 * know what a command will later ask for, and a flag nobody asks for has
 * to be refused at the door.
 *
 * The reason this list exists is one typo. `--chian base` parsed cleanly,
 * `--chain` was never set, and BOUNCER read Robinhood Chain while its
 * user believed they were checking a token on Base — a token that on
 * Robinhood Chain is somebody else's contract entirely, or nothing at
 * all. For a tool whose whole argument is "do not trust that this address
 * is what you were told", silently reading a different chain is the worst
 * failure available to it. `--dem0` was the same shape: a live read by
 * somebody who thought they were in the demo.
 *
 * A test holds this against what the source actually reads, so a flag
 * added to a command and not added here fails rather than being refused
 * from a user's command line.
 */
export const KNOWN_FLAGS = [
  "amount", "backfill", "buy", "chain", "chunk", "config", "crew", "demo", "factory", "format",
  "help", "hours", "interval", "launch-blocks", "liquidity-blocks", "min",
  "no-blockscout", "no-cover", "no-crew", "no-dev", "no-liquidity", "no-lookalikes", "no-room",
  "output", "quiet", "quote", "rounds", "rpc", "tax", "top", "version", "wallet",
] as const;

/** Levenshtein, small and local: it exists to say "did you mean --chain". */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return rows[a.length][b.length];
}

/**
 * The flags in this command line that the tool does not know, each with
 * the closest one it does when there is a plausible candidate.
 */
export function unknownFlags(flags: Record<string, string | true>): { flag: string; meant?: string }[] {
  const known = new Set<string>(KNOWN_FLAGS);
  return Object.keys(flags)
    .filter((k) => !known.has(k))
    .map((flag) => {
      // Two edits for anything four characters or longer, one below that.
      //
      // The first version allowed one edit for a five-letter flag, which
      // meant `--chian` — a straight transposition of `--chain`, and the
      // typo this whole list exists for — got no suggestion at all. A
      // swapped pair of letters is two edits in plain Levenshtein, and it
      // is the most common way anybody mistypes a word.
      const near = [...known]
        .map((k) => ({ k, d: editDistance(flag, k) }))
        .filter((x) => x.d <= (x.k.length >= 4 ? 2 : 1))
        .sort((a, b) => a.d - b.d || a.k.length - b.k.length)[0];
      return near ? { flag, meant: near.k } : { flag };
    });
}
