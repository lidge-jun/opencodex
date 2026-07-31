# Phase 2 — bounded, single-parse SSE inspection

## Decision

This phase changes only the background SSE **inspection** branch used by the
tee path. It does not change the tee, the client relay, the platform gate, or
which stream path macOS selects. In particular, `core.ts` must retain the
macOS `relaySseWithFailedTail` path at `src/server/responses/core.ts:1749-1751`;
the single-reader migration is Phase 3.

The change has three bounded mechanisms:

| State/work | Bound or reduction | Why it is safe |
| --- | --- | --- |
| Unterminated SSE candidate | 1,048,576 UTF-8 bytes | A Responses event must be a complete SSE block before it is inspected. An oversized block is discarded as one malformed/best-effort event and parsing resumes only at the next blank-line delimiter. |
| Reconstructed `response.output_item.done` items | 256 distinct output indexes | Continuation receives the completely reconstructed response synchronously before state is cleared; the cap only applies to pathological streams and retains the lowest indexes deterministically. |
| JSON decoding | one `JSON.parse` per complete payload in `createSseInspector` | The result is shared by request-log metadata/error capture, terminal detection, first-output detection, and continuation capture; malformed payloads remain no-throw/best effort. |

The evidence for targeting this branch is direct: `buffer += decoder.decode(...)`
has no bound (`src/server/relay.ts:503-511`), the done-item map remains live
after its callback (`src/server/relay.ts:476-500`), and the existing log and
continuation paths independently parse the same payload (`src/server/request-log.ts:507-516`,
`src/server/relay.ts:469-475`). The Phase 1 isolation result is the activation
baseline: the rate-mismatched tee reached 249.8 MiB peak external versus
4.1 MiB for one reader, and the HTTP case reached 363–461 MiB versus 10–22 MiB
(`devlog/_plan/260731_macos_rss_retention/000_plan.md:43-53`).

## Exact framing bound and resynchronization

Add these file-local constants and helpers in `src/server/relay.ts`, adjacent
to `nextSseBlock` (`src/server/relay.ts:91-108`). The cap is deliberately in
**bytes**, not JavaScript UTF-16 code units. `TextEncoder` is a Web API and is
available in Bun, so this remains Bun-native TypeScript.

```ts
const MAX_INSPECTION_SSE_FRAME_BYTES = 1_048_576;
const MAX_COMPLETED_OUTPUT_ITEMS = 256;

type ParsedSseEvent = {
  type?: unknown;
  output_index?: unknown;
  item?: unknown;
  response?: unknown;
  delta?: unknown;
};

type ParsedSsePayload = {
  event: ParsedSseEvent | null;
  malformed: boolean;
};

function parseSsePayload(payload: string | null): ParsedSsePayload {
  if (!payload || payload === "[DONE]") return { event: null, malformed: false };
  try {
    const event = JSON.parse(payload) as unknown;
    return {
      event: event && typeof event === "object" && !Array.isArray(event)
        ? event as ParsedSseEvent
        : null,
      malformed: false,
    };
  } catch {
    return { event: null, malformed: true };
  }
}

function discardThroughNextSseBoundary(buffer: string): string | null {
  const next = nextSseBlock(buffer);
  return next ? next.rest : null;
}
```

Replace the inspector's current `feed` body (`src/server/relay.ts:503-512`) with
the full body below. Add `const utf8 = new TextEncoder();` and
`let discardingOversizedBlock = false;` beside `decoder`/`buffer` in
`createSseInspector`.

```ts
feed(chunk) {
  buffer += decoder.decode(chunk, { stream: true });

  // Once a candidate exceeds the limit without a delimiter, none of its bytes
  // are a trustworthy event. Do not parse its tail as a new SSE block: discard
  // through the next blank-line boundary, then resume with bytes after it.
  if (discardingOversizedBlock) {
    const rest = discardThroughNextSseBoundary(buffer);
    if (rest === null) {
      buffer = "";
      return;
    }
    buffer = rest;
    discardingOversizedBlock = false;
  }

  let next: { block: string; rest: string } | null;
  while ((next = nextSseBlock(buffer))) {
    buffer = next.rest;
    if (reported && !handlers.onCompletedResponse) continue;
    scanPayload(sseDataPayload(next.block));
  }

  if (utf8.encode(buffer).byteLength > MAX_INSPECTION_SSE_FRAME_BYTES) {
    // Do not include payload bytes: usage debug/request logs must not become a
    // second unbounded retention path. One warning represents one dropped frame.
    console.warn(`[ocx] discarded oversized SSE inspection frame (> ${MAX_INSPECTION_SSE_FRAME_BYTES} bytes)`);
    buffer = "";
    discardingOversizedBlock = true;
  }
},
```

