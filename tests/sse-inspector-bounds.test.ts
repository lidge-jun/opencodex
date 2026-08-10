import { beforeEach, describe, expect, test } from "bun:test";
import {
  createSseInspector,
  getInspectionCounters,
  MAX_COMPLETED_OUTPUT_ITEMS,
  MAX_INSPECTION_SSE_FRAME_BYTES,
  relaySseWithHeartbeat,
  resetInspectionCountersForTest,
  trackSseForRequestLog,
} from "../src/server/relay";
import type { RequestLogContext } from "../src/server/request-log";

const encoder = new TextEncoder();

function candidate(event: unknown): string {
  return `data: ${JSON.stringify(event)}`;
}

function frame(event: unknown, delimiter = "\n\n"): Uint8Array {
  return encoder.encode(`${candidate(event)}${delimiter}`);
}

function completedEvent(id: string, output: unknown[] = []): Record<string, unknown> {
  return { type: "response.completed", response: { id, status: "completed", output } };
}

function doneItemEvent(index: number, item: Record<string, unknown>): Record<string, unknown> {
  return { type: "response.output_item.done", output_index: index, item };
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function streamFromChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return joinBytes(chunks);
    chunks.push(value);
  }
}

beforeEach(() => resetInspectionCountersForTest());

describe("createSseInspector frame bounds", () => {
  test("optionally persists a completed snapshot under the first client-visible response id", () => {
    const completed: Array<{ id?: unknown }> = [];
    const inspector = createSseInspector({
      pinCompletedResponseIdToFirstSeen: true,
      onCompletedResponse: response => completed.push(response),
    });

    inspector.feed(frame({
      type: "response.created",
      response: { id: "resp-client-visible", status: "in_progress", output: [] },
    }));
    inspector.feed(frame(completedEvent("resp-upstream-terminal", [{ type: "message", id: "msg-1" }])));

    expect(completed).toEqual([
      expect.objectContaining({ id: "resp-client-visible" }),
    ]);
    inspector.dispose();
  });

  test("keeps the upstream completed response id when pinning is not enabled", () => {
    const completed: Array<{ id?: unknown }> = [];
    const inspector = createSseInspector({
      onCompletedResponse: response => completed.push(response),
    });

    inspector.feed(frame({
      type: "response.created",
      response: { id: "resp-client-visible", status: "in_progress", output: [] },
    }));
    inspector.feed(frame(completedEvent("resp-upstream-terminal", [{ type: "message", id: "msg-1" }])));

    expect(completed).toEqual([
      expect.objectContaining({ id: "resp-upstream-terminal" }),
    ]);
    inspector.dispose();
  });

  test("oversized candidate is inspection-only: tee client bytes stay exact and the next event resynchronizes", async () => {
    const oversized = encoder.encode(`data: ${"x".repeat(MAX_INSPECTION_SSE_FRAME_BYTES)}x\n\n`);
    const terminal = frame(completedEvent("after-cap"));
    const chunks = [oversized, terminal];
    const [clientBody, inspectionBody] = streamFromChunks(chunks).tee();
    const terminals: string[] = [];
    const inspected = new Promise<void>(resolve => {
      const reader = inspectionBody.getReader();
      const inspector = createSseInspector({ onTerminal: status => terminals.push(status) });
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              inspector.finish();
              return;
            }
            inspector.feed(value);
          }
        } finally {
          inspector.dispose();
          resolve();
        }
      })();
    });

    expect(await readAllBytes(clientBody)).toEqual(joinBytes(chunks));
    await inspected;
    expect(terminals).toEqual(["completed"]);
    expect(getInspectionCounters().frameCapOverflows).toBe(1);
    expect(getInspectionCounters().frameBufferHighWaterBytes)
      .toBeLessThanOrEqual(MAX_INSPECTION_SSE_FRAME_BYTES);
  });

  test("a single over-cap chunk is rejected before decode", () => {
    const inspector = createSseInspector({ onFirstOutput: () => {} });
    const oversized = frame({
      type: "response.output_text.delta",
      delta: "x".repeat(MAX_INSPECTION_SSE_FRAME_BYTES),
    });
    const originalParse = JSON.parse;
    let parses = 0;
    JSON.parse = ((text: string) => {
      parses += 1;
      return originalParse(text);
    }) as typeof JSON.parse;
    const originalDecode = TextDecoder.prototype.decode;
    let oversizedDecodedBytes = 0;
    TextDecoder.prototype.decode = function (this: TextDecoder, input?: AllowSharedBufferSource, opts?: { stream?: boolean }) {
      const byteLength = input && "byteLength" in input ? input.byteLength : 0;
      if (byteLength >= MAX_INSPECTION_SSE_FRAME_BYTES) oversizedDecodedBytes += byteLength;
      return originalDecode.call(this, input as Uint8Array<ArrayBuffer>, opts);
    } as typeof TextDecoder.prototype.decode;
    try {
      inspector.feed(oversized);
      expect(parses).toBe(0);
      // The ≥cap candidate must never be decoded, not merely never parsed.
      expect(oversizedDecodedBytes).toBe(0);
      inspector.feed(frame(completedEvent("after-reject")));
      expect(parses).toBe(1);
    } finally {
      JSON.parse = originalParse;
      TextDecoder.prototype.decode = originalDecode;
      inspector.dispose();
    }
    expect(getInspectionCounters().frameCapOverflows).toBe(1);
  });

  test("finish while still discarding parses nothing and reports no terminal", () => {
    const terminals: string[] = [];
    const inspector = createSseInspector({ onTerminal: status => terminals.push(status) });
    const originalParse = JSON.parse;
    let parses = 0;
    JSON.parse = ((text: string) => {
      parses += 1;
      return originalParse(text);
    }) as typeof JSON.parse;
    try {
      // Overflow the candidate with NO delimiter, then EOF while discarding.
      inspector.feed(encoder.encode(`data: ${"x".repeat(MAX_INSPECTION_SSE_FRAME_BYTES)}`));
      inspector.finish();
      expect(parses).toBe(0);
      expect(terminals).toEqual([]);
    } finally {
      JSON.parse = originalParse;
      inspector.dispose();
    }
    expect(getInspectionCounters().frameCapOverflows).toBe(1);
  });

  test("a large consumed frame does not overcharge a small trailing partial frame", () => {
    const terminals: string[] = [];
    const inspector = createSseInspector({ onTerminal: status => terminals.push(status) });
    const large = candidate({
      type: "response.output_text.delta",
      delta: "x".repeat(MAX_INSPECTION_SSE_FRAME_BYTES - 256),
    });
    expect(encoder.encode(large).byteLength).toBeLessThan(MAX_INSPECTION_SSE_FRAME_BYTES);
    const trailing = candidate(completedEvent("small-tail"));
    const split = Math.floor(trailing.length / 2);

    inspector.feed(encoder.encode(`${large}\n\n${trailing.slice(0, split)}`));
    inspector.feed(encoder.encode(`${trailing.slice(split)}\n\n`));

    expect(terminals).toEqual(["completed"]);
    expect(getInspectionCounters().frameCapOverflows).toBe(0);
  });

  test("a chunk larger than 4 MiB containing small complete frames has no overflow", () => {
    const completed: unknown[] = [];
    const inspector = createSseInspector({ onCompletedResponse: response => completed.push(response) });
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < 4; index += 1) {
      chunks.push(frame({
        ...completedEvent(`multi-${index}`, [{ type: "message", index }]),
        padding: "x".repeat(1024 * 1024),
      }));
    }
    const combined = joinBytes(chunks);
    expect(combined.byteLength).toBeGreaterThan(MAX_INSPECTION_SSE_FRAME_BYTES);

    inspector.feed(combined);

    expect(completed).toHaveLength(4);
    expect(getInspectionCounters().frameCapOverflows).toBe(0);
  });

  for (const delimiter of ["\n\n", "\r\n\r\n", "\r\n\n", "\n\r\n"] as const) {
    test(`delimiter ${JSON.stringify(delimiter)} retains regex parity when split across chunks`, () => {
      const terminals: string[] = [];
      const inspector = createSseInspector({ onTerminal: status => terminals.push(status) });
      inspector.feed(encoder.encode(candidate(completedEvent(`delimiter-${delimiter.length}`))));
      for (const byte of encoder.encode(delimiter)) inspector.feed(Uint8Array.of(byte));
      expect(terminals).toEqual(["completed"]);
      expect(getInspectionCounters().frameCapOverflows).toBe(0);
    });
  }

  test("a just-under-cap candidate split across chunks parses normally", () => {
    const terminals: string[] = [];
    const inspector = createSseInspector({ onTerminal: status => terminals.push(status) });
    const empty = candidate({ ...completedEvent("under-cap"), padding: "" });
    const paddingLength = MAX_INSPECTION_SSE_FRAME_BYTES - encoder.encode(empty).byteLength - 1;
    const bytes = encoder.encode(candidate({
      ...completedEvent("under-cap"),
      padding: "x".repeat(paddingLength),
    }));
    expect(bytes.byteLength).toBe(MAX_INSPECTION_SSE_FRAME_BYTES - 1);

    inspector.feed(bytes.subarray(0, 1_000_000));
    inspector.feed(bytes.subarray(1_000_000, 3_000_000));
    inspector.feed(bytes.subarray(3_000_000));
    inspector.feed(encoder.encode("\r\n"));
    inspector.feed(encoder.encode("\r\n"));

    expect(terminals).toEqual(["completed"]);
    expect(getInspectionCounters().frameCapOverflows).toBe(0);
  });

  test("a delimiter split while discarding resynchronizes the following frame", () => {
    const terminals: string[] = [];
    const inspector = createSseInspector({ onTerminal: status => terminals.push(status) });
    inspector.feed(encoder.encode("x".repeat(MAX_INSPECTION_SSE_FRAME_BYTES + 1)));
    inspector.feed(encoder.encode("\r"));
    inspector.feed(encoder.encode("\n\r"));
    inspector.feed(encoder.encode("\n"));
    inspector.feed(frame(completedEvent("discard-resync")));

    expect(terminals).toEqual(["completed"]);
    expect(getInspectionCounters().frameCapOverflows).toBe(1);
  });
});

