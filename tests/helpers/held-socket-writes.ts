import { Socket } from "node:net";

type WriteCallback = (error?: Error | null) => void;

const originalWrite = Socket.prototype._write;

/**
 * Holds the completion of every `node:net` socket write of at least `minBytes`, the way a send
 * buffer the peer does not drain holds it on Linux and macOS: the bytes still go out as the peer
 * reads them, but the write never reports completion, and the socket ending or closing fails it, as
 * Bun fails a write still waiting on its native socket.
 *
 * Size alone cannot give a test that state. Bun completes a plain TCP write once the operating system
 * accepts it, and Windows can take a whole large nonblocking send into its socket buffer (on the
 * Windows runners a 48 MiB write to a Home that never reads it completed immediately). Smaller writes
 * (the relay-auth challenge, headers) complete as usual. Undo with {@link restoreSocketWrites}.
 */
export function holdLargeSocketWrites(minBytes: number): void {
  Socket.prototype._write = function (this: Socket, chunk: unknown, encoding: BufferEncoding, callback: WriteCallback) {
    const size = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : (chunk as Uint8Array).byteLength;
    if (size < minBytes) return originalWrite.call(this, chunk, encoding, callback);
    let settled = false;
    const settle = (error: Error) => {
      if (settled) return;
      settled = true;
      this.removeListener("end", closed).removeListener("close", closed);
      callback(error);
    };
    const closed = () => settle(Object.assign(new Error("write failed: the socket closed before it completed"), { code: "ERR_SOCKET_CLOSED" }));
    this.prependOnceListener("end", closed).prependOnceListener("close", closed);
    return originalWrite.call(this, chunk, encoding, (error?: Error | null) => { if (error) settle(error); });
  };
}

export function restoreSocketWrites(): void {
  Socket.prototype._write = originalWrite;
}
