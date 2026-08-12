/**
 * Darwin eager-relay abort-stress probe — CHILD (server) process.
 *
 * Serves the ACTUAL relaySseEagerBounded stream (src/server/relay-eager.ts)
 * as a Bun.serve HTTP Response body — the JS-stream→native-sink boundary that
 * Bun#32111 concerns. The parent (scripts/darwin-eager-abort-stress.ts) is
 * the external watchdog; this process only reports readiness and serves.
 *
 * Spec: devlog/_fin/260731_macos_rss_retention/100_darwin_eager_optin.md
 * §Abort-stress gate. This is a probe, not a test or CI job. JSON phase
 * markers let the parent prove that every abort happened inside its intended
 * boundary rather than merely counting attempted client requests.
 */
import { relaySseEagerBounded } from "../src/server/relay-eager";
import { createSseInspector } from "../src/server/relay";

type AbortClass = "before-first-byte" | "mid-frame" | "during-backpressure";

type UpstreamLifecycle = {
  done: boolean;
  pulls: number;
  producedBytes: number;
  producedChunks: number;
  inspectedChunks: number;
  lastInspectAt: number;
  phaseEmitted: boolean;
};

const encoder = new TextEncoder();
const BACKPRESSURE_CHUNK_BYTES = 8 * 1024;
const BACKPRESSURE_MAX_QUEUE_BYTES = 64 * 1024;
const BACKPRESSURE_STALL_MS = 50;
const BACKPRESSURE_MONITOR_MS = 10;
const BACKPRESSURE_UNREACHABLE_BYTES = 4 * 1024 * 1024;

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

function sseEvent(index: number, bytes: number): Uint8Array {
  const payload = JSON.stringify({
    type: "response.output_text.delta",
    delta: "x".repeat(Math.max(0, bytes - 80)),
    index,
  });
  return encoder.encode(`data: ${payload}\n\n`);
}

function isAbortClass(value: string | null): value is AbortClass {
  return value === "before-first-byte" || value === "mid-frame" || value === "during-backpressure";
}

function makeUpstream(
  abortClass: AbortClass,
  lifecycle: UpstreamLifecycle,
  emitPhase: () => void,
): ReadableStream<Uint8Array> {
  let sent = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      lifecycle.pulls += 1;
      const enqueue = (chunk: Uint8Array) => {
        lifecycle.producedBytes += chunk.byteLength;
        lifecycle.producedChunks += 1;
        controller.enqueue(chunk);
      };
      if (abortClass === "before-first-byte") {
        if (sent === 0) {
          // Marker precedes the first body byte; the parent aborts only after
          // observing this window.
          emitPhase();
          await Bun.sleep(25);
        }
        enqueue(sseEvent(sent++, 2 * 1024));
      } else if (abortClass === "mid-frame") {
        if (sent === 0) {
          // Deliberately split one SSE JSON frame. The marker is emitted after
          // the opening bytes but before the frame terminator/JSON close.
          enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"'));
          sent += 1;
          emitPhase();
          return;
        }
        if (sent === 1) {
          await Bun.sleep(25);
          enqueue(encoder.encode('continued"}\n\n'));
          sent += 1;
          return;
        }
        enqueue(sseEvent(sent++, 2 * 1024));
      } else {
        // A finite, always-ready 8 KiB source makes the real relay pause
        // observable once aggregate queued bytes exceed the 64 KiB bound.
        // If Bun's native Response sink drains the entire source without that
        // pause, onDone reports backpressure-unreachable instead of a phase.
        enqueue(sseEvent(sent++, BACKPRESSURE_CHUNK_BYTES));
      }

      const limit = abortClass === "during-backpressure"
        ? BACKPRESSURE_UNREACHABLE_BYTES / BACKPRESSURE_CHUNK_BYTES
        : 256;
      if (sent >= limit) {
        enqueue(encoder.encode(`data: {"type":"response.completed","response":{"id":"probe","status":"completed","output":[]}}\n\ndata: [DONE]\n\n`));
        lifecycle.done = true;
        controller.close();
      }
    },
    cancel() {
      lifecycle.done = true;
    },
  });
}