The overflow condition is only evaluated after every already-complete block has
been consumed. Thus the dropped bytes are exactly one *unterminated candidate*.
On overflow, preserve no bytes from that candidate, log one payload-free warning,
and set `discardingOversizedBlock`. Subsequent chunks are not parsed until
`nextSseBlock` finds the next `\n\n`, `\r\n\r\n`, or mixed equivalent delimiter
recognized by the existing regex (`src/server/relay.ts:91-97`). The delimiter is
dropped too. Only bytes after that delimiter are preserved and become the next
candidate. This is the necessary SSE resynchronization: retaining an arbitrary
tail would turn mid-frame `data:` text into a false event. It intentionally loses
the oversized event's terminal/usage/debug data rather than corrupting a later
event; all inspection is already best effort (`src/server/relay.ts:473-475`,
`src/server/request-log.ts:513-515`).

`finish` must not scan a discarded candidate. Replace its complete body
(`src/server/relay.ts:513-519`) with:

```ts
finish() {
  buffer += decoder.decode();
  if (discardingOversizedBlock) {
    buffer = "";
    return;
  }
  if (buffer.trim() && !reported) {
    scanPayload(sseDataPayload(buffer));
  }
  buffer = "";
},
```

The 1 MiB value is intentionally far above ordinary Responses SSE events but
far below the unbounded queue. It bounds the inspector's textual candidate and
the temporary UTF-8 measurement allocation to roughly 1 MiB per inspection
reader. It is not a client protocol limit: the client branch receives every
byte unchanged through `nativeBody` (`src/server/responses/core.ts:1686`,
`src/server/responses/core.ts:1746-1755`).

## Single parse and bounded continuation reconstruction

`rememberResponseState` only accepts a response when `id` is a string and
`output` is an array, then copies that output into the continuation state
(`src/responses/state.ts:444-467`). Therefore the map is needed only until a
`response.completed` payload has been reconstructed and synchronously passed to
`onCompletedResponse`; it is not needed after that call returns.

Replace `scanPayload` in `src/server/relay.ts:453-501` with this full body. It
preserves the current ordering: log metadata first, first-output timing next,
terminal metadata before terminal callback, then continuation capture
(`src/server/relay.ts:453-500`).

```ts
const scanPayload = (payload: string | null): void => {
  const parsed = parseSsePayload(payload);
  if (!reported && handlers.logCtx) {
    inspectResponseLogSsePayload(handlers.logCtx, payload, parsed);
  }
  reportFirstOutput(parsed.event);
  if (!payload) return;

  if (!reported && handlers.onTerminal) {
    const status = terminalStatusFromParsedSseEvent(parsed.event);
    if (status) {
      reported = true;
      if (handlers.logCtx) {
        handlers.logCtx.transportPhase = "terminal_sse";
        handlers.logCtx.terminalSource = "upstream";
      }
      handlers.onTerminal(status);
    }
  }

  if (!handlers.onCompletedResponse) return;
  const doneItem = parsed.event?.type === "response.output_item.done" ? parsed.event.item : undefined;
  if (parsed.event
    && doneItem !== undefined
    && Number.isInteger(parsed.event.output_index)
    && (parsed.event.output_index as number) >= 0
    && typeof doneItem === "object"
    && doneItem !== null
    && !Array.isArray(doneItem)
    && typeof (doneItem as { type?: unknown }).type === "string") {
    const outputIndex = parsed.event.output_index as number;
    if (completedItemsByOutputIndex!.has(outputIndex)) {
      completedItemsByOutputIndex!.set(outputIndex, doneItem);
    } else if (completedItemsByOutputIndex!.size < MAX_COMPLETED_OUTPUT_ITEMS) {
      completedItemsByOutputIndex!.set(outputIndex, doneItem);
    } else {
      const highestIndex = Math.max(...completedItemsByOutputIndex!.keys());
      if (outputIndex < highestIndex) {
        completedItemsByOutputIndex!.delete(highestIndex);
        completedItemsByOutputIndex!.set(outputIndex, doneItem);
      }
      // Retain the lowest indexes deterministically; do not retain an
      // unbounded pathological response just to improve best-effort replay.
    }
  }

  let response = completedResponseFromParsedEvent(parsed.event);
  if (response
    && (!Array.isArray(response.output) || response.output.length === 0)
    && completedItemsByOutputIndex!.size > 0) {
    response = {
      ...response,
      output: [...completedItemsByOutputIndex!.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, item]) => item),
    };
  }
  if (!response) return;
  try {
    handlers.onCompletedResponse(response);
  } finally {
    // The consumer synchronously copies response.output into state. No later
    // event needs these retained item objects after this completed callback.
    completedItemsByOutputIndex!.clear();
  }
};
```