describe("createSseInspector completed-item bounds", () => {
  test("300 indexes retain at most the lowest 256 and count every high-index eviction", () => {
    const inspector = createSseInspector({ onCompletedResponse: () => {} });
    for (let index = 0; index < 300; index += 1) {
      inspector.feed(frame(doneItemEvent(index, { type: "message", id: `item-${index}` })));
    }
    expect(getInspectionCounters()).toMatchObject({
      completedItemsMaxCount: MAX_COMPLETED_OUTPUT_ITEMS,
      itemCapEvictions: 300 - MAX_COMPLETED_OUTPUT_ITEMS,
    });

    inspector.feed(frame(doneItemEvent(255, { type: "message", id: "replace-retained" })));
    expect(getInspectionCounters().itemCapEvictions).toBe(44);
    inspector.feed(frame(doneItemEvent(256, { type: "message", id: "replace-evicted" })));
    expect(getInspectionCounters().itemCapEvictions).toBe(45);
    inspector.dispose();
  });

  test("aggregate cap charges UTF-8 source bytes and evicts with only three large items", () => {
    const completed: unknown[] = [];
    const inspector = createSseInspector({ onCompletedResponse: response => completed.push(response) });
    const multiByteText = "é".repeat(1_500_000);
    for (let index = 0; index < 3; index += 1) {
      inspector.feed(frame(doneItemEvent(index, {
        type: "message",
        id: `large-${index}`,
        content: [{ type: "output_text", text: multiByteText }],
      })));
    }
    inspector.feed(frame(completedEvent("aggregate-tainted")));

    expect(getInspectionCounters().itemCapEvictions).toBe(1);
    expect(completed).toEqual([]);
  });

  test("taint suppresses partial synthesis but authoritative terminal output still fires", () => {
    const completed: Array<{ output?: unknown }> = [];
    const inspector = createSseInspector({ onCompletedResponse: response => completed.push(response) });
    const overflowCountCap = () => {
      for (let index = 0; index <= MAX_COMPLETED_OUTPUT_ITEMS; index += 1) {
        inspector.feed(frame(doneItemEvent(index, { type: "message", id: `taint-${index}` })));
      }
    };

    overflowCountCap();
    inspector.feed(frame(completedEvent("empty-tainted")));
    expect(completed).toEqual([]);

    overflowCountCap();
    const authoritative = [{ type: "message", id: "authoritative" }];
    inspector.feed(frame(completedEvent("authoritative-tainted", authoritative)));
    expect(completed).toEqual([expect.objectContaining({ output: authoritative })]);
  });

  test("frame-cap rejection taints reconstruction so a kept item cannot become a partial replay", () => {
    const completed: Array<{ output?: unknown }> = [];
    const inspector = createSseInspector({ onCompletedResponse: response => completed.push(response) });

    // 1. A retained item survives in the map.
    inspector.feed(frame(doneItemEvent(0, { type: "message", id: "kept" })));
    // 2. An oversized candidate is rejected — it may have carried another item.
    const oversized = new Uint8Array(MAX_INSPECTION_SSE_FRAME_BYTES + 16).fill(0x61);
    inspector.feed(oversized);
    inspector.feed(new TextEncoder().encode("\n\n"));
    expect(getInspectionCounters().frameCapOverflows).toBe(1);
    // 3. An empty-output terminal must NOT synthesize [kept] as the replay.
    inspector.feed(frame(completedEvent("partial-after-frame-reject")));
    expect(completed).toEqual([]);

    // Authoritative output still fires even while tainted.
    const authoritative = [{ type: "message", id: "authoritative" }];
    inspector.feed(frame(completedEvent("authoritative-after-reject", authoritative)));
    expect(completed).toEqual([expect.objectContaining({ output: authoritative })]);
  });

  test("completed callback handoff clears reconstruction state, including when the callback throws", () => {
    const outputs: unknown[] = [];
    let shouldThrow = true;
    const inspector = createSseInspector({
      onCompletedResponse: response => {
        outputs.push(response.output);
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("callback failed");
        }
      },
    });
    inspector.feed(frame(doneItemEvent(0, { type: "message", id: "first" })));
    expect(() => inspector.feed(frame(completedEvent("throws")))).toThrow("callback failed");
    inspector.feed(frame(completedEvent("second")));

    expect(outputs).toEqual([[{ type: "message", id: "first" }], []]);
  });

  for (const status of ["failed", "incomplete"] as const) {
    test(`${status} terminal clears reconstruction state immediately`, () => {
      const outputs: unknown[] = [];
      const inspector = createSseInspector({
        onTerminal: () => {},
        onCompletedResponse: response => outputs.push(response.output),
      });
      inspector.feed(frame(doneItemEvent(0, { type: "message", id: `before-${status}` })));
      inspector.feed(frame({ type: `response.${status}`, response: { status } }));
      inspector.feed(frame(completedEvent(`after-${status}`)));
      expect(outputs).toEqual([[]]);
    });
  }

  test("finish and dispose both clear retained state; dispose never parses", () => {
    const outputs: unknown[] = [];
    const inspector = createSseInspector({ onCompletedResponse: response => outputs.push(response.output) });
    inspector.feed(frame(doneItemEvent(0, { type: "message", id: "before-finish" })));
    inspector.finish();
    inspector.feed(frame(completedEvent("after-finish")));
    expect(outputs).toEqual([[]]);

    inspector.feed(frame(doneItemEvent(0, { type: "message", id: "before-dispose" })));
    inspector.dispose();
    inspector.dispose(); // idempotent: a second dispose must not throw or resurrect state
    inspector.feed(frame(completedEvent("after-dispose")));
    inspector.finish();
    expect(outputs).toEqual([[]]);
  });
});

