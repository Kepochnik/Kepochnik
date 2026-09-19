/**
 * One JSON-RPC batch, assembled a question at a time.
 *
 * A door check asks the chain about forty things, and almost none of them
 * need another's answer. Written as a queue of awaits that is forty round
 * trips; at a quarter-second each, ten seconds of a reader watching a
 * spinner. Written as slots it is one.
 *
 * Reserve a slot for each question, run once, then read the answers back.
 * Three rules make it safe to use everywhere:
 *
 *   1. A call the node answered with an error comes back AS that error, in
 *      its own slot. A contract without a token() view is the ordinary case
 *      at this door, not a failure, and it must not discard the nine reads
 *      sharing its batch.
 *   2. An endpoint that refuses batches — they exist — is retried one
 *      request at a time rather than reported as forty dead reads.
 *   3. A question that could not be asked at all reads back as an error,
 *      never as a zero. Every caller here already tells "no" apart from
 *      "could not ask", and this keeps that distinction intact.
 */
import type { Hex } from "./abi.js";
import { RpcError, type RpcClient, type RpcRequest } from "./rpc.js";

export class ReadBatch {
  private readonly requests: RpcRequest[] = [];
  private answers: (unknown | RpcError)[] = [];
  private ran = false;

  constructor(
    private readonly rpc: RpcClient,
    private readonly block: number,
  ) {}

  private slot(request: RpcRequest): number {
    if (this.ran) throw new Error("ReadBatch: add every question before run()");
    this.requests.push(request);
    return this.requests.length - 1;
  }

  /** An eth_call, pinned to this batch's block. */
  call(to: string, data: Hex): number {
    return this.slot({ method: "eth_call", params: [{ to, data }, this.tag] });
  }

  /** An eth_call from a given sender, which is how a transfer is simulated. */
  callFrom(from: string, to: string, data: Hex): number {
    return this.slot({ method: "eth_call", params: [{ from, to, data }, this.tag] });
  }

  getCode(address: string): number {
    return this.slot({ method: "eth_getCode", params: [address, this.tag] });
  }

  getStorageAt(address: string, storageSlot: Hex): number {
    return this.slot({ method: "eth_getStorageAt", params: [address, storageSlot, this.tag] });
  }

  get size(): number {
    return this.requests.length;
  }

  private get tag(): string {
    return `0x${this.block.toString(16)}`;
  }

  async run(): Promise<void> {
    this.ran = true;
    if (!this.requests.length) return;
    try {
      this.answers = await this.rpc.sendBatchSettled(this.requests);
      return;
    } catch (whole) {
      // The batch itself did not get through. That is either a dead endpoint
      // or one that will not take batches, and the two are told apart by
      // trying again one at a time — cheap, because it only happens once.
      this.answers = [];
      for (const request of this.requests) {
        try {
          this.answers.push(await this.rpc.send(request.method, request.params));
        } catch (single) {
          this.answers.push(asRpcError(single));
        }
      }
      if (this.answers.every((answer) => answer instanceof RpcError)) {
        // Nothing got through either way: the endpoint is the problem, and
        // the original failure describes it better than the last retry does.
        const failure = asRpcError(whole);
        this.answers = this.requests.map(() => failure);
      }
    }
  }

  /**
   * The raw answer at a slot: the hex the node returned, the error it gave,
   * or null when the question was never asked (slot === null).
   */
  answer(slot: number | null): Hex | RpcError | null {
    if (slot === null) return null;
    const value = this.answers[slot];
    if (value instanceof RpcError) return value;
    if (typeof value === "string") return value as Hex;
    return new RpcError("no answer in the batch for this read");
  }

  /** The hex at a slot, or null for anything that is not a readable answer. */
  hex(slot: number | null): Hex | null {
    const value = this.answer(slot);
    return value === null || value instanceof RpcError ? null : value;
  }
}

function asRpcError(error: unknown): RpcError {
  return error instanceof RpcError ? error : new RpcError(error instanceof Error ? error.message : String(error));
}
