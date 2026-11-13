import { Socket } from "node:net";

type WriteCallback = (error?: Error | null) => void;
type SocketWrite = (this: Socket, chunk: unknown, encoding: BufferEncoding, callback: WriteCallback) => unknown;

const originalWrite: SocketWrite = Socket.prototype._write;

/** One hold, from holdLargeSocketWrites to restoreSocketWrites; its writes keep it after a later hold. */
interface HoldCycle { releasing: boolean; held: Set<() => void> }
let cycle: HoldCycle | null = null;

/**
 * Holds the completion of every `node:net` socket write of at least `minBytes`, the way a send
 * buffer the peer does not drain holds it on Linux and macOS: the bytes still go out as the peer
 * reads them, but the write never reports completion, and the socket ending or closing fails it, as
 * Bun fails a write still waiting on its native socket.
 *
 * Size alone cannot give a test that state. Bun completes a plain TCP write once the operating system
 * accepts it, and Windows can take a whole large nonblocking send into its socket buffer (on the
 * Windows runners a 48 MiB write to a Home that never reads it completed immediately). Smaller writes
 * (the relay-auth challenge, headers) complete as usual. A write error and the socket ending or
 * closing settle a held write at once; each write settles once. {@link releaseHeldSocketWrites} lets
 * successful completions through, and {@link restoreSocketWrites} releases whatever this hold still
 * holds before undoing it, so a completion arriving after the restore is never kept by a later hold.
 * `base` is the write being wrapped; only the helper's own tests pass one.
 */
export function holdLargeSocketWrites(minBytes: number, base: SocketWrite = originalWrite): void {
  const current: HoldCycle = { releasing: false, held: new Set() };
  cycle = current;
  Socket.prototype._write = function (this: Socket, chunk: unknown, encoding: BufferEncoding, callback: WriteCallback) {
    const size = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : (chunk as Uint8Array).byteLength;
    if (size < minBytes) return base.call(this, chunk, encoding, callback);
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      current.held.delete(complete);
      this.removeListener("end", closed).removeListener("close", closed);
      callback(error);
    };
    const complete = () => settle();
    const closed = () => settle(Object.assign(new Error("write failed: the socket closed before it completed"), { code: "ERR_SOCKET_CLOSED" }));
    this.prependOnceListener("end", closed).prependOnceListener("close", closed);
    return base.call(this, chunk, encoding, (error?: Error | null) => {
      if (settled) return; // Already failed by the socket ending or closing; nothing to hold.
      if (error) settle(error);
      else if (current.releasing) complete();
      else current.held.add(complete);
    });
  };
}

/** Let this hold's held and later successful completions through, as a drained buffer would. Idempotent. */
export function releaseHeldSocketWrites(): void {
  if (!cycle) return;
  cycle.releasing = true;
  for (const complete of [...cycle.held]) complete();
}

/** Release what the current hold still holds and put the real write back. */
export function restoreSocketWrites(): void {
  releaseHeldSocketWrites();
  cycle = null;
  Socket.prototype._write = originalWrite;
}

/** Test seam for the helper's own tests: how many completions the current hold is keeping. */
export function heldSocketWriteCountForTests(): number {
  return cycle?.held.size ?? 0;
}
