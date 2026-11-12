import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { LINK_WS_LIMITS } from "../../src/server/index/link-websocket-limits";
import { LinkWireClient } from "../helpers/link-ws-client";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

// Release gate (design T4 6.3), opt-in: OCX_LINK_WS_RSS_ACCEPTANCE=1, optionally
// OCX_LINK_WS_RSS_SOCKETS=<n> (default 24, the overall cap). It needs several hundred MiB of free memory
// and is not part of the ordinary suite. Transport-only load: a fake upstream, every link socket sends a
// near-maximum message, every reader stalls, upstream chunks run from 1 byte to 16 MiB around near-4 MiB
// events, and the sockets are then cut in a seeded random order. Accepted when peak RSS minus idle RSS
// of the Home process stays within n link socket reservations (the 768 MiB budget at n = 24).
// The peak is the kernel's high-water mark (VmHWM, reset after the idle reading) on Linux 4.0 or later;
// elsewhere the Home samples RSS on its own event loop, may miss a short peak, and reports "sampled".
// Any OCX_LINK_WS_RSS_* setting besides the opt-in turns the run into a diagnostic: it prints its numbers and
// never reports an acceptance.

const ENABLED = process.env.OCX_LINK_WS_RSS_ACCEPTANCE === "1";
const SOCKETS = Number(process.env.OCX_LINK_WS_RSS_SOCKETS ?? LINK_WS_LIMITS.totalSockets);
const MiB = 1024 * 1024;
const EVENT_BYTES = Math.floor(3.9 * MiB);
const CHUNK_PLAN = [1, 64 * 1024, 16 * MiB, MiB, 4 * MiB, 1, 16 * MiB];
// Diagnostics only, to split transport memory from turn-processing memory: the create's input size
// and the largest upstream chunk. The acceptance itself runs with neither set.
const INPUT_BYTES = Number(process.env.OCX_LINK_WS_RSS_INPUT_BYTES ?? LINK_WS_LIMITS.maxMessageBytes - 64 * 1024);
const MAX_CHUNK = Number(process.env.OCX_LINK_WS_RSS_MAX_CHUNK ?? 16 * MiB);
// Diagnostics only: "http" sends the same stalled load through the HTTP link relay instead, to
// compare what the Home holds for a slow reader on today's transport.
const TRANSPORT = process.env.OCX_LINK_WS_RSS_TRANSPORT === "http" ? "http" : "websocket";
// Diagnostics only: "hold" makes every upstream stream stop after HOLD_BYTES (about four events), so the Home's fetch cannot
// read further ahead of a stalled reader; HEAP=1 asks the Home for a heap breakdown at the stall.
const UPSTREAM_HOLD = process.env.OCX_LINK_WS_RSS_UPSTREAM === "hold";
const HEAP = process.env.OCX_LINK_WS_RSS_HEAP === "1";
const HOLD_BYTES = 16 * MiB;
// Only the canonical load (all sockets, no diagnostic setting) may report an acceptance; anything else runs as a
// diagnostic that prints its numbers and never asserts the budget.
const DIAGNOSTIC_SETTINGS = ["OCX_LINK_WS_RSS_SOCKETS", "OCX_LINK_WS_RSS_INPUT_BYTES", "OCX_LINK_WS_RSS_MAX_CHUNK",
  "OCX_LINK_WS_RSS_TRANSPORT", "OCX_LINK_WS_RSS_UPSTREAM", "OCX_LINK_WS_RSS_HEAP"].filter(name => process.env[name] !== undefined);
const CANONICAL = DIAGNOSTIC_SETTINGS.length === 0;
// A child process runs the Home: the bound is this file's default, not a per-test timeout.
setDefaultTimeout(600_000);

function eventsText(count: number): string {
  const delta = "x".repeat(EVENT_BYTES - 200);
  const one = (index: number) => "event: response.output_text.delta\ndata: " + JSON.stringify({ type: "response.output_text.delta", index, delta }) + "\n\n";
  return Array.from({ length: count }, (_, index) => one(index)).join("")
    + 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n';
}

interface LoadResult { method: string; idle: number; peak: number; delta: number }

