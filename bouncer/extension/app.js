"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // src/chain/keccak.ts
  function rotl64(value, shift) {
    if (shift === 0) return value;
    return (value << BigInt(shift) | value >> BigInt(64 - shift)) & MASK64;
  }
  function keccakF1600(state) {
    const c = new Array(5);
    const d = new Array(5);
    const b = new Array(25);
    for (let round = 0; round < 24; round++) {
      for (let x = 0; x < 5; x++) {
        c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      }
      for (let x = 0; x < 5; x++) {
        d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
      }
      for (let i = 0; i < 25; i++) {
        state[i] ^= d[i % 5];
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          const from = x + 5 * y;
          const to = y + 5 * ((2 * x + 3 * y) % 5);
          b[to] = rotl64(state[from], ROTATION[from]);
        }
      }
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
          const i = x + 5 * y;
          state[i] = b[i] ^ ~b[(x + 1) % 5 + 5 * y] & MASK64 & b[(x + 2) % 5 + 5 * y];
        }
      }
      state[0] ^= ROUND_CONSTANTS[round];
    }
  }
  function keccak256(input) {
    const message = typeof input === "string" ? new TextEncoder().encode(input) : input;
    const paddedLength = Math.ceil((message.length + 1) / RATE_BYTES) * RATE_BYTES;
    const padded = new Uint8Array(paddedLength);
    padded.set(message);
    padded[message.length] ^= 1;
    padded[paddedLength - 1] ^= 128;
    const state = new Array(25).fill(0n);
    for (let offset = 0; offset < paddedLength; offset += RATE_BYTES) {
      for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
        let word = 0n;
        for (let byte = 7; byte >= 0; byte--) {
          word = word << 8n | BigInt(padded[offset + lane * 8 + byte]);
        }
        state[lane] ^= word;
      }
      keccakF1600(state);
    }
    const out2 = new Uint8Array(32);
    for (let lane = 0; lane < 4; lane++) {
      let word = state[lane];
      for (let byte = 0; byte < 8; byte++) {
        out2[lane * 8 + byte] = Number(word & 0xffn);
        word >>= 8n;
      }
    }
    return out2;
  }
  function keccak256Hex(input) {
    return `0x${bytesToHex(keccak256(input))}`;
  }
  function bytesToHex(bytes) {
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
  }
  function hexToBytes(hex) {
    const clean2 = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (clean2.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
    const out2 = new Uint8Array(clean2.length / 2);
    for (let i = 0; i < out2.length; i++) {
      out2[i] = Number.parseInt(clean2.slice(i * 2, i * 2 + 2), 16);
    }
    return out2;
  }
  var MASK64, ROUND_CONSTANTS, ROTATION, RATE_BYTES;
  var init_keccak = __esm({
    "src/chain/keccak.ts"() {
      "use strict";
      MASK64 = (1n << 64n) - 1n;
      ROUND_CONSTANTS = [
        0x0000000000000001n,
        0x0000000000008082n,
        0x800000000000808an,
        0x8000000080008000n,
        0x000000000000808bn,
        0x0000000080000001n,
        0x8000000080008081n,
        0x8000000000008009n,
        0x000000000000008an,
        0x0000000000000088n,
        0x0000000080008009n,
        0x000000008000000an,
        0x000000008000808bn,
        0x800000000000008bn,
        0x8000000000008089n,
        0x8000000000008003n,
        0x8000000000008002n,
        0x8000000000000080n,
        0x000000000000800an,
        0x800000008000000an,
        0x8000000080008081n,
        0x8000000000008080n,
        0x0000000080000001n,
        0x8000000080008008n
      ];
      ROTATION = [
        0,
        1,
        62,
        28,
        27,
        36,
        44,
        6,
        55,
        20,
        3,
        10,
        43,
        25,
        39,
        41,
        45,
        15,
        21,
        8,
        18,
        2,
        61,
        56,
        14
      ];
      RATE_BYTES = 136;
    }
  });

  // src/chain/abi.ts
  function selector(signature) {
    return `0x${bytesToHex(keccak256(signature).slice(0, 4))}`;
  }
  function eventSignature(event) {
    return `${event.name}(${event.inputs.map((input) => input.type).join(",")})`;
  }
  function eventTopic(event) {
    return `0x${bytesToHex(keccak256(eventSignature(event)))}`;
  }
  function functionSignature(fn) {
    return `${fn.name}(${fn.inputs.join(",")})`;
  }
  function encodeWord(type, value) {
    if (type === "address") {
      const address = normalizeAddress(String(value));
      return address.slice(2).padStart(64, "0");
    }
    if (type === "bool") {
      return (value ? 1n : 0n).toString(16).padStart(64, "0");
    }
    if (type === "bytes32") {
      const hex = String(value).toLowerCase().replace(/^0x/, "");
      if (hex.length !== 64) throw new Error(`bytes32 expects 32 bytes, got ${hex.length / 2}`);
      return hex;
    }
    if (type.startsWith("uint")) {
      const big = toBigInt(value);
      if (big < 0n) throw new Error(`negative value for ${type}`);
      return big.toString(16).padStart(64, "0");
    }
    if (type.startsWith("int")) {
      const big = toBigInt(value);
      const twos = big < 0n ? (1n << 256n) + big : big;
      return twos.toString(16).padStart(64, "0");
    }
    throw new Error(`unsupported static type ${type}`);
  }
  function encodeCall(fn, args) {
    if (args.length !== fn.inputs.length) {
      throw new Error(`${fn.name} expects ${fn.inputs.length} args, got ${args.length}`);
    }
    const words = fn.inputs.map((type, index) => encodeWord(type, args[index]));
    return `${selector(functionSignature(fn))}${words.join("")}`;
  }
  function decodeWord(type, word) {
    if (word.length !== 64) throw new Error(`expected a 32-byte word, got ${word.length / 2} bytes`);
    if (type === "address") return `0x${word.slice(24)}`.toLowerCase();
    if (type === "bool") return BigInt(`0x${word}`) !== 0n;
    if (type === "bytes32") return `0x${word}`;
    if (type.startsWith("uint")) return BigInt(`0x${word}`);
    if (type.startsWith("int")) {
      const raw = BigInt(`0x${word}`);
      return raw >= 1n << 255n ? raw - (1n << 256n) : raw;
    }
    throw new Error(`unsupported static type ${type}`);
  }
  function decodeOutputs(fn, data) {
    const hex = data.slice(2);
    if (hex.length === 0) throw new Error(`${fn.name}: empty return data`);
    const words = hex.match(/.{64}/g) ?? [];
    const values = [];
    for (let i = 0; i < fn.outputs.length; i++) {
      const type = fn.outputs[i];
      const word = words[i];
      if (word === void 0) throw new Error(`${fn.name}: return data too short`);
      if (type === "string") {
        const offset = Number(BigInt(`0x${word}`)) * 2;
        const length = Number(BigInt(`0x${hex.slice(offset, offset + 64)}`));
        const bytes = hexToBytes(hex.slice(offset + 64, offset + 64 + length * 2));
        values.push(new TextDecoder().decode(bytes));
      } else {
        values.push(decodeWord(type, word));
      }
    }
    return values;
  }
  function decodeLog(event, log) {
    const expectedTopic = eventTopic(event);
    if ((log.topics[0] ?? "").toLowerCase() !== expectedTopic) {
      throw new Error(`log topic does not match ${event.name}`);
    }
    const args = {};
    let topicIndex = 1;
    const dataWords = log.data.slice(2).match(/.{64}/g) ?? [];
    let dataIndex = 0;
    for (const input of event.inputs) {
      if (input.indexed) {
        const topic = log.topics[topicIndex++];
        if (!topic) throw new Error(`${event.name}: missing indexed topic ${input.name}`);
        args[input.name] = decodeWord(input.type, topic.slice(2));
      } else {
        const word = dataWords[dataIndex++];
        if (!word) throw new Error(`${event.name}: missing data word ${input.name}`);
        args[input.name] = decodeWord(input.type, word);
      }
    }
    return {
      name: event.name,
      address: log.address.toLowerCase(),
      blockNumber: Number(BigInt(log.blockNumber)),
      transactionHash: log.transactionHash,
      logIndex: Number(BigInt(log.logIndex)),
      args
    };
  }
  function isAddress(value) {
    return /^0x[0-9a-fA-F]{40}$/.test(value);
  }
  function normalizeAddress(value) {
    if (!isAddress(value)) throw new Error(`not an EVM address: ${value}`);
    return value.toLowerCase();
  }
  function toBigInt(value) {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      if (!Number.isInteger(value)) throw new Error(`non-integer number ${value}`);
      return BigInt(value);
    }
    if (typeof value === "string") return BigInt(value);
    throw new Error(`cannot convert ${typeof value} to bigint`);
  }
  var init_abi = __esm({
    "src/chain/abi.ts"() {
      "use strict";
      init_keccak();
    }
  });

  // src/chain/tape.ts
  var tape_exports = {};
  __export(tape_exports, {
    BLOCKS_PER_SECOND_ESTIMATE: () => BLOCKS_PER_SECOND_ESTIMATE,
    addressTopic: () => addressTopic,
    estimateBlocksAgo: () => estimateBlocksAgo,
    findBlockByTimestamp: () => findBlockByTimestamp,
    readTape: () => readTape,
    readTapeAdaptive: () => readTapeAdaptive
  });
  async function readTape(rpc, request) {
    const byTopic = /* @__PURE__ */ new Map();
    for (const event of request.events) byTopic.set(eventTopic(event), event);
    const topic0 = [...byTopic.keys()];
    const chunkSize = request.chunkSize ?? 2e3;
    const filterTopics = [topic0.length === 1 ? topic0[0] : topic0, ...request.topics ?? []];
    const logs = [];
    let chunks = 0;
    for (let from = request.fromBlock; from <= request.toBlock; from += chunkSize) {
      const to = Math.min(from + chunkSize - 1, request.toBlock);
      const raw = await rpc.getLogs({ address: request.address, topics: filterTopics, fromBlock: from, toBlock: to });
      chunks++;
      for (const log of raw) logs.push(decodeRaw(byTopic, log));
    }
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return { logs, fromBlock: request.fromBlock, toBlock: request.toBlock, chunks };
  }
  function decodeRaw(byTopic, log) {
    const event = byTopic.get((log.topics[0] ?? "").toLowerCase());
    if (!event) throw new Error(`tape received a log with an unexpected topic ${log.topics[0]}`);
    return decodeLog(event, log);
  }
  async function readTapeAdaptive(rpc, request, chunking = {}) {
    const byTopic = /* @__PURE__ */ new Map();
    for (const event of request.events) byTopic.set(eventTopic(event), event);
    const topic0 = [...byTopic.keys()];
    const filterTopics = [topic0.length === 1 ? topic0[0] : topic0, ...request.topics ?? []];
    const minChunk = chunking.minChunk ?? 1e3;
    const maxChunk = chunking.maxChunk ?? 2e5;
    const ceiling = rpc.logSpanCeiling?.() ?? null;
    let chunk = Math.min(maxChunk, ceiling ?? Infinity, Math.max(minChunk, chunking.startChunk ?? 5e4));
    chunk = Math.max(minChunk, chunk);
    const maxRequests = chunking.maxRequests ?? Infinity;
    const deadline = chunking.budgetMs === void 0 ? Infinity : Date.now() + chunking.budgetMs;
    const logs = [];
    let chunks = 0;
    let requests = 0;
    const lanes = Math.max(1, chunking.lanes ?? 6);
    let from = request.fromBlock;
    let complete = true;
    let proven = false;
    while (from <= request.toBlock) {
      if (Date.now() >= deadline) {
        complete = false;
        break;
      }
      if (requests >= maxRequests) {
        complete = false;
        break;
      }
      const remaining = request.toBlock - from + 1;
      const width = proven ? Math.min(lanes, Math.ceil(remaining / chunk), Math.max(1, maxRequests - requests)) : 1;
      const spans = [];
      for (let i = 0; i < width; i++) {
        const start = from + i * chunk;
        if (start > request.toBlock) break;
        spans.push({ fromBlock: start, toBlock: Math.min(start + chunk - 1, request.toBlock) });
      }
      requests += spans.length;
      const answers = await Promise.all(
        spans.map(
          (span) => rpc.getLogs({ address: request.address, topics: filterTopics, fromBlock: span.fromBlock, toBlock: span.toBlock }).then((raw) => ({ ok: true, raw })).catch((error) => ({ ok: false, error }))
        )
      );
      let advanced = 0;
      for (const answer of answers) {
        if (!answer.ok) break;
        chunks++;
        for (const log of answer.raw) logs.push(decodeRaw(byTopic, log));
        advanced++;
      }
      if (advanced) {
        from = spans[advanced - 1].toBlock + 1;
        proven = true;
        chunk = Math.min(maxChunk, chunk * 2);
        if (advanced === answers.length) continue;
      }
      const failure = answers[advanced];
      if (chunk <= minChunk) {
        if (!chunks) throw failure.ok ? new Error("log walk made no progress") : failure.error;
        complete = false;
        break;
      }
      chunk = Math.max(minChunk, Math.floor(chunk / 8));
      proven = false;
    }
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return { logs, fromBlock: request.fromBlock, toBlock: complete ? request.toBlock : Math.max(request.fromBlock, from - 1), chunks, complete };
  }
  function addressTopic(address) {
    return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  }
  function estimateBlocksAgo(seconds) {
    return Math.max(1, Math.round(seconds * BLOCKS_PER_SECOND_ESTIMATE));
  }
  async function findBlockByTimestamp(rpc, targetTimestamp, latest) {
    let high = latest ?? await rpc.blockNumber();
    let low = 0;
    const latestHeader = await rpc.getBlock(high);
    if (latestHeader.timestamp <= targetTimestamp) return high;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const header = await rpc.getBlock(mid);
      if (header.timestamp < targetTimestamp) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  var BLOCKS_PER_SECOND_ESTIMATE;
  var init_tape = __esm({
    "src/chain/tape.ts"() {
      "use strict";
      init_abi();
      BLOCKS_PER_SECOND_ESTIMATE = 10;
    }
  });

  // src/chain/blockscout.ts
  var BlockscoutError = class extends Error {
    constructor(status2, path) {
      super(`blockscout ${status2} for ${path}`);
      this.status = status2;
      this.path = path;
      this.name = "BlockscoutError";
    }
    /** True when the explorer answered, and its answer was "I do not have this". */
    get notIndexed() {
      return this.status === 404;
    }
  };
  var BlockscoutClient = class _BlockscoutClient {
    baseUrl;
    fetchImpl;
    timeoutMs;
    /**
     * Reads already in flight or already answered, for the life of this
     * client. See `memo` below.
     *
     * The promise, not the value. Two callers asking for the same path before
     * either answer arrives is the ordinary case here — the page starts these
     * reads the moment an address is pasted and the pass that needs them
     * begins a second later — and a memo of values would let both requests
     * go out, which is the thing it exists to prevent.
     *
     * Failures are kept too: a path that just timed out will time out again,
     * and paying six seconds for that twice is the worst version of this.
     */
    memo;
    constructor(options) {
      this.baseUrl = options.baseUrl.replace(/\/$/, "");
      this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
      this.timeoutMs = options.timeoutMs ?? 6e3;
      this.memo = options.memo ? /* @__PURE__ */ new Map() : null;
    }
    /** Browsers drop the user-agent header silently; Node and workers send it, which keeps bot challenges away. */
    static USER_AGENT = "Mozilla/5.0 (compatible; bouncer/0.3; +https://github.com/Kepochnik/bouncer)";
    /**
     * Calls and milliseconds per endpoint, the same way the RPC clients count.
     *
     * Added after a profile that did not add up: a door's fast half took 8.7
     * seconds and every RPC call in it summed to 4.6. The missing 4.1 seconds
     * were here and invisible, which is the same blind spot that cost an
     * afternoon of wrong guesses on the Solana side. A client this slip waits
     * on has to be countable.
     */
    counters = /* @__PURE__ */ new Map();
    /**
     * How old the stalest answer this client was given is, in seconds.
     *
     * Zero for a direct read, and for a proxied one that missed the cache.
     * The slip reports it when it is not zero rather than presenting a cached
     * reading as a live one.
     */
    oldestSeconds = 0;
    /** How many reads the memo answered without asking the explorer. */
    memoHits = 0;
    stats() {
      return [...this.counters.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.ms - a.ms);
    }
    record(path, ms, failed2) {
      const key = path.replace(/0x[0-9a-fA-F]{40,}/g, "{address}").replace(/\?.*$/, "").replace(/\/[1-9A-HJ-NP-Za-km-z]{32,44}(?=\/|$)/g, "/{mint}");
      const entry = this.counters.get(key) ?? { calls: 0, ms: 0, failures: 0 };
      entry.calls += 1;
      entry.ms += ms;
      if (failed2) entry.failures += 1;
      this.counters.set(key, entry);
    }
    async get(path) {
      const remembered = this.memo?.get(path);
      if (remembered) {
        this.memoHits++;
        return remembered;
      }
      if (this.memo) {
        const started = this.fetchOnce(path);
        this.memo.set(path, started);
        return started;
      }
      return this.fetchOnce(path);
    }
    /**
     * Warms the memo without waiting for it.
     *
     * The explorer is the slowest thing in a door read — measured on
     * Robinhood Chain, one /addresses call is about three seconds against a
     * chain answering every request in under two hundred milliseconds — and
     * the pass that needs it does not start until the chain-only render is on
     * screen. Started here, it runs under that render instead of after it.
     * Nothing waits on these; whoever asks for the path later gets this
     * request, finished or still in flight.
     */
    /** The four reads a door opens with, for prewarm(). Kept here so the paths have one home. */
    static doorPaths(token) {
      return [`/api/v2/addresses/${token}`, `/api/v2/tokens/${token}/holders`, `/api/v2/tokens/${token}`, `/api/v2/tokens/${token}/transfers`];
    }
    prewarm(paths) {
      if (!this.memo) return;
      for (const path of paths) {
        if (this.memo.has(path)) continue;
        const started = this.fetchOnce(path);
        started.catch(() => {
        });
        this.memo.set(path, started);
      }
    }
    async fetchOnce(path) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const startedAt = Date.now();
      try {
        const headers = { accept: "application/json" };
        if (typeof globalThis.window === "undefined") headers["user-agent"] = _BlockscoutClient.USER_AGENT;
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "GET", headers, signal: controller.signal });
        if (!response.ok) throw new BlockscoutError(response.status, path);
        const body = await response.json();
        this.record(path, Date.now() - startedAt, false);
        const age = Number(response.headers?.get?.("x-bouncer-age") ?? 0);
        if (Number.isFinite(age) && age > this.oldestSeconds) this.oldestSeconds = age;
        return body;
      } catch (error) {
        this.record(path, Date.now() - startedAt, true);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    /**
     * Earliest incoming native transfer to `address` before `beforeBlock`,
     * walking at most `maxPages` pages of the address's transactions (newest
     * first). Fresh wallets have a handful of transactions, which is the case
     * that matters: a wallet funded once, minutes before a launch.
     */
    async fundingSource(address, beforeBlock, maxPages = 3) {
      let path = `/api/v2/addresses/${address}/transactions?filter=to`;
      let best = null;
      for (let page = 0; page < maxPages; page++) {
        const body = await this.get(path);
        for (const tx of body.items ?? []) {
          const value = BigInt(tx.value ?? "0");
          const block = Number(tx.block_number ?? tx.block ?? 0);
          const to = (tx.to?.hash ?? "").toLowerCase();
          if (to !== address.toLowerCase() || value === 0n || block === 0 || block >= beforeBlock) continue;
          if (!best || block < best.block) best = { from: (tx.from?.hash ?? "").toLowerCase(), value, block, hash: tx.hash };
        }
        if (!body.next_page_params) break;
        const query = new URLSearchParams(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)]));
        path = `/api/v2/addresses/${address}/transactions?filter=to&${query.toString()}`;
      }
      return best;
    }
    /** Tokens whose name or symbol matches `query`, as Blockscout indexes them. */
    async searchTokens(query) {
      const body = await this.get(`/api/v2/search?q=${encodeURIComponent(query)}`);
      return (body.items ?? []).filter((i) => i.type === "token" && (i.address || i.address_hash)).map((i) => ({ address: String(i.address ?? i.address_hash).toLowerCase(), name: i.name ?? "", symbol: i.symbol ?? "" }));
    }
    /** Largest holders first, as the explorer ranks them; `limit` caps the count, one page is 50. */
    async tokenHolders(token, limit = 50) {
      const body = await this.get(`/api/v2/tokens/${token}/holders`);
      return (body.items ?? []).slice(0, limit).map((h) => ({
        address: (h.address?.hash ?? "").toLowerCase(),
        value: BigInt(h.value ?? "0"),
        isContract: Boolean(h.address?.is_contract),
        delegated: (h.address?.proxy_type ?? "").toLowerCase() === "eip7702",
        name: h.address?.name ?? h.address?.metadata?.tags?.[0]?.name ?? null
      }));
    }
    /** Holder and transfer counts for a token; nulls when the explorer has not counted yet. */
    async tokenInfo(token) {
      const info = await this.get(`/api/v2/tokens/${token}`);
      let transfers = null;
      let holders = numberOrNull(info.holders_count ?? info.holders);
      try {
        const counters = await this.get(`/api/v2/tokens/${token}/counters`);
        transfers = numberOrNull(counters.transfers_count);
        holders = holders ?? numberOrNull(counters.token_holders_count);
      } catch {
      }
      return { holders, transfers, type: info.type ?? null, priceUsd: numberOrNull(info.exchange_rate ?? void 0), volume24hUsd: numberOrNull(info.volume_24h ?? void 0), marketCapUsd: numberOrNull(info.circulating_market_cap ?? void 0) };
    }
    /** What the explorer knows about an address: contract or not, verified, who created it. */
    async addressInfo(address) {
      const body = await this.get(`/api/v2/addresses/${address}`);
      return {
        isContract: Boolean(body.is_contract),
        isVerified: Boolean(body.is_verified),
        isScam: Boolean(body.is_scam),
        name: body.name ?? null,
        creator: body.creator_address_hash ? body.creator_address_hash.toLowerCase() : null,
        creationTx: body.creation_transaction_hash ?? body.creation_tx_hash ?? null
      };
    }
    /** The newest token transfers the explorer indexed, newest first (one page). */
    async tokenTransfers(token) {
      const body = await this.get(`/api/v2/tokens/${token}/transfers`);
      return (body.items ?? []).map((t) => ({
        from: (t.from?.hash ?? "").toLowerCase(),
        to: (t.to?.hash ?? "").toLowerCase(),
        value: BigInt(t.total?.value ?? "0"),
        block: Number(t.block_number ?? 0),
        timestamp: t.timestamp ? Math.floor(Date.parse(t.timestamp) / 1e3) : null,
        hash: t.transaction_hash ?? t.tx_hash ?? ""
      }));
    }
    /** Whether the explorer holds verified source for the address. */
    async isVerified(address) {
      try {
        const body = await this.get(`/api/v2/smart-contracts/${address}`);
        return Boolean(body.is_verified ?? body.is_fully_verified);
      } catch (error) {
        if (error instanceof Error && /\b404\b/.test(error.message)) return false;
        return null;
      }
    }
  };
  function numberOrNull(value) {
    if (value === void 0 || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // src/bouncer/topics.ts
  var TOPIC_ORDER = ["id", "keep", "sell", "exit", "room", "unread"];
  var TOPIC_QUESTION = {
    id: "Is this the token you meant?",
    keep: "Can they take it from you?",
    sell: "Can you sell it right now?",
    exit: "What would you actually get out?",
    room: "Who is already inside?",
    unread: "What BOUNCER could not read"
  };
  var TOPIC_BLURB = {
    id: "Whether the address is the contract behind the ticker, or something wearing its name.",
    keep: "Powers in the code and hands on the liquidity: who can still change the rules or walk off with the pool.",
    sell: "Whether a transfer goes through at all today, and what it costs when it does.",
    exit: "Where it trades and what a sale of your size would really pay, at this block.",
    room: "Who holds the supply, who launched it, and whether the early buyers knew each other.",
    unread: "Reads that did not answer. A gap here is not a clean result; it is a question still open."
  };
  var TOPIC_OF = {
    // ---- is this the token you meant
    "claimed-factory": "id",
    "curve-input": "id",
    deployed: "id",
    "known-address": "id",
    "launch-older": "id",
    "lookalike-impostor": "id",
    "lookalike-later": "id",
    "lookalike-shared-ticker": "id",
    lookalikes: "id",
    "no-account": "id",
    "not-a-mint": "id",
    "not-erc20": "id",
    "not-a-token": "id",
    "meta-unread": "id",
    "not-registered": "id",
    spl: "id",
    "v1-launch": "id",
    graduated: "id",
    "v1-not-graduated": "id",
    "swept-no-pool": "id",
    // ---- can they take it from you
    burned: "keep",
    "buyback-vests": "keep",
    code: "keep",
    "fee-recipient-moved": "keep",
    "freeze-authority": "keep",
    "liquidity-free": "keep",
    "liquidity-held": "keep",
    "liquidity-partial": "keep",
    "liquidity-partly-free": "keep",
    "metadata-frozen": "keep",
    "metadata-mutable": "keep",
    "mint-authority": "keep",
    "mint-close": "keep",
    "no-freeze": "keep",
    "no-mint": "keep",
    "no-powers": "keep",
    "permanent-delegate": "keep",
    powers: "keep",
    "sol-liquidity-free": "keep",
    "sol-liquidity-held": "keep",
    "sol-liquidity-partly-free": "keep",
    "terms-retuned": "keep",
    // ---- can you sell it right now
    "cover-closed": "sell",
    "cover-open": "sell",
    "frozen-by-default": "sell",
    "high-tax": "sell",
    "interest-bearing": "sell",
    "non-transferable": "sell",
    pausable: "sell",
    paused: "sell",
    "trading-closed": "sell",
    "transfer-fee": "sell",
    "transfer-hook": "sell",
    "v1-caps": "sell",
    "v4-hook": "sell",
    "extension-unknown": "sell",
    // ---- what would you actually get out
    active: "exit",
    concentrated: "exit",
    "exit-closed": "exit",
    "exit-thin": "exit",
    "graduated-no-pool": "exit",
    "no-pool": "exit",
    "no-venue": "exit",
    "on-the-curve": "exit",
    pools: "exit",
    "pools-empty": "exit",
    price: "exit",
    quiet: "exit",
    "sale-price": "exit",
    "venue-unidentified": "exit",
    "venues-read": "exit",
    // ---- who is already inside
    "bundled-blocks": "room",
    "crew-clean": "room",
    "crew-creator": "room",
    "deployer-holds": "room",
    "dev-first": "room",
    "dev-funded": "room",
    "dev-graduated": "room",
    "dev-holds": "room",
    "dev-repeat": "room",
    "dev-serial": "room",
    "delegated-wallet": "room",
    "in-contracts": "room",
    "no-holders": "room",
    "one-crew": "room",
    "owner-holds": "room",
    "room-wide": "room",
    spread: "room",
    // ---- what could not be read
    "explorer-scam": "unread",
    "explorer-unread": "unread",
    "too-new": "id",
    // A cached reading is not a missing one, but it belongs in the same strip:
    // this is where the page says how sure it is of what it just told you.
    "explorer-age": "unread",
    "liquidity-unread": "unread",
    "no-metadata": "unread",
    "no-probe": "unread",
    "shares-unknown": "unread",
    skipped: "unread",
    "sol-liquidity-unread": "unread",
    "surface-unreadable": "unread",
    unverified: "unread"
  };
  function topicOf(code) {
    return TOPIC_OF[code] ?? "unread";
  }

  // src/bouncer/trade.ts
  var REFERRAL = { gmgn: "save", basedbot: "bot" };
  var VENUE_NAMES = { gmgn: "GMGN", basedbot: "BasedBot" };
  var TRADE_SLUGS = {
    robinhood: { gmgn: "robinhood", basedbot: "robinhood" },
    // both from real URLs
    base: { gmgn: "base" },
    // unverified
    bnb: { gmgn: "bsc" },
    // unverified
    solana: { gmgn: "sol" }
    // unverified
  };
  function tradeVenues(chainKey, address) {
    const slugs = TRADE_SLUGS[chainKey];
    if (!slugs || !address) return [];
    const out2 = [];
    if (slugs.gmgn) {
      out2.push({
        key: "gmgn",
        name: "GMGN",
        what: "chart, holders and a one-click swap",
        url: `https://gmgn.ai/${slugs.gmgn}/token/${REFERRAL.gmgn}_${address}`
      });
    }
    if (slugs.basedbot) {
      out2.push({
        key: "basedbot",
        name: "BasedBot",
        what: "buy from Telegram, no browser wallet",
        url: `https://basedbot.app/r/${REFERRAL.basedbot}/token/${slugs.basedbot}/${address}`
      });
    }
    return out2;
  }
  function missingVenues(chainKey) {
    const slugs = TRADE_SLUGS[chainKey];
    if (!slugs) return [];
    return Object.keys(VENUE_NAMES).filter((v) => !slugs[v]).map((v) => VENUE_NAMES[v]);
  }

  // src/chain/chains.ts
  var PUBLIC_PROXY = "https://bouncer-proxy.tarasenkosanja12.workers.dev";
  var CHAINS = {
    robinhood: {
      key: "robinhood",
      name: "Robinhood Chain",
      family: "evm",
      chainId: 4663,
      // Robinhood Chain publishes one endpoint, so a 403 from it used to stop
      // every read on the chain outright — which happened during a live run
      // today. The proxy is a different address in front of the same node, so it
      // survives a per-caller limit even though it cannot survive the node
      // itself going down. That is the honest half of a fix, and it is better
      // than the nothing that was here.
      rpc: ["https://rpc.mainnet.chain.robinhood.com", `${PUBLIC_PROXY}/rpc/robinhood`],
      blockscout: "https://robinhoodchain.blockscout.com",
      factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e".toLowerCase(),
      factoryV1: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB".toLowerCase(),
      olderFactoriesV1: ["0x0c37a24F5D23A486FA692d1500881d698B1F77a4".toLowerCase()],
      launchpad: "Pons V2",
      native: { symbol: "ETH", decimals: 18 },
      blocksPerSecond: 10,
      known: {
        "0x39dbed3a2bd333467115de45665cc57f813c4571": "$PONS, the launchpad's own platform token: a fixed-supply PonsLauncherToken paired into a Uniswap V3 pool at launch. The V2 curve, door tax and creator tax do not apply to it.",
        "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e": "the Pons V2 launch factory itself, not a token.",
        "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb": "the Pons V1 launch factory itself, not a token."
      },
      dex: {
        weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73".toLowerCase(),
        wethSymbol: "WETH",
        v3Factories: [{ name: "Uniswap V3", address: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA".toLowerCase() }],
        v3PositionManager: "0x943e6b11d6a2a0dD87eC5E23Cf58A63A8D9Ec2B7".toLowerCase(),
        // The launchpad graduates into V4 and its factory names the singleton, so
        // the address is read from the chain rather than recalled.
        v4PoolManager: "from-launchpad"
      }
    },
    base: {
      key: "base",
      name: "Base",
      family: "evm",
      chainId: 8453,
      rpc: ["https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://mainnet.base.org", "https://base.drpc.org"],
      blockscout: "https://base.blockscout.com",
      factory: null,
      launchpad: null,
      native: { symbol: "ETH", decimals: 18 },
      blocksPerSecond: 0.5,
      notes: "No launchpad BOUNCER knows runs here, so every address is checked as an ordinary token: who can change its rules, whether a holder can sell right now, who holds it, where it trades.",
      dex: {
        weth: "0x4200000000000000000000000000000000000006",
        wethSymbol: "WETH",
        v3Factories: [{ name: "Uniswap V3", address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD".toLowerCase() }],
        v2Factories: [{ name: "Uniswap V2", address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6".toLowerCase() }],
        solidlyFactories: [{ name: "Aerodrome", address: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da".toLowerCase() }],
        v3PositionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1".toLowerCase()
      }
    },
    bnb: {
      key: "bnb",
      name: "BNB Chain",
      family: "evm",
      chainId: 56,
      rpc: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.defibit.io", "https://binance.llamarpc.com"],
      blockscout: null,
      explorerUrl: "https://bscscan.com",
      factory: null,
      launchpad: null,
      native: { symbol: "BNB", decimals: 18 },
      blocksPerSecond: 1.33,
      notes: "No launchpad BOUNCER knows runs here, and BNB Chain has no public Blockscout, so holders, the deployer and the price feed are not read. Everything the chain itself answers still is: the code's switches, the owner, whether a holder can sell into the pool, and the pools themselves.",
      dex: {
        weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c".toLowerCase(),
        wethSymbol: "WBNB",
        v3Factories: [
          { name: "PancakeSwap V3", address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865".toLowerCase(), feeTiers: [100, 500, 2500, 1e4] },
          { name: "Uniswap V3", address: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7".toLowerCase() }
        ],
        v2Factories: [{ name: "PancakeSwap V2", address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73".toLowerCase() }],
        v3PositionManager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364".toLowerCase()
      }
    },
    solana: {
      key: "solana",
      name: "Solana",
      family: "solana",
      chainId: 0,
      // Measured, not assumed. A probe asked eight public endpoints for the
      // three methods this reader depends on:
      //   api.mainnet-beta      getTokenAccountsByOwner 96ms, getMultipleAccounts
      //                         58ms, getTokenLargestAccounts throttled (429)
      //   solana-rpc.publicnode getMultipleAccounts 75ms, the other two blocked
      // Everything else — drpc, ankr, public-rpc, omniatech, onfinality,
      // blockeden — refused all three: paid plan, no key, or down. drpc was in
      // this list and served nothing, so it was three wasted failover attempts
      // on every call.
      rpc: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
      blockscout: null,
      explorerUrl: "https://solscan.io",
      factory: null,
      launchpad: null,
      native: { symbol: "SOL", decimals: 9 },
      blocksPerSecond: 2.5,
      notes: "Read as SPL: the mint account says outright whether anyone can print more tokens or freeze yours, and Token-2022 extensions say whether a transfer costs a fee, runs someone's code, or can be reversed by a permanent delegate. Where it trades is read too: the pump.fun bonding curve exactly, and Raydium, Orca, Meteora and pump.fun AMM pools against SOL or USDC. A ranged pool is shown but not priced, because its vault balances are not what a trade moves through."
    },
    "arc-testnet": {
      key: "arc-testnet",
      name: "Arc Testnet",
      family: "evm",
      chainId: 5042002,
      rpc: ["https://rpc.testnet.arc.network", "https://rpc.testnet.arc.io"],
      blockscout: "https://testnet.arcscan.app",
      factory: "0x90022cC2107De9c070F889E3A67009FcA270E4E2".toLowerCase(),
      launchpad: "Radian (Pons V2 port)",
      native: { symbol: "USDC", decimals: 18 },
      blocksPerSecond: 1,
      notes: "Native USDC is the gas and quote asset, counted in 18-decimal native units on chain (the ERC-20 view shows 6)."
    },
    arc: {
      key: "arc",
      name: "Arc",
      family: "evm",
      chainId: 5042,
      rpc: ["https://rpc.arc-scan.org"],
      blockscout: null,
      factory: null,
      launchpad: "Radian (Pons V2 port)",
      native: { symbol: "USDC", decimals: 18 },
      blocksPerSecond: 1,
      notes: "The Radian mainnet factory is not published yet: pass --factory 0x\u2026 (CLI) or set it in the site's live settings once it is. Every check that needs no factory runs regardless."
    }
  };
  var DEFAULT_CHAIN = CHAINS.robinhood;
  var DEFAULT_V3_FEE_TIERS = [100, 500, 3e3, 1e4];
  function chainByKey(key) {
    if (!key) return DEFAULT_CHAIN;
    const found = CHAINS[key.toLowerCase()];
    if (!found) throw new Error(`unknown chain ${key}; known: ${Object.keys(CHAINS).join(", ")}`);
    return found;
  }

  // src/chain/pons.ts
  var ROBINHOOD_CHAIN_ID = 4663;
  var PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e".toLowerCase();
  var ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  var PONS_V1_FACTORY = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB".toLowerCase();
  var PHASE_LABEL = {
    [0 /* NotGraduated */]: "curve",
    [1 /* Swept */]: "swept",
    [2 /* PoolCreated */]: "pool",
    [3 /* Rescued */]: "rescued"
  };
  var FACTORY_EVENTS = {
    TokenLaunched: {
      name: "TokenLaunched",
      inputs: [
        { name: "token", type: "address", indexed: true },
        { name: "curve", type: "address", indexed: true },
        { name: "deployer", type: "address", indexed: true },
        { name: "pairToken", type: "address", indexed: false },
        { name: "launchConfigId", type: "uint256", indexed: false },
        { name: "graduationThreshold", type: "uint256", indexed: false }
      ]
    },
    LaunchSwept: {
      name: "LaunchSwept",
      inputs: [
        { name: "token", type: "address", indexed: true },
        { name: "quoteOut", type: "uint256", indexed: false },
        { name: "tokenOut", type: "uint256", indexed: false }
      ]
    },
    PoolGraduated: {
      name: "PoolGraduated",
      inputs: [
        { name: "token", type: "address", indexed: true },
        { name: "positionId", type: "uint256", indexed: false },
        { name: "tokenAmount", type: "uint256", indexed: false },
        { name: "pairTokenAmount", type: "uint256", indexed: false }
      ]
    },
    /** Older factory deployments emitted this shape; both are read. */
    PoolGraduatedLegacy: {
      name: "PoolGraduated",
      inputs: [
        { name: "token", type: "address", indexed: true },
        { name: "poolId", type: "bytes32", indexed: false }
      ]
    },
    CreatorFeeRecipientUpdated: {
      name: "CreatorFeeRecipientUpdated",
      inputs: [
        { name: "token", type: "address", indexed: true },
        { name: "previousRecipient", type: "address", indexed: true },
        { name: "newRecipient", type: "address", indexed: true }
      ]
    },
    SnipeTaxStartBpsUpdated: {
      name: "SnipeTaxStartBpsUpdated",
      inputs: [{ name: "bps", type: "uint256", indexed: false }]
    },
    SnipeTaxSecondsUpdated: {
      name: "SnipeTaxSecondsUpdated",
      inputs: [{ name: "secondsWindow", type: "uint256", indexed: false }]
    },
    BuybackEnabledUpdated: {
      name: "BuybackEnabledUpdated",
      inputs: [
        { name: "token", type: "address", indexed: true },
        { name: "enabled", type: "bool", indexed: false },
        { name: "controller", type: "address", indexed: true }
      ]
    }
  };
  var FACTORY_FUNCTIONS = {
    getLaunchedToken: {
      name: "getLaunchedToken",
      inputs: ["address"],
      outputs: [
        "address",
        // token
        "address",
        // curve
        "address",
        // deployer
        "address",
        // creatorFeeRecipient
        "address",
        // pairToken
        "uint256",
        // graduationThreshold
        "uint24",
        // poolFee
        "int24",
        // tickSpacing
        "uint16",
        // creatorTaxBps
        "bool",
        // buybackEnabled
        "uint8",
        // phase
        "uint256",
        // sweptQuote
        "uint256",
        // sweptTokens
        "uint256",
        // sweptAt
        "bool"
        // exists
      ]
    },
    snipeTaxStartBps: { name: "snipeTaxStartBps", inputs: [], outputs: ["uint256"] },
    snipeTaxSeconds: { name: "snipeTaxSeconds", inputs: [], outputs: ["uint256"] },
    maxCreatorTaxBps: { name: "maxCreatorTaxBps", inputs: [], outputs: ["uint256"] },
    poolManager: { name: "poolManager", inputs: [], outputs: ["address"] },
    memeHook: { name: "memeHook", inputs: [], outputs: ["address"] },
    launchFee: { name: "launchFee", inputs: [], outputs: ["uint256"] },
    launchConfigCount: { name: "launchConfigCount", inputs: [], outputs: ["uint256"] },
    /** LaunchConfig struct: supply, curveFeeBps, phantomQuote, graduationThreshold, poolFee, tickSpacing, enabled. */
    getLaunchConfig: { name: "getLaunchConfig", inputs: ["uint256"], outputs: ["uint256", "uint256", "uint256", "uint256", "uint24", "int24", "bool"] },
    /** PairTokenEconomics struct: phantomQuote, graduationThreshold, decimals. */
    pairTokenEconomics: { name: "pairTokenEconomics", inputs: ["address"], outputs: ["uint256", "uint256", "uint8"] }
  };
  var V1_FACTORY_FUNCTIONS = {
    getLaunchedToken: {
      name: "getLaunchedToken",
      inputs: ["address"],
      outputs: ["address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "bool", "uint24", "bool", "uint256"]
    },
    /** pairedPrincipal, threshold, graduated */
    graduationStatus: { name: "graduationStatus", inputs: ["address"], outputs: ["uint256", "uint256", "bool"] },
    /** pairToken, graduationThreshold, initialTick, supply, maxWalletBps, maxTxBps, restrictionBlocks, reservedFee, enabled, routerRequiresDeadline */
    getLaunchConfig: { name: "getLaunchConfig", inputs: ["uint256"], outputs: ["address", "uint256", "int24", "uint256", "uint16", "uint16", "uint32", "uint24", "bool", "bool"] },
    locker: { name: "locker", inputs: [], outputs: ["address"] }
  };
  function decodeV1LaunchedToken(values) {
    const [token, deployer, pairedToken, positionManager, positionId, dexId, launchConfigId, restrictionsEndBlock, supply, isToken0, poolFee, exists, initialBuyAmount] = values;
    return { token, deployer, pairedToken, positionManager, positionId, dexId, launchConfigId, restrictionsEndBlock, supply, isToken0, poolFee, exists, initialBuyAmount };
  }
  var HOOK_FUNCTIONS = {
    /** FeePolicySnapshot: protocolFeeRecipient, protocolFeeShareBps, buybackBurnBps, hookFeeBps, maxInternalPriceImpactBps. */
    currentFeePolicy: { name: "currentFeePolicy", inputs: [], outputs: ["address", "uint16", "uint16", "uint16", "uint16"] }
  };
  function decodeLaunchedToken(values) {
    const [
      token,
      curve,
      deployer,
      creatorFeeRecipient,
      pairToken,
      graduationThreshold,
      poolFee,
      tickSpacing,
      creatorTaxBps,
      buybackEnabled,
      phase,
      sweptQuote,
      sweptTokens,
      sweptAt,
      exists
    ] = values;
    return {
      token,
      curve,
      deployer,
      creatorFeeRecipient,
      pairToken,
      graduationThreshold,
      poolFee,
      tickSpacing,
      creatorTaxBps,
      buybackEnabled,
      phase: Number(phase),
      sweptQuote,
      sweptTokens,
      sweptAt,
      exists
    };
  }
  var CURVE_EVENTS = {
    CurveBuy: {
      name: "CurveBuy",
      inputs: [
        { name: "buyer", type: "address", indexed: true },
        { name: "recipient", type: "address", indexed: true },
        { name: "quoteIn", type: "uint256", indexed: false },
        { name: "tokensOut", type: "uint256", indexed: false },
        { name: "fee", type: "uint256", indexed: false },
        { name: "tax", type: "uint256", indexed: false }
      ]
    },
    CurveSell: {
      name: "CurveSell",
      inputs: [
        { name: "seller", type: "address", indexed: true },
        { name: "recipient", type: "address", indexed: true },
        { name: "tokensIn", type: "uint256", indexed: false },
        { name: "quoteOut", type: "uint256", indexed: false },
        { name: "fee", type: "uint256", indexed: false },
        { name: "tax", type: "uint256", indexed: false }
      ]
    },
    FeesSwept: {
      name: "FeesSwept",
      inputs: [
        { name: "protocolAmount", type: "uint256", indexed: false },
        { name: "buybackAmount", type: "uint256", indexed: false },
        { name: "creatorAmount", type: "uint256", indexed: false }
      ]
    },
    BuybackLocked: {
      name: "BuybackLocked",
      inputs: [
        { name: "quoteSpent", type: "uint256", indexed: false },
        { name: "tokensLocked", type: "uint256", indexed: false }
      ]
    },
    CurveCompleted: {
      name: "CurveCompleted",
      inputs: [
        { name: "recipient", type: "address", indexed: false },
        { name: "quoteOut", type: "uint256", indexed: false },
        { name: "tokenOut", type: "uint256", indexed: false }
      ]
    }
  };
  var CURVE_FUNCTIONS = {
    getReserves: { name: "getReserves", inputs: [], outputs: ["uint256", "uint256"] },
    realQuoteReserve: { name: "realQuoteReserve", inputs: [], outputs: ["uint256"] },
    graduationThreshold: { name: "graduationThreshold", inputs: [], outputs: ["uint256"] },
    readyToGraduate: { name: "readyToGraduate", inputs: [], outputs: ["bool"] },
    graduated: { name: "graduated", inputs: [], outputs: ["bool"] },
    phantomQuote: { name: "phantomQuote", inputs: [], outputs: ["uint256"] },
    feeBps: { name: "feeBps", inputs: [], outputs: ["uint256"] },
    creatorTaxBps: { name: "creatorTaxBps", inputs: [], outputs: ["uint256"] },
    sellableTokens: { name: "sellableTokens", inputs: [], outputs: ["uint256"] },
    quoteFeeBalance: { name: "quoteFeeBalance", inputs: [], outputs: ["uint256"] },
    creatorTaxBalance: { name: "creatorTaxBalance", inputs: [], outputs: ["uint256"] },
    buybackQuoteBalance: { name: "buybackQuoteBalance", inputs: [], outputs: ["uint256"] },
    deployer: { name: "deployer", inputs: [], outputs: ["address"] },
    token: { name: "token", inputs: [], outputs: ["address"] },
    pairToken: { name: "pairToken", inputs: [], outputs: ["address"] },
    isNativeQuote: { name: "isNativeQuote", inputs: [], outputs: ["bool"] }
  };
  var ERC20_FUNCTIONS = {
    name: { name: "name", inputs: [], outputs: ["string"] },
    symbol: { name: "symbol", inputs: [], outputs: ["string"] },
    decimals: { name: "decimals", inputs: [], outputs: ["uint8"] },
    totalSupply: { name: "totalSupply", inputs: [], outputs: ["uint256"] },
    balanceOf: { name: "balanceOf", inputs: ["address"], outputs: ["uint256"] }
  };
  var ERC20_EVENTS = {
    Transfer: {
      name: "Transfer",
      inputs: [
        { name: "from", type: "address", indexed: true },
        { name: "to", type: "address", indexed: true },
        { name: "value", type: "uint256", indexed: false }
      ]
    }
  };
  function curveAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
    if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n || feeBps >= 10000n) return 0n;
    const amountInWithFee = amountIn * (10000n - feeBps);
    return amountInWithFee * reserveOut / (reserveIn * 10000n + amountInWithFee);
  }

  // src/chain/reader.ts
  init_abi();
  var NotAPonsLaunch = class extends Error {
    constructor(address) {
      super(`${address} is not a Pons V2 launch on this factory`);
      this.address = address;
      this.name = "NotAPonsLaunch";
    }
  };
  var PonsReader = class {
    constructor(rpc, factory = PONS_V2_FACTORY) {
      this.rpc = rpc;
      this.factory = factory;
    }
    /** Factory launch record, or throws NotAPonsLaunch. */
    async launchedToken(token, blockNumber) {
      const address = normalizeAddress(token);
      const [raw] = await this.rpc.callBatch(
        [{ to: this.factory, data: encodeCall(FACTORY_FUNCTIONS.getLaunchedToken, [address]) }],
        blockNumber
      );
      const record = decodeLaunchedToken(decodeOutputs(FACTORY_FUNCTIONS.getLaunchedToken, raw));
      if (!record.exists) throw new NotAPonsLaunch(address);
      return record;
    }
    /** Everything a receipt needs, pinned to `blockNumber` (defaults to the latest block). */
    async snapshot(token, blockNumber) {
      await this.rpc.assertChain();
      const chainId = await this.rpc.chainId();
      const pinned = blockNumber ?? await this.rpc.blockNumber();
      const header = await this.rpc.getBlock(pinned);
      const launch = await this.launchedToken(token, pinned);
      const tokenCalls = [
        { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.name, []) },
        { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.symbol, []) },
        { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.decimals, []) },
        { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.totalSupply, []) },
        { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [launch.deployer]) },
        { to: launch.token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [launch.curve]) }
      ];
      const curveOrder = [
        CURVE_FUNCTIONS.getReserves,
        CURVE_FUNCTIONS.realQuoteReserve,
        CURVE_FUNCTIONS.graduationThreshold,
        CURVE_FUNCTIONS.phantomQuote,
        CURVE_FUNCTIONS.feeBps,
        CURVE_FUNCTIONS.creatorTaxBps,
        CURVE_FUNCTIONS.readyToGraduate,
        CURVE_FUNCTIONS.graduated,
        CURVE_FUNCTIONS.quoteFeeBalance,
        CURVE_FUNCTIONS.creatorTaxBalance,
        CURVE_FUNCTIONS.buybackQuoteBalance,
        CURVE_FUNCTIONS.isNativeQuote
      ];
      const onCurve = launch.phase === 0 /* NotGraduated */;
      const curveCalls = onCurve ? curveOrder.map((fn) => ({ to: launch.curve, data: encodeCall(fn, []) })) : [];
      const results = await this.rpc.callBatch([...tokenCalls, ...curveCalls], pinned);
      const [name] = decodeOutputs(ERC20_FUNCTIONS.name, results[0]);
      const [symbol] = decodeOutputs(ERC20_FUNCTIONS.symbol, results[1]);
      const [decimals] = decodeOutputs(ERC20_FUNCTIONS.decimals, results[2]);
      const [totalSupply] = decodeOutputs(ERC20_FUNCTIONS.totalSupply, results[3]);
      const [deployerBalance] = decodeOutputs(ERC20_FUNCTIONS.balanceOf, results[4]);
      const [curveTokenBalance] = decodeOutputs(ERC20_FUNCTIONS.balanceOf, results[5]);
      let curve = null;
      if (onCurve) {
        const out2 = curveOrder.map((fn, index) => decodeOutputs(fn, results[tokenCalls.length + index]));
        curve = {
          quoteReserve: out2[0][0],
          tokenReserve: out2[0][1],
          realQuoteReserve: out2[1][0],
          graduationThreshold: out2[2][0],
          phantomQuote: out2[3][0],
          feeBps: out2[4][0],
          creatorTaxBps: out2[5][0],
          readyToGraduate: out2[6][0],
          graduated: out2[7][0],
          quoteFeeBalance: out2[8][0],
          creatorTaxBalance: out2[9][0],
          buybackQuoteBalance: out2[10][0],
          isNativeQuote: out2[11][0]
        };
      }
      return {
        chainId,
        block: { number: header.number, timestamp: header.timestamp },
        launch,
        token: { name, symbol, decimals: Number(decimals), totalSupply },
        curve,
        deployerBalance,
        curveTokenBalance
      };
    }
  };
  async function readTokenMeta(rpc, address, blockNumber) {
    const [symbolRaw, decimalsRaw] = await rpc.callBatch(
      [
        { to: address, data: encodeCall(ERC20_FUNCTIONS.symbol, []) },
        { to: address, data: encodeCall(ERC20_FUNCTIONS.decimals, []) }
      ],
      blockNumber
    );
    const [symbol] = decodeOutputs(ERC20_FUNCTIONS.symbol, symbolRaw);
    const [decimals] = decodeOutputs(ERC20_FUNCTIONS.decimals, decimalsRaw);
    return { symbol, decimals: Number(decimals) };
  }

  // src/chain/rpc.ts
  var READ_ONLY_METHODS = /* @__PURE__ */ new Set([
    "eth_chainId",
    "eth_blockNumber",
    "eth_call",
    "eth_getLogs",
    "eth_getBlockByNumber",
    "eth_getBalance",
    "eth_getCode",
    "eth_getTransactionReceipt",
    "eth_getStorageAt"
  ]);
  var RpcError = class extends Error {
    constructor(message, code, data, kind = "transport") {
      super(message);
      this.code = code;
      this.data = data;
      this.kind = kind;
      this.name = "RpcError";
    }
    /**
     * True when the node ran the call and the EVM reverted. That is a fact about
     * the contract; every other error is a fact about the network, and the two
     * must never be confused: a rate-limited probe is not a trapping token.
     */
    get isRevert() {
      if (this.kind !== "application") return false;
      if (typeof this.data === "string" && this.data.startsWith("0x")) return true;
      if (this.code === 3) return true;
      return /execution reverted|execution error|invalid opcode|out of gas/i.test(this.message);
    }
    /** True when the endpoint is asking us to slow down, whether it said so in HTTP or in JSON-RPC. */
    get isRateLimit() {
      return this.code === 429 || this.code === -32005 || /rate limited|rate limit|too many requests/i.test(this.message);
    }
  };
  var RpcClient = class {
    urls;
    expectedChainId;
    timeoutMs;
    fetchImpl;
    minSpacingMs;
    rateLimitRetries;
    requestBudgetMs;
    activeIndex = 0;
    /**
     * Calls, milliseconds and failures per method. The Solana side got this
     * after three wrong diagnoses in a row, and it found the answer on the
     * first run; a Base door that takes minutes deserves the same treatment
     * rather than another plausible story.
     */
    counters = /* @__PURE__ */ new Map();
    /** One entry per request that reached the wire; see slowest(). Bounded so a log walk cannot grow it without limit. */
    requestLog = [];
    nextId = 1;
    /**
     * The widest eth_getLogs span this client has had served, and the
     * narrowest it has had refused.
     *
     * Nobody publishes the block range an endpoint allows, so every log walk
     * has been rediscovering it from scratch — and rediscovery is expensive:
     * measured on Base, five refused requests at about 2.4 seconds each,
     * twelve seconds spent learning something the walk before it already
     * knew. Learned once per client, which is once per read.
     */
    logSpanServed = 0;
    logSpanRefused = Infinity;
    /** See RpcOptions.memo. Null when off, which is the default. */
    memo;
    verifiedChain = false;
    lastRequestAt = 0;
    constructor(options) {
      if (options.urls.length === 0) throw new Error("at least one RPC url is required");
      this.urls = options.urls;
      this.expectedChainId = options.expectedChainId;
      this.timeoutMs = options.timeoutMs ?? 6e3;
      this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
      this.minSpacingMs = options.minSpacingMs ?? (options.fetchImpl ? 0 : 120);
      this.rateLimitRetries = options.rateLimitRetries ?? 3;
      this.memo = options.memo ? /* @__PURE__ */ new Map() : null;
      this.requestBudgetMs = options.requestBudgetMs ?? 9e3;
    }
    /** How many reads the memo answered without asking anybody. */
    memoHits = 0;
    get activeUrl() {
      return this.urls[this.activeIndex];
    }
    async chainId() {
      const hex = await this.send("eth_chainId", []);
      return Number(BigInt(hex));
    }
    async assertChain() {
      if (this.verifiedChain) return;
      const id = await this.chainId();
      if (id !== this.expectedChainId) {
        throw new RpcError(`endpoint ${this.activeUrl} reports chain ${id}, expected ${this.expectedChainId}`);
      }
      this.verifiedChain = true;
    }
    async blockNumber() {
      const hex = await this.send("eth_blockNumber", []);
      return Number(BigInt(hex));
    }
    /**
     * The head block and the chain-identity check in one round trip.
     *
     * Every read starts here, and it used to cost three: eth_chainId, then
     * eth_blockNumber, then eth_getBlockByNumber for that number. The first two
     * answers are not needed to ask the third, and "latest" already returns the
     * number, so all three were one batch pretending to be a queue.
     */
    async head() {
      if (this.verifiedChain) return this.getBlock("latest");
      const [idHex, raw] = await this.sendBatch([
        { method: "eth_chainId", params: [] },
        { method: "eth_getBlockByNumber", params: ["latest", false] }
      ]);
      const id = Number(BigInt(idHex));
      if (id !== this.expectedChainId) {
        throw new RpcError(`endpoint ${this.activeUrl} reports chain ${id}, expected ${this.expectedChainId}`);
      }
      this.verifiedChain = true;
      return toHeader(raw, "latest");
    }
    async getBlock(blockNumber) {
      const tag = blockNumber === "latest" ? "latest" : toHex(blockNumber);
      return toHeader(await this.send("eth_getBlockByNumber", [tag, false]), tag);
    }
    async call(to, data, blockNumber = "latest") {
      const tag = blockNumber === "latest" ? "latest" : toHex(blockNumber);
      const result = await this.send("eth_call", [{ to, data }, tag]);
      return result;
    }
    /** Several eth_call reads pinned to one block, sent as one JSON-RPC batch. */
    async callBatch(calls, blockNumber) {
      const tag = toHex(blockNumber);
      const results = await this.sendBatch(
        calls.map((call) => ({ method: "eth_call", params: [{ to: call.to, data: call.data }, tag] }))
      );
      return results;
    }
    /** Runtime bytecode at an address, pinned to a block. "0x" for an EOA. */
    async getCode(address, blockNumber = "latest") {
      const tag = blockNumber === "latest" ? "latest" : toHex(blockNumber);
      return await this.send("eth_getCode", [address, tag]);
    }
    /** One storage word, pinned to a block. Used only to read the EIP-1967 proxy slots. */
    async getStorageAt(address, slot, blockNumber = "latest") {
      const tag = blockNumber === "latest" ? "latest" : toHex(blockNumber);
      return await this.send("eth_getStorageAt", [address, slot, tag]);
    }
    async getLogs(filter) {
      const params = {
        address: filter.address,
        topics: filter.topics,
        fromBlock: toHex(filter.fromBlock),
        toBlock: toHex(filter.toBlock)
      };
      const span = filter.toBlock - filter.fromBlock + 1;
      try {
        const logs = await this.send("eth_getLogs", [params]);
        if (span > this.logSpanServed) this.logSpanServed = span;
        return logs;
      } catch (error) {
        if (isRangeRefusal(error) && span < this.logSpanRefused) this.logSpanRefused = span;
        throw error;
      }
    }
    /**
     * The widest span the next log walk should open with, or null when this
     * client has no reason to cap it.
     *
     * Only a refusal caps anything. Being served a thousand blocks says
     * nothing about whether twenty thousand would be served — the caller
     * simply did not ask for more — and treating it as a limit would make
     * every later walk narrower than it needs to be. A refusal is the only
     * direction that carries information, and it carries it in one direction.
     */
    logSpanCeiling() {
      return Number.isFinite(this.logSpanRefused) ? Math.max(1, Math.floor(this.logSpanRefused / 8)) : null;
    }
    /**
     * Public endpoints cap the block span of one eth_getLogs request. This
     * walks the range in chunks and never invents data for a chunk that fails:
     * the error propagates so the caller can report "unknown", not "zero".
     */
    async getLogsChunked(filter, chunkSize) {
      const logs = [];
      for (let from = filter.fromBlock; from <= filter.toBlock; from += chunkSize) {
        const to = Math.min(from + chunkSize - 1, filter.toBlock);
        logs.push(...await this.getLogs({ ...filter, fromBlock: from, toBlock: to }));
      }
      return logs;
    }
    async send(method, params) {
      const [result] = await this.sendBatch([{ method, params }]);
      return result;
    }
    /**
     * Like sendBatch, but a call the node answered with an error comes back as
     * that error instead of discarding every other answer in the batch. One
     * contract without a slot0() must not cost the caller the reserves of three
     * pools that were read perfectly well.
     */
    async sendBatchSettled(requests) {
      return this.dispatch(requests, true);
    }
    /** Several eth_call reads pinned to one block, each answered or failed on its own. */
    async callBatchSettled(calls, blockNumber) {
      const tag = toHex(blockNumber);
      const answers = await this.sendBatchSettled(calls.map((call) => ({ method: "eth_call", params: [{ to: call.to, data: call.data }, tag] })));
      return answers.map((a) => a instanceof RpcError ? a : a);
    }
    async sendBatch(requests) {
      return this.dispatch(requests, false);
    }
    /**
     * The slowest individual requests, newest cost first.
     *
     * The per-method numbers cannot answer "which request was slow", because a
     * batch's time is charged to every method in it: 86 eth_calls and 8.3
     * seconds could be one heavy batch or twenty light ones, and those call for
     * opposite fixes. This records each request as it lands, so the next
     * profile names the batch instead of the method.
     */
    slowest(limit = 8) {
      return [...this.requestLog].sort((a, b) => b.ms - a.ms).slice(0, limit);
    }
    /** Per-method call counts and total milliseconds, for working out where a slow read went. */
    stats() {
      return [...this.counters.entries()].map(([method, v]) => ({ method, ...v })).sort((a, b) => b.ms - a.ms);
    }
    record(requests, ms, failed2) {
      if (this.requestLog.length < 400) {
        const counts = /* @__PURE__ */ new Map();
        for (const r of requests) counts.set(r.method, (counts.get(r.method) ?? 0) + 1);
        const label = [...counts].map(([m, n]) => n === 1 ? m : `${m} \xD7${n}`).join(" + ");
        this.requestLog.push({ label: failed2 ? `${label} (failed)` : label, size: requests.length, ms });
      }
      const methods = new Set(requests.map((r) => r.method));
      for (const method of methods) {
        const entry = this.counters.get(method) ?? { calls: 0, ms: 0, failures: 0 };
        entry.calls += requests.filter((r) => r.method === method).length;
        entry.ms += ms;
        if (failed2) entry.failures += 1;
        this.counters.set(method, entry);
      }
    }
    /**
     * The memo sits in front of the wire, not behind it: a batch of ten where
     * seven are already known sends three, and a batch where all ten are known
     * sends nothing at all and costs no round trip.
     */
    async dispatch(requests, settled) {
      if (!this.memo) return this.fetchAll(requests, settled);
      const keys = requests.map((request) => memoKey(request));
      const pending = new Array(requests.length);
      const missing = [];
      for (let i = 0; i < requests.length; i++) {
        const key = keys[i];
        const hit = key === null ? void 0 : this.memo.get(key);
        if (!hit) {
          missing.push(i);
          continue;
        }
        this.memoHits++;
        pending[i] = hit;
      }
      if (missing.length) {
        const batch = this.fetchAll(
          missing.map((i) => requests[i]),
          settled
        ).then(
          (fresh) => fresh.map((value) => value instanceof RpcError ? { ok: false, error: value } : { ok: true, value }),
          (error) => {
            const failure = error instanceof RpcError ? error : new RpcError(error instanceof Error ? error.message : String(error));
            for (const i of missing) if (keys[i] !== null) this.memo.delete(keys[i]);
            throw failure;
          }
        );
        missing.forEach((target, j) => {
          const slot = batch.then((all) => all[j]);
          pending[target] = slot;
          const key = keys[target];
          if (key !== null) {
            slot.catch(() => {
            });
            this.memo.set(key, slot);
          }
        });
      }
      const settledAnswers = await Promise.all(pending);
      return settledAnswers.map((answer) => {
        if (answer.ok) return answer.value;
        if (settled) return answer.error;
        throw answer.error;
      });
    }
    async fetchAll(requests, settled) {
      for (const request of requests) {
        if (!READ_ONLY_METHODS.has(request.method)) {
          throw new RpcError(`refusing non-read method ${request.method}`);
        }
      }
      const payload = requests.map((request) => ({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: request.method,
        params: request.params
      }));
      let lastError;
      const startedAt = Date.now();
      const deadline = startedAt + this.requestBudgetMs;
      let transportFailures = 0;
      let rateLimited = 0;
      for (; ; ) {
        if (transportFailures >= this.urls.length || rateLimited > this.rateLimitRetries) break;
        if (Date.now() >= deadline) {
          lastError = lastError ?? new RpcError(`no endpoint answered within ${this.requestBudgetMs} ms`);
          break;
        }
        const url = this.urls[this.activeIndex];
        try {
          await this.pace();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);
          const response = await this.fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (compatible; bouncer/0.1; +https://github.com/Kepochnik/bouncer)" },
            body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
            signal: controller.signal
          });
          clearTimeout(timer);
          if (response.status === 429) throw new RpcError(`${url} rate limited (429)`, 429);
          if (!response.ok) throw new RpcError(`${url} responded ${response.status}`);
          const body = await response.json();
          const items = Array.isArray(body) ? body : [body];
          const byId = /* @__PURE__ */ new Map();
          for (const item of items) {
            byId.set(item.id, item);
          }
          const answers = payload.map((request) => {
            const item = byId.get(request.id);
            if (!item) throw new RpcError(`missing response for ${request.method}`);
            if (item.error) {
              const failure = new RpcError(item.error.message, item.error.code, item.error.data, "application");
              if (settled && !failure.isRateLimit) return failure;
              throw failure;
            }
            return item.result;
          });
          this.record(requests, Date.now() - startedAt, false);
          return answers;
        } catch (error) {
          lastError = error;
          if (error instanceof RpcError && error.isRateLimit) {
            if (this.urls.length > 1) this.activeIndex = (this.activeIndex + 1) % this.urls.length;
            await new Promise((resolve) => setTimeout(resolve, Math.min(300 * 2 ** rateLimited, Math.max(0, deadline - Date.now()))));
            rateLimited++;
            continue;
          }
          if (error instanceof RpcError && error.isRevert) throw error;
          transportFailures++;
          this.activeIndex = (this.activeIndex + 1) % this.urls.length;
          this.verifiedChain = false;
        }
      }
      this.record(requests, Date.now() - startedAt, true);
      throw lastError instanceof Error ? lastError : new RpcError(String(lastError));
    }
    async pace() {
      if (this.minSpacingMs <= 0) return;
      const wait = this.lastRequestAt + this.minSpacingMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequestAt = Date.now();
    }
  };
  var MOVING_TAGS = ['"latest"', '"pending"', '"safe"', '"finalized"', '"earliest"'];
  function memoKey(request) {
    const params = JSON.stringify(request.params);
    for (const tag of MOVING_TAGS) if (params.includes(tag)) return null;
    return `${request.method}|${params}`;
  }
  function isRangeRefusal(error) {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes("block range") || message.includes("range is too") || message.includes("too many blocks") || message.includes("query returned more than") || message.includes("exceed maximum block range") || message.includes("limit exceeded") || message.includes("response size exceeded") || message.includes("too large");
  }
  function toHeader(raw, tag) {
    const block = raw;
    if (!block) throw new RpcError(`block ${tag} not found`);
    return { number: Number(BigInt(block.number)), timestamp: Number(BigInt(block.timestamp)), hash: block.hash };
  }
  function toHex(value) {
    return `0x${value.toString(16)}`;
  }

  // src/chain/base58.ts
  var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var INDEX = /* @__PURE__ */ new Map();
  for (let i = 0; i < ALPHABET.length; i++) INDEX.set(ALPHABET[i], i);
  function base58Decode(text) {
    if (text.length === 0) return new Uint8Array(0);
    let value = 0n;
    for (const char of text) {
      const digit = INDEX.get(char);
      if (digit === void 0) throw new Error(`not base58: ${JSON.stringify(char)} in ${text.slice(0, 64)}`);
      value = value * 58n + BigInt(digit);
    }
    const body = [];
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
  function base58Encode(bytes) {
    if (bytes.length === 0) return "";
    let value = 0n;
    for (const byte of bytes) value = value << 8n | BigInt(byte);
    let out2 = "";
    while (value > 0n) {
      out2 = ALPHABET[Number(value % 58n)] + out2;
      value /= 58n;
    }
    for (const byte of bytes) {
      if (byte !== 0) break;
      out2 = "1" + out2;
    }
    return out2;
  }
  function isSolanaAddress(text) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return false;
    try {
      return base58Decode(text).length === 32;
    } catch {
      return false;
    }
  }

  // src/chain/ed25519.ts
  var P = (1n << 255n) - 19n;
  var D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
  var SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;
  function modPow(base, exponent, modulus) {
    let result = 1n;
    let b = (base % modulus + modulus) % modulus;
    let e = exponent;
    while (e > 0n) {
      if (e & 1n) result = result * b % modulus;
      b = b * b % modulus;
      e >>= 1n;
    }
    return result;
  }
  function isOnCurve(bytes) {
    if (bytes.length !== 32) return false;
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = y << 8n | BigInt(bytes[i]);
    const sign = y >> 255n & 1n;
    y &= (1n << 255n) - 1n;
    if (y >= P) return false;
    const y2 = y * y % P;
    const u = (y2 - 1n + P) % P;
    const v = (D * y2 + 1n) % P;
    if (v === 0n) return false;
    const v3 = v * v % P * v % P;
    const v7 = v3 * v3 % P * v % P;
    let x = u * v3 % P * modPow(u * v7 % P, (P - 5n) / 8n, P) % P;
    const check = v * x % P * x % P;
    if (check === u) {
    } else if (check === (P - u) % P) {
      x = x * SQRT_M1 % P;
    } else {
      return false;
    }
    if (x === 0n && sign === 1n) return false;
    return true;
  }

  // src/chain/sha256.ts
  var K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var rotr = (x, n) => x >>> n | x << 32 - n;
  function sha256(input) {
    const h = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
    const bitLength = BigInt(input.length) * 8n;
    const padded = new Uint8Array(input.length + 9 + 63 >> 6 << 6);
    padded.set(input);
    padded[input.length] = 128;
    for (let i = 0; i < 8; i++) padded[padded.length - 1 - i] = Number(bitLength >> BigInt(8 * i) & 0xffn);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = padded[offset + i * 4] << 24 | padded[offset + i * 4 + 1] << 16 | padded[offset + i * 4 + 2] << 8 | padded[offset + i * 4 + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = e & f ^ ~e & g;
        const temp1 = hh + S1 + ch + K[i] + w[i] >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = a & b ^ a & c ^ b & c;
        const temp2 = S0 + maj >>> 0;
        hh = g;
        g = f;
        f = e;
        e = d + temp1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2 >>> 0;
      }
      h[0] = h[0] + a >>> 0;
      h[1] = h[1] + b >>> 0;
      h[2] = h[2] + c >>> 0;
      h[3] = h[3] + d >>> 0;
      h[4] = h[4] + e >>> 0;
      h[5] = h[5] + f >>> 0;
      h[6] = h[6] + g >>> 0;
      h[7] = h[7] + hh >>> 0;
    }
    const out2 = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out2[i * 4] = h[i] >>> 24 & 255;
      out2[i * 4 + 1] = h[i] >>> 16 & 255;
      out2[i * 4 + 2] = h[i] >>> 8 & 255;
      out2[i * 4 + 3] = h[i] & 255;
    }
    return out2;
  }

  // src/chain/solana.ts
  var TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  var TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  var METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
  var READ_ONLY_METHODS2 = /* @__PURE__ */ new Set([
    "getAccountInfo",
    "getMultipleAccounts",
    "getTokenSupply",
    "getTokenLargestAccounts",
    "getTokenAccountsByOwner",
    "getSlot",
    "getBlockTime",
    "getHealth",
    "getVersion",
    "getSignaturesForAddress",
    "getEpochInfo"
  ]);
  var RATE_LIMIT_RETRIES = 3;
  var SolanaRpcError = class extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
      this.name = "SolanaRpcError";
    }
  };
  var SolanaRpc = class {
    urls;
    timeoutMs;
    fetchImpl;
    minSpacingMs;
    /** See SolanaRpcOptions.memo. Null when off, which is the default. */
    memo;
    /** How many reads the memo answered without asking an endpoint. */
    memoHits = 0;
    retries;
    activeIndex = 0;
    nextId = 1;
    lastRequestAt = 0;
    /**
     * How many calls each method made and how long they took. Three times in a
     * row a slow Solana slip was diagnosed from the symptom and the diagnosis
     * was wrong; this is here so the next one is diagnosed from the numbers.
     */
    counters = /* @__PURE__ */ new Map();
    constructor(options) {
      if (!options.urls.length) throw new Error("at least one RPC url is required");
      this.urls = options.urls;
      this.timeoutMs = options.timeoutMs ?? 7e3;
      this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
      this.minSpacingMs = options.minSpacingMs ?? (options.fetchImpl ? 0 : 120);
      this.memo = options.memo ? /* @__PURE__ */ new Map() : null;
      this.retries = options.retries ?? 1;
    }
    get activeUrl() {
      return this.urls[this.activeIndex];
    }
    /** Per-method call counts and total milliseconds, for working out where a slow read went. */
    stats() {
      return [...this.counters.entries()].map(([method, v]) => ({ method, ...v })).sort((a, b) => b.ms - a.ms);
    }
    record(method, ms, failed2) {
      const entry = this.counters.get(method) ?? { calls: 0, ms: 0, failures: 0 };
      entry.calls += 1;
      entry.ms += ms;
      if (failed2) entry.failures += 1;
      this.counters.set(method, entry);
    }
    async send(method, params) {
      if (!READ_ONLY_METHODS2.has(method)) throw new SolanaRpcError(`refusing non-read method ${method}`);
      const key = this.memo && method !== "getSlot" ? `${method}|${JSON.stringify(params)}` : null;
      if (key !== null && this.memo.has(key)) {
        this.memoHits++;
        return this.memo.get(key);
      }
      let lastError;
      const startedAt = Date.now();
      const maxAttempts = this.urls.length * Math.max(1, this.retries);
      let rateLimited = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const url = this.urls[this.activeIndex];
        try {
          await this.pace();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);
          const response = await this.fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
            signal: controller.signal
          });
          clearTimeout(timer);
          if (response.status === 429) throw new SolanaRpcError(`${url} rate limited (429)`, 429);
          if (!response.ok) throw new SolanaRpcError(`${url} responded ${response.status}`);
          const body = await response.json();
          if (body.error) throw new SolanaRpcError(body.error.message, body.error.code);
          this.record(method, Date.now() - startedAt, false);
          if (key !== null) this.memo.set(key, body.result);
          return body.result;
        } catch (error) {
          lastError = error;
          if (error instanceof SolanaRpcError && error.code === 429) {
            if (rateLimited >= RATE_LIMIT_RETRIES) throw error;
            if (this.urls.length > 1) this.activeIndex = (this.activeIndex + 1) % this.urls.length;
            await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** rateLimited));
            rateLimited++;
            continue;
          }
          this.activeIndex = (this.activeIndex + 1) % this.urls.length;
        }
      }
      this.record(method, Date.now() - startedAt, true);
      throw lastError instanceof Error ? lastError : new SolanaRpcError(String(lastError));
    }
    async pace() {
      if (this.minSpacingMs <= 0) return;
      const wait = this.lastRequestAt + this.minSpacingMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequestAt = Date.now();
    }
    async slot() {
      return Number(await this.send("getSlot", [{ commitment: "confirmed" }]));
    }
    async blockTime(slot) {
      try {
        const value = await this.send("getBlockTime", [slot]);
        return value === null || value === void 0 ? null : Number(value);
      } catch {
        return null;
      }
    }
    async accountInfo(address) {
      const result = await this.send("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
      return decodeAccount(result?.value ?? null);
    }
    async multipleAccounts(addresses) {
      if (!addresses.length) return [];
      const out2 = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const slice = addresses.slice(i, i + 100);
        const result = await this.send("getMultipleAccounts", [slice, { encoding: "base64", commitment: "confirmed" }]);
        for (const value of result?.value ?? []) out2.push(decodeAccount(value));
      }
      return out2;
    }
    async tokenSupply(mint) {
      try {
        const result = await this.send("getTokenSupply", [mint, { commitment: "confirmed" }]);
        if (!result?.value) return null;
        return { amount: BigInt(result.value.amount), decimals: Number(result.value.decimals) };
      } catch {
        return null;
      }
    }
    /**
     * Every token account one address holds, with its mint and balance. This is
     * how both sides of a pool are read without a program scan: the pool owns its
     * vaults, so asking the pool for its token accounts returns the pair.
     */
    async tokenAccountsByOwner(owner, programId = TOKEN_PROGRAM) {
      const result = await this.send("getTokenAccountsByOwner", [owner, { programId }, { encoding: "base64", commitment: "confirmed" }]);
      const out2 = [];
      for (const entry of result?.value ?? []) {
        const account = decodeAccount(entry.account);
        if (!account || account.data.length < 72) continue;
        let amount = 0n;
        for (let i = 71; i >= 64; i--) amount = amount << 8n | BigInt(account.data[i] ?? 0);
        out2.push({ address: entry.pubkey, mint: base58Encode(account.data.slice(0, 32)), amount });
      }
      return out2;
    }
    /** The 20 largest token accounts, which are accounts and not yet people: their owners are a second read. */
    async largestAccounts(mint) {
      const result = await this.send("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
      return (result?.value ?? []).map((v) => ({ address: v.address, amount: BigInt(v.amount) }));
    }
  };
  function decodeAccount(raw) {
    if (!raw) return null;
    const encoded = Array.isArray(raw.data) ? raw.data[0] : raw.data;
    return { owner: raw.owner, lamports: Number(raw.lamports), executable: Boolean(raw.executable), data: base64ToBytes(encoded) };
  }
  function base64ToBytes(text) {
    if (!text) return new Uint8Array(0);
    if (typeof atob === "function") {
      const binary = atob(text);
      const out2 = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out2[i] = binary.charCodeAt(i);
      return out2;
    }
    return new Uint8Array(Buffer.from(text, "base64"));
  }
  var MINT_SIZE = 82;
  var TLV_START = 166;
  function parseMint(account) {
    const d = account.data;
    if (d.length < MINT_SIZE) return null;
    if (account.owner !== TOKEN_PROGRAM && account.owner !== TOKEN_2022_PROGRAM) return null;
    const view2 = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const mintAuthorityOption = view2.getUint32(0, true);
    const freezeAuthorityOption = view2.getUint32(46, true);
    const mint = {
      mintAuthority: mintAuthorityOption === 1 ? base58Encode(d.slice(4, 36)) : null,
      supply: view2.getBigUint64(36, true),
      decimals: d[44],
      isInitialized: d[45] === 1,
      freezeAuthority: freezeAuthorityOption === 1 ? base58Encode(d.slice(50, 82)) : null,
      token2022: account.owner === TOKEN_2022_PROGRAM,
      extensions: []
    };
    if (mint.token2022 && d.length > TLV_START) mint.extensions = parseExtensions(d.slice(TLV_START));
    return mint;
  }
  function parseExtensions(tlv) {
    const out2 = [];
    const view2 = new DataView(tlv.buffer, tlv.byteOffset, tlv.byteLength);
    let offset = 0;
    while (offset + 4 <= tlv.length) {
      const type = view2.getUint16(offset, true);
      const length = view2.getUint16(offset + 2, true);
      const start = offset + 4;
      if (type === 0 || start + length > tlv.length) break;
      const value = tlv.slice(start, start + length);
      out2.push(parseExtension(type, value));
      offset = start + length;
    }
    return out2;
  }
  function optionalKey(bytes) {
    if (bytes.length !== 32) return null;
    return bytes.every((b) => b === 0) ? null : base58Encode(bytes);
  }
  function parseExtension(type, v) {
    const view2 = new DataView(v.buffer, v.byteOffset, v.byteLength);
    switch (type) {
      case 1: {
        if (v.length < 108) return { kind: "other", type };
        const older = 72;
        const newer = 90;
        return {
          kind: "transfer-fee",
          feeAuthority: optionalKey(v.slice(0, 32)),
          withdrawAuthority: optionalKey(v.slice(32, 64)),
          maximumFee: view2.getBigUint64(older + 8, true),
          feeBps: view2.getUint16(older + 16, true),
          nextFeeEpoch: view2.getBigUint64(newer, true),
          nextFeeBps: view2.getUint16(newer + 16, true)
        };
      }
      case 3:
        return v.length >= 32 ? { kind: "mint-close-authority", authority: base58Encode(v.slice(0, 32)) } : { kind: "other", type };
      case 6:
        return { kind: "default-account-state", frozen: v[0] === 2 };
      case 9:
        return { kind: "non-transferable" };
      case 10:
        return v.length >= 34 ? { kind: "interest-bearing", authority: optionalKey(v.slice(0, 32)), rateBps: view2.getInt16(v.length - 2, true) } : { kind: "other", type };
      case 12:
        return v.length >= 32 ? { kind: "permanent-delegate", delegate: base58Encode(v.slice(0, 32)) } : { kind: "other", type };
      case 14:
        return v.length >= 64 ? { kind: "transfer-hook", authority: optionalKey(v.slice(0, 32)), programId: optionalKey(v.slice(32, 64)) } : { kind: "other", type };
      case 18:
        return v.length >= 64 ? { kind: "metadata-pointer", address: optionalKey(v.slice(32, 64)) } : { kind: "other", type };
      case 19: {
        if (v.length < 64) return { kind: "other", type };
        let offset = 64;
        const read = () => {
          if (offset + 4 > v.length) return "";
          const length = view2.getUint32(offset, true);
          offset += 4;
          const text = new TextDecoder().decode(v.slice(offset, offset + length));
          offset += length;
          return text;
        };
        return { kind: "token-metadata", updateAuthority: optionalKey(v.slice(0, 32)), name: read(), symbol: read(), uri: read() };
      }
      case 26:
        return { kind: "pausable", authority: optionalKey(v.slice(0, 32)) };
      default:
        return { kind: "other", type };
    }
  }
  function tokenAccountOwner(account) {
    if (account.data.length < 72) return null;
    return base58Encode(account.data.slice(32, 64));
  }
  var PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
  function findProgramAddress(seeds, programId) {
    const program = base58Decode(programId);
    for (let bump = 255; bump >= 0; bump--) {
      const parts = [...seeds, new Uint8Array([bump]), program, PDA_MARKER];
      let total = 0;
      for (const p of parts) total += p.length;
      const buffer = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        buffer.set(p, offset);
        offset += p.length;
      }
      const candidate = sha256(buffer);
      if (!isOnCurve(candidate)) return { address: base58Encode(candidate), bump };
    }
    return null;
  }
  function metadataAddress(mint) {
    const seeds = [new TextEncoder().encode("metadata"), base58Decode(METADATA_PROGRAM), base58Decode(mint)];
    return findProgramAddress(seeds, METADATA_PROGRAM)?.address ?? null;
  }
  function parseMetadata(account) {
    const d = account.data;
    if (d.length < 100 || d[0] !== 4) return null;
    const view2 = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let offset = 1;
    const updateAuthority = base58Encode(d.slice(offset, offset + 32));
    offset += 32;
    const mint = base58Encode(d.slice(offset, offset + 32));
    offset += 32;
    const readString = () => {
      if (offset + 4 > d.length) return "";
      const length = view2.getUint32(offset, true);
      offset += 4;
      if (length > 1e3 || offset + length > d.length) return "";
      const text = new TextDecoder().decode(d.slice(offset, offset + length));
      offset += length;
      return text.replace(/\0+$/, "");
    };
    const name = readString();
    const symbol = readString();
    const uri = readString();
    if (offset + 2 > d.length) return null;
    const sellerFeeBasisPoints = view2.getUint16(offset, true);
    offset += 2;
    if (d[offset] === 1) {
      offset += 1;
      const count = view2.getUint32(offset, true);
      offset += 4 + count * 34;
    } else {
      offset += 1;
    }
    if (offset + 2 > d.length) return null;
    return { updateAuthority, mint, name, symbol, uri, sellerFeeBasisPoints, primarySaleHappened: d[offset] === 1, isMutable: d[offset + 1] === 1 };
  }

  // src/chain/whichChain.ts
  init_abi();
  function searchableChains() {
    return Object.values(CHAINS).filter((c) => c.family === "evm");
  }
  function decodeString(answer, fn) {
    if (answer instanceof RpcError || typeof answer !== "string") return null;
    try {
      const [value] = decodeOutputs(fn, answer);
      return typeof value === "string" && value.length ? value : null;
    } catch {
      return null;
    }
  }
  async function whichChains(address, clientFor, chains = searchableChains()) {
    const results = await Promise.all(
      chains.map(async (chain2) => {
        try {
          const [code, name, symbol] = await clientFor(chain2).sendBatchSettled([
            { method: "eth_getCode", params: [address, "latest"] },
            { method: "eth_call", params: [{ to: address, data: encodeCall(ERC20_FUNCTIONS.name, []) }, "latest"] },
            { method: "eth_call", params: [{ to: address, data: encodeCall(ERC20_FUNCTIONS.symbol, []) }, "latest"] }
          ]);
          if (code instanceof RpcError) return { chain: chain2, hit: null, reason: code.message };
          if (typeof code !== "string") return { chain: chain2, hit: null, reason: "the endpoint answered with something that is not bytecode" };
          const codeSize = Math.max(0, (code.length - 2) / 2);
          if (codeSize === 0) return { chain: chain2, hit: null, reason: null };
          const n = decodeString(name, ERC20_FUNCTIONS.name);
          const s = decodeString(symbol, ERC20_FUNCTIONS.symbol);
          return { chain: chain2, hit: { chain: chain2, codeSize, token: n !== null && s !== null ? { name: n, symbol: s } : null }, reason: null };
        } catch (error) {
          return { chain: chain2, hit: null, reason: error instanceof Error ? error.message : String(error) };
        }
      })
    );
    return {
      hits: results.filter((r) => r.hit).map((r) => r.hit),
      unreachable: results.filter((r) => !r.hit && r.reason !== null).map((r) => ({ chain: r.chain, reason: r.reason })),
      empty: results.filter((r) => !r.hit && r.reason === null).map((r) => r.chain)
    };
  }
  function readChainSearch(search) {
    if (search.hits.length === 1) return { kind: "one", chain: search.hits[0].chain, search };
    if (search.hits.length > 1) return { kind: "several", search };
    return { kind: "none", search };
  }

  // src/chain/solanaDerived.ts
  var WSOL = "So11111111111111111111111111111111111111112";
  var USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  var WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
  var WHIRLPOOLS_CONFIG = "2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ";
  var CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
  var TICK_SPACINGS = [1, 2, 4, 8, 16, 64, 96, 128, 256];
  var CPMM_CONFIG_INDEXES = [0, 1, 2, 3];
  var enc = new TextEncoder();
  function u16le(value) {
    return new Uint8Array([value & 255, value >> 8 & 255]);
  }
  function u16be(value) {
    return new Uint8Array([value >> 8 & 255, value & 255]);
  }
  function sortPair(a, b) {
    const x = base58Decode(a);
    const y = base58Decode(b);
    for (let i = 0; i < 32; i++) {
      if (x[i] !== y[i]) return x[i] < y[i] ? [a, b, true] : [b, a, false];
    }
    return [a, b, true];
  }
  var WHIRLPOOL_LAYOUT = { mintA: 101, vaultA: 133, mintB: 181, vaultB: 213 };
  var CPMM_LAYOUT = { vaultA: 72, vaultB: 104, mintA: 168, mintB: 200 };
  function deriveCandidates(mint, quotes = [WSOL, USDC]) {
    const out2 = [];
    for (const quote of quotes) {
      let sorted;
      try {
        sorted = sortPair(mint, quote);
      } catch {
        continue;
      }
      const [first, second] = sorted;
      const a = base58Decode(first);
      const b = base58Decode(second);
      for (const spacing of TICK_SPACINGS) {
        const pda = findProgramAddress([enc.encode("whirlpool"), base58Decode(WHIRLPOOLS_CONFIG), a, b, u16le(spacing)], WHIRLPOOL_PROGRAM);
        if (pda) out2.push({ address: pda.address, program: WHIRLPOOL_PROGRAM, name: `Orca Whirlpool (spacing ${spacing})`, concentrated: true, layout: WHIRLPOOL_LAYOUT });
      }
      for (const index of CPMM_CONFIG_INDEXES) {
        const config = findProgramAddress([enc.encode("amm_config"), u16be(index)], CPMM_PROGRAM);
        if (!config) continue;
        const pda = findProgramAddress([enc.encode("pool"), base58Decode(config.address), a, b], CPMM_PROGRAM);
        if (pda) out2.push({ address: pda.address, program: CPMM_PROGRAM, name: "Raydium CPMM", concentrated: false, layout: CPMM_LAYOUT });
      }
    }
    return out2;
  }
  var QUOTES = {
    [WSOL]: { symbol: "SOL", decimals: 9 },
    [USDC]: { symbol: "USDC", decimals: 6 }
  };
  function pubkeyAt(data, offset) {
    if (data.length < offset + 32) return null;
    return base58Encode(data.slice(offset, offset + 32));
  }
  function u64At(data, offset) {
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = value << 8n | BigInt(data[offset + i] ?? 0);
    return value;
  }
  async function readDerivedPools(rpc, mint) {
    const candidates = deriveCandidates(mint);
    if (!candidates.length) return [];
    const accounts = await rpc.multipleAccounts(candidates.map((c) => c.address));
    const live = [];
    const vaultAddresses = [];
    candidates.forEach((candidate, i) => {
      const account = accounts[i];
      if (!account || account.owner !== candidate.program) return;
      const mintA = pubkeyAt(account.data, candidate.layout.mintA);
      const mintB = pubkeyAt(account.data, candidate.layout.mintB);
      if (mintA === null || mintB === null) return;
      const tokenIsA = mintA === mint;
      if (!tokenIsA && mintB !== mint) return;
      const quoteMint = tokenIsA ? mintB : mintA;
      if (!QUOTES[quoteMint]) return;
      const vaultToken = pubkeyAt(account.data, tokenIsA ? candidate.layout.vaultA : candidate.layout.vaultB);
      const vaultQuote = pubkeyAt(account.data, tokenIsA ? candidate.layout.vaultB : candidate.layout.vaultA);
      if (!vaultToken || !vaultQuote) return;
      live.push({ candidate, account, quoteMint, tokenIsA });
      vaultAddresses.push(vaultToken, vaultQuote);
    });
    if (!live.length) return [];
    const vaults = await rpc.multipleAccounts(vaultAddresses);
    const pools = [];
    live.forEach((entry, i) => {
      const tokenVault = vaults[i * 2];
      const quoteVault = vaults[i * 2 + 1];
      if (!tokenVault || !quoteVault) return;
      const quote = QUOTES[entry.quoteMint];
      pools.push({
        address: entry.candidate.address,
        program: entry.candidate.program,
        name: entry.candidate.name,
        concentrated: entry.candidate.concentrated,
        tokenReserve: u64At(tokenVault.data, 64),
        quoteMint: entry.quoteMint,
        quoteSymbol: quote.symbol,
        quoteDecimals: quote.decimals,
        quoteReserve: u64At(quoteVault.data, 64)
      });
    });
    return pools.sort((a, b) => b.quoteReserve > a.quoteReserve ? 1 : b.quoteReserve < a.quoteReserve ? -1 : 0);
  }

  // src/chain/solanaLiquidity.ts
  var CPMM_LP_MINT = 136;
  var CPMM_LP_DECIMALS = 330;
  var CPMM_LP_SUPPLY = 333;
  var ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  var BURN_OWNERS = {
    "1nc1nerator11111111111111111111111111111111": "the incinerator",
    "11111111111111111111111111111111": "the system address"
  };
  function u64At2(data, offset) {
    if (data.length < offset + 8) return 0n;
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = value << 8n | BigInt(data[offset + i] ?? 0);
    return value;
  }
  function pubkeyAt2(data, offset) {
    if (data.length < offset + 32) return null;
    return base58Encode(data.slice(offset, offset + 32));
  }
  function associatedTokenAddress(owner, mint) {
    try {
      const pda = findProgramAddress([base58Decode(owner), base58Decode(TOKEN_PROGRAM), base58Decode(mint)], ASSOCIATED_TOKEN_PROGRAM);
      return pda?.address ?? null;
    } catch {
      return null;
    }
  }
  var bps = (part, whole) => whole === 0n ? 0 : Number(part * 10000n / whole);
  async function readSolanaLock(rpc, pool, poolAccount) {
    const base = { pool: pool.address, name: pool.name, read: false, burnedBps: 0, strandedBps: 0, freeBps: 0, lpMint: null, shareOfLiquidityBps: 1e4, unread: "" };
    if (pool.program !== CPMM_PROGRAM) {
      return {
        ...base,
        unread: pool.concentrated ? `${pool.name} holds liquidity as NFT positions rather than LP tokens, and finding who owns them needs an account search no free endpoint answers, so whether it can be withdrawn was not read` : `${pool.name} is not a pool type BOUNCER can read liquidity ownership from`
      };
    }
    const account = poolAccount ?? await rpc.accountInfo(pool.address);
    if (!account) return { ...base, unread: "the pool account did not answer, so who holds its liquidity was not read" };
    const lpMint = pubkeyAt2(account.data, CPMM_LP_MINT);
    const issued = u64At2(account.data, CPMM_LP_SUPPLY);
    if (!lpMint) return { ...base, unread: "the pool account was shorter than its layout, so the LP token was not found" };
    if (issued === 0n) return { ...base, lpMint, unread: "the pool records no LP tokens issued, so there is no share to work out" };
    const burnAccounts = Object.keys(BURN_OWNERS).map((owner) => ({ owner, address: associatedTokenAddress(owner, lpMint) }));
    const wanted = [lpMint, ...burnAccounts.map((b) => b.address).filter((a) => a !== null)];
    let accounts;
    try {
      accounts = await rpc.multipleAccounts(wanted);
    } catch {
      return { ...base, lpMint, unread: "the LP token did not answer, so who holds this pool's liquidity was not read" };
    }
    const mintAccount = accounts[0];
    const mint = mintAccount ? parseMint(mintAccount) : null;
    if (!mint) return { ...base, lpMint, unread: "the LP token account could not be read, so how much of it still exists is unknown" };
    const alive = mint.supply;
    if (account.data[CPMM_LP_DECIMALS] !== mint.decimals) {
      return { ...base, lpMint, unread: "the pool's own record of its LP token disagrees with the LP token itself, so BOUNCER is not reading this pool's layout correctly and will not guess at it" };
    }
    if (alive > issued) {
      return { ...base, lpMint, unread: "more of this pool's LP token exists than the pool records issuing, which means one of the two numbers is not what BOUNCER thinks it is" };
    }
    const burned = issued - alive;
    let stranded = 0n;
    const strandedAt = [];
    burnAccounts.forEach((entry, i) => {
      if (!entry.address) return;
      const held = accounts[i + 1];
      if (!held) return;
      if (pubkeyAt2(held.data, 0) !== lpMint) return;
      const amount = u64At2(held.data, 64);
      if (amount === 0n) return;
      stranded += amount;
      strandedAt.push(BURN_OWNERS[entry.owner]);
    });
    const burnedBps = bps(burned, issued);
    const strandedBps = bps(stranded, issued);
    return {
      ...base,
      read: true,
      lpMint,
      burnedBps,
      strandedBps,
      freeBps: Math.max(0, 1e4 - burnedBps - strandedBps),
      // Naming the wallets that hold the rest would need the account search the
      // endpoints refuse. Not naming them does not make them harmless.
      unread: strandedAt.length ? `${strandedAt.join(" and ")} hold${strandedAt.length === 1 ? "s" : ""} LP tokens that can never move` : ""
    };
  }

  // src/chain/solanaPools.ts
  var PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  var POOL_PROGRAMS = {
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": { name: "Raydium AMM v4", concentrated: false },
    CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: { name: "Raydium CPMM", concentrated: false },
    CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: { name: "Raydium CLMM", concentrated: true },
    whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: { name: "Orca Whirlpool", concentrated: true },
    LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: { name: "Meteora DLMM", concentrated: true },
    Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: { name: "Meteora Dynamic AMM", concentrated: false },
    pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: { name: "pump.fun AMM", concentrated: false }
  };
  var enc2 = new TextEncoder();
  var u64 = (data, offset) => {
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = value << 8n | BigInt(data[offset + i] ?? 0);
    return value;
  };
  function pumpCurveAddress(mint) {
    let key;
    try {
      key = base58Decode(mint);
    } catch {
      return null;
    }
    if (key.length !== 32) return null;
    return findProgramAddress([enc2.encode("bonding-curve"), key], PUMP_PROGRAM)?.address ?? null;
  }
  function parsePumpCurve(address, account) {
    if (account.owner !== PUMP_PROGRAM) return null;
    if (account.data.length < 49) return null;
    return {
      address,
      virtualTokens: u64(account.data, 8),
      virtualSol: u64(account.data, 16),
      realTokens: u64(account.data, 24),
      realSol: u64(account.data, 32),
      complete: account.data[48] === 1
    };
  }
  var PUMP_FEE_BPS = 100n;
  function quoteCurveSale(curve, tokensIn) {
    if (tokensIn <= 0n || curve.virtualTokens === 0n || curve.virtualSol === 0n) return 0n;
    const k = curve.virtualSol * curve.virtualTokens;
    const solAfter = k / (curve.virtualTokens + tokensIn);
    const gross = curve.virtualSol > solAfter ? curve.virtualSol - solAfter : 0n;
    const capped = gross > curve.realSol ? curve.realSol : gross;
    return capped - capped * PUMP_FEE_BPS / 10000n;
  }
  function quotePoolSale(pool, tokensIn, feeBps = 25n) {
    if (tokensIn <= 0n || pool.tokenReserve === 0n || pool.quoteReserve === 0n) return 0n;
    const afterFee = tokensIn - tokensIn * feeBps / 10000n;
    return pool.quoteReserve * afterFee / (pool.tokenReserve + afterFee);
  }
  var QUOTES2 = {
    [WSOL]: { symbol: "SOL", decimals: 9 },
    [USDC]: { symbol: "USDC", decimals: 6 }
  };
  async function readSolanaPools(rpc, mint, scan) {
    const largest = scan?.largest ?? await rpc.largestAccounts(mint);
    if (!largest.length) return [];
    const accounts = scan?.accounts ?? await rpc.multipleAccounts(largest.map((l) => l.address));
    const authorities = [];
    for (const account of accounts) {
      if (!account || account.data.length < 72) continue;
      const authority = base58Encode(account.data.slice(32, 64));
      if (!authorities.includes(authority)) authorities.push(authority);
    }
    if (!authorities.length) return [];
    const authorityAccounts = await rpc.multipleAccounts(authorities);
    const candidates = [];
    for (let i = 0; i < authorities.length; i++) {
      const account = authorityAccounts[i];
      if (!account) continue;
      const program = POOL_PROGRAMS[account.owner];
      if (!program) continue;
      candidates.push({ authority: authorities[i], program: account.owner, name: program.name, concentrated: program.concentrated });
    }
    if (!candidates.length) return [];
    candidates.splice(6);
    const sides = await Promise.all(
      candidates.map((c) => rpc.tokenAccountsByOwner(c.authority).catch(() => null))
    );
    const pools = [];
    candidates.forEach((c, i) => {
      const vaults = sides[i];
      if (!vaults) return;
      const ours = vaults.find((v) => v.mint === mint);
      const other = vaults.find((v) => v.mint !== mint && QUOTES2[v.mint]);
      if (!ours || !other) return;
      const quote = QUOTES2[other.mint];
      pools.push({
        address: c.authority,
        program: c.program,
        name: c.name,
        concentrated: c.concentrated,
        tokenReserve: ours.amount,
        quoteMint: other.mint,
        quoteSymbol: quote.symbol,
        quoteDecimals: quote.decimals,
        quoteReserve: other.amount
      });
    });
    return pools.sort((a, b) => b.quoteReserve > a.quoteReserve ? 1 : b.quoteReserve < a.quoteReserve ? -1 : 0);
  }
  var SHARES = [1e3, 2500, 5e3, 1e4];
  async function readSolanaMarket(rpc, mint, position, tokenDecimals, scan) {
    const empty = { curve: null, pools: [], best: null, spot: null, quoteSymbol: "SOL", quotes: [], locks: [], note: "" };
    let curve = null;
    const curveAddress = pumpCurveAddress(mint);
    if (curveAddress) {
      try {
        const account = await rpc.accountInfo(curveAddress);
        if (account) curve = parsePumpCurve(curveAddress, account);
      } catch {
      }
    }
    if (curve && !curve.complete) {
      const scale2 = 10 ** tokenDecimals;
      const spot2 = curve.virtualTokens > 0n ? Number(curve.virtualSol) / 1e9 / (Number(curve.virtualTokens) / scale2) : null;
      const quotes2 = position > 0n ? priced(SHARES.map((b) => ({ shareBps: b, tokensIn: position * BigInt(b) / 10000n })), (t) => quoteCurveSale(curve, t), spot2, tokenDecimals, 9, curve.realSol) : [];
      return {
        curve,
        pools: [],
        best: { kind: "curve", name: "the pump.fun bonding curve" },
        spot: spot2,
        quoteSymbol: "SOL",
        quotes: quotes2,
        locks: [],
        note: "Priced on the pump.fun bonding curve's own virtual reserves, with its 1% fee, and capped at the SOL the curve actually holds. It has not graduated, so there is no pool yet."
      };
    }
    let pools = [];
    let derivedFailed = false;
    try {
      pools = await readDerivedPools(rpc, mint);
    } catch {
      derivedFailed = true;
    }
    if (scan || !pools.length) {
      try {
        const walked = await readSolanaPools(rpc, mint, scan);
        for (const p of walked) if (!pools.some((seen) => seen.address === p.address)) pools.push(p);
        pools.sort((a, b) => b.quoteReserve > a.quoteReserve ? 1 : b.quoteReserve < a.quoteReserve ? -1 : 0);
      } catch {
      }
    }
    if (!pools.length && derivedFailed) {
      return { ...empty, curve, note: "The pools could not be read from this endpoint." };
    }
    if (!pools.length) {
      const how = "Pools are found two ways: the address an Orca Whirlpool or Raydium CPMM pool for this pair would live at is worked out locally and read directly, and \u2014 when the endpoint serves it \u2014 the twenty largest accounts holding the mint are walked for vaults belonging to any other DEX. A venue with neither a derivable address nor a vault among the largest holders is not seen.";
      return { ...empty, curve, note: `${curve?.complete ? "The bonding curve has graduated, but no" : "No"} pool against SOL or USDC turned up. ${how}` };
    }
    const priceable = pools.filter((p) => !p.concentrated && p.tokenReserve > 0n && p.quoteReserve > 0n);
    const best = priceable[0] ?? null;
    if (!best) {
      return {
        ...empty,
        curve,
        pools,
        quoteSymbol: pools[0].quoteSymbol,
        locks: await readLocks(rpc, pools),
        note: `Found ${pools.length} pool${pools.length === 1 ? "" : "s"}, ${pools.every((p) => p.concentrated) ? "all of them concentrated" : "none of them priceable"}. A concentrated pool keeps its liquidity in ranges, so its vault balances are not what a trade moves through and pricing a sale from them would overstate it \u2014 the reserves are shown, the sale is not priced.`
      };
    }
    const scale = 10 ** tokenDecimals;
    const spot = Number(best.quoteReserve) / 10 ** best.quoteDecimals / (Number(best.tokenReserve) / scale);
    const quotes = position > 0n ? priced(SHARES.map((b) => ({ shareBps: b, tokensIn: position * BigInt(b) / 10000n })), (t) => quotePoolSale(best, t), spot, tokenDecimals, best.quoteDecimals, best.quoteReserve) : [];
    return {
      curve,
      pools,
      best: { kind: "pool", name: best.name },
      spot,
      quoteSymbol: best.quoteSymbol,
      quotes,
      locks: await readLocks(rpc, pools),
      note: marketNote(pools, best, quotes)
    };
  }
  async function readLocks(rpc, pools) {
    const wanted = [pools[0]];
    const withLp = pools.find((p) => !p.concentrated);
    if (withLp && withLp !== pools[0]) wanted.push(withLp);
    const totalFor = (quoteMint) => pools.filter((p) => p.quoteMint === quoteMint).reduce((a, p) => a + p.quoteReserve, 0n);
    const locks = [];
    for (const pool of wanted) {
      if (!pool) continue;
      try {
        const lock = await readSolanaLock(rpc, pool);
        const total = totalFor(pool.quoteMint);
        lock.shareOfLiquidityBps = total > 0n ? Number(pool.quoteReserve * 10000n / total) : 1e4;
        locks.push(lock);
      } catch {
      }
    }
    return locks;
  }
  function marketNote(pools, best, quotes) {
    const concentrated = pools.filter((p) => p.concentrated);
    const deepest = pools[0];
    const muchDeeper = deepest && deepest !== best && deepest.concentrated && best.quoteReserve > 0n && deepest.quoteReserve / best.quoteReserve >= 2n ? ` The deepest venue for this token is in fact a ${deepest.name}, holding about ${(Number(deepest.quoteReserve) / Number(best.quoteReserve)).toFixed(0)}x more ${deepest.quoteSymbol} than the pool priced here, and a real sale would mostly go through it \u2014 so treat the figures above as a floor from one pool rather than as what the market would pay.` : "";
    const drained = quotes.some((q2) => q2.drainsPool) ? " Sizes marked as emptying the pool take essentially all the quote asset it holds; that is the pool telling you it is too small for this position, not a price you would get." : "";
    return `Priced on the deepest constant-product pool (${best.name}) at a 0.25% fee${concentrated.length ? `; ${concentrated.length} concentrated pool${concentrated.length === 1 ? "" : "s"} found and deliberately not priced, since their vault balances are not what a trade moves through` : ""}.${muchDeeper}${drained} Pools against pairs other than SOL and USDC are not counted.`;
  }
  function priced(sizes, sell, spot, tokenDecimals, quoteDecimals, available) {
    return sizes.map(({ shareBps, tokensIn }) => {
      const out2 = sell(tokensIn);
      const atSpot = spot === null ? 0 : Number(tokensIn) / 10 ** tokenDecimals * spot;
      const got = Number(out2) / 10 ** quoteDecimals;
      return {
        shareBps,
        tokensIn,
        out: out2,
        realisedBps: atSpot > 0 ? Math.round(got / atSpot * 1e4) : 0,
        drainsPool: available > 0n && out2 * 100n >= available * 99n
      };
    });
  }

  // src/bouncer/spl.ts
  async function readSplDoor(rpc, input, chain2, options = {}) {
    if (!isSolanaAddress(input)) throw new Error(`${input} is not a Solana address`);
    const metadataPda = metadataAddress(input);
    const [{ slot, timestamp }, accounts] = await Promise.all([
      (async () => {
        const at = await rpc.slot();
        return { slot: at, timestamp: await rpc.blockTime(at) };
      })(),
      rpc.multipleAccounts(metadataPda ? [input, metadataPda] : [input]).catch(async () => [await rpc.accountInfo(input), null])
    ]);
    const slip = {
      chain: { key: chain2.key, name: chain2.name, family: "solana" },
      at: { slot, timestamp },
      subject: input,
      stamp: "NOT A LAUNCH",
      mint: null,
      whatItIs: null,
      metadata: null,
      metadataInline: false,
      holders: null,
      market: null,
      notes: [],
      skipped: []
    };
    const account = accounts[0] ?? null;
    if (!account) {
      slip.stamp = "NOT ON THE LIST";
      slip.notes = [{ level: "stop", code: "no-account", text: `There is no account at this address on ${chain2.name}.` }];
      return slip;
    }
    slip.mint = parseMint(account);
    if (!slip.mint) {
      slip.stamp = "NOT ON THE LIST";
      slip.whatItIs = describeAccount(account.owner, account.executable, account.data.length);
      slip.notes = [{ level: "stop", code: "not-a-mint", text: `This address is not a token: it is ${slip.whatItIs}. Paste the mint address, which is what a token is on Solana.` }];
      return slip;
    }
    const attempt = async (section2, run, deadlineMs) => {
      try {
        await (deadlineMs ? withDeadline(run(), deadlineMs, section2) : run());
      } catch (error) {
        slip.skipped.push({ section: section2, reason: reasonFor(error) });
      }
    };
    const inline = slip.mint.extensions.find((e) => e.kind === "token-metadata");
    if (inline && inline.kind === "token-metadata") {
      slip.metadataInline = true;
      slip.metadata = { updateAuthority: inline.updateAuthority ?? "", mint: input, name: inline.name, symbol: inline.symbol, uri: inline.uri, sellerFeeBasisPoints: 0, primarySaleHappened: false, isMutable: inline.updateAuthority !== null };
    }
    const readName = slip.metadata ? Promise.resolve() : attempt(
      "metadata",
      async () => {
        const metaAccount = metadataPda ? accounts[1] ?? null : null;
        if (metaAccount && metaAccount.owner === METADATA_PROGRAM) slip.metadata = parseMetadata(metaAccount);
      },
      options.deadlineMs ?? 8e3
    );
    let scan = null;
    const readScan = options.skipHolders ? Promise.resolve() : attempt(
      "holders",
      async () => {
        const largest = (await rpc.largestAccounts(input)).slice(0, options.topHolders ?? 20);
        if (!largest.length) {
          scan = { largest: [], accounts: [] };
          return;
        }
        let owners = [];
        try {
          owners = await rpc.multipleAccounts(largest.map((a) => a.address));
        } catch (error) {
          slip.skipped.push({ section: "holder owners", reason: error instanceof Error ? error.message : String(error) });
        }
        scan = { largest, accounts: owners };
      },
      options.deadlineMs ?? 15e3
    );
    await readScan;
    const readHolders = (async () => {
      const found = scan;
      if (!found) return;
      const largest = found.largest;
      if (!largest.length) {
        slip.holders = { top: [], top10Bps: null, distinctOwners: null };
        return;
      }
      const owners = found.accounts;
      const supply = slip.mint.supply;
      const top = largest.map((a, i) => ({
        account: a.address,
        owner: owners[i] ? tokenAccountOwner(owners[i]) : null,
        amount: a.amount,
        bps: supply > 0n ? Number(a.amount * 10000n / supply) : null
      }));
      const byOwner = /* @__PURE__ */ new Map();
      for (const h of top) {
        const key = h.owner ?? h.account;
        byOwner.set(key, (byOwner.get(key) ?? 0) + (h.bps ?? 0));
      }
      const ranked = [...byOwner.values()].sort((a, b) => b - a);
      slip.holders = {
        top,
        top10Bps: supply > 0n ? ranked.slice(0, 10).reduce((a, b) => a + b, 0) : null,
        distinctOwners: byOwner.size
      };
    })();
    const readMarket2 = options.skipMarket ? Promise.resolve() : attempt(
      "market",
      async () => {
        const supply = slip.mint.supply;
        const position = supply > 0n ? supply / 100n : 0n;
        slip.market = await readSolanaMarket(rpc, input, position, slip.mint.decimals, scan ?? void 0);
      },
      // Several round trips rather than one, and a public endpoint paces
      // them. The eight seconds the other sections get was killing this one
      // outright, which reads on the slip as "no venue" — the wrong answer.
      options.marketDeadlineMs ?? 25e3
    );
    await Promise.all([readName, readHolders, readMarket2]);
    slip.notes = splNotes(slip);
    return slip;
  }
  function reasonFor(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b429\b|rate limit|too many requests/i.test(message)) {
      return `the public endpoint rate-limited this read (${message}). Point BOUNCER at your own endpoint with RPC_URL_SOLANA to get it.`;
    }
    if (/blocked|forbidden|\b403\b/i.test(message)) return `the public endpoint refused this read (${message})`;
    return message;
  }
  async function withDeadline(work, ms, section2) {
    let timer;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the endpoint did not answer within ${ms / 1e3}s`)), ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  function describeAccount(owner, executable, size) {
    if (executable) return "an executable program";
    if (owner === "11111111111111111111111111111111") return "a wallet";
    if ((owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) && size >= 165) return "a token account, which is one wallet's holding of some token rather than the token itself";
    return `an account owned by the program ${short(owner)}`;
  }
  function short(address) {
    return address.length > 12 ? `${address.slice(0, 4)}\u2026${address.slice(-4)}` : address;
  }
  function pct(bps3) {
    return bps3 === null ? "an unknown share" : `${(bps3 / 100).toFixed(1)}%`;
  }
  function splNotes(slip) {
    const notes = [];
    const m = slip.mint;
    if (!m) return notes;
    const ext = (kind) => m.extensions.find((e) => e.kind === kind);
    notes.push({
      level: "info",
      code: "spl",
      text: `An SPL token on ${slip.chain.name}${m.token2022 ? ", using the Token-2022 program, which is where transfer fees, hooks and delegates live" : ""}. There is no launchpad registry to be on here, so this is the ordinary-token check: who can still change the rules, and who holds it.`
    });
    if (m.freezeAuthority) {
      notes.push({
        level: "stop",
        code: "freeze-authority",
        text: `${short(m.freezeAuthority)} can freeze any holder's account for this token. A frozen account cannot send, so it cannot sell. This is the plainest way a Solana token traps its holders, and it is a field on the mint, not a guess.`
      });
    } else {
      notes.push({ level: "info", code: "no-freeze", text: "Nobody can freeze a holder's account: the freeze authority is not set, and it cannot be added back." });
    }
    if (m.mintAuthority) {
      notes.push({
        level: "watch",
        code: "mint-authority",
        text: `${short(m.mintAuthority)} can print more of this token at will, diluting every holder. The supply shown is what exists now, not a cap.`
      });
    } else {
      notes.push({ level: "info", code: "no-mint", text: "The supply is fixed: the mint authority is not set, so no more can ever be printed." });
    }
    const defaultState = ext("default-account-state");
    if (defaultState?.kind === "default-account-state" && defaultState.frozen) {
      notes.push({ level: "stop", code: "frozen-by-default", text: "Every new holder's account starts frozen, so a buyer cannot sell until somebody unfreezes them one by one." });
    }
    if (ext("non-transferable")) {
      notes.push({ level: "stop", code: "non-transferable", text: "This token is marked non-transferable: it cannot be sent to anyone, so it cannot be sold at all." });
    }
    const delegate = ext("permanent-delegate");
    if (delegate?.kind === "permanent-delegate") {
      notes.push({ level: "stop", code: "permanent-delegate", text: `${short(delegate.delegate)} is a permanent delegate: it can move or burn this token out of any holder's account without their signature.` });
    }
    const hook = ext("transfer-hook");
    if (hook?.kind === "transfer-hook" && hook.programId) {
      notes.push({
        level: "watch",
        code: "transfer-hook",
        text: `Every transfer runs the program ${short(hook.programId)} first, and whatever that program does is not read here. It can make a transfer fail on its own terms.${hook.authority ? ` ${short(hook.authority)} can point the hook at a different program.` : ""}`
      });
    }
    const fee = ext("transfer-fee");
    if (fee?.kind === "transfer-fee") {
      const current = (fee.feeBps / 100).toFixed(2);
      const next = (fee.nextFeeBps / 100).toFixed(2);
      notes.push({
        level: fee.feeBps >= 500 || fee.nextFeeBps > fee.feeBps ? "watch" : "info",
        code: "transfer-fee",
        text: `Every transfer of this token pays ${current}% to the token itself${fee.nextFeeBps !== fee.feeBps ? `, changing to ${next}% at epoch ${fee.nextFeeEpoch}` : ""}. ` + (fee.feeAuthority ? `${short(fee.feeAuthority)} can change that fee.` : "The fee can no longer be changed: its authority is not set.") + (fee.withdrawAuthority ? ` ${short(fee.withdrawAuthority)} collects what has been withheld.` : "")
      });
    }
    const pausable = ext("pausable");
    if (pausable?.kind === "pausable") {
      notes.push({ level: "watch", code: "pausable", text: `${pausable.authority ? short(pausable.authority) : "Somebody"} can pause every transfer of this token.` });
    }
    const close = ext("mint-close-authority");
    if (close?.kind === "mint-close-authority") {
      notes.push({ level: "watch", code: "mint-close", text: `${short(close.authority)} can close the mint account once the supply reaches zero.` });
    }
    const interest = ext("interest-bearing");
    if (interest?.kind === "interest-bearing") {
      notes.push({ level: "info", code: "interest-bearing", text: `The balance a wallet displays grows at ${(interest.rateBps / 100).toFixed(2)}% a year by rule, without any tokens being minted. What you hold is the raw amount, not the displayed one.` });
    }
    for (const e of m.extensions) {
      if (e.kind === "other") notes.push({ level: "info", code: "extension-unknown", text: `The mint carries a Token-2022 extension BOUNCER does not read (type ${e.type}); what it does is not covered here.` });
    }
    if (slip.metadata) {
      if (slip.metadata.isMutable) {
        notes.push({
          level: "watch",
          code: "metadata-mutable",
          text: `The name, symbol and artwork can still be changed${slip.metadata.updateAuthority ? ` by ${short(slip.metadata.updateAuthority)}` : ""}. A token can be renamed into something it is not after you buy it.`
        });
      } else {
        notes.push({ level: "info", code: "metadata-frozen", text: "The name, symbol and artwork are frozen: nobody can rename this token." });
      }
    } else {
      notes.push({ level: "info", code: "no-metadata", text: "No Metaplex metadata account: this token has no on-chain name or symbol, only its mint address." });
    }
    const h = slip.holders;
    if (h && h.top.length) {
      if (h.top10Bps !== null && h.top10Bps >= 5e3) {
        notes.push({ level: "watch", code: "concentrated", text: `The 10 largest holders hold ${pct(h.top10Bps)} of supply, counted across the ${h.top.length} largest accounts and grouped by the wallet behind them.` });
      } else if (h.top10Bps !== null) {
        notes.push({ level: "info", code: "spread", text: `The 10 largest holders hold ${pct(h.top10Bps)} of supply, over ${h.distinctOwners} distinct wallets among the ${h.top.length} largest accounts.` });
      }
    } else if (h) {
      notes.push({ level: "watch", code: "no-holders", text: "The node returned no token accounts for this mint: nobody holds it." });
    }
    const mk = slip.market;
    if (mk) {
      const sol = (v) => (Number(v) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 });
      if (mk.curve && !mk.curve.complete) {
        notes.push({
          level: "watch",
          code: "on-the-curve",
          text: `This has not graduated: it trades against a pump.fun bonding curve holding ${sol(mk.curve.realSol)} SOL, not a pool. The curve is the only place to sell, its price is set by arithmetic rather than by anyone bidding, and it takes 1% of every sale.`
        });
      } else if (mk.curve?.complete && mk.pools.length === 0) {
        notes.push({ level: "watch", code: "graduated-no-pool", text: "The bonding curve has graduated, but no pool against SOL or USDC turned up among the largest accounts holding this mint. Until one does, there is nothing here to sell into." });
      }
      if (mk.pools.length) {
        const ranged = mk.pools.filter((p) => p.concentrated).length;
        notes.push({
          level: "info",
          code: "pools",
          text: `Trades in ${mk.pools.length} pool${mk.pools.length === 1 ? "" : "s"}: ${mk.pools.map((p) => p.name).join(", ")}.${ranged ? ` ${ranged} of them keep${ranged === 1 ? "s" : ""} liquidity in ranges, so their vault balances are not what a trade moves through and no sale is priced from them.` : ""}`
        });
      }
      const whole = mk.quotes.find((q2) => q2.shareBps === 1e4);
      if (whole && whole.realisedBps > 0 && whole.realisedBps < 5e3) {
        notes.push({
          level: "watch",
          code: "exit-thin",
          text: `Selling 1% of supply now would get only ${(whole.realisedBps / 100).toFixed(0)}% of the quoted price: the venue is thin enough that the sale moves it against you.`
        });
      }
      if (!mk.best) notes.push({ level: "watch", code: "no-venue", text: mk.note });
      for (const lock of mk.locks) {
        if (!lock.read) {
          notes.push({ level: "watch", code: "sol-liquidity-unread", text: `${lock.unread}. Treat this pool's liquidity as withdrawable until you have checked it yourself.` });
          continue;
        }
        const held = lock.burnedBps + lock.strandedBps;
        const sliver = lock.shareOfLiquidityBps < 1e3;
        const size = sliver ? ` That pool holds ${pct(lock.shareOfLiquidityBps)} of this token's readable liquidity, so it is not where a sale of any size would go.` : "";
        if (held === 0) {
          notes.push({
            level: sliver ? "info" : "stop",
            code: "sol-liquidity-free",
            text: `Every LP token of the ${lock.name} pool is still held by somebody: none of it was burned and none sits at an address with no key. Whoever holds it can withdraw the pool, and then there is nothing to sell into.${size}`
          });
        } else if (lock.freeBps >= 2e3) {
          notes.push({
            level: sliver ? "info" : "watch",
            code: "sol-liquidity-partly-free",
            text: `${pct(lock.freeBps)} of the ${lock.name} pool's LP tokens can still be withdrawn against (${pct(held)} is gone for good). Taking the rest out would thin the pool by that much.${size}`
          });
        } else {
          notes.push({
            level: "info",
            code: "sol-liquidity-held",
            text: `${pct(held)} of the ${lock.name} pool's LP tokens are gone for good${lock.burnedBps ? ` (${pct(lock.burnedBps)} burned)` : ""}${lock.strandedBps ? ` (${pct(lock.strandedBps)} at an address with no key)` : ""}, so that share of the liquidity stays put. That is not a promise about the price.`
          });
        }
      }
    }
    for (const s of slip.skipped) notes.push({ level: "info", code: "skipped", text: `${s.section} could not be read: ${s.reason}` });
    notes.push({
      level: "info",
      code: "venues-read",
      text: "Venues read here: the pump.fun bonding curve, and any Raydium, Orca, Meteora or pump.fun AMM pool that holds this mint among its largest accounts, paired against SOL or USDC. A pool against another pair, or on a venue not in that list, is not counted."
    });
    return notes;
  }

  // site/src/app.ts
  init_tape();

  // src/format.ts
  function formatUnits(value, decimals, maxFraction = 4) {
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    const fraction = abs % base;
    let fractionText = fraction.toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
    const wholeText = groupThousands(whole.toString());
    const text = fractionText ? `${wholeText}.${fractionText}` : wholeText;
    return negative ? `-${text}` : text;
  }
  function formatBps(bps3) {
    const whole = bps3 / 100n;
    const fraction = bps3 % 100n;
    return fraction === 0n ? `${whole}%` : `${whole}.${fraction.toString().padStart(2, "0").replace(/0$/, "")}%`;
  }
  function formatPercent(numerator, denominator, digits = 1) {
    if (denominator === 0n) return "n/a";
    const scaled = numerator * 10n ** BigInt(digits + 2) / denominator;
    const whole = scaled / 10n ** BigInt(digits);
    const fraction = scaled % 10n ** BigInt(digits);
    return digits === 0 ? `${whole}%` : `${whole}.${fraction.toString().padStart(digits, "0")}%`;
  }
  function shortAddress(address) {
    return `${address.slice(0, 6)}\u2026${address.slice(-4)}`;
  }
  function formatDuration(seconds) {
    if (seconds <= 0) return "0s";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor(seconds % 86400 / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = seconds % 60;
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m && !d) parts.push(`${m}m`);
    if (s && !d && !h) parts.push(`${s}s`);
    return parts.join(" ");
  }
  function isoUtc(unix) {
    return new Date(unix * 1e3).toISOString().replace(".000Z", "Z");
  }
  function groupThousands(digits) {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // src/bouncer/card.ts
  var CARD_COLORS = {
    ink: "#0b0b0f",
    panel: "#15151c",
    line: "#2a2a35",
    brass: "#d4a017",
    rope: "#c8102e",
    text: "#f2efe6",
    muted: "#8f8f9c",
    stop: "#ff4d5e",
    watch: "#e8b323",
    ok: "#39d98a",
    info: "#7f8ea3",
    dim: "#5e5a66"
  };
  function cardVerdict(notes) {
    const c = CARD_COLORS;
    const stop = notes.filter((n) => n.level === "stop").length;
    const watch = notes.filter((n) => n.level === "watch").length;
    if (stop) return { word: "STOP", color: c.stop, line: `${stop} thing${stop === 1 ? "" : "s"} here can cost you money outright` };
    if (watch) return { word: "WATCH", color: c.watch, line: `${watch} thing${watch === 1 ? "" : "s"} worth reading before you buy` };
    return { word: "CLEAR", color: c.ok, line: "nothing in what was read stands out" };
  }
  function facts(slip) {
    const o = slip.open;
    const out2 = [];
    if (o) {
      const owner = o.ownerUnread ? "UNREAD" : o.owner === null ? "NONE" : o.owner.renounced ? "RENOUNCED" : shortAddress(o.owner.address).toUpperCase();
      out2.push({ label: "OWNER", value: owner, bad: Boolean(o.owner && !o.owner.renounced) });
      const powers = o.powers.filter((p) => p.kind !== "exempt" && p.kind !== "sweep").length;
      out2.push({ label: "CODE CAN", value: String(powers), bad: powers > 0 });
      const sells = o.probes.filter((p) => p.target === "pool");
      const sale = !sells.length ? "NOT RUN" : sells.every((p) => p.status === "ok") ? "GOES THROUGH" : sells.some((p) => p.status === "reverts") ? "REVERTS" : "UNREAD";
      out2.push({ label: "SALE INTO POOL", value: sale, bad: sale === "REVERTS" });
      const top = o.holders?.top10WalletsBps ?? null;
      out2.push({ label: "TOP 10 WALLETS", value: top === null ? "UNKNOWN" : `${(top / 100).toFixed(0)}%`, bad: top !== null && top >= 5e3 });
    } else if (slip.rules) {
      out2.push({ label: "TRADE FEE", value: formatBps(slip.rules.totalTradeBps), bad: slip.rules.totalTradeBps >= 1e3 });
      out2.push({ label: "CREATOR TAX", value: formatBps(slip.rules.creatorTaxBps), bad: slip.rules.creatorTaxBps >= 500 });
      out2.push({ label: "DEV HOLDS", value: `${(slip.rules.deployerShareBps / 100).toFixed(1)}%`, bad: slip.rules.deployerShareBps >= 2e3 });
      out2.push({ label: "BUYBACK", value: slip.rules.buybackEnabled ? "VESTS" : "NONE", bad: slip.rules.buybackEnabled });
    }
    return out2.slice(0, 4);
  }
  function doorCard(slip, options) {
    const meta = slip.id.meta;
    return renderCard(
      {
        chain: slip.chain.name,
        at: `block ${slip.at.block}`,
        timestamp: slip.at.timestamp,
        ticker: meta ? clip(meta.symbol, 12) : shortAddress(slip.subject),
        name: meta ? clip(meta.name, 34) : slip.known ? "known contract" : "no name on chain",
        address: slip.subject,
        stamp: slip.stamp,
        notes: slip.notes,
        facts: facts(slip)
      },
      options
    );
  }
  function splCard(slip, options) {
    const m = slip.mint;
    const fee = m?.extensions.find((e) => e.kind === "transfer-fee");
    const top = slip.holders?.top10Bps ?? null;
    return renderCard(
      {
        chain: slip.chain.name,
        at: `slot ${slip.at.slot}`,
        timestamp: slip.at.timestamp,
        ticker: clip(slip.metadata?.symbol || shortAddress(slip.subject), 12),
        name: clip(slip.metadata?.name || slip.whatItIs || "no name on chain", 34),
        address: slip.subject,
        stamp: slip.stamp,
        notes: slip.notes,
        facts: [
          { label: "CAN THEY FREEZE YOU", value: m?.freezeAuthority ? "YES" : m ? "NO" : "UNREAD", bad: Boolean(m?.freezeAuthority) },
          { label: "CAN THEY PRINT MORE", value: m?.mintAuthority ? "YES" : m ? "NO" : "UNREAD", bad: Boolean(m?.mintAuthority) },
          {
            label: "TAX PER TRANSFER",
            value: fee?.kind === "transfer-fee" ? `${(fee.feeBps / 100).toFixed(2)}%` : m ? "0%" : "UNREAD",
            bad: fee?.kind === "transfer-fee" && fee.feeBps >= 500
          },
          { label: "TOP 10 HOLDERS", value: top === null ? "UNKNOWN" : `${(top / 100).toFixed(0)}%`, bad: top !== null && top >= 5e3 }
        ]
      },
      options
    );
  }
  function renderCard(model, options) {
    const c = CARD_COLORS;
    const v = cardVerdict(model.notes);
    const ticker2 = model.ticker;
    const name = model.name;
    const rank = { stop: 0, watch: 1, info: 2 };
    const shown = [...model.notes].sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 3);
    const tiles = model.facts.map((f, i) => {
      const x = 60 + i * 272;
      return `<g>
      <rect x="${x}" y="344" width="252" height="96" rx="12" fill="${c.ink}" stroke="${c.line}"/>
      <text x="${x + 18}" y="374" font-size="12" letter-spacing="2" fill="${c.muted}">${esc(f.label)}</text>
      <text x="${x + 18}" y="416" font-size="${f.value.length > 11 ? 21 : 29}" font-weight="700" fill="${f.bad ? c.stop : c.text}">${esc(f.value)}</text>
    </g>`;
    }).join("");
    const noteRows = shown.map((n, i) => {
      const y = 496 + i * 32;
      const color = n.level === "stop" ? c.stop : n.level === "watch" ? c.watch : c.info;
      return `<circle cx="66" cy="${y - 5}" r="5" fill="${color}"/><text x="86" y="${y}" font-size="17" fill="${n.level === "info" ? c.muted : c.text}">${esc(clip(n.text, 96))}</text>`;
    }).join("");
    const stamp = model.stamp;
    const stampColor = stamp === "ON THE LIST" ? c.brass : stamp === "NOT A LAUNCH" ? c.muted : c.stop;
    const stampWidth = stamp.length * 9.5 + 26;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">
  <rect width="1200" height="630" fill="${c.ink}"/>
  <rect x="24" y="24" width="1152" height="582" rx="20" fill="${c.panel}" stroke="${c.line}"/>
  <rect x="24" y="24" width="1152" height="5" rx="2.5" fill="${v.color}"/>

  <g transform="translate(56 50) scale(1.05)">${options.mascotSvg}</g>
  <text x="112" y="70" font-size="22" font-weight="700" letter-spacing="6" fill="${c.brass}">BOUNCER</text>
  <text x="112" y="92" font-size="13" fill="${c.dim}">read-only \xB7 no key \xB7 no signer</text>
  <text x="1144" y="70" text-anchor="end" font-size="15" fill="${c.muted}">${esc(model.chain)} \xB7 ${esc(model.at)}</text>
  <text x="1144" y="92" text-anchor="end" font-size="13" fill="${c.dim}">${model.timestamp ? esc(isoUtc(model.timestamp)) : ""}</text>
  <line x1="56" y1="116" x2="1144" y2="116" stroke="${c.line}"/>

  <text x="60" y="168" font-size="42" font-weight="800" fill="${c.text}">${esc(ticker2)}</text>
  <text x="60" y="200" font-size="20" fill="${c.muted}">${esc(name)}</text>
  <g transform="translate(${1144 - stampWidth} 142)">
    <rect x="0" y="0" width="${stampWidth}" height="30" rx="15" fill="none" stroke="${stampColor}"/>
    <text x="${stampWidth / 2}" y="20" text-anchor="middle" font-size="13" font-weight="700" letter-spacing="2" fill="${stampColor}">${esc(stamp)}</text>
  </g>
  <text x="1144" y="200" text-anchor="end" font-size="15" fill="${c.dim}">${esc(model.address)}</text>

  <text x="60" y="296" font-size="76" font-weight="800" letter-spacing="1" fill="${v.color}">${v.word}</text>
  <text x="${60 + v.word.length * 46 + 34}" y="284" font-size="20" fill="${c.text}">${esc(v.line)}</text>
  <text x="${60 + v.word.length * 46 + 34}" y="310" font-size="15" fill="${c.dim}">read at one block \xB7 nothing here is advice</text>

  ${tiles}

  <line x1="60" y1="470" x2="1140" y2="470" stroke="${c.line}"/>
  ${noteRows}

  <text x="60" y="588" font-size="15" fill="${c.muted}">${esc(options.checkUrl ?? options.repoUrl)}</text>
  <text x="1144" y="588" text-anchor="end" font-size="15" fill="${c.dim}">check it yourself before you buy \xB7 ${esc(options.ticker)}</text>
</svg>
`;
  }
  function esc(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function clip(text, max) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    return `${(space > max - 18 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
  }

  // src/bouncer/coverCharge.ts
  init_abi();
  init_tape();
  async function readCoverCharge(rpc, launch, options) {
    const factory = options.factory ?? PONS_V2_FACTORY;
    const head = options.head;
    const [startRaw, secondsRaw] = await rpc.callBatch(
      [
        { to: factory, data: encodeCall(FACTORY_FUNCTIONS.snipeTaxStartBps, []) },
        { to: factory, data: encodeCall(FACTORY_FUNCTIONS.snipeTaxSeconds, []) }
      ],
      head.number
    );
    const startBps = decodeOutputs(FACTORY_FUNCTIONS.snipeTaxStartBps, startRaw)[0];
    const seconds = Number(decodeOutputs(FACTORY_FUNCTIONS.snipeTaxSeconds, secondsRaw)[0]);
    const launchHeader = await rpc.getBlock(options.launchBlock);
    const secondsSinceLaunch = Math.max(0, head.timestamp - launchHeader.timestamp);
    const windowEndsAt = launchHeader.timestamp + seconds;
    const status2 = startBps === 0n ? "disabled" : head.timestamp < windowEndsAt ? "open" : "closed";
    const secondsLeft = status2 === "open" ? windowEndsAt - head.timestamp : 0;
    const retunes = await readTape(rpc, {
      fromBlock: options.launchBlock,
      toBlock: head.number,
      address: factory,
      events: [FACTORY_EVENTS.SnipeTaxStartBpsUpdated, FACTORY_EVENTS.SnipeTaxSecondsUpdated],
      chunkSize: options.chunkSize ?? 1e5
    });
    const blocksPerSecond = blockRate(launchHeader, head);
    const spanBlocks = Math.max(1, Math.ceil(seconds * blocksPerSecond * 2) + 10);
    const spanEnd = Math.min(head.number, options.launchBlock + spanBlocks);
    const spanHeader = spanEnd === head.number ? head : await rpc.getBlock(spanEnd);
    const secondsPerBlock = spanEnd > options.launchBlock ? (spanHeader.timestamp - launchHeader.timestamp) / (spanEnd - options.launchBlock) : 0;
    const tape = await readTape(rpc, {
      fromBlock: options.launchBlock,
      toBlock: spanEnd,
      address: launch.curve,
      events: [CURVE_EVENTS.CurveBuy],
      chunkSize: options.chunkSize ?? 1e5
    });
    const creatorWallets = /* @__PURE__ */ new Set([launch.deployer.toLowerCase(), launch.creatorFeeRecipient.toLowerCase()]);
    const observed = [];
    for (const log of tape.logs) {
      const secondsAfterLaunch = (log.blockNumber - options.launchBlock) * secondsPerBlock;
      if (secondsAfterLaunch > seconds) continue;
      const quoteIn = log.args.quoteIn;
      const fee = log.args.fee;
      const tax = log.args.tax;
      const buyer2 = String(log.args.buyer).toLowerCase();
      observed.push({
        block: log.blockNumber,
        secondsAfterLaunch: Math.round(secondsAfterLaunch * 10) / 10,
        buyer: buyer2,
        recipient: String(log.args.recipient).toLowerCase(),
        quoteIn,
        fee,
        tax,
        chargeBps: quoteIn === 0n ? 0 : Number((fee + tax) * 10000n / quoteIn),
        creatorWallet: creatorWallets.has(buyer2)
      });
    }
    return {
      terms: { startBps, seconds },
      termsChangedSinceLaunch: retunes.logs.length > 0,
      launch: { block: launchHeader.number, timestamp: launchHeader.timestamp },
      head: { block: head.number, timestamp: head.timestamp },
      windowEndsAt,
      status: status2,
      secondsLeft,
      secondsSinceLaunch,
      observed
    };
  }
  function blockRate(a, b) {
    const blocks = b.number - a.number;
    const seconds = b.timestamp - a.timestamp;
    if (blocks <= 0 || seconds <= 0) return 10;
    return blocks / seconds;
  }
  function coverChargeLine(c) {
    if (c.status === "disabled") return "disabled at the factory when this launch was created";
    if (c.status === "open") return `open \xB7 ${c.secondsLeft} s left \xB7 up to ${Number(c.terms.startBps) / 100}% on a buy right now`;
    const taxed = c.observed.filter((b) => !b.creatorWallet);
    const paid = taxed.length ? ` \xB7 ${taxed.length} paid at the door, highest ${(Math.max(...taxed.map((b) => b.chargeBps)) / 100).toFixed(1)}%` : "";
    return `closed \xB7 ${c.observed.length} buy${c.observed.length === 1 ? "" : "s"} inside the ${c.terms.seconds} s window${paid}`;
  }

  // src/bouncer/demo.ts
  init_abi();

  // src/chain/code.ts
  init_keccak();
  var OP_SELFDESTRUCT = 255;
  var OP_DELEGATECALL = 244;
  var OP_CALLCODE = 242;
  var OP_CREATE = 240;
  var OP_CREATE2 = 245;
  var OP_PUSH1 = 96;
  var OP_PUSH32 = 127;
  var EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  var EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
  function scanBytecode(code) {
    const bytes = hexToBytes(code);
    const read = readSelectors(code);
    const scan = {
      bytes: bytes.length,
      codeHash: keccak256Hex(bytes),
      empty: bytes.length === 0,
      metadataBytes: metadataTrailerLength(bytes),
      opcodes: { selfdestruct: 0, delegatecall: 0, callcode: 0, create: 0, create2: 0 },
      minimalProxyTarget: minimalProxyTarget(bytes),
      selectors: read.all,
      dispatcherSelectors: read.push4,
      delegatedTo: delegationTarget(bytes)
    };
    const end = bytes.length - scan.metadataBytes;
    for (let i = 0; i < end; i++) {
      const op = bytes[i];
      if (op >= OP_PUSH1 && op <= OP_PUSH32) {
        i += op - OP_PUSH1 + 1;
        continue;
      }
      if (op === OP_SELFDESTRUCT) scan.opcodes.selfdestruct++;
      else if (op === OP_DELEGATECALL) scan.opcodes.delegatecall++;
      else if (op === OP_CALLCODE) scan.opcodes.callcode++;
      else if (op === OP_CREATE) scan.opcodes.create++;
      else if (op === OP_CREATE2) scan.opcodes.create2++;
    }
    return scan;
  }
  function metadataTrailerLength(bytes) {
    if (bytes.length < 4) return 0;
    const length = bytes[bytes.length - 2] << 8 | bytes[bytes.length - 1];
    if (length === 0 || length + 2 > bytes.length) return 0;
    const start = bytes.length - 2 - length;
    const first = bytes[start];
    if (first < 161 || first > 163) return 0;
    const keyHeader = bytes[start + 1];
    if (keyHeader === void 0 || keyHeader < 97 || keyHeader > 111) return 0;
    const keyLength = keyHeader - 96;
    for (let i = 0; i < keyLength; i++) {
      const c = bytes[start + 2 + i];
      if (c === void 0 || !(c >= 97 && c <= 122 || c >= 48 && c <= 57)) return 0;
    }
    return length + 2;
  }
  function delegationTarget(bytes) {
    if (bytes.length !== 23 || bytes[0] !== 239 || bytes[1] !== 1 || bytes[2] !== 0) return null;
    return `0x${Array.from(bytes.slice(3), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  var MINIMAL_PROXY_PREFIX = "363d3d373d3d3d363d73";
  var MINIMAL_PROXY_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
  function minimalProxyTarget(bytes) {
    if (bytes.length !== 45) return null;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (!hex.startsWith(MINIMAL_PROXY_PREFIX) || !hex.endsWith(MINIMAL_PROXY_SUFFIX)) return null;
    return `0x${hex.slice(MINIMAL_PROXY_PREFIX.length, MINIMAL_PROXY_PREFIX.length + 40)}`;
  }
  function storageWordIsSet(word) {
    return /[1-9a-f]/i.test(word.replace(/^0x/, ""));
  }
  function storageWordAddress(word) {
    return `0x${word.replace(/^0x/, "").padStart(64, "0").slice(24)}`;
  }
  function readSelectors(code) {
    const bytes = hexToBytes(code);
    const end = bytes.length - metadataTrailerLength(bytes);
    const all = /* @__PURE__ */ new Set();
    const push4 = /* @__PURE__ */ new Set();
    for (let i = 0; i < end; i++) {
      const op = bytes[i];
      if (op < OP_PUSH1 || op > OP_PUSH32) continue;
      const size = op - OP_PUSH1 + 1;
      if (size <= 4 && i + size < end) {
        let hex = "";
        for (let j = 1; j <= size; j++) hex += bytes[i + j].toString(16).padStart(2, "0");
        const padded = `0x${hex.padStart(8, "0")}`;
        all.add(padded);
        if (size === 4) push4.add(padded);
      }
      i += size;
    }
    return { all, push4 };
  }

  // src/bouncer/demo.ts
  init_keccak();

  // src/bouncer/exitDoor.ts
  init_abi();
  init_keccak();
  var POOLS_SLOT = 6n;
  var Q96 = 2n ** 96n;
  function poolIdFor(token, pairToken, fee, tickSpacing, hooks) {
    const a = BigInt(token);
    const b = BigInt(pairToken);
    const tokenIsCurrency0 = a < b;
    const [c0, c1] = tokenIsCurrency0 ? [token, pairToken] : [pairToken, token];
    const encoded = `0x${encodeWord("address", c0)}${encodeWord("address", c1)}${encodeWord("uint24", fee)}${encodeWord("int24", tickSpacing)}${encodeWord("address", hooks)}`;
    return { poolId: keccak256Hex(hexToBytes2(encoded)), tokenIsCurrency0 };
  }
  function hexToBytes2(hex) {
    const clean2 = hex.replace(/^0x/, "");
    const out2 = new Uint8Array(clean2.length / 2);
    for (let i = 0; i < out2.length; i++) out2[i] = parseInt(clean2.slice(i * 2, i * 2 + 2), 16);
    return out2;
  }
  async function readPoolState(rpc, poolManager, launch, hooks, block) {
    const { poolId, tokenIsCurrency0 } = poolIdFor(launch.token, launch.pairToken, launch.poolFee, launch.tickSpacing, hooks);
    const stateSlot = keccak256Hex(hexToBytes2(`0x${poolId.slice(2)}${encodeWord("uint256", POOLS_SLOT)}`));
    const liquiditySlot = `0x${(BigInt(stateSlot) + 3n).toString(16).padStart(64, "0")}`;
    const [slot0Raw, liquidityRaw] = await rpc.callBatch(
      [
        { to: poolManager, data: encodeCall(POOL_MANAGER_EXTSLOAD, [stateSlot]) },
        { to: poolManager, data: encodeCall(POOL_MANAGER_EXTSLOAD, [liquiditySlot]) }
      ],
      block
    );
    const slot0 = BigInt(slot0Raw);
    const sqrtPriceX96 = slot0 & (1n << 160n) - 1n;
    const liquidity = BigInt(liquidityRaw) & (1n << 128n) - 1n;
    return { poolId, sqrtPriceX96, liquidity, tokenIsCurrency0 };
  }
  var POOL_MANAGER_EXTSLOAD = { name: "extsload", inputs: ["bytes32"], outputs: ["bytes32"] };
  function fullRangeReserves(state) {
    if (state.sqrtPriceX96 === 0n || state.liquidity === 0n) return { token: 0n, quote: 0n };
    const amount0 = state.liquidity * Q96 / state.sqrtPriceX96;
    const amount1 = state.liquidity * state.sqrtPriceX96 / Q96;
    return state.tokenIsCurrency0 ? { token: amount0, quote: amount1 } : { token: amount1, quote: amount0 };
  }
  function quoteExit(position, reserves, feeBps, creatorTaxBps, shares = [1e3, 2500, 5e3, 1e4]) {
    const spot = reserves.token === 0n ? 0n : reserves.quote * 10n ** 18n / reserves.token;
    return shares.map((shareBps) => {
      const tokensIn = position * BigInt(shareBps) / 10000n;
      const gross = curveAmountOut(tokensIn, reserves.token, reserves.quote, 0n);
      const fee = gross * feeBps / 10000n;
      const tax = gross * creatorTaxBps / 10000n;
      const net = gross - fee - tax;
      const atSpot = tokensIn * spot / 10n ** 18n;
      return { shareBps, tokensIn, gross, fee, tax, net, realisedBps: atSpot === 0n ? 0 : Number(net * 10000n / atSpot) };
    });
  }
  async function readExitDoor(rpc, launch, options) {
    if (launch.phase === 0 /* NotGraduated */) {
      const [reservesRaw, feeRaw, readyRaw] = await rpc.callBatch(
        [
          { to: launch.curve, data: encodeCall(CURVE_FUNCTIONS.getReserves, []) },
          { to: launch.curve, data: encodeCall(CURVE_FUNCTIONS.feeBps, []) },
          { to: launch.curve, data: encodeCall(CURVE_FUNCTIONS.readyToGraduate, []) }
        ],
        options.block
      );
      const [quote, token] = decodeOutputs(CURVE_FUNCTIONS.getReserves, reservesRaw);
      const [feeBps] = decodeOutputs(CURVE_FUNCTIONS.feeBps, feeRaw);
      const [ready] = decodeOutputs(CURVE_FUNCTIONS.readyToGraduate, readyRaw);
      const reserves2 = { token, quote };
      const quotes2 = quoteExit(options.position, reserves2, feeBps, launch.creatorTaxBps);
      return {
        venue: ready ? "closed" : "curve",
        position: options.position,
        reserves: reserves2,
        feeBps,
        creatorTaxBps: launch.creatorTaxBps,
        spot: token === 0n ? 0n : quote * 10n ** 18n / token,
        quotes: quotes2,
        note: ready ? "The curve is full and waiting for graduate(); sells revert until the pool exists. Anyone can call graduate()." : "Priced with the curve's own sell arithmetic on reserves at this block: constant product, then protocol fee and creator tax on the quote leg."
      };
    }
    if (launch.phase === 1 /* Swept */) {
      return { venue: "closed", position: options.position, reserves: { token: 0n, quote: 0n }, feeBps: 0n, creatorTaxBps: launch.creatorTaxBps, spot: 0n, quotes: [], note: "Swept, pool not created yet: nothing trades until the factory seeds the pool." };
    }
    const [pmRaw, hookRaw] = await rpc.callBatch(
      [
        { to: options.factory, data: encodeCall(FACTORY_FUNCTIONS.poolManager, []) },
        { to: options.factory, data: encodeCall(FACTORY_FUNCTIONS.memeHook, []) }
      ],
      options.block
    );
    const [poolManager] = decodeOutputs(FACTORY_FUNCTIONS.poolManager, pmRaw);
    const [hook] = decodeOutputs(FACTORY_FUNCTIONS.memeHook, hookRaw);
    const state = await readPoolState(rpc, poolManager, launch, hook, options.block);
    const reserves = fullRangeReserves(state);
    let hookFeeBps = 0n;
    try {
      const [policyRaw] = await rpc.callBatch([{ to: hook, data: encodeCall(HOOK_FUNCTIONS.currentFeePolicy, []) }], options.block);
      hookFeeBps = decodeOutputs(HOOK_FUNCTIONS.currentFeePolicy, policyRaw)[3];
    } catch {
      hookFeeBps = 0n;
    }
    const quotes = quoteExit(options.position, reserves, hookFeeBps, launch.creatorTaxBps);
    return {
      venue: "pool",
      position: options.position,
      reserves,
      feeBps: hookFeeBps,
      creatorTaxBps: launch.creatorTaxBps,
      spot: reserves.token === 0n ? 0n : reserves.quote * 10n ** 18n / reserves.token,
      quotes,
      note: `Estimate on the graduated pool: full-range liquidity and price read from PoolManager storage at this block, hook fee ${Number(hookFeeBps) / 100}% (live policy) and creator tax on the quote leg. Other LPs and concentrated positions, if any, are not modelled.`
    };
  }

  // src/bouncer/demo.ts
  init_tape();
  var ETH = 10n ** 18n;
  var HEAD = 31337500;
  var DEV_A = "0x0000000000000000000000000000000000d0e5e1";
  var DEV_B = "0x00000000000000000000000000000000000000b7";
  var DEV_C = "0x000000000000000000000000000000000000c0c0";
  var buyer = (n) => `0x${(45056 + n).toString(16).padStart(40, "0")}`;
  var DEMO_POOL_MANAGER = "0x00000000000000000000000000000000000900a1";
  var DEMO_HOOK = "0x0000000000000000000000000000000000900c00";
  var DEMO_FUNDER = "0x000000000000000000000000000000000000feed";
  var DEMO_BLOCKSCOUT = "https://demo.blockscout.invalid";
  var DEMO_V1 = { token: "0x0000000000000000000000000000000000001d1e", deployer: "0x00000000000000000000000000000000000001d1", positionId: 777n, restrictionsEndBlock: BigInt(HEAD + 40), name: "Old School", symbol: "OLDIE" };
  var DEMO_IMPOSTOR = {
    token: "0x00000000000000000000000000000000000bad01",
    implementation: "0x00000000000000000000000000000000000bad02",
    deployer: "0x00000000000000000000000000000000000bad03",
    creationTx: "0xdemoimpostorcreate",
    /** Deployed after the real SPRINT launch, which is what makes it the copy. */
    createdAt: HEAD - 900
  };
  var DEMO_PLAIN = {
    token: "0x0000000000000000000000000000000000f1a1a1",
    owner: "0x00000000000000000000000000000000000000f1",
    pool: "0x000000000000000000000000000000000000900f",
    name: "Robin Rocket",
    symbol: "ROCKET",
    createdAt: HEAD - 5e4,
    creationTx: "0xdemoplaincreate",
    supply: 10n ** 27n,
    /** [holder, share in bps, is contract, explorer label, EIP-7702 delegated]. */
    holders: [
      ["0x000000000000000000000000000000000000900f", 3e3, true, "UniswapV3Pool", false],
      ["0x00000000000000000000000000000000000000f1", 2500, false, null, false],
      ["0x000000000000000000000000000000000000c500", 800, false, null, false],
      ["0x000000000000000000000000000000000000c501", 500, false, null, false],
      ["0x000000000000000000000000000000000000c502", 300, false, null, false],
      // A wallet whose owner signed an EIP-7702 delegation. The explorer calls it a
      // contract; it is a person, and counting it as a pool would understate how
      // concentrated this token is.
      ["0x000000000000000000000000000000000000c503", 400, true, null, true],
      ["0x000000000000000000000000000000000000dead", 200, false, null, false]
    ],
    blacklisted: "0x000000000000000000000000000000000000c501",
    /** What the pool holds in the wrapped native coin. */
    poolWeth: 12n * 10n ** 18n,
    /** Every function in the dispatcher, not only the dangerous ones. */
    powers: ["mint(address,uint256)", "pause()", "unpause()", "paused()", "owner()", "renounceOwnership()", "transferOwnership(address)", "setFees(uint256,uint256)", "blacklist(address,bool)", "tradingOpen()", "excludeFromFees(address,bool)", "transfer(address,uint256)", "balanceOf(address)", "totalSupply()", "name()", "symbol()", "decimals()"]
  };
  var freshBuys = [[1, DEV_C, 400n * 10n ** 15n], [22, buyer(900), 300n * 10n ** 15n, 6e3], [70, buyer(901), 100n * 10n ** 15n, 1900]];
  var sprintBuys = [[3, DEV_A, 2600n * 10n ** 15n]];
  for (let i = 1; i <= 8; i++) sprintBuys.push([100 + i * 250, buyer(i), 200n * 10n ** 15n]);
  var slowBuys = [[10, DEV_B, 340n * 10n ** 15n]];
  for (let i = 1; i <= 39; i++) slowBuys.push([600 + i * 900, buyer(100 + i), 100n * 10n ** 15n]);
  var DEMO = {
    head: HEAD,
    genesisTimestamp: 1789430400 - HEAD * 0.1,
    threshold: 42n * 10n ** 17n,
    tokens: {
      sprint: { token: "0x00c0ffee0000000000000000000000000000600d", curve: "0x0000c0a70000000000000000000000000000600d", deployer: DEV_A, name: "Sprint", symbol: "SPRINT", launched: HEAD - 2600, swept: HEAD - 2600 + 2120, graduated: HEAD - 2600 + 2121, raised: 42n * 10n ** 17n, supplyToPool: 2n * 10n ** 26n, positionId: 4663n, taxBps: 300n, real: 42n * 10n ** 17n, tokenReserve: 0n, buys: sprintBuys, sells: [], recipientMoves: [[2300, "0x000000000000000000000000000000000000f0f0"]] },
      slow: { token: "0x0000000000000000000000000000000000005107", curve: "0x0000c0a70000000000000000000000000000a107", deployer: DEV_B, name: "Slow and Steady", symbol: "SLOW", launched: HEAD - 4e4, swept: HEAD - 2800, graduated: HEAD - 2799, raised: 42n * 10n ** 17n, supplyToPool: 2n * 10n ** 26n, positionId: 4664n, taxBps: 100n, real: 42n * 10n ** 17n, tokenReserve: 0n, buys: slowBuys, sells: [[2e4, buyer(105), 50n * 10n ** 15n]] },
      late: { token: "0x00000000000000000000000000000000000000a7", curve: "0x0000c0a7000000000000000000000000000000a7", deployer: DEV_B, name: "Late Bloomer", symbol: "LATE", launched: HEAD - 17500, raised: 0n, taxBps: 200n, real: 31n * 10n ** 17n, tokenReserve: 3n * 10n ** 26n, buys: Array.from({ length: 60 }, (_, i) => [i * 290, buyer(200 + i % 25), 50n * 10n ** 15n]), sells: [[9e3, buyer(201), 20n * 10n ** 15n], [15e3, buyer(202), 20n * 10n ** 15n], [17450, DEV_B, 40n * 10n ** 15n]], buybackFlips: [[17470, false]], transfers: [[17400, DEV_B, "0x0000000000000000000000000000000000000ca5", 10n ** 25n], [17450, DEV_B, "0x0000c0a7000000000000000000000000000000a7", 2n * 10n ** 24n]] },
      fresh: { token: "0x00000000000000000000000000000000000f2e54", curve: "0x0000c0a7000000000000000000000000000f2e54", deployer: DEV_C, name: "Fresh Off The Curve", symbol: "FRESH", launched: HEAD - 90, raised: 0n, taxBps: 1000n, real: 8n * 10n ** 17n, tokenReserve: 8n * 10n ** 26n, buys: freshBuys, sells: [[85, buyer(900), 120n * 10n ** 15n], [88, buyer(901), 40n * 10n ** 15n]] },
      nap: { token: "0x0000000000000000000000000000000000000d0e", curve: "0x0000c0a70000000000000000000000000000ad0e", deployer: DEV_B, name: "Nap Time", symbol: "NAP", launched: HEAD - 237500, raised: 0n, taxBps: 500n, real: 3n * 10n ** 17n, tokenReserve: 9n * 10n ** 26n, buys: [[5, DEV_B, 300n * 10n ** 15n]], sells: [] }
    }
  };
  function encodeString(value) {
    const bytes = new TextEncoder().encode(value);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return [encodeWord("uint256", 32n), encodeWord("uint256", BigInt(bytes.length)), hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")].join("");
  }
  function blockTime(block) {
    return DEMO.genesisTimestamp + block * 0.1;
  }
  function launchedRecord(t) {
    const phase = t.graduated ? 2n : t.swept ? 1n : 0n;
    return [
      encodeWord("address", t.token),
      encodeWord("address", t.curve),
      encodeWord("address", t.deployer),
      encodeWord("address", t.deployer),
      encodeWord("address", ZERO_ADDRESS),
      encodeWord("uint256", DEMO.threshold),
      encodeWord("uint24", 10000n),
      encodeWord("int24", 200n),
      encodeWord("uint16", t.taxBps),
      encodeWord("bool", true),
      encodeWord("uint8", phase),
      encodeWord("uint256", t.graduated ? t.raised : 0n),
      encodeWord("uint256", t.graduated ? t.supplyToPool ?? 0n : 0n),
      encodeWord("uint256", t.swept ? BigInt(Math.round(blockTime(t.swept))) : 0n),
      encodeWord("bool", true)
    ].join("");
  }
  function factoryLogs(from, to) {
    const logs = [];
    for (const t of Object.values(DEMO.tokens)) {
      if (t.launched >= from && t.launched <= to) {
        logs.push({ address: PONS_V2_FACTORY, topics: [eventTopic(FACTORY_EVENTS.TokenLaunched), addressTopic(t.token), addressTopic(t.curve), addressTopic(t.deployer)], data: `0x${encodeWord("address", ZERO_ADDRESS)}${encodeWord("uint256", 1n)}${encodeWord("uint256", DEMO.threshold)}`, blockNumber: `0x${t.launched.toString(16)}`, transactionHash: `0xdemo${t.symbol.toLowerCase()}launch`, logIndex: "0x0" });
      }
      if (t.swept && t.swept >= from && t.swept <= to) {
        logs.push({ address: PONS_V2_FACTORY, topics: [eventTopic(FACTORY_EVENTS.LaunchSwept), addressTopic(t.token)], data: `0x${encodeWord("uint256", t.raised)}${encodeWord("uint256", t.supplyToPool ?? 0n)}`, blockNumber: `0x${t.swept.toString(16)}`, transactionHash: `0xdemo${t.symbol.toLowerCase()}sweep`, logIndex: "0x1" });
      }
      for (const [offset, enabled] of t.buybackFlips ?? []) {
        const b = t.launched + offset;
        if (b < from || b > to) continue;
        logs.push({ address: PONS_V2_FACTORY, topics: [eventTopic(FACTORY_EVENTS.BuybackEnabledUpdated), addressTopic(t.token), addressTopic(t.deployer)], data: `0x${encodeWord("bool", enabled)}`, blockNumber: `0x${b.toString(16)}`, transactionHash: `0xdemo${t.symbol.toLowerCase()}buyback${b}`, logIndex: "0x4" });
      }
      for (const [offset, to_] of t.recipientMoves ?? []) {
        const b = t.launched + offset;
        if (b < from || b > to) continue;
        logs.push({ address: PONS_V2_FACTORY, topics: [eventTopic(FACTORY_EVENTS.CreatorFeeRecipientUpdated), addressTopic(t.token), addressTopic(t.deployer), addressTopic(to_)], data: "0x", blockNumber: `0x${b.toString(16)}`, transactionHash: `0xdemo${t.symbol.toLowerCase()}move`, logIndex: "0x3" });
      }
      if (t.graduated && t.graduated >= from && t.graduated <= to) {
        logs.push({ address: PONS_V2_FACTORY, topics: [eventTopic(FACTORY_EVENTS.PoolGraduated), addressTopic(t.token)], data: `0x${encodeWord("uint256", t.positionId ?? 0n)}${encodeWord("uint256", t.supplyToPool ?? 0n)}${encodeWord("uint256", t.raised)}`, blockNumber: `0x${t.graduated.toString(16)}`, transactionHash: `0xdemo${t.symbol.toLowerCase()}grad`, logIndex: "0x2" });
      }
    }
    return logs;
  }
  function curveLogs(t, from, to) {
    const buy = eventTopic(CURVE_EVENTS.CurveBuy);
    const sell = eventTopic(CURVE_EVENTS.CurveSell);
    const logs = [];
    let index = 0;
    for (const [offset, who, quoteIn, doorBps] of t.buys) {
      const b = t.launched + offset;
      if (b < from || b > to) continue;
      const fee = quoteIn / 100n;
      const tax = quoteIn * (t.taxBps + BigInt(doorBps ?? 0)) / 10000n;
      logs.push({ address: t.curve, topics: [buy, addressTopic(who), addressTopic(who)], data: `0x${encodeWord("uint256", quoteIn)}${encodeWord("uint256", 10n ** 24n)}${encodeWord("uint256", fee)}${encodeWord("uint256", tax)}`, blockNumber: `0x${b.toString(16)}`, transactionHash: `0xdemo${t.symbol}${b}`, logIndex: `0x${(index++).toString(16)}` });
    }
    for (const [offset, who, quoteOut] of t.sells) {
      const b = t.launched + offset;
      if (b < from || b > to) continue;
      logs.push({ address: t.curve, topics: [sell, addressTopic(who), addressTopic(who)], data: `0x${encodeWord("uint256", 10n ** 24n)}${encodeWord("uint256", quoteOut)}${encodeWord("uint256", quoteOut / 100n)}${encodeWord("uint256", 0n)}`, blockNumber: `0x${b.toString(16)}`, transactionHash: `0xdemo${t.symbol}${b}s`, logIndex: `0x${(index++).toString(16)}` });
    }
    return logs;
  }
  function demoFetch() {
    const byToken = /* @__PURE__ */ new Map();
    const byCurve = /* @__PURE__ */ new Map();
    for (const t of Object.values(DEMO.tokens)) {
      byToken.set(t.token, t);
      byCurve.set(t.curve, t);
    }
    const sel = (sig) => selector(sig);
    const poolSlots = /* @__PURE__ */ new Map();
    for (const t of Object.values(DEMO.tokens)) {
      if (!t.graduated) continue;
      const { poolId, tokenIsCurrency0 } = poolIdFor(t.token, ZERO_ADDRESS, 10000n, 200n, DEMO_HOOK);
      const token = t.supplyToPool ?? 0n;
      const quote = t.raised;
      const [amount0, amount1] = tokenIsCurrency0 ? [token, quote] : [quote, token];
      const sqrtPriceX96 = isqrt(amount1 * 2n ** 192n / amount0);
      const liquidity = isqrt(amount0 * amount1);
      const stateSlot = keccak256Hex(hexToBytesLocal(`${poolId.slice(2)}${encodeWord("uint256", 6n)}`));
      poolSlots.set(stateSlot, `0x${encodeWord("uint256", sqrtPriceX96)}`);
      poolSlots.set(`0x${(BigInt(stateSlot) + 3n).toString(16).padStart(64, "0")}`, `0x${encodeWord("uint256", liquidity)}`);
    }
    return (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const requests = Array.isArray(body) ? body : [body];
      const responses = requests.map((request) => {
        const ok = (result) => ({ jsonrpc: "2.0", id: request.id, result });
        const err = (message) => ({ jsonrpc: "2.0", id: request.id, error: { code: -32e3, message } });
        switch (request.method) {
          case "eth_chainId":
            return ok(`0x${ROBINHOOD_CHAIN_ID.toString(16)}`);
          case "eth_blockNumber":
            return ok(`0x${DEMO.head.toString(16)}`);
          case "eth_getBlockByNumber": {
            const tag = request.params[0];
            const n = tag === "latest" ? DEMO.head : Number(BigInt(tag));
            return ok({ number: `0x${n.toString(16)}`, timestamp: `0x${Math.round(blockTime(n)).toString(16)}`, hash: `0xdemo${n}` });
          }
          case "eth_getLogs": {
            const f = request.params[0];
            const from = Number(BigInt(f.fromBlock));
            const to = Number(BigInt(f.toBlock));
            const address = f.address ? String(f.address).toLowerCase() : void 0;
            const all = !address ? [...factoryLogs(from, to), ...plainTokenLogs(from, to), ...Object.values(DEMO.tokens).flatMap((t) => [...curveLogs(t, from, to), ...tokenLogs(t, from, to)])] : address === PONS_V2_FACTORY ? factoryLogs(from, to) : address === DEMO_PLAIN.token ? plainTokenLogs(from, to) : byCurve.has(address) ? curveLogs(byCurve.get(address), from, to) : byToken.has(address) ? tokenLogs(byToken.get(address), from, to) : [];
            return ok(all.filter((log) => matchesTopics(log.topics, f.topics)));
          }
          case "eth_getCode": {
            const who = request.params[0].toLowerCase();
            if (who === PONS_V2_FACTORY) return ok(DEMO_CODE.factory);
            if (byToken.has(who)) return ok(DEMO_CODE.ponsToken);
            if (byCurve.has(who)) return ok(DEMO_CODE.ponsCurve);
            if (who === DEMO_IMPOSTOR.token) return ok(DEMO_CODE.impostor);
            if (who === DEMO_V1.token || who === PONS_V1_FACTORY) return ok(DEMO_CODE.ponsToken);
            if (who === DEMO_PLAIN.token) return ok(DEMO_CODE.plain);
            if (who === DEMO_PLAIN.pool) return ok(DEMO_CODE.factory);
            return ok("0x");
          }
          case "eth_getTransactionReceipt": {
            const hash = request.params[0];
            if (hash === DEMO_PLAIN.creationTx) return ok({ transactionHash: hash, blockNumber: `0x${DEMO_PLAIN.createdAt.toString(16)}`, from: DEMO_PLAIN.owner, status: "0x1", logs: [] });
            if (hash === DEMO_IMPOSTOR.creationTx) return ok({ transactionHash: hash, blockNumber: `0x${DEMO_IMPOSTOR.createdAt.toString(16)}`, from: DEMO_IMPOSTOR.deployer, status: "0x1", logs: [] });
            for (const t of Object.values(DEMO.tokens)) {
              const logs = curveLogs(t, 0, DEMO.head);
              const hit = logs.filter((l) => l.transactionHash === hash);
              if (hit.length) return ok({ transactionHash: hash, blockNumber: hit[0].blockNumber, from: hit[0], status: "0x1", logs: hit });
            }
            return ok(null);
          }
          case "eth_getStorageAt": {
            const [who, slot] = request.params;
            if (who.toLowerCase() === DEMO_IMPOSTOR.token && slot === EIP1967_IMPLEMENTATION_SLOT) return ok(`0x${encodeWord("address", DEMO_IMPOSTOR.implementation)}`);
            return ok(`0x${"0".repeat(64)}`);
          }
          case "eth_call": {
            const call = request.params[0];
            const to = call.to.toLowerCase();
            const s = call.data.slice(0, 10);
            if (to === PONS_V2_FACTORY) {
              if (s === sel("getLaunchedToken(address)")) {
                const t2 = byToken.get(`0x${call.data.slice(34)}`);
                return ok(`0x${t2 ? launchedRecord(t2) : new Array(15).fill(encodeWord("uint256", 0n)).join("")}`);
              }
              if (s === sel("snipeTaxStartBps()")) return ok(`0x${encodeWord("uint256", 9900n)}`);
              if (s === sel("snipeTaxSeconds()")) return ok(`0x${encodeWord("uint256", 15n)}`);
              if (s === sel("maxCreatorTaxBps()")) return ok(`0x${encodeWord("uint256", 1000n)}`);
              if (s === sel("poolManager()")) return ok(`0x${encodeWord("address", DEMO_POOL_MANAGER)}`);
              if (s === sel("memeHook()")) return ok(`0x${encodeWord("address", DEMO_HOOK)}`);
              if (s === sel("launchFee()")) return ok(`0x${encodeWord("uint256", 10n ** 15n)}`);
              if (s === sel("launchConfigCount()")) return ok(`0x${encodeWord("uint256", 1n)}`);
              if (s === sel("getLaunchConfig(uint256)")) {
                return ok(`0x${[encodeWord("uint256", 10n ** 27n), encodeWord("uint256", 100n), encodeWord("uint256", 9n * 10n ** 17n), encodeWord("uint256", DEMO.threshold), encodeWord("uint24", 10000n), encodeWord("int24", 200n), encodeWord("bool", true)].join("")}`);
              }
              if (s === sel("pairTokenEconomics(address)")) return ok(`0x${[encodeWord("uint256", 0n), encodeWord("uint256", 0n), encodeWord("uint8", 18n)].join("")}`);
            }
            if (to === DEMO_HOOK && s === sel("currentFeePolicy()")) {
              return ok(`0x${[encodeWord("address", "0x0000000000000000000000000000000000000fee"), encodeWord("uint16", 3000n), encodeWord("uint16", 5000n), encodeWord("uint16", 100n), encodeWord("uint16", 300n)].join("")}`);
            }
            if (to === DEMO_POOL_MANAGER && s === sel("extsload(bytes32)")) {
              const slot = `0x${call.data.slice(10, 74)}`;
              const word = poolSlots.get(slot);
              return ok(word ?? `0x${"0".repeat(64)}`);
            }
            const t = byToken.get(to);
            if (t) {
              if (s === sel("name()")) return ok(`0x${encodeString(t.name)}`);
              if (s === sel("symbol()")) return ok(`0x${encodeString(t.symbol)}`);
              if (s === sel("decimals()")) return ok(`0x${encodeWord("uint8", 18n)}`);
              if (s === sel("totalSupply()")) return ok(`0x${encodeWord("uint256", 10n ** 27n)}`);
              if (s === sel("balanceOf(address)")) {
                const who = `0x${call.data.slice(34)}`;
                if (who === t.deployer) return ok(`0x${encodeWord("uint256", 3n * 10n ** 25n)}`);
                if (who === t.curve) return ok(`0x${encodeWord("uint256", t.tokenReserve)}`);
                return ok(`0x${encodeWord("uint256", 0n)}`);
              }
            }
            if (to === PONS_V1_FACTORY) {
              if (s === sel("getLaunchedToken(address)")) {
                const who = `0x${call.data.slice(34)}`;
                if (who !== DEMO_V1.token) return ok(`0x${new Array(13).fill(encodeWord("uint256", 0n)).join("")}`);
                return ok(`0x${[encodeWord("address", DEMO_V1.token), encodeWord("address", DEMO_V1.deployer), encodeWord("address", ZERO_ADDRESS), encodeWord("address", "0x0000000000000000000000000000000000009051"), encodeWord("uint256", DEMO_V1.positionId), encodeWord("uint256", 0n), encodeWord("uint256", 0n), encodeWord("uint256", DEMO_V1.restrictionsEndBlock), encodeWord("uint256", 10n ** 27n), encodeWord("bool", false), encodeWord("uint24", 10000n), encodeWord("bool", true), encodeWord("uint256", 5n * 10n ** 16n)].join("")}`);
              }
              if (s === sel("graduationStatus(address)")) return ok(`0x${[encodeWord("uint256", 12n * 10n ** 17n), encodeWord("uint256", 3n * 10n ** 18n), encodeWord("bool", false)].join("")}`);
              if (s === sel("getLaunchConfig(uint256)")) return ok(`0x${[encodeWord("address", ZERO_ADDRESS), encodeWord("uint256", 3n * 10n ** 18n), encodeWord("int24", -200000n), encodeWord("uint256", 10n ** 27n), encodeWord("uint16", 200n), encodeWord("uint16", 100n), encodeWord("uint32", 300n), encodeWord("uint24", 10000n), encodeWord("bool", true), encodeWord("bool", false)].join("")}`);
              if (s === sel("locker()")) return ok(`0x${encodeWord("address", "0x00000000000000000000000000000000000010c4")}`);
            }
            if (to === DEMO_V1.token) {
              if (s === sel("name()")) return ok(`0x${encodeString(DEMO_V1.name)}`);
              if (s === sel("symbol()")) return ok(`0x${encodeString(DEMO_V1.symbol)}`);
              if (s === sel("decimals()")) return ok(`0x${encodeWord("uint8", 18n)}`);
              if (s === sel("totalSupply()")) return ok(`0x${encodeWord("uint256", 10n ** 27n)}`);
            }
            const dex = CHAINS.robinhood.dex;
            if ((dex.v3Factories ?? []).some((f) => f.address === to) && s === sel("getPool(address,address,uint24)")) {
              const [a, , fee] = [`0x${call.data.slice(34, 74)}`, 0, BigInt(`0x${call.data.slice(138, 202)}`)];
              return ok(`0x${encodeWord("address", a === DEMO_PLAIN.token && fee === 3000n ? DEMO_PLAIN.pool : ZERO_ADDRESS)}`);
            }
            if (to === dex.weth && s === sel("balanceOf(address)")) {
              const who = `0x${call.data.slice(34)}`;
              return ok(`0x${encodeWord("uint256", who === DEMO_PLAIN.pool ? DEMO_PLAIN.poolWeth : 0n)}`);
            }
            if (to === DEMO_PLAIN.pool) {
              const tokens = DEMO_PLAIN.supply * 3000n / 10000n;
              if (s === sel("token0()")) return ok(`0x${encodeWord("address", DEMO_PLAIN.token)}`);
              if (s === sel("fee()")) return ok(`0x${encodeWord("uint24", 3000n)}`);
              if (s === sel("liquidity()")) return ok(`0x${encodeWord("uint128", isqrt(tokens * DEMO_PLAIN.poolWeth))}`);
              if (s === sel("slot0()")) {
                const sqrtPriceX96 = isqrt(DEMO_PLAIN.poolWeth * 2n ** 192n / tokens);
                return ok(
                  `0x${[
                    encodeWord("uint160", sqrtPriceX96),
                    encodeWord("int24", 0n),
                    encodeWord("uint16", 0n),
                    encodeWord("uint16", 1n),
                    encodeWord("uint16", 1n),
                    encodeWord("uint8", 0n),
                    encodeWord("bool", true)
                  ].join("")}`
                );
              }
            }
            if (to === DEMO_PLAIN.token) {
              const from = call.from?.toLowerCase();
              if (s === sel("name()")) return ok(`0x${encodeString(DEMO_PLAIN.name)}`);
              if (s === sel("symbol()")) return ok(`0x${encodeString(DEMO_PLAIN.symbol)}`);
              if (s === sel("decimals()")) return ok(`0x${encodeWord("uint8", 18n)}`);
              if (s === sel("totalSupply()")) return ok(`0x${encodeWord("uint256", DEMO_PLAIN.supply)}`);
              if (s === sel("owner()")) return ok(`0x${encodeWord("address", DEMO_PLAIN.owner)}`);
              if (s === sel("paused()")) return ok(`0x${encodeWord("bool", false)}`);
              if (s === sel("tradingOpen()")) return ok(`0x${encodeWord("bool", true)}`);
              if (s === sel("balanceOf(address)")) {
                const who = `0x${call.data.slice(34)}`;
                const row = DEMO_PLAIN.holders.find((h) => h[0] === who);
                return ok(`0x${encodeWord("uint256", row ? DEMO_PLAIN.supply * BigInt(row[1]) / 10000n : 0n)}`);
              }
              if (s === sel("transfer(address,uint256)")) {
                if (from === DEMO_PLAIN.blacklisted) return { jsonrpc: "2.0", id: request.id, error: { code: 3, message: "execution reverted: Blacklisted", data: `0x08c379a0${encodeString("Blacklisted")}` } };
                return ok(`0x${encodeWord("bool", true)}`);
              }
            }
            if (to === DEMO_IMPOSTOR.token) {
              if (s === sel("name()")) return ok(`0x${encodeString("Sprint")}`);
              if (s === sel("symbol()")) return ok(`0x${encodeString("SPRINT")}`);
              if (s === sel("decimals()")) return ok(`0x${encodeWord("uint8", 18n)}`);
              if (s === sel("totalSupply()")) return ok(`0x${encodeWord("uint256", 10n ** 27n)}`);
            }
            const c = byCurve.get(to);
            if (c) {
              const one = (v, type) => ok(`0x${encodeWord(type, v)}`);
              if (s === sel("token()")) return ok(`0x${encodeWord("address", c.token)}`);
              if (s === sel("getReserves()")) return ok(`0x${encodeWord("uint256", c.real + 9n * 10n ** 17n)}${encodeWord("uint256", c.tokenReserve)}`);
              if (s === sel("realQuoteReserve()")) return one(c.real, "uint256");
              if (s === sel("graduationThreshold()")) return one(DEMO.threshold, "uint256");
              if (s === sel("phantomQuote()")) return one(9n * 10n ** 17n, "uint256");
              if (s === sel("feeBps()")) return one(100n, "uint256");
              if (s === sel("creatorTaxBps()")) return one(c.taxBps, "uint256");
              if (s === sel("readyToGraduate()")) return one(c.tokenReserve === 0n, "bool");
              if (s === sel("graduated()")) return one(Boolean(c.swept), "bool");
              if (s === sel("quoteFeeBalance()")) return one(10n ** 16n, "uint256");
              if (s === sel("creatorTaxBalance()")) return one(3n * 10n ** 16n, "uint256");
              if (s === sel("buybackQuoteBalance()")) return one(2n * 10n ** 16n, "uint256");
              if (s === sel("isNativeQuote()")) return one(true, "bool");
            }
            return { jsonrpc: "2.0", id: request.id, error: { code: 3, message: "execution reverted", data: "0x" } };
          }
          default:
            return err(`demo chain does not serve ${request.method}`);
        }
      });
      return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), { headers: { "content-type": "application/json" } });
    });
  }
  function isqrt(n) {
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + n / x) / 2n;
    }
    return x;
  }
  function hexToBytesLocal(hex) {
    const out2 = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out2.length; i++) out2[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out2;
  }
  function demoBlockscoutFetch() {
    const tokens = Object.values(DEMO.tokens);
    return (async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      const m = url.pathname.match(/^\/api\/v2\/addresses\/(0x[0-9a-f]{40})\/transactions$/i);
      if (m) {
        const who = m[1].toLowerCase();
        const fresh = DEMO.tokens.fresh;
        const funded = /* @__PURE__ */ new Set([buyer(900), buyer(901)]);
        const items = funded.has(who) ? [{ hash: `0xdemofund${who.slice(-4)}`, value: (10n ** 18n).toString(), block_number: fresh.launched - 400, from: { hash: DEMO_FUNDER }, to: { hash: who } }] : [];
        return json({ items, next_page_params: null });
      }
      if (url.pathname === "/api/v2/search") {
        const q2 = (url.searchParams.get("q") ?? "").toUpperCase();
        const items = tokens.filter((t) => t.symbol.toUpperCase() === q2).map((t) => ({ type: "token", address: t.token, name: t.name, symbol: t.symbol }));
        if (q2 === "SPRINT") items.push({ type: "token", address: DEMO_IMPOSTOR.token, name: "Sprint", symbol: "SPRINT" });
        return json({ items });
      }
      const v = url.pathname.match(/^\/api\/v2\/smart-contracts\/(0x[0-9a-f]{40})$/i);
      if (v) return json({ is_verified: tokens.some((t) => t.token === v[1].toLowerCase() || t.curve === v[1].toLowerCase()) });
      const plain = DEMO_PLAIN;
      if (url.pathname === `/api/v2/addresses/${plain.token}`) return json({ is_contract: true, is_verified: false, name: null, creator_address_hash: plain.owner, creation_transaction_hash: plain.creationTx });
      if (url.pathname === `/api/v2/addresses/${DEMO_IMPOSTOR.token}`) {
        return json({ is_contract: true, is_verified: false, is_scam: false, name: null, creator_address_hash: DEMO_IMPOSTOR.deployer, creation_transaction_hash: DEMO_IMPOSTOR.creationTx });
      }
      if (url.pathname === `/api/v2/tokens/${plain.token}`) return json({ holders_count: "143", type: "ERC-20", name: plain.name, symbol: plain.symbol });
      if (url.pathname === `/api/v2/tokens/${plain.token}/counters`) return json({ token_holders_count: "143", transfers_count: "2210" });
      if (url.pathname === `/api/v2/tokens/${plain.token}/holders`) {
        return json({
          items: plain.holders.map(([hash, bps3, is_contract, name, delegated]) => ({
            address: { hash, is_contract, name, proxy_type: delegated ? "eip7702" : null },
            value: (plain.supply * BigInt(bps3) / 10000n).toString()
          })),
          next_page_params: null
        });
      }
      if (url.pathname === `/api/v2/tokens/${plain.token}/transfers`) {
        const at = (block) => new Date(Math.round(DEMO.genesisTimestamp + block * 0.1) * 1e3).toISOString();
        const items = [DEMO.head - 1200, DEMO.head - 4e3, DEMO.head - 9e3].map((block, i) => ({ block_number: block, timestamp: at(block), from: { hash: plain.pool }, to: { hash: buyer(500 + i) }, total: { value: (10n ** 24n).toString() }, transaction_hash: `0xdemoplainxfer${i}` }));
        return json({ items, next_page_params: null });
      }
      return new Response("not found", { status: 404 });
    });
  }
  function plainTokenLogs(from, to) {
    const logs = [];
    const recipients = DEMO_PLAIN.holders.filter(([, , isContract]) => !isContract).map(([hash]) => hash);
    recipients.forEach((who, i) => {
      const b = DEMO.head - 40 + i;
      if (b < from || b > to) return;
      logs.push({
        address: DEMO_PLAIN.token,
        topics: [eventTopic(ERC20_EVENTS.Transfer), addressTopic(DEMO_PLAIN.pool), addressTopic(who)],
        data: `0x${encodeWord("uint256", 10n ** 21n)}`,
        blockNumber: `0x${b.toString(16)}`,
        transactionHash: `0xdemoplainxfer${i}`,
        logIndex: `0x${i.toString(16)}`
      });
    });
    return logs;
  }
  function tokenLogs(t, from, to) {
    const logs = [];
    let index = 0;
    for (const [offset, from_, to_, amount] of t.transfers ?? []) {
      const b = t.launched + offset;
      if (b < from || b > to) continue;
      logs.push({ address: t.token, topics: [eventTopic(ERC20_EVENTS.Transfer), addressTopic(from_), addressTopic(to_)], data: `0x${encodeWord("uint256", amount)}`, blockNumber: `0x${b.toString(16)}`, transactionHash: `0xdemo${t.symbol}xfer${b}`, logIndex: `0x${(index++).toString(16)}` });
    }
    return logs;
  }
  function matchesTopics(topics, filter) {
    if (!filter) return true;
    return filter.every((want, i) => {
      if (want === null || want === void 0) return true;
      const have = (topics[i] ?? "").toLowerCase();
      return Array.isArray(want) ? want.some((w) => w.toLowerCase() === have) : want.toLowerCase() === have;
    });
  }
  var CBOR_TRAILER = "a2646970667358221220" + "ff".repeat(4) + "f4".repeat(4) + "ab".repeat(26) + "64736f6c63430008260035";
  var DEMO_CODE = {
    factory: `0x6080604052${"5b".repeat(40)}00${CBOR_TRAILER}`,
    ponsToken: `0x60806040527f${"ff".repeat(16)}${"f4".repeat(16)}5b${"5b".repeat(200)}00${CBOR_TRAILER}`,
    ponsCurve: `0x60806040527f${"00".repeat(32)}5b${"5b".repeat(900)}00${CBOR_TRAILER}`,
    impostor: `0x6080604052${"5b".repeat(20)}f4${"5b".repeat(20)}ff00${CBOR_TRAILER}`,
    /** A dispatcher: PUSH4 <selector> EQ PUSH2 <dest> JUMPI for each function the plain token has. */
    plain: `0x6080604052${DEMO_PLAIN.powers.map((sig) => `63${selector(sig).slice(2)}1461${"0000"}57`).join("")}${"5b".repeat(60)}00${CBOR_TRAILER}`
  };
  function demoRpc(memo = false) {
    return new RpcClient({ urls: ["demo://robinhood-chain"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl: demoFetch(), minSpacingMs: 0, memo });
  }

  // src/bouncer/devReport.ts
  init_abi();
  init_tape();
  async function readDevReport(rpc, deployer, options) {
    const address = normalizeAddress(deployer);
    const factory = options.factory ?? PONS_V2_FACTORY;
    const tape = await readTapeAdaptive(
      rpc,
      { fromBlock: options.fromBlock, toBlock: options.toBlock, address: factory, events: [FACTORY_EVENTS.TokenLaunched], topics: [null, null, addressTopic(address)] },
      options.chunking
    );
    const all = tape.logs.slice().reverse();
    const limit = options.limit ?? 40;
    const detailed = all.slice(0, limit);
    const records = detailed.length ? await rpc.callBatch(
      detailed.map((l) => ({ to: factory, data: encodeCall(FACTORY_FUNCTIONS.getLaunchedToken, [String(l.args.token)]) })),
      options.toBlock
    ) : [];
    const symbols = detailed.length ? await rpc.callBatch(detailed.map((l) => ({ to: String(l.args.token), data: encodeCall(ERC20_FUNCTIONS.symbol, []) })), options.toBlock) : [];
    const launches = [];
    for (let i = 0; i < detailed.length; i++) {
      const log = detailed[i];
      const record = decodeLaunchedToken(decodeOutputs(FACTORY_FUNCTIONS.getLaunchedToken, records[i]));
      let symbol = "?";
      try {
        symbol = decodeOutputs(ERC20_FUNCTIONS.symbol, symbols[i])[0];
      } catch {
        symbol = "?";
      }
      const header = await rpc.getBlock(log.blockNumber);
      const sweptAt = Number(record.sweptAt);
      launches.push({
        token: String(log.args.token).toLowerCase(),
        curve: String(log.args.curve).toLowerCase(),
        symbol,
        launchedBlock: log.blockNumber,
        launchedAt: header.timestamp,
        phase: record.phase,
        creatorTaxBps: record.creatorTaxBps,
        sweptAt,
        secondsToSweep: sweptAt > 0 ? Math.max(0, sweptAt - header.timestamp) : null
      });
    }
    const counts = { launched: all.length, graduated: 0, swept: 0, onCurve: 0 };
    for (const l of launches) {
      if (l.phase === 2 /* PoolCreated */ || l.phase === 3 /* Rescued */) counts.graduated++;
      else if (l.phase === 1 /* Swept */) counts.swept++;
      else counts.onCurve++;
    }
    const sweeps = launches.map((l) => l.secondsToSweep).filter((s) => s !== null).sort((a, b) => a - b);
    const seen = /* @__PURE__ */ new Map();
    for (const l of launches) seen.set(l.symbol.toUpperCase(), (seen.get(l.symbol.toUpperCase()) ?? 0) + 1);
    const taxes = launches.map((l) => l.creatorTaxBps);
    return {
      deployer: address,
      window: { fromBlock: options.fromBlock, toBlock: options.toBlock },
      launches,
      truncated: all.length > detailed.length,
      counts,
      medianSecondsToSweep: sweeps.length ? sweeps[Math.floor(sweeps.length / 2)] : null,
      repeatedSymbols: [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s),
      taxRangeBps: taxes.length ? [taxes.reduce((a, b) => a < b ? a : b), taxes.reduce((a, b) => a > b ? a : b)] : null
    };
  }
  function devReportLine(d) {
    const c = d.counts;
    if (c.launched === 0) return "first launch from this address in the window";
    const parts = [`${c.launched} launch${c.launched === 1 ? "" : "es"}`, `${c.graduated} graduated`];
    if (c.swept) parts.push(`${c.swept} swept, no pool`);
    if (c.onCurve) parts.push(`${c.onCurve} still on the curve`);
    if (d.repeatedSymbols.length) parts.push(`same ticker ${d.repeatedSymbols.length}\xD7`);
    return parts.join(" \xB7 ");
  }

  // src/bouncer/door.ts
  init_abi();
  init_tape();

  // src/bouncer/houseRules.ts
  init_tape();
  async function readHouseRules(rpc, launch, options) {
    const factory = options.factory ?? PONS_V2_FACTORY;
    const reader = new PonsReader(rpc, factory);
    const snapshot = await reader.snapshot(launch.token, options.head);
    const native = launch.pairToken.toLowerCase() === ZERO_ADDRESS;
    const quote = native ? { ...options.native ?? { symbol: "ETH", decimals: 18 }, native } : { ...await readTokenMeta(rpc, launch.pairToken, options.head), native };
    const history = await readTape(rpc, {
      fromBlock: options.launchBlock,
      toBlock: options.head,
      address: factory,
      events: [FACTORY_EVENTS.CreatorFeeRecipientUpdated, FACTORY_EVENTS.BuybackEnabledUpdated],
      topics: [addressTopic(launch.token)],
      chunkSize: options.chunkSize ?? 1e5
    });
    const creatorFeeRecipientChanges = history.logs.filter((l) => l.name === "CreatorFeeRecipientUpdated").map((l) => ({ block: l.blockNumber, from: String(l.args.previousRecipient).toLowerCase(), to: String(l.args.newRecipient).toLowerCase() }));
    const buybackChanges = history.logs.filter((l) => l.name === "BuybackEnabledUpdated").map((l) => ({ block: l.blockNumber, enabled: Boolean(l.args.enabled) }));
    const curveFeeBps = snapshot.curve?.feeBps ?? 0n;
    const creatorTaxBps = launch.creatorTaxBps;
    const fill = snapshot.curve ? {
      real: snapshot.curve.realQuoteReserve,
      threshold: snapshot.curve.graduationThreshold,
      bps: snapshot.curve.graduationThreshold === 0n ? 0 : Number(snapshot.curve.realQuoteReserve * 10000n / snapshot.curve.graduationThreshold)
    } : null;
    const deployerShareBps = snapshot.token.totalSupply === 0n ? 0 : Number(snapshot.deployerBalance * 10000n / snapshot.token.totalSupply);
    const rules = {
      snapshot,
      quote,
      curveFeeBps,
      creatorTaxBps,
      totalTradeBps: curveFeeBps + creatorTaxBps,
      poolFeePpm: launch.poolFee,
      creatorFeeRecipient: launch.creatorFeeRecipient.toLowerCase(),
      creatorFeeRecipientChanges,
      buybackEnabled: launch.buybackEnabled,
      buybackChanges,
      phase: launch.phase,
      fill,
      deployerShareBps,
      rules: []
    };
    rules.rules = houseRulesInWords(rules, launch);
    return rules;
  }
  function houseRulesInWords(r, launch) {
    const out2 = [];
    const q2 = r.quote.symbol;
    if (r.phase === 0 /* NotGraduated */) {
      out2.push(`Every buy and sell on the curve pays ${formatBps(r.totalTradeBps)} of the ${q2} leg: ${formatBps(r.curveFeeBps)} protocol fee + ${formatBps(r.creatorTaxBps)} creator tax.`);
    } else {
      out2.push(`On the curve this launch charged ${formatBps(r.creatorTaxBps)} creator tax on top of the protocol fee; the graduated pool charges ${Number(r.poolFeePpm) / 1e4}% per swap through the Pons hook.`);
    }
    out2.push(`The creator tax is paid to ${r.creatorFeeRecipient}${r.creatorFeeRecipientChanges.length ? `, changed ${r.creatorFeeRecipientChanges.length}\xD7 since launch` : ", unchanged since launch"}. The creator can move it again at any time.`);
    out2.push(
      r.buybackEnabled ? "Buyback is on: a share of fees buys tokens back and locks them in a vault that vests them to the creator and the protocol over five years. Nothing is burned." : "Buyback is off: fees are split between the protocol and the creator, none is spent buying the token back."
    );
    if (r.fill) {
      out2.push(`Quote asset is ${q2}. The curve holds ${formatUnits(r.fill.real, r.quote.decimals)} of the ${formatUnits(r.fill.threshold, r.quote.decimals)} ${q2} it needs to graduate (${(r.fill.bps / 100).toFixed(1)}% full).`);
    } else if (r.phase === 1 /* Swept */) {
      out2.push(`Quote asset is ${q2}. The curve was swept at ${formatUnits(launch.sweptQuote, r.quote.decimals)} ${q2}; the pool has not been created yet, so nothing trades right now.`);
    } else {
      out2.push(`Quote asset is ${q2}. Graduated: ${formatUnits(launch.sweptQuote, r.quote.decimals)} ${q2} and the reserved tokens seeded a Uniswap V4 pool whose position is held by the Pons locker, not the creator.`);
    }
    out2.push(`The deployer holds ${formatPercent(r.snapshot.deployerBalance, r.snapshot.token.totalSupply)} of supply at block ${r.snapshot.block.number}.`);
    return out2;
  }

  // src/bouncer/idCheck.ts
  init_abi();

  // src/chain/batch.ts
  var ReadBatch = class {
    constructor(rpc, block) {
      this.rpc = rpc;
      this.block = block;
    }
    requests = [];
    answers = [];
    ran = false;
    slot(request) {
      if (this.ran) throw new Error("ReadBatch: add every question before run()");
      this.requests.push(request);
      return this.requests.length - 1;
    }
    /** An eth_call, pinned to this batch's block. */
    call(to, data) {
      return this.slot({ method: "eth_call", params: [{ to, data }, this.tag] });
    }
    /** An eth_call from a given sender, which is how a transfer is simulated. */
    callFrom(from, to, data) {
      return this.slot({ method: "eth_call", params: [{ from, to, data }, this.tag] });
    }
    getCode(address) {
      return this.slot({ method: "eth_getCode", params: [address, this.tag] });
    }
    getStorageAt(address, storageSlot) {
      return this.slot({ method: "eth_getStorageAt", params: [address, storageSlot, this.tag] });
    }
    get size() {
      return this.requests.length;
    }
    get tag() {
      return `0x${this.block.toString(16)}`;
    }
    async run() {
      this.ran = true;
      if (!this.requests.length) return;
      try {
        this.answers = await this.rpc.sendBatchSettled(this.requests);
        return;
      } catch (whole) {
        this.answers = [];
        for (const request of this.requests) {
          try {
            this.answers.push(await this.rpc.send(request.method, request.params));
          } catch (single) {
            this.answers.push(asRpcError(single));
          }
        }
        if (this.answers.every((answer) => answer instanceof RpcError)) {
          const failure = asRpcError(whole);
          this.answers = this.requests.map(() => failure);
        }
      }
    }
    /**
     * The raw answer at a slot: the hex the node returned, the error it gave,
     * or null when the question was never asked (slot === null).
     */
    answer(slot) {
      if (slot === null) return null;
      const value = this.answers[slot];
      if (value instanceof RpcError) return value;
      if (typeof value === "string") return value;
      return new RpcError("no answer in the batch for this read");
    }
    /** The hex at a slot, or null for anything that is not a readable answer. */
    hex(slot) {
      const value = this.answer(slot);
      return value === null || value instanceof RpcError ? null : value;
    }
  };
  function asRpcError(error) {
    return error instanceof RpcError ? error : new RpcError(error instanceof Error ? error.message : String(error));
  }

  // src/bouncer/v1.ts
  init_abi();
  async function readV1Launch(rpc, factory, token, block, native) {
    const [raw] = await rpc.callBatch([{ to: factory, data: encodeCall(V1_FACTORY_FUNCTIONS.getLaunchedToken, [token]) }], block);
    const record = decodeV1LaunchedToken(decodeOutputs(V1_FACTORY_FUNCTIONS.getLaunchedToken, raw));
    if (!record.exists) return null;
    const [statusRaw, configRaw, lockerRaw] = await rpc.callBatch(
      [
        { to: factory, data: encodeCall(V1_FACTORY_FUNCTIONS.graduationStatus, [token]) },
        { to: factory, data: encodeCall(V1_FACTORY_FUNCTIONS.getLaunchConfig, [record.launchConfigId]) },
        { to: factory, data: encodeCall(V1_FACTORY_FUNCTIONS.locker, []) }
      ],
      block
    ).catch(() => [null, null, null]);
    const [pairedPrincipal, threshold, graduated] = statusRaw ? decodeOutputs(V1_FACTORY_FUNCTIONS.graduationStatus, statusRaw) : [0n, 0n, false];
    let config = null;
    if (configRaw) {
      try {
        const c = decodeOutputs(V1_FACTORY_FUNCTIONS.getLaunchConfig, configRaw);
        config = { maxWalletBps: c[4], maxTxBps: c[5], restrictionBlocks: c[6], reservedFee: c[7], supply: c[3] };
      } catch {
        config = null;
      }
    }
    let locker = null;
    if (lockerRaw) {
      try {
        locker = decodeOutputs(V1_FACTORY_FUNCTIONS.locker, lockerRaw)[0].toLowerCase();
      } catch {
        locker = null;
      }
    }
    const pairedNative = record.pairedToken.toLowerCase() === ZERO_ADDRESS;
    let quote = native;
    if (!pairedNative) {
      try {
        quote = await readTokenMeta(rpc, record.pairedToken, block);
      } catch {
        quote = { symbol: `${record.pairedToken.slice(0, 8)}\u2026`, decimals: 18 };
      }
    }
    const restrictionBlocksLeft = Math.max(0, Number(record.restrictionsEndBlock) - block);
    const launch = { factory, record, quote, status: { pairedPrincipal, threshold, graduated }, config, locker, restrictionBlocksLeft, rules: [] };
    launch.rules = v1RulesInWords(launch, block);
    return launch;
  }
  function v1RulesInWords(l, block) {
    const out2 = [];
    const q2 = l.quote;
    out2.push(`Pons V1 launch: the whole supply of ${formatUnits(l.record.supply, 18, 0)} tokens was paired into a Uniswap V3 pool (fee ${Number(l.record.poolFee) / 1e4}%) at launch. There is no bonding curve; it has traded in the pool from the first block.`);
    if (l.config) {
      out2.push(
        l.restrictionBlocksLeft > 0 ? `Launch caps are still on for ${l.restrictionBlocksLeft} more blocks (until block ${l.record.restrictionsEndBlock}): no wallet may hold more than ${formatBps(l.config.maxWalletBps)} of supply and no single trade may move more than ${formatBps(l.config.maxTxBps)}.` : `The launch caps (max ${formatBps(l.config.maxWalletBps)} per wallet, ${formatBps(l.config.maxTxBps)} per trade for ${l.config.restrictionBlocks} blocks) lifted at block ${l.record.restrictionsEndBlock}.`
      );
    }
    out2.push(
      l.status.graduated ? `Graduated: the pool holds ${formatUnits(l.status.pairedPrincipal, q2.decimals)} ${q2.symbol} of principal, past the ${formatUnits(l.status.threshold, q2.decimals)} ${q2.symbol} threshold.` : `Not graduated yet: ${formatUnits(l.status.pairedPrincipal, q2.decimals)} of the ${formatUnits(l.status.threshold, q2.decimals)} ${q2.symbol} threshold is in the pool.`
    );
    out2.push(`The liquidity position (#${l.record.positionId}) is held by the launchpad's locker${l.locker ? ` ${l.locker}` : ""}; the creator cannot pull it.`);
    if (l.record.initialBuyAmount > 0n) out2.push(`The deployer bought ${formatUnits(l.record.initialBuyAmount, q2.decimals)} ${q2.symbol} worth in the launch transaction.`);
    out2.push(`Read at block ${block}. V1 has no creator tax and no door tax; V2 tools (curve, cover charge, exit door) do not apply.`);
    return out2;
  }

  // src/bouncer/idCheck.ts
  var LAUNCH_FACTORY_VIEW = { name: "launchFactory", inputs: [], outputs: ["address"] };
  async function readIdCheck(rpc, input, block, factory, options = {}) {
    if (!isAddress(input)) throw new Error(`${input} is not an address`);
    const address = normalizeAddress(input);
    const reader = new PonsReader(rpc, factory);
    const v2Factory = factory || PONS_V2_FACTORY;
    const opening = new ReadBatch(rpc, block);
    const v2Slot = options.skipLaunchLookup ? null : opening.call(v2Factory, encodeCall(FACTORY_FUNCTIONS.getLaunchedToken, [address]));
    const curveSlot = options.skipLaunchLookup ? null : opening.call(address, encodeCall(CURVE_FUNCTIONS.token, []));
    const v1Slot = options.factoryV1 ? opening.call(options.factoryV1, encodeCall(V1_FACTORY_FUNCTIONS.getLaunchedToken, [address])) : null;
    const idSlots = contractIdSlots(opening, address);
    const metaFields = metaSlots(opening, address);
    await opening.run();
    let launch = null;
    let resolvedAs = "unknown";
    const v2Raw = opening.answer(v2Slot);
    if (v2Raw instanceof RpcError) throw v2Raw;
    if (v2Raw !== null) {
      const record = decodeLaunchedToken(decodeOutputs(FACTORY_FUNCTIONS.getLaunchedToken, v2Raw));
      if (record.exists) {
        launch = record;
        resolvedAs = "token";
      }
    }
    if (!launch) {
      const viaCurve = decodeAddress(CURVE_FUNCTIONS.token, opening.answer(curveSlot));
      if (viaCurve) {
        try {
          const record = await reader.launchedToken(viaCurve, block);
          if (record.curve.toLowerCase() === address) {
            launch = record;
            resolvedAs = "curve";
          }
        } catch (inner) {
          if (!(inner instanceof NotAPonsLaunch)) throw inner;
        }
      }
    }
    const native = options.native ?? { symbol: "ETH", decimals: 18 };
    let v1 = null;
    if (!launch && options.factoryV1) {
      const v1Raw = opening.answer(v1Slot);
      try {
        if (v1Raw !== null && !(v1Raw instanceof RpcError) && decodeV1LaunchedToken(decodeOutputs(V1_FACTORY_FUNCTIONS.getLaunchedToken, v1Raw)).exists) {
          v1 = await readV1Launch(rpc, options.factoryV1, address, block, native);
          if (v1) resolvedAs = "token";
        }
      } catch {
        v1 = null;
      }
    }
    const tokenAddress = launch ? launch.token.toLowerCase() : address;
    const token = tokenAddress === address ? contractIdOf(opening, address, idSlots) : await readContractId(rpc, tokenAddress, block);
    const curve = launch ? await readContractId(rpc, launch.curve.toLowerCase(), block) : null;
    const meta = token.code.empty ? null : tokenAddress === address ? metaOf(opening, metaFields) ?? await readMetaSafely(rpc, tokenAddress, block) : await readMetaSafely(rpc, tokenAddress, block);
    let claimedFactory = null;
    if (!launch && !v1 && !token.code.empty && token.code.selectors.has(selector("launchFactory()"))) {
      claimedFactory = await launchFactoryOf(rpc, tokenAddress, block);
      const known = new Set([options.factoryV1, ...options.olderFactoriesV1 ?? []].filter((x) => Boolean(x)).map((x) => x.toLowerCase()));
      if (claimedFactory && known.has(claimedFactory) && claimedFactory !== options.factoryV1) {
        try {
          v1 = await readV1Launch(rpc, claimedFactory, address, block, native);
          if (v1) resolvedAs = "token";
        } catch {
          v1 = null;
        }
      }
    }
    return { input: address, resolvedAs, registered: launch !== null || v1 !== null, launchpad: launch ? "v2" : v1 ? "v1" : null, launch, v1, token, meta, curve, claimedFactory };
  }
  function contractIdSlots(batch, address) {
    return [batch.getCode(address), batch.getStorageAt(address, EIP1967_IMPLEMENTATION_SLOT), batch.getStorageAt(address, EIP1967_BEACON_SLOT)];
  }
  function contractIdOf(batch, address, [codeSlot, implSlot, beaconSlot]) {
    const code = scanBytecode(batch.hex(codeSlot) ?? "0x");
    if (code.empty) return { address, code, runtime: "0x", proxyImplementation: null, proxyBeacon: null };
    const implementation = batch.hex(implSlot);
    const beacon = batch.hex(beaconSlot);
    return {
      address,
      code,
      runtime: batch.hex(codeSlot) ?? "0x",
      proxyImplementation: implementation && storageWordIsSet(implementation) ? storageWordAddress(implementation) : null,
      proxyBeacon: beacon && storageWordIsSet(beacon) ? storageWordAddress(beacon) : null
    };
  }
  function metaSlots(batch, address) {
    return [
      batch.call(address, encodeCall(ERC20_FUNCTIONS.name, [])),
      batch.call(address, encodeCall(ERC20_FUNCTIONS.symbol, [])),
      batch.call(address, encodeCall(ERC20_FUNCTIONS.decimals, [])),
      batch.call(address, encodeCall(ERC20_FUNCTIONS.totalSupply, []))
    ];
  }
  function metaOf(batch, [nameSlot, symbolSlot, decimalsSlot, supplySlot]) {
    try {
      const raw = (slot) => {
        const value = batch.hex(slot);
        if (value === null) throw new Error("unread");
        return value;
      };
      const [name] = decodeOutputs(ERC20_FUNCTIONS.name, raw(nameSlot));
      const [symbol] = decodeOutputs(ERC20_FUNCTIONS.symbol, raw(symbolSlot));
      const [decimals] = decodeOutputs(ERC20_FUNCTIONS.decimals, raw(decimalsSlot));
      const [totalSupply] = decodeOutputs(ERC20_FUNCTIONS.totalSupply, raw(supplySlot));
      return { name, symbol, decimals: Number(decimals), totalSupply };
    } catch {
      return null;
    }
  }
  function decodeAddress(fn, raw) {
    if (raw === null || raw instanceof RpcError) return null;
    try {
      const [value] = decodeOutputs(fn, raw);
      return value && value !== ZERO_ADDRESS ? value.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  async function launchFactoryOf(rpc, token, block) {
    try {
      const [raw] = await rpc.callBatch([{ to: token, data: encodeCall(LAUNCH_FACTORY_VIEW, []) }], block);
      const [factory] = decodeOutputs(LAUNCH_FACTORY_VIEW, raw);
      return factory && factory !== ZERO_ADDRESS ? factory.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  async function readContractId(rpc, address, block) {
    const batch = new ReadBatch(rpc, block);
    const slots = contractIdSlots(batch, address);
    await batch.run();
    return contractIdOf(batch, address, slots);
  }
  async function readMetaSafely(rpc, token, block) {
    const one = async (fn) => (await rpc.callBatch([{ to: token, data: encodeCall(fn, []) }], block))[0];
    try {
      const results = await rpc.callBatch(
        [
          { to: token, data: encodeCall(ERC20_FUNCTIONS.name, []) },
          { to: token, data: encodeCall(ERC20_FUNCTIONS.symbol, []) },
          { to: token, data: encodeCall(ERC20_FUNCTIONS.decimals, []) },
          { to: token, data: encodeCall(ERC20_FUNCTIONS.totalSupply, []) }
        ],
        block
      );
      const [name] = decodeOutputs(ERC20_FUNCTIONS.name, results[0]);
      const [symbol] = decodeOutputs(ERC20_FUNCTIONS.symbol, results[1]);
      const [decimals] = decodeOutputs(ERC20_FUNCTIONS.decimals, results[2]);
      const [totalSupply] = decodeOutputs(ERC20_FUNCTIONS.totalSupply, results[3]);
      return { name, symbol, decimals: Number(decimals), totalSupply };
    } catch {
      try {
        const [name] = decodeOutputs(ERC20_FUNCTIONS.name, await one(ERC20_FUNCTIONS.name));
        const [symbol] = decodeOutputs(ERC20_FUNCTIONS.symbol, await one(ERC20_FUNCTIONS.symbol));
        const [decimals] = decodeOutputs(ERC20_FUNCTIONS.decimals, await one(ERC20_FUNCTIONS.decimals));
        const [totalSupply] = decodeOutputs(ERC20_FUNCTIONS.totalSupply, await one(ERC20_FUNCTIONS.totalSupply));
        return { name, symbol, decimals: Number(decimals), totalSupply };
      } catch {
        return null;
      }
    }
  }
  function idFindings(id) {
    const out2 = [];
    const t = id.token;
    if (t.code.empty) out2.push("no bytecode at this address");
    if (t.proxyImplementation) out2.push(`upgradeable proxy (EIP-1967 implementation ${t.proxyImplementation})`);
    if (t.proxyBeacon) out2.push(`beacon proxy (EIP-1967 beacon ${t.proxyBeacon})`);
    if (t.code.minimalProxyTarget) out2.push(`minimal proxy (EIP-1167) to ${t.code.minimalProxyTarget}`);
    if (t.code.opcodes.selfdestruct) out2.push(`SELFDESTRUCT \xD7${t.code.opcodes.selfdestruct}`);
    if (t.code.opcodes.delegatecall) out2.push(`DELEGATECALL \xD7${t.code.opcodes.delegatecall}`);
    if (t.code.opcodes.callcode) out2.push(`CALLCODE \xD7${t.code.opcodes.callcode}`);
    if (t.code.opcodes.create2 || t.code.opcodes.create) out2.push(`deploys contracts (CREATE \xD7${t.code.opcodes.create}, CREATE2 \xD7${t.code.opcodes.create2})`);
    return out2;
  }

  // src/bouncer/lookalike.ts
  async function readLookalikes(rpc, blockscout, subject, symbol, block, factory, searchBlocks, limit = 8, subjectRegistered = true) {
    const hits = await blockscout.searchTokens(symbol);
    const reader = new PonsReader(rpc, factory);
    const wanted = symbol.toUpperCase();
    const candidates = await Promise.all(
      hits.filter((h) => h.symbol.toUpperCase() === wanted).slice(0, limit).map(async (hit) => {
        let registered = false;
        let phase = null;
        try {
          const record = await reader.launchedToken(hit.address, block);
          registered = true;
          phase = record.phase;
        } catch (error) {
          if (!(error instanceof NotAPonsLaunch)) throw error;
        }
        const launchBlock = registered ? await findLaunchBlock(rpc, hit.address, block, searchBlocks, factory) : null;
        return { address: hit.address, name: hit.name, symbol: hit.symbol, registered, phase, launchBlock };
      })
    );
    if (!candidates.some((c) => c.address === subject.toLowerCase())) {
      candidates.unshift({ address: subject.toLowerCase(), name: "", symbol, registered: subjectRegistered, phase: null, launchBlock: null });
    }
    const dated = candidates.filter((c) => c.registered && c.launchBlock !== null).sort((a, b) => a.launchBlock - b.launchBlock);
    const earliest = dated[0] ?? null;
    return {
      query: symbol,
      subject: subject.toLowerCase(),
      candidates,
      registeredCount: candidates.filter((c) => c.registered).length,
      earliest,
      subjectIsEarliest: earliest ? earliest.address === subject.toLowerCase() : null
    };
  }
  function registeredLookalikes(l) {
    return l.candidates.filter((c) => c.address !== l.subject && c.registered);
  }
  function lookalikeLine(l) {
    const others = l.candidates.filter((c) => c.address !== l.subject);
    if (!others.length) return `only token called ${l.query} the explorer knows`;
    const reg = others.filter((c) => c.registered).length;
    return `${others.length} other token${others.length === 1 ? "" : "s"} called ${l.query} (${reg} launched on this factory)${l.subjectIsEarliest === null ? "" : l.subjectIsEarliest ? " \xB7 this one came first" : " \xB7 this one is not the first"}`;
  }

  // src/bouncer/oneCrew.ts
  async function readOneCrew(blockscout, room, launchBlock, creatorWallets, limit = 12) {
    const creators = new Set(creatorWallets.map((c) => c.toLowerCase()));
    const candidates = room.first.slice(0, limit);
    const wallets = [];
    let unresolved = 0;
    for (const address of candidates) {
      const w = room.wallets.find((x) => x.address === address);
      let source = null;
      try {
        source = await blockscout.fundingSource(address, launchBlock + 1);
      } catch {
        unresolved++;
      }
      if (!source && !creators.has(address)) unresolved++;
      wallets.push({ address, funder: source?.from ?? null, fundedAtBlock: source?.block ?? null, quoteIn: w?.quoteIn ?? 0n, creatorWallet: creators.has(address) });
    }
    const byFunder = /* @__PURE__ */ new Map();
    for (const w of wallets) if (w.funder) byFunder.set(w.funder, [...byFunder.get(w.funder) ?? [], w]);
    const crews = [...byFunder.entries()].filter(([, ws]) => ws.length > 1).map(([funder, ws]) => {
      const quoteIn = ws.reduce((a, w) => a + w.quoteIn, 0n);
      return { funder, wallets: ws.map((w) => w.address), quoteIn, shareBps: room.totalQuoteIn === 0n ? 0 : Number(quoteIn * 10000n / room.totalQuoteIn) };
    }).sort((a, b) => b.shareBps - a.shareBps);
    return {
      checked: wallets.length,
      wallets,
      crews,
      largestCrewShareBps: crews[0]?.shareBps ?? 0,
      fundedByCreator: wallets.filter((w) => w.funder && creators.has(w.funder)).map((w) => w.address),
      unresolved
    };
  }
  function oneCrewLine(c) {
    if (c.checked === 0) return "no buyers to check";
    if (!c.crews.length) return `${c.checked} first buyers checked \xB7 no shared funder${c.unresolved ? ` \xB7 ${c.unresolved} unresolved` : ""}`;
    const top = c.crews[0];
    return `${c.checked} first buyers checked \xB7 ${top.wallets.length} share a funder (${(top.shareBps / 100).toFixed(0)}% of the curve)${c.fundedByCreator.length ? ` \xB7 ${c.fundedByCreator.length} funded by the creator` : ""}`;
  }

  // src/bouncer/openDoor.ts
  init_abi();

  // src/chain/market.ts
  init_abi();

  // src/chain/v4.ts
  init_abi();
  init_keccak();
  init_tape();
  var POOLS_SLOT2 = 6n;
  var EXTSLOAD = { name: "extsload", inputs: ["bytes32"], outputs: ["bytes32"] };
  var V4_EVENTS = {
    Initialize: {
      name: "Initialize",
      inputs: [
        { name: "id", type: "bytes32", indexed: true },
        { name: "currency0", type: "address", indexed: true },
        { name: "currency1", type: "address", indexed: true },
        { name: "fee", type: "uint24", indexed: false },
        { name: "tickSpacing", type: "int24", indexed: false },
        { name: "hooks", type: "address", indexed: false },
        { name: "sqrtPriceX96", type: "uint160", indexed: false },
        { name: "tick", type: "int24", indexed: false }
      ]
    }
  };
  function hexToBytes3(hex) {
    const clean2 = hex.replace(/^0x/, "");
    const out2 = new Uint8Array(clean2.length / 2);
    for (let i = 0; i < out2.length; i++) out2[i] = parseInt(clean2.slice(i * 2, i * 2 + 2), 16);
    return out2;
  }
  var ZERO = "0x0000000000000000000000000000000000000000";
  async function readV4Pools(rpc, token, quote, poolManager, options) {
    const lower = token.toLowerCase();
    const quoteLower = quote.toLowerCase();
    const window2 = { address: poolManager, events: [V4_EVENTS.Initialize], fromBlock: options.fromBlock, toBlock: options.toBlock };
    const window_ = Math.max(1, options.toBlock - options.fromBlock + 1);
    const chunking = { minChunk: 1, startChunk: options.chunkSize ?? window_, maxChunk: Math.max(2e5, window_), maxRequests: options.maxRequests ?? 20, budgetMs: options.budgetMs ?? 15e3 };
    const [asCurrency0, asCurrency1] = await Promise.all([
      readTapeAdaptive(rpc, { ...window2, topics: [addressTopic(lower)] }, chunking),
      readTapeAdaptive(rpc, { ...window2, topics: [null, addressTopic(lower)] }, chunking)
    ]);
    const found = /* @__PURE__ */ new Map();
    for (const log of [...asCurrency0.logs, ...asCurrency1.logs]) {
      const currency0 = String(log.args.currency0).toLowerCase();
      const currency1 = String(log.args.currency1).toLowerCase();
      const tokenIsCurrency0 = currency0 === lower;
      const other = tokenIsCurrency0 ? currency1 : currency0;
      if (other !== quoteLower) continue;
      const poolId = String(log.args.id);
      if (found.has(poolId)) continue;
      found.set(poolId, {
        poolId,
        fee: Number(log.args.fee),
        tickSpacing: Number(log.args.tickSpacing),
        hooks: String(log.args.hooks).toLowerCase(),
        tokenIsCurrency0
      });
    }
    if (!found.size) return [];
    const keys = [...found.values()].slice(0, options.maxPools ?? 16);
    const calls = [];
    for (const key of keys) {
      const stateSlot = keccak256Hex(hexToBytes3(`0x${key.poolId.slice(2)}${encodeWord("uint256", POOLS_SLOT2)}`));
      const liquiditySlot = `0x${(BigInt(stateSlot) + 3n).toString(16).padStart(64, "0")}`;
      calls.push({ to: poolManager, data: encodeCall(EXTSLOAD, [stateSlot]) });
      calls.push({ to: poolManager, data: encodeCall(EXTSLOAD, [liquiditySlot]) });
    }
    const raws = await rpc.callBatchSettled(calls, options.toBlock);
    const pools = [];
    keys.forEach((key, i) => {
      const slot0Raw = raws[i * 2];
      const liquidityRaw = raws[i * 2 + 1];
      if (slot0Raw instanceof Error || liquidityRaw instanceof Error) return;
      let sqrtPriceX96;
      let liquidity;
      try {
        sqrtPriceX96 = BigInt(slot0Raw) & (1n << 160n) - 1n;
        liquidity = BigInt(liquidityRaw) & (1n << 128n) - 1n;
      } catch {
        return;
      }
      if (sqrtPriceX96 === 0n) return;
      pools.push({
        dex: key.hooks === ZERO ? "Uniswap V4" : "Uniswap V4 (hooked)",
        kind: "v4",
        address: poolManager,
        poolId: key.poolId,
        hooks: key.hooks,
        tickSpacing: key.tickSpacing,
        feeBps: key.fee / 100,
        tokenIsToken0: key.tokenIsCurrency0,
        // V4 holds every pool's funds in one contract, so a balance of the
        // PoolManager is not this pool's reserves. Leaving these null is the
        // truthful answer; the price and liquidity below are what a swap uses.
        tokenReserve: null,
        quoteReserve: null,
        sqrtPriceX96,
        liquidity
      });
    });
    return pools;
  }

  // src/chain/market.ts
  var Q962 = 2n ** 96n;
  var BATCH_SLICE = 40;
  var FACTORY_FUNCTIONS2 = {
    getPool: { name: "getPool", inputs: ["address", "address", "uint24"], outputs: ["address"] },
    getPair: { name: "getPair", inputs: ["address", "address"], outputs: ["address"] },
    getPoolStable: { name: "getPool", inputs: ["address", "address", "bool"], outputs: ["address"] }
  };
  var POOL_FUNCTIONS = {
    token0: { name: "token0", inputs: [], outputs: ["address"] },
    token1: { name: "token1", inputs: [], outputs: ["address"] },
    slot0: { name: "slot0", inputs: [], outputs: ["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"] },
    liquidity: { name: "liquidity", inputs: [], outputs: ["uint128"] },
    fee: { name: "fee", inputs: [], outputs: ["uint24"] },
    getReserves: { name: "getReserves", inputs: [], outputs: ["uint112", "uint112", "uint32"] },
    getReservesWide: { name: "getReserves", inputs: [], outputs: ["uint256", "uint256", "uint256"] },
    stable: { name: "stable", inputs: [], outputs: ["bool"] }
  };
  async function discoverPools(rpc, token, quote, candidates, block, known = /* @__PURE__ */ new Set()) {
    const subject = token.toLowerCase();
    const weth = quote.toLowerCase();
    const ask = candidates.filter((c) => {
      const a = c.address.toLowerCase();
      return a !== subject && a !== weth && !known.has(a);
    });
    if (!ask.length) return [];
    const calls = ask.flatMap((c) => [
      { to: c.address, data: encodeCall(POOL_FUNCTIONS.token0, []) },
      { to: c.address, data: encodeCall(POOL_FUNCTIONS.token1, []) }
    ]);
    const raws = [];
    for (let i = 0; i < calls.length; i += BATCH_SLICE) {
      try {
        raws.push(...await rpc.callBatchSettled(calls.slice(i, i + BATCH_SLICE), block));
      } catch (error) {
        for (let k = i; k < Math.min(i + BATCH_SLICE, calls.length); k++) raws.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const found = [];
    ask.forEach((candidate, i) => {
      const zero = raws[i * 2];
      const one = raws[i * 2 + 1];
      if (zero instanceof Error || one instanceof Error || zero === void 0 || one === void 0) return;
      let token0;
      let token1;
      try {
        [token0] = decodeOutputs(POOL_FUNCTIONS.token0, zero);
        [token1] = decodeOutputs(POOL_FUNCTIONS.token1, one);
      } catch {
        return;
      }
      const pair = [token0.toLowerCase(), token1.toLowerCase()];
      if (!(pair.includes(subject) && pair.includes(weth))) return;
      found.push({
        // "unknown" until the pool says otherwise, below. Defaulting to V2 here
        // would mean a concentrated pool got priced by constant product over its
        // raw balances, which overstates a sale worst on the large one.
        // No article in the label. Every sentence that prints it says "the
        // ${dex} pool", and a live run produced "the an unidentified venue
        // pool's liquidity".
        dex: candidate.name || "unnamed venue",
        kind: "unknown",
        address: candidate.address.toLowerCase(),
        feeBps: 30,
        tokenIsToken0: pair[0] === subject,
        tokenReserve: null,
        quoteReserve: null
      });
    });
    if (!found.length) return [];
    await classify(rpc, found, block);
    await hydrate(rpc, token, quote, found, block);
    return found;
  }
  async function classify(rpc, pools, block) {
    const calls = pools.flatMap((p) => [
      { to: p.address, data: encodeCall(POOL_FUNCTIONS.slot0, []) },
      { to: p.address, data: encodeCall(POOL_FUNCTIONS.stable, []) },
      { to: p.address, data: encodeCall(POOL_FUNCTIONS.getReserves, []) },
      { to: p.address, data: encodeCall(POOL_FUNCTIONS.fee, []) }
    ]);
    let raws;
    try {
      raws = await rpc.callBatchSettled(calls, block);
    } catch {
      return;
    }
    pools.forEach((pool, i) => {
      const [slot0, stable, reserves, fee] = raws.slice(i * 4, i * 4 + 4);
      const ok = (raw) => typeof raw === "string" && raw.length > 2;
      if (ok(slot0)) {
        pool.kind = "v3";
        if (ok(fee)) {
          try {
            pool.feeBps = Number(decodeOutputs(POOL_FUNCTIONS.fee, fee)[0]) / 100;
          } catch {
          }
        }
        return;
      }
      if (ok(stable)) {
        try {
          pool.kind = "solidly";
          pool.stable = decodeOutputs(POOL_FUNCTIONS.stable, stable)[0];
          pool.feeBps = pool.stable ? 5 : 30;
          return;
        } catch {
        }
      }
      if (ok(reserves)) pool.kind = "v2";
    });
  }
  async function readPools(rpc, token, dex, block, tokenDecimals = 18, options = {}) {
    const asks = [];
    const calls = [];
    for (const f of dex.v3Factories ?? []) {
      for (const fee of f.feeTiers ?? DEFAULT_V3_FEE_TIERS) {
        asks.push({ dex: f.name, kind: "v3", feeBps: fee / 100 });
        calls.push({ to: f.address, data: encodeCall(FACTORY_FUNCTIONS2.getPool, [token, dex.weth, BigInt(fee)]) });
      }
    }
    for (const f of dex.v2Factories ?? []) {
      asks.push({ dex: f.name, kind: "v2", feeBps: 30 });
      calls.push({ to: f.address, data: encodeCall(FACTORY_FUNCTIONS2.getPair, [token, dex.weth]) });
    }
    for (const f of dex.solidlyFactories ?? []) {
      for (const stable of [false, true]) {
        asks.push({ dex: f.name, kind: "solidly", feeBps: stable ? 5 : 30, stable });
        calls.push({ to: f.address, data: encodeCall(FACTORY_FUNCTIONS2.getPoolStable, [token, dex.weth, stable]) });
      }
    }
    const v4 = options.v4PoolManager && options.v4FromBlock !== void 0 ? readV4Pools(rpc, token, dex.weth, options.v4PoolManager, { fromBlock: Math.max(0, options.v4FromBlock), toBlock: block }).catch(() => []) : Promise.resolve([]);
    if (!calls.length) {
      const only = await v4;
      const candidates2 = await resolveCandidates(options.candidates);
      const extra = candidates2.length ? await discoverPools(rpc, token, dex.weth, candidates2, block, new Set(only.map((p) => p.address))).catch(() => []) : [];
      return [...only, ...extra].sort(byDepth);
    }
    const raws = await rpc.callBatch(calls, block);
    const found = [];
    const seen = /* @__PURE__ */ new Set();
    raws.forEach((raw, i) => {
      try {
        const [address] = decodeOutputs(FACTORY_FUNCTIONS2.getPool, raw);
        if (!address || address === ZERO_ADDRESS || seen.has(address)) return;
        seen.add(address);
        found.push({ ...asks[i], address, tokenIsToken0: false, tokenReserve: null, quoteReserve: null });
      } catch {
      }
    });
    const v4Pools = await v4;
    if (found.length) await hydrate(rpc, token, dex.weth, found, block);
    const all = [...found, ...v4Pools];
    const candidates = await resolveCandidates(options.candidates);
    if (candidates.length) {
      const known = new Set(all.map((p) => p.address));
      const extra = await discoverPools(rpc, token, dex.weth, candidates, block, known).catch(() => []);
      all.push(...extra);
    }
    return all.sort(byDepth);
  }
  async function resolveCandidates(candidates) {
    if (!candidates) return [];
    try {
      return await candidates;
    } catch {
      return [];
    }
  }
  async function hydrate(rpc, token, quote, pools, block) {
    const calls = [];
    const plan = [];
    const want = (pool, field, to, data) => {
      plan.push({ pool, field });
      calls.push({ to, data });
    };
    for (const p of pools) {
      want(p, "token0", p.address, encodeCall(POOL_FUNCTIONS.token0, []));
      want(p, "tokenReserve", token, encodeCall(ERC20_FUNCTIONS.balanceOf, [p.address]));
      want(p, "quoteReserve", quote, encodeCall(ERC20_FUNCTIONS.balanceOf, [p.address]));
      if (p.kind === "v3") {
        want(p, "slot0", p.address, encodeCall(POOL_FUNCTIONS.slot0, []));
        want(p, "liquidity", p.address, encodeCall(POOL_FUNCTIONS.liquidity, []));
        want(p, "fee", p.address, encodeCall(POOL_FUNCTIONS.fee, []));
      }
    }
    let raws;
    try {
      raws = await rpc.callBatchSettled(calls, block);
    } catch {
      return;
    }
    plan.forEach(({ pool, field }, i) => {
      const raw = raws[i];
      if (raw instanceof Error) return;
      try {
        if (field === "token0") pool.tokenIsToken0 = decodeOutputs(POOL_FUNCTIONS.token0, raw)[0].toLowerCase() === token.toLowerCase();
        else if (field === "tokenReserve") pool.tokenReserve = decodeOutputs(ERC20_FUNCTIONS.balanceOf, raw)[0];
        else if (field === "quoteReserve") pool.quoteReserve = decodeOutputs(ERC20_FUNCTIONS.balanceOf, raw)[0];
        else if (field === "slot0") pool.sqrtPriceX96 = decodeOutputs(POOL_FUNCTIONS.slot0, raw)[0];
        else if (field === "liquidity") pool.liquidity = decodeOutputs(POOL_FUNCTIONS.liquidity, raw)[0];
        else if (field === "fee") pool.feeBps = Number(decodeOutputs(POOL_FUNCTIONS.fee, raw)[0]) / 100;
      } catch {
      }
    });
  }
  function depth(pool) {
    if (pool.quoteReserve !== null) return pool.quoteReserve;
    const sqrt = pool.sqrtPriceX96 ?? 0n;
    const liquidity = pool.liquidity ?? 0n;
    if (sqrt <= 0n || liquidity <= 0n) return -1n;
    return pool.tokenIsToken0 ? liquidity * sqrt / Q962 : liquidity * Q962 / sqrt;
  }
  var byDepth = (a, b) => {
    const x = depth(a);
    const y = depth(b);
    return y > x ? 1 : y < x ? -1 : 0;
  };
  function canPrice(pool) {
    if (pool.kind === "unknown") return false;
    if (pool.kind === "v3" || pool.kind === "v4") return (pool.sqrtPriceX96 ?? 0n) > 0n && (pool.liquidity ?? 0n) > 0n;
    if (pool.kind === "solidly" && pool.stable) return false;
    return (pool.tokenReserve ?? 0n) > 0n && (pool.quoteReserve ?? 0n) > 0n;
  }
  function spotPrice(pool, tokenDecimals) {
    const one = 10n ** BigInt(tokenDecimals);
    if (pool.kind === "v3" || pool.kind === "v4") {
      const sqrt = pool.sqrtPriceX96 ?? 0n;
      if (sqrt <= 0n) return null;
      return pool.tokenIsToken0 ? sqrt * sqrt * one / (Q962 * Q962) : Q962 * Q962 * one / (sqrt * sqrt);
    }
    const t = pool.tokenReserve ?? 0n;
    const q2 = pool.quoteReserve ?? 0n;
    if (t <= 0n || q2 <= 0n) return null;
    return q2 * one / t;
  }
  function quoteSale(pool, tokensIn) {
    if (tokensIn <= 0n || !canPrice(pool)) return null;
    const feeBps = BigInt(Math.round(pool.feeBps));
    const afterFee = tokensIn * (10000n - feeBps) / 10000n;
    if (afterFee <= 0n) return { out: 0n, beyondTick: false };
    if (pool.kind !== "v3" && pool.kind !== "v4") {
      const t = pool.tokenReserve ?? 0n;
      const q2 = pool.quoteReserve ?? 0n;
      const out3 = afterFee * q2 / (t + afterFee);
      return { out: out3 > q2 ? q2 : out3, beyondTick: false };
    }
    const sqrt = pool.sqrtPriceX96;
    const L = pool.liquidity;
    if (pool.tokenIsToken0) {
      const denominator = L * Q962 + afterFee * sqrt;
      if (denominator <= 0n) return null;
      const sqrtNext2 = L * Q962 * sqrt / denominator;
      const out3 = L * (sqrt - sqrtNext2) / Q962;
      return { out: out3, beyondTick: sqrtNext2 * 2n < sqrt };
    }
    const sqrtNext = sqrt + afterFee * Q962 / L;
    if (sqrtNext <= sqrt) return { out: 0n, beyondTick: false };
    const out2 = L * Q962 * (sqrtNext - sqrt) / (sqrtNext * sqrt);
    return { out: out2, beyondTick: sqrtNext > sqrt * 2n };
  }
  function readMarket(pools, position, tokenDecimals, quoteSymbol) {
    const priceable = pools.filter(canPrice);
    const best = priceable[0] ?? null;
    if (!best) {
      return {
        pools,
        best: null,
        spot: null,
        quotes: [],
        note: pools.length ? `A pool exists but nothing in it could be priced: ${pools.every((p) => p.stable) ? "a Solidly stable pool uses an invariant this does not model" : "its reserves or price did not read"}.` : `No ${quoteSymbol} pool on the chain's known DEX factories. It may trade on another venue, against another pair, or not at all.`
      };
    }
    const spot = spotPrice(best, tokenDecimals);
    const one = 10n ** BigInt(tokenDecimals);
    const quotes = [];
    for (const shareBps of [1e3, 2500, 5e3, 1e4]) {
      const tokensIn = position * BigInt(shareBps) / 10000n;
      const priced2 = quoteSale(best, tokensIn);
      if (!priced2 || tokensIn <= 0n) continue;
      const reference = spot !== null ? spot * tokensIn / one : 0n;
      quotes.push({
        shareBps,
        tokensIn,
        out: priced2.out,
        realisedBps: reference > 0n ? Number(priced2.out * 10000n / reference) : 0,
        beyondTick: priced2.beyondTick
      });
    }
    const crosses = quotes.some((q2) => q2.beyondTick);
    return {
      pools,
      best,
      spot,
      quotes,
      note: `Priced on the ${best.dex} ${best.kind === "v3" ? "V3" : best.kind === "v4" ? "V4" : best.kind === "v2" ? "V2" : best.kind === "solidly" ? "Solidly" : "unidentified"} pool at ${(best.feeBps / 100).toFixed(2)}% fee, from its state at this block. ` + (best.kind === "v3" || best.kind === "v4" ? `Concentrated liquidity: exact inside the current tick${crosses ? ", and the larger sizes leave it, so the real answer depends on ticks this does not read" : ""}. ` : "Constant product, so the arithmetic is exact for the pool. ") + `The token's own transfer tax, if it has one, is not included, and nothing here is a promise about a trade.`
    };
  }

  // src/chain/liquidity.ts
  init_abi();
  var ZERO2 = "0x0000000000000000000000000000000000000000";
  var DEAD = "0x000000000000000000000000000000000000dead";
  var BURN_ADDRESSES = /* @__PURE__ */ new Set([ZERO2, DEAD, "0x0000000000000000000000000000000000000001"]);
  var LP_FUNCTIONS = {
    ownerOf: { name: "ownerOf", inputs: ["uint256"], outputs: ["address"] }
  };
  var POOL_EVENTS = {
    /** Uniswap V3 / PancakeSwap V3. `owner` is the position manager for an NFT position. */
    Mint: {
      name: "Mint",
      inputs: [
        { name: "sender", type: "address", indexed: false },
        { name: "owner", type: "address", indexed: true },
        { name: "tickLower", type: "int24", indexed: true },
        { name: "tickUpper", type: "int24", indexed: true },
        { name: "amount", type: "uint128", indexed: false },
        { name: "amount0", type: "uint256", indexed: false },
        { name: "amount1", type: "uint256", indexed: false }
      ]
    }
  };
  var MANAGER_EVENTS = {
    /** Emitted by the NonfungiblePositionManager in the same transaction as the pool's Mint. */
    IncreaseLiquidity: {
      name: "IncreaseLiquidity",
      inputs: [
        { name: "tokenId", type: "uint256", indexed: true },
        { name: "liquidity", type: "uint128", indexed: false },
        { name: "amount0", type: "uint256", indexed: false },
        { name: "amount1", type: "uint256", indexed: false }
      ]
    }
  };
  function classify2(address, lockers, hasCode) {
    const lower = address.toLowerCase();
    if (BURN_ADDRESSES.has(lower)) return { kind: "burned" };
    const known = lockers?.[lower];
    if (known) return { kind: "locked", name: known };
    return { kind: hasCode ? "contract" : "wallet" };
  }
  var bps2 = (part, whole) => whole > 0n ? Number(part * 10000n / whole) : 0;
  async function readV2Lock(rpc, pool, lockers, block) {
    const base = { pool: pool.address, dex: pool.dex, kind: pool.kind, read: false, burnedBps: 0, lockedBps: 0, freeBps: 0, partial: false, positionsFound: 0, positionsRead: 0, holders: [], shareOfLiquidityBps: 1e4, unread: "" };
    const lockerAddresses = Object.keys(lockers ?? {});
    const asked = [ZERO2, DEAD, ...lockerAddresses];
    const calls = [
      { to: pool.address, data: encodeCall(ERC20_FUNCTIONS.totalSupply, []) },
      ...asked.map((a) => ({ to: pool.address, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [a]) }))
    ];
    let raws;
    try {
      raws = await rpc.callBatchSettled(calls, block);
    } catch {
      return { ...base, unread: "the LP token did not answer, so who holds the liquidity is not read" };
    }
    const supplyRaw = raws[0];
    if (supplyRaw instanceof Error) return { ...base, unread: "the LP token's total supply did not answer, so the shares below cannot be worked out" };
    let supply;
    try {
      supply = decodeOutputs(ERC20_FUNCTIONS.totalSupply, supplyRaw)[0];
    } catch {
      return { ...base, unread: "the LP token's total supply could not be read" };
    }
    if (supply === 0n) return { ...base, unread: "this pool has no LP tokens outstanding" };
    let accounted = 0n;
    const holders = [];
    asked.forEach((address, i) => {
      const raw = raws[i + 1];
      if (raw instanceof Error) return;
      let balance;
      try {
        balance = decodeOutputs(ERC20_FUNCTIONS.balanceOf, raw)[0];
      } catch {
        return;
      }
      if (balance === 0n) return;
      accounted += balance;
      const { kind, name } = classify2(address, lockers, true);
      holders.push({ address, kind, name, shareBps: bps2(balance, supply) });
    });
    const burnedBps = holders.filter((h) => h.kind === "burned").reduce((a, h) => a + h.shareBps, 0);
    const lockedBps = holders.filter((h) => h.kind === "locked").reduce((a, h) => a + h.shareBps, 0);
    const freeBps = Math.max(0, 1e4 - burnedBps - lockedBps);
    return {
      ...base,
      read: true,
      burnedBps,
      lockedBps,
      freeBps,
      holders: holders.sort((a, b) => b.shareBps - a.shareBps),
      // The remainder is held by addresses this read did not enumerate. Naming
      // them needs an explorer; not naming them does not make them safe.
      unread: freeBps > 0 ? "the rest of the LP tokens sit in wallets this read does not enumerate; any of them can withdraw" : ""
    };
  }
  async function nameHolders(lock, nameOf, limit = 6) {
    if (!nameOf) return lock;
    const unnamed = lock.holders.filter((h) => !h.name && h.kind === "contract").slice(0, limit);
    if (!unnamed.length) return lock;
    const names = await Promise.all(unnamed.map((h) => nameOf(h.address).catch(() => null)));
    unnamed.forEach((holder, i) => {
      const name = names[i];
      if (name) {
        holder.name = name;
        holder.namedByExplorer = true;
      }
    });
    return lock;
  }
  async function readV3Lock(rpc, pool, lockers, positionManager, block, options) {
    const base = { pool: pool.address, dex: pool.dex, kind: pool.kind, read: false, burnedBps: 0, lockedBps: 0, freeBps: 0, partial: false, positionsFound: 0, positionsRead: 0, holders: [], shareOfLiquidityBps: 1e4, unread: "" };
    const maxPositions = options.maxPositions ?? 60;
    let logs;
    let windowComplete = true;
    try {
      const { readTapeAdaptive: readTapeAdaptive2 } = await Promise.resolve().then(() => (init_tape(), tape_exports));
      const tape = await readTapeAdaptive2(
        rpc,
        { address: pool.address, events: [POOL_EVENTS.Mint], fromBlock: options.fromBlock, toBlock: block },
        // The budget is the whole point on a busy pool. USDC/WETH on Base makes
        // the endpoint refuse every wide chunk, so the span halves to a single
        // block and a week's window becomes hundreds of thousands of requests —
        // ten minutes of a door, and then nothing to show for it.
        //
        // Twenty thousand to open, not two. Unlike the V4 scan next door this
        // filter is not selective — every mint on the pool matches — so the
        // whole window in one request is a real risk of a refusal on a busy
        // pair. But two thousand meant five round trips to walk a day on Base
        // before the doubling caught up, and that cost is paid by every
        // memecoin pool, which is quiet, to spare the handful that are not.
        { minChunk: 1, startChunk: options.chunkSize ?? 2e4, maxChunk: 1e5, maxRequests: options.maxRequests ?? 15, budgetMs: options.budgetMs ?? 2e4 }
      );
      logs = tape.logs;
      windowComplete = tape.complete !== false;
    } catch {
      return { ...base, unread: "the pool's mint history did not answer, so who holds the liquidity is not read" };
    }
    if (!logs.length) {
      return {
        ...base,
        partial: !windowComplete,
        unread: windowComplete ? `no position was opened in this pool within the window searched (from block ${options.fromBlock}); --liquidity-blocks looks further back` : "this pool is busy enough that the walk ran out of budget before finding a position, so who holds its liquidity is not read rather than absent"
      };
    }
    const byPosition = /* @__PURE__ */ new Map();
    for (const log of logs) {
      const owner = String(log.args.owner).toLowerCase();
      const key = `${owner}:${log.args.tickLower}:${log.args.tickUpper}`;
      const prev = byPosition.get(key);
      byPosition.set(key, { owner, amount: (prev?.amount ?? 0n) + log.args.amount, tx: prev?.tx ?? log.transactionHash });
    }
    const positions = [...byPosition.values()].sort((a, b) => b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0);
    const partial = positions.length > maxPositions;
    const considered = positions.slice(0, maxPositions);
    base.positionsFound = positions.length;
    base.positionsRead = considered.length;
    const manager = positionManager?.toLowerCase();
    const realOwners = /* @__PURE__ */ new Map();
    const managed = considered.filter((p) => manager && p.owner === manager);
    if (managed.length) {
      let receipts = [];
      const RECEIPT_SLICE = 20;
      const slices = [];
      for (let i = 0; i < managed.length; i += RECEIPT_SLICE) {
        slices.push(managed.slice(i, i + RECEIPT_SLICE).map((p) => ({ method: "eth_getTransactionReceipt", params: [p.tx] })));
      }
      const answered = await Promise.all(slices.map((slice) => rpc.sendBatchSettled(slice).catch(() => slice.map(() => new Error("receipt batch refused")))));
      for (const slice of answered) receipts.push(...slice);
      const idCalls = [];
      const idFor = [];
      receipts.forEach((receipt, i) => {
        if (receipt instanceof Error || !receipt || typeof receipt !== "object") return;
        const rawLogs = receipt.logs ?? [];
        for (const raw of rawLogs) {
          const entry = raw;
          if ((entry.address ?? "").toLowerCase() !== manager) continue;
          let decoded;
          try {
            decoded = decodeLog(MANAGER_EVENTS.IncreaseLiquidity, { address: entry.address ?? "", topics: entry.topics ?? [], data: entry.data ?? "0x", blockNumber: "0x0", transactionHash: "0x", logIndex: "0x0" });
          } catch {
            continue;
          }
          idCalls.push({ to: manager, data: encodeCall(LP_FUNCTIONS.ownerOf, [decoded.args.tokenId]) });
          idFor.push({ key: `${managed[i].owner}:${managed[i].tx}` });
          break;
        }
      });
      if (idCalls.length) {
        let owners = [];
        try {
          owners = await rpc.callBatchSettled(idCalls, block);
        } catch {
          owners = [];
        }
        owners.forEach((raw, i) => {
          if (raw instanceof Error) return;
          try {
            realOwners.set(idFor[i].key, decodeOutputs(LP_FUNCTIONS.ownerOf, raw)[0].toLowerCase());
          } catch {
          }
        });
      }
    }
    const total = considered.reduce((a, p) => a + p.amount, 0n);
    if (total === 0n) return { ...base, unread: "every position found has been withdrawn" };
    const merged = /* @__PURE__ */ new Map();
    const unresolvedAt = /* @__PURE__ */ new Set();
    for (const p of considered) {
      const owner = realOwners.get(`${p.owner}:${p.tx}`);
      const resolved = owner ?? p.owner;
      if (!owner) unresolvedAt.add(resolved);
      merged.set(resolved, (merged.get(resolved) ?? 0n) + p.amount);
    }
    const addresses = [...merged.keys()];
    let codes = [];
    try {
      codes = await rpc.sendBatchSettled(addresses.map((a) => ({ method: "eth_getCode", params: [a, `0x${block.toString(16)}`] })));
    } catch {
      codes = [];
    }
    const holders = addresses.map((address, i) => {
      const code = codes[i];
      const hasCode = code instanceof Error ? null : typeof code === "string" && code.length > 2;
      const { kind, name } = classify2(address, lockers, hasCode);
      const holder = { address, kind, name, shareBps: bps2(merged.get(address) ?? 0n, total) };
      if (unresolvedAt.has(address)) holder.unresolved = true;
      return holder;
    });
    const burnedBps = holders.filter((h) => h.kind === "burned").reduce((a, h) => a + h.shareBps, 0);
    const lockedBps = holders.filter((h) => h.kind === "locked").reduce((a, h) => a + h.shareBps, 0);
    const freeBps = Math.max(0, 1e4 - burnedBps - lockedBps);
    const notes = [];
    if (!windowComplete) notes.push("the pool is busy enough that only part of the window could be walked within this read's budget, so older positions were not seen");
    if (partial) notes.push(`only the ${maxPositions} largest of ${positions.length} positions in the window were resolved, so the shares above are of those and not of the pool`);
    if (!manager) notes.push("this DEX's position manager is not in BOUNCER's table, so an NFT position is reported under the manager rather than its holder");
    const unresolved = holders.filter((h) => manager && h.address === manager);
    if (unresolved.length) notes.push("some positions could not be traced to an NFT holder and are counted as withdrawable");
    return { ...base, read: true, burnedBps, lockedBps, freeBps, partial: partial || !windowComplete, holders: holders.sort((a, b) => b.shareBps - a.shareBps), unread: notes.join("; ") };
  }
  async function readPoolLock(rpc, pool, lockers, positionManager, block, options) {
    if (pool.kind === "v3") return readV3Lock(rpc, pool, lockers, positionManager, block, options);
    if (pool.kind === "v4") {
      return { pool: pool.address, dex: pool.dex, kind: pool.kind, read: false, burnedBps: 0, lockedBps: 0, freeBps: 0, partial: false, positionsFound: 0, positionsRead: 0, holders: [], shareOfLiquidityBps: 1e4, unread: "a Uniswap V4 pool holds no LP token of its own, so who can withdraw its liquidity is not read here" };
    }
    if (pool.kind === "unknown") {
      return { pool: pool.address, dex: pool.dex, kind: pool.kind, read: false, burnedBps: 0, lockedBps: 0, freeBps: 0, partial: false, positionsFound: 0, positionsRead: 0, holders: [], shareOfLiquidityBps: 1e4, unread: "this venue was found by checking which contracts hold the token, and it is not a pool shape BOUNCER knows how to read liquidity ownership from" };
    }
    return readV2Lock(rpc, pool, lockers, block);
  }

  // src/bouncer/openDoor.ts
  init_abi();
  var POWER_MEANING = {
    mint: "create new tokens out of thin air, diluting every holder",
    pause: "freeze every transfer",
    blacklist: "block chosen wallets from selling",
    fees: "change the tax on buys and sells",
    limits: "change or remove per-wallet and per-trade caps",
    trading: "switch trading on or off",
    upgrade: "replace the contract's code",
    "burn-others": "destroy tokens held by other wallets",
    exempt: "exempt chosen wallets from fees or limits",
    sweep: "pull tokens or coins that sit in the contract"
  };
  var POWER_SIGNATURES = {
    mint: ["mint(address,uint256)", "mint(uint256)", "mint(address)", "mintTo(address,uint256)", "issue(uint256)", "issue(address,uint256)"],
    pause: ["pause()", "unpause()", "setPaused(bool)", "pauseTransfers(bool)"],
    blacklist: [
      "blacklist(address)",
      "blacklist(address,bool)",
      "addBlacklist(address)",
      "addToBlacklist(address)",
      "setBlacklist(address,bool)",
      "setBlacklisted(address,bool)",
      "blacklistAddress(address,bool)",
      "setIsBlacklisted(address,bool)",
      "blockAccount(address)",
      "blockAddress(address)",
      "setBots(address[],bool)",
      "addBots(address[])",
      "addBot(address)",
      "setBot(address,bool)",
      "delBot(address)",
      "blacklistAccount(address,bool)",
      "setBlacklistEnabled(bool)",
      "banAddress(address)",
      "setBanned(address,bool)",
      "blacklistBots(address[])",
      "multiBlacklist(address[])",
      "blacklistMultipleWallets(address[])",
      "addSniper(address)",
      "setSniper(address,bool)"
    ],
    fees: [
      "setFee(uint256)",
      "setFees(uint256,uint256)",
      "setFees(uint256,uint256,uint256)",
      "setTaxes(uint256,uint256)",
      "setTax(uint256)",
      "setBuyFee(uint256)",
      "setSellFee(uint256)",
      "setBuyTax(uint256)",
      "setSellTax(uint256)",
      "updateFees(uint256,uint256)",
      "updateBuyFees(uint256,uint256)",
      "updateSellFees(uint256,uint256)",
      "updateBuyFees(uint256,uint256,uint256)",
      "updateSellFees(uint256,uint256,uint256)",
      "setTaxFee(uint256)",
      "setTaxFeePercent(uint256)",
      "setLiquidityFeePercent(uint256)",
      "setFeePercent(uint256)",
      "setTransferFee(uint256)",
      "setTransferTax(uint256)",
      "reduceFee(uint256)",
      "reduceFees(uint256,uint256)",
      "changeFees(uint256,uint256)",
      "setSellFeePercent(uint256)",
      "setBuyFeePercent(uint256)",
      "setMarketingFee(uint256)",
      "setFeeRate(uint256)",
      "updateTaxes(uint256,uint256)",
      "setTradingFees(uint256,uint256)"
    ],
    limits: [
      "setMaxTxAmount(uint256)",
      "setMaxTx(uint256)",
      "setMaxTxPercent(uint256)",
      "setMaxWallet(uint256)",
      "setMaxWalletAmount(uint256)",
      "setMaxWalletPercent(uint256)",
      "setMaxWalletSize(uint256)",
      "updateMaxTxnAmount(uint256)",
      "updateMaxWalletAmount(uint256)",
      "removeLimits()",
      "removeAllLimits()",
      "setLimits(uint256,uint256)",
      "setMaxBuy(uint256)",
      "setMaxSell(uint256)",
      "setMaxTransaction(uint256)",
      "setCooldownEnabled(bool)",
      "setTransferDelayEnabled(bool)",
      "setLimitsInEffect(bool)"
    ],
    trading: ["enableTrading()", "openTrading()", "startTrading()", "setTradingEnabled(bool)", "setTrading(bool)", "setTradingOpen(bool)", "enableTrading(bool)", "tradingStatus(bool)", "setTradingStatus(bool)", "toggleTrading()", "activateTrading()", "setTradingActive(bool)", "setLaunched(bool)"],
    upgrade: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)", "setImplementation(address)", "changeImplementation(address)"],
    "burn-others": ["burn(address,uint256)", "burnTokens(address,uint256)"],
    exempt: ["excludeFromFees(address,bool)", "excludeFromFee(address)", "excludeFromFee(address,bool)", "setExcludedFromFees(address,bool)", "excludeFromLimits(address,bool)", "setExcludedFromMaxTransaction(address,bool)", "excludeMultipleAccountsFromFees(address[],bool)", "setFeeExempt(address,bool)", "setIsExcludedFromFee(address,bool)", "excludeFromMaxTransaction(address,bool)", "setExcludeFromMaxWallet(address,bool)"],
    sweep: ["manualSwap()", "manualswap()", "manualSend()", "manualsend()", "clearStuckBalance()", "clearStuckBalance(uint256)", "withdrawStuckETH()", "withdrawStuckEth()", "withdrawStuckTokens(address)", "withdrawStuckTokens(address,uint256)", "rescueTokens(address)", "rescueTokens(address,uint256)", "rescueETH()", "rescueETH(uint256)", "claimStuckTokens(address)", "sweep(address)", "recoverERC20(address,uint256)"]
  };
  var OWNER_FUNCTIONS = {
    owner: { name: "owner", inputs: [], outputs: ["address"] },
    getOwner: { name: "getOwner", inputs: [], outputs: ["address"] },
    paused: { name: "paused", inputs: [], outputs: ["bool"] },
    transfer: { name: "transfer", inputs: ["address", "uint256"], outputs: ["bool"] }
  };
  var TRADING_VIEWS = ["tradingOpen()", "tradingEnabled()", "tradingActive()", "isTradingEnabled()", "tradingIsEnabled()", "launched()", "tradingLive()", "tradingStarted()"];
  var RENOUNCE_SIGNATURES = ["renounceOwnership()", "transferOwnership(address)"];
  var TRANSFER_SIGNATURE = "transfer(address,uint256)";
  var PROBE_RECIPIENT = "0x000000000000000000000000000000000000b0ce";
  var BURN_ADDRESSES2 = /* @__PURE__ */ new Set([ZERO_ADDRESS, "0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000001"]);
  async function readOpenDoor(rpc, token, meta, block, options = {}) {
    const address = token.address.toLowerCase();
    const implementation = token.proxyImplementation ?? token.proxyBeacon ?? token.code.minimalProxyTarget;
    const head = new ReadBatch(rpc, block);
    const implSlot = implementation ? head.getCode(implementation) : null;
    const ownerSlot = head.call(address, encodeCall(OWNER_FUNCTIONS.owner, []));
    const getOwnerSlot = head.call(address, encodeCall(OWNER_FUNCTIONS.getOwner, []));
    const pausedSlot = head.call(address, encodeCall(OWNER_FUNCTIONS.paused, []));
    const tradingSlots = TRADING_VIEWS.map((view2) => head.call(address, encodeCall({ name: view2.slice(0, -2), inputs: [], outputs: ["bool"] }, [])));
    await head.run();
    let surfaceFrom = "token";
    let code = token.runtime;
    if (implementation) {
      const implCode = head.hex(implSlot);
      surfaceFrom = implCode && implCode.length > 2 ? "implementation" : "implementation-unreadable";
      if (implCode && implCode.length > 2) code = implCode;
    }
    const { all: present, push4 } = readSelectors(code);
    const has = (signature) => present.has(selector(signature));
    const powers = [];
    for (const kind of Object.keys(POWER_SIGNATURES)) {
      for (const signature of POWER_SIGNATURES[kind]) if (has(signature)) powers.push({ kind, signature });
    }
    const ownable = RENOUNCE_SIGNATURES.some(has);
    const ownerRead = readOwnerFrom(head.answer(ownerSlot), head.answer(getOwnerSlot));
    const owner = ownerRead.owner;
    const ownerIsContract = owner && !owner.renounced && !options.skipOwnerWallet ? rpc.getCode(owner.address, block).then((c) => c.length > 2).catch(() => false) : Promise.resolve(owner && !owner.renounced && options.skipOwnerWallet ? null : false);
    const paused = readBoolFrom(OWNER_FUNCTIONS.paused, head.answer(pausedSlot));
    let tradingOpen = null;
    for (let i = 0; i < TRADING_VIEWS.length; i++) {
      const view2 = TRADING_VIEWS[i];
      if (!has(view2)) continue;
      const open = readBoolFrom({ name: view2.slice(0, -2), inputs: [], outputs: ["bool"] }, head.answer(tradingSlots[i]));
      if (open !== null) tradingOpen = { view: view2, open };
      break;
    }
    const supply = meta?.totalSupply ?? null;
    const bps3 = (v) => supply !== null && supply > 0n ? Number(v * 10000n / supply) : null;
    const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
    const bsEarly = options.skipExplorer ? null : options.blockscout;
    const holderList = bsEarly ? bsEarly.tokenHolders(address, 50).catch(() => null) : Promise.resolve(null);
    const addressInfoP = bsEarly ? settle(bsEarly.addressInfo(address)) : null;
    const tokenInfoP = bsEarly ? bsEarly.tokenInfo(address).catch(() => ({ holders: null, transfers: null, type: null, priceUsd: null, volume24hUsd: null, marketCapUsd: null })) : null;
    const transfersP = bsEarly ? settle(bsEarly.tokenTransfers(address)) : null;
    const unwrap = async (p, fallback) => {
      if (!p) return fallback();
      const settled = await p;
      if ("error" in settled) throw settled.error;
      return settled.value;
    };
    const deployerRead = bsEarly ? settle(
      (async () => {
        const read = await unwrap(addressInfoP, () => bsEarly.addressInfo(address));
        if (!read.creator) return { info: read, deployer: null };
        const whenP = (async () => {
          if (!read.creationTx) return { createdAtBlock: null, createdAt: null };
          try {
            const receipt = await rpc.send("eth_getTransactionReceipt", [read.creationTx]);
            if (!receipt?.blockNumber) return { createdAtBlock: null, createdAt: null };
            const createdAtBlock2 = Number(BigInt(receipt.blockNumber));
            return { createdAtBlock: createdAtBlock2, createdAt: (await rpc.getBlock(createdAtBlock2)).timestamp };
          } catch {
            return { createdAtBlock: null, createdAt: null };
          }
        })();
        const [{ createdAtBlock, createdAt }, balance] = await Promise.all([whenP, readBalance(rpc, address, read.creator, block).catch(() => null)]);
        return {
          info: read,
          deployer: { address: read.creator, creationTx: read.creationTx, createdAtBlock, createdAt, balance: balance ?? 0n, bps: balance === null ? null : bps3(balance) }
        };
      })()
    ) : null;
    const ownerBalanceP = owner && !owner.renounced && !options.skipOwnerWallet ? readBalance(rpc, address, owner.address, block).then((balance) => ({ balance, bps: bps3(balance) })).catch(() => null) : Promise.resolve(null);
    const candidatesP = options.skipProbes || !has(TRANSFER_SIGNATURE) ? Promise.resolve({ value: [] }) : settle(
      (async () => {
        const listed = await holderList ?? [];
        const settledInfo = addressInfoP ? await addressInfoP : null;
        const deployerAddress = settledInfo && !("error" in settledInfo) ? settledInfo.value.creator : null;
        return probeCandidates(rpc, address, block, listed, deployerAddress, owner?.address ?? null, options.probeHolders ?? 3, options.recentBlocks);
      })()
    );
    let pools = null;
    let market = null;
    let liquidity = null;
    if (options.dex && !options.skipMarket) {
      try {
        pools = await readPools(rpc, address, options.dex, block, meta?.decimals ?? 18, {
          v4PoolManager: options.v4PoolManager,
          v4FromBlock: options.liquidityFromBlock,
          // The promise, not its value. Awaiting it here would put an explorer
          // round trip in front of every factory read that could have been
          // running meanwhile; readPools needs it only at the end.
          //
          // Contracts only, and only the twenty largest: a wallet is not a pool,
          // the list is largest-first, and a pool is a large holder by
          // definition, so the tail is two calls each for a certain revert.
          candidates: holderList.then((listed) => (listed ?? []).filter((h) => h.isContract && !h.delegated).slice(0, 20).map((h) => ({ address: h.address, name: h.name })))
        });
        const position = options.position ?? (supply !== null && supply > 0n ? supply / 100n : 0n);
        if (position > 0n) market = readMarket(pools, position, meta?.decimals ?? 18, options.dex.wethSymbol);
      } catch {
        pools = null;
      }
      const readable = (pools ?? []).filter((p) => p.kind === "v2" || p.kind === "v3" || p.kind === "solidly");
      const deepest = readable[0] ?? pools?.[0] ?? null;
      if (deepest && options.liquidity !== false) {
        try {
          const LIQUIDITY_BUDGET_MS = options.liquidityDeadlineMs ?? 3500;
          liquidity = await Promise.race([
            readPoolLock(rpc, deepest, options.lockers, options.dex.v3PositionManager, block, {
              fromBlock: Math.max(0, options.liquidityFromBlock ?? block - 5e5),
              budgetMs: options.liquidityBudgetMs ?? 2500
            }),
            new Promise(
              (resolve) => setTimeout(
                () => resolve({
                  pool: deepest.address,
                  dex: deepest.dex,
                  kind: deepest.kind,
                  read: false,
                  burnedBps: 0,
                  lockedBps: 0,
                  freeBps: 0,
                  partial: false,
                  positionsFound: 0,
                  positionsRead: 0,
                  holders: [],
                  shareOfLiquidityBps: 0,
                  unread: `the endpoint did not answer the liquidity history within ${LIQUIDITY_BUDGET_MS / 1e3} seconds, so who can withdraw this pool was not read`
                }),
                LIQUIDITY_BUDGET_MS
              )
            )
          ]);
          const bs2 = options.blockscout;
          if (bs2) {
            const byAddress = new Map((await holderList.catch(() => null) ?? []).filter((h) => h.name).map((h) => [h.address.toLowerCase(), h.name]));
            const named = nameHolders(liquidity, async (address2) => {
              const known = byAddress.get(address2.toLowerCase());
              if (known) return known;
              return (await bs2.addressInfo(address2)).name;
            }, 10);
            liquidity = await Promise.race([named, new Promise((resolve) => setTimeout(() => resolve(liquidity), 1500))]);
          }
          const total = (pools ?? []).reduce((a, p) => a + (depth(p) > 0n ? depth(p) : 0n), 0n);
          const mine = depth(deepest) > 0n ? depth(deepest) : 0n;
          liquidity.shareOfLiquidityBps = total > 0n ? Number(mine * 10000n / total) : 1e4;
        } catch {
          liquidity = null;
        }
      }
    }
    let holders = null;
    let deployer = null;
    let activity = null;
    let verified = null;
    let explorer = null;
    let explorerError = null;
    let explorerMissing = 0;
    const note = (error) => {
      if (error instanceof BlockscoutError && error.notIndexed) {
        explorerMissing++;
        return;
      }
      const text = error instanceof Error ? error.message : String(error);
      explorerError = explorerError ? `${explorerError}; ${text}` : text;
    };
    const bs = options.skipExplorer ? null : options.blockscout;
    if (bs) {
      let info = null;
      const read = deployerRead ? await deployerRead : null;
      if (read && "error" in read) note(read.error);
      else if (read) {
        info = read.value.info;
        verified = read.value.info.isVerified;
        deployer = read.value.deployer;
      }
      try {
        const [listed, tokenInfo] = await Promise.all([
          holderList,
          tokenInfoP ?? bs.tokenInfo(address).catch(() => ({ holders: null, transfers: null, type: null, priceUsd: null, volume24hUsd: null, marketCapUsd: null }))
        ]);
        if (!listed) throw new Error("the explorer did not return the token's holders");
        const list = listed;
        explorer = {
          isScam: info ? info.isScam : null,
          priceUsd: tokenInfo.priceUsd,
          volume24hUsd: tokenInfo.volume24hUsd,
          marketCapUsd: tokenInfo.marketCapUsd,
          tokenType: tokenInfo.type,
          ageSeconds: bs.oldestSeconds
        };
        const top = list.map((h) => ({
          address: h.address,
          value: h.value,
          bps: bps3(h.value),
          isContract: h.isContract && !h.delegated,
          delegated: h.delegated,
          name: h.name,
          role: h.address === deployer?.address ? "deployer" : owner && h.address === owner.address ? "owner" : h.address === address ? "token" : BURN_ADDRESSES2.has(h.address) ? "burn" : null
        }));
        const wallets = top.filter((h) => !h.isContract && h.role !== "burn" && h.role !== "token");
        const share = (rows) => {
          if (supply === null || supply <= 0n || !rows.length) return null;
          return rows.reduce((a, h) => a + (h.bps ?? 0), 0);
        };
        holders = {
          count: tokenInfo.holders,
          transfers: tokenInfo.transfers,
          top,
          rows: top.length,
          top10WalletsBps: share(wallets.slice(0, 10)),
          contractsBps: share(top.filter((h) => h.isContract || h.role === "token")),
          burnedBps: share(top.filter((h) => h.role === "burn"))
        };
      } catch (error) {
        note(error);
        holders = null;
      }
      if (explorer === null && info) explorer = { isScam: info.isScam, priceUsd: null, volume24hUsd: null, marketCapUsd: null, tokenType: null, ageSeconds: bs.oldestSeconds };
      try {
        activity = summariseActivity(await unwrap(transfersP, () => bs.tokenTransfers(address)));
      } catch (error) {
        note(error);
        activity = null;
      }
    }
    const ownerBalance = await ownerBalanceP;
    const probes = [];
    let probesSkipped = null;
    if (options.skipProbes) {
      probesSkipped = "the sale simulation is still running";
    } else if (!has(TRANSFER_SIGNATURE)) {
      probesSkipped = surfaceFrom === "implementation-unreadable" ? "the code that actually runs could not be read, so no transfer was simulated" : "this contract has no transfer(address,uint256) function, so it is not an ERC-20 and no transfer was simulated";
    } else {
      const settledCandidates = await candidatesP;
      const candidates = "error" in settledCandidates ? [] : settledCandidates.value;
      if (!candidates.length) {
        probesSkipped = "no wallet with a readable balance to simulate from";
      } else {
        const deepest = (pools ?? []).filter((p) => (p.quoteReserve ?? 0n) > 0n || canPrice(p))[0] ?? null;
        const wanted = [];
        for (const c of candidates) {
          wanted.push({ from: c.address, to: PROBE_RECIPIENT, target: "fresh-wallet", source: c.source });
          if (deepest) wanted.push({ from: c.address, to: deepest.address, target: "pool", source: c.source });
        }
        probes.push(...await probeTransfers(rpc, address, wanted, block));
      }
    }
    return {
      selectors: push4.size,
      constants: present.size,
      surfaceFrom,
      powers,
      ownable,
      owner: owner ? { ...owner, isContract: await ownerIsContract } : null,
      ownerUnread: ownerRead.unread,
      paused,
      tradingOpen,
      probes,
      transferFunction: has(TRANSFER_SIGNATURE),
      probesSkipped,
      probesPending: options.skipProbes === true,
      ownerWalletPending: options.skipOwnerWallet === true,
      verified,
      deployer,
      ownerBalance,
      explorer,
      explorerError,
      explorerNotIndexed: explorerMissing > 0 && explorerError === null,
      pools,
      market,
      liquidity,
      holders,
      activity
    };
  }
  async function probeCandidates(rpc, token, block, holders, deployer, owner, want, recentBlocks) {
    const excluded = new Set([token, deployer, owner].filter((x) => Boolean(x)).map((x) => x.toLowerCase()));
    let shortlist = holders.filter((h) => (!h.isContract || h.delegated) && !BURN_ADDRESSES2.has(h.address) && !excluded.has(h.address) && h.value > 0n).slice(0, Math.max(want * 3, 9)).map((h) => h.address);
    if (!shortlist.length) shortlist = await recentRecipients(rpc, token, block, excluded, Math.max(want * 4, 12), recentBlocks);
    const out2 = [];
    if (shortlist.length) {
      try {
        const balances = await rpc.callBatch(
          shortlist.map((who) => ({ to: token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [who]) })),
          block
        );
        shortlist.forEach((who, i) => {
          try {
            const [balance] = decodeOutputs(ERC20_FUNCTIONS.balanceOf, balances[i]);
            if (balance > 0n) out2.push({ address: who, source: "holder" });
          } catch {
          }
        });
      } catch {
        for (const who of shortlist) out2.push({ address: who, source: "holder" });
      }
    }
    if (!out2.length && deployer) {
      const balance = await readBalance(rpc, token, deployer, block).catch(() => 0n);
      if (balance > 0n) out2.push({ address: deployer, source: "deployer" });
    }
    return out2.slice(0, want);
  }
  async function recentRecipients(rpc, token, block, excluded, want, recentBlocks = 1800) {
    let logs;
    try {
      logs = await rpc.getLogs({ address: token, topics: [eventTopic(ERC20_EVENTS.Transfer)], fromBlock: Math.max(0, block - recentBlocks), toBlock: block });
    } catch {
      return [];
    }
    const seen = [];
    for (let i = logs.length - 1; i >= 0 && seen.length < want * 3; i--) {
      const topic = logs[i].topics[2];
      if (!topic) continue;
      const who = `0x${topic.slice(-40)}`.toLowerCase();
      if (BURN_ADDRESSES2.has(who) || excluded.has(who) || seen.includes(who)) continue;
      seen.push(who);
    }
    if (!seen.length) return [];
    const codes = await rpc.callBatchSettled(
      seen.map((who) => ({ to: token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [who]) })),
      block
    );
    const withBalance = [];
    codes.forEach((raw, i) => {
      if (raw instanceof Error) return;
      try {
        if (decodeOutputs(ERC20_FUNCTIONS.balanceOf, raw)[0] > 0n) withBalance.push(seen[i]);
      } catch {
      }
    });
    const out2 = [];
    for (const who of withBalance) {
      if (out2.length >= want) break;
      try {
        if ((await rpc.getCode(who, block)).length <= 2) out2.push(who);
      } catch {
      }
    }
    return out2;
  }
  function readOwnerFrom(ownerAnswer, getOwnerAnswer) {
    for (const [fn, answer] of [
      [OWNER_FUNCTIONS.owner, ownerAnswer],
      [OWNER_FUNCTIONS.getOwner, getOwnerAnswer]
    ]) {
      if (answer instanceof RpcError) {
        if (answer.isRevert) continue;
        return { owner: null, unread: true };
      }
      if (answer === null) continue;
      let address;
      try {
        [address] = decodeOutputs(fn, answer);
      } catch {
        return { owner: null, unread: true };
      }
      const renounced = address === ZERO_ADDRESS || BURN_ADDRESSES2.has(address);
      return { owner: { address, renounced, isContract: false }, unread: false };
    }
    return { owner: null, unread: false };
  }
  function readBoolFrom(fn, answer) {
    if (answer === null || answer instanceof RpcError) return null;
    try {
      const [value] = decodeOutputs(fn, answer);
      return value;
    } catch {
      return null;
    }
  }
  async function readBalance(rpc, token, who, block) {
    const [raw] = await rpc.callBatch([{ to: token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [who]) }], block);
    const [balance] = decodeOutputs(ERC20_FUNCTIONS.balanceOf, raw);
    return balance;
  }
  async function probeTransfers(rpc, token, requests, block) {
    if (!requests.length) return [];
    const calls = requests.map((r) => ({
      method: "eth_call",
      params: [{ from: r.from, to: token, data: encodeCall(OWNER_FUNCTIONS.transfer, [r.to, 1n]) }, toTag(block)]
    }));
    let answers;
    try {
      answers = await rpc.sendBatchSettled(calls);
    } catch {
      answers = [];
      for (const call of calls) {
        try {
          answers.push(await rpc.send(call.method, call.params));
        } catch (error) {
          answers.push(error instanceof RpcError ? error : new RpcError(error instanceof Error ? error.message : String(error)));
        }
      }
    }
    return requests.map((r, i) => readProbe(r, answers[i]));
  }
  function readProbe({ from, to, target, source }, answer) {
    if (answer instanceof RpcError) {
      if (answer.isRevert) return { from, to, target, status: "reverts", reason: revertReason(answer), source };
      return { from, to, target, status: "unread", reason: answer.message, source };
    }
    const raw = answer;
    if (raw === "0x") return { from, to, target, status: "ok", reason: null, source };
    if (typeof raw !== "string" || raw.length < 66) return { from, to, target, status: "unread", reason: "the call returned data too short to read", source };
    return BigInt(raw.slice(0, 66)) !== 0n ? { from, to, target, status: "ok", reason: null, source } : { from, to, target, status: "reverts", reason: "transfer returned false", source };
  }
  function toTag(block) {
    return `0x${block.toString(16)}`;
  }
  function revertReason(error) {
    const data = typeof error.data === "string" ? error.data : "";
    if (data.startsWith("0x08c379a0") && data.length >= 10 + 128) {
      try {
        const [text] = decodeOutputs({ name: "Error", inputs: [], outputs: ["string"] }, `0x${data.slice(10)}`);
        if (text) return text;
      } catch {
      }
    }
    if (data.startsWith("0x4e487b71") && data.length >= 10 + 64) {
      return `panic 0x${BigInt(`0x${data.slice(10, 74)}`).toString(16)}`;
    }
    if (data.length > 10) return `custom error ${data.slice(0, 10)}`;
    const message = error.message.replace(/^execution reverted:?\s*/i, "").trim();
    return message || null;
  }
  function summariseActivity(transfers) {
    if (!transfers.length) return { lastTransferAt: null, lastTransferBlock: null, recent: 0, recentWallets: 0 };
    const newest = transfers.reduce((a, b) => b.block > a.block ? b : a, transfers[0]);
    const wallets = /* @__PURE__ */ new Set();
    for (const t of transfers) {
      wallets.add(t.from);
      wallets.add(t.to);
    }
    return { lastTransferAt: newest.timestamp, lastTransferBlock: newest.block || null, recent: transfers.length, recentWallets: wallets.size };
  }
  function powerKinds(o) {
    const order = ["upgrade", "mint", "pause", "blacklist", "trading", "fees", "limits", "burn-others", "exempt", "sweep"];
    const have = new Set(o.powers.map((p) => p.kind));
    return order.filter((k) => have.has(k));
  }
  function sellProbes(o) {
    return o.probes.filter((p) => p.target === "pool");
  }
  function moveProbes(o) {
    return o.probes.filter((p) => p.target === "fresh-wallet");
  }

  // src/bouncer/room.ts
  init_tape();
  async function readRoom(rpc, launch, fromBlock, toBlock, chunkSize, firstMinuteBlocks = 600) {
    const tape = await readTapeAdaptive(
      rpc,
      { fromBlock, toBlock, address: launch.curve, events: [CURVE_EVENTS.CurveBuy, CURVE_EVENTS.CurveSell] },
      chunkSize ? { startChunk: chunkSize, maxChunk: chunkSize, minChunk: Math.min(1e3, chunkSize) } : { startChunk: 2e4 }
    );
    const creator = /* @__PURE__ */ new Set([launch.deployer.toLowerCase(), launch.creatorFeeRecipient.toLowerCase()]);
    const wallets = /* @__PURE__ */ new Map();
    const perBlock = /* @__PURE__ */ new Map();
    let buys = 0;
    let sells = 0;
    let totalQuoteIn = 0n;
    let devQuoteIn = 0n;
    let firstMinuteQuoteIn = 0n;
    const first = [];
    for (const log of tape.logs) {
      const isBuy = log.name === "CurveBuy";
      const who = String(isBuy ? log.args.buyer : log.args.seller).toLowerCase();
      let w = wallets.get(who);
      if (!w) {
        w = { address: who, firstBlock: log.blockNumber, buys: 0, sells: 0, quoteIn: 0n, quoteOut: 0n, creatorWallet: creator.has(who) };
        wallets.set(who, w);
      }
      if (isBuy) {
        const spent = log.args.quoteIn - log.args.fee - log.args.tax;
        buys++;
        w.buys++;
        w.quoteIn += spent;
        totalQuoteIn += spent;
        if (w.creatorWallet) devQuoteIn += spent;
        if (log.blockNumber - fromBlock <= firstMinuteBlocks) firstMinuteQuoteIn += spent;
        if (w.buys === 1 && first.length < 25) first.push(who);
        let set = perBlock.get(log.blockNumber);
        if (!set) perBlock.set(log.blockNumber, set = /* @__PURE__ */ new Set());
        set.add(who);
      } else {
        sells++;
        w.sells++;
        w.quoteOut += log.args.quoteOut;
      }
    }
    const list = [...wallets.values()].sort((a, b) => b.quoteIn - b.quoteOut > a.quoteIn - a.quoteOut ? 1 : -1);
    return {
      fromBlock,
      toBlock,
      buys,
      sells,
      buyers: list.filter((w) => w.buys > 0).length,
      totalQuoteIn,
      devShareBps: totalQuoteIn === 0n ? 0 : Number(devQuoteIn * 10000n / totalQuoteIn),
      firstMinuteShareBps: totalQuoteIn === 0n ? 0 : Number(firstMinuteQuoteIn * 10000n / totalQuoteIn),
      sharedBlocks: [...perBlock.entries()].filter(([, s]) => s.size > 1).map(([block, s]) => ({ block, wallets: s.size })),
      wallets: list,
      first
    };
  }
  function roomLine(r) {
    if (r.buys === 0) return "empty: no buys yet";
    const parts = [`${r.buyers} buyer${r.buyers === 1 ? "" : "s"}`, `dev funded ${(r.devShareBps / 100).toFixed(0)}%`, `${(r.firstMinuteShareBps / 100).toFixed(0)}% in the first minute`];
    if (r.sharedBlocks.length) parts.push(`${r.sharedBlocks.length} block${r.sharedBlocks.length === 1 ? "" : "s"} with several wallets buying at once`);
    return parts.join(" \xB7 ");
  }

  // src/bouncer/door.ts
  async function readDoor(rpc, input, options = {}) {
    const chain2 = options.chain ?? DEFAULT_CHAIN;
    const factory = (options.factory ?? chain2.factory ?? "").toLowerCase();
    const launchpadKnown = Boolean(factory);
    const head = options.at ?? await rpc.head();
    const searchBlocks = options.launchSearchBlocks ?? Math.round(7 * 86400 * chain2.blocksPerSecond);
    const v4ManagerP = resolveV4Manager(rpc, chain2, options.factory, head.number).catch(() => void 0);
    const lockersP = resolveLockers(rpc, chain2, factory, void 0, head.number).catch(() => chain2.lockers);
    const id = await readIdCheck(rpc, input, head.number, factory || void 0, {
      factoryV1: chain2.factoryV1,
      olderFactoriesV1: chain2.olderFactoriesV1,
      native: chain2.native,
      skipLaunchLookup: !launchpadKnown
    });
    const slip = {
      chain: { key: chain2.key, name: chain2.name, chainId: chain2.chainId, launchpad: chain2.launchpad, native: chain2.native },
      at: { block: head.number, timestamp: head.timestamp },
      subject: id.launch ? id.launch.token.toLowerCase() : id.input,
      stamp: id.registered ? "ON THE LIST" : "NOT ON THE LIST",
      id,
      launchBlock: null,
      cover: null,
      rules: null,
      room: null,
      exit: null,
      crew: null,
      lookalikes: null,
      dev: null,
      open: null,
      notes: [],
      skipped: [],
      known: chain2.known?.[id.input.toLowerCase()] ?? null
    };
    const attempt = async (section2, run) => {
      try {
        await run();
      } catch (error) {
        slip.skipped.push({ section: section2, reason: error instanceof Error ? error.message : String(error) });
      }
    };
    const begin = (section2, run) => {
      const started = run().then(
        () => null,
        (error) => error instanceof Error ? error.message : String(error)
      );
      return async () => {
        const reason = await started;
        if (reason !== null) slip.skipped.push({ section: section2, reason });
      };
    };
    if (!launchpadKnown) {
      slip.skipped.push({
        section: "launch record",
        reason: chain2.launchpad ? `the ${chain2.launchpad} factory address is not published for ${chain2.name} yet; pass --factory 0x\u2026 to check launches here` : `no launchpad BOUNCER knows runs on ${chain2.name}, so there is no launch record to look for; every address here is checked as an ordinary token`
      });
    }
    if (!id.launch && !id.token.code.empty) {
      if (!id.registered) slip.stamp = "NOT A LAUNCH";
      const lookalikesDone2 = !id.registered && launchpadKnown && options.blockscout && !options.skipLookalikes && id.meta?.symbol ? begin("lookalikes", async () => {
        slip.lookalikes = await readLookalikes(rpc, options.blockscout, id.input, id.meta.symbol, head.number, factory, searchBlocks, 8, false);
      }) : null;
      await attempt("open door", async () => {
        const [lockers, v4PoolManager] = await Promise.all([
          id.v1?.factory && id.v1.factory !== chain2.factoryV1 ? resolveLockers(rpc, chain2, factory, id.v1.factory, head.number).catch(() => chain2.lockers) : lockersP,
          v4ManagerP
        ]);
        slip.open = await readOpenDoor(rpc, id.token, id.meta, head.number, {
          blockscout: options.blockscout ?? null,
          dex: chain2.dex,
          skipMarket: options.skipMarket,
          skipExplorer: options.skipExplorer,
          skipProbes: options.skipProbes,
          skipOwnerWallet: options.skipOwnerWallet,
          lockers,
          liquidity: options.skipLiquidity !== true,
          // A day, not a week. This is read before a trade, and the measured
          // cost of a week on Base was the better part of a minute for a section
          // that then reported nothing. What matters for "can they pull it now"
          // is who holds the liquidity now; --liquidity-blocks widens it for
          // anyone who wants the longer history and will wait for it.
          liquidityFromBlock: head.number - (options.liquidityBlocks ?? Math.min(2e5, Math.round(86400 * chain2.blocksPerSecond))),
          liquidityBudgetMs: options.liquidityBudgetMs,
          liquidityDeadlineMs: options.liquidityDeadlineMs,
          v4PoolManager
        });
      });
      if (lookalikesDone2) await lookalikesDone2();
      if (!id.registered && impostorOf(slip)) slip.stamp = "NOT ON THE LIST";
    }
    if (!id.launch) {
      slip.notes = doorNotes(slip);
      return slip;
    }
    const launch = id.launch;
    const lookalikesDone = options.blockscout && !options.skipLookalikes && slip.id.meta ? begin("lookalikes", async () => {
      slip.lookalikes = await readLookalikes(rpc, options.blockscout, launch.token, slip.id.meta.symbol, head.number, factory, searchBlocks);
    }) : null;
    const devDone = !options.skipDev ? begin("dev report card", async () => {
      const hours = options.devHours ?? 24;
      const fromBlock = await findBlockByTimestamp(rpc, head.timestamp - hours * 3600, head.number);
      slip.dev = await readDevReport(rpc, launch.deployer, { fromBlock, toBlock: head.number, factory, chunking: options.chunkSize ? { startChunk: options.chunkSize, maxChunk: options.chunkSize } : void 0 });
    }) : null;
    slip.launchBlock = await findLaunchBlock(rpc, launch.token, head.number, searchBlocks, factory, options.chunkSize);
    if (slip.launchBlock !== null) {
      await attempt("cover charge", async () => {
        slip.cover = await readCoverCharge(rpc, launch, { launchBlock: slip.launchBlock, head, chunkSize: options.chunkSize, factory });
      });
    }
    const rulesFrom = slip.launchBlock ?? Math.max(0, head.number - searchBlocks);
    await attempt("house rules", async () => {
      slip.rules = await readHouseRules(rpc, launch, { launchBlock: rulesFrom, head: head.number, chunkSize: options.chunkSize, factory, native: chain2.native });
    });
    if (!options.skipRoom && slip.launchBlock !== null) {
      await attempt("the room", async () => {
        slip.room = await readRoom(rpc, launch, slip.launchBlock, head.number, options.chunkSize, Math.round(60 * chain2.blocksPerSecond));
      });
    }
    await attempt("exit door", async () => {
      const supply = slip.rules?.snapshot.token.totalSupply ?? slip.id.meta?.totalSupply ?? 0n;
      slip.exit = await readExitDoor(rpc, launch, { position: options.position ?? supply / 100n, block: head.number, factory });
    });
    if (options.blockscout && !options.skipCrew && slip.room && slip.launchBlock !== null) {
      await attempt("one crew", async () => {
        slip.crew = await readOneCrew(options.blockscout, slip.room, slip.launchBlock, [launch.deployer, launch.creatorFeeRecipient]);
      });
    }
    if (lookalikesDone) await lookalikesDone();
    if (devDone) await devDone();
    slip.notes = doorNotes(slip);
    return slip;
  }
  async function findLaunchBlock(rpc, token, head, maxBlocks, factory, chunkSize) {
    let to = head;
    let chunk = chunkSize ?? 2e4;
    const floor = Math.max(0, head - maxBlocks);
    while (to >= floor) {
      const from = Math.max(floor, to - chunk + 1);
      const tape = await readTapeAdaptive(
        rpc,
        { fromBlock: from, toBlock: to, address: factory, events: [FACTORY_EVENTS.TokenLaunched], topics: [addressTopic(token)] },
        { startChunk: chunk, maxChunk: chunk, minChunk: Math.min(1e3, chunk) }
      );
      if (tape.logs.length) return tape.logs[0].blockNumber;
      if (from === floor) break;
      to = from - 1;
      chunk = Math.min(chunk * 2, chunkSize ?? 4e5);
    }
    return null;
  }
  function doorNotes(slip) {
    const notes = [];
    const t = slip.id.token;
    const findings = idFindings(slip.id);
    const q2 = slip.chain.native;
    if (slip.id.v1) {
      const v = slip.id.v1;
      notes.push({ level: "info", code: "v1-launch", text: `This is a Pons V1 token: fixed supply, traded in a Uniswap V3 pool from the first block. There is no bonding curve, no creator tax and no door tax, so those sections are not shown.` });
      if (v.restrictionBlocksLeft > 0 && v.config) notes.push({ level: "watch", code: "v1-caps", text: `Launch caps are still on for ${v.restrictionBlocksLeft} blocks: max ${formatBps(v.config.maxWalletBps)} of supply per wallet, ${formatBps(v.config.maxTxBps)} per trade. A buy above the cap reverts.` });
      if (!v.status.graduated) notes.push({ level: "info", code: "v1-not-graduated", text: `Not graduated: ${formatUnits(v.status.pairedPrincipal, v.quote.decimals)} of ${formatUnits(v.status.threshold, v.quote.decimals)} ${v.quote.symbol} in the pool.` });
      for (const f of findings) notes.push({ level: "watch", code: "code", text: `Unexpected for a launchpad token: ${f}.` });
      if (slip.open) notes.push(...openDoorFactNotes(slip, slip.open));
      return notes;
    }
    if (!slip.id.registered) return openDoorNotes(slip, findings);
    if (slip.id.resolvedAs === "curve") notes.push({ level: "info", code: "curve-input", text: `You pasted the curve; the slip is for its token ${slip.subject}.` });
    for (const f of findings) notes.push({ level: "watch", code: "code", text: `Unexpected for a launchpad token: ${f}.` });
    const c = slip.cover;
    if (c) {
      if (c.status === "open") {
        notes.push({ level: "watch", code: "cover-open", text: `The door tax is still on for ${c.secondsLeft} s: buying now hands up to ${formatBps(c.terms.startBps)} of your money to the creator on top of the fees. Wait for it to end.` });
      } else if (c.status === "closed") {
        const taxed = c.observed.filter((b) => !b.creatorWallet && b.chargeBps > 0);
        const highest = taxed.length ? Math.max(...taxed.map((b) => b.chargeBps)) : 0;
        notes.push({
          level: "info",
          code: "cover-closed",
          text: `The door tax ended ${formatDuration(Math.max(0, c.head.timestamp - c.windowEndsAt))} ago. ${c.observed.length} buy${c.observed.length === 1 ? "" : "s"} landed in the first ${c.terms.seconds} s${taxed.length ? `; the highest paid ${(highest / 100).toFixed(1)}% at the door` : ""}.`
        });
      }
      if (c.termsChangedSinceLaunch) notes.push({ level: "watch", code: "terms-retuned", text: "The factory changed its door-tax settings after this launch; this token keeps the settings it launched under, which are not the ones shown." });
    } else if (slip.launchBlock === null) {
      notes.push({ level: "info", code: "launch-older", text: "This launch is older than the search window, so the door tax ended long ago and was not read." });
    }
    const r = slip.rules;
    if (r) {
      if (r.totalTradeBps >= 1000n) notes.push({ level: "watch", code: "high-tax", text: `Every trade pays ${formatBps(r.totalTradeBps)} in fees, ${formatBps(r.creatorTaxBps)} of it to the creator.` });
      if (r.creatorFeeRecipientChanges.length) notes.push({ level: "watch", code: "fee-recipient-moved", text: `The creator changed where their cut is paid ${r.creatorFeeRecipientChanges.length}\xD7 since launch, last to ${shortAddress(r.creatorFeeRecipientChanges[r.creatorFeeRecipientChanges.length - 1].to)}.` });
      if (r.deployerShareBps >= 2e3) notes.push({ level: "watch", code: "dev-holds", text: `The deployer holds ${(r.deployerShareBps / 100).toFixed(1)}% of supply.` });
      if (r.buybackEnabled) notes.push({ level: "info", code: "buyback-vests", text: "Buyback is on. It does not burn anything: bought-back tokens are locked and released to the creator and the protocol over five years." });
      if (r.phase === 1 /* Swept */) notes.push({ level: "info", code: "swept-no-pool", text: "The curve is closed and the Uniswap pool has not been created yet, so nothing trades right now." });
      if (r.phase === 2 /* PoolCreated */ || r.phase === 3 /* Rescued */) notes.push({ level: "info", code: "graduated", text: "Graduated: it trades in a Uniswap pool whose liquidity is locked by the launchpad. The creator cannot pull it." });
    }
    const room = slip.room;
    if (room && room.buys > 0) {
      if (room.devShareBps >= 5e3) notes.push({ level: "watch", code: "dev-funded", text: `The creator's own wallets paid for ${(room.devShareBps / 100).toFixed(0)}% of everything bought so far.` });
      if (room.sharedBlocks.length >= 3) notes.push({ level: "watch", code: "bundled-blocks", text: `${room.sharedBlocks.length} times, several different wallets bought in the very same block: the shape of a bundled launch.` });
      if (room.buyers >= 25 && room.devShareBps < 2e3) notes.push({ level: "info", code: "room-wide", text: `${room.buyers} distinct buyers and the creator funded ${(room.devShareBps / 100).toFixed(0)}%.` });
    }
    const crew = slip.crew;
    if (crew) {
      if (crew.largestCrewShareBps >= 2500) notes.push({ level: "watch", code: "one-crew", text: `${crew.crews[0].wallets.length} of the first buyers got their money from the same address (${shortAddress(crew.crews[0].funder)}) and together bought ${(crew.largestCrewShareBps / 100).toFixed(0)}% of everything.` });
      if (crew.fundedByCreator.length) notes.push({ level: "watch", code: "crew-creator", text: `${crew.fundedByCreator.length} of the first buyers got their ${q2.symbol} from the creator's wallets right before buying.` });
      if (!crew.crews.length && crew.checked >= 5 && !crew.fundedByCreator.length) notes.push({ level: "info", code: "crew-clean", text: `${crew.checked} first buyers checked, no shared funder.` });
    }
    const l = slip.lookalikes;
    if (l) {
      const others = l.candidates.filter((x) => x.address !== l.subject);
      if (l.subjectIsEarliest === false) notes.push({ level: "watch", code: "lookalike-later", text: `Another token called ${l.query} launched before this one (${shortAddress(l.earliest.address)}, block ${l.earliest.launchBlock}). A name is not an identity; check which address the team posted.` });
      else if (others.length) notes.push({ level: "info", code: "lookalikes", text: `${others.length} other token${others.length === 1 ? "" : "s"} called ${l.query} exist on this chain${l.subjectIsEarliest ? "; this one launched first" : ""}.` });
    }
    const e = slip.exit;
    if (e) {
      const whole = e.quotes.find((x) => x.shareBps === 1e4);
      if (e.venue === "closed") notes.push({ level: "info", code: "exit-closed", text: e.note });
      else if (whole && whole.realisedBps > 0 && whole.realisedBps < 5e3) notes.push({ level: "info", code: "exit-thin", text: `Selling 1% of supply now would get only ${(whole.realisedBps / 100).toFixed(0)}% of the quoted price: liquidity is thin.` });
    }
    const d = slip.dev;
    if (d) {
      if (d.counts.launched === 0) notes.push({ level: "info", code: "dev-first", text: "First launch from this dev in the window." });
      if (d.counts.launched >= 5 && d.counts.graduated === 0) notes.push({ level: "watch", code: "dev-serial", text: `This dev launched ${d.counts.launched} tokens in the window and none of them graduated.` });
      if (d.repeatedSymbols.length) notes.push({ level: "watch", code: "dev-repeat", text: `This dev launched the same ticker more than once: ${d.repeatedSymbols.join(", ")}.` });
      if (d.counts.graduated > 0) notes.push({ level: "info", code: "dev-graduated", text: `This dev has ${d.counts.graduated} graduation${d.counts.graduated === 1 ? "" : "s"} in the window${d.medianSecondsToSweep !== null ? `, typically ${formatDuration(d.medianSecondsToSweep)} from launch to a full curve` : ""}.` });
    }
    return withSkipped(slip, notes);
  }
  function impostorOf(slip) {
    if (slip.known || !slip.lookalikes) return null;
    const subjectBlock = slip.open?.deployer?.createdAtBlock ?? null;
    if (subjectBlock === null) return null;
    for (const candidate of registeredLookalikes(slip.lookalikes)) {
      if (candidate.launchBlock !== null && candidate.launchBlock < subjectBlock) return candidate;
    }
    return null;
  }
  function openDoorNotes(slip, findings) {
    const notes = [];
    const t = slip.id.token;
    const factories = slip.chain.launchpad ? `the ${slip.chain.launchpad} factory${slip.chain.key === "robinhood" ? " nor the Pons V1 factory" : ""}` : "";
    if (t.code.empty) {
      notes.push({ level: "stop", code: "not-registered", text: `No contract at this address on ${slip.chain.name}.` });
      return withSkipped(slip, notes);
    }
    if (t.code.delegatedTo) {
      notes.push({ level: "info", code: "delegated-wallet", text: `This is a wallet, not a token: its code is an EIP-7702 delegation to ${shortAddress(t.code.delegatedTo)}, which its owner signed. There is nothing at this address to check for launch terms.` });
      return withSkipped(slip, notes);
    }
    const named = slip.id.meta ? `"${slip.id.meta.name}" (${slip.id.meta.symbol})` : "this contract";
    const impostor = impostorOf(slip);
    if (impostor) {
      notes.push({
        level: "stop",
        code: "lookalike-impostor",
        text: `A real ${slip.chain.launchpad} launch is called ${slip.lookalikes.query} (${shortAddress(impostor.address)}, block ${impostor.launchBlock}) and it is older than this contract. This address is not it. If someone is selling this as that launch, it is not one.`
      });
    } else if (slip.lookalikes && registeredLookalikes(slip.lookalikes).length) {
      notes.push({
        level: "watch",
        code: "lookalike-shared-ticker",
        text: `${registeredLookalikes(slip.lookalikes).length} launchpad token${registeredLookalikes(slip.lookalikes).length === 1 ? " carries" : "s carry"} the ticker ${slip.lookalikes.query} as well. Which came first could not be established, so neither is called a copy here; check the address the team posted.`
      });
    }
    const ident = slip.open;
    if (ident && !slip.id.meta && !slip.id.registered && !slip.known) {
      if (ident.surfaceFrom === "implementation-unreadable") {
        notes.push({
          level: "watch",
          code: "surface-unreadable",
          text: "This is a proxy and the code it actually runs could not be read, so its name, symbol and supply are unknown and nothing below describes what a call to it would really do."
        });
      } else if (!ident.transferFunction) {
        notes.push({
          level: "stop",
          code: "not-a-token",
          text: "Nothing here identifies a token. Its name, symbol, decimals and total supply did not read, and its code has no transfer(address,uint256) function, so no balance of it can be held or sold. Whatever ticker this address was posted under, it is not that token \u2014 and it is not something you can buy."
        });
      } else {
        notes.push({
          level: "watch",
          code: "meta-unread",
          text: "Its name, symbol, decimals and total supply did not read, so there is no ticker here to check against the one you were given, and every share of supply below is unknown rather than zero."
        });
      }
    }
    if (slip.id.claimedFactory) notes.push({ level: "watch", code: "claimed-factory", text: `The token names ${shortAddress(slip.id.claimedFactory)} as its launch factory (launchFactory()), but that factory is not one BOUNCER knows or its record does not confirm this token. A contract can claim any factory; only a known factory's record counts.` });
    if (slip.known) notes.push({ level: "info", code: "known-address", text: `This is ${slip.known}` });
    else if (slip.open) {
      notes.push({
        level: "info",
        code: "not-registered",
        text: factories ? `Not a launchpad token: neither ${factories} deployed ${named}, so curves, door tax and locked pools do not apply. Checked instead as an ordinary token on ${slip.chain.name}: who can change its rules, whether a holder can sell right now, who holds it.` : `No launchpad BOUNCER knows runs on ${slip.chain.name}, so ${named} is checked as what it is: an ordinary token. Who can change its rules, whether a holder can sell right now, who holds it, where it trades.`
      });
    } else {
      notes.push({
        level: "watch",
        code: "not-registered",
        text: factories ? `Not a launchpad token: neither ${factories} deployed ${named}. The ordinary-token check could not be run, so nothing below was read.` : `${named} could not be checked: the ordinary-token read failed, so nothing below was read.`
      });
    }
    const o = slip.open;
    for (const f of findings) {
      if (f.startsWith("SELFDESTRUCT") || f.startsWith("CALLCODE")) notes.push({ level: "stop", code: "code", text: `Code can vanish: ${f}.` });
      else if (f.startsWith("upgradeable proxy") || f.startsWith("beacon proxy") || f.startsWith("minimal proxy")) notes.push({ level: "watch", code: "code", text: `Code can be replaced: ${f}. Whoever controls the proxy decides what this token does tomorrow${o?.surfaceFrom === "implementation" ? "; the functions below were read from the current implementation" : ""}.` });
      else if (f.startsWith("DELEGATECALL")) notes.push({ level: "watch", code: "code", text: `Runs other contracts' code in its own storage: ${f}.` });
      else notes.push({ level: "info", code: "code", text: `${f.charAt(0).toUpperCase()}${f.slice(1)}.` });
    }
    if (!o) return withSkipped(slip, notes);
    notes.push(...openDoorFactNotes(slip, o));
    return withSkipped(slip, notes);
  }
  function withSkipped(slip, notes) {
    for (const s of slip.skipped) notes.push({ level: "info", code: "skipped", text: `${s.section} could not be read: ${s.reason}` });
    return notes;
  }
  function pct2(bps3) {
    return bps3 === null ? "an unknown share" : `${(bps3 / 100).toFixed(1)}%`;
  }
  async function resolveV4Manager(rpc, chain2, factory, block) {
    const configured = chain2.dex?.v4PoolManager;
    if (!configured) return void 0;
    if (configured !== "from-launchpad") return configured;
    if (!factory) return void 0;
    try {
      const [raw] = await rpc.callBatch([{ to: factory, data: encodeCall(FACTORY_FUNCTIONS.poolManager, []) }], block);
      const address = decodeOutputs(FACTORY_FUNCTIONS.poolManager, raw)[0].toLowerCase();
      return address && address !== ZERO_ADDRESS ? address : void 0;
    } catch {
      return void 0;
    }
  }
  async function resolveLockers(rpc, chain2, factory, v1Factory, block) {
    const family = chain2.launchpad ? chain2.launchpad.replace(/ V\d+$/, "") : "launchpad";
    const factories = [
      { address: factory, name: `the ${chain2.launchpad ?? "launchpad"} locker` },
      // The V1 factory that registered THIS token where the identify step found
      // one, because a chain can have had more than one, and a locker read off
      // the wrong factory is exactly the kind of near-miss this file exists to
      // avoid. The configured address is the fallback.
      { address: v1Factory ?? chain2.factoryV1, name: `the ${family} V1 locker` }
    ].filter((f) => Boolean(f.address));
    if (!factories.length) return chain2.lockers;
    const table = { ...chain2.lockers ?? {} };
    try {
      const raws = await rpc.callBatchSettled(factories.map((f) => ({ to: f.address, data: encodeCall(V1_FACTORY_FUNCTIONS.locker, []) })), block);
      raws.forEach((raw, i) => {
        if (raw instanceof Error) return;
        try {
          const address = decodeOutputs(V1_FACTORY_FUNCTIONS.locker, raw)[0].toLowerCase();
          if (address && address !== ZERO_ADDRESS) table[address] = factories[i].name;
        } catch {
        }
      });
    } catch {
      return chain2.lockers;
    }
    return Object.keys(table).length ? table : chain2.lockers;
  }
  function openDoorFactNotes(slip, o) {
    const notes = [];
    if (o.surfaceFrom === "implementation-unreadable") {
      notes.push({ level: "watch", code: "surface-unreadable", text: "This address is a proxy and the code it points at could not be read, so nothing below about its functions is a finding: the switches it carries are unknown, not absent." });
    }
    if (o.explorer?.tokenType && o.explorer.tokenType !== "ERC-20") {
      notes.push({ level: "info", code: "not-erc20", text: `The explorer indexes this as ${o.explorer.tokenType}, not ERC-20. The questions below are asked of fungible tokens; read them with that in mind.` });
    }
    if (o.explorerNotIndexed) {
      notes.push({
        level: "watch",
        code: "too-new",
        text: "The explorer has not indexed this address yet, which usually means it was deployed very recently. Everything above came off the chain and is current; who holds it, who deployed it and its recent trades are not available until the explorer catches up. A token nobody has had time to look at is worth more caution, not less."
      });
    } else if (o.explorerError) {
      notes.push({ level: "info", code: "explorer-unread", text: `The explorer could not be read, so holders, the deployer and recent trades are missing: ${o.explorerError}` });
    }
    if (o.explorer && o.explorer.ageSeconds >= 3) {
      notes.push({
        level: "info",
        code: "explorer-age",
        text: `The explorer's figures \u2014 holders, the deployer, recent trades, the price \u2014 are ${o.explorer.ageSeconds} seconds old: the proxy served them from its cache. The chain readings beside them are from this block.`
      });
    }
    const kinds = powerKinds(o).filter((k) => k !== "exempt" && k !== "sweep");
    const owner = o.owner;
    const movesWork = o.probes.length > 0 && o.probes.every((p) => p.status === "ok");
    const contradicted = movesWork ? "yes" : o.probesPending ? "unknown" : "no";
    if (o.paused === true) {
      notes.push(
        contradicted === "yes" ? { level: "watch", code: "paused", text: "paused() returns true, yet every simulated transfer went through. Either the pause does not gate transfers in this contract or it exempts the wallets that were tried; read the source before trusting either reading." } : contradicted === "unknown" ? { level: "watch", code: "paused", text: "paused() returns true. Whether that actually stops a transfer is still being simulated; in most contracts it does." } : { level: "stop", code: "paused", text: "Transfers are paused right now: paused() returns true, so nobody can move this token until whoever holds that switch unpauses it." }
      );
    }
    if (o.tradingOpen && !o.tradingOpen.open) {
      notes.push(
        contradicted === "yes" ? { level: "watch", code: "trading-closed", text: `${o.tradingOpen.view} returns false, yet every simulated transfer went through: the switch exists but is not stopping the wallets that were tried.` } : contradicted === "unknown" ? { level: "watch", code: "trading-closed", text: `${o.tradingOpen.view} returns false. Whether that actually stops a trade is still being simulated; in most contracts it does.` } : { level: "stop", code: "trading-closed", text: `Trading is switched off: ${o.tradingOpen.view} returns false, so only wallets that are exempted can trade until it is switched on.` }
      );
    }
    if (kinds.length) {
      const what = kinds.map((k) => `${k} (${POWER_MEANING[k]})`).join("; ");
      const who = o.ownerUnread ? "owner() is in the code but the chain would not answer it, so who holds those keys is unknown" : owner === null ? "there is no owner() view, so who may call them cannot be read off the chain" : owner.renounced ? "ownership is renounced, so any function guarded by the owner has nobody left to call it; a separate admin role, if the code has one, is not covered by this check" : `ownership is not renounced: ${shortAddress(owner.address)}${owner.isContract ? ", a contract," : ""} holds it`;
      notes.push({ level: owner?.renounced ? "info" : "watch", code: "powers", text: `The code carries ${what}. Which of them is guarded, and by whom, is not readable from bytecode; what is readable is that ${who}.` });
    } else if (o.surfaceFrom !== "implementation-unreadable") {
      const tail = owner === null ? "and no owner() view either" : owner.renounced ? "and ownership is renounced" : `though ${shortAddress(owner.address)} is still its owner`;
      notes.push({ level: "info", code: "no-powers", text: `No mint, pause, blacklist, fee, limit, trading or upgrade function was seen among the ${o.selectors} functions in the code, ${tail}.` });
    }
    if (o.verified === false) notes.push({ level: "watch", code: "unverified", text: "Source code is not verified on the explorer: nobody can read what the contract does beyond what its bytes show here." });
    if (o.explorer?.isScam === true) notes.push({ level: "stop", code: "explorer-scam", text: "The explorer flags this address as a scam." });
    if (o.probesSkipped) notes.push({ level: "info", code: "no-probe", text: `No transfer was simulated: ${o.probesSkipped}.` });
    notes.push(...probeNotes(o, moveProbes(o), "move"));
    notes.push(...probeNotes(o, sellProbes(o), "sell"));
    const h = o.holders;
    if (h) {
      const over = h.rows >= 50 ? " (counted over the first 50 holders the explorer lists)" : "";
      if (h.top10WalletsBps !== null && h.top10WalletsBps >= 5e3) notes.push({ level: "watch", code: "concentrated", text: `The 10 largest wallets hold ${pct2(h.top10WalletsBps)} of supply${over}. Contracts and burn addresses are not counted; wallets that delegated under EIP-7702 are.` });
      else if (h.count !== null && h.count >= 100 && h.top10WalletsBps !== null) notes.push({ level: "info", code: "spread", text: `${h.count} holders; the 10 largest wallets hold ${pct2(h.top10WalletsBps)} of supply${over}.` });
      else if (h.count !== null && h.top10WalletsBps === null) notes.push({ level: "info", code: "shares-unknown", text: `${h.count} holders. What share each holds could not be worked out: totalSupply() did not read.` });
      if (h.contractsBps !== null && h.contractsBps >= 1e3) notes.push({ level: "info", code: "in-contracts", text: `${pct2(h.contractsBps)} of supply sits in contracts (pools, lockers, vaults, the token itself).` });
      if (h.burnedBps !== null && h.burnedBps >= 100) notes.push({ level: "info", code: "burned", text: `${pct2(h.burnedBps)} of supply sits at a burn address.` });
    }
    if (o.deployer && o.deployer.bps !== null && o.deployer.bps >= 2e3) notes.push({ level: "watch", code: "deployer-holds", text: `The deployer (${shortAddress(o.deployer.address)}) holds ${pct2(o.deployer.bps)} of supply.` });
    if (o.ownerBalance && o.ownerBalance.bps !== null && o.ownerBalance.bps >= 2e3 && o.owner && o.owner.address !== o.deployer?.address) notes.push({ level: "watch", code: "owner-holds", text: `The owner holds ${pct2(o.ownerBalance.bps)} of supply.` });
    if (o.pools) {
      const live = o.pools.filter((p) => (p.quoteReserve ?? 0n) > 0n);
      const q2 = slip.chain.native;
      if (live.length) notes.push({ level: "info", code: "pools", text: `Trades in ${live.length} ${live[0].dex} pool${live.length === 1 ? "" : "s"} against W${q2.symbol}: the deepest (${(live[0].feeBps / 100).toFixed(2)}% fee) holds ${formatUnits(live[0].quoteReserve ?? 0n, q2.decimals, 3)} W${q2.symbol}. Pools on other venues or against other pairs are not counted.` });
      else if (o.pools.length) notes.push({ level: "watch", code: "pools-empty", text: `A ${o.pools[0].dex} pool exists but holds no W${q2.symbol}: nothing to sell into there.` });
      else notes.push({ level: "info", code: "no-pool", text: `No W${q2.symbol} pool found: none on the chain's known DEX factories, and none announced by the Uniswap V4 singleton where that is read. It may trade on another venue, against another pair, or not at all.` });
      const hooked = o.pools.filter((p) => p.kind === "v4" && p.hooks && p.hooks !== ZERO_ADDRESS);
      for (const p of hooked) {
        notes.push({
          level: "watch",
          code: "v4-hook",
          text: `The ${p.dex} pool runs a hook at ${shortAddress(p.hooks)}: code that executes on every swap and can charge its own fee, decide who may trade, or refuse the swap outright. Any sale figure here is the pool's arithmetic and does not include whatever the hook does.`
        });
      }
    }
    const unidentified = (o.pools ?? []).filter((p) => p.kind === "unknown");
    if (unidentified.length) {
      notes.push({
        level: "watch",
        code: "venue-unidentified",
        text: `${unidentified.length} contract${unidentified.length === 1 ? "" : "s"} holding this token turned out to be a pool for it \u2014 ${unidentified.map((p) => `${p.dex} at ${shortAddress(p.address)}`).join(", ")} \u2014 found by asking the largest holders rather than from a list of factories. ${unidentified.length === 1 ? "It answers" : "They answer"} none of the pool shapes BOUNCER can price, so the balances are shown and no sale is priced from them: guessing the invariant is how a quote ends up flattering the exit.`
      });
    }
    if (o.liquidity) {
      const l = o.liquidity;
      const held = l.holders.filter((h2) => h2.kind === "wallet" || h2.kind === "contract");
      const shown = held.slice(0, 3);
      const heldBy = held.length ? `Held by ${shown.map((h2) => h2.name ? `${h2.name} (${shortAddress(h2.address)})` : shortAddress(h2.address)).join(", ")}${held.length > 3 ? ` and ${held.length - 3} more` : ""}.${shown.some((h2) => h2.namedByExplorer) ? " Those names come from the explorer's verified source, not from anything BOUNCER checked: a contract called a locker can still be told to release." : ""}` : "";
      const sliver = l.shareOfLiquidityBps < 1e3;
      const size = sliver ? ` That pool holds ${pct2(l.shareOfLiquidityBps)} of this token's liquidity, so it is not where a sale of any size would go.` : "";
      if (l.partial) {
        notes.push({
          level: "watch",
          code: "liquidity-partial",
          text: `Of the ${l.positionsRead} largest liquidity positions in the ${l.dex} pool (${l.positionsFound} were found), ${pct2(l.freeBps)} can be withdrawn${l.burnedBps ? `, ${pct2(l.burnedBps)} is burned` : ""}${l.lockedBps ? `, ${pct2(l.lockedBps)} is locked` : ""}. ${heldBy} The rest of the pool's positions were not read, so this is not a statement about the whole pool.`
        });
      } else if (l.burnedBps + l.lockedBps === 0 && l.freeBps > 0) {
        const parties = held.filter((h2) => !h2.unresolved);
        const untraced = held.filter((h2) => h2.unresolved).reduce((a, h2) => a + h2.shareBps, 0);
        const biggest = parties.length ? Math.max(...parties.map((h2) => h2.shareBps)) : 0;
        const enumerated = parties.length > 0;
        const concentrated = enumerated && biggest >= 5e3;
        const untracedNote = untraced > 0 ? ` A further ${pct2(untraced)} sits in positions whose owner could not be traced; that is withdrawable too, and it is not known to be one address.` : "";
        notes.push({
          level: sliver ? "info" : concentrated || !enumerated ? "stop" : "watch",
          code: "liquidity-free",
          text: enumerated ? concentrated ? `None of the ${l.dex} pool's liquidity is burned or in a locker BOUNCER knows, and one address holds ${pct2(biggest)} of it. ${heldBy} That one address can take most of the pool away on its own, and then there is nothing to sell into.${untracedNote}${size}` : `None of the ${l.dex} pool's liquidity is burned or in a locker BOUNCER knows, so all of it can be withdrawn \u2014 but it is spread across ${parties.length} holders and the largest has ${pct2(biggest)}, so no single one can empty the pool. ${heldBy} That is the ordinary shape of an unlocked pool, not by itself a trap.${untracedNote}${size}` : held.length ? (
            // Positions were found and none of their owners could be traced.
            // Different from never having looked, and the words have to be
            // different too: the size is known, the owner is not.
            `Every bit of the ${l.dex} pool's liquidity can be withdrawn, and none of the positions holding it could be traced to an owner. ${heldBy} How many addresses that is \u2014 one or a hundred \u2014 is unknown, and one would be enough to empty the pool.${size}`
          ) : `Every bit of the ${l.dex} pool's liquidity can be withdrawn: none of it is burned and none sits in a locker BOUNCER knows. Who holds the rest was not enumerated \u2014 this read asks the burn addresses and the lockers it knows, and everything else is the remainder \u2014 so whether that is one address or ten thousand is unknown, and one address would be enough.${size}`
        });
      } else if (l.freeBps >= 2e3) {
        notes.push({
          level: sliver ? "info" : "watch",
          code: "liquidity-partly-free",
          text: `${pct2(l.freeBps)} of the ${l.dex} pool's liquidity can be withdrawn${l.burnedBps ? `, ${pct2(l.burnedBps)} is burned` : ""}${l.lockedBps ? `, ${pct2(l.lockedBps)} is in ${l.holders.find((h2) => h2.kind === "locked")?.name ?? "a locker"}` : ""}. Taking out the withdrawable part would thin the pool by that much.${size}`
        });
      } else if (l.burnedBps + l.lockedBps > 0) {
        notes.push({
          level: "info",
          code: "liquidity-held",
          text: `${pct2(l.burnedBps + l.lockedBps)} of the ${l.dex} pool's liquidity cannot be withdrawn${l.burnedBps ? ` (${pct2(l.burnedBps)} burned)` : ""}${l.lockedBps ? ` (${pct2(l.lockedBps)} locked)` : ""}. A locked pool is not a promise about the price; it only means this liquidity stays put.`
        });
      }
      if (l.unread) notes.push({ level: "info", code: "liquidity-unread", text: `About the liquidity read: ${l.unread}.` });
    }
    const m = o.market;
    if (m && m.quotes.length && m.best) {
      const q2 = slip.chain.native;
      const whole = m.quotes.find((x) => x.shareBps === 1e4);
      const dec = slip.id.meta?.decimals ?? 18;
      if (whole) {
        const thin = whole.realisedBps > 0 && whole.realisedBps < 5e3;
        notes.push({
          level: thin ? "watch" : "info",
          code: "sale-price",
          text: `Selling ${formatUnits(whole.tokensIn, dec, 0)} tokens into the ${m.best.dex} pool would quote ${formatUnits(whole.out, q2.decimals, 4)} W${q2.symbol}` + (thin ? `, which is ${(whole.realisedBps / 100).toFixed(0)}% of the marginal price: the pool is thin for a position that size.` : ".") + (whole.beyondTick ? " That size leaves the pool's current tick, so the real figure depends on liquidity this does not read." : "") + " The token's own transfer tax, if it has one, is not included."
        });
      }
    }
    const price = o.explorer?.priceUsd;
    if (price !== null && price !== void 0) notes.push({ level: "info", code: "price", text: `The explorer's price feed says ${money(price)}${o.explorer.volume24hUsd !== null ? `, ${usd(o.explorer.volume24hUsd)} traded in 24 h` : ""}${o.explorer.marketCapUsd !== null ? `, ${usd(o.explorer.marketCapUsd)} market cap` : ""}. That feed is the explorer's, not the chain's.` });
    if (o.deployer?.createdAt) notes.push({ level: "info", code: "deployed", text: `Deployed ${formatDuration(Math.max(0, slip.at.timestamp - o.deployer.createdAt))} ago by ${shortAddress(o.deployer.address)}.` });
    if (o.activity) {
      if (o.activity.lastTransferAt !== null) {
        const ago = Math.max(0, slip.at.timestamp - o.activity.lastTransferAt);
        if (ago > 7 * 86400) notes.push({ level: "watch", code: "quiet", text: `No transfer for ${formatDuration(ago)}: nothing is trading here.` });
        else notes.push({ level: "info", code: "active", text: `Last transfer ${formatDuration(ago)} ago; ${o.activity.recentWallets} wallets in the last ${o.activity.recent} transfers.` });
      } else if (o.activity.recent === 0) notes.push({ level: "watch", code: "quiet", text: "The explorer has indexed no transfers of this token at all." });
    }
    return notes;
  }
  function probeNotes(o, probes, kind) {
    if (!probes.length) return [];
    const reverted = probes.filter((p) => p.status === "reverts");
    const unread = probes.filter((p) => p.status === "unread");
    const ok = probes.filter((p) => p.status === "ok");
    const from = probes[0].source === "deployer" ? "the deployer's wallet" : probes.length === 1 ? "a wallet holding it" : `each of ${probes.length} wallets holding it`;
    const what = kind === "sell" ? "into the pool" : "to a fresh wallet";
    const why = reverted[0]?.reason ? ` ("${reverted[0].reason}")` : "";
    const notes = [];
    if (!ok.length && !reverted.length) {
      notes.push({ level: "info", code: `${kind}-unread`, text: `The ${kind === "sell" ? "sale" : "transfer"} simulation could not be run: the node would not answer${unread[0]?.reason ? ` (${unread[0].reason})` : ""}. Nothing is claimed either way.` });
      return notes;
    }
    if (reverted.length && !ok.length) {
      notes.push({
        level: "stop",
        code: `${kind}-reverts`,
        text: kind === "sell" ? `Sending 1 unit ${what} from ${from} reverts right now${why}. A sale is a transfer into the pool, so on this reading the token cannot be sold. Simulated on the chain, nothing was sent.` : `A transfer ${what} from ${from} reverts right now${why}. Simulated on the chain, nothing was sent. This is what a paused, closed or trapping token looks like from the outside.`
      });
    } else if (reverted.length) {
      notes.push({
        level: "watch",
        code: `${kind}-some-revert`,
        text: `${reverted.length} of the ${probes.length} wallets tried cannot ${kind === "sell" ? "send tokens into the pool" : "transfer"} right now${why}; the others can. A blacklist or a lock on chosen wallets looks like this.`
      });
    } else {
      notes.push({
        level: "info",
        code: `${kind}-ok`,
        text: kind === "sell" ? `Sending 1 unit ${what} from ${from} goes through. That is the shape of a sale and it is not blocked at this block. It is one unit, not a priced trade: a fee on transfer, a cap on size or a rule that changes tomorrow would not show up here.` : `Tokens can move: a 1-unit transfer ${what} from ${from} goes through (simulated on the chain, nothing sent).`
      });
    }
    if (unread.length) notes.push({ level: "info", code: `${kind}-partial`, text: `${unread.length} further ${kind === "sell" ? "sale" : "transfer"} simulation${unread.length === 1 ? "" : "s"} could not be run and ${unread.length === 1 ? "is" : "are"} not counted above.` });
    return notes;
  }
  function money(value) {
    if (!Number.isFinite(value)) return "an unreadable number";
    if (value === 0) return "$0";
    if (value >= 1) return `$${value.toFixed(2)}`;
    const digits = Math.min(18, Math.max(2, 2 - Math.floor(Math.log10(Math.abs(value)))));
    return `$${value.toFixed(digits)}`;
  }
  function usd(value) {
    if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
    return `$${value.toFixed(0)}`;
  }
  function slipJson(value) {
    return JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v instanceof Set ? void 0 : v, 2);
  }

  // src/bouncer/mascot.ts
  var MASCOT_SVG_INNER = `<rect x="11" y="1" width="10" height="1" fill="#3e3e4c"/><rect x="9" y="2" width="14" height="1" fill="#3e3e4c"/><rect x="8" y="3" width="16" height="1" fill="#3e3e4c"/><rect x="7" y="4" width="18" height="1" fill="#3e3e4c"/><rect x="6" y="5" width="5" height="1" fill="#3e3e4c"/><rect x="11" y="5" width="10" height="1" fill="#757584"/><rect x="21" y="5" width="5" height="1" fill="#3e3e4c"/><rect x="6" y="6" width="4" height="1" fill="#3e3e4c"/><rect x="10" y="6" width="12" height="1" fill="#757584"/><rect x="22" y="6" width="4" height="1" fill="#3e3e4c"/><rect x="5" y="7" width="4" height="1" fill="#3e3e4c"/><rect x="9" y="7" width="14" height="1" fill="#0a0a0e"/><rect x="23" y="7" width="4" height="1" fill="#3e3e4c"/><rect x="5" y="8" width="4" height="1" fill="#3e3e4c"/><rect x="9" y="8" width="14" height="1" fill="#0a0a0e"/><rect x="23" y="8" width="4" height="1" fill="#3e3e4c"/><rect x="27" y="8" width="1" height="1" fill="#d4a017"/><rect x="5" y="9" width="4" height="1" fill="#3e3e4c"/><rect x="9" y="9" width="1" height="1" fill="#757584"/><rect x="10" y="9" width="12" height="1" fill="#0a0a0e"/><rect x="22" y="9" width="1" height="1" fill="#757584"/><rect x="23" y="9" width="4" height="1" fill="#3e3e4c"/><rect x="27" y="9" width="1" height="1" fill="#d4a017"/><rect x="5" y="10" width="4" height="1" fill="#3e3e4c"/><rect x="9" y="10" width="14" height="1" fill="#757584"/><rect x="23" y="10" width="4" height="1" fill="#3e3e4c"/><rect x="28" y="10" width="1" height="1" fill="#d4a017"/><rect x="5" y="11" width="4" height="1" fill="#3e3e4c"/><rect x="9" y="11" width="4" height="1" fill="#757584"/><rect x="13" y="11" width="2" height="1" fill="#1c1c22"/><rect x="15" y="11" width="2" height="1" fill="#757584"/><rect x="17" y="11" width="2" height="1" fill="#1c1c22"/><rect x="19" y="11" width="4" height="1" fill="#757584"/><rect x="23" y="11" width="4" height="1" fill="#3e3e4c"/><rect x="28" y="11" width="1" height="1" fill="#d4a017"/><rect x="6" y="12" width="3" height="1" fill="#3e3e4c"/><rect x="9" y="12" width="14" height="1" fill="#757584"/><rect x="23" y="12" width="3" height="1" fill="#3e3e4c"/><rect x="28" y="12" width="1" height="1" fill="#d4a017"/><rect x="6" y="13" width="4" height="1" fill="#3e3e4c"/><rect x="10" y="13" width="12" height="1" fill="#757584"/><rect x="22" y="13" width="4" height="1" fill="#3e3e4c"/><rect x="7" y="14" width="4" height="1" fill="#3e3e4c"/><rect x="11" y="14" width="10" height="1" fill="#757584"/><rect x="21" y="14" width="4" height="1" fill="#3e3e4c"/><rect x="8" y="15" width="16" height="1" fill="#3e3e4c"/><rect x="4" y="16" width="24" height="1" fill="#3e3e4c"/><rect x="2" y="17" width="9" height="1" fill="#3e3e4c"/><rect x="11" y="17" width="12" height="1" fill="#111117"/><rect x="23" y="17" width="8" height="1" fill="#3e3e4c"/><rect x="1" y="18" width="10" height="1" fill="#3e3e4c"/><rect x="11" y="18" width="12" height="1" fill="#111117"/><rect x="23" y="18" width="9" height="1" fill="#3e3e4c"/><rect x="1" y="19" width="10" height="1" fill="#3e3e4c"/><rect x="11" y="19" width="5" height="1" fill="#111117"/><rect x="16" y="19" width="2" height="1" fill="#c8102e"/><rect x="18" y="19" width="5" height="1" fill="#111117"/><rect x="23" y="19" width="9" height="1" fill="#3e3e4c"/><rect x="1" y="20" width="5" height="1" fill="#3e3e4c"/><rect x="7" y="20" width="19" height="1" fill="#3e3e4c"/><rect x="27" y="20" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="21" width="5" height="1" fill="#3e3e4c"/><rect x="7" y="21" width="19" height="1" fill="#3e3e4c"/><rect x="27" y="21" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="22" width="5" height="1" fill="#3e3e4c"/><rect x="7" y="22" width="2" height="1" fill="#3e3e4c"/><rect x="9" y="22" width="4" height="1" fill="#757584"/><rect x="13" y="22" width="8" height="1" fill="#3e3e4c"/><rect x="21" y="22" width="4" height="1" fill="#757584"/><rect x="25" y="22" width="1" height="1" fill="#3e3e4c"/><rect x="27" y="22" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="23" width="5" height="1" fill="#3e3e4c"/><rect x="7" y="23" width="2" height="1" fill="#3e3e4c"/><rect x="9" y="23" width="5" height="1" fill="#757584"/><rect x="14" y="23" width="6" height="1" fill="#3e3e4c"/><rect x="20" y="23" width="5" height="1" fill="#757584"/><rect x="25" y="23" width="1" height="1" fill="#3e3e4c"/><rect x="27" y="23" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="24" width="5" height="1" fill="#3e3e4c"/><rect x="7" y="24" width="19" height="1" fill="#3e3e4c"/><rect x="27" y="24" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="25" width="5" height="1" fill="#3e3e4c"/><rect x="8" y="25" width="17" height="1" fill="#3e3e4c"/><rect x="27" y="25" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="26" width="5" height="1" fill="#3e3e4c"/><rect x="10" y="26" width="12" height="1" fill="#111117"/><rect x="27" y="26" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="27" width="5" height="1" fill="#757584"/><rect x="10" y="27" width="12" height="1" fill="#111117"/><rect x="27" y="27" width="5" height="1" fill="#757584"/><rect x="1" y="28" width="5" height="1" fill="#757584"/><rect x="10" y="28" width="12" height="1" fill="#111117"/><rect x="27" y="28" width="5" height="1" fill="#757584"/><rect x="11" y="29" width="5" height="1" fill="#3e3e4c"/><rect x="17" y="29" width="5" height="1" fill="#3e3e4c"/><rect x="11" y="30" width="5" height="1" fill="#3e3e4c"/><rect x="17" y="30" width="5" height="1" fill="#3e3e4c"/><rect x="10" y="31" width="6" height="1" fill="#111117"/><rect x="17" y="31" width="6" height="1" fill="#111117"/>`;

  // src/bouncer/planner.ts
  init_abi();
  async function readLaunchPlan(rpc, options) {
    const f = options.factory;
    const configId = options.configId ?? 0;
    const pairToken = (options.pairToken ?? ZERO_ADDRESS).toLowerCase();
    const native = pairToken === ZERO_ADDRESS;
    const calls = [
      { to: f, data: encodeCall(FACTORY_FUNCTIONS.getLaunchConfig, [BigInt(configId)]) },
      { to: f, data: encodeCall(FACTORY_FUNCTIONS.launchFee, []) },
      { to: f, data: encodeCall(FACTORY_FUNCTIONS.maxCreatorTaxBps, []) },
      { to: f, data: encodeCall(FACTORY_FUNCTIONS.snipeTaxStartBps, []) },
      { to: f, data: encodeCall(FACTORY_FUNCTIONS.snipeTaxSeconds, []) },
      { to: f, data: encodeCall(FACTORY_FUNCTIONS.memeHook, []) },
      ...native ? [] : [{ to: f, data: encodeCall(FACTORY_FUNCTIONS.pairTokenEconomics, [pairToken]) }]
    ];
    const r = await rpc.callBatch(calls, options.block);
    const [supply, curveFeeBps, phantomNative, thresholdNative, poolFee, tickSpacing, enabled] = decodeOutputs(FACTORY_FUNCTIONS.getLaunchConfig, r[0]);
    const [launchFee] = decodeOutputs(FACTORY_FUNCTIONS.launchFee, r[1]);
    const [maxCreatorTaxBps] = decodeOutputs(FACTORY_FUNCTIONS.maxCreatorTaxBps, r[2]);
    const [startBps] = decodeOutputs(FACTORY_FUNCTIONS.snipeTaxStartBps, r[3]);
    const [seconds] = decodeOutputs(FACTORY_FUNCTIONS.snipeTaxSeconds, r[4]);
    const [hook] = decodeOutputs(FACTORY_FUNCTIONS.memeHook, r[5]);
    let phantomQuote = phantomNative;
    let graduationThreshold = thresholdNative;
    let quote = { symbol: options.nativeSymbol, decimals: 18 };
    if (!native) {
      const [p, t] = decodeOutputs(FACTORY_FUNCTIONS.pairTokenEconomics, r[6]);
      phantomQuote = p;
      graduationThreshold = t;
      quote = await readTokenMeta(rpc, pairToken, options.block);
    }
    let hookFeeBps = 0n;
    let protocolFeeShareBps = 0n;
    let buybackBurnBps = 0n;
    try {
      const [policyRaw] = await rpc.callBatch([{ to: hook, data: encodeCall(HOOK_FUNCTIONS.currentFeePolicy, []) }], options.block);
      const p = decodeOutputs(HOOK_FUNCTIONS.currentFeePolicy, policyRaw);
      protocolFeeShareBps = p[1];
      buybackBurnBps = p[2];
      hookFeeBps = p[3];
    } catch {
    }
    const creatorTaxBps = options.creatorTaxBps ?? 100n;
    if (creatorTaxBps > maxCreatorTaxBps) throw new Error(`creator tax ${creatorTaxBps} bps is above the factory ceiling of ${maxCreatorTaxBps} bps`);
    const reserved = phantomQuote + graduationThreshold === 0n ? 0n : supply * phantomQuote / (phantomQuote + graduationThreshold);
    const startPrice = supply === 0n ? 0n : phantomQuote * 10n ** 18n / supply;
    const graduationPrice = reserved === 0n ? 0n : (phantomQuote + graduationThreshold) * 10n ** 18n / reserved;
    const sampleBuy = options.sampleBuy ?? 10n ** BigInt(quote.decimals) / 10n;
    return {
      block: options.block,
      configId,
      configEnabled: enabled,
      pairToken,
      quote,
      supply,
      curveFeeBps,
      creatorTaxBps,
      maxCreatorTaxBps,
      phantomQuote,
      graduationThreshold,
      poolFeePpm: poolFee,
      tickSpacing,
      launchFee,
      hookFeeBps,
      protocolFeeShareBps,
      buybackBurnBps,
      snipe: { startBps, seconds: Number(seconds) },
      startPrice,
      graduationPrice,
      tokensSoldOnCurve: supply - reserved,
      tokensToPool: reserved,
      fdvAtGraduation: graduationPrice * supply / 10n ** 18n,
      creatorPerVolumeBps: creatorTaxBps,
      sampleBuy,
      sampleDoorCharge: sampleBuy * startBps / 10000n
    };
  }

  // src/bouncer/position.ts
  init_abi();
  init_tape();
  async function readPosition(rpc, launch, wallet, fromBlock, toBlock, factory, chunkSize = 2e3) {
    const who = wallet.toLowerCase();
    const buys = await readTape(rpc, { fromBlock, toBlock, address: launch.curve, events: [CURVE_EVENTS.CurveBuy], topics: [addressTopic(who)], chunkSize });
    const sells = await readTape(rpc, { fromBlock, toBlock, address: launch.curve, events: [CURVE_EVENTS.CurveSell], topics: [addressTopic(who)], chunkSize });
    const trades = [
      ...buys.logs.map((l) => ({ block: l.blockNumber, kind: "buy", quote: l.args.quoteIn, tokens: l.args.tokensOut, fee: l.args.fee, tax: l.args.tax, tx: l.transactionHash })),
      ...sells.logs.map((l) => ({ block: l.blockNumber, kind: "sell", quote: l.args.quoteOut, tokens: l.args.tokensIn, fee: l.args.fee, tax: l.args.tax, tx: l.transactionHash }))
    ].sort((a, b) => a.block - b.block);
    const [balanceRaw] = await rpc.callBatch([{ to: launch.token, data: encodeCall(ERC20_FUNCTIONS.balanceOf, [who]) }], toBlock);
    const [balance] = decodeOutputs(ERC20_FUNCTIONS.balanceOf, balanceRaw);
    const spentQuote = trades.filter((t) => t.kind === "buy").reduce((a, t) => a + t.quote, 0n);
    const receivedQuote = trades.filter((t) => t.kind === "sell").reduce((a, t) => a + t.quote, 0n);
    const feesPaid = trades.reduce((a, t) => a + t.fee, 0n);
    const taxesPaid = trades.reduce((a, t) => a + t.tax, 0n);
    const exit = await readExitDoor(rpc, launch, { position: balance, block: toBlock, factory });
    const whole = exit.quotes.find((q2) => q2.shareBps === 1e4);
    const costBasis = spentQuote - receivedQuote;
    return { wallet: who, token: launch.token.toLowerCase(), balance, trades, spentQuote, receivedQuote, feesPaid, taxesPaid, costBasis, exit, unrealised: (whole?.net ?? 0n) - costBasis };
  }

  // src/bouncer/leaderboard.ts
  init_abi();
  init_tape();
  async function readBoard(rpc, options) {
    const factory = options.factory ?? PONS_V2_FACTORY;
    const top = options.top ?? 10;
    const ledger = await readTapeAdaptive(
      rpc,
      { fromBlock: options.fromBlock, toBlock: options.toBlock, address: factory, events: [FACTORY_EVENTS.TokenLaunched, FACTORY_EVENTS.LaunchSwept, FACTORY_EVENTS.PoolGraduated, FACTORY_EVENTS.PoolGraduatedLegacy] },
      { startChunk: options.chunkSize ?? 5e3, maxChunk: options.chunkSize ?? 2e4 }
    );
    const byDeployer = /* @__PURE__ */ new Map();
    const tokenToDeployer = /* @__PURE__ */ new Map();
    const curveToToken = /* @__PURE__ */ new Map();
    let launches = 0;
    let graduations = 0;
    for (const l of ledger.logs) {
      const token = String(l.args.token).toLowerCase();
      if (l.name === "TokenLaunched") {
        const deployer = String(l.args.deployer).toLowerCase();
        launches++;
        tokenToDeployer.set(token, deployer);
        curveToToken.set(String(l.args.curve).toLowerCase(), token);
        const row = byDeployer.get(deployer) ?? { deployer, launched: 0, swept: 0, graduated: 0, tokens: [] };
        row.launched++;
        row.tokens.push(token);
        byDeployer.set(deployer, row);
      } else if (l.name === "LaunchSwept") {
        const d = tokenToDeployer.get(token);
        if (d) byDeployer.get(d).swept++;
      } else if (l.name === "PoolGraduated") {
        graduations++;
        const d = tokenToDeployer.get(token);
        if (d) byDeployer.get(d).graduated++;
      }
    }
    const rows = [...byDeployer.values()];
    const topDeployers = rows.slice().sort((a, b) => b.graduated - a.graduated || b.launched - a.launched).slice(0, top);
    const serial = rows.filter((r) => r.launched >= 5 && r.graduated === 0).sort((a, b) => b.launched - a.launched).slice(0, top);
    let coverTotal = 0n;
    let taxedBuys = 0;
    let topCurves = [];
    let topPayers = [];
    let chunks = ledger.chunks;
    if (!options.skipCover) {
      const buys = await readTapeAdaptive(
        rpc,
        { fromBlock: options.fromBlock, toBlock: options.toBlock, events: [CURVE_EVENTS.CurveBuy] },
        { startChunk: Math.min(options.chunkSize ?? 2e3, 2e3), maxChunk: options.chunkSize ?? 1e4 }
      );
      chunks += buys.chunks;
      const curves = [...new Set(buys.logs.map((l) => l.address.toLowerCase()))];
      const rates = /* @__PURE__ */ new Map();
      for (let i = 0; i < curves.length; i += 50) {
        const slice = curves.slice(i, i + 50);
        const raw = await rpc.callBatch(slice.map((c) => ({ to: c, data: encodeCall(CURVE_FUNCTIONS.creatorTaxBps, []) })), options.toBlock).catch(() => null);
        slice.forEach((c, j) => {
          try {
            rates.set(c, raw ? decodeOutputs(CURVE_FUNCTIONS.creatorTaxBps, raw[j])[0] : 0n);
          } catch {
            rates.set(c, 0n);
          }
        });
      }
      const perCurve = /* @__PURE__ */ new Map();
      const perPayer = /* @__PURE__ */ new Map();
      for (const l of buys.logs) {
        const curve = l.address.toLowerCase();
        const rate = rates.get(curve) ?? 0n;
        const quoteIn = l.args.quoteIn;
        const tax = l.args.tax;
        const creatorPart = quoteIn * rate / 10000n;
        const cover = tax > creatorPart ? tax - creatorPart : 0n;
        const row = perCurve.get(curve) ?? { curve, token: curveToToken.get(curve) ?? null, creatorTaxBps: rate, buys: 0, taxedBuys: 0, coverCollected: 0n, highestBps: 0 };
        row.buys++;
        if (cover > 0n) {
          row.taxedBuys++;
          row.coverCollected += cover;
          row.highestBps = Math.max(row.highestBps, quoteIn === 0n ? 0 : Number(cover * 10000n / quoteIn));
          taxedBuys++;
          coverTotal += cover;
          const buyer2 = String(l.args.buyer).toLowerCase();
          const p = perPayer.get(buyer2) ?? { wallet: buyer2, buys: 0, coverPaid: 0n };
          p.buys++;
          p.coverPaid += cover;
          perPayer.set(buyer2, p);
        }
        perCurve.set(curve, row);
      }
      topCurves = [...perCurve.values()].filter((r) => r.coverCollected > 0n).sort((a, b) => b.coverCollected > a.coverCollected ? 1 : -1).slice(0, top);
      topPayers = [...perPayer.values()].sort((a, b) => b.coverPaid > a.coverPaid ? 1 : -1).slice(0, top);
    }
    return { window: { fromBlock: options.fromBlock, toBlock: options.toBlock }, launches, graduations, deployers: rows.length, topDeployers, serial, coverTotal, taxedBuys, topCurves, topPayers, chunks };
  }

  // src/bouncer/watch.ts
  init_tape();
  async function readWatchEvents(rpc, launch, options) {
    const factory = options.factory ?? PONS_V2_FACTORY;
    const q2 = options.quote ?? { symbol: "ETH", decimals: 18 };
    const chunkSize = options.chunkSize ?? 5e3;
    const window2 = { fromBlock: options.fromBlock, toBlock: options.toBlock, chunkSize };
    const deployer = launch.deployer.toLowerCase();
    const curve = launch.curve.toLowerCase();
    const token = launch.token.toLowerCase();
    const crew = (options.crew ?? []).map((w) => w.toLowerCase()).filter((w) => w !== deployer);
    const events = [];
    const devSells = await readTape(rpc, { ...window2, address: curve, events: [CURVE_EVENTS.CurveSell], topics: [addressTopic(deployer)] });
    for (const l of devSells.logs) {
      events.push({ block: l.blockNumber, kind: "dev-sold", tx: l.transactionHash, wallets: [deployer], quote: l.args.quoteOut, tokens: l.args.tokensIn, text: `deployer sold ${formatUnits(l.args.tokensIn, 18, 0)} tokens on the curve for ${formatUnits(l.args.quoteOut, q2.decimals)} ${q2.symbol}` });
    }
    const devTransfers = await readTape(rpc, { ...window2, address: token, events: [ERC20_EVENTS.Transfer], topics: [addressTopic(deployer)] });
    for (const l of devTransfers.logs) {
      const to = String(l.args.to).toLowerCase();
      if (to === curve) continue;
      events.push({ block: l.blockNumber, kind: "dev-transferred", tx: l.transactionHash, wallets: [deployer, to], tokens: l.args.value, text: `deployer moved ${formatUnits(l.args.value, 18, 0)} tokens to ${shortAddress(to)}` });
    }
    const factoryTape = await readTape(rpc, { ...window2, address: factory, events: [FACTORY_EVENTS.CreatorFeeRecipientUpdated, FACTORY_EVENTS.BuybackEnabledUpdated, FACTORY_EVENTS.LaunchSwept, FACTORY_EVENTS.PoolGraduated, FACTORY_EVENTS.PoolGraduatedLegacy], topics: [addressTopic(token)] });
    for (const l of factoryTape.logs) {
      if (l.name === "CreatorFeeRecipientUpdated") events.push({ block: l.blockNumber, kind: "fee-recipient-moved", tx: l.transactionHash, wallets: [String(l.args.newRecipient).toLowerCase()], text: `creator tax recipient moved to ${shortAddress(String(l.args.newRecipient))}` });
      else if (l.name === "BuybackEnabledUpdated") events.push({ block: l.blockNumber, kind: "buyback-changed", tx: l.transactionHash, wallets: [], text: `buyback turned ${l.args.enabled ? "on" : "off"}` });
      else if (l.name === "LaunchSwept") events.push({ block: l.blockNumber, kind: "swept", tx: l.transactionHash, wallets: [], quote: l.args.quoteOut, text: `curve swept: ${formatUnits(l.args.quoteOut, q2.decimals)} ${q2.symbol} on the way to the pool` });
      else if (l.name === "PoolGraduated") events.push({ block: l.blockNumber, kind: "graduated", tx: l.transactionHash, wallets: [], text: "graduated: the pool exists and the position is locked" });
    }
    if (crew.length) {
      const crewTopics = crew.map(addressTopic);
      const sells = await readTape(rpc, { ...window2, address: curve, events: [CURVE_EVENTS.CurveSell], topics: [crewTopics] });
      const moves = await readTape(rpc, { ...window2, address: token, events: [ERC20_EVENTS.Transfer], topics: [crewTopics] });
      const left = /* @__PURE__ */ new Map();
      for (const l of sells.logs) {
        const who = String(l.args.seller).toLowerCase();
        const prev = left.get(who);
        left.set(who, { block: Math.min(prev?.block ?? l.blockNumber, l.blockNumber), quote: (prev?.quote ?? 0n) + l.args.quoteOut, tx: prev?.tx ?? l.transactionHash });
      }
      for (const l of moves.logs) {
        if (String(l.args.to).toLowerCase() === curve) continue;
        const who = String(l.args.from).toLowerCase();
        if (!left.has(who)) left.set(who, { block: l.blockNumber, quote: 0n, tx: l.transactionHash });
      }
      if (left.size >= 2) {
        const wallets = [...left.keys()];
        const quote = [...left.values()].reduce((a, v) => a + v.quote, 0n);
        const first = Math.min(...[...left.values()].map((v) => v.block));
        events.push({ block: first, kind: "crew-exit", tx: [...left.values()][0].tx, wallets, quote, text: `${wallets.length} of ${crew.length} crew wallets left in the same window${quote ? `, ${formatUnits(quote, q2.decimals)} ${q2.symbol} out` : ""}` });
      }
    }
    events.sort((a, b) => a.block - b.block);
    return events;
  }

  // src/bouncer/txReceipt.ts
  init_abi();
  async function readTradeReceipt(rpc, hash, factory) {
    const receipt = await rpc.send("eth_getTransactionReceipt", [hash]);
    if (!receipt) throw new Error(`no receipt for ${hash}; is it on this chain?`);
    const block = Number(BigInt(receipt.blockNumber));
    const buyTopic = eventTopic(CURVE_EVENTS.CurveBuy);
    const sellTopic = eventTopic(CURVE_EVENTS.CurveSell);
    const reader = new PonsReader(rpc, factory);
    const out2 = [];
    for (const log of receipt.logs) {
      const topic = (log.topics[0] ?? "").toLowerCase();
      if (topic !== buyTopic && topic !== sellTopic) continue;
      const isBuy = topic === buyTopic;
      const decoded = decodeLog(isBuy ? CURVE_EVENTS.CurveBuy : CURVE_EVENTS.CurveSell, log);
      const curve = log.address.toLowerCase();
      let launch = null;
      try {
        const [tokenRaw] = await rpc.callBatch([{ to: curve, data: encodeCall(CURVE_FUNCTIONS.token, []) }], block);
        const [token] = decodeOutputs(CURVE_FUNCTIONS.token, tokenRaw);
        launch = await reader.launchedToken(token, block);
        if (launch.curve.toLowerCase() !== curve) launch = null;
      } catch (error) {
        if (!(error instanceof NotAPonsLaunch)) launch = null;
      }
      const quote = isBuy ? decoded.args.quoteIn : decoded.args.quoteOut;
      const tokens = isBuy ? decoded.args.tokensOut : decoded.args.tokensIn;
      const fee = decoded.args.fee;
      const tax = decoded.args.tax;
      const creatorTaxPart = launch ? quote * launch.creatorTaxBps / 10000n : tax;
      const coverChargePart = tax > creatorTaxPart ? tax - creatorTaxPart : 0n;
      let marginalPriceAfter = null;
      try {
        const [reservesRaw] = await rpc.callBatch([{ to: curve, data: encodeCall(CURVE_FUNCTIONS.getReserves, []) }], block);
        const [q2, t] = decodeOutputs(CURVE_FUNCTIONS.getReserves, reservesRaw);
        marginalPriceAfter = t === 0n ? null : q2 * 10n ** 18n / t;
      } catch {
        marginalPriceAfter = null;
      }
      out2.push({
        hash,
        block,
        kind: isBuy ? "buy" : "sell",
        curve,
        launch,
        wallet: String(isBuy ? decoded.args.buyer : decoded.args.seller).toLowerCase(),
        quote,
        tokens,
        fee,
        tax,
        creatorTaxPart,
        coverChargePart,
        effectivePrice: tokens === 0n ? 0n : quote * 10n ** 18n / tokens,
        marginalPriceAfter
      });
    }
    if (!out2.length) throw new Error(`${hash} has no curve buy or sell in it`);
    return out2;
  }

  // site/src/app.ts
  var LEVEL_WORD = { stop: "Stop", watch: "Careful", info: "Note" };
  var REPO = "github.com/Kepochnik/bouncer";
  var MARK = "$BOUNCER";
  var ADDR = /^0x[0-9a-fA-F]{40}$/;
  var SANDBOXED = /(^|\.)claude\.ai$|claudeusercontent|anthropic/.test(location.hostname);
  var HOSTED = "https://kepochnik.github.io/bouncer/";
  var DEFAULT_PROXY = "https://bouncer-proxy.tarasenkosanja12.workers.dev";
  var $ = (id) => document.getElementById(id);
  var out = $("out");
  var status = $("status");
  var form = $("form");
  var q = $("q");
  var go = $("go");
  var rpcInput = $("rpc");
  var proxyInput = $("proxy");
  var factoryInput = $("factory");
  var chainSelect = $("chain");
  var settings = $("settings");
  var sourcePill = $("source-pill");
  var sourceText = $("source-text");
  var settingsToggle = $("settings-toggle");
  var toast = $("toast");
  var mode = "demo";
  var view = "door";
  var ticker = null;
  var watcher = null;
  function storage(key, value) {
    try {
      if (value !== void 0) localStorage.setItem(key, value);
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  var autoChain = null;
  var resolvedFor = { address: "", chain: "" };
  function chainOrNull() {
    if (mode === "demo") return CHAINS.robinhood;
    if (chainSelect.value === "auto") return autoChain;
    return chainByKey(chainSelect.value);
  }
  function chain() {
    return chainOrNull() ?? CHAINS.robinhood;
  }
  function setMode(next, silent = false) {
    mode = next;
    $("mode-demo").setAttribute("aria-pressed", String(next === "demo"));
    $("mode-live").setAttribute("aria-pressed", String(next === "live"));
    chainSelect.disabled = next === "demo";
    sourcePill.textContent = next === "demo" ? "Demo data" : chainOrNull() ? `Live \xB7 ${chainOrNull().name}` : "Live \xB7 finding the chain";
    sourcePill.classList.toggle("live", next === "live");
    sourceText.innerHTML = next === "demo" ? SANDBOXED ? `You are looking at an invented example chain. This preview on claude.ai cannot reach the internet, so <b>Live</b> is off here: use the <a href="${HOSTED}">hosted site</a>, the Chrome extension or the CLI for real tokens.` : "You are looking at an invented example chain. Switch to <b>Live</b> to check a real token." : `Reading ${esc2(chain().name)} from your browser at one block. Nothing is cached.`;
    renderChips();
    if (!silent) storage("bouncer.mode", next);
  }
  function setView(next) {
    view = next;
    const labels = {
      door: "Token address",
      dev: "Deployer address",
      wallet: "Token and wallet",
      tx: "Transaction hash",
      plan: "Plan a launch",
      board: "Tonight's board"
    };
    $("door-label").textContent = labels[next];
  }
  function detect(raw) {
    const parts = raw.trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length === 1 && mode === "live" && (chainSelect.value === "auto" || chain().family === "solana") && isSolanaAddress(parts[0]) && !ADDR.test(parts[0])) return { view: "door", parts };
    if (parts.length === 2 && ADDR.test(parts[0]) && ADDR.test(parts[1])) return { view: "wallet", parts };
    if (parts.length === 1 && ADDR.test(parts[0])) return { view: "door", parts };
    if (parts.length === 1 && /^0x[0-9a-fA-F]{64}$/.test(parts[0])) return { view: "tx", parts };
    if (parts.length === 1 && /^0x/.test(parts[0]) && mode === "demo" && /^0xdemo/i.test(parts[0])) return { view: "tx", parts };
    if (raw.trim() && mode === "live" && /^\$?[a-z0-9 ._-]{2,32}$/i.test(raw.trim())) return { view: "door", parts: [raw.trim()] };
    return null;
  }
  function proxyBase() {
    return (proxyInput.value.trim() || DEFAULT_PROXY).replace(/\/$/, "");
  }
  function rpcForChain(c, memo = false) {
    const url = rpcInput.value.trim();
    const proxy = proxyBase();
    const urls = url ? [url] : proxy ? [`${proxy}/rpc/${c.key}`, ...c.rpc] : c.rpc;
    return new RpcClient({ urls, expectedChainId: c.chainId, minSpacingMs: 120, memo });
  }
  function rpcFor(memo = false) {
    if (mode === "demo") return demoRpc(memo);
    return rpcForChain(chain(), memo);
  }
  function blockscoutFor(memo = false) {
    if (mode === "demo") return new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch(), memo });
    const c = chain();
    if (!c.blockscout) return null;
    const proxy = proxyBase();
    return new BlockscoutClient({ baseUrl: proxy ? `${proxy}/api/${c.key}` : c.blockscout, memo });
  }
  function factoryFor() {
    const c = chain();
    const f = (mode === "live" ? factoryInput.value.trim() : "") || c.factory || "";
    return f ? f.toLowerCase() : void 0;
  }
  function solanaRpcFor(memo = false) {
    const c = chain();
    const url = rpcInput.value.trim();
    const proxy = proxyBase();
    const urls = url ? [url] : proxy ? [`${proxy}/rpc/${c.key}`, ...c.rpc] : c.rpc;
    return new SolanaRpc({ urls, minSpacingMs: 120, memo });
  }
  var EXAMPLES = [
    { label: "A fresh launch", hint: "9 s old, door tax still open", hash: `#/demo/${DEMO.tokens.fresh.token}` },
    { label: "A graduated token", hint: "filled its curve in 212 s", hash: `#/demo/${DEMO.tokens.sprint.token}` },
    { label: "A fake copy", hint: "same name, not from the factory", hash: `#/demo/${DEMO_IMPOSTOR.token}` },
    { label: "An ordinary token", hint: "not a launch: owner keeps mint, pause, blacklist", hash: `#/demo/${DEMO_PLAIN.token}` },
    { label: "A dev on the move", hint: "sold and moved tokens, watch on", hash: `#/demo/${DEMO.tokens.late.token}?watch=1` },
    { label: "A trade receipt", hint: "one buy, itemised", hash: `#/tx/0xdemoFRESH${DEMO.tokens.fresh.launched + 22}?chain=demo` },
    { label: "A Pons V1 token", hint: "the older launchpad, caps still on", hash: `#/demo/${DEMO_V1.token}` }
  ];
  function renderChips() {
    const chips = $("chips");
    chips.innerHTML = "";
    if (mode === "demo") {
      const label = document.createElement("span");
      label.textContent = "Try an example:";
      chips.appendChild(label);
      for (const e of EXAMPLES) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.innerHTML = `${esc2(e.label)}<em>${esc2(e.hint)}</em>`;
        b.addEventListener("click", () => {
          location.hash = e.hash;
        });
        chips.appendChild(b);
      }
    }
    const more = document.createElement("div");
    more.className = "more";
    const c = mode === "demo" ? "demo" : chainSelect.value === "auto" ? chainOrNull()?.key ?? "auto" : chain().key;
    more.innerHTML = `<span>More:</span><a href="#/board?chain=${c}">Tonight's board</a><a href="#/plan?tax=100&chain=${c}">Plan a launch</a><span>Paste "token wallet" (two addresses) to see one wallet's bag.</span>`;
    chips.appendChild(more);
  }
  new MutationObserver(() => {
    document.body.classList.toggle("answered", (document.getElementById("out")?.childElementCount ?? 0) > 0);
  }).observe(document.getElementById("out"), { childList: true });
  document.addEventListener("click", async (event) => {
    const target = event.target?.closest("[data-copy]");
    if (!target) return;
    const text = target.dataset.copy ?? "";
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied");
    } catch {
      showToast(text);
    }
  });
  function showToast(text) {
    toast.textContent = text;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 1600);
  }
  function busy(text) {
    go.disabled = true;
    stopWatch();
    status.innerHTML = `<span class="dot"></span> ${esc2(text)} ${mode === "demo" ? "(demo chain, every address invented)" : `(${esc2(chain().name)}, one block pinned)`}`;
    out.innerHTML = "";
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }
  function failed(error, input) {
    const message = error instanceof Error ? error.message : String(error);
    const network = /fetch|network|failed|CORS|load|abort/i.test(message) && mode === "live";
    status.textContent = "";
    out.innerHTML = `<div class="error"><strong>Could not read the chain.</strong><p>${esc2(message)}</p>${SANDBOXED ? `<p>This is the claude.ai preview: the sandbox blocks every request a page makes, so no RPC can be reached from here, whatever its settings. Real tokens work on the <a href="${HOSTED}">hosted site</a>, in the <a href="https://github.com/Kepochnik/bouncer#browser-extension">Chrome extension</a> (it can call any RPC), or in the CLI: <code>npx bouncer door ${esc2(input)} --chain ${esc2(chain().key)}</code>.</p>` : network ? `<p>The browser could not reach the RPC. Public endpoints often refuse requests from websites. Three ways out: deploy the read-only <a href="https://github.com/Kepochnik/bouncer/tree/main/proxy">proxy</a> (3 minutes, free) and paste its URL under Settings \u2192 Proxy URL; the <a href="https://github.com/Kepochnik/bouncer#browser-extension">Chrome extension</a> (it can call any RPC); or the CLI: <code>npx bouncer door ${esc2(input)} --chain ${esc2(chain().key)}</code>. Demo mode works offline.</p>` : ""}</div>`;
  }
  function done(text) {
    go.disabled = false;
    status.textContent = `${mode === "demo" ? "DEMO \xB7 " : `${chain().name} \xB7 `}${text}`;
  }
  function isDemoAddress(address) {
    const a = address.toLowerCase();
    return Object.values(DEMO.tokens).some((t) => t.token === a || t.curve === a || t.deployer === a) || a === DEMO_IMPOSTOR.token || a === DEMO_PLAIN.token || a === DEMO_V1.token || a === DEMO_V1.deployer || a === "0x000000000000000000000000000000000000dead";
  }
  var doorRun = 0;
  var SLOW_SECTIONS = { skipLiquidity: true, skipDev: true, skipRoom: true, skipCrew: true, skipLookalikes: true };
  var OPENING_SECTIONS = { ...SLOW_SECTIONS, skipMarket: true, skipExplorer: true, skipProbes: true, skipOwnerWallet: true };
  async function runSearch(query) {
    const bs = blockscoutFor();
    if (!bs) {
      return bad(
        `"${query}" is not an address, and ${chain().name} has no explorer BOUNCER can search. Paste the contract address: 0x followed by 40 hex characters.`
      );
    }
    busy(`looking for "${query}" on ${chain().name}\u2026`);
    let hits;
    try {
      hits = (await bs.searchTokens(query)).slice(0, 12);
    } catch (error) {
      return bad(`Could not search ${chain().name} for "${esc2(query)}": ${error instanceof Error ? error.message : String(error)}. Paste the contract address instead.`);
    }
    status.textContent = "";
    if (!hits.length) {
      out.innerHTML = `<div class="error"><strong>Nothing on ${esc2(chain().name)} called "${esc2(query)}".</strong>
      <p>The explorer's index has no token by that name here. It may be on another chain \u2014 try the chain picker \u2014 or too new to be indexed, in which case only its contract address will find it.</p></div>`;
      return;
    }
    const rows = hits.map(
      (h) => `<li><button class="hit" type="button" data-go="${esc2(h.address)}">
        <span class="hit-sym">${esc2(h.symbol || "\u2014")}</span>
        <span class="hit-name">${esc2(h.name || "no name")}</span>
        <span class="hit-addr mono">${esc2(h.address)}</span>
      </button></li>`
    ).join("");
    out.innerHTML = `<section class="found">
    <h2>${hits.length} token${hits.length === 1 ? "" : "s"} on ${esc2(chain().name)} called something like "${esc2(query)}"</h2>
    <p class="qblurb">BOUNCER will not pick for you. A ticker is not unique and anyone can deploy one \u2014 which is the whole reason this tool exists. Check the address against the one the team posted, then open it.</p>
    <ul class="hits">${rows}</ul>
  </section>`;
    for (const button of out.querySelectorAll("[data-go]")) {
      button.addEventListener("click", () => {
        location.hash = `#/t/${button.dataset.go}?chain=${chain().key}`;
      });
    }
  }
  function paintSelectedChain() {
    if (chainSelect.value === "auto") {
      q.placeholder = "0x\u2026 or a Solana mint \u2014 BOUNCER finds the chain";
      $("chain-hint").textContent = `BOUNCER asks every chain it knows where this address lives: ${searchableChains().map((c2) => c2.name).join(", ")}, and Solana by the shape of the address. Pick one from the menu to skip the search and read it directly.`;
      return;
    }
    const c = chainByKey(chainSelect.value);
    q.placeholder = c.family === "solana" ? "a Solana mint address (base58, like EPjFWdd5\u2026yTDt1v)" : "0x\u2026 (a token, its curve, a wallet or a transaction hash)";
    $("chain-hint").textContent = `${c.name}${c.chainId ? ` (${c.chainId})` : ""}${c.launchpad ? ` \xB7 ${c.launchpad}` : " \xB7 no launchpad known here"} \xB7 RPC ${c.rpc[0]}${c.blockscout ? ` \xB7 explorer ${c.blockscout}` : " \xB7 no explorer known, the funder check and same-name search are off"}${c.notes ? ` \xB7 ${c.notes}` : ""}`;
  }
  function paintChain() {
    const c = chainOrNull();
    sourcePill.textContent = mode === "demo" ? "Demo data" : c ? `Live \xB7 ${c.name}` : "Live \xB7 finding the chain";
  }
  async function resolveChain(address) {
    if (autoChain && autoChain.key === resolvedFor.chain && resolvedFor.address === address.toLowerCase()) return true;
    busy("finding the chain this address lives on\u2026");
    let search;
    try {
      search = await whichChains(address, (c) => rpcForChain(c), searchableChains());
    } catch (error) {
      bad(`The chains could not be asked where this address lives: ${error instanceof Error ? error.message : String(error)}. Pick one from the menu and BOUNCER will read it directly.`);
      return false;
    }
    const verdict = readChainSearch(search);
    if (verdict.kind === "one") {
      autoChain = verdict.chain;
      resolvedFor = { address: address.toLowerCase(), chain: verdict.chain.key };
      paintChain();
      return true;
    }
    if (verdict.kind === "several") {
      renderChainChoice(address, search);
      return false;
    }
    renderChainMiss(address, search);
    return false;
  }
  function renderChainChoice(address, search) {
    const rows = search.hits.map(
      // Its own classes, not the ticker search's: a check asserts every
      // `.hit-addr` on the page is a bare 0x address, and this one names a
      // chain. Two different lists should not share a name.
      (h) => `<button class="chain-hit" data-chain="${esc2(h.chain.key)}">
        <span class="hit-name">${esc2(h.token ? `${h.token.name} \xB7 ${h.token.symbol}` : "a contract, which does not name itself")}</span>
        <span class="chain-hit-where">${esc2(h.chain.name)} \xB7 ${h.codeSize.toLocaleString()} bytes of code</span>
      </button>`
    ).join("");
    out.innerHTML = `<section class="found">
    <h2>${search.hits.length} chains have a contract at this address</h2>
    <p class="qblurb">That is not a glitch. A contract's address comes from who deployed it and how many times they had deployed before, so the same pair lands on the same address on every chain \u2014 which is also how somebody puts a real token on one chain and something else at the matching address on another. Which one did you mean?</p>
    <div class="hits">${rows}</div>
    <p class="buy-gap"><span class="mono">${esc2(address)}</span></p>
  </section>`;
    for (const button of out.querySelectorAll("[data-chain]")) {
      button.addEventListener("click", () => {
        location.hash = `#/t/${address.toLowerCase()}?chain=${button.dataset.chain}`;
      });
    }
  }
  function renderChainMiss(address, search) {
    const asked = search.empty.map((c) => c.name).join(", ");
    const broke = search.unreachable.map((u) => `${u.chain.name} (${u.reason})`).join("; ");
    out.innerHTML = `<section class="found">
    <h2>No contract at this address on any chain BOUNCER could read</h2>
    <p class="qblurb">${asked ? `Asked and answered nothing: ${esc2(asked)}.` : ""} ${broke ? `<b>These never answered, so this address could still be on one of them:</b> ${esc2(broke)}. Try again, or pick the chain from the menu to read it directly.` : "An address with no code is a wallet, not a token \u2014 or the token has not been deployed yet."}</p>
    <p class="buy-gap"><span class="mono">${esc2(address)}</span></p>
  </section>`;
  }
  async function runDoor(address) {
    if (mode === "live" && chainSelect.value === "auto" && isSolanaAddress(address) && !ADDR.test(address)) {
      autoChain = CHAINS.solana;
      paintChain();
      return await runSolanaDoor(address);
    }
    if (chainOrNull()?.family === "solana" && mode === "live") return await runSolanaDoor(address);
    if (!ADDR.test(address)) {
      if (mode === "live" && /^[a-z0-9$ ._-]{2,32}$/i.test(address)) return await runSearch(address.replace(/^\$/, ""));
      return bad("Paste a 20-byte hex address \u2014 0x followed by 40 hex characters \u2014 or a token's name to search for it.");
    }
    if (mode === "live" && chainSelect.value === "auto" && !await resolveChain(address)) return;
    if (mode === "demo" && !isDemoAddress(address)) {
      setMode("live");
      showToast(`Real address: switched to live on ${chain().name}`);
      location.hash = `#/t/${address.toLowerCase()}?chain=${chain().key}`;
      return;
    }
    const run = ++doorRun;
    busy("reading the chain at the door\u2026");
    const options = mode === "demo" ? { chain: CHAINS.robinhood, factory: factoryFor(), blockscout: blockscoutFor(true), devHours: 8, chunkSize: 1e5, launchSearchBlocks: 4e5 } : { chain: chain(), factory: factoryFor(), blockscout: blockscoutFor(true), devHours: 24 };
    const rpc = rpcFor(true);
    if (options.blockscout) options.blockscout.prewarm(BlockscoutClient.doorPaths(address.toLowerCase()));
    let at;
    const RANK = { opening: 0, fast: 1, done: 2 };
    let drawn = null;
    const draw = (slip, stage) => {
      if (run !== doorRun) return false;
      if (drawn !== null && RANK[stage] <= RANK[drawn]) return true;
      if (drawn === null) renderSlip(slip, { stage });
      else keepPlace(() => renderSlip(slip, { stage }));
      drawn = stage;
      if (stage === "done") done(`block ${slip.at.block} \xB7 ${isoUtc(slip.at.timestamp)} \xB7 ${slip.notes.length} thing${slip.notes.length === 1 ? "" : "s"} to know`);
      else status.textContent = `${mode === "demo" ? "DEMO \xB7 " : `${chain().name} \xB7 `}block ${slip.at.block} \xB7 ${STILL_READING[stage]}\u2026`;
      return true;
    };
    try {
      at = await rpc.head();
    } catch (error) {
      return failed(error, address);
    }
    const SLOW_HALF_HEAD_START_MS = 250;
    const passes = [
      ["opening", readDoor(rpc, address, { ...options, ...OPENING_SECTIONS, at })],
      ["fast", readDoor(rpc, address, { ...options, ...SLOW_SECTIONS, at })],
      [
        "done",
        new Promise((resolve) => setTimeout(resolve, SLOW_HALF_HEAD_START_MS)).then(() => {
          if (run !== doorRun) throw new Error("superseded");
          return readDoor(rpc, address, { ...options, at });
        })
      ]
    ];
    for (const [, p] of passes) p.catch(() => {
    });
    let lastError = null;
    for (const [stage, pass] of passes) {
      try {
        const slip = await pass;
        if (!draw(slip, stage)) return;
      } catch (error) {
        lastError = error;
      }
    }
    if (run !== doorRun) return;
    if (drawn === null) failed(lastError, address);
    else if (drawn !== "done") {
      status.textContent = `${chain().name} \xB7 the slower sections did not answer: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
    }
    go.disabled = false;
  }
  async function runDev(address) {
    if (!ADDR.test(address)) return bad("Paste the deployer's address.");
    busy("reading the deployer's launches\u2026");
    try {
      const rpc = rpcFor();
      const head = await rpc.getBlock("latest");
      const fromBlock = mode === "demo" ? Math.max(0, head.number - 3e5) : await findBlockByTimestamp(rpc, head.timestamp - 24 * 3600, head.number);
      const d = await readDevReport(rpc, address, { fromBlock, toBlock: head.number, factory: factoryFor(), chunking: mode === "demo" ? { startChunk: 1e5, maxChunk: 1e5 } : void 0 });
      done(`block ${head.number} \xB7 last ${mode === "demo" ? "8" : "24"} h`);
      out.innerHTML = `<div class="slip">${devSection(d, null, true)}</div>`;
    } catch (error) {
      failed(error, address);
    } finally {
      go.disabled = false;
    }
  }
  async function runWallet(token, wallet) {
    if (!ADDR.test(token) || !ADDR.test(wallet)) return bad("Paste the token address and the wallet address.");
    busy("reading the wallet's trades\u2026");
    try {
      const rpc = rpcFor();
      const factory = factoryFor();
      const head = await rpc.blockNumber();
      const launch = await new PonsReader(rpc, factory).launchedToken(token, head);
      const launchBlock = await findLaunchBlock(rpc, launch.token, head, mode === "demo" ? 4e5 : Math.round(30 * 86400 * chain().blocksPerSecond), factory, mode === "demo" ? 1e5 : void 0);
      const p = await readPosition(rpc, launch, wallet, launchBlock ?? 0, head, factory, mode === "demo" ? 1e5 : void 0);
      done(`block ${head}`);
      renderPosition(p, head);
    } catch (error) {
      failed(error, token);
    } finally {
      go.disabled = false;
    }
  }
  async function runTx(hash) {
    if (!hash.startsWith("0x")) return bad("Paste a transaction hash.");
    busy("decoding the trade\u2026");
    try {
      const receipts = await readTradeReceipt(rpcFor(), hash, factoryFor());
      done(`block ${receipts[0].block}`);
      out.innerHTML = `<div class="slip">${receipts.map(receiptSection).join("")}</div>`;
    } catch (error) {
      failed(error, hash);
    } finally {
      go.disabled = false;
    }
  }
  async function runPlan(taxBps, params) {
    busy("reading the factory's terms\u2026");
    try {
      const rpc = rpcFor();
      const c = chain();
      const buy = params.get("buy");
      const plan = await readLaunchPlan(rpc, {
        factory: factoryFor(),
        block: await rpc.blockNumber(),
        nativeSymbol: c.native.symbol,
        creatorTaxBps: BigInt(taxBps),
        configId: Number(params.get("config") ?? 0),
        pairToken: params.get("quote") ?? void 0,
        sampleBuy: buy ? BigInt(Math.round(Number(buy) * 1e6)) * 10n ** 12n : void 0
      });
      done(`block ${plan.block} \xB7 config ${plan.configId}`);
      renderPlan(plan);
    } catch (error) {
      failed(error, "plan");
    } finally {
      go.disabled = false;
    }
  }
  async function runBoard(hours) {
    busy("reading the window\u2026");
    try {
      const rpc = rpcFor();
      const head = await rpc.getBlock("latest");
      const fromBlock = mode === "demo" ? Math.max(0, head.number - 3e5) : await findBlockByTimestamp(rpc, head.timestamp - hours * 3600, head.number);
      const b = await readBoard(rpc, { fromBlock, toBlock: head.number, factory: factoryFor(), top: 10, chunkSize: mode === "demo" ? 1e5 : void 0 });
      done(`blocks ${b.window.fromBlock}\u2013${b.window.toBlock} \xB7 ${b.chunks} log reads`);
      renderBoard(b, hours);
    } catch (error) {
      failed(error, "board");
    } finally {
      go.disabled = false;
    }
  }
  function renderBoard(b, hours) {
    const qd = chain().native;
    const amt = (v) => `${formatUnits(v, qd.decimals)} ${esc2(qd.symbol)}`;
    const link = (a) => `<a href="#/${mode === "demo" ? "demo" : "t"}/${a}${routeChain()}">${shortAddress(a)}</a>`;
    const dev = (a) => `<a href="#/dev/${a}${routeChain()}">${shortAddress(a)}</a>`;
    out.innerHTML = `<div class="slip">
    <div class="stamp-row"><div class="who"><div class="sym">THE BOARD</div><div class="name">${esc2(chain().name)} \xB7 last ${hours} h \xB7 blocks ${b.window.fromBlock}\u2013${b.window.toBlock}</div></div>
      <div class="stamp">${b.launches} LAUNCHES</div></div>
    <div class="grid">
      <section class="sec"><h2>Tonight</h2><div class="exit-grid">
        <div><span>launches</span><b class="num">${b.launches}</b></div>
        <div><span>graduations</span><b class="num">${b.graduations}</b></div>
        <div><span>deployers</span><b class="num">${b.deployers}</b></div>
        <div><span>cover collected</span><b class="num">${formatUnits(b.coverTotal, qd.decimals, 3)}</b><span>${esc2(qd.symbol)} \xB7 ${b.taxedBuys} buys</span></div>
      </div><p style="margin:0;color:var(--dim);font-size:12px">Cover charge = the part of a buy's tax above the curve's own creator rate, as the curve's CurveBuy event reports it. Counts, not scores.</p></section>
      <section class="sec"><h2>Deployers</h2>${b.topDeployers.length ? `<div class="tbl"><table class="buys"><thead><tr><th>deployer</th><th>launched</th><th>graduated</th><th>swept, no pool</th></tr></thead><tbody>${b.topDeployers.map((r) => `<tr><td>${dev(r.deployer)}</td><td>${r.launched}</td><td>${r.graduated}</td><td>${Math.max(0, r.swept - r.graduated)}</td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--muted);margin:0">No launches in the window.</p>`}
        ${b.serial.length ? `<h2 style="margin-top:14px">Serial, no graduation</h2><div class="tbl"><table class="buys"><tbody>${b.serial.map((r) => `<tr><td>${dev(r.deployer)}</td><td>${r.launched} launched, none graduated</td></tr>`).join("")}</tbody></table></div>` : ""}</section>
      <section class="sec"><h2>Cover charge by curve</h2>${b.topCurves.length ? `<div class="tbl"><table class="buys"><thead><tr><th>token</th><th>collected</th><th>buys</th><th>highest</th><th>creator tax</th></tr></thead><tbody>${b.topCurves.map((r) => `<tr><td>${link(r.token ?? r.curve)}</td><td>${amt(r.coverCollected)}</td><td>${r.taxedBuys}</td><td>${(r.highestBps / 100).toFixed(1)}%</td><td>${formatBps(r.creatorTaxBps)}</td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--muted);margin:0">No buy in the window paid above the creator rate.</p>`}</section>
      <section class="sec"><h2>Cover charge by wallet</h2>${b.topPayers.length ? `<div class="tbl"><table class="buys"><thead><tr><th>wallet</th><th>paid at the door</th><th>buys</th></tr></thead><tbody>${b.topPayers.map((r) => `<tr><td>${shortAddress(r.wallet)}</td><td>${amt(r.coverPaid)}</td><td>${r.buys}</td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--muted);margin:0">Nobody paid at the door in the window.</p>`}</section>
    </div></div>`;
  }
  function stopWatch() {
    if (watcher) {
      clearInterval(watcher);
      watcher = null;
    }
  }
  function startWatch(slip, panel, button) {
    const launch = slip.id.launch;
    const crew = slip.crew?.crews.flatMap((c) => c.wallets) ?? [];
    const list = panel.querySelector(".events");
    let cursor = mode === "demo" ? Math.max(0, slip.at.block - 3e5) : slip.at.block + 1;
    let rounds = 0;
    const add = (html, quiet = false) => {
      const el = document.createElement("div");
      el.className = `event${quiet ? " quiet" : ""}`;
      el.innerHTML = html;
      list.prepend(el);
      while (list.children.length > 40) list.lastElementChild?.remove();
    };
    const tick = async () => {
      try {
        const rpc = rpcFor();
        const head = await rpc.blockNumber();
        if (head < cursor) return;
        const events = await readWatchEvents(rpc, launch, { fromBlock: cursor, toBlock: head, crew, factory: factoryFor(), quote: slip.rules?.quote ?? chain().native, chunkSize: mode === "demo" ? 1e5 : void 0 });
        cursor = head + 1;
        rounds++;
        for (const e of events) {
          add(`<span class="b">${e.block}</span><span class="k">${esc2(e.kind)}</span><span>${esc2(e.text)}</span>`);
          try {
            if (Notification.permission === "granted") new Notification(`BOUNCER \xB7 ${slip.id.meta?.symbol ?? "watch"}`, { body: `${e.kind}: ${e.text}` });
          } catch {
          }
        }
        if (!events.length && rounds % 4 === 1) add(`<span class="b">${head}</span><span class="k" style="color:var(--dim)">quiet</span><span>no moves up to block ${head}</span>`, true);
      } catch (error) {
        add(`<span class="b">\xB7</span><span class="k" style="color:var(--stop)">error</span><span>${esc2(error instanceof Error ? error.message : String(error))}</span>`);
      }
    };
    button.setAttribute("aria-pressed", "true");
    button.textContent = "Watching \xB7 click to stop";
    try {
      if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
    } catch {
    }
    void tick();
    watcher = window.setInterval(() => void tick(), mode === "demo" ? 5e3 : 15e3);
  }
  function bad(text) {
    out.innerHTML = `<div class="error"><strong>That is not what this tab needs.</strong><p>${esc2(text)}</p></div>`;
  }
  function summarySentence(slip) {
    if (slip.id.v1) {
      const v = slip.id.v1;
      const parts2 = ["Real Pons V1 launch: fixed supply, trading in a Uniswap V3 pool since block one, liquidity locked"];
      if (v.restrictionBlocksLeft > 0 && v.config) parts2.push(`launch caps are on for ${v.restrictionBlocksLeft} more blocks (max ${formatBps(v.config.maxWalletBps)} per wallet)`);
      parts2.push(v.status.graduated ? "graduated" : `${formatUnits(v.status.pairedPrincipal, v.quote.decimals)} of ${formatUnits(v.status.threshold, v.quote.decimals)} ${v.quote.symbol} towards graduation`);
      return parts2.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(". ") + ".";
    }
    if (!slip.id.registered) return openDoorSentence(slip);
    const parts = [`Real ${slip.chain.launchpad ?? "launchpad"} launch`];
    const c = slip.cover;
    if (c?.status === "open") parts.push(`the door tax is still on for ${c.secondsLeft} s (up to ${formatBps(c.terms.startBps)} of a buy goes to the creator)`);
    else if (c?.status === "closed") parts.push("the door tax has ended");
    if (slip.rules) parts.push(`every trade pays ${formatBps(slip.rules.totalTradeBps)} in fees`);
    if (slip.room && slip.room.buys > 0) parts.push(`the creator funded ${(slip.room.devShareBps / 100).toFixed(0)}% of what was bought`);
    if (slip.crew?.crews.length) parts.push(`${slip.crew.crews[0].wallets.length} early buyers share a funder`);
    if (slip.dev) parts.push(slip.dev.counts.launched <= 1 ? "first launch from this dev" : `this dev launched ${slip.dev.counts.launched} tokens, ${slip.dev.counts.graduated} graduated`);
    if (slip.rules?.phase === 2 || slip.rules?.phase === 3) parts.push("graduated, pool locked");
    return parts.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(". ") + ".";
  }
  function verdictOf(notes, stage = "done") {
    if (stage === "opening") return { word: "READING", kind: "reading", line: "What the code can do and who holds the keys is below. The rest is still being read; there is no verdict until it is in." };
    const stop = notes.filter((n) => n.level === "stop").length;
    const watch = notes.filter((n) => n.level === "watch").length;
    if (stop) return { word: "STOP", kind: "stop", line: `${stop} thing${stop === 1 ? "" : "s"} here can cost you money outright.` };
    if (watch) return { word: "WATCH", kind: "watch", line: `Nothing outright dangerous, ${watch} thing${watch === 1 ? "" : "s"} worth reading before you buy.` };
    return { word: "CLEAR", kind: "clear", line: "Nothing in what was read stands out. That is not a promise about the price." };
  }
  var SOL_STILL_READING = "still reading who holds it and where it trades";
  var STILL_READING = {
    opening: "still reading where it trades, who holds it, and whether a sale goes through",
    fast: "still reading who holds the liquidity and the dev history",
    done: ""
  };
  function verdictBlock(opts) {
    const stage = opts.stage ?? "done";
    const v = verdictOf(opts.notes, stage);
    const counts = ["stop", "watch", "info"].map((level) => ({ level, n: opts.notes.filter((x) => x.level === level).length })).filter((x) => x.n > 0).map((x) => `<span class="tally lv-${x.level}"><i></i>${x.n} ${LEVEL_WORD[x.level].toLowerCase()}</span>`).join("");
    const stampClass = opts.stamp === "ON THE LIST" ? "yes" : opts.stamp === "NOT A LAUNCH" ? "mid" : "no";
    return `<section class="verdict v-${v.kind}">
    <div class="vhead">
      <div class="vwho">
        <span class="vsym">${opts.sym}</span>
        <span class="vname">${opts.name}</span>
        <span class="vstamp ${stampClass}">${opts.stamp}</span>
      </div>
      <button class="vaddr" type="button" data-copy="${esc2(opts.address)}" title="Copy the address">${esc2(opts.address)}</button>
    </div>
    <div class="vbody">
      <div class="vword" aria-label="Verdict">${v.word}</div>
      <div class="vsay">
        <p class="vlead">${esc2(opts.lead)}</p>
        <p class="vsub">${esc2(v.line)}</p>
      </div>
    </div>
    ${opts.tiles ?? ""}
    <div class="vfoot">
      <div class="tallies">${counts || '<span class="tally lv-info"><i></i>nothing to flag</span>'}${stage === "done" ? "" : `<span class="tally pendingchip"><i></i>${esc2(opts.stillReading ?? STILL_READING[stage])}</span>`}</div>
      <div class="vat">${opts.at}</div>
      <div class="vacts">${opts.actions}</div>
    </div>
  </section>`;
  }
  function answerCards(notes) {
    const cards = TOPIC_ORDER.filter((t) => t !== "unread").map((topic) => {
      const mine = notes.filter((n) => topicOf(n.code) === topic);
      if (!mine.length) return "";
      const worst = mine.some((n) => n.level === "stop") ? "stop" : mine.some((n) => n.level === "watch") ? "watch" : "info";
      const rows = mine.map((n) => `<li class="ans lv-${n.level}"><span class="dot" aria-hidden="true"></span><span>${esc2(n.text)}</span></li>`).join("");
      return `<article class="qcard lv-${worst}">
        <h2>${esc2(TOPIC_QUESTION[topic])}</h2>
        <p class="qblurb">${esc2(TOPIC_BLURB[topic])}</p>
        <ul class="answers">${rows}</ul>
      </article>`;
    }).join("");
    return cards ? `<div class="qgrid">${cards}</div>` : "";
  }
  function unreadStrip(notes, skipped) {
    const mine = notes.filter((n) => topicOf(n.code) === "unread");
    if (!mine.length) return "";
    void skipped;
    const rows = mine.map((n) => `<li>${esc2(n.text)}</li>`).join("");
    return `<section class="unread">
    <h2>${esc2(TOPIC_QUESTION.unread)}</h2>
    <p class="qblurb">${esc2(TOPIC_BLURB.unread)}</p>
    <ul>${rows}</ul>
  </section>`;
  }
  function buyStrip(chainKey, address, sellable = true, verdict = "clear") {
    if (!sellable) {
      return `<section class="buy">
      <div class="buy-head"><h2>Buy it</h2></div>
      <p class="qblurb">No links here. BOUNCER could not establish that this address is a token you can hold or sell, and sending you to a venue to buy it anyway would be the one piece of advice on this page that is not read off the chain.</p>
    </section>`;
    }
    const venues = tradeVenues(chainKey, address);
    if (!venues.length) return "";
    const links = venues.map(
      (v) => `<a class="buy-link" href="${esc2(v.url)}" target="_blank" rel="noopener nofollow sponsored">
          <span class="buy-name">${esc2(v.name)}</span>
          <span class="buy-what">${esc2(v.what)}</span>
          <span class="buy-go" aria-hidden="true">\u2197</span>
        </a>`
    ).join("");
    const missing = missingVenues(chainKey);
    const gap = missing.length ? `<p class="buy-gap">${esc2(missing.join(" and "))} ${missing.length === 1 ? "is" : "are"} not linked on this chain: BOUNCER has no confirmed address for ${missing.length === 1 ? "it" : "them"} here, and a guessed link is a dead one.</p>` : "";
    const head = verdict === "stop" ? "Buy it anyway?" : "Buy it";
    const lead = verdict === "stop" ? "The slip above says STOP: something here can cost you money outright. The links are not hidden \u2014 this page does not decide for anybody \u2014 but read the red lines first, because nothing on the other side of them will." : verdict === "watch" ? "The slip above has things worth reading first. These open the token on someone else's venue; BOUNCER cannot trade and holds no key." : "BOUNCER cannot trade and holds no key. These open the token on someone else's venue. Read the slip above first; nothing here changes what it says.";
    return `<section class="buy${verdict === "stop" ? " buy-stop" : ""}">
    <div class="buy-head"><h2>${head}</h2></div>
    <p class="qblurb">${lead}</p>
    <div class="buy-links">${links}</div>
    ${gap}
  </section>`;
  }
  function section(id, title, what, body, open) {
    return `<details class="sec" id="${id}"${open ? " open" : ""}><summary><h2>${title}</h2><span class="what">${what}</span><span class="chev">\u25B6</span></summary><div class="body">${body}</div></details>`;
  }
  async function runSolanaDoor(address) {
    if (!isSolanaAddress(address)) return bad("Paste a Solana mint address: 32 bytes written in base58, which looks like EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.");
    const run = ++doorRun;
    busy("reading the mint account\u2026");
    const rpc = solanaRpcFor(true);
    let opened = false;
    try {
      const first = await readSplDoor(rpc, address, chain(), { skipHolders: true, skipMarket: true });
      if (run !== doorRun) return;
      renderSplSlip(first, { stage: "opening" });
      opened = true;
      status.textContent = `${chain().name} \xB7 slot ${first.at.slot} \xB7 ${SOL_STILL_READING}\u2026`;
    } catch {
    }
    try {
      const slip = await readSplDoor(rpc, address, chain());
      if (run !== doorRun) return;
      if (opened) keepPlace(() => renderSplSlip(slip));
      else renderSplSlip(slip);
      done(`slot ${slip.at.slot}${slip.at.timestamp ? ` \xB7 ${isoUtc(slip.at.timestamp)}` : ""} \xB7 ${slip.notes.length} thing${slip.notes.length === 1 ? "" : "s"} to know`);
    } catch (error) {
      if (run !== doorRun) return;
      if (opened) {
        go.disabled = false;
        status.textContent = `${chain().name} \xB7 the slower sections did not answer: ${error instanceof Error ? error.message : String(error)}`;
      } else {
        failed(error, address);
      }
    } finally {
      go.disabled = false;
    }
  }
  function renderSplSlip(slip, opts = {}) {
    noteRender(opts.stage ?? "done", verdictOf(slip.notes, opts.stage ?? "done").word);
    const m = slip.mint;
    const sym = slip.metadata?.symbol ? esc2(slip.metadata.symbol) : shortSol(slip.subject);
    const name = slip.metadata?.name ? esc2(slip.metadata.name) : slip.whatItIs ? esc2(slip.whatItIs) : "no on-chain name";
    const ext = (kind) => m?.extensions.find((e) => e.kind === kind);
    const fee = ext("transfer-fee");
    const frozenByDefault = ext("default-account-state");
    const blocked = Boolean(m?.freezeAuthority) || Boolean(ext("non-transferable")) || frozenByDefault?.kind === "default-account-state" && frozenByDefault.frozen;
    const tiles = m ? `<div class="tiles">
        <div class="tile"><div class="l">Can they freeze you?</div><div class="v ${m.freezeAuthority ? "bad" : ""}">${m.freezeAuthority ? "YES" : "NO"}</div><div class="s">${m.freezeAuthority ? `${esc2(shortSol(m.freezeAuthority))} can stop any holder selling` : "the freeze authority is not set and cannot come back"}</div></div>
        <div class="tile"><div class="l">Can they print more?</div><div class="v ${m.mintAuthority ? "bad" : ""}">${m.mintAuthority ? "YES" : "NO"}</div><div class="s">${m.mintAuthority ? `${esc2(shortSol(m.mintAuthority))} holds the mint authority` : "the supply is fixed for good"}</div></div>
        <div class="tile"><div class="l">Tax per transfer</div><div class="v ${fee?.kind === "transfer-fee" && fee.feeBps >= 500 ? "bad" : ""}">${fee?.kind === "transfer-fee" ? `${(fee.feeBps / 100).toFixed(2)}%` : "0%"}</div><div class="s">${fee?.kind === "transfer-fee" ? fee.nextFeeBps !== fee.feeBps ? `changing to ${(fee.nextFeeBps / 100).toFixed(2)}% at epoch ${fee.nextFeeEpoch}` : fee.feeAuthority ? "and it can still be changed" : "fixed for good" : "no Token-2022 transfer fee"}</div></div>
        <div class="tile"><div class="l">Top 10 holders</div><div class="v ${slip.holders && slip.holders.top10Bps !== null && slip.holders.top10Bps >= 5e3 ? "bad" : ""}">${slip.holders && slip.holders.top10Bps !== null ? `${(slip.holders.top10Bps / 100).toFixed(0)}%` : "\u2014"}</div><div class="s">${slip.holders?.distinctOwners ? `of supply \xB7 ${slip.holders.distinctOwners} distinct wallets` : "not read"}</div></div>
      </div>` : "";
    const explorer = chain().explorerUrl;
    const link = (addr) => explorer ? `<a href="${esc2(explorer)}/account/${esc2(addr)}" target="_blank" rel="noopener"><span class="mono">${esc2(shortSol(addr))}</span></a>` : `<span class="mono">${esc2(shortSol(addr))}</span>`;
    const idBody = m ? `<dl class="kv">
        <dt>chain</dt><dd>${esc2(slip.chain.name)} \xB7 no launchpad known here, so this is the ordinary-token check</dd>
        <dt>program</dt><dd>${m.token2022 ? "Token-2022, which is where fees, hooks and delegates live" : "SPL Token, the classic program with no extensions"}</dd>
        <dt>supply</dt><dd>${esc2(formatSupply(m.supply, m.decimals))} \xB7 ${m.decimals} decimals</dd>
        <dt>mint authority</dt><dd>${m.mintAuthority ? `${link(m.mintAuthority)} <span class="flag bad">can print more</span>` : '<span class="flag ok">none</span> the supply is fixed'}</dd>
        <dt>freeze authority</dt><dd>${m.freezeAuthority ? `${link(m.freezeAuthority)} <span class="flag bad">can stop a holder selling</span>` : '<span class="flag ok">none</span> holders cannot be frozen'}</dd>
        ${slip.metadata ? `<dt>name</dt><dd>${esc2(slip.metadata.name)} (${esc2(slip.metadata.symbol)}) \xB7 ${slip.metadata.isMutable ? '<span class="flag bad">can be renamed</span>' : '<span class="flag ok">frozen</span>'} \xB7 ${slip.metadataInline ? "from the Token-2022 extension" : "from Metaplex"}</dd>` : ""}
      </dl>` : `<dl class="kv"><dt>what it is</dt><dd>${esc2(slip.whatItIs ?? "not an SPL mint")}</dd></dl>`;
    const extBody = m && m.extensions.length ? `<div class="tbl"><table class="buys"><thead><tr><th>extension</th><th>what it means for a holder</th></tr></thead><tbody>${m.extensions.map((e) => `<tr><td><span class="mono">${esc2(e.kind)}</span></td><td>${esc2(SPL_EXTENSION_MEANING[e.kind] ?? "not read here")}</td></tr>`).join("")}</tbody></table></div>` : "";
    const holdersBodyText = slip.holders && slip.holders.top.length ? `<dl class="kv"><dt>distinct wallets</dt><dd>${slip.holders.distinctOwners ?? "unknown"} among the ${slip.holders.top.length} largest accounts</dd>
        <dt>top 10</dt><dd>${slip.holders.top10Bps === null ? "unknown" : `${(slip.holders.top10Bps / 100).toFixed(1)}% of supply`}</dd></dl>
      <div class="tbl"><table class="buys"><thead><tr><th>#</th><th>wallet</th><th>share</th></tr></thead><tbody>${slip.holders.top.slice(0, 15).map((h, i) => `<tr><td>${i + 1}</td><td>${h.owner ? link(h.owner) : `${link(h.account)} <span class="flag">account</span>`}</td><td>${h.bps === null ? "unknown" : `${(h.bps / 100).toFixed(2)}%`}</td></tr>`).join("")}</tbody></table></div>` : "";
    out.innerHTML = `<div class="slip">
    ${verdictBlock({
      sym,
      name,
      address: slip.subject,
      stamp: slip.stamp,
      at: `${esc2(slip.chain.name)} \xB7 slot ${slip.at.slot}${slip.at.timestamp ? ` \xB7 ${isoUtc(slip.at.timestamp)}` : ""}`,
      notes: slip.notes,
      lead: splSentence(slip, blocked),
      stage: opts.stage ?? "done",
      tiles,
      stillReading: SOL_STILL_READING,
      actions: `<button class="ghost primary" id="act-share" type="button">Copy card</button><button class="ghost" id="act-link" type="button">Copy link</button><button class="ghost" id="act-json" type="button">JSON</button>`
    })}
    ${answerCards(slip.notes)}
    ${unreadStrip(slip.notes, slip.skipped)}
    ${buyStrip(slip.chain.key, slip.subject, Boolean(slip.mint), verdictOf(slip.notes).kind)}
    <div class="stack">
      ${section("s-id", "Is it real?", "What this address actually is, who can print more of it, and who can freeze what you hold.", idBody, false)}
      ${extBody ? section("s-ext", "Token-2022 extensions", "The rules the token program itself enforces on every transfer.", extBody, false) : ""}
      ${holdersBodyText ? section("s-holders", "Who holds it", "The largest token accounts and the wallets behind them.", holdersBodyText, false) : ""}
    </div>
  </div>`;
    $("act-json").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(slipJson(slip));
        showToast("JSON copied");
      } catch {
        showToast("Clipboard blocked; use the CLI --format json");
      }
    });
    $("act-link").addEventListener("click", async () => {
      const url = `${location.origin}${location.pathname}#/t/${slip.subject}?chain=${chain().key}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast("Link copied");
      } catch {
        showToast(url);
      }
    });
  }
  var SPL_EXTENSION_MEANING = {
    "transfer-fee": "every transfer pays a percentage to the token, and someone may be able to raise it",
    "permanent-delegate": "one address can move or burn your tokens without your signature",
    "transfer-hook": "someone's program runs on every transfer and can make it fail",
    "mint-close-authority": "the mint account can be closed once the supply is zero",
    "default-account-state": "new holders may start frozen, unable to sell until unfrozen",
    "non-transferable": "the token cannot be sent to anyone at all",
    pausable: "every transfer can be paused",
    "interest-bearing": "the displayed balance grows by rule; the real amount does not",
    "metadata-pointer": "where the name and symbol live",
    "token-metadata": "the name and symbol, stored on the mint itself"
  };
  function splSentence(slip, blocked) {
    const m = slip.mint;
    if (!m) return `This address is not a token: it is ${slip.whatItIs ?? "not an SPL mint"}.`;
    const parts = [];
    if (m.freezeAuthority) parts.push("somebody can freeze your account, which is how a holder is stopped from selling");
    else parts.push("nobody can freeze your account");
    parts.push(m.mintAuthority ? "somebody can print more" : "the supply is fixed");
    const fee = m.extensions.find((e) => e.kind === "transfer-fee");
    if (fee?.kind === "transfer-fee") parts.push(`every transfer pays ${(fee.feeBps / 100).toFixed(2)}%${fee.nextFeeBps !== fee.feeBps ? `, rising to ${(fee.nextFeeBps / 100).toFixed(2)}%` : ""}`);
    if (m.extensions.some((e) => e.kind === "permanent-delegate")) parts.push("a permanent delegate can take your tokens");
    if (m.extensions.some((e) => e.kind === "transfer-hook")) parts.push("someone's program runs on every transfer");
    if (blocked && !m.freezeAuthority) parts.push("transfers are blocked by the token's own rules");
    if (slip.holders?.top10Bps != null) parts.push(`the 10 largest wallets hold ${(slip.holders.top10Bps / 100).toFixed(0)}%`);
    return parts.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(". ") + ".";
  }
  function shortSol(address) {
    return address.length > 12 ? `${address.slice(0, 4)}\u2026${address.slice(-4)}` : address;
  }
  function formatSupply(value, decimals) {
    const whole = value / 10n ** BigInt(decimals);
    return whole.toLocaleString("en-US");
  }
  function openDoorSentence(slip) {
    const t = slip.id.token;
    if (t.code.empty) return `There is no contract at this address on ${slip.chain.name}.`;
    if (t.code.delegatedTo) return `This is a wallet, not a token: its code is an EIP-7702 delegation its owner signed.`;
    const parts = [];
    const impostor = impostorOf(slip);
    if (impostor) parts.push(`an older ${slip.chain.launchpad ?? "launchpad"} launch is called ${slip.lookalikes.query} and this is not it`);
    if (slip.known) parts.push(`this is ${slip.known.replace(/\.$/, "")}`);
    else parts.push(slip.chain.launchpad ? `not a ${slip.chain.launchpad} launch, checked as an ordinary token` : `checked as an ordinary token: no launchpad BOUNCER knows runs on ${slip.chain.name}`);
    if (t.proxyImplementation || t.code.minimalProxyTarget) parts.push("its code can be replaced (proxy)");
    if (t.code.opcodes.selfdestruct) parts.push("it can self-destruct");
    const o = slip.open;
    if (o) {
      if (o.surfaceFrom === "implementation-unreadable") {
        parts.push("the code it actually runs could not be read, so what it can do is unknown");
        return sentence(parts);
      }
      const kinds = powerKinds(o).filter((k) => k !== "exempt" && k !== "sweep");
      if (o.paused === true) parts.push("paused() is true");
      if (o.tradingOpen && !o.tradingOpen.open) parts.push("its trading switch is off");
      if (kinds.length) parts.push(`the code carries ${kinds.join(", ")}${o.owner && !o.owner.renounced ? " and ownership is not renounced" : o.owner?.renounced ? " but ownership is renounced" : ""}`);
      else if (o.owner?.renounced) parts.push("ownership renounced, no special powers seen");
      else if (o.owner) parts.push("has an owner but no mint, pause, blacklist or fee switch was seen");
      const sell = sellProbes(o);
      const move = moveProbes(o);
      const verdict = (ps, yes, no, some) => {
        const reverted = ps.filter((p) => p.status === "reverts").length;
        const ok = ps.filter((p) => p.status === "ok").length;
        if (!ok && !reverted) return null;
        if (reverted && !ok) return no;
        if (reverted) return some;
        return yes;
      };
      const sellSays = verdict(sell, "a 1-unit sale into the pool goes through", "a 1-unit sale into the pool reverts", "some wallets cannot send into the pool");
      if (sellSays) parts.push(sellSays);
      else {
        const moveSays = verdict(move, "a 1-unit transfer to a fresh wallet goes through", "a 1-unit transfer reverts", "some wallets cannot transfer");
        if (moveSays) parts.push(moveSays);
      }
      if (o.holders?.top10WalletsBps != null) parts.push(`the 10 largest wallets hold ${(o.holders.top10WalletsBps / 100).toFixed(0)}%`);
      if (o.deployer?.createdAt) parts.push(`deployed ${formatDuration(Math.max(0, slip.at.timestamp - o.deployer.createdAt))} ago`);
    }
    return sentence(parts);
  }
  var LEAD_CLAUSES = 3;
  function sentence(parts) {
    const kept = parts.slice(0, LEAD_CLAUSES);
    return kept.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(". ") + ".";
  }
  function keepPlace(render) {
    const open = [...document.querySelectorAll("details.sec[open]")].map((d) => d.id).filter(Boolean);
    const y = window.scrollY;
    render();
    for (const id of open) document.getElementById(id)?.setAttribute("open", "");
    if (y) window.scrollTo({ top: y, behavior: "auto" });
  }
  function shareBase() {
    return `${location.host}${location.pathname}`.replace(/\/$/, "");
  }
  async function copyCardImage(svg, filename) {
    const scale = 2;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const png = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = 1200 * scale;
          canvas.height = 630 * scale;
          const ctx = canvas.getContext("2d");
          if (!ctx) return reject(new Error("no 2d context"));
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((out2) => out2 ? resolve(out2) : reject(new Error("canvas produced nothing")), "image/png");
        };
        img.onerror = () => reject(new Error("the card did not render"));
        img.src = url;
      });
      const Item = window.ClipboardItem;
      if (Item && navigator.clipboard && "write" in navigator.clipboard) {
        await navigator.clipboard.write([new Item({ "image/png": png })]);
        return "copied";
      }
      download(png, filename);
      return "downloaded";
    } catch {
      download(blob, filename.replace(/\.png$/, ".svg"));
      return "downloaded";
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  {
    const inner = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const log = window.__bouncerWire ??= [];
      const url = String(input instanceof Request ? input.url : input);
      const started = performance.now();
      const entry = { url, at: Math.round(started), ms: 0, ok: false, done: false };
      if (log.length < 400) log.push(entry);
      try {
        const response = await inner(input, init);
        entry.ms = Math.round(performance.now() - started);
        entry.ok = response.ok;
        entry.done = true;
        return response;
      } catch (error) {
        entry.ms = Math.round(performance.now() - started);
        entry.done = true;
        throw error;
      }
    };
  }
  function noteRender(stage, word) {
    const log = window.__bouncerRenders ??= [];
    if (log.length < 200) log.push({ stage, at: Math.round(performance.now()), word });
  }
  function renderSlip(slip, opts = {}) {
    noteRender(opts.stage ?? "done", verdictOf(slip.notes, opts.stage ?? "done").word);
    const meta = slip.id.meta;
    const c0 = chain();
    const explorer = c0.blockscout ? `${c0.blockscout}/address/${slip.subject}` : null;
    const sym = meta ? esc2(meta.symbol) : shortAddress(slip.subject);
    const name = meta ? esc2(meta.name) : slip.known ? "known contract, not a launch" : slip.id.token.code.empty ? "no contract at this address" : "contract without a name";
    const o = slip.open;
    const tradesText = o ? tradesBody(slip) : "";
    const qd = slip.rules?.quote ?? slip.chain.native;
    const amt = (v) => `${formatUnits(v, qd.decimals)} ${esc2(qd.symbol)}`;
    const c = slip.cover;
    const r = slip.rules;
    const room = slip.room;
    const e = slip.exit;
    const crew = slip.crew;
    const l = slip.lookalikes;
    const d = slip.dev;
    const t = slip.id.token;
    const registered = slip.id.registered;
    const v1 = slip.id.v1;
    const tiles = v1 ? `<div class="tiles">
        <div class="tile"><div class="l">Launch caps</div><div class="v ${v1.restrictionBlocksLeft > 0 ? "open" : "closed"}">${v1.restrictionBlocksLeft > 0 ? `${v1.restrictionBlocksLeft}` : "OFF"}</div><div class="s">${v1.restrictionBlocksLeft > 0 ? `blocks left \xB7 max ${v1.config ? formatBps(v1.config.maxWalletBps) : "?"} per wallet` : "wallet and trade caps lifted"}</div></div>
        <div class="tile"><div class="l">Pool fee</div><div class="v">${Number(v1.record.poolFee) / 1e4}%</div><div class="s">Uniswap V3 \xB7 position #${v1.record.positionId} locked</div></div>
        <div class="tile"><div class="l">Towards graduation</div><div class="v">${v1.status.threshold === 0n ? "\u2014" : `${Number(v1.status.pairedPrincipal * 100n / v1.status.threshold)}%`}</div><div class="s">${formatUnits(v1.status.pairedPrincipal, v1.quote.decimals)} of ${formatUnits(v1.status.threshold, v1.quote.decimals)} ${esc2(v1.quote.symbol)}${v1.status.graduated ? " \xB7 graduated" : ""}</div></div>
        <div class="tile"><div class="l">Dev bought at launch</div><div class="v">${formatUnits(v1.record.initialBuyAmount, v1.quote.decimals, 3)}</div><div class="s">${esc2(v1.quote.symbol)} in the launch transaction</div></div>
      </div>` : registered ? `<div class="tiles">
        <div class="tile"><div class="l">Door tax</div><div class="v ${c?.status === "open" ? "open" : "closed"}" id="cd">${c ? c.status === "open" ? `${c.secondsLeft}s` : c.status === "closed" ? "OFF" : "OFF" : "OFF"}</div><div class="s" id="cd-note">${c ? c.status === "open" ? `left, then it is safe to buy` : c.status === "closed" ? `ended ${formatDuration(Math.max(0, c.head.timestamp - c.windowEndsAt))} ago` : "disabled for this launch" : "ended long ago"}</div></div>
        <div class="tile"><div class="l">Fee per trade</div><div class="v ${r && r.totalTradeBps >= 1000n ? "bad" : ""}">${r ? formatBps(r.totalTradeBps) : "\u2014"}</div><div class="s">${r ? `${formatBps(r.creatorTaxBps)} of it to the creator` : ""}</div></div>
        <div class="tile"><div class="l">${room && room.buys > 0 ? "Creator funded" : "Curve full"}</div><div class="v ${room && room.devShareBps >= 5e3 ? "bad" : ""}">${room && room.buys > 0 ? `${(room.devShareBps / 100).toFixed(0)}%` : r?.fill ? `${(r.fill.bps / 100).toFixed(0)}%` : "\u2014"}</div><div class="s">${room && room.buys > 0 ? `of all buys \xB7 ${room.buyers} buyers` : r?.fill ? "of the way to graduation" : ""}</div></div>
        <div class="tile"><div class="l">This dev before</div><div class="v ${d && d.counts.launched >= 5 && d.counts.graduated === 0 ? "bad" : ""}">${d ? `${d.counts.launched}` : "\u2014"}</div><div class="s">${d ? `launch${d.counts.launched === 1 ? "" : "es"} in ${mode === "demo" ? "8" : "24"} h \xB7 ${d.counts.graduated} graduated` : ""}</div></div>
      </div>` : o ? openDoorTiles(slip) : "";
    const idFlags = (x) => {
      const f = [];
      if (x.proxyImplementation) f.push(`<span class="flag bad">upgradeable proxy \u2192 ${shortAddress(x.proxyImplementation)}</span>`);
      if (x.code.minimalProxyTarget) f.push(`<span class="flag bad">minimal proxy</span>`);
      if (x.code.opcodes.selfdestruct) f.push(`<span class="flag bad">can self-destruct \xD7${x.code.opcodes.selfdestruct}</span>`);
      if (x.code.opcodes.delegatecall) f.push(`<span class="flag bad">DELEGATECALL \xD7${x.code.opcodes.delegatecall}</span>`);
      if (x.code.opcodes.callcode) f.push(`<span class="flag bad">CALLCODE</span>`);
      if (x.code.opcodes.create || x.code.opcodes.create2) f.push(`<span class="flag">deploys contracts</span>`);
      if (!f.length && !x.code.empty) f.push(`<span class="flag ok">fixed code \xB7 no proxy \xB7 cannot self-destruct</span>`);
      return f.join("");
    };
    const idBody = `<dl class="kv">
    <dt>chain</dt><dd>${esc2(slip.chain.name)}${slip.chain.launchpad ? ` \xB7 ${esc2(slip.chain.launchpad)}` : ""}</dd>
    <dt>factory record</dt><dd>${registered ? `<span class="flag ok">yes</span> ${v1 ? "the Pons V1 factory" : "the launchpad's own factory"} deployed this token${slip.id.resolvedAs === "curve" ? " (you pasted its curve)" : ""}` : `<span class="flag ${o ? "" : "bad"}">none</span> ${slip.chain.launchpad ? `neither the ${esc2(slip.chain.launchpad)} factory${slip.chain.key === "robinhood" ? " nor the Pons V1 factory" : ""} deployed this address` : `no launchpad BOUNCER knows runs on ${esc2(slip.chain.name)}`}${o ? "; checked as an ordinary token below" : ""}`}</dd>
    <dt>token code</dt><dd>${t.code.empty ? "empty (no contract)" : `${t.code.bytes} bytes`}<br>${idFlags(t)}</dd>
    ${slip.id.curve ? `<dt>curve code</dt><dd>${slip.id.curve.code.bytes} bytes<br>${idFlags(slip.id.curve)}</dd>` : ""}
    ${v1 ? `<dt>launchpad</dt><dd>Pons V1</dd><dt>deployer</dt><dd><span class="mono">${esc2(v1.record.deployer.toLowerCase())}</span></dd>` : ""}
    ${slip.id.launch ? `<dt>deployer</dt><dd><a href="#/dev/${slip.id.launch.deployer.toLowerCase()}${routeChain()}"><span class="mono">${esc2(slip.id.launch.deployer.toLowerCase())}</span></a> <small style="color:var(--dim)">click for their history</small></dd><dt>stage</dt><dd>${{ curve: "on the bonding curve", swept: "curve closed, pool not created yet", pool: "graduated: trades in the locked Uniswap pool", rescued: "graduated (rescued)" }[PHASE_LABEL[slip.id.launch.phase]] ?? PHASE_LABEL[slip.id.launch.phase]}</dd>` : ""}
    ${explorer ? `<dt>explorer</dt><dd><a href="${explorer}" target="_blank" rel="noopener">${mode === "demo" ? "open in Blockscout (demo address, will be empty)" : "open in Blockscout"}</a></dd>` : ""}
  </dl>`;
    let coverBody = "";
    if (c) {
      const buys = c.observed.map((b) => `<tr class="${b.creatorWallet ? "exempt" : ""}"><td>${b.secondsAfterLaunch.toFixed(1)} s</td><td>${shortAddress(b.buyer)}${b.creatorWallet ? ' <span class="flag">creator \xB7 exempt</span>' : ""}</td><td>${amt(b.quoteIn)}</td><td>${(b.chargeBps / 100).toFixed(1)}%</td></tr>`).join("");
      coverBody = `${c.status === "open" ? `<div class="bar"><i id="cd-bar" style="width:${Math.round(c.secondsLeft / c.terms.seconds * 100)}%"></i></div>` : ""}
      <dl class="kv">
        <dt>the rule</dt><dd>In the first ${c.terms.seconds} s after launch, a buy pays up to ${formatBps(c.terms.startBps)} of its money to the creator on top of normal fees, falling to zero over the window. The creator's own wallets never pay it.${c.termsChangedSinceLaunch ? ' <span class="flag bad">the factory changed these terms after this launch</span>' : ""}</dd>
        <dt>launched</dt><dd>${isoUtc(c.launch.timestamp)} \xB7 block ${c.launch.block}</dd>
        <dt>now</dt><dd>${esc2(coverChargeLine(c))}</dd>
      </dl>
      ${c.observed.length ? `<div class="tbl"><table class="buys"><thead><tr><th>after launch</th><th>buyer</th><th>spent</th><th>paid at the door</th></tr></thead><tbody>${buys}</tbody></table></div>` : `<p style="color:var(--muted);font-size:13px;margin:8px 0 0">No buys landed inside the window.</p>`}`;
    } else if (registered) {
      coverBody = `<p style="color:var(--muted);margin:0">This launch is older than the search window; the door tax ended long ago and was not read.</p>`;
    }
    const rulesBody = r ? `<ol class="rules">${r.rules.map((x) => `<li>${esc2(x)}</li>`).join("")}</ol>` : "";
    const exitBody = e ? `<p style="margin:0 0 4px;color:var(--muted);font-size:13px">If you held ${formatUnits(e.position, 18, 0)} tokens (1% of supply) and sold now on the ${e.venue === "pool" ? "pool" : "curve"}${e.venue !== "closed" ? ` \xB7 ${formatBps(e.feeBps)} fee + ${formatBps(e.creatorTaxBps)} creator tax` : ""}:</p>
        ${e.quotes.length ? `<div class="exit-grid">${e.quotes.map((x) => `<div><span>sell ${x.shareBps / 100}%</span><b class="num">${formatUnits(x.net, qd.decimals)}</b><span>${esc2(qd.symbol)} in hand</span><small>${(x.realisedBps / 100).toFixed(1)}% of the quoted price</small></div>`).join("")}</div>` : ""}
        <p style="margin:0;color:var(--dim);font-size:12px">${esc2(e.note)}</p>
        <div class="wallet-row"><input id="wallet-q" placeholder="your wallet 0x\u2026 to see your own bag on this token" spellcheck="false"><button class="ghost" id="wallet-go" type="button">Show my bag</button></div>` : "";
    const roomBody = room ? `<dl class="kv">
        <dt>since launch</dt><dd>${esc2(roomLine(room))}</dd>
        <dt>bought</dt><dd>${amt(room.totalQuoteIn)} after fees \xB7 ${room.buys} buys \xB7 ${room.sells} sells</dd></dl>
        ${room.wallets.length ? `<div class="tbl"><table class="buys"><thead><tr><th>wallet</th><th>in</th><th>out</th><th>buys</th></tr></thead><tbody>${room.wallets.slice(0, 8).map((w) => `<tr><td>${shortAddress(w.address)}${w.creatorWallet ? ' <span class="flag">creator</span>' : ""}</td><td>${amt(w.quoteIn)}</td><td>${w.quoteOut ? amt(w.quoteOut) : "\u2014"}</td><td>${w.buys}</td></tr>`).join("")}</tbody></table></div>` : ""}` : "";
    const crewBody = crew ? `<dl class="kv"><dt>first buyers</dt><dd>${esc2(oneCrewLine(crew))}</dd>
        ${crew.crews.slice(0, 3).map((cr, i) => `<dt>group ${i + 1}</dt><dd>${cr.wallets.length} wallets were all funded by <span class="mono">${shortAddress(cr.funder)}</span> before the launch \xB7 together ${(cr.shareBps / 100).toFixed(1)}% of all buys</dd>`).join("")}</dl>
        <div class="tbl"><table class="buys"><thead><tr><th>wallet</th><th>got its money from</th><th>bought</th></tr></thead><tbody>${crew.wallets.slice(0, 10).map((w) => `<tr><td>${shortAddress(w.address)}</td><td>${w.creatorWallet ? '<span class="flag">creator wallet</span>' : w.funder ? `${shortAddress(w.funder)} <small style="color:var(--dim)">@${w.fundedAtBlock}</small>` : '<span style="color:var(--dim)">not found</span>'}</td><td>${amt(w.quoteIn)}</td></tr>`).join("")}</tbody></table></div>` : "";
    const lookBody = l ? `<dl class="kv"><dt>${esc2(l.query)}</dt><dd>${esc2(lookalikeLine(l))}</dd></dl>
        <div class="tbl"><table class="buys"><thead><tr><th>address</th><th>from the factory?</th><th>stage</th><th>launch block</th></tr></thead><tbody>${l.candidates.slice(0, 8).map((x) => `<tr><td><a href="#/${mode === "demo" ? "demo" : "t"}/${x.address}${routeChain()}">${shortAddress(x.address)}</a>${x.address === l.subject ? " \xB7 this one" : ""}</td><td>${x.registered ? '<span class="flag ok">yes</span>' : '<span class="flag bad">no</span>'}</td><td>${x.phase !== null ? PHASE_LABEL[x.phase] : "\u2014"}</td><td>${x.launchBlock ?? "\u2014"}</td></tr>`).join("")}</tbody></table></div>` : "";
    const watchBody = `<div class="watchbar"><button class="ghost" id="act-watch" type="button" aria-pressed="false">Start watching</button><span style="color:var(--muted);font-size:13px">Checks every ${mode === "demo" ? "5" : "15"} s while this tab is open: the dev selling or moving tokens, the tax recipient changing, buyback switching, graduation${crew?.crews.length ? `, and ${crew.crews.flatMap((x) => x.wallets).length} grouped wallets leaving together` : ""}. Browser notifications if you allow them.</span></div><div class="events"></div>`;
    out.innerHTML = `<div class="slip">
    ${verdictBlock({
      sym,
      name,
      address: slip.subject,
      stamp: slip.stamp,
      at: `${mode === "demo" ? "DEMO \xB7 " : ""}${esc2(slip.chain.name)} \xB7 block ${slip.at.block} \xB7 ${isoUtc(slip.at.timestamp)}`,
      notes: slip.notes,
      lead: summarySentence(slip),
      stage: opts.stage ?? "done",
      tiles,
      actions: `<button class="ghost primary" id="act-share" type="button">Copy card</button><button class="ghost" id="act-card" type="button">Preview</button><button class="ghost" id="act-link" type="button">Copy link</button><button class="ghost" id="act-json" type="button">JSON</button>`
    })}
    <div class="card-wrap" id="card"></div>
    ${answerCards(slip.notes)}
    ${unreadStrip(slip.notes, slip.skipped)}
    ${buyStrip(mode === "demo" ? "" : slip.chain.key, slip.subject, Boolean(slip.id.meta) && slip.open?.transferFunction !== false, verdictOf(slip.notes).kind)}
    <h2 class="stack-head">The evidence<span>every number above, and where it was read from</span></h2>
    <div class="stack">
      ${section("s-id", "Is it real?", "Did the launchpad's factory deploy this token, and can its code change later?", idBody, false)}
      ${o ? section("s-control", "Who controls it", "Which switches the code has (mint, pause, blacklist, fees), who holds the keys, and whether holders can move tokens right now.", controlBody(slip), false) : ""}
      ${o && tradesText ? section("s-trades", "Where it trades", "Pools on the chain's DEX factories and what they hold, plus the explorer's price feed.", tradesText, false) : ""}
      ${o && (o.holders || o.deployer || o.activity) ? section("s-holders", "Who holds it", "The largest wallets, the deployer's share, what sits in pools and contracts, and when it last moved.", holdersBody(slip), false) : ""}
      ${registered && !v1 ? section("s-cover", "Door tax", `The anti-snipe tax in the first ${c?.terms.seconds ?? 15} seconds, and who paid it.`, coverBody, c?.status === "open") : ""}
      ${r ? section("s-rules", "Fees and rules", "What every trade costs, where the creator's cut goes, what buyback really does.", rulesBody, false) : ""}
      ${v1 ? section("s-v1", "Rules (Pons V1)", "How this older kind of launch works: pool from block one, launch caps, locked liquidity.", `<ol class="rules">${v1.rules.map((x) => `<li>${esc2(x)}</li>`).join("")}</ol>`, false) : ""}
      ${e ? section("s-exit", "Cash out now", "What you would actually get for selling part or all of a position right now.", exitBody, false) : ""}
      ${room ? section("s-room", "Who is inside", "Every buyer since launch, how much the creator's own wallets put in, buys landing in the same block.", roomBody, false) : ""}
      ${crew ? section("s-crew", "Same funder?", "Where the first buyers got their money. Wallets funded by one address before the launch are one group.", crewBody, false) : ""}
      ${l ? section("s-look", "Same name", "Other tokens with this ticker on the chain, and which one launched first.", lookBody, false) : ""}
      ${d ? section("s-dev", "This dev before", `Everything this deployer launched in the last ${mode === "demo" ? "8" : "24"} h and how it went.`, devSection(d, slip.subject, false, true), false) : ""}
      ${registered && !v1 ? section("s-watch", "Watch for changes", "Get told when the dev moves, right in this tab.", watchBody, new URLSearchParams(location.hash.split("?")[1] ?? "").get("watch") === "1") : ""}
    </div>
  </div>`;
    const cardSvg = () => doorCard(slip, { repoUrl: REPO, ticker: MARK, mascotSvg: MASCOT_SVG_INNER, checkUrl: shareBase() });
    $("act-card").addEventListener("click", () => {
      const wrap = $("card");
      if (!wrap.classList.contains("open")) wrap.innerHTML = cardSvg();
      wrap.classList.toggle("open");
    });
    $("act-share").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const sym2 = slip.id.meta?.symbol ?? slip.subject.slice(0, 10);
        const how = await copyCardImage(cardSvg(), `bouncer-${sym2.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
        showToast(how === "copied" ? "Card copied \u2014 paste it anywhere" : "Your browser would not take an image; the card was downloaded instead");
      } finally {
        button.disabled = false;
      }
    });
    $("act-share").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const sym2 = slip.metadata?.symbol ?? slip.subject.slice(0, 10);
        const svg = splCard(slip, { repoUrl: REPO, ticker: MARK, mascotSvg: MASCOT_SVG_INNER, checkUrl: shareBase() });
        const how = await copyCardImage(svg, `bouncer-${sym2.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
        showToast(how === "copied" ? "Card copied \u2014 paste it anywhere" : "Your browser would not take an image; the card was downloaded instead");
      } finally {
        button.disabled = false;
      }
    });
    $("act-json").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(slipJson(slip));
        showToast("JSON copied");
      } catch {
        showToast("Clipboard blocked; use the CLI --format json");
      }
    });
    $("act-link").addEventListener("click", async () => {
      const url = `${location.origin}${location.pathname}#/${mode === "demo" ? "demo" : "t"}/${slip.subject}${routeChain()}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast("Link copied");
      } catch {
        showToast(url);
      }
    });
    const walletGo = document.getElementById("wallet-go");
    if (walletGo) {
      walletGo.addEventListener("click", () => {
        const w = document.getElementById("wallet-q").value.trim();
        if (!ADDR.test(w)) {
          showToast("paste a wallet address");
          return;
        }
        location.hash = `#/wallet/${slip.subject}/${w.toLowerCase()}?chain=${mode === "demo" ? "demo" : chain().key}`;
      });
    }
    const watchButton = document.getElementById("act-watch");
    if (watchButton) {
      watchButton.addEventListener("click", () => {
        if (watcher) {
          stopWatch();
          watchButton.setAttribute("aria-pressed", "false");
          watchButton.textContent = "Start watching";
          return;
        }
        startWatch(slip, $("s-watch"), watchButton);
      });
      if (new URLSearchParams(location.hash.split("?")[1] ?? "").get("watch") === "1") startWatch(slip, $("s-watch"), watchButton);
    }
    if (slip.cover?.status === "open") {
      const cc = slip.cover;
      const started = Date.now();
      ticker = window.setInterval(() => {
        const left = Math.max(0, cc.secondsLeft - Math.floor((Date.now() - started) / 1e3));
        const cd = document.getElementById("cd");
        const bar = document.getElementById("cd-bar");
        const note = document.getElementById("cd-note");
        if (!cd) {
          if (ticker) clearInterval(ticker);
          return;
        }
        cd.textContent = left > 0 ? `${left}s` : "OFF";
        if (bar) bar.style.width = `${Math.round(left / cc.terms.seconds * 100)}%`;
        if (left <= 0) {
          cd.className = "v closed";
          if (note) note.textContent = "ended while you were looking; check again to see who paid";
          if (ticker) clearInterval(ticker);
          ticker = null;
        }
      }, 1e3);
    }
  }
  function clean(text, max = 160) {
    const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
  }
  function pctText(bps3) {
    return bps3 === null ? "unknown" : `${(bps3 / 100).toFixed(1)}%`;
  }
  function money2(value) {
    if (!Number.isFinite(value)) return "unreadable";
    if (value === 0) return "$0";
    if (value >= 1) return `$${value.toFixed(2)}`;
    const digits = Math.min(18, Math.max(2, 2 - Math.floor(Math.log10(Math.abs(value)))));
    return `$${value.toFixed(digits)}`;
  }
  function usdShort(v) {
    return v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`;
  }
  function probeVerdict(probes) {
    if (!probes.length) return { value: "\u2014", bad: false, note: "not simulated" };
    const ok = probes.filter((p) => p.status === "ok").length;
    const reverted = probes.filter((p) => p.status === "reverts").length;
    if (!ok && !reverted) return { value: "\u2014", bad: false, note: "the node would not run the simulation" };
    if (reverted && !ok) return { value: "NO", bad: true, note: `reverts from ${reverted === 1 ? "the wallet tried" : `all ${reverted} wallets tried`}` };
    if (reverted) return { value: `${ok}/${ok + reverted}`, bad: true, note: "some wallets can, some cannot" };
    return { value: "YES", bad: false, note: `goes through from ${ok === 1 ? "the wallet tried" : `all ${ok} wallets tried`}` };
  }
  function openDoorTiles(slip) {
    const o = slip.open;
    const kinds = powerKinds(o).filter((k) => k !== "exempt" && k !== "sweep");
    const unreadable = o.surfaceFrom === "implementation-unreadable";
    const ownerV = unreadable ? "?" : o.ownerUnread ? "?" : o.owner === null ? "NONE" : o.owner.renounced ? "GONE" : "KEYS";
    const ownerS = unreadable ? "the code it runs could not be read" : o.ownerUnread ? "owner() did not answer" : o.owner === null ? "no owner() function" : o.owner.renounced ? "ownership renounced" : `owner ${shortAddress(o.owner.address)}${o.owner.isContract ? " (contract)" : ""}`;
    const sell = probeVerdict(sellProbes(o));
    const h = o.holders;
    return `<div class="tiles">
    <div class="tile"><div class="l">Owner</div><div class="v ${!unreadable && o.owner && !o.owner.renounced && kinds.length ? "bad" : ""}">${ownerV}</div><div class="s">${esc2(ownerS)}</div></div>
    <div class="tile"><div class="l">Code can</div><div class="v ${kinds.length ? "bad" : ""}">${unreadable ? "?" : kinds.length || "0"}</div><div class="s">${unreadable ? "the implementation could not be read" : kinds.length ? esc2(kinds.join(", ")) : "no mint, pause, blacklist, fee or trading switch seen"}</div></div>
    <div class="tile"><div class="l">Sale into the pool</div><div class="v ${sell.bad ? "bad" : ""}">${sell.value}</div><div class="s">${esc2(sell.note)}</div></div>
    <div class="tile"><div class="l">Top 10 wallets</div><div class="v ${h && h.top10WalletsBps !== null && h.top10WalletsBps >= 5e3 ? "bad" : ""}">${h && h.top10WalletsBps !== null ? `${(h.top10WalletsBps / 100).toFixed(0)}%` : "\u2014"}</div><div class="s">${h ? h.top10WalletsBps === null ? "supply not readable" : `of supply \xB7 ${h.count ?? "?"} holders` : "explorer not reachable"}</div></div>
  </div>`;
  }
  function controlBody(slip) {
    const o = slip.open;
    const powers = o.powers.length ? `<div class="tbl"><table class="buys"><thead><tr><th>function in the code</th><th>lets whoever may call it</th></tr></thead><tbody>${o.powers.map((p) => `<tr><td><span class="mono">${esc2(p.signature)}</span></td><td>${esc2(POWER_MEANING[p.kind])}</td></tr>`).join("")}</tbody></table></div><p style="color:var(--dim);font-size:12px;margin:6px 0 0">A name in the dispatcher is not a permission. Whether each is guarded by the owner, by a role, or by nothing at all is not readable from bytecode.</p>` : o.surfaceFrom === "implementation-unreadable" ? `<p style="color:var(--muted);font-size:13px;margin:8px 0 0">The code this proxy points at could not be read, so no function list is shown. Its switches are unknown, not absent.</p>` : `<p style="color:var(--muted);font-size:13px;margin:8px 0 0">No mint, pause, blacklist, fee, limit, trading or upgrade function was seen among the ${o.selectors} four-byte selectors in the code.</p>`;
    const probeRows = o.probes.length ? `<div class="tbl"><table class="buys"><thead><tr><th>simulated</th><th>from</th><th>result</th></tr></thead><tbody>${o.probes.map(
      (p) => `<tr><td>${p.target === "pool" ? "sale into the pool" : "transfer to a fresh wallet"}</td><td><span class="mono">${shortAddress(p.from)}</span>${p.source === "deployer" ? ' <span class="flag">deployer</span>' : ""}</td><td>${p.status === "ok" ? '<span class="flag ok">goes through</span>' : p.status === "reverts" ? `<span class="flag bad">reverts</span> ${esc2(clean(p.reason ?? ""))}` : `<span class="flag">not run</span> ${esc2(clean(p.reason ?? ""))}`}</td></tr>`
    ).join("")}</tbody></table></div><p style="color:var(--dim);font-size:12px;margin:6px 0 0">Run with eth_call from wallets that hold the token; nothing was signed or sent. One unit, at this block: a fee on transfer, a cap on size, or a rule the owner flips tomorrow would not show up here.</p>` : o.probesSkipped ? `<p style="color:var(--muted);font-size:13px;margin:8px 0 0">No transfer was simulated: ${esc2(o.probesSkipped)}.</p>` : "";
    return `<dl class="kv">
    <dt>owner</dt><dd>${o.ownerUnread ? "owner() is in the code but the chain would not answer it" : o.owner === null ? "no owner() function in the code" : o.owner.renounced ? '<span class="flag ok">renounced</span> nobody can call owner-only functions' : `<span class="mono">${esc2(o.owner.address)}</span>${o.owner.isContract ? " (a contract)" : ""}${o.ownerBalance?.bps != null ? ` \xB7 holds ${pctText(o.ownerBalance.bps)}` : ""}${o.ownable ? "" : " \xB7 no renounceOwnership()"}`}</dd>
    ${o.paused !== null ? `<dt>paused</dt><dd>${o.paused ? '<span class="flag bad">yes</span>' : '<span class="flag ok">no</span>'}</dd>` : ""}
    ${o.tradingOpen ? `<dt>${esc2(o.tradingOpen.view)}</dt><dd>${o.tradingOpen.open ? '<span class="flag ok">true</span> trading is open' : '<span class="flag bad">false</span> trading is switched off'}</dd>` : ""}
    <dt>source</dt><dd>${o.verified === null ? "explorer not reachable" : o.verified ? '<span class="flag ok">verified</span> the code can be read on the explorer' : '<span class="flag bad">not verified</span> only the bytes can be read'}</dd>
    <dt>read from</dt><dd>${o.surfaceFrom === "implementation" ? "the proxy's current implementation" : o.surfaceFrom === "implementation-unreadable" ? '<span class="flag bad">unreadable</span> this is a proxy and its implementation code did not load' : "the token's own bytecode"} \xB7 ${o.selectors} four-byte selectors${o.constants > o.selectors ? `, ${o.constants - o.selectors} shorter constants ignored` : ""}</dd>
  </dl>${powers}${probeRows}`;
  }
  function tradesBody(slip) {
    const o = slip.open;
    const q2 = slip.chain.native;
    const dec = slip.id.meta?.decimals ?? 18;
    const explorer = chain().blockscout;
    const amount = (v, decimals, fraction) => v === null ? "unread" : formatUnits(v, decimals, fraction);
    const pools = o.pools ? o.pools.length ? `<div class="tbl"><table class="buys"><thead><tr><th>pool</th><th>fee</th><th>W${esc2(q2.symbol)} inside</th><th>tokens inside</th></tr></thead><tbody>${o.pools.map((p) => `<tr><td>${explorer && mode !== "demo" ? `<a href="${esc2(explorer)}/address/${esc2(p.address)}" target="_blank" rel="noopener">${esc2(p.dex)} \xB7 ${shortAddress(p.address)}</a>` : `${esc2(p.dex)} \xB7 ${shortAddress(p.address)}`}</td><td>${(p.feeBps / 100).toFixed(2)}%</td><td>${amount(p.quoteReserve, q2.decimals, 3)}</td><td>${amount(p.tokenReserve, dec, 0)}</td></tr>`).join("")}</tbody></table></div><p style="color:var(--dim);font-size:12px;margin:6px 0 0">Reserves are the pool's balances at this block. Whether the liquidity is locked is not read here, and pools on other venues or against other pairs are not counted.</p>` : `<p style="color:var(--muted);font-size:13px;margin:0">No W${esc2(q2.symbol)} pool on the chain's known DEX factories. It may trade on another DEX, in a Uniswap V4 pool, against another pair, or not at all.</p>` : "";
    const feed = o.explorer && o.explorer.priceUsd != null ? `<dl class="kv"><dt>explorer price</dt><dd>${money2(o.explorer.priceUsd)}${o.explorer.volume24hUsd !== null ? ` \xB7 ${usdShort(o.explorer.volume24hUsd)} in 24 h` : ""}${o.explorer.marketCapUsd !== null ? ` \xB7 ${usdShort(o.explorer.marketCapUsd)} market cap` : ""} <small style="color:var(--dim)">the explorer's feed, not the chain's</small></dd></dl>` : "";
    return `${feed}${pools}`;
  }
  function holdersBody(slip) {
    const o = slip.open;
    const h = o.holders;
    const role = (x) => x.role === "deployer" ? '<span class="flag">deployer</span>' : x.role === "owner" ? '<span class="flag">owner</span>' : x.role === "burn" ? '<span class="flag ok">burn</span>' : x.role === "token" ? '<span class="flag">the token</span>' : x.delegated ? '<span class="flag">wallet \xB7 7702</span>' : x.isContract ? `<span class="flag">${esc2(x.name ?? "contract")}</span>` : "";
    const explorer = chain().blockscout;
    return `<dl class="kv">
    ${o.deployer ? `<dt>deployer</dt><dd><span class="mono">${esc2(o.deployer.address)}</span> \xB7 holds ${pctText(o.deployer.bps)}${o.deployer.createdAt ? ` \xB7 deployed ${isoUtc(o.deployer.createdAt)} (${formatDuration(Math.max(0, slip.at.timestamp - o.deployer.createdAt))} ago)` : ""}</dd>` : ""}
    ${h ? `<dt>holders</dt><dd>${h.count ?? "unknown"}${h.transfers !== null ? ` \xB7 ${h.transfers} transfers indexed` : ""}</dd>
    <dt>top 10 wallets</dt><dd>${pctText(h.top10WalletsBps)} of supply, over the ${h.rows} rows the explorer returned. Contracts and burn addresses are not counted; wallets that delegated under EIP-7702 are.</dd>
    <dt>in contracts</dt><dd>${pctText(h.contractsBps)} (pools, lockers, vaults, the token itself)${h.burnedBps ? ` \xB7 burned ${pctText(h.burnedBps)}` : ""}</dd>` : ""}
    ${o.activity ? `<dt>last transfer</dt><dd>${o.activity.lastTransferAt ? `${formatDuration(Math.max(0, slip.at.timestamp - o.activity.lastTransferAt))} ago \xB7 ${o.activity.recentWallets} wallets in the last ${o.activity.recent} transfers` : "none indexed by the explorer"}</dd>` : ""}
  </dl>
  ${h && h.top.length ? `<div class="tbl"><table class="buys"><thead><tr><th>#</th><th>holder</th><th>share</th></tr></thead><tbody>${h.top.slice(0, 15).map((x, i) => `<tr><td>${i + 1}</td><td>${explorer && mode !== "demo" ? `<a href="${esc2(explorer)}/address/${esc2(x.address)}" target="_blank" rel="noopener"><span class="mono">${shortAddress(x.address)}</span></a>` : `<span class="mono">${shortAddress(x.address)}</span>`} ${role(x)}</td><td>${pctText(x.bps)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
  }
  function devSection(d, subject, standalone, bodyOnly = false) {
    const inner = `<dl class="kv"><dt>deployer</dt><dd><span class="mono">${esc2(d.deployer)}</span></dd><dt>in window</dt><dd>${esc2(devReportLine(d))}</dd>${standalone ? `<dt>blocks</dt><dd>${d.window.fromBlock}\u2013${d.window.toBlock}</dd>` : ""}</dl>
    ${d.launches.length ? `<div class="tbl"><table class="buys"><thead><tr><th>ticker</th><th>launched</th><th>stage</th><th>creator tax</th><th>launch \u2192 sweep</th></tr></thead><tbody>${d.launches.map((l) => `<tr><td><a href="#/${mode === "demo" ? "demo" : "t"}/${l.token}${routeChain()}">${esc2(l.symbol)}</a>${l.token === subject ? " \xB7 this one" : ""}</td><td>${isoUtc(l.launchedAt).slice(0, 16).replace("T", " ")}</td><td>${PHASE_LABEL[l.phase]}</td><td>${formatBps(l.creatorTaxBps)}</td><td>${l.secondsToSweep === null ? "\u2014" : formatDuration(l.secondsToSweep)}</td></tr>`).join("")}</tbody></table></div>${d.truncated ? `<p style="color:var(--muted);font-size:13px">${d.counts.launched - d.launches.length} older launches counted but not listed.</p>` : ""}` : ""}`;
    return bodyOnly ? inner : `<section class="sec wide"><h2>This dev before</h2>${inner}</section>`;
  }
  function renderPosition(p, head) {
    const qd = chain().native;
    const amt = (v) => `${formatUnits(v, qd.decimals)} ${esc2(qd.symbol)}`;
    const whole = p.exit.quotes.find((x) => x.shareBps === 1e4);
    const sign = p.unrealised < 0n ? "\u2212" : "+";
    const absU = p.unrealised < 0n ? -p.unrealised : p.unrealised;
    out.innerHTML = `<div class="slip">
    <div class="stamp-row"><div class="who"><div class="sym">THE BAG</div><div class="name"><span class="mono">${esc2(p.wallet)}</span> on <a href="#/${mode === "demo" ? "demo" : "t"}/${p.token}${routeChain()}">${shortAddress(p.token)}</a></div><div class="at">block ${head} \xB7 ${p.exit.venue}</div></div>
      <div class="stamp ${p.unrealised < 0n ? "no" : ""}">${sign}${formatUnits(absU, qd.decimals, 3)} ${esc2(qd.symbol)}</div></div>
    <div class="grid">
      <section class="sec"><h2>Position</h2><dl class="kv">
        <dt>balance</dt><dd class="num">${formatUnits(p.balance, 18, 0)} tokens</dd>
        <dt>spent</dt><dd>${amt(p.spentQuote)} over ${p.trades.filter((t) => t.kind === "buy").length} buys</dd>
        <dt>received</dt><dd>${amt(p.receivedQuote)} over ${p.trades.filter((t) => t.kind === "sell").length} sells</dd>
        <dt>fees paid</dt><dd>${amt(p.feesPaid)}</dd>
        <dt>taxes paid</dt><dd>${amt(p.taxesPaid)} <small style="color:var(--dim)">creator tax plus any cover charge</small></dd>
        <dt>cost basis</dt><dd>${amt(p.costBasis)}</dd>
        <dt>exit now</dt><dd>${whole ? amt(whole.net) : "n/a"}</dd>
        <dt>unrealised</dt><dd>${sign}${amt(absU)}</dd>
      </dl><p style="margin:10px 0 0;color:var(--dim);font-size:12px">${esc2(p.exit.note)}</p></section>
      <section class="sec"><h2>Trades</h2>${p.trades.length ? `<div class="tbl"><table class="buys"><thead><tr><th>block</th><th>side</th><th>quote</th><th>tokens</th><th>fee + tax</th></tr></thead><tbody>${p.trades.slice(0, 20).map((t) => `<tr><td>${t.block}</td><td>${t.kind}</td><td>${amt(t.quote)}</td><td>${formatUnits(t.tokens, 18, 0)}</td><td>${formatUnits(t.fee + t.tax, qd.decimals)}</td></tr>`).join("")}</tbody></table></div>` : `<p style="color:var(--muted);margin:0">No curve trades by this wallet on this launch.</p>`}</section>
    </div></div>`;
  }
  function receiptSection(r) {
    const qd = chain().native;
    const amt = (v) => `${formatUnits(v, qd.decimals)} ${esc2(qd.symbol)}`;
    const share = (v) => r.quote === 0n ? "0" : (Number(v * 10000n / r.quote) / 100).toFixed(1);
    return `<div class="stamp-row"><div class="who"><div class="sym">${r.kind.toUpperCase()}</div><div class="name">${r.launch ? `<a href="#/${mode === "demo" ? "demo" : "t"}/${r.launch.token.toLowerCase()}${routeChain()}">${shortAddress(r.launch.token)}</a>` : `curve ${shortAddress(r.curve)} (no factory record)`} \xB7 by <span class="mono">${shortAddress(r.wallet)}</span></div><div class="addr">${esc2(r.hash)}</div><div class="at">block ${r.block}</div></div>
      <div class="stamp ${r.coverChargePart > 0n ? "no" : ""}">${r.coverChargePart > 0n ? `${share(r.coverChargePart)}% COVER` : "NO COVER"}</div></div>
    <section class="sec wide"><h2>Itemised</h2><dl class="kv">
      <dt>${r.kind === "buy" ? "paid" : "received"}</dt><dd>${amt(r.quote)}</dd>
      <dt>tokens</dt><dd class="num">${formatUnits(r.tokens, 18, 0)}</dd>
      <dt>protocol fee</dt><dd>${amt(r.fee)} \xB7 ${share(r.fee)}%</dd>
      <dt>creator tax</dt><dd>${amt(r.creatorTaxPart)} \xB7 ${share(r.creatorTaxPart)}%${r.launch ? ` <small style="color:var(--dim)">rate ${formatBps(r.launch.creatorTaxBps)}</small>` : ""}</dd>
      <dt>cover charge</dt><dd>${amt(r.coverChargePart)} \xB7 ${share(r.coverChargePart)}% <small style="color:var(--dim)">the part of the tax above the creator's rate: paid at the door</small></dd>
      <dt>effective price</dt><dd>${formatUnits(r.effectivePrice, qd.decimals, 12)} ${esc2(qd.symbol)} per token, fees included</dd>
      <dt>curve price after</dt><dd>${r.marginalPriceAfter === null ? "not served by this RPC for that block" : `${formatUnits(r.marginalPriceAfter, qd.decimals, 12)} ${esc2(qd.symbol)} per token`}</dd>
    </dl></section>`;
  }
  function renderPlan(plan) {
    const qd = plan.quote;
    const c = chain();
    const u = (v, f = 4) => `${formatUnits(v, qd.decimals, f)} ${esc2(qd.symbol)}`;
    out.innerHTML = `<div class="slip">
    <div class="stamp-row"><div class="who"><div class="sym">PLAN</div><div class="name">${esc2(c.name)} \xB7 ${esc2(c.launchpad)} \xB7 config ${plan.configId}${plan.configEnabled ? "" : " (disabled)"} \xB7 quote ${esc2(qd.symbol)}</div><div class="at">block ${plan.block}</div>
      <form class="row" id="plan-form" style="margin-top:12px"><input class="short" id="plan-tax" placeholder="creator tax bps" value="${plan.creatorTaxBps}"><input class="short" id="plan-buy" placeholder="sample buy (${esc2(qd.symbol)})" value="${formatUnits(plan.sampleBuy, qd.decimals)}"><input class="short" id="plan-quote" placeholder="quote token 0x\u2026 (blank = ${esc2(c.native.symbol)})" value="${plan.pairToken === "0x0000000000000000000000000000000000000000" ? "" : plan.pairToken}"><button class="ghost" type="submit">Recalculate</button></form></div>
      <div class="stamp">${formatBps(plan.creatorTaxBps)} TAX</div></div>
    <div class="grid">
      <section class="sec"><h2>Terms today</h2><dl class="kv">
        <dt>launch fee</dt><dd>${formatUnits(plan.launchFee, c.native.decimals)} ${esc2(c.native.symbol)} to the protocol</dd>
        <dt>supply</dt><dd class="num">${formatUnits(plan.supply, 18, 0)}</dd>
        <dt>curve</dt><dd>phantom ${u(plan.phantomQuote)} \xB7 graduates at ${u(plan.graduationThreshold)}</dd>
        <dt>creator tax</dt><dd>${formatBps(plan.creatorTaxBps)} of every curve trade (ceiling ${formatBps(plan.maxCreatorTaxBps)})</dd>
        <dt>curve fee</dt><dd>${formatBps(plan.curveFeeBps)} \xB7 protocol ${formatBps(plan.protocolFeeShareBps)} / buyback ${formatBps(plan.buybackBurnBps)} of the rest / creator</dd>
        <dt>after graduation</dt><dd>pool fee ${Number(plan.poolFeePpm) / 1e4}% \xB7 hook fee ${formatBps(plan.hookFeeBps)}</dd>
        <dt>cover charge</dt><dd>${formatBps(plan.snipe.startBps)} in the launch second, 0 after ${plan.snipe.seconds} s</dd>
      </dl></section>
      <section class="sec"><h2>What the curve does</h2><dl class="kv">
        <dt>start price</dt><dd>${formatUnits(plan.startPrice, qd.decimals, 12)} ${esc2(qd.symbol)}</dd>
        <dt>graduation price</dt><dd>${formatUnits(plan.graduationPrice, qd.decimals, 12)} ${esc2(qd.symbol)} \xB7 ${(Number(plan.graduationPrice * 100n / (plan.startPrice || 1n)) / 100).toFixed(2)}\xD7 the start</dd>
        <dt>sold on the curve</dt><dd class="num">${formatUnits(plan.tokensSoldOnCurve, 18, 0)} tokens (${(Number(plan.tokensSoldOnCurve * 10000n / (plan.supply || 1n)) / 100).toFixed(1)}%)</dd>
        <dt>seeded into the pool</dt><dd class="num">${formatUnits(plan.tokensToPool, 18, 0)} tokens + ${u(plan.graduationThreshold)} \xB7 locked</dd>
        <dt>FDV at graduation</dt><dd>${u(plan.fdvAtGraduation, 2)}</dd>
        <dt>creator earns</dt><dd>${u(plan.graduationThreshold * plan.creatorTaxBps / 10000n)} if the curve fills with no sells</dd>
        <dt>${u(plan.sampleBuy)} at second 0</dt><dd>pays ${u(plan.sampleDoorCharge)} to the creator as cover charge, unless the wallet is on the exemption list</dd>
      </dl></section>
    </div>
    <p style="color:var(--dim);font:12px var(--mono);margin:0">Read from the factory and the hook at block ${plan.block}; the curve arithmetic is the contract's own. The factory owner can retune terms before you launch.</p>
  </div>`;
    $("plan-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const tax = $("plan-tax").value.trim() || "100";
      const buy = $("plan-buy").value.trim();
      const quote = $("plan-quote").value.trim();
      const params = new URLSearchParams();
      params.set("tax", tax);
      if (buy) params.set("buy", buy);
      if (quote) params.set("quote", quote);
      params.set("chain", mode === "demo" ? "demo" : chain().key);
      location.hash = `#/plan?${params.toString()}`;
    });
  }
  function esc2(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function routeChain() {
    return mode === "demo" ? "" : `?chain=${chain().key}`;
  }
  function route() {
    const raw = location.hash.replace(/^#/, "");
    const [path, query = ""] = raw.split("?");
    const params = new URLSearchParams(query);
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) return;
    const chainParam = params.get("chain");
    const wantDemo = parts[0] === "demo" || chainParam === "demo";
    if (wantDemo && mode !== "demo") setMode("demo", true);
    if (!wantDemo && parts[0] !== "demo") {
      if (mode !== "live") setMode("live", true);
      if (chainParam && CHAINS[chainParam]) chainSelect.value = chainParam;
    }
    switch (parts[0]) {
      case "t":
      case "demo":
        setView("door");
        q.value = parts[1] ?? "";
        void runDoor(parts[1] ?? "");
        break;
      case "dev":
        setView("dev");
        q.value = parts[1] ?? "";
        void runDev(parts[1] ?? "");
        break;
      case "wallet":
        setView("wallet");
        q.value = `${parts[1] ?? ""} ${parts[2] ?? ""}`.trim();
        void runWallet(parts[1] ?? "", parts[2] ?? "");
        break;
      case "tx":
        setView("tx");
        q.value = parts[1] ?? "";
        void runTx(parts[1] ?? "");
        break;
      case "plan":
        setView("plan");
        q.value = params.get("tax") ?? "100";
        void runPlan(Number(params.get("tax") ?? 100), params);
        break;
      case "board":
        setView("board");
        q.value = params.get("hours") ?? "1";
        void runBoard(Number(params.get("hours") ?? 1) || 1);
        break;
    }
  }
  function submit() {
    const v = q.value.trim();
    const c = mode === "demo" ? "demo" : chainSelect.value === "auto" ? chainOrNull()?.key ?? "auto" : chain().key;
    let hash;
    if (view === "plan") hash = `#/plan?tax=${encodeURIComponent(v || "100")}&chain=${c}`;
    else if (view === "board") hash = `#/board?hours=${encodeURIComponent(v || "1")}&chain=${c}`;
    else if (view === "dev" && ADDR.test(v)) hash = `#/dev/${v.toLowerCase()}?chain=${c}`;
    else {
      const found = detect(v);
      if (!found) return bad(chainOrNull()?.family === "solana" && mode === "live" ? "Paste a Solana mint address: 32 bytes in base58, like EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v." : "Paste a token or curve address (0x + 40 hex characters), a transaction hash (0x + 64), or a token and a wallet address separated by a space.");
      if (found.view === "wallet") hash = `#/wallet/${found.parts[0].toLowerCase()}/${found.parts[1].toLowerCase()}?chain=${c}`;
      else if (found.view === "tx") hash = `#/tx/${found.parts[0]}?chain=${c}`;
      else hash = `#/${mode === "demo" ? "demo" : "t"}/${mode === "live" && isSolanaAddress(found.parts[0]) && !ADDR.test(found.parts[0]) ? found.parts[0] : found.parts[0].toLowerCase()}${mode === "demo" ? "" : `?chain=${c}`}`;
    }
    if (location.hash === hash) route();
    else location.hash = hash;
  }
  function boot() {
    $("mark").src = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">${MASCOT_SVG_INNER}</svg>`)}`;
    rpcInput.value = storage("bouncer.rpc") ?? "";
    proxyInput.value = storage("bouncer.proxy") ?? "";
    proxyInput.addEventListener("change", () => storage("bouncer.proxy", proxyInput.value.trim()));
    factoryInput.value = storage("bouncer.factory") ?? "";
    chainSelect.value = storage("bouncer.chain") ?? "auto";
    paintSelectedChain();
    rpcInput.addEventListener("change", () => storage("bouncer.rpc", rpcInput.value.trim()));
    factoryInput.addEventListener("change", () => storage("bouncer.factory", factoryInput.value.trim()));
    chainSelect.addEventListener("change", () => {
      storage("bouncer.chain", chainSelect.value);
      if (chainSelect.value === "auto") {
        autoChain = null;
        resolvedFor = { address: "", chain: "" };
      }
      paintSelectedChain();
      if (mode === "live") setMode("live", true);
      renderChips();
    });
    $("mode-demo").addEventListener("click", () => setMode("demo"));
    $("mode-live").addEventListener("click", () => setMode("live"));
    if (SANDBOXED) {
      const live = $("mode-live");
      live.disabled = true;
      live.title = "Live mode cannot run inside the claude.ai preview: the sandbox blocks network requests. Use the hosted site or the Chrome extension.";
    }
    settingsToggle.addEventListener("click", () => {
      const open = !settings.classList.contains("open");
      settings.classList.toggle("open", open);
      settingsToggle.setAttribute("aria-expanded", String(open));
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submit();
    });
    window.addEventListener("hashchange", route);
    setMode(SANDBOXED ? "demo" : storage("bouncer.mode") ?? "demo", true);
    setView("door");
    if (location.hash) route();
    else {
      q.value = DEMO.tokens.fresh.token;
      setMode("demo", true);
      void runDoor(DEMO.tokens.fresh.token);
    }
  }
  boot();
})();
