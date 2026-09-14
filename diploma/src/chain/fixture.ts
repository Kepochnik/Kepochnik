/**
 * Replays recorded JSON-RPC answers so `demo` and the tests run with no
 * network. A fixture is a plain object keyed by `method|params` and is
 * clearly synthetic: it never impersonates a live block.
 */
import type { RpcRequest } from "./rpc.js";

export interface RpcFixture {
  chainId: number;
  description: string;
  answers: Record<string, unknown>;
}

export function fixtureKey(request: RpcRequest): string {
  return `${request.method}|${JSON.stringify(request.params)}`;
}

export function fixtureFetch(fixture: RpcFixture): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RpcJson | RpcJson[];
    const requests = Array.isArray(body) ? body : [body];
    const responses = requests.map((request) => {
      if (request.method === "eth_chainId") {
        return { jsonrpc: "2.0", id: request.id, result: `0x${fixture.chainId.toString(16)}` };
      }
      const key = fixtureKey(request);
      if (!(key in fixture.answers)) {
        return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: `fixture has no answer for ${key}` } };
      }
      return { jsonrpc: "2.0", id: request.id, result: fixture.answers[key] };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** Records every answer a live fetch returns so it can be replayed later. */
export function recordingFetch(live: typeof fetch, into: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await live(url, init);
    const clone = response.clone();
    const body = JSON.parse(String(init?.body)) as RpcJson | RpcJson[];
    const requests = Array.isArray(body) ? body : [body];
    const payload = (await clone.json()) as RpcResponse | RpcResponse[];
    const responses = Array.isArray(payload) ? payload : [payload];
    for (const request of requests) {
      const match = responses.find((item) => item.id === request.id);
      if (match && "result" in match) into[fixtureKey(request)] = match.result;
    }
    return response;
  }) as typeof fetch;
}

interface RpcJson {
  id: number;
  method: string;
  params: unknown[];
}

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}
