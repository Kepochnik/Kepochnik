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
let head;
try {
  head = await rpc.getBlock("latest");
} catch (error) {
  // A stack trace here would read as a defect in this script. It is the
  // endpoint refusing, which is a fact about the endpoint.
  console.error(`movers: no endpoint for ${chain.name} answered (${error instanceof Error ? error.message : error})`);
  process.exit(3);
}
const transfer = eventTopic(ERC20_EVENTS.Transfer);

// Single blocks, spread out — not a range.
//
// The first version asked for fifty-block slices, which on Base is a
// firehose: every ERC-20 transfer on the chain for a hundred seconds, tens of
// thousands of logs in one response, and a step that ran for twenty-five
// minutes without finishing. A busy chain makes an unfiltered range query by
// topic alone an enormous read.
//
// One block at a time is bounded by how busy one block is, and a dozen blocks
// spread over the last few minutes rank the movers just as well as a
// contiguous range would — better, arguably, since one burst cannot dominate.
const SAMPLES = 12;
const span = Math.max(SAMPLES, Math.round(300 * chain.blocksPerSecond));
const step = Math.max(1, Math.floor(span / SAMPLES));

const counts = new Map();
let read = 0;
for (let i = 0; i < SAMPLES; i++) {
  const at = head.number - i * step;
  if (at < 0) break;
  try {
    const logs = await rpc.getLogs({ fromBlock: at, toBlock: at, topics: [transfer] });
    read++;
    for (const log of logs) {
      // Three topics is an ERC-20 Transfer; two is an ERC-721, whose "value"
      // is a token id. Counting those would rank NFT collections as movers.
      if (log.topics.length !== 3) continue;
      const address = log.address.toLowerCase();
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
  } catch {
    // A block the endpoint refuses costs its own logs, not the run.
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
  console.error(`movers: no ERC-20 transfers found on ${chain.name} across ${SAMPLES} sampled blocks (${read} answered)`);
  process.exit(2);
}
for (const [address, transfers] of ranked) console.log(`${address} ${transfers}`);
