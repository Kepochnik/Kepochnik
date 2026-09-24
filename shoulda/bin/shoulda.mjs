#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { BENCHMARKS, DEFAULT_BENCHMARK } from '../src/config.mjs';
import { demoReceipt } from '../src/demo.mjs';
import { card } from '../src/render/card.mjs';
import { terminal } from '../src/render/terminal.mjs';
import { receipt } from '../src/run.mjs';

const HELP = `shoulda: your memecoin trades vs. just buying the stock.

  shoulda <wallet>            replay a Robinhood Chain wallet against ${DEFAULT_BENCHMARK}
  shoulda demo                the same, on a made-up wallet, offline

  --vs <TICKER>               benchmark: ${Object.keys(BENCHMARKS).join(', ')} (default ${DEFAULT_BENCHMARK})
  --card <file.svg>           also write a 1200x675 share card
  --json                      print the raw receipt as JSON
  -h, --help

Read-only. No keys, no signing, no wallet connect.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    vs: { type: 'string', default: DEFAULT_BENCHMARK },
    card: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const target = positionals[0];
if (values.help || !target) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

const bench = values.vs.toUpperCase();
if (target !== 'demo' && !/^0x[0-9a-fA-F]{40}$/.test(target)) {
  console.error(`"${target}" is not a wallet address.`);
  process.exit(1);
}

try {
  const r =
    target === 'demo'
      ? demoReceipt(bench)
      : await receipt(target, { bench, onStep: (s) => !values.json && process.stderr.write(`  … ${s}\n`) });

  if (values.card) {
    await writeFile(values.card, card(r));
    if (!values.json) process.stderr.write(`  card written to ${values.card}\n`);
  }
  console.log(values.json ? JSON.stringify(r, null, 2) : terminal(r));
} catch (err) {
  console.error(`shoulda: ${err.message}`);
  process.exit(1);
}