Also replace the parse-based helper bodies with event-based equivalents and keep
the public payload wrappers for existing callers:

```ts
function terminalStatusFromParsedSseEvent(event: ParsedSseEvent | null): ResponsesTerminalStatus | null {
  switch (event?.type) {
    case "response.completed": return "completed";
    case "response.failed": return "failed";
    case "response.incomplete": return "incomplete";
    default: return null;
  }
}

export function terminalStatusFromSsePayload(payload: string): ResponsesTerminalStatus | null {
  return terminalStatusFromParsedSseEvent(parseSsePayload(payload).event);
}

function completedResponseFromParsedEvent(
  event: ParsedSseEvent | null,
): { id?: unknown; output?: unknown; status?: unknown } | null {
  if (event?.type !== "response.completed") return null;
  const response = event.response;
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  return response as { id?: unknown; output?: unknown; status?: unknown };
}

function isFirstOutputSseEvent(event: ParsedSseEvent | null): boolean {
  return (event?.type === "response.output_text.delta"
    || event?.type === "response.reasoning_summary_text.delta"
    || event?.type === "response.reasoning_text.delta")
    && typeof event.delta === "string"
    && event.delta.length > 0;
}

export function isFirstOutputSsePayload(payload: string | null): boolean {
  return isFirstOutputSseEvent(parseSsePayload(payload).event);
}
```

Change `createFirstOutputReporter` to accept the already-parsed event, so the
first-output timing contract stays identical without a second parse:

```ts
function createFirstOutputReporter(onFirstOutput?: () => void): (event: ParsedSseEvent | null) => void {
  let reported = false;
  return event => {
    if (reported || !isFirstOutputSseEvent(event)) return;
    reported = true;
    try { onFirstOutput?.(); } catch { /* metrics must not break the stream */ }
  };
}
```

Update the two non-inspector callers at `src/server/relay.ts:132` and
`src/server/relay.ts:200-202` to parse once locally before calling both
`inspectResponseLogSsePayload` and `reportFirstOutput`; this keeps the public
wrapper behavior and avoids a new type mismatch. They are not part of the tee
amplifier but should not retain the old double parse.

### Request-log signature and error tolerance

`inspectResponseLogSsePayload` changes from
`(logCtx, payload)` to `(logCtx, payload, parsed?)`, where the optional
`ParsedSsePayload` is supplied only by a caller that has already parsed. A
standalone caller retains its current behavior by parsing internally. The
request-log path must keep raw malformed payload fallback: an invalid JSON SSE
payload can still be the only redacted upstream error text
(`src/server/request-log.ts:536-577`).

At the top of `src/server/request-log.ts`, add this structural (type-only)
shape; it deliberately avoids importing from `relay.ts`:

```ts
type ParsedSsePayload = {
  event: unknown;
  malformed: boolean;
};
```

Replace the full function body at `src/server/request-log.ts:507-534` and the
full `captureUpstreamError` body at `src/server/request-log.ts:536-578`:

