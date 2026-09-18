#!/usr/bin/env node
// Read-only MCP server over stdio. Configure in an agent as:
//   { "mcpServers": { "bouncer": { "command": "node", "args": ["bin/bouncer-mcp.mjs"] } } }
// Optional env: RPC_URL_<CHAIN> for any chain key (ROBINHOOD, BASE, BNB, SOLANA, ARC, ARC_TESTNET),
//               FACTORY_<CHAIN>, BOUNCER_DEMO=1
import { createMcpServer, serveStdio } from "../dist/src/mcp/server.js";
import { RpcClient } from "../dist/src/chain/rpc.js";
import { SolanaRpc } from "../dist/src/chain/solana.js";
import { BlockscoutClient } from "../dist/src/chain/blockscout.js";
import { DEMO_BLOCKSCOUT, demoBlockscoutFetch, demoRpc } from "../dist/src/bouncer/demo.js";

const demo = process.env.BOUNCER_DEMO === "1";
const server = createMcpServer({
  demo,
  rpcFor: (chain) => {
    if (demo) return demoRpc();
    const override = process.env[`RPC_URL_${chain.key.toUpperCase().replace(/-/g, "_")}`];
    return new RpcClient({ urls: override ? [override] : chain.rpc, expectedChainId: chain.chainId });
  },
  blockscoutFor: (chain) => (demo ? new BlockscoutClient({ baseUrl: DEMO_BLOCKSCOUT, fetchImpl: demoBlockscoutFetch() }) : chain.blockscout ? new BlockscoutClient({ baseUrl: chain.blockscout }) : null),
  factoryFor: (chain) => process.env[`FACTORY_${chain.key.toUpperCase().replace(/-/g, "_")}`] ?? chain.factory,
  // Without this an agent asking about a Solana mint is told the server was
  // started without a Solana endpoint, which was true of every server anyone
  // could have started.
  solanaRpcFor: (chain) => {
    const override = process.env[`RPC_URL_${chain.key.toUpperCase().replace(/-/g, "_")}`];
    return new SolanaRpc({ urls: override ? [override] : chain.rpc });
  },
});
process.stdin.setEncoding("utf8");
await serveStdio(server, process.stdin, process.stdout);
