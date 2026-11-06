import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Socket, createServer, type AddressInfo } from "node:net";
import { socks5Fetch } from "../../src/lib/socks5-fetch";

// Identify only the callbacks owned by this transport, as in the upload lifecycle
// tests. Do not require unrelated timeout observers on the socket to disappear.
const HANDSHAKE_TIMEOUT_MS = 30_000;
const RESPONSE_TIMEOUT_MS = 200_000;
type TimeoutOwner = { socket: Socket; callback: () => void; milliseconds: number };
type Stage = "greeting" | "connect" | "request" | "answered";

async function withPeer(
  reply: (socket: Socket) => void,
  check: (response: Promise<Response>, owners: TimeoutOwner[], requestSeen: Promise<void>) => Promise<void>,
  secure = false,
) {
  const peers = new Set<Socket>();
  let markRequest!: () => void;
  const requestSeen = new Promise<void>(resolve => { markRequest = resolve; });
  const server = createServer(socket => {
    peers.add(socket);
    socket.on("error", () => { /* cancellation and protocol failure close the peer */ });
    socket.on("close", () => peers.delete(socket));
    let stage: Stage = "greeting";
    let pending = Buffer.alloc(0);
    socket.on("data", chunk => {
      if (stage === "answered") return;
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (stage === "greeting") {
        if (pending.length < 2 || pending.length < 2 + pending[1]!) return;
        pending = pending.subarray(2 + pending[1]!);
        socket.write(Buffer.from([5, 0]));
        stage = "connect";
      }
      if (stage === "connect") {
        if (pending.length < 5 || pending.length < 7 + pending[4]!) return;
        pending = pending.subarray(7 + pending[4]!);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        stage = "request";
      }
      if (stage === "request" && (secure ? pending.length > 0 : pending.includes("\r\n\r\n"))) {
        stage = "answered";
        pending = Buffer.alloc(0);
        markRequest();
        reply(socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const owners: TimeoutOwner[] = [];
  const original = Socket.prototype.setTimeout;
  Socket.prototype.setTimeout = function (milliseconds: number, callback?: () => void) {
    if (callback && [HANDSHAKE_TIMEOUT_MS, RESPONSE_TIMEOUT_MS].includes(milliseconds)) {
      owners.push({ socket: this, callback, milliseconds });
    }
    return original.call(this, milliseconds, callback);
  };
  const abort = new AbortController();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let response: Promise<Response> | undefined;
  try {
    const port = (server.address() as AddressInfo).port;
    response = socks5Fetch(`${secure ? "https" : "http"}://destination.invalid/`, { signal: abort.signal }, `socks5://127.0.0.1:${port}`);
    // A TLS failure may settle before check reaches its own await.
    response.catch(() => {});
    await Promise.race([
      check(response, owners, requestSeen),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          const error = new Error("timeout cleanup fixture watchdog");
          abort.abort(error); reject(error);
        }, 2_000);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
    abort.abort();
    await response?.catch(() => {});
    Socket.prototype.setTimeout = original;
    for (const { socket } of owners) socket.destroy();
    for (const socket of peers) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function assertReleased(owners: TimeoutOwner[]) {
  assert.ok(owners.length > 0, "the transport must arm an observed timeout");
  for (const { socket, callback, milliseconds } of owners) {
    assert.equal(socket.listeners("timeout").includes(callback), false, `${milliseconds} ms timeout callback retained after cleanup`);
  }
}

describe("SOCKS5 owned timeout cleanup", () => {
  test("response phase has no handshake callback and timeout reports the current phase", async () => {
    await withPeer(() => {}, async (response, owners, requestSeen) => {
      await requestSeen;
      const handshake = owners.find(owner => owner.milliseconds === HANDSHAKE_TIMEOUT_MS)!;
      const current = owners.find(owner => owner.milliseconds === RESPONSE_TIMEOUT_MS)!;
      assert.ok(handshake && current, "both transport phases must be observed");
      const retainedHandshake = handshake.socket.listeners("timeout").includes(handshake.callback);
      const unrelatedTimeout = () => {};
      current.socket.on("timeout", unrelatedTimeout);
      const failure = response.then(() => assert.fail("unexpected response"), error => error);
      current.socket.emit("timeout");
      const error = await failure;
      assert.equal(retainedHandshake, false, "handshake callback must be removed before response I/O");
      assert.match(String(error), /upstream request timed out/);
      assertReleased(owners);
      assert.ok(current.socket.listeners("timeout").includes(unrelatedTimeout), "cleanup must preserve timeout observers it does not own");
    });
  });

  for (const terminal of ["complete", "cancel", "truncated", "bodyless", "invalid-head"] as const) {
    test(`${terminal} releases owned timeout callbacks`, async () => {
      await withPeer(socket => {
        if (terminal === "bodyless") socket.write("HTTP/1.1 204 No Content\r\n\r\n");
        else if (terminal === "invalid-head") socket.end("not-http\r\n\r\n");
        else if (terminal === "truncated") socket.end("HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nx");
        else if (terminal === "cancel") socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\na");
        else socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
      }, async (pending, owners) => {
        if (terminal === "invalid-head") await assert.rejects(pending, /invalid HTTP response/);
        else {
          const response = await pending;
          if (terminal === "bodyless") assert.equal(response.body, null);
          else if (terminal === "truncated") await assert.rejects(response.text(), /expected bytes/);
          else if (terminal === "cancel") await response.body!.cancel();
          else assert.equal(await response.text(), "ok");
        }
        assert.ok(owners.some(owner => owner.milliseconds === RESPONSE_TIMEOUT_MS));
        assertReleased(owners);
      });
    });
  }

  test("TLS failure leaves no SOCKS handshake timeout callback", async () => {
    await withPeer(socket => socket.end("invalid TLS"), async (response, owners, requestSeen) => {
      await requestSeen;
      await assert.rejects(response);
      assert.ok(owners.some(owner => owner.milliseconds === HANDSHAKE_TIMEOUT_MS));
      assertReleased(owners);
    }, true);
  });
});
