/**
 * After the backend ends a connection (an HTTP/1.1 refusal sent with Connection: close while the
 * upload is unfinished), the TCP front keeps discarding the client's ciphertext so the reply is not
 * reset (#6984). That discard is bounded: once the reply has been flushed, the connection is dropped
 * after PICKER_ABANDONED_INPUT_LINGER_MS. The drop is armed through an injected scheduler, so the
 * test fires it itself instead of waiting on a clock. A half-open TLS client stands in for a peer
 * that never stops uploading, so no HTTP client library decides when the socket closes.
 */
import { expect, test } from "bun:test";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { PICKER_ABANDONED_INPUT_LINGER_MS, startPickerListener } from "../../src/claude/intercept/picker-listener";

interface ArmedDrop { ms: number; fire(): void }

async function refusalWithEndlessUpload() {
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, ["claude.ai"]);
  let relayed = 0;
  const upstream = createServer({ cert: leaf.certPem, key: leaf.keyPem }, (_req, res) => { relayed++; res.end("ordinary"); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address() as AddressInfo;
  const armed: ArmedDrop[] = [];
  const armedOnce = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const relay = await startPickerListener({
    leaf, models: () => [],
    upstream: { host: "127.0.0.1", port, servername: "claude.ai", ca: ca.certPem },
    scheduleAbandonedInputDrop: (drop, ms) => {
      armed.push({ ms, fire: drop });
      armedOnce.resolve();
      return () => cancelled.resolve();
    },
  });

  // Half-open: the client keeps uploading after the server's FIN instead of closing on it.
  const socket = tlsConnect({ host: "127.0.0.1", port: relay.port, servername: "claude.ai", ca: ca.certPem,
    ALPNProtocols: ["http/1.1"], allowHalfOpen: true });
  socket.on("error", () => {});
  const received: Buffer[] = [];
  const replied = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const pumped = Promise.withResolvers<void>();
  let isClosed = false;
  socket.on("data", chunk => {
    received.push(Buffer.from(chunk));
    if (Buffer.concat(received).includes("\r\n\r\n")) replied.resolve();
  });
  socket.once("end", () => ended.resolve());
  // Close also ends the pump: Bun drops a TLS write callback still pending when the peer resets
  // the socket (the drop below does exactly that), so waiting on the callback alone can hang.
  socket.once("close", () => { isClosed = true; closed.resolve(); pumped.resolve(); });
  await new Promise<void>(resolve => socket.once("secureConnect", () => resolve()));
  // An unrelayable target is refused with 400 while 32 MiB are still advertised.
  socket.write("POST //[ HTTP/1.1\r\nHost: claude.ai\r\nContent-Length: 33554432\r\n\r\n");
  const chunk = Buffer.alloc(1024, 0x61);
  let sent = 0;
  let pumping = true;
  /** Writes chunks one after another, each after the previous one was flushed, until stopped. */
  const pump = () => {
    if (!pumping || isClosed || socket.destroyed) { pumped.resolve(); return; }
    socket.write(chunk, error => { if (error) { pumped.resolve(); return; } sent++; setImmediate(pump); });
  };
  pump();
  let stopped = false;
  return {
    armed, armedOnce: armedOnce.promise, cancelled: cancelled.promise,
    replied: replied.promise, ended: ended.promise, closed: closed.promise,
    isClosed: () => isClosed, sent: () => sent, relayed: () => relayed,
    head: () => Buffer.concat(received).toString("latin1"),
    disconnect() { pumping = false; socket.destroy(); },
    async stop() {
      if (stopped) return;
      stopped = true;
      pumping = false;
      socket.destroy();
      await pumped.promise;
      await relay.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    },
  };
}

/** Resolves once `count` more chunks have been flushed by the uploading client. */
async function afterMoreChunks(run: { sent(): number; isClosed(): boolean }, count: number) {
  const target = run.sent() + count;
  while (run.sent() < target && !run.isClosed()) await new Promise(resolve => setImmediate(resolve));
}

test("h1 refusal reaches a client that keeps uploading; the drop is armed once with the production budget", async () => {
  const run = await refusalWithEndlessUpload();
  try {
    await run.replied;
    const head = run.head();
    expect(head.startsWith("HTTP/1.1 400")).toBe(true);
    expect(head.toLowerCase()).toContain("connection: close");
    await run.ended;
    await run.armedOnce;
    expect(run.armed).toHaveLength(1);
    expect(run.armed[0]!.ms).toBe(PICKER_ABANDONED_INPUT_LINGER_MS);
    // Until the budget fires, the front keeps discarding instead of resetting the uploader.
    await afterMoreChunks(run, 64);
    expect(run.isClosed()).toBe(false);
    run.armed[0]!.fire();
    await run.closed;
    expect(run.relayed()).toBe(0);
  } finally { await run.stop(); }
});

test("a client that disconnects on its own cancels the armed drop", async () => {
  const run = await refusalWithEndlessUpload();
  try {
    await run.replied;
    await run.armedOnce;
    run.disconnect();
    await run.cancelled;
    expect(run.armed).toHaveLength(1);
  } finally { await run.stop(); }
});

