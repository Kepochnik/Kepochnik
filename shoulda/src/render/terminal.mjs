import { pct, shortAddress, signedUsd, usd } from './format.mjs';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const lime = paint('38;5;190');
const grey = paint('90');

const GRAMPS = [
  "                  _____",
  "       ,-\"\"\"-.   [_____]_",
  "     /' /\\_/\\ '\\  (-o o-)",
  "    |  <_/ \\_>  |__ \\_ /",
  "     \\.________./ --'",
  "       |_|   |_|",
];

export function terminal(receipt) {
  const { result, verdict, bench, wallet, notes } = receipt;
  const { totals } = result;
  const lost = totals.memes < totals.index;
  const out = [];

  out.push('', ...GRAMPS.map((l) => lime(l)), '');
  out.push(`${lime(bold('SHOULDA'))}  ${grey(`${shortAddress(wallet)} · Robinhood Chain`)}`, '');
  out.push(bold(verdict.title), dim(verdict.line), '');

  if (result.apes) {
    const max = Math.max(totals.memes, totals.eth, totals.index, 1);
    const bar = (v, color) => color('█'.repeat(Math.max(1, Math.round((v / max) * 28))));
    const line = (label, v, color) => `  ${label.padEnd(18)} ${bar(v, color)} ${bold(usd(v))}`;
    out.push(line('Your memes', totals.memes, lost ? red : lime));
    out.push(line('Just held ETH', totals.eth, grey));
    out.push(line(`Just bought ${bench}`, totals.index, lost ? lime : grey), '');
    out.push(`  ${(lost ? red : lime)(`${signedUsd(result.gap)} vs ${bench} (${pct(result.ratio)})`)}`);
    out.push(
      grey(`  ${result.apes} apes · ${result.coins} coins · ${result.rugged} went to zero · ${usd(totals.spent)} in`),
      '',
    );
    if (result.worst) out.push(`  ${red('worst')}  $${result.worst.token.symbol.padEnd(12)} ${signedUsd(result.worst.memes - result.worst.index)} vs ${bench}`);
    if (result.best && result.best !== result.worst) {
      out.push(`  ${lime('best')}   $${result.best.token.symbol.padEnd(12)} ${signedUsd(result.best.memes - result.best.index)} vs ${bench}`);
    }
    out.push('');
  }

  const caveats = [];
  if (!notes.completeHistory) caveats.push('history truncated by the explorer: oldest trades may be missing');
  if (notes.skipped.memeToMeme) caveats.push(`${notes.skipped.memeToMeme} meme-to-meme swaps not counted`);
  if (notes.skipped.stockTrades) caveats.push(`${notes.skipped.stockTrades} stock-token trades left out (those are investing)`);
  caveats.push(`ETH priced from ${notes.ethSource}; bags marked at DEX price, not exit liquidity; gas not counted`);
  out.push(...caveats.map((c) => dim(`  · ${c}`)), '');
  return out.join('\n');
}