let shuttingDown = false;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/shutdown" && req.method === "POST") {
      if (!shuttingDown) {
        shuttingDown = true;
        emit({ type: "shutdown-ack" });
        setTimeout(() => {
          server.stop(true);
          process.exit(0);
        }, 25);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/sse") return new Response("not found", { status: 404 });

    const id = url.searchParams.get("id");
    const abortClass = url.searchParams.get("class");
    if (!id || !/^[a-z0-9-]{1,96}$/.test(id) || !isAbortClass(abortClass)) {
      return Response.json({ error: "invalid id or abort class" }, { status: 400 });
    }

    const upstream = new AbortController();
    const inspector = createSseInspector({});
    const lifecycle: UpstreamLifecycle = {
      done: false,
      pulls: 0,
      producedBytes: 0,
      producedChunks: 0,
      inspectedChunks: 0,
      lastInspectAt: performance.now(),
      phaseEmitted: false,
    };
    let cancelAckEmitted = false;
    let clientGone = req.signal.aborted;
    const emitCancelAck = () => {
      if (cancelAckEmitted) return;
      cancelAckEmitted = true;
      emit({ type: "cancel-ack", id });
    };
    const noteClientGone = () => {
      clientGone = true;
      // A before-first-byte request may disappear before the relay body starts.
      // Once a producer is already done, this signal also proves teardown.
      if (abortClass === "before-first-byte" || lifecycle.done) emitCancelAck();
    };
    if (req.signal.aborted) noteClientGone();
    else req.signal.addEventListener("abort", noteClientGone, { once: true });

    let monitor: ReturnType<typeof setInterval> | undefined;
    const emitPhase = () => {
      if (lifecycle.phaseEmitted) return;
      lifecycle.phaseEmitted = true;
      if (monitor) clearInterval(monitor);
      emit({ type: "phase", id, class: abortClass });
    };
    const upstreamBody = makeUpstream(abortClass, lifecycle, emitPhase);

    if (abortClass === "during-backpressure") {
      monitor = setInterval(() => {
        if (lifecycle.done || lifecycle.phaseEmitted) return;
        // The synthetic source is always-ready (pull resolves immediately), so
        // "upstream has data ready" is exactly "the source is not done". A
        // prefetch-count comparison (producedChunks > inspectedChunks) is NOT
        // reliable here: a parked relay stops pulling, so the pull-based source
        // never gets to prefetch and the comparison deadlocks the marker.
        const upstreamHasDataReady = !lifecycle.done;
        const stalledForMs = performance.now() - lifecycle.lastInspectAt;
        if (lifecycle.producedBytes > BACKPRESSURE_MAX_QUEUE_BYTES
          && upstreamHasDataReady
          && stalledForMs >= BACKPRESSURE_STALL_MS) {
          emitPhase();
        }
      }, BACKPRESSURE_MONITOR_MS);
    }

    const body = relaySseEagerBounded(upstreamBody, upstream, {
      inspectChunk: chunk => {
        lifecycle.inspectedChunks += 1;
        lifecycle.lastInspectAt = performance.now();
        inspector.feed(chunk);
      },
      finishInspection: () => inspector.finish(),
      sawTerminal: () => inspector.reported(),
      onSynthetic: () => {},
      onClientCancel: emitCancelAck,
      onDone: () => {
        lifecycle.done = true;
        if (monitor) clearInterval(monitor);
        if (clientGone) emitCancelAck();
        if (abortClass === "during-backpressure"
          && !lifecycle.phaseEmitted
          // Chunk-count basis: each sseEvent is slightly under the nominal
          // 8 KiB (JSON overhead is subtracted from the delta), so a byte
          // threshold of exactly 4 MiB can miss by a few KiB after a full
          // drain. Producing every scheduled chunk without a park IS the
          // unreachable outcome.
          && lifecycle.producedChunks >= BACKPRESSURE_UNREACHABLE_BYTES / BACKPRESSURE_CHUNK_BYTES) {
          emit({
            type: "backpressure-unreachable",
            id,
            producedBytes: lifecycle.producedBytes,
            maxQueueBytes: BACKPRESSURE_MAX_QUEUE_BYTES,
            stallThresholdMs: BACKPRESSURE_STALL_MS,
          });
        }
      },
      disposeInspection: () => inspector.dispose(),
    }, {
      // Nine always-ready 8 KiB chunks exceed this 64 KiB queue bound; a real
      // producer park then leaves a prefetched upstream chunk uninspected.
      maxQueueBytes: BACKPRESSURE_MAX_QUEUE_BYTES,
      postCancelDrainMs: 250,
      postCancelDrainBytes: 256 * 1024,
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});

// Readiness marker the parent watches for.
emit({ type: "ready", port: server.port });