```ts
export function inspectResponseLogSsePayload(
  logCtx: RequestLogContext,
  payload: string | null,
  parsed?: ParsedSsePayload,
): void {
  if (!payload || payload.trim() === "[DONE]") return;
  const debugEnabled = isUsageDebugEnabled();
  const sseAlreadyMarked = logCtx.usageDebugBodyKind === "sse";
  const event = parsed ?? (() => {
    try {
      return { event: JSON.parse(payload), malformed: false };
    } catch {
      return { event: null, malformed: true };
    }
  })();
  if (!event.malformed) applyResponseLogMetadata(logCtx, event.event);
  captureUpstreamError(logCtx, payload, event);
  if (debugEnabled) {
    if (!sseAlreadyMarked) {
      logCtx.usageDebugBodyKind = "sse";
      logCtx.usageDebugBodySample = truncateForDebug(payload);
    } else if (typeof logCtx.usageDebugBodySample === "string"
      && logCtx.usageDebugBodySample.length < USAGE_DEBUG_BODY_SAMPLE_BYTES) {
      const combined = `${logCtx.usageDebugBodySample}\n${payload}`;
      logCtx.usageDebugBodySample = truncateForDebug(combined);
    }
  }
}

function captureUpstreamError(
  logCtx: RequestLogContext,
  text: string | null,
  parsed?: ParsedSsePayload,
): void {
  if (!text) return;
  let event = parsed;
  if (!event) {
    try {
      event = { event: JSON.parse(text), malformed: false };
    } catch {
      event = { event: null, malformed: true };
    }
  }
  if (event.malformed) {
    if (!logCtx.upstreamError && text.trim()) {
      logCtx.upstreamError = redactSecretString(text.trim()).slice(0, 500);
    }
    return;
  }
  const json = event.event as {
    type?: unknown;
    error?: { message?: unknown };
    last_error?: { message?: unknown };
    response?: {
      error?: { type?: unknown; code?: unknown; message?: unknown };
      incomplete_details?: { reason?: unknown };
    };
  };
  captureTerminalHttpStatus(logCtx, json);
  const reason = json?.response?.incomplete_details?.reason;
  if (json.type === "response.incomplete"
    && logCtx.terminalIncompleteReason === undefined
    && typeof reason === "string"
    && reason.trim()) {
    logCtx.terminalIncompleteReason = reason.trim();
  }
  if (logCtx.upstreamError) return;
  const message = json?.error?.message
    ?? json?.last_error?.message
    ?? json?.response?.error?.message;
  if (typeof message === "string" && message.trim()) {
    logCtx.upstreamError = redactSecretString(message).slice(0, 500);
  } else if (typeof reason === "string" && reason.trim()) {
    logCtx.upstreamError = redactSecretString(incompleteReasonLabel(reason.trim())).slice(0, 500);
  }
}
```

This preserves both tolerances: continuation ignores malformed JSON (current
`src/server/relay.ts:471-475`); log metadata ignores malformed JSON but still
records a redacted raw upstream error (current `src/server/request-log.ts:511-516`,
`src/server/request-log.ts:571-576`). It also preserves usage-debug sampling:
the first sample and capped concatenation remain byte-for-byte the current
logic (`src/server/request-log.ts:517-534`).

## Client disconnect: no new cancellation wiring in this phase

Do **not** add a new `core.ts` diff. The current path is deliberately:

```ts
// src/server/responses/core.ts:1686-1689
const [nativeBody, inspectBody] = upstreamResponse.body.tee();
const turnAc = new AbortController();
linkAbortSignal(upstream, turnAc.signal);
registerTurn(turnAc);
```

The client relay aborts `upstream` in `cancel` (`src/server/relay.ts:84-87`),
and `linkAbortSignal` aborts its first `AbortController` from the supplied
signal (`src/server/responses/core.ts:2573-2582`); therefore the inspection
reader's existing `turnAc.signal` listener cancels it (`src/server/relay.ts:537-554`).
This is indirect in object topology, but it is intentional and synchronous
enough for lifecycle semantics. Do not wire `clientBody.cancel` directly to
`reader.cancel` or abort `turnAc` ahead of the upstream abort.

The risk is terminal-outcome loss: a real terminal observed after the client
disconnect must still call `reportNativeTerminal`, whereas a true cancel without
a terminal uses `onNativePassthroughCancel` (`src/server/responses/core.ts:1691-1723`).
That is the #44 contract. Eager cancellation could race a queued terminal and
downgrade a completed/failed turn to a cancel. Phase 2 only makes the inspector
faster and bounded; it must not alter this outcome ordering.

## Exact file set and tests

Implementation changes exactly these source/test files (plus this plan record):

- `src/server/relay.ts` — helpers, bounded `feed`/`finish`, one parse shared by inspector consumers.
- `src/server/request-log.ts` — optional parsed event handoff and raw-error-preserving capture.
- `tests/relay-eager.test.ts` — inspector framing/parse/first-output tests.
- `tests/responses-state.test.ts` — reconstruction cap and post-callback-release tests.
- `tests/consume-for-inspection-cancel.test.ts` — cancellation remains terminal-suppressing for a true cancel.

No `src/server/responses/core.ts` change is planned. The existing cancellation
coverage is `tests/consume-for-inspection-cancel.test.ts:20-50`; inspector
extraction locks are in `tests/relay-eager.test.ts:361-411`; continuation
reconstruction is in `tests/responses-state.test.ts:239-265` and
`tests/responses-state.test.ts:367-461`.

Add these complete regression tests (with existing `enc`, `sse`, and test
helpers where those files already define them):

