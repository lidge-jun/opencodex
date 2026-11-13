import { Socket } from "node:net";

type WriteCallback = (error?: Error | null) => void;

const originalWrite = Socket.prototype._write;
/** Successful completions held until released; each settles its write once. */
const heldCompletions = new Set<() => void>();
let releasing = false;

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
 * closing settle a held write at once; {@link releaseHeldSocketWrites} lets successful completions
 * through, and {@link restoreSocketWrites} releases whatever is still held before undoing the hold.
 */
export function holdLargeSocketWrites(minBytes: number): void {
  releasing = false;
  Socket.prototype._write = function (this: Socket, chunk: unknown, encoding: BufferEncoding, callback: WriteCallback) {
    const size = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : (chunk as Uint8Array).byteLength;
    if (size < minBytes) return originalWrite.call(this, chunk, encoding, callback);
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      heldCompletions.delete(complete);
      this.removeListener("end", closed).removeListener("close", closed);
      callback(error);
    };
    const complete = () => settle();
    const closed = () => settle(Object.assign(new Error("write failed: the socket closed before it completed"), { code: "ERR_SOCKET_CLOSED" }));
    this.prependOnceListener("end", closed).prependOnceListener("close", closed);
    return originalWrite.call(this, chunk, encoding, (error?: Error | null) => {
      if (error) settle(error);
      else if (releasing) complete();
      else heldCompletions.add(complete);
    });
  };
}

/** Let held and later successful completions through, as a send buffer the peer drained would. Idempotent. */
export function releaseHeldSocketWrites(): void {
  releasing = true;
  for (const complete of [...heldCompletions]) complete();
}

export function restoreSocketWrites(): void {
  releaseHeldSocketWrites();
  Socket.prototype._write = originalWrite;
}
