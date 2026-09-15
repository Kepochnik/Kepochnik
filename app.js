"use strict";
(() => {
  // src/chain/blockscout.ts
  var BlockscoutClient = class {
    baseUrl;
    fetchImpl;
    timeoutMs;
    constructor(options) {
      this.baseUrl = options.baseUrl.replace(/\/$/, "");
      this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
      this.timeoutMs = options.timeoutMs ?? 15e3;
    }
    async get(path) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new Error(`blockscout ${response.status} for ${path}`);
        return await response.json();
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
    /** Whether the explorer holds verified source for the address. */
    async isVerified(address) {
      try {
        const body = await this.get(`/api/v2/smart-contracts/${address}`);
        return Boolean(body.is_verified ?? body.is_fully_verified);
      } catch {
        return null;
      }
    }
  };

  // src/chain/chains.ts
  var CHAINS = {
    robinhood: {
      key: "robinhood",
      name: "Robinhood Chain",
      chainId: 4663,
      rpc: ["https://rpc.mainnet.chain.robinhood.com"],
      blockscout: "https://robinhoodchain.blockscout.com",
      factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e".toLowerCase(),
      factoryV1: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB".toLowerCase(),
      launchpad: "Pons V2",
      native: { symbol: "ETH", decimals: 18 },
      blocksPerSecond: 10
    },
    "arc-testnet": {
      key: "arc-testnet",
      name: "Arc Testnet",
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
      chainId: 5042,
      rpc: ["https://rpc.arc-scan.org"],
      blockscout: null,
      factory: null,
      launchpad: "Radian (Pons V2 port)",
      native: { symbol: "USDC", decimals: 18 },
      blocksPerSecond: 1,
      notes: "Mainnet opens 2026-09-16. The Radian mainnet factory is not published yet: pass --factory 0x\u2026 (CLI) or set it in the site's live settings once it is."
    }
  };
  var DEFAULT_CHAIN = CHAINS.robinhood;
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

  // src/chain/keccak.ts
  var MASK64 = (1n << 64n) - 1n;
  var ROUND_CONSTANTS = [
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
  var ROTATION = [
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
  var RATE_BYTES = 136;
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
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
    const out2 = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out2.length; i++) {
      out2[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out2;
  }

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

  // src/chain/reader.ts
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
    constructor(message, code, data) {
      super(message);
      this.code = code;
      this.data = data;
      this.name = "RpcError";
    }
  };
  var RpcClient = class {
    urls;
    expectedChainId;
    timeoutMs;
    fetchImpl;
    minSpacingMs;
    rateLimitRetries;
    activeIndex = 0;
    nextId = 1;
    verifiedChain = false;
    lastRequestAt = 0;
    constructor(options) {
      if (options.urls.length === 0) throw new Error("at least one RPC url is required");
      this.urls = options.urls;
      this.expectedChainId = options.expectedChainId;
      this.timeoutMs = options.timeoutMs ?? 15e3;
      this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
      this.minSpacingMs = options.minSpacingMs ?? (options.fetchImpl ? 0 : 120);
      this.rateLimitRetries = options.rateLimitRetries ?? 3;
    }
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
    async getBlock(blockNumber) {
      const tag = blockNumber === "latest" ? "latest" : toHex(blockNumber);
      const block = await this.send("eth_getBlockByNumber", [tag, false]);
      if (!block) throw new RpcError(`block ${tag} not found`);
      return {
        number: Number(BigInt(block.number)),
        timestamp: Number(BigInt(block.timestamp)),
        hash: block.hash
      };
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
      return await this.send("eth_getLogs", [params]);
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
    async sendBatch(requests) {
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
      const attempts = this.urls.length * (this.rateLimitRetries + 1);
      for (let attempt = 0; attempt < attempts; attempt++) {
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
          return payload.map((request) => {
            const item = byId.get(request.id);
            if (!item) throw new RpcError(`missing response for ${request.method}`);
            if (item.error) throw new RpcError(item.error.message, item.error.code, item.error.data);
            return item.result;
          });
        } catch (error) {
          lastError = error;
          const rateLimited = error instanceof RpcError && (error.code === 429 || /rate|limit|too many/i.test(error.message));
          if (rateLimited) {
            await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** Math.min(attempt, 4)));
            continue;
          }
          this.activeIndex = (this.activeIndex + 1) % this.urls.length;
          this.verifiedChain = false;
        }
      }
      throw lastError instanceof Error ? lastError : new RpcError(String(lastError));
    }
    async pace() {
      if (this.minSpacingMs <= 0) return;
      const wait = this.lastRequestAt + this.minSpacingMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequestAt = Date.now();
    }
  };
  function toHex(value) {
    return `0x${value.toString(16)}`;
  }

  // src/chain/tape.ts
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
    let chunk = Math.min(maxChunk, Math.max(minChunk, chunking.startChunk ?? 5e4));
    const logs = [];
    let chunks = 0;
    let from = request.fromBlock;
    while (from <= request.toBlock) {
      const to = Math.min(from + chunk - 1, request.toBlock);
      try {
        const raw = await rpc.getLogs({ address: request.address, topics: filterTopics, fromBlock: from, toBlock: to });
        chunks++;
        for (const log of raw) logs.push(decodeRaw(byTopic, log));
        from = to + 1;
        chunk = Math.min(maxChunk, chunk * 2);
      } catch (error) {
        if (chunk <= minChunk) throw error;
        chunk = Math.max(minChunk, Math.floor(chunk / 2));
      }
    }
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return { logs, fromBlock: request.fromBlock, toBlock: request.toBlock, chunks };
  }
  function addressTopic(address) {
    return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
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
  function formatBps(bps) {
    const whole = bps / 100n;
    const fraction = bps % 100n;
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

  // src/bouncer/coverCharge.ts
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

  // src/bouncer/devReport.ts
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
    info: "#7f8ea3",
    dim: "#5e5a66"
  };
  function doorCard(slip, options) {
    const c = CARD_COLORS;
    const meta = slip.id.meta;
    const title = meta ? esc(meta.symbol) : shortAddress(slip.subject);
    const sub = meta ? esc(meta.name) : "unregistered contract";
    const stampColor = slip.stamp === "ON THE LIST" ? c.brass : c.stop;
    const lines = [];
    const idBits = [slip.id.registered ? "factory record" : "no factory record", slip.id.token.code.empty ? "no code" : `${slip.id.token.code.bytes} bytes`];
    if (slip.id.token.proxyImplementation || slip.id.token.code.minimalProxyTarget) idBits.push("proxy");
    if (slip.id.token.code.opcodes.selfdestruct) idBits.push("SELFDESTRUCT");
    if (slip.id.token.code.opcodes.delegatecall) idBits.push("DELEGATECALL");
    if (idBits.length === 2 && !slip.id.token.code.empty) idBits.push("no SELFDESTRUCT, no DELEGATECALL, no proxy");
    lines.push(["ID CHECK", idBits.join(" \xB7 ")].join("  "));
    if (slip.cover) lines.push(["COVER CHARGE", coverChargeLine(slip.cover)].join("  "));
    if (slip.rules) {
      lines.push(["HOUSE RULES", `${formatBps(slip.rules.totalTradeBps)} per curve trade \xB7 creator ${formatBps(slip.rules.creatorTaxBps)} \xB7 ${slip.rules.buybackEnabled ? "buyback vests, no burn" : "no buyback"} \xB7 ${slip.rules.quote.symbol}`].join("  "));
      lines.push(["PHASE", `${PHASE_LABEL[slip.rules.phase]}${slip.rules.fill ? ` \xB7 ${(slip.rules.fill.bps / 100).toFixed(1)}% full` : ""} \xB7 dev holds ${(slip.rules.deployerShareBps / 100).toFixed(1)}%`].join("  "));
    }
    if (slip.dev) lines.push(["DEV REPORT CARD", devReportLine(slip.dev)].join("  "));
    const notes = slip.notes.slice(0, 4);
    const noteRows = notes.map((n, i) => {
      const y = 396 + i * 38;
      const color = n.level === "stop" ? c.stop : n.level === "watch" ? c.watch : c.info;
      return `<circle cx="72" cy="${y - 6}" r="6" fill="${color}"/><text x="92" y="${y}" font-size="18" fill="${c.text}">${esc(clip(n.text, 74))}</text>`;
    }).join("");
    const factRows = lines.map((l, i) => {
      const [label, value] = l.split("  ");
      const y = 214 + i * 36;
      return `<text x="60" y="${y}" font-size="15" font-weight="700" letter-spacing="2" fill="${c.brass}">${esc(label)}</text><text x="270" y="${y}" font-size="19" fill="${c.text}">${esc(clip(value, 70))}</text>`;
    }).join("");
    const _phaseUnused = slip.rules?.phase ?? null;
    void _phaseUnused;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">
  <rect width="1200" height="630" fill="${c.ink}"/>
  <rect x="40" y="40" width="1120" height="550" rx="18" fill="${c.panel}" stroke="${c.line}"/>
  <rect x="40" y="40" width="1120" height="6" fill="${c.rope}"/>
  <text x="60" y="96" font-size="22" font-weight="700" letter-spacing="6" fill="${c.brass}">BOUNCER</text>
  <text x="60" y="122" font-size="15" fill="${c.muted}">read-only door check \xB7 Pons V2 \xB7 Robinhood Chain 4663 \xB7 block ${slip.at.block} \xB7 ${isoUtc(slip.at.timestamp)}</text>
  <text x="60" y="176" font-size="44" font-weight="700" fill="${c.text}">${title}</text>
  <text x="${60 + Math.min(title.length, 14) * 27 + 24}" y="176" font-size="20" fill="${c.muted}">${sub}</text>
  ${factRows}
  <line x1="60" y1="340" x2="900" y2="340" stroke="${c.line}"/>
  <text x="60" y="366" font-size="13" font-weight="700" letter-spacing="3" fill="${c.muted}">DOOR NOTES</text>
  ${noteRows}
  <g transform="translate(880 150) rotate(-8)">
    <rect x="0" y="0" width="270" height="64" rx="8" fill="none" stroke="${stampColor}" stroke-width="4"/>
    <text x="135" y="42" text-anchor="middle" font-size="${slip.stamp.length > 12 ? 22 : 26}" font-weight="800" letter-spacing="3" fill="${stampColor}">${slip.stamp}</text>
  </g>
  <g transform="translate(964 330) scale(5.5)">${options.mascotSvg}</g>
  <text x="60" y="562" font-size="14" fill="${c.muted}">${esc(slip.subject)}</text>
  <text x="1140" y="540" text-anchor="end" font-size="13" fill="${c.dim}">no key \xB7 no signer \xB7 no transaction path</text>
  <text x="1140" y="562" text-anchor="end" font-size="14" fill="${c.muted}">${esc(options.repoUrl)} \xB7 ${esc(options.ticker)}</text>
</svg>
`;
  }
  function esc(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function clip(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
  }

  // src/chain/code.ts
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
    const scan = {
      bytes: bytes.length,
      codeHash: keccak256Hex(bytes),
      empty: bytes.length === 0,
      metadataBytes: metadataTrailerLength(bytes),
      opcodes: { selfdestruct: 0, delegatecall: 0, callcode: 0, create: 0, create2: 0 },
      minimalProxyTarget: minimalProxyTarget(bytes)
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
    const first = bytes[bytes.length - 2 - length];
    return first >= 161 && first <= 163 ? length + 2 : 0;
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

  // src/bouncer/exitDoor.ts
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
    const clean = hex.replace(/^0x/, "");
    const out2 = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out2.length; i++) out2[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
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
  var DEMO_IMPOSTOR = { token: "0x00000000000000000000000000000000000bad01", implementation: "0x00000000000000000000000000000000000bad02" };
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
            const all = !address ? [...factoryLogs(from, to), ...Object.values(DEMO.tokens).flatMap((t) => [...curveLogs(t, from, to), ...tokenLogs(t, from, to)])] : address === PONS_V2_FACTORY ? factoryLogs(from, to) : byCurve.has(address) ? curveLogs(byCurve.get(address), from, to) : byToken.has(address) ? tokenLogs(byToken.get(address), from, to) : [];
            return ok(all.filter((log) => matchesTopics(log.topics, f.topics)));
          }
          case "eth_getCode": {
            const who = request.params[0].toLowerCase();
            if (who === PONS_V2_FACTORY) return ok(DEMO_CODE.factory);
            if (byToken.has(who)) return ok(DEMO_CODE.ponsToken);
            if (byCurve.has(who)) return ok(DEMO_CODE.ponsCurve);
            if (who === DEMO_IMPOSTOR.token) return ok(DEMO_CODE.impostor);
            if (who === DEMO_V1.token || who === PONS_V1_FACTORY) return ok(DEMO_CODE.ponsToken);
            return ok("0x");
          }
          case "eth_getTransactionReceipt": {
            const hash = request.params[0];
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
            return err(`demo chain has no answer for ${to} ${s}`);
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
      return new Response("not found", { status: 404 });
    });
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
    impostor: `0x6080604052${"5b".repeat(20)}f4${"5b".repeat(20)}ff00${CBOR_TRAILER}`
  };
  function demoRpc() {
    return new RpcClient({ urls: ["demo://robinhood-chain"], expectedChainId: ROBINHOOD_CHAIN_ID, fetchImpl: demoFetch(), minSpacingMs: 0 });
  }

  // src/bouncer/houseRules.ts
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

  // src/bouncer/v1.ts
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
  async function readIdCheck(rpc, input, block, factory, options = {}) {
    if (!isAddress(input)) throw new Error(`${input} is not an address`);
    const address = normalizeAddress(input);
    const reader = new PonsReader(rpc, factory);
    let launch = null;
    let resolvedAs = "unknown";
    try {
      launch = await reader.launchedToken(address, block);
      resolvedAs = "token";
    } catch (error) {
      if (!(error instanceof NotAPonsLaunch)) throw error;
      const viaCurve = await tokenOfCurve(rpc, address, block);
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
    let v1 = null;
    if (!launch && options.factoryV1) {
      try {
        v1 = await readV1Launch(rpc, options.factoryV1, address, block, options.native ?? { symbol: "ETH", decimals: 18 });
        if (v1) resolvedAs = "token";
      } catch {
        v1 = null;
      }
    }
    const tokenAddress = launch ? launch.token.toLowerCase() : address;
    const token = await readContractId(rpc, tokenAddress, block);
    const curve = launch ? await readContractId(rpc, launch.curve.toLowerCase(), block) : null;
    const meta = token.code.empty ? null : await readMetaSafely(rpc, tokenAddress, block);
    return { input: address, resolvedAs, registered: launch !== null || v1 !== null, launchpad: launch ? "v2" : v1 ? "v1" : null, launch, v1, token, meta, curve };
  }
  async function readContractId(rpc, address, block) {
    const code = scanBytecode(await rpc.getCode(address, block));
    if (code.empty) return { address, code, proxyImplementation: null, proxyBeacon: null };
    const implementation = await rpc.getStorageAt(address, EIP1967_IMPLEMENTATION_SLOT, block);
    const beacon = await rpc.getStorageAt(address, EIP1967_BEACON_SLOT, block);
    return {
      address,
      code,
      proxyImplementation: storageWordIsSet(implementation) ? storageWordAddress(implementation) : null,
      proxyBeacon: storageWordIsSet(beacon) ? storageWordAddress(beacon) : null
    };
  }
  async function tokenOfCurve(rpc, curve, block) {
    try {
      const [raw] = await rpc.callBatch([{ to: curve, data: encodeCall(CURVE_FUNCTIONS.token, []) }], block);
      const [token] = decodeOutputs(CURVE_FUNCTIONS.token, raw);
      return token && token !== ZERO_ADDRESS ? token.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  async function readMetaSafely(rpc, token, block) {
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
      return null;
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
  async function readLookalikes(rpc, blockscout, subject, symbol, block, factory, searchBlocks, limit = 8) {
    const hits = await blockscout.searchTokens(symbol);
    const reader = new PonsReader(rpc, factory);
    const candidates = [];
    const wanted = symbol.toUpperCase();
    for (const hit of hits.filter((h) => h.symbol.toUpperCase() === wanted).slice(0, limit)) {
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
      candidates.push({ address: hit.address, name: hit.name, symbol: hit.symbol, registered, phase, launchBlock });
    }
    if (!candidates.some((c) => c.address === subject.toLowerCase())) {
      candidates.unshift({ address: subject.toLowerCase(), name: "", symbol, registered: true, phase: null, launchBlock: null });
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

  // src/bouncer/room.ts
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
    if (!factory) throw new Error(`${chain2.name}: the launchpad factory address is not published yet; pass --factory 0x\u2026`);
    await rpc.assertChain();
    const headNumber = await rpc.blockNumber();
    const head = await rpc.getBlock(headNumber);
    const searchBlocks = options.launchSearchBlocks ?? Math.round(7 * 86400 * chain2.blocksPerSecond);
    const id = await readIdCheck(rpc, input, head.number, factory, { factoryV1: chain2.factoryV1, native: chain2.native });
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
      notes: [],
      skipped: []
    };
    if (!id.launch) {
      slip.notes = doorNotes(slip);
      return slip;
    }
    const launch = id.launch;
    const attempt = async (section, run) => {
      try {
        await run();
      } catch (error) {
        slip.skipped.push({ section, reason: error instanceof Error ? error.message : String(error) });
      }
    };
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
    if (options.blockscout && !options.skipLookalikes && slip.id.meta) {
      await attempt("lookalikes", async () => {
        slip.lookalikes = await readLookalikes(rpc, options.blockscout, launch.token, slip.id.meta.symbol, head.number, factory, searchBlocks);
      });
    }
    if (!options.skipDev) {
      await attempt("dev report card", async () => {
        const hours = options.devHours ?? 24;
        const fromBlock = await findBlockByTimestamp(rpc, head.timestamp - hours * 3600, head.number);
        slip.dev = await readDevReport(rpc, launch.deployer, { fromBlock, toBlock: head.number, factory, chunking: options.chunkSize ? { startChunk: options.chunkSize, maxChunk: options.chunkSize } : void 0 });
      });
    }
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
      return notes;
    }
    if (!slip.id.registered) {
      notes.push({
        level: "stop",
        code: "not-registered",
        text: t.code.empty ? `No contract at this address on ${slip.chain.name}.` : `Not a ${slip.chain.launchpad} launch: neither the ${slip.chain.launchpad} factory${slip.chain.key === "robinhood" ? " nor the Pons V1 factory" : ""} has a record of this address. If it was launched elsewhere (another launchpad, or by hand), it is not a Pons token, whatever its name says.`
      });
      for (const f of findings) if (!f.startsWith("no bytecode")) notes.push({ level: "stop", code: "code", text: `Code can change or vanish: ${f}.` });
      return notes;
    }
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
    for (const s of slip.skipped) notes.push({ level: "info", code: "skipped", text: `${s.section} could not be read: ${s.reason}` });
    return notes;
  }
  function slipJson(value) {
    return JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2);
  }

  // src/bouncer/mascot.ts
  var MASCOT_SVG_INNER = `<rect x="11" y="1" width="10" height="1" fill="#3e3e4c"/><rect x="9" y="2" width="14" height="1" fill="#3e3e4c"/><rect x="8" y="3" width="16" height="1" fill="#3e3e4c"/><rect x="7" y="4" width="18" height="1" fill="#3e3e4c"/><rect x="6" y="5" width="5" height="1" fill="#3e3e4c"/><rect x="11" y="5" width="10" height="1" fill="#757584"/><rect x="21" y="5" width="5" height="1" fill="#3e3e4c"/><rect x="6" y="6" width="4" height="1" fill="#3e3e4c"/><rect x="10" y="6" width="12" height="1" fill="#757584"/><rect x="22" y="6" width="4" height="1" fill="#3e3e4c"/><rect x="5" y="7" width="4" height="1" fill="#3e3e4c"/><rect x="9" y="7" width="14" height="1" fill="#0a0a0e"/><rect x="23" y="7" width="4" height="1" fill="#3e3e4c"/><rect x="5" y="8" width="4" height="1" fill="#3e3e4c"/><rect x="9" y="8" width="14" height="1" fill="#0a0a0e"/><rect x="23" y="8" width="4" height="1" fill="#3e3e4c"/><rect x="27" y="8" width="1" height="1" fill="#d4a017"/><rect x="5" y="9" width="4" height="1" fill="#3e3e4c"/><rect x="9" y="9" width="1" height="1" fill="#757584"/><rect x="10" y="9" width="12" height="1" fill="#0a0a0e"/><rect x="22" y="9" width="1" height="1" fill="#757584"/><rect x="23" y="9" width="4" height="1" fill="#3e3e4c"/><rect x="27" y="9" width="1" height="1" fill="#d4a017"/><rect x="5" y="10" width="4" height="1" fill="#3e3e4c"/><rect x="9" y="10" width="14" height="1" fill="#757584"/><rect x="23" y="10" width="4" height="1" fill="#3e3e4c"/><rect x="28" y="10" width="1" height="1" fill="#d4a017"/><rect x="5" y="11" width="4" height="1" fill="#3e3e4c"/><rect x="9" y="11" width="4" height="1" fill="#757584"/><rect x="13" y="11" width="2" height="1" fill="#1c1c22"/><rect x="15" y="11" width="2" height="1" fill="#757584"/><rect x="17" y="11" width="2" height="1" fill="#1c1c22"/><rect x="19" y="11" width="4" height="1" fill="#757584"/><rect x="23" y="11" width="4" height="1" fill="#3e3e4c"/><rect x="28" y="11" width="1" height="1" fill="#d4a017"/><rect x="6" y="12" width="3" height="1" fill="#3e3e4c"/><rect x="9" y="12" width="14" height="1" fill="#757584"/><rect x="23" y="12" width="3" height="1" fill="#3e3e4c"/><rect x="28" y="12" width="1" height="1" fill="#d4a017"/><rect x="6" y="13" width="4" height="1" fill="#3e3e4c"/><rect x="10" y="13" width="12" height="1" fill="#757584"/><rect x="22" y="13" width="4" height="1" fill="#3e3e4c"/><rect x="7" y="14" width="4" height="1" fill="#3e3e4c"/><rect x="11" y="14" width="10" height="1" fill="#757584"/><rect x="21" y="14" width="4" height="1" fill="#3e3e4c"/><rect x="8" y="15" width="16" height="1" fill="#3e3e4c"/><rect x="4" y="16" width="24" height="1" fill="#3e3e4c"/><rect x="2" y="17" width="9" height="1" fill="#3e3e4c"/><rect x="11" y="17" width="12" height="1" fill="#111117"/><rect x="23" y="17" width="8" height="1" fill="#3e3e4c"/><rect x="1" y="18" width="10" height="1" fill="#3e3e4c"/><rect x="11" y="18" width="12" height="1" fill="#111117"/><rect x="23" y="18" width="9" height="1" fill="#3e3e4c"/><rect x="1" y="19" width="10" height="1" fill="#3e3e4c"/><rect x="11" y="19" width="5" height="1" fill="#111117"/><rect x="16" y="19" width="2" height="1" fill="#c8102e"/><rect x="18" y="19" width="5" height="1" fill="#111117"/><rect x="23" y="19" width="9" height="1" fill="#3e3e4c"/><rect x="1" y="20" width="5" height="1" fill="#3e3e4c"/><rect x="7" y="20" width="19" height="1" fill="#3e3e4c"/><rect x="27" y="20" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="21" width="5" height="1" fill="#3e3e4c"/><rect x="7" y="21" width="19" height="1" fill="#3e3e4c"/><rect x="27" y="21" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="22" width="5" height="1" fill="#3e3e4c"/><rect x="7" y="22" width="2" height="1" fill="#3e3e4c"/><rect x="9" y="22" width="4" height="1" fill="#757584"/><rect x="13" y="22" width="8" height="1" fill="#3e3e4c"/><rect x="21" y="22" width="4" height="1" fill="#757584"/><rect x="25" y="22" width="1" height="1" fill="#3e3e4c"/><rect x="27" y="22" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="23" width="5" height="1" fill="#3e3e4c"/><rect x="7" y="23" width="2" height="1" fill="#3e3e4c"/><rect x="9" y="23" width="5" height="1" fill="#757584"/><rect x="14" y="23" width="6" height="1" fill="#3e3e4c"/><rect x="20" y="23" width="5" height="1" fill="#757584"/><rect x="25" y="23" width="1" height="1" fill="#3e3e4c"/><rect x="27" y="23" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="24" width="5" height="1" fill="#3e3e4c"/><rect x="7" y="24" width="19" height="1" fill="#3e3e4c"/><rect x="27" y="24" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="25" width="5" height="1" fill="#3e3e4c"/><rect x="8" y="25" width="17" height="1" fill="#3e3e4c"/><rect x="27" y="25" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="26" width="5" height="1" fill="#3e3e4c"/><rect x="10" y="26" width="12" height="1" fill="#111117"/><rect x="27" y="26" width="5" height="1" fill="#3e3e4c"/><rect x="1" y="27" width="5" height="1" fill="#757584"/><rect x="10" y="27" width="12" height="1" fill="#111117"/><rect x="27" y="27" width="5" height="1" fill="#757584"/><rect x="1" y="28" width="5" height="1" fill="#757584"/><rect x="10" y="28" width="12" height="1" fill="#111117"/><rect x="27" y="28" width="5" height="1" fill="#757584"/><rect x="11" y="29" width="5" height="1" fill="#3e3e4c"/><rect x="17" y="29" width="5" height="1" fill="#3e3e4c"/><rect x="11" y="30" width="5" height="1" fill="#3e3e4c"/><rect x="17" y="30" width="5" height="1" fill="#3e3e4c"/><rect x="10" y="31" width="6" height="1" fill="#111117"/><rect x="17" y="31" width="6" height="1" fill="#111117"/>`;

  // src/bouncer/planner.ts
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
  var HOSTED = "https://kepochnik.github.io/kepochnik/";
  var DEFAULT_PROXY = "";
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
  function chain() {
    return mode === "demo" ? CHAINS.robinhood : chainByKey(chainSelect.value);
  }
  function setMode(next, silent = false) {
    mode = next;
    $("mode-demo").setAttribute("aria-pressed", String(next === "demo"));
    $("mode-live").setAttribute("aria-pressed", String(next === "live"));
    chainSelect.disabled = next === "demo";
    sourcePill.textContent = next === "demo" ? "Demo data" : `Live \xB7 ${chain().name}`;
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
    if (parts.length === 2 && ADDR.test(parts[0]) && ADDR.test(parts[1])) return { view: "wallet", parts };
    if (parts.length === 1 && ADDR.test(parts[0])) return { view: "door", parts };
    if (parts.length === 1 && /^0x[0-9a-fA-F]{64}$/.test(parts[0])) return { view: "tx", parts };
    if (parts.length === 1 && /^0x/.test(parts[0]) && mode === "demo" && /^0xdemo/i.test(parts[0])) return { view: "tx", parts };
    return null;
  }
  function proxyBase() {
    return (proxyInput.value.trim() || DEFAULT_PROXY).replace(/\/$/, "");
  }
  function rpcFor() {
    if (mode === "demo") return demoRpc();
    const c = chain();
    const url = rpcInput.value.trim();
    const proxy = proxyBase();
    const urls = url ? [url] : proxy ? [`${proxy}/rpc/${c.key}`, ...c.rpc] : c.rpc;
    return new RpcClient({ urls, expectedChainId: c.chainId, minSpacingMs: 120 });
  }
  function blockscoutFor() {
    if (mode === "demo") return new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() });
    const c = chain();
    if (!c.blockscout) return null;
    const proxy = proxyBase();
    return new BlockscoutClient({ baseUrl: proxy ? `${proxy}/api/${c.key}` : c.blockscout });
  }
  function factoryFor() {
    const c = chain();
    const f = (mode === "live" ? factoryInput.value.trim() : "") || c.factory || "";
    if (!f) throw new Error(`${c.name}: ${c.notes ?? "no factory known; paste it under live settings"}`);
    return f.toLowerCase();
  }
  var EXAMPLES = [
    { label: "A fresh launch", hint: "9 s old, door tax still open", hash: `#/demo/${DEMO.tokens.fresh.token}` },
    { label: "A graduated token", hint: "filled its curve in 212 s", hash: `#/demo/${DEMO.tokens.sprint.token}` },
    { label: "A fake copy", hint: "same name, not from the factory", hash: `#/demo/${DEMO_IMPOSTOR.token}` },
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
    const c = mode === "demo" ? "demo" : chain().key;
    more.innerHTML = `<span>More:</span><a href="#/board?chain=${c}">Tonight's board</a><a href="#/plan?tax=100&chain=${c}">Plan a launch</a><span>Paste "token wallet" (two addresses) to see one wallet's bag.</span>`;
    chips.appendChild(more);
  }
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
    return Object.values(DEMO.tokens).some((t) => t.token === a || t.curve === a || t.deployer === a) || a === DEMO_IMPOSTOR.token || a === DEMO_V1.token || a === DEMO_V1.deployer || a === "0x000000000000000000000000000000000000dead";
  }
  async function runDoor(address) {
    if (!ADDR.test(address)) return bad("Paste a 20-byte hex address: the token or its bonding curve, 0x followed by 40 hex characters.");
    if (mode === "demo" && !isDemoAddress(address)) {
      setMode("live");
      showToast(`Real address: switched to live on ${chain().name}`);
      location.hash = `#/t/${address.toLowerCase()}?chain=${chain().key}`;
      return;
    }
    busy("reading the chain at the door\u2026");
    try {
      const slip = await readDoor(rpcFor(), address, mode === "demo" ? { chain: CHAINS.robinhood, factory: factoryFor(), blockscout: blockscoutFor(), devHours: 8, chunkSize: 1e5, launchSearchBlocks: 4e5 } : { chain: chain(), factory: factoryFor(), blockscout: blockscoutFor(), devHours: 24 });
      done(`block ${slip.at.block} \xB7 ${isoUtc(slip.at.timestamp)} \xB7 ${slip.notes.length} thing${slip.notes.length === 1 ? "" : "s"} to know`);
      renderSlip(slip);
    } catch (error) {
      failed(error, address);
    } finally {
      go.disabled = false;
    }
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
    if (!slip.id.registered) {
      const t = slip.id.token;
      if (t.code.empty) return `There is no contract at this address on ${slip.chain.name}.`;
      const flags = [];
      if (t.proxyImplementation || t.code.minimalProxyTarget) flags.push("its code can be swapped (proxy)");
      if (t.code.opcodes.selfdestruct) flags.push("it can self-destruct");
      if (t.code.opcodes.delegatecall) flags.push("it delegates calls");
      return `Not a ${slip.chain.launchpad} launch: the factory never deployed this contract${flags.length ? `, and ${flags.join(", ")}` : ""}. Anything sold under this name is not the token.`;
    }
    const parts = [`Real ${slip.chain.launchpad} launch`];
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
  function renderSlip(slip) {
    const meta = slip.id.meta;
    const c0 = chain();
    const explorer = c0.blockscout ? `${c0.blockscout}/address/${slip.subject}` : null;
    const sym = meta ? esc2(meta.symbol) : shortAddress(slip.subject);
    const name = meta ? esc2(meta.name) : slip.id.token.code.empty ? "no contract at this address" : "unregistered contract";
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
      </div>` : "";
    const notes = slip.notes.map((n) => `<div class="note"><span class="lvl ${n.level}">${LEVEL_WORD[n.level]}</span><span>${esc2(n.text)}</span></div>`).join("");
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
    const section = (id, title, what, body, open) => `<details class="sec" id="${id}"${open ? " open" : ""}><summary><h2>${title}</h2><span class="what">${what}</span><span class="chev">\u25B6</span></summary><div class="body">${body}</div></details>`;
    const idBody = `<dl class="kv">
    <dt>chain</dt><dd>${esc2(slip.chain.name)} \xB7 ${esc2(slip.chain.launchpad)}</dd>
    <dt>factory record</dt><dd>${registered ? `<span class="flag ok">yes</span> ${v1 ? "the Pons V1 factory" : "the launchpad's own factory"} deployed this token${slip.id.resolvedAs === "curve" ? " (you pasted its curve)" : ""}` : `<span class="flag bad">none</span> neither the ${esc2(slip.chain.launchpad)} factory${slip.chain.key === "robinhood" ? " nor the Pons V1 factory" : ""} has seen this address`}</dd>
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
    const watchBody = `<div class="watch"><button class="ghost" id="act-watch" type="button" aria-pressed="false">Start watching</button><span style="color:var(--muted);font-size:13px">Checks every ${mode === "demo" ? "5" : "15"} s while this tab is open: the dev selling or moving tokens, the tax recipient changing, buyback switching, graduation${crew?.crews.length ? `, and ${crew.crews.flatMap((x) => x.wallets).length} grouped wallets leaving together` : ""}. Browser notifications if you allow them.</span></div><div class="events"></div>`;
    out.innerHTML = `<div class="slip">
    <div class="summary">
      <div class="top">
        <div class="who"><div class="sym">${sym}</div><div class="name">${name}</div><div class="addr">${esc2(slip.subject)}</div><div class="at">${mode === "demo" ? "DEMO \xB7 " : ""}${esc2(slip.chain.name)} \xB7 block ${slip.at.block} \xB7 ${isoUtc(slip.at.timestamp)}</div></div>
        <div class="stamp ${slip.stamp === "ON THE LIST" ? "" : "no"}">${slip.stamp}</div>
      </div>
      <p class="lead">${esc2(summarySentence(slip))}</p>
      ${tiles}
      <div class="actions" style="margin-top:16px">
        <button class="ghost" id="act-card" type="button">Show as image</button>
        <button class="ghost" id="act-json" type="button">Copy JSON</button>
        <button class="ghost" id="act-link" type="button">Copy link</button>
      </div>
    </div>
    <div class="card-wrap" id="card"></div>
    <div class="notes"><h2>What to know</h2>${notes || `<div class="note"><span class="lvl info">Note</span><span>Nothing stands out. The factory made this token and none of its terms needs a second look.</span></div>`}</div>
    <div class="stack">
      ${section("s-id", "Is it real?", "Did the launchpad's factory deploy this token, and can its code change later?", idBody, true)}
      ${registered && !v1 ? section("s-cover", "Door tax", `The anti-snipe tax in the first ${c?.terms.seconds ?? 15} seconds, and who paid it.`, coverBody, c?.status === "open") : ""}
      ${r ? section("s-rules", "Fees and rules", "What every trade costs, where the creator's cut goes, what buyback really does.", rulesBody, false) : ""}
      ${v1 ? section("s-v1", "Rules (Pons V1)", "How this older kind of launch works: pool from block one, launch caps, locked liquidity.", `<ol class="rules">${v1.rules.map((x) => `<li>${esc2(x)}</li>`).join("")}</ol>`, true) : ""}
      ${e ? section("s-exit", "Cash out now", "What you would actually get for selling part or all of a position right now.", exitBody, false) : ""}
      ${room ? section("s-room", "Who is inside", "Every buyer since launch, how much the creator's own wallets put in, buys landing in the same block.", roomBody, false) : ""}
      ${crew ? section("s-crew", "Same funder?", "Where the first buyers got their money. Wallets funded by one address before the launch are one group.", crewBody, false) : ""}
      ${l ? section("s-look", "Same name", "Other tokens with this ticker on the chain, and which one launched first.", lookBody, false) : ""}
      ${d ? section("s-dev", "This dev before", `Everything this deployer launched in the last ${mode === "demo" ? "8" : "24"} h and how it went.`, devSection(d, slip.subject, false, true), false) : ""}
      ${registered && !v1 ? section("s-watch", "Watch for changes", "Get told when the dev moves, right in this tab.", watchBody, new URLSearchParams(location.hash.split("?")[1] ?? "").get("watch") === "1") : ""}
    </div>
  </div>`;
    $("act-card").addEventListener("click", () => {
      const wrap = $("card");
      if (!wrap.classList.contains("open")) wrap.innerHTML = doorCard(slip, { repoUrl: REPO, ticker: MARK, mascotSvg: MASCOT_SVG_INNER });
      wrap.classList.toggle("open");
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
    const c = mode === "demo" ? "demo" : chain().key;
    let hash;
    if (view === "plan") hash = `#/plan?tax=${encodeURIComponent(v || "100")}&chain=${c}`;
    else if (view === "board") hash = `#/board?hours=${encodeURIComponent(v || "1")}&chain=${c}`;
    else if (view === "dev" && ADDR.test(v)) hash = `#/dev/${v.toLowerCase()}?chain=${c}`;
    else {
      const found = detect(v);
      if (!found) return bad("Paste a token or curve address (0x + 40 hex characters), a transaction hash (0x + 64), or a token and a wallet address separated by a space.");
      if (found.view === "wallet") hash = `#/wallet/${found.parts[0].toLowerCase()}/${found.parts[1].toLowerCase()}?chain=${c}`;
      else if (found.view === "tx") hash = `#/tx/${found.parts[0]}?chain=${c}`;
      else hash = `#/${mode === "demo" ? "demo" : "t"}/${found.parts[0].toLowerCase()}${mode === "demo" ? "" : `?chain=${c}`}`;
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
    chainSelect.value = storage("bouncer.chain") ?? "robinhood";
    rpcInput.addEventListener("change", () => storage("bouncer.rpc", rpcInput.value.trim()));
    factoryInput.addEventListener("change", () => storage("bouncer.factory", factoryInput.value.trim()));
    chainSelect.addEventListener("change", () => {
      storage("bouncer.chain", chainSelect.value);
      const c = chainByKey(chainSelect.value);
      $("chain-hint").textContent = `${c.name} (${c.chainId}) \xB7 ${c.launchpad} \xB7 RPC ${c.rpc[0]}${c.blockscout ? ` \xB7 explorer ${c.blockscout}` : " \xB7 no explorer known, the funder check and same-name search are off"}${c.notes ? ` \xB7 ${c.notes}` : ""}`;
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