```ts
test("drops an oversized unterminated frame and resynchronizes at the next SSE boundary", () => {
  const terminals: string[] = [];
  const inspector = createSseInspector({ onTerminal: status => terminals.push(status) });
  const huge = "x".repeat(1_048_577);
  inspector.feed(enc.encode(`data: ${huge}`));
  // The next blank line terminates the discarded candidate; only the following
  // complete block may be parsed.
  inspector.feed(enc.encode(`\n\ndata: ${COMPLETED}\n\n`));
  inspector.finish();
  expect(terminals).toEqual(["completed"]);
});

test("caps reconstructed done items while retaining the lowest output indexes", () => {
  let captured: { output?: unknown } | undefined;
  const inspector = createSseInspector({ onCompletedResponse: response => { captured = response; } });
  for (let index = 300; index >= 0; index--) {
    inspector.feed(enc.encode(`data: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: index,
      item: { type: "message", id: `item_${index}`, role: "assistant", content: [] },
    })}\n\n`));
  }
  inspector.feed(enc.encode(`data: ${JSON.stringify({
    type: "response.completed",
    response: { id: "resp_bounded_items", status: "completed", output: [] },
  })}\n\n`));
  expect(captured?.output).toHaveLength(256);
  expect((captured?.output as Array<{ id: string }>).at(0)?.id).toBe("item_0");
  expect((captured?.output as Array<{ id: string }>).at(-1)?.id).toBe("item_255");
});

test("shares one parsed event across metadata, continuation, terminal, and first-output", () => {
  const logCtx = {} as RequestLogContext;
  const terminals: string[] = [];
  const completed: unknown[] = [];
  let firstOutput = 0;
  const inspector = createSseInspector({
    logCtx,
    onTerminal: status => terminals.push(status),
    onCompletedResponse: response => completed.push(response),
    onFirstOutput: () => firstOutput++,
  });
  inspector.feed(enc.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x" })}\n\n`));
  inspector.feed(enc.encode(`data: ${COMPLETED}\n\n`));
  expect(firstOutput).toBe(1);
  expect(terminals).toEqual(["completed"]);
  expect(completed).toHaveLength(1);
});
```

The first test is the mandatory **activation grounding**: it proves the cap
fires by forcing `1_048_577` bytes without an SSE boundary and proves that the
subsequent complete terminal is parsed only after delimiter resynchronization.
Spy on `console.warn` in that test and assert exactly one call containing
`discarded oversized SSE inspection frame`; otherwise a passing final terminal
would not prove the bound fired. Restore the spy in `finally`.

Add one assertion to the existing mid-drain cancel test that a terminal fed
after `ac.abort()` is not recorded. This locks the existing #44 split: genuine
already-parsed terminal wins, true client cancellation suppresses synthetic
terminal (`tests/consume-for-inspection-cancel.test.ts:31-40`).

Run:

```bash
bun test tests/relay-eager.test.ts tests/responses-state.test.ts tests/consume-for-inspection-cancel.test.ts
bun run typecheck
bun run privacy:scan
```

## Acceptance measurement and non-goals

Use the Phase 1 harness with the same Bun 1.3.14/macOS arm64 workload,
concurrency, upstream pacing, response size, sampling cadence, and three-run
reporting. Phase 2 helps only if it reduces the **inspection-lag workload**
median peak external by at least 20% *and* peak RSS by at least 10%, with no
regression in first-output timing beyond 5% and all terminal/continuation/log
assertions passing. Report absolute peaks and deltas for each run; do not
substitute heapUsed for external or RSS.

It did **not** help if median peak external changes by less than 10%, or RSS
changes by less than 5%, or any run is worse by more than 10%. That result is
valuable evidence that tee queueing rather than inspector work dominates and
Phase 3 must be evaluated as the structural change. Do not claim allocator RSS
retention is fixed: even the single-reader HTTP baseline pinned 1.65–2.04 GiB
after GC (`devlog/_plan/260731_macos_rss_retention/000_plan.md:50-58`).

Non-goals:

- No change to which stream path macOS selects; the `win32` eager gate remains (`src/server/responses/core.ts:1626-1628`).
- No tee removal, client-side rewrite migration, or failed-tail behavior change; those are Phase 3 concerns.
- No change to terminal outcome recording (#44), continuation semantics for normal-sized streams, first-output timing semantics, or usage-debug sampling semantics.
- No runtime upgrade, allocator intervention, provider-adapter change, or new Node-only API.
