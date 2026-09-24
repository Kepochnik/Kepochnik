// Minimal read-only JSON-RPC client. No signing, no sends: eth_call only.

export class RpcError extends Error {}

export function createRpc(url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let id = 0;
  return {
    /** Returns the hex result, or null when the call reverts. */
    async call(to, data) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'eth_call', params: [{ to, data }, 'latest'] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new RpcError(`RPC ${url} answered HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) {
        if (/revert/i.test(body.error.message ?? '')) return null;
        throw new RpcError(`RPC error: ${body.error.message}`);
      }
      return body.result === '0x' ? null : body.result;
    },
  };
}

/** Splits an ABI-encoded return value into 32-byte words as BigInts. */
export function words(hex) {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(BigInt('0x' + body.slice(i, i + 64)));
  return out;
}

export function encodeUint(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

/** Reads an int256 word (Chainlink answers are signed). */
export function toSigned(word) {
  return word >= 1n << 255n ? word - (1n << 256n) : word;
}
