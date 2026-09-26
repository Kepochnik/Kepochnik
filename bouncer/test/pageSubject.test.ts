import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAINS } from "../src/chain/chains.js";
import { MULTI_CHAIN_HOSTS, pageSubject, tokenPageHosts } from "../src/bouncer/pageSubject.js";

const EVM = "0x532f27101965dd16442E59d40670FaF5eBB142E4";
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

/**
 * The bug: the popup kept its own two-case table and sent everything it did
 * not recognise to Robinhood Chain, so a Base token page produced a confident
 * verdict about whatever those twenty bytes are on a different chain.
 */
test("a token page resolves to the chain it is actually about", () => {
  for (const [url, chain] of [
    [`https://basescan.org/token/${EVM}`, "base"],
    [`https://www.basescan.org/token/${EVM}`, "base"],
    [`https://base.blockscout.com/address/${EVM}`, "base"],
    [`https://bscscan.com/token/${EVM}`, "bnb"],
    [`https://robinhoodchain.blockscout.com/token/${EVM}`, "robinhood"],
    [`https://testnet.arcscan.app/token/${EVM}`, "arc-testnet"],
    [`https://dexscreener.com/base/${EVM}`, "base"],
    [`https://dexscreener.com/bsc/${EVM}`, "bnb"],
    [`https://solscan.io/token/${MINT}`, "solana"],
    [`https://solana.fm/address/${MINT}`, "solana"],
    [`https://gmgn.ai/sol/token/${MINT}`, "solana"],
  ] as [string, string][]) {
    const got = pageSubject(url);
    assert.equal(got?.chain, chain, `${url} read as ${got?.chain ?? "nothing"}`);
    assert.ok(CHAINS[got!.chain], `${got!.chain} is not a chain the app knows`);
  }
});

test("an EVM address is lower-cased and a base58 mint is left alone", () => {
  assert.equal(pageSubject(`https://basescan.org/token/${EVM}`)?.address, EVM.toLowerCase());
  assert.equal(pageSubject(`https://solscan.io/token/${MINT}`)?.address, MINT);
});

/**
 * Null, not a guess. An address read on the wrong chain is a confident answer
 * about a different contract, which is the one outcome worse than no answer.
 */
test("no chain means no answer, even with an address in plain sight", () => {
  for (const url of [
    `https://example.com/token/${EVM}`,
    `https://etherscan.io/token/${EVM}`,
    `https://dexscreener.com/ethereum/${EVM}`,
    "https://basescan.org/blocks",
    "https://news.ycombinator.com/",
    "",
    "not a url",
    `chrome://extensions/?q=${EVM}`,
    `file:///tmp/${EVM}.html`,
  ]) {
    assert.equal(pageSubject(url), null, `${url} was answered anyway`);
  }
});

test("an address of the wrong shape for the chain is not answered", () => {
  // A Solana page carrying an EVM address is not a Solana mint, and a Base
  // page carrying a base58 string is not a Base token. Either answered on the
  // page's chain would be a read of an address that does not exist there.
  assert.equal(pageSubject(`https://solscan.io/token/${EVM}`), null);
  assert.equal(pageSubject(`https://basescan.org/token/${MINT}`), null);
});

test("a base58 run that is not in an address path is not a mint", () => {
  // Unanchored, a 32-to-44 character base58 run matches half the query
  // strings on the web — a session id, a tracking token, a cache buster.
  assert.equal(pageSubject(`https://solscan.io/?ref=${MINT}`), null);
  assert.equal(pageSubject(`https://solscan.io/tx/${MINT}`), null, "a transaction is not a token");
});

test("every host in the table names a chain the app can actually read", () => {
  const hosts = tokenPageHosts();
  assert.ok(Object.keys(hosts).length >= 6, "the table has lost entries");
  for (const [host, key] of Object.entries(hosts)) {
    assert.ok(CHAINS[key], `${host} maps to "${key}", which is not in the chain table`);
  }
  // A chain whose explorer is in the table must be reachable from it: that is
  // the whole point of deriving these from CHAINS rather than hand-keeping them.
  assert.equal(hosts["robinhoodchain.blockscout.com"], "robinhood");
  assert.ok(MULTI_CHAIN_HOSTS.includes("dexscreener.com"));
});