describe("createSseInspector parse-once", () => {
  test("all hooks share exactly one JSON.parse per complete payload", () => {
    const originalParse = JSON.parse;
    let parses = 0;
    JSON.parse = ((text: string) => {
      parses += 1;
      return originalParse(text);
    }) as typeof JSON.parse;
    try {
      const inspector = createSseInspector({
        onTerminal: () => {},
        logCtx: {} as RequestLogContext,
        onCompletedResponse: () => {},
        onFirstOutput: () => {},
      });
      inspector.feed(frame(completedEvent("parse-once", [{ type: "message" }])));
      expect(parses).toBe(1);
      inspector.dispose();
    } finally {
      JSON.parse = originalParse;
    }
  });
});

describe("client-facing SSE wrapper bounds", () => {
  test("translated request-log tracking discards an oversized frame, resynchronizes, and preserves bytes", async () => {
    const oversized = encoder.encode(`data: ${"x".repeat(MAX_INSPECTION_SSE_FRAME_BYTES)}x`);
    const delimiter = encoder.encode("\n\n");
    const terminal = frame(completedEvent("translated-after-cap"));
    const chunks = [oversized, delimiter, terminal];
    const terminals: string[] = [];
    const tracked = trackSseForRequestLog(
      streamFromChunks(chunks),
      status => terminals.push(status),
      () => {},
      {} as RequestLogContext,
      () => {},
    );

    expect(await readAllBytes(tracked)).toEqual(joinBytes(chunks));
    expect(terminals).toEqual(["completed"]);
    expect(getInspectionCounters().frameCapOverflows).toBe(1);
    expect(getInspectionCounters().frameBufferHighWaterBytes)
      .toBeLessThanOrEqual(MAX_INSPECTION_SSE_FRAME_BYTES);
  });

  test("translated request-log tracking parses a complete payload once for all observers", async () => {
    const originalParse = JSON.parse;
    let parses = 0;
    JSON.parse = ((text: string) => {
      parses += 1;
      return originalParse(text);
    }) as typeof JSON.parse;
    try {
      const tracked = trackSseForRequestLog(
        streamFromChunks([frame(completedEvent("translated-parse-once"))]),
        () => {},
        () => {},
        {} as RequestLogContext,
        () => {},
      );
      await readAllBytes(tracked);
      expect(parses).toBe(1);
    } finally {
      JSON.parse = originalParse;
    }
  });

  test("heartbeat relay applies the same frame bound without changing upstream bytes", async () => {
    const oversized = encoder.encode(`data: ${"x".repeat(MAX_INSPECTION_SSE_FRAME_BYTES)}x`);
    const delimiter = encoder.encode("\r\n\r\n");
    const terminal = frame(completedEvent("heartbeat-after-cap"));
    const chunks = [oversized, delimiter, terminal];
    const terminals: string[] = [];
    const relayed = relaySseWithHeartbeat(
      streamFromChunks(chunks),
      new AbortController(),
      60_000,
      status => terminals.push(status),
    )!;

    expect(await readAllBytes(relayed)).toEqual(joinBytes(chunks));
    expect(terminals).toEqual(["completed"]);
    expect(getInspectionCounters().frameCapOverflows).toBe(1);
  });
});
