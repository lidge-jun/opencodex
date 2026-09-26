import { connect as bunConnect, listen as bunListen, type Socket, type TCPSocketListener } from "bun";

/**
 * Loopback CONNECT entry for the ChatGPT desktop send-unblock PAC fallback.
 *
 * The PAC points chatgpt.com at this plaintext listener. It speaks only enough HTTP proxy to
 * accept `CONNECT chatgpt.com:443`, answer 200, and splice the raw bytes both ways onto the TLS
 * origin listener (which terminates the intercept). Anything else is refused: this is not a
 * general forward proxy, and the app only ever asks for the intercepted host here.
 *
 * When opencodex stops, this listener dies with the process; Chromium sees the refused CONNECT
 * and falls through the PAC chain on its own, with no app restart.
 */

const MAX_HEAD_BYTES = 8 * 1024;
const HEAD_TIMEOUT_SECONDS = 10;

/**
 * One direction of the splice. Bun sockets are unbuffered: `write()` takes what fits and
 * returns the count, so the remainder waits here and the producing socket stays paused until
 * the target drains. One dropped byte would corrupt the TLS stream the tunnel carries.
 */
interface Pipe {
  queue: Buffer[];
  /** The producing side closed; end the target once the queue is flushed. */
  ended: boolean;
}

interface EntryState {
  head: Buffer;
  /** Set once the CONNECT head parsed; the app socket is paused until the upstream attaches. */
  connecting: boolean;
  upstream: Socket | null;
  /** app -> origin */
  toUpstream: Pipe;
  /** origin -> app */
  toClient: Pipe;
}

export interface EntryProxyHandle {
  port: number;
  stop(): Promise<void>;
}

export interface StartEntryProxyOptions {
  /** Loopback port of the TLS origin listener the tunnels splice onto. */
  originPort: number;
  /** Test seam: bind a fixed port instead of an ephemeral one. */
  port?: number;
  /** Test seam: seconds a client has to finish its CONNECT head. */
  headTimeoutSeconds?: number;
}

/** Write what `target` accepts now and queue the rest, pausing `source` until `target` drains. */
function send<T, S>(target: Socket<T>, pipe: Pipe, bytes: Uint8Array, source: Socket<S>): void {
  if (pipe.queue.length === 0) {
    const wrote = target.write(bytes);
    // -1: the target is closed and its close handler tears the pair down.
    if (wrote < 0 || wrote === bytes.byteLength) return;
    bytes = bytes.subarray(wrote);
  }
  pipe.queue.push(Buffer.from(bytes));
  source.pause();
}

/** From the target's `drain`: flush the queue, then resume the source or finish the half. */
function flush<T, S>(target: Socket<T>, pipe: Pipe, source: Socket<S> | null): void {
  while (pipe.queue.length > 0) {
    const next = pipe.queue[0]!;
    const wrote = target.write(next);
    if (wrote < 0) {
      pipe.queue.length = 0;
      return;
    }
    if (wrote < next.length) {
      pipe.queue[0] = next.subarray(wrote);
      return;
    }
    pipe.queue.shift();
  }
  if (pipe.ended) target.end();
  else source?.resume();
}

/** The producer of `pipe` closed: end the target now, or once the queued bytes are written. */
function finish<T>(target: Socket<T>, pipe: Pipe): void {
  pipe.ended = true;
  if (pipe.queue.length === 0) target.end();
}

function refuse(socket: Socket<EntryState>, line: string): void {
  if (socket.data.upstream) return;
  socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
  socket.end();
}

function handleData(socket: Socket<EntryState>, chunk: Uint8Array, originPort: number): void {
  const state = socket.data;
  if (state.upstream) {
    send(state.upstream, state.toUpstream, chunk, socket);
    return;
  }
  if (state.connecting) {
    // Read before the pause took effect; it goes out right after the 200.
    state.toUpstream.queue.push(Buffer.from(chunk));
    return;
  }
  state.head = state.head.length === 0 ? Buffer.from(chunk) : Buffer.concat([state.head, Buffer.from(chunk)]);
  const end = state.head.indexOf("\r\n\r\n");
  if (end === -1) {
    if (state.head.length > MAX_HEAD_BYTES) refuse(socket, "431 Request Header Fields Too Large");
    return;
  }
  const head = state.head.subarray(0, end).toString("latin1");
  const leftover = state.head.subarray(end + 4);
  if (!/^CONNECT\s+chatgpt\.com:443\s+HTTP\/1\.[01]\r?$/i.test(head.split("\r\n")[0] ?? "")) {
    refuse(socket, "403 Forbidden");
    return;
  }
  // Answer exactly one CONNECT: later bytes are tunnel payload, never another head.
  state.connecting = true;
  socket.pause();
  if (leftover.length > 0) state.toUpstream.queue.push(Buffer.from(leftover));
  bunConnect({
    hostname: "127.0.0.1",
    port: originPort,
    socket: {
      data(upstream, upChunk) { send(socket, state.toClient, upChunk, upstream); },
      drain(upstream) { flush(upstream, state.toUpstream, socket); },
      close() { finish(socket, state.toClient); },
      error() { /* close follows */ },
    },
  }).then(upstream => {
    state.upstream = upstream;
    state.connecting = false;
    // The head deadline guards a silent client; a live tunnel may idle for as long as it likes.
    socket.timeout(0);
    send(socket, state.toClient, Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n"), upstream);
    flush(upstream, state.toUpstream, socket);
  }).catch(() => {
    state.connecting = false;
    refuse(socket, "502 Bad Gateway");
  });
}

export function startChatgptUnblockEntryProxy(options: StartEntryProxyOptions): Promise<EntryProxyHandle> {
  return new Promise((resolve, reject) => {
    let server: TCPSocketListener<EntryState>;
    try {
      server = bunListen<EntryState>({
        hostname: "127.0.0.1",
        port: options.port ?? 0,
        socket: {
          open(socket) {
            socket.data = {
              head: Buffer.alloc(0),
              connecting: false,
              upstream: null,
              toUpstream: { queue: [], ended: false },
              toClient: { queue: [], ended: false },
            };
            socket.timeout(options.headTimeoutSeconds ?? HEAD_TIMEOUT_SECONDS);
          },
          data(socket, chunk) { handleData(socket, chunk, options.originPort); },
          // Bun only fires the deadline when a handler exists, and never closes on its own.
          timeout(socket) {
            if (!socket.data.upstream) socket.end();
          },
          drain(socket) {
            if (socket.data.upstream) flush(socket, socket.data.toClient, socket.data.upstream);
          },
          close(socket) {
            const state = socket.data;
            if (state.upstream) finish(state.upstream, state.toUpstream);
            else state.toUpstream.ended = true;
          },
          error() { /* the close handler tears the pair down */ },
        },
      });
    } catch (error) {
      reject(error);
      return;
    }
    // Bun binds synchronously: `listen()` either returned a serving listener or threw.
    resolve({
      port: server.port,
      stop: () =>
        new Promise<void>(done => {
          server.stop(true);
          done();
        }),
    });
  });
}
