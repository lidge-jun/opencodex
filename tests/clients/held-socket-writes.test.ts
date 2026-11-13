import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { heldSocketWriteCountForTests, holdLargeSocketWrites, releaseHeldSocketWrites, restoreSocketWrites } from "../helpers/held-socket-writes";

// The shared helper behind the link traffic, request-zstd and relay cases (#8627, #8670). These cases
// drive it with a base write whose native completion the test decides, on an EventEmitter standing in
// for the socket, so every ordering is deterministic on every platform.
type Done = (error?: Error | null) => void;
afterEach(() => { restoreSocketWrites(); });

function controlledBase() {
  const pending: Done[] = [];
  const base = function (this: Socket, _chunk: unknown, _encoding: BufferEncoding, done: Done) { pending.push(done); };
  return { base, pending };
}
const write = (target: EventEmitter, calls: Array<Error | null | undefined>) =>
  (Socket.prototype._write as unknown as (this: EventEmitter, chunk: Uint8Array, encoding: string, done: Done) => void)
    .call(target, new Uint8Array(8), "buffer", error => { calls.push(error); });

test("a success is held until released, and settles once", () => {
  const { base, pending } = controlledBase();
  holdLargeSocketWrites(1, base);
  const calls: Array<Error | null | undefined> = [];
  write(new EventEmitter(), calls);
  pending[0]!();
  expect(calls).toHaveLength(0);
  expect(heldSocketWriteCountForTests()).toBe(1);
  releaseHeldSocketWrites();
  releaseHeldSocketWrites();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBeUndefined();
  expect(heldSocketWriteCountForTests()).toBe(0);
});

test("a write error and a closing socket settle at once", () => {
  const { base, pending } = controlledBase();
  holdLargeSocketWrites(1, base);
  const failed: Array<Error | null | undefined> = [], closed: Array<Error | null | undefined> = [];
  write(new EventEmitter(), failed);
  const socket = new EventEmitter();
  write(socket, closed);
  pending[0]!(new Error("EPIPE"));
  socket.emit("close");
  expect(failed.map(error => error?.message)).toEqual(["EPIPE"]);
  expect(closed.map(error => (error as { code?: string } | undefined)?.code)).toEqual(["ERR_SOCKET_CLOSED"]);
});

test("a native success after the socket closed is ignored and nothing is kept", () => {
  const { base, pending } = controlledBase();
  holdLargeSocketWrites(1, base);
  const calls: Array<Error | null | undefined> = [];
  const socket = new EventEmitter();
  write(socket, calls);
  socket.emit("close");
  pending[0]!();
  expect(heldSocketWriteCountForTests()).toBe(0);
  releaseHeldSocketWrites();
  expect(calls).toHaveLength(1);
});

test("a completion arriving after restore settles at once, even after a new hold began", () => {
  const first = controlledBase();
  holdLargeSocketWrites(1, first.base);
  const calls: Array<Error | null | undefined> = [];
  write(new EventEmitter(), calls);
  restoreSocketWrites();
  const second = controlledBase();
  holdLargeSocketWrites(1, second.base);
  first.pending[0]!();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBeUndefined();
  expect(heldSocketWriteCountForTests()).toBe(0);
});
