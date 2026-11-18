import { describe, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Socket } from "node:net";
import { Socks5FetchError } from "../../src/lib/socks5-fetch";
import { repoPath } from "../helpers/repo-root";

interface Reader {
  read(length: number, signal?: AbortSignal): Promise<Buffer>;
  readAny(signal?: AbortSignal): Promise<Buffer>;
  readUntil(delimiter: Buffer, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
  dispose(preserveBuffered?: boolean): void;
}

// Execute the current private class, not a copied implementation or a new public
// API. Emitting data synchronously makes the dispose-before-continuation ordering
// deterministic; an actual network packet cannot guarantee that microtask boundary.
const source = readFileSync(repoPath("src", "lib", "socks5-fetch.ts"), "utf8");
const start = source.indexOf("class SocketReader {");
const end = source.indexOf("\nasync function socks5Connect(", start);
const sliceLimit = source.match(/^const MAX_BODY_SLICE_BYTES = (.+);$/m)?.[0];
assert.ok(start >= 0 && end > start && sliceLimit, "SocketReader source seam must exist");
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(`${sliceLimit}\n${source.slice(start, end)}`);
const SocketReader = new Function("Buffer", "Socks5FetchError", `${javascript}\nreturn SocketReader;`)(Buffer, Socks5FetchError) as new (socket: Socket) => Reader;

async function outcome(promise: Promise<Buffer>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(value => ({ kind: "value" as const, value }), error => ({ kind: "error" as const, error })),
      new Promise<{ kind: "pending" }>(resolve => { timer = setTimeout(() => resolve({ kind: "pending" }), 250); }),
    ]);
  } finally { clearTimeout(timer); }
}

describe("SOCKS5 reader disposal", () => {
  test("partial framing cannot enqueue another read after disposal", async () => {
    const socket = new Socket();
    const reader = new SocketReader(socket);
    const controller = new AbortController();
    const added = spyOn(controller.signal, "addEventListener");
    const removed = spyOn(controller.signal, "removeEventListener");
    try {
      const pending = outcome(reader.readUntil(Buffer.from("\r\n"), 1024, controller.signal));
      assert.equal(added.mock.calls.length, 1);
      // Resolves readAny, but readUntil cannot resume until this stack unwinds.
      socket.emit("data", Buffer.from("a"));
      reader.dispose();
      socket.destroy();
      const result = await pending;
      assert.equal(result.kind, "error", "disposed framing read must settle instead of waiting on a detached socket");
      if (result.kind === "error") assert.match(String(result.error), /reader disposed/);
      assert.equal(added.mock.calls.length, 1, "the continuation must not add another abort listener");
      assert.equal(removed.mock.calls.length, 1);
    } finally {
      controller.abort();
      reader.dispose();
      socket.destroy();
      added.mockRestore(); removed.mockRestore();
    }
  });

  for (const method of ["read", "readAny"] as const) {
    test(`${method} after disposal rejects without an abort listener`, async () => {
      const socket = new Socket();
      const reader = new SocketReader(socket);
      const controller = new AbortController();
      const added = spyOn(controller.signal, "addEventListener");
      try {
        reader.dispose();
        reader.dispose();
        const result = await outcome(method === "read" ? reader.read(1, controller.signal) : reader.readAny(controller.signal));
        assert.equal(result.kind, "error");
        if (result.kind === "error") assert.match(String(result.error), /reader disposed/);
        assert.equal(added.mock.calls.length, 0);
      } finally {
        controller.abort(); reader.dispose(); socket.destroy(); added.mockRestore();
      }
    });
  }

  test("successful handshake disposal hands buffered bytes to the next owner only once", async () => {
    const socket = new Socket();
    const reader = new SocketReader(socket);
    const unshift = spyOn(socket, "unshift");
    try {
      socket.emit("data", Buffer.from("replytail"));
      assert.equal((await reader.read(5)).toString(), "reply");
      reader.dispose(true);
      reader.dispose(true);
      assert.equal(unshift.mock.calls.length, 1);
      assert.deepEqual(unshift.mock.calls[0]![0], Buffer.from("tail"));
      assert.equal(socket.read()?.toString(), "tail");
    } finally { reader.dispose(); socket.destroy(); unshift.mockRestore(); }
  });

  test("disposal after socket failure preserves its original reason", async () => {
    const socket = new Socket();
    const reader = new SocketReader(socket);
    const reason = new Error("synthetic socket failure");
    try {
      const pending = outcome(reader.readAny());
      socket.emit("error", reason);
      reader.dispose();
      assert.deepEqual(await pending, { kind: "error", error: reason });
      await assert.rejects(reader.read(1), error => error === reason);
      await assert.rejects(reader.readAny(), error => error === reason);
    } finally { reader.dispose(); socket.destroy(); }
  });

  test("EOF prevents handshake handoff of abandoned buffered bytes", () => {
    const socket = new Socket();
    const reader = new SocketReader(socket);
    const unshift = spyOn(socket, "unshift");
    try {
      socket.emit("data", Buffer.from("abandoned"));
      socket.emit("end");
      reader.dispose(true);
      assert.equal(unshift.mock.calls.length, 0);
    } finally { reader.dispose(); socket.destroy(); unshift.mockRestore(); }
  });
});
