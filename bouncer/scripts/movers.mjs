/**
 * Which tokens are actually moving on this chain right now.
 *
 * Testing the tool against one reference token per chain proves almost
 * nothing: USDC and CAKE are the best-behaved contracts on their chains, and
 * the slip is for the ones that are not. What is needed is real, arbitrary,
 * currently-traded tokens — and the honest way to get them is to ask the
 * chain, not to type addresses from memory. An address recalled wrong is
 * either a dead read or, worse, somebody else's contract.
 *
 * So: read the Transfer logs of the last few thousand blocks and count which
 * contracts emitted them. The ones at the top are what people are trading in
 * the last few minutes, which on Base or BNB means memecoins. Nothing is
 * assumed about any of them; they are addresses to point the tool at.
 *
 * Read-only, through the same allow-listed client the product uses.
 *
 *   node scripts/movers.mjs base 5
 */
import { RpcClient } from "../dist/src/chain/rpc.js";
import { CHAINS } from "../dist/src/chain/chains.js";
import { eventTopic } from "../dist/src/chain/abi.js";
import { ERC20_EVENTS } from "../dist/src/chain/pons.js";

const key = process.argv[2] ?? "base";
const want = Number(process.argv[3] ?? 5);
const chain = CHAINS[key];
if (!chain || chain.family !== "evm") {
  console.error(`movers: ${key} is not an EVM chain in the table`);
  process.exit(1);
}

const rpc = new RpcClient({ urls: chain.rpc, expectedChainId: chain.chainId });
const head = await rpc.getBlock("latest");
const transfer = eventTopic(ERC20_EVENTS.Transfer);

// About ten minutes of chain, in slices the endpoints accept. A wider window
// finds more tokens and costs more; ten minutes is enough to see what is busy
// and short enough that the answer is about now.
const span = Math.min(3_000, Math.max(200, Math.round(600 * chain.blocksPerSecond)));
const slice = Math.max(50, Math.round(span / 6));

const counts = new Map();
let read = 0;
for (let from = head.number - span; from <= head.number; from += slice) {
  const to = Math.min(from + slice - 1, head.number);
  try {
    const logs = await rpc.getLogs({ fromBlock: from, toBlock: to, topics: [transfer] });
    read++;
    for (const log of logs) {
      // Three topics is an ERC-20 Transfer; two is an ERC-721, whose "value"
      // is a token id. Counting those would rank NFT collections as movers.
      if (log.topics.length !== 3) continue;
      const address = log.address.toLowerCase();
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
  } catch {
    // A slice the endpoint refuses costs its own blocks, not the run.
  }
}

// The wrapped native coin is in every pool on the chain and is not a token
// anybody needs checked; the same goes for a token the chain config already
// calls out by name.
const skip = new Set([chain.dex?.weth?.toLowerCase(), ...Object.keys(chain.known ?? {})].filter(Boolean));
const ranked = [...counts.entries()]
  .filter(([address]) => !skip.has(address))
  .sort((a, b) => b[1] - a[1])
  .slice(0, want);

if (!ranked.length) {
  console.error(`movers: no ERC-20 transfers found on ${chain.name} in ${span} blocks (${read} log reads answered)`);
  process.exit(2);
}
for (const [address, transfers] of ranked) console.log(`${address} ${transfers}`);
