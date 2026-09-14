#!/usr/bin/env node
// Read-only MCP server over stdio. Configure in an agent as:
//   { "mcpServers": { "bouncer": { "command": "node", "args": ["bin/bouncer-mcp.mjs"] } } }
// Optional env: RPC_URL_ROBINHOOD, RPC_URL_ARC, RPC_URL_ARC_TESTNET, FACTORY_ARC, BOUNCER_DEMO=1
import { createMcpServer, serveStdio } from "../dist/src/mcp/server.js";
import { RpcClient } from "../dist/src/chain/rpc.js";
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
});
process.stdin.setEncoding("utf8");
await serveStdio(server, process.stdin, process.stdout);
