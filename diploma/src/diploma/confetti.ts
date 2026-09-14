/**
 * The confetti. Robinhood removed its confetti animation in 2021 after
 * regulators called it gamification. DIPLOMA fires it under one rule: once per
 * token, on the block the token graduates.
 *
 * Deterministic: seeded by the graduation block number, so a replay of the
 * same block draws the same confetti. No randomness, no surprises.
 */

const GLYPHS = ["▪", "▪", "▪", "▫", "◆", "•", "✦"];

function lcg(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export interface ConfettiOptions {
  width?: number;
  height?: number;
  frames?: number;
  density?: number; // pieces per frame width
  color?: boolean;
}

const NAVY = "[38;5;18m";
const GOLD = "[38;5;220m";
const RESET = "[0m";

/** Returns the frames of one confetti burst as arrays of lines. */
export function confettiFrames(seedBlock: number, options: ConfettiOptions = {}): string[][] {
  const width = options.width ?? 60;
  const height = options.height ?? 6;
  const frameCount = options.frames ?? 12;
  const density = options.density ?? 0.35;
  const color = options.color ?? false;
  const rand = lcg(seedBlock);

  const pieces = Math.max(1, Math.round(width * density));
  const items = Array.from({ length: pieces }, () => ({
    x: Math.floor(rand() * width),
    drift: rand() < 0.5 ? -1 : 1,
    delay: Math.floor(rand() * 4),
    glyph: GLYPHS[Math.floor(rand() * GLYPHS.length)],
    gold: rand() < 0.5,
  }));

  const frames: string[][] = [];
  for (let f = 0; f < frameCount; f++) {
    const grid: string[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
    for (const item of items) {
      const t = f - item.delay;
      if (t < 0) continue;
      const y = Math.min(height - 1, t);
      const x = ((item.x + (t % 3 === 0 ? item.drift : 0)) % width + width) % width;
      if (t >= height + 2) continue;
      const glyph = color ? `${item.gold ? GOLD : NAVY}${item.glyph}${RESET}` : item.glyph;
      grid[y][x] = glyph;
    }
    frames.push(grid.map((row) => row.join("")));
  }
  return frames;
}

/** Render the burst as a static block (last frame with the banner) for logs and docs. */
export function confettiBlock(seedBlock: number, banner: string, options: ConfettiOptions = {}): string {
  const frames = confettiFrames(seedBlock, options);
  const last = frames[Math.min(frames.length - 1, 5)];
  const width = options.width ?? 60;
  const centered = banner.length >= width ? banner : " ".repeat(Math.floor((width - banner.length) / 2)) + banner;
  return [...last.slice(0, 3), centered, ...last.slice(3)].join("\n");
}

/** Play the burst in a TTY. Resolves when done; no-op frames when not a TTY. */
export async function playConfetti(seedBlock: number, banner: string, write: (text: string) => void, frameMs = 90, options: ConfettiOptions = {}): Promise<void> {
  const frames = confettiFrames(seedBlock, options);
  const height = frames[0].length;
  for (let i = 0; i < frames.length; i++) {
    write(frames[i].join("\n") + "\n");
    await new Promise((resolve) => setTimeout(resolve, frameMs));
    if (i < frames.length - 1) write(`[${height}A`);
  }
  write(banner + "\n");
}
