/**
 * `doctor`: prove the read path works before trusting any receipt.
 * Checks the RPC answers, reports chain 4663, has the Pons V2 factory
 * bytecode at the expected address, and returns the current anti-snipe terms.
 */
import { decodeOutputs, encodeCall } from "../chain/abi.js";
import { FACTORY_FUNCTIONS, PONS_V2_FACTORY } from "../chain/pons.js";
import { chainById } from "../chain/chains.js";
import type { RpcClient } from "../chain/rpc.js";
import type { Receipt } from "../receipt.js";

export interface DoctorReport {
  ok: boolean;
  rpcUrl: string;
  chainId: number | null;
  latestBlock: number | null;
  blockTimestamp: number | null;
  latencyMs: number | null;
  factoryHasCode: boolean | null;
  snipeTaxStartBps: bigint | null;
  snipeTaxSeconds: bigint | null;
  errors: string[];
}

export async function runDoctor(rpc: RpcClient, now: () => number = () => Date.now(), factory: string | null = PONS_V2_FACTORY): Promise<DoctorReport> {
  const report: DoctorReport = {
    ok: false,
    rpcUrl: rpc.activeUrl,
    chainId: null,
    latestBlock: null,
    blockTimestamp: null,
    latencyMs: null,
    factoryHasCode: null,
    snipeTaxStartBps: null,
    snipeTaxSeconds: null,
    errors: [],
  };
  try {
    const started = now();
    report.chainId = await rpc.chainId();
    report.latencyMs = now() - started;
    if (!chainById(report.chainId)) {
      report.errors.push(`chain id ${report.chainId} is not one BOUNCER knows`);
    }
    const block = await rpc.getBlock("latest");
    report.latestBlock = block.number;
    report.blockTimestamp = block.timestamp;
    // A chain with no launchpad has nothing to check for one, and that is not a
    // problem with the read path: skipping it must not leave the report unfinished.
    if (factory) {
      const code = (await rpc.send("eth_getCode", [factory, "latest"])) as string;
      report.factoryHasCode = typeof code === "string" && code.length > 2;
      if (!report.factoryHasCode) report.errors.push(`no bytecode at the launchpad factory ${factory}`);
      const [startRaw, secondsRaw] = await rpc.callBatch(
        [
          { to: factory, data: encodeCall(FACTORY_FUNCTIONS.snipeTaxStartBps, []) },
          { to: factory, data: encodeCall(FACTORY_FUNCTIONS.snipeTaxSeconds, []) },
        ],
        block.number,
      );
      report.snipeTaxStartBps = decodeOutputs(FACTORY_FUNCTIONS.snipeTaxStartBps, startRaw)[0] as bigint;
      report.snipeTaxSeconds = decodeOutputs(FACTORY_FUNCTIONS.snipeTaxSeconds, secondsRaw)[0] as bigint;
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
  report.rpcUrl = rpc.activeUrl;
  report.ok = report.errors.length === 0;
  return report;
}

export function doctorReceipt(report: DoctorReport, toolName: string, chainName = "Robinhood Chain", factory: string | null = PONS_V2_FACTORY): Receipt {
  return {
    title: `${toolName} doctor`,
    subtitle: report.ok ? "read path healthy" : "read path has problems",
    sections: [
      {
        title: chainName,
        rows: [
          { label: "rpc", value: report.rpcUrl },
          { label: "chain id", value: report.chainId, note: chainById(report.chainId ?? -1)?.name ?? "unexpected" },
          { label: "latest block", value: report.latestBlock },
          { label: "block time", value: report.blockTimestamp === null ? null : new Date(report.blockTimestamp * 1000).toISOString() },
          { label: "rpc latency", value: report.latencyMs === null ? null : `${report.latencyMs} ms` },
        ],
      },
      ...(factory
        ? [
            {
              title: "launchpad factory",
              rows: [
                { label: "address", value: factory },
                { label: "bytecode", value: report.factoryHasCode },
                { label: "snipe tax start", value: report.snipeTaxStartBps === null ? null : `${Number(report.snipeTaxStartBps) / 100}%` },
                { label: "snipe tax window", value: report.snipeTaxSeconds === null ? null : `${report.snipeTaxSeconds}s` },
              ],
            },
          ]
        : [
            {
              title: "launchpad",
              rows: [{ label: "factory", value: "none known on this chain", note: "every address here is checked as an ordinary token" }],
            },
          ]),
      {
        title: "Boundaries",
        rows: [
          { label: "keys", value: "none" },
          { label: "signing", value: "none" },
          { label: "transactions", value: "none" },
        ],
      },
    ],
    footnotes: report.errors.length ? report.errors : ["Every value above was read from the chain at the moment shown; nothing is cached or inferred."],
    meta: { ok: report.ok },
  };
}