/** One stalled load against a Home in its own process; prints its numbers and returns the peak reading. */
async function runLoad(): Promise<LoadResult> {
    expect(SOCKETS).toBeGreaterThan(0);
    expect(SOCKETS).toBeLessThanOrEqual(LINK_WS_LIMITS.totalSockets);
    const root = mkdtempSync(join(tmpdir(), "ocx-link-ws-rss-"));
    const body = new TextEncoder().encode(eventsText(14));
    // One promise pair per expected upstream request, created up front: no polling for arrivals.
    // Request 0 is a complete warm-up turn, so one-time first-request costs land before "idle".
    const signals = Array.from({ length: SOCKETS + 1 }, () => {
      let stalled!: () => void;
      let gone!: () => void;
      let heldAt!: () => void;
      return {
        reachedStall: new Promise<void>(resolve => { stalled = resolve; }),
        cancelled: new Promise<void>(resolve => { gone = resolve; }),
        reachedHold: new Promise<void>(resolve => { heldAt = resolve; }),
        stalled: () => stalled(), gone: () => gone(), held: () => heldAt(),
      };
    });
    let requests = 0;
    let largestChunk = 0;
    // Upstream bytes each stream had handed to the Home when the peak was read: how far Bun's fetch
    // read ahead of the stalled pump. These are bytes the fake upstream enqueued, which bounds from above
    // what the Home's fetch has read; they are reported, never asserted.
    const delivered: number[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        await req.arrayBuffer();
        const signal = signals[requests++]!;
        const stream = delivered.push(0) - 1;
        let offset = 0;
        let pulls = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= body.byteLength) { controller.close(); signal.gone(); return; }
            // A held stream (not the warm-up) supplies nothing more after the stall point, until it is cancelled.
            if (UPSTREAM_HOLD && stream > 0 && offset >= HOLD_BYTES) { signal.held(); return new Promise<void>(() => {}); }
            const size = Math.min(MAX_CHUNK, CHUNK_PLAN[pulls % CHUNK_PLAN.length]!);
            const chunk = body.subarray(offset, Math.min(body.byteLength, offset + size));
            offset += chunk.byteLength;
            delivered[stream] = offset;
            pulls += 1;
            largestChunk = Math.max(largestChunk, chunk.byteLength);
            controller.enqueue(chunk);
            // By the third chunk the paused reader has an event to stall on (the 16 MiB chunk holds several).
            if (pulls === 3) signal.stalled();
          },
          cancel() { signal.gone(); },
        }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const links = Math.ceil(SOCKETS / LINK_WS_LIMITS.perLinkSockets);
    const keys = Array.from({ length: links }, (_, index) => ({ id: "rss-key-" + index, key: "rss-secret-" + index + "-0123456789", linkId: "lnk_" + String(index + 1).repeat(16) }));
    const child = Bun.spawn(["bun", repoPath("tests/fixtures/link-ws-rss-home.ts")], {
      cwd: repoPath(), stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: { ...process.env, OPENCODEX_HOME: join(root, "home"), CODEX_HOME: join(root, "codex") },
    });
    const reader = child.stdout.getReader();
    let pending = "";
    const nextLine = async (): Promise<Record<string, number | boolean>> => {
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.startsWith("{")) return JSON.parse(line) as Record<string, number | boolean>;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("Home fixture exited");
        pending += new TextDecoder().decode(value);
      }
    };
    const ask = async (command: string): Promise<number> => { child.stdin.write(command + "\n"); child.stdin.flush(); return Number((await nextLine()).rss); };
    const clients: LinkWireClient[] = [];
    try {
      child.stdin.write(JSON.stringify({ upstreamPort: upstream.port, keys, stalls: TRANSPORT === "websocket" ? SOCKETS : Number.MAX_SAFE_INTEGER }) + "\n");
      child.stdin.flush();
      const ready = await nextLine();
      const linkPort = Number(ready.linkPort);
      const warm = await LinkWireClient.open(linkPort);
      clients.push(warm);
      const warmKey = keys[0]!;
      const warmSession = await warm.challenge({ keyId: warmKey.id, linkId: warmKey.linkId, fingerprint: serviceApiTokenFingerprint(warmKey.key) });
      expect((await warm.upgrade({ nonce: warmSession.nonce, bearer: warmKey.key })).status).toBe(101);
      warm.sendJson({ type: "response.create", model: "fixture/fixture", input: "y".repeat(LINK_WS_LIMITS.maxMessageBytes - 64 * 1024), stream: true });
      await warm.until(message => message.type === "text" && message.data.includes('"response.completed"'));
      warm.destroy();
      await signals[0]!.cancelled;
      const idle = await ask("gc-rss");
      const input = "y".repeat(INPUT_BYTES);
      for (let index = 0; index < SOCKETS; index += 1) {
        const entry = keys[index % keys.length]!;
        const wire = await LinkWireClient.open(linkPort);
        clients.push(wire);
        const { nonce } = await wire.challenge({ keyId: entry.id, linkId: entry.linkId, fingerprint: serviceApiTokenFingerprint(entry.key) });
        if (TRANSPORT === "http") {
          wire.sendRequest("POST /v1/responses HTTP/1.1", {
            host: "127.0.0.1", "content-type": "application/json", authorization: "Bearer " + entry.key, "x-opencodex-link-session": nonce,
          }, JSON.stringify({ model: "fixture/fixture", input, stream: true }));
        } else {
          expect((await wire.upgrade({ nonce, bearer: entry.key })).status).toBe(101);
          wire.sendJson({ type: "response.create", model: "fixture/fixture", input, stream: true });
        }
        wire.pause();
      }
      // The Home itself announces when every link pump is waiting on a drain at once. The HTTP
      // diagnostic has no pump to observe and settles for the upstream having enqueued its third chunk.
      if (TRANSPORT === "websocket") {
        const announced = (async () => { for (;;) if ((await nextLine()).stalled === true) return "stalled" as const; })();
        const finished = Promise.all(signals.slice(1).map(signal => signal.cancelled)).then(() => "finished" as const);
        // A load that completes before every pump waits never reached the condition being measured.
        expect(await Promise.race([announced, finished])).toBe("stalled");
      } else await Promise.all(signals.slice(1).map(signal => UPSTREAM_HOLD ? signal.reachedHold : signal.reachedStall));
      // With a held upstream both transports also wait until every stream has supplied all it will.
      if (UPSTREAM_HOLD && TRANSPORT === "websocket") await Promise.all(signals.slice(1).map(signal => signal.reachedHold));
      const enqueuedAtStallMiB = delivered.slice(1).map(bytes => Math.round(bytes / MiB));
      if (HEAP) { child.stdin.write("heap\n"); child.stdin.flush(); console.log(JSON.stringify(await nextLine())); }
      // Cut every socket in a seeded random order, at different points of its stalled stream.
      let seed = 7;
      const order = clients.map((client, index) => ({ client, key: (seed = (seed * 48271) % 2147483647) + index }));
      for (const { client } of order.sort((a, b) => a.key - b.key)) client.destroy();
      await Promise.all(signals.map(signal => signal.cancelled));
      // High-water mark over setup, load and cancellation, sampled inside the Home.
      child.stdin.write("peak\n");
      child.stdin.flush();
      const peakAnswer = await nextLine();
      const peak = peakAnswer.rss === null ? Number.NaN : Number(peakAnswer.rss);
      const method = String(peakAnswer.method);
      const after = await ask("gc-rss");
      const delta = peak - idle;
      const budget = SOCKETS * LINK_WS_LIMITS.socketReservationBytes;
      console.log(JSON.stringify({ method, transport: TRANSPORT, sockets: SOCKETS, idleMiB: idle / MiB, peakMiB: peak / MiB, deltaMiB: delta / MiB, perSocketMiB: delta / SOCKETS / MiB, budgetMiB: budget / MiB, afterCutMiB: after / MiB, largestUpstreamChunkMiB: largestChunk / MiB, upstreamBodyMiB: Math.round(body.byteLength / MiB), enqueuedAtStallMiB }));
      return { method, idle, peak, delta };
    } finally {
      for (const client of clients) client.destroy();
      try { child.stdin.write("stop\n"); child.stdin.flush(); child.stdin.end(); } catch { /* already gone */ }
      await child.exited;
      await upstream.stop(true);
      removeTreeWithRetry(root);
    }
}

describe.skipIf(!ENABLED)("link WebSocket transport-only RSS acceptance (opt-in release gate: OCX_LINK_WS_RSS_ACCEPTANCE=1)", () => {
  test.skipIf(!CANONICAL)("acceptance: peak RSS minus idle RSS of the Home stays within the link socket reservations"
    + (CANONICAL ? "" : " [skipped: diagnostic settings present (" + DIAGNOSTIC_SETTINGS.join(", ") + "); only the canonical load reports an acceptance]"), async () => {
    const result = await runLoad();
    // Only a kernel high-water mark, reset after the idle reading and read back, can satisfy the gate.
    expect(result.method).toBe("kernel-vmhwm");
    expect(Number.isFinite(result.peak) && result.peak >= result.idle).toBe(true);
    expect(result.delta).toBeLessThanOrEqual(SOCKETS * LINK_WS_LIMITS.socketReservationBytes);
  });

  test.skipIf(CANONICAL)("diagnostic run, never an acceptance: " + (CANONICAL ? "none requested" : DIAGNOSTIC_SETTINGS.join(", ")), async () => {
    const result = await runLoad();
    // The numbers are printed by runLoad; a diagnostic only checks that the peak was really measured.
    expect(result.method).toBe("kernel-vmhwm");
    expect(Number.isFinite(result.peak) && result.peak >= result.idle).toBe(true);
  });
});

