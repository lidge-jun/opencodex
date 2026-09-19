import { afterEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../../src/adapters/google";
import { antigravitySessionAnchor, antigravitySessionId } from "../../../src/adapters/google-antigravity-wire";
import {
  classifyGoogleWireUpstreamError,
  GOOGLE_WIRE_SHAPE_MAX_SERIALIZED_BYTES,
  GOOGLE_WIRE_SHAPE_TURN_CEILING,
  summarizeGoogleWireShape,
} from "../../../src/adapters/google-wire-shape";
import { debugProviderDiagnosticLazy } from "../../../src/lib/debug";
import { getDebugLogEntries, MAX_DEBUG_LINE_BYTES, resetDebugLogBufferForTests } from "../../../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../../../src/lib/debug-settings";
import { createRequestExecutionBudget, type RequestExecutionBudgetPolicy } from "../../../src/lib/request-execution-budget";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import {
  callId,
  compactedToolSession,
  compiledWireBody,
  longToolSession,
  modelCallTurn,
  modelTextTurn,
  THOUGHT_SIGNATURE_SENTINEL,
  toolResultTurn,
  toolRoundTrip,
  unidentifiedCallTurn,
  userTurn,
  WIRE_MARKERS,
  type WireTurn,
} from "../../fixtures/google-wire-shape-cases";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const provider = {
  adapter: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  googleMode: "cloud-code-assist",
  project: "proj-123",
  apiKey: "ya29.token",
} as OcxProviderConfig;

/** Exactly `sends` physical sends allowed, with no reserve and no alternate target. */
function budgetOf(sends: number) {
  const policy: RequestExecutionBudgetPolicy = {
    maxTotalModelSends: sends,
    baseSendAllowance: sends,
    finalRecoveryAllowance: 0,
    maxAlternateTargetSends: 0,
    maxTargetTransitions: 0,
  };
  return createRequestExecutionBudget(policy, "lr-google-wire-shape-test");
}

function parsedToolSession(rounds: number, threads: { parent?: string; own?: string } = {}): OcxParsedRequest {
  const messages: unknown[] = [{ role: "user", content: "opening turn" }];
  for (let round = 1; round <= rounds; round++) {
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${round}`, name: "search", arguments: { q: "x" } }],
    });
    messages.push({ role: "toolResult", toolCallId: `call-${round}`, toolName: "search", content: "ok" });
  }
  messages.push({ role: "user", content: "next turn" });
  return {
    modelId: "gemini-3-pro",
    stream: false,
    context: { messages, systemPrompt: [], tools: [] },
    options: {},
    ...(threads.parent === undefined ? {} : { _clientThreadId: threads.parent }),
    ...(threads.own === undefined ? {} : { _codexOwnThreadId: threads.own }),
  } as unknown as OcxParsedRequest;
}

function parsedWithThreads(threads: { parent?: string; own?: string }, firstText = "opening turn"): OcxParsedRequest {
  return {
    modelId: "gemini-3-pro",
    stream: false,
    context: { messages: [{ role: "user", content: firstText }], systemPrompt: [], tools: [] },
    options: {},
    ...(threads.parent === undefined ? {} : { _clientThreadId: threads.parent }),
    ...(threads.own === undefined ? {} : { _codexOwnThreadId: threads.own }),
  } as unknown as OcxParsedRequest;
}

/** Every marker the fixtures plant, so one assertion can prove none of them survives. */
const ALL_MARKERS = [...Object.values(WIRE_MARKERS), callId(1), callId(2), callId(3)];

afterEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
});

// The projection is a diagnostic. If it can move a byte, a send, or a signature, it is worse
// than the missing information it exists to supply — so this runs before anything about shape.
describe("google wire shape projection is inert", () => {
  test("summarizing does not mutate the body it reads", () => {
    const body = compiledWireBody(longToolSession(5, { signature: WIRE_MARKERS.signature }), {
      toolDeclarations: 3,
    });
    const before = JSON.stringify(body);
    summarizeGoogleWireShape(body, { sessionAnchor: "parent-and-own", sendOrdinal: 1 });
    expect(JSON.stringify(body)).toBe(before);
  });

  test("provider debug changes neither the compiled request nor the headers", async () => {
    const adapter = createGoogleAdapter(provider);
    const request = parsedToolSession(4, { parent: "tp-9f31", own: "tc-4a02" });
    const realError = console.error;
    console.error = () => {};
    try {
      setDebugSettings({ debug: false });
      const off = await adapter.buildRequest(request);
      setDebugSettings({ debug: true });
      const on = await adapter.buildRequest(request);
      const offEnvelope = JSON.parse(off.body) as Record<string, unknown>;
      const onEnvelope = JSON.parse(on.body) as Record<string, unknown>;
      expect(JSON.stringify(onEnvelope.request)).toBe(JSON.stringify(offEnvelope.request));
      expect(on.url).toBe(off.url);
      expect(on.method).toBe(off.method);
      expect(JSON.stringify(on.headers)).toBe(JSON.stringify(off.headers));
      // The envelope requestId is a fresh uuid per build and is the only difference allowed.
      expect(onEnvelope.requestId).not.toBe(offEnvelope.requestId);
    } finally {
      console.error = realError;
    }
  });

  // buildRequest never calls fetch, so counting fetches around it proves nothing about the
  // diagnostic. The send count worth pinning is the one the budget and the physical-send
  // observer see on the real dispatch path, with the request the diagnostic just described.
  test("provider debug changes neither the physical send count nor the bytes dispatched", async () => {
    const adapter = createGoogleAdapter(provider);
    const parsedRequest = parsedToolSession(4, { parent: "tp-9f31", own: "tc-4a02" });
    const realError = console.error;
    console.error = () => {};
    try {
      const run = async (debug: boolean) => {
        setDebugSettings({ debug });
        const built = await adapter.buildRequest(parsedRequest);
        const sends: number[] = [];
        const dispatched: string[] = [];
        const executor = (async (_input: unknown, init?: { body?: unknown }) => {
          dispatched.push(typeof init?.body === "string" ? init.body : "");
          return new Response(JSON.stringify({ response: { candidates: [] } }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof globalThis.fetch;
        const response = await adapter.fetchResponse!(built, {
          executor,
          sendBudget: budgetOf(3),
          onPhysicalSend: send => { sends.push(send.ordinal); },
          timeoutMs: 5_000,
        });
        expect(response.status).toBe(200);
        const envelope = JSON.parse(dispatched[0]!) as Record<string, unknown>;
        const requestId = envelope.requestId;
        // The envelope request id is a fresh uuid per build and has nothing to do with debug;
        // normalizing it lets the rest of the dispatched body be compared byte for byte.
        envelope.requestId = "<per-build uuid>";
        return { sends, requestId, body: JSON.stringify(envelope) };
      };
      const off = await run(false);
      const on = await run(true);
      // Exactly one physical send either way, and the budget saw the same single dispatch.
      expect(off.sends).toEqual([1]);
      expect(on.sends).toEqual(off.sends);
      // And every byte that actually left is identical apart from that uuid — not merely the
      // bytes that were built.
      expect(on.body).toBe(off.body);
      expect(on.requestId).not.toBe(off.requestId);
    } finally {
      console.error = realError;
    }
  });

  // Proven by execution, not asserted: the exact expression google.ts hands to the lazy logger,
  // given a body that throws when the projection reads it.
  test("a projection that throws is swallowed and emits nothing", () => {
    const hostile = {
      get contents(): never { throw new Error("projection boom"); },
    };
    setDebugSettings({ debug: true });
    resetDebugLogBufferForTests();
    expect(() => debugProviderDiagnosticLazy(
      "google", "antigravity-wire-shape", () => summarizeGoogleWireShape(hostile),
    )).not.toThrow();
    expect(getDebugLogEntries()).toEqual([]);
  });

  test("the builder is never invoked while provider debug is off", () => {
    let built = 0;
    setDebugSettings({ debug: false });
    debugProviderDiagnosticLazy("google", "antigravity-wire-shape", () => {
      built += 1;
      return {};
    });
    expect(built).toBe(0);
  });

  test("the emitted diagnostic carries no prompt, argument, result, id or signature", async () => {
    const adapter = createGoogleAdapter(provider);
    const realError = console.error;
    console.error = () => {};
    try {
      setDebugSettings({ debug: true });
      resetDebugLogBufferForTests();
      await adapter.buildRequest(parsedToolSession(3, { parent: "tp-9f31", own: "tc-4a02" }));
      const line = getDebugLogEntries().map(entry => entry.line).find(l => l.includes("antigravity-wire-shape"));
      expect(line).toBeDefined();
      const emitted = line as string;
      for (const secret of ["opening turn", "next turn", "search", "call-1", "call-2", "proj-123", "ya29.token", THOUGHT_SIGNATURE_SENTINEL, "tp-9f31", "tc-4a02"]) {
        expect(emitted).not.toContain(secret);
      }
      expect(emitted).toContain("\"sessionAnchor\":\"parent-and-own\"");
    } finally {
      console.error = realError;
    }
  });

  test("provider debug off emits nothing at all", async () => {
    const adapter = createGoogleAdapter(provider);
    setDebugSettings({ debug: false });
    resetDebugLogBufferForTests();
    await adapter.buildRequest(parsedToolSession(3, { parent: "tp-9f31", own: "tc-4a02" }));
    expect(getDebugLogEntries()).toEqual([]);
  });
});

describe("google wire shape projection describes structure", () => {
  test("a well-formed tool round trip projects its roles, counts and pairing", () => {
    const summary = summarizeGoogleWireShape(
      compiledWireBody([userTurn(), ...toolRoundTrip(1), userTurn()], { toolDeclarations: 37 }),
      { sessionAnchor: "parent-and-own" },
    );
    expect(summary.turns).toBe(4);
    expect(summary.roles).toEqual({ user: 3, model: 1, other: 0 });
    expect(summary.functionCalls).toBe(1);
    expect(summary.functionResponses).toBe(1);
    expect(summary.distinctCallIds).toBe(1);
    expect(summary.unansweredCalls).toBe(0);
    expect(summary.unmatchedResponses).toBe(0);
    expect(summary.toolDeclarations).toBe(37);
    expect(summary.hasSystemInstruction).toBe(true);
    expect(summary.hasSessionId).toBe(true);
    expect(summary.orderingViolations).toBe(0);
    expect(summary.firstOrderingViolation).toBeNull();
    expect(summary.truncated).toBe(false);
    expect(summary.turnShapes[1]).toEqual({
      index: 1,
      role: "model",
      parts: 1,
      kinds: ["functionCall"],
      calls: [1],
      responses: [],
      signedCalls: 0,
      sentinelCalls: 0,
    });
    expect(summary.turnShapes[2]?.responses).toEqual([1]);
  });

  test("call ids become request-internal ordinals, so unrelated ids project identically", () => {
    const first = compiledWireBody([
      userTurn("first conversation"),
      modelCallTurn(["alpha-7f3c", "beta-1"]),
      toolResultTurn(["beta-1", "alpha-7f3c"]),
    ]);
    const second = compiledWireBody([
      userTurn("an entirely different conversation"),
      modelCallTurn(["toolu_01QqRz", "fc_9928"]),
      toolResultTurn(["fc_9928", "toolu_01QqRz"]),
    ]);
    expect(summarizeGoogleWireShape(first)).toEqual(summarizeGoogleWireShape(second));
    const summary = summarizeGoogleWireShape(first);
    expect(summary.turnShapes[1]?.calls).toEqual([1, 2]);
    // Responses keep their own order, and the ordinals show the answers were transposed.
    expect(summary.turnShapes[2]?.responses).toEqual([2, 1]);
    expect(JSON.stringify(summary)).not.toContain("alpha-7f3c");
  });

  test("a call turn that opens the request is flagged with its position", () => {
    const summary = summarizeGoogleWireShape(compiledWireBody([
      modelCallTurn([callId(1)]),
      toolResultTurn([callId(1)]),
    ]));
    expect(summary.firstOrderingViolation).toEqual({ index: 0, kind: "call-turn-opens-request" });
    expect(summary.orderingViolations).toBe(1);
  });

  // The reporter's case A. It is flagged because the upstream error names this relationship,
  // and it returned 200 upstream — which is why this projection reports rather than judges.
  test("a call turn after a model text turn is flagged as such", () => {
    const summary = summarizeGoogleWireShape(compiledWireBody([
      userTurn(),
      modelTextTurn(),
      modelCallTurn([callId(1)]),
      toolResultTurn([callId(1)]),
    ]));
    expect(summary.firstOrderingViolation).toEqual({ index: 2, kind: "call-turn-after-model-turn" });
    expect(summary.roles).toEqual({ user: 2, model: 2, other: 0 });
  });

  test("a response turn with no call turn before it is flagged", () => {
    const summary = summarizeGoogleWireShape(compiledWireBody([
      userTurn(),
      toolResultTurn([callId(1)]),
    ]));
    expect(summary.firstOrderingViolation).toEqual({ index: 1, kind: "response-turn-without-call-turn" });
    expect(summary.unmatchedResponses).toBe(1);
    expect(summary.unansweredCalls).toBe(0);
  });

  test("a model tail is flagged, which is what the (continue) nudge exists to prevent", () => {
    const summary = summarizeGoogleWireShape(compiledWireBody([userTurn(), modelTextTurn()]));
    expect(summary.firstOrderingViolation).toEqual({ index: 1, kind: "request-ends-with-model-turn" });
  });

  test("a call turn after an unrecognized role is not blamed on a model turn", () => {
    const summary = summarizeGoogleWireShape(compiledWireBody([
      userTurn(),
      { role: "function", parts: [{ text: WIRE_MARKERS.prompt }] },
      modelCallTurn([callId(1)]),
      toolResultTurn([callId(1)]),
    ]));
    expect(summary.roles).toEqual({ user: 2, model: 1, other: 1 });
    expect(summary.firstOrderingViolation).toEqual({ index: 2, kind: "call-turn-after-unknown-turn" });
  });

  // The exhaustive leak oracle: every marker the fixtures plant, checked against one projection.
  test("no marker the fixture plants survives into a summary", () => {
    const summary = summarizeGoogleWireShape(
      compiledWireBody([
        userTurn(),
        ...toolRoundTrip(1, { signature: WIRE_MARKERS.signature }),
        ...toolRoundTrip(2),
        modelCallTurn([callId(3)]),
        toolResultTurn([callId(3)]),
      ], { toolDeclarations: 4 }),
      { sessionAnchor: "parent-and-own", historySignedCalls: 1, replayScopeBound: true, sendOrdinal: 1, errorClass: "turn-adjacency" },
    );
    const serialized = JSON.stringify(summary);
    for (const marker of ALL_MARKERS) expect(serialized).not.toContain(marker);
    // The projection is not vacuous: it did describe the request it refused to quote.
    expect(summary.functionCalls).toBe(3);
    expect(summary.toolDeclarations).toBe(4);
    expect(summary.hasSessionId).toBe(true);
    expect(summary.signature.present).toBe(true);
  });

  test("an unanswered call and an id-less call are counted separately", () => {
    const summary = summarizeGoogleWireShape(compiledWireBody([
      userTurn(),
      modelCallTurn([callId(1), callId(2)]),
      toolResultTurn([callId(1)]),
      unidentifiedCallTurn(),
      userTurn(),
    ]));
    expect(summary.functionCalls).toBe(3);
    expect(summary.callsWithoutId).toBe(1);
    expect(summary.unansweredCalls).toBe(1);
    expect(summary.distinctCallIds).toBe(2);
  });

  test("a long session keeps exact totals and truncates only its per-turn detail", () => {
    const rounds = 60;
    const summary = summarizeGoogleWireShape(compiledWireBody(longToolSession(rounds)));
    expect(summary.turns).toBe(2 + rounds * 2);
    expect(summary.functionCalls).toBe(rounds);
    expect(summary.functionResponses).toBe(rounds);
    expect(summary.distinctCallIds).toBe(rounds);
    expect(summary.unansweredCalls).toBe(0);
    expect(summary.orderingViolations).toBe(0);
    expect(summary.truncated).toBe(true);
    // Two ceilings bind, and the tighter one wins: the turn ceiling caps the retained detail,
    // then the serialized budget trims further if the kept turns still do not fit a debug line.
    expect(summary.turnShapes.length).toBeLessThanOrEqual(GOOGLE_WIRE_SHAPE_TURN_CEILING);
    expect(summary.turnShapes.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(summary)).length)
      .toBeLessThanOrEqual(GOOGLE_WIRE_SHAPE_MAX_SERIALIZED_BYTES);
    // The retained detail is still the head of the request, where a first-send violation lives.
    expect(summary.turnShapes[0]?.index).toBe(0);
  });

  test("a parallel batch wider than the ordinal ceiling truncates the list, not the count", () => {
    const ids = Array.from({ length: 20 }, (_unused, i) => callId(i + 1));
    const summary = summarizeGoogleWireShape(compiledWireBody([
      userTurn(),
      modelCallTurn(ids),
      toolResultTurn(ids),
    ]));
    expect(summary.functionCalls).toBe(20);
    expect(summary.distinctCallIds).toBe(20);
    expect(summary.turnShapes[1]?.calls).toHaveLength(16);
    expect(summary.truncated).toBe(true);
  });

  // The item ceilings alone are not enough: 64 retained turns carrying 16 ordinals each serialize
  // past the debug buffer's per-line cap, and the buffer cuts at a byte boundary. This drives the
  // worst case through the REAL buffer and parses what comes back out of it.
  test("the worst case inside the item ceilings still parses out of the real debug buffer", () => {
    const contents: WireTurn[] = [userTurn()];
    for (let round = 0; round < 32; round++) {
      const ids = Array.from({ length: 16 }, (_unused, i) => callId(round * 16 + i + 1));
      contents.push(modelCallTurn(ids, { signature: WIRE_MARKERS.signature }), toolResultTurn(ids));
    }
    const summary = summarizeGoogleWireShape(compiledWireBody(contents, { toolDeclarations: 37 }), {
      sessionAnchor: "parent-and-own", historySignedCalls: 32, replayScopeBound: true,
    });
    expect(summary.turns).toBe(65);
    expect(summary.functionCalls).toBe(512);
    expect(summary.truncated).toBe(true);
    // The size budget bit before the turn ceiling did, which is the whole point.
    expect(summary.turnShapes.length).toBeLessThan(GOOGLE_WIRE_SHAPE_TURN_CEILING);
    expect(new TextEncoder().encode(JSON.stringify(summary)).length)
      .toBeLessThanOrEqual(GOOGLE_WIRE_SHAPE_MAX_SERIALIZED_BYTES);

    setDebugSettings({ debug: true });
    resetDebugLogBufferForTests();
    const realError = console.error;
    console.error = () => {};
    try {
      debugProviderDiagnosticLazy("google", "antigravity-wire-shape", () => summary);
    } finally {
      console.error = realError;
    }
    const entries = getDebugLogEntries();
    expect(entries).toHaveLength(1);
    const line = entries[0]!.line;
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(MAX_DEBUG_LINE_BYTES);
    // Parseable, and still honest about having been cut. A buffer-truncated line would fail the
    // parse, and its retained prefix would still have read truncated:false.
    const roundTripped = JSON.parse(line.slice(line.indexOf("] ") + 2)) as
      { truncated: boolean; turns: number; functionCalls: number; turnShapes: unknown[] };
    expect(roundTripped.truncated).toBe(true);
    expect(roundTripped.turns).toBe(65);
    expect(roundTripped.functionCalls).toBe(512);
    expect(roundTripped.turnShapes.length).toBe(summary.turnShapes.length);
  });

  test("compaction shortens the request without changing what the projection reports about a turn", () => {
    const full = summarizeGoogleWireShape(compiledWireBody(longToolSession(20)));
    const compacted = summarizeGoogleWireShape(compiledWireBody(compactedToolSession(20, 4)));
    expect(full.functionCalls).toBe(20);
    expect(compacted.functionCalls).toBe(4);
    expect(compacted.orderingViolations).toBe(0);
    expect(compacted.turnShapes[1]).toEqual({ ...full.turnShapes[1]!, index: 1 });
  });

  test("signature presence, sentinel-only signing and the two signing sources stay separable", () => {
    const unsigned = summarizeGoogleWireShape(compiledWireBody([userTurn(), ...toolRoundTrip(1)]));
    expect(unsigned.signature).toEqual({
      present: false,
      sentinelOnly: false,
      signedCalls: 0,
      sentinelCalls: 0,
      historySignedCalls: 0,
      sessionCacheSignedCalls: 0,
      replayScopeBound: false,
    });

    const signed = summarizeGoogleWireShape(
      compiledWireBody([userTurn(), ...toolRoundTrip(1, { signature: WIRE_MARKERS.signature })]),
      { historySignedCalls: 1, replayScopeBound: true },
    );
    expect(signed.signature).toEqual({
      present: true,
      sentinelOnly: false,
      signedCalls: 1,
      sentinelCalls: 0,
      historySignedCalls: 1,
      sessionCacheSignedCalls: 0,
      replayScopeBound: true,
    });
    expect(JSON.stringify(signed)).not.toContain(WIRE_MARKERS.signature);

    // A signature the translator did not supply is attributed to the Antigravity session cache.
    const fromCache = summarizeGoogleWireShape(
      compiledWireBody([userTurn(), ...toolRoundTrip(1, { signature: WIRE_MARKERS.signature })]),
      { historySignedCalls: 0, replayScopeBound: true },
    );
    expect(fromCache.signature.historySignedCalls).toBe(0);
    expect(fromCache.signature.sessionCacheSignedCalls).toBe(1);

    // Sentinel-only is the shape a lookup miss reaches the wire as: signed, but by us.
    const sentinel = summarizeGoogleWireShape(
      compiledWireBody([userTurn(), ...toolRoundTrip(1, { signature: THOUGHT_SIGNATURE_SENTINEL })]),
      { historySignedCalls: 0, replayScopeBound: true },
    );
    expect(sentinel.signature.present).toBe(true);
    expect(sentinel.signature.sentinelOnly).toBe(true);
    expect(sentinel.signature.sessionCacheSignedCalls).toBe(0);
    expect(sentinel.signature.replayScopeBound).toBe(true);
  });

  test("send facts are carried only when the caller has them", () => {
    const body = compiledWireBody([userTurn(), ...toolRoundTrip(1)]);
    expect(summarizeGoogleWireShape(body).send).toBeNull();
    expect(summarizeGoogleWireShape(body, { sendOrdinal: 1, errorClass: "turn-adjacency" }).send)
      .toEqual({ ordinal: 1, errorClass: "turn-adjacency" });
    expect(summarizeGoogleWireShape(body, { sendOrdinal: 3 }).send).toEqual({ ordinal: 3, errorClass: null });
    expect(summarizeGoogleWireShape(body).sessionAnchor).toBe("unknown");
  });

  test("a body that is not a Google request degrades to an empty description", () => {
    for (const input of [undefined, null, 42, "text", [], {}, { contents: "not-an-array" }]) {
      const summary = summarizeGoogleWireShape(input);
      expect(summary.turns).toBe(0);
      expect(summary.turnShapes).toEqual([]);
      expect(summary.truncated).toBe(false);
      expect(summary.hasSessionId).toBe(false);
    }
  });
});

describe("google wire upstream error classification", () => {
  test("the reported 400 classifies as a turn-adjacency rejection", () => {
    expect(classifyGoogleWireUpstreamError(
      "Antigravity invalid request: Please ensure that function call turn comes immediately after a user turn or after a function response turn.",
    )).toBe("turn-adjacency");
  });

  test("the neighbouring Google 400 classes stay distinct", () => {
    expect(classifyGoogleWireUpstreamError("Requests ending with a model turn are not supported")).toBe("turn-adjacency");
    expect(classifyGoogleWireUpstreamError("Invalid thought_signature: TYPE_BYTES decoding failed")).toBe("thought-signature");
    expect(classifyGoogleWireUpstreamError("tools[2].custom.input_schema is invalid")).toBe("tool-schema");
    expect(classifyGoogleWireUpstreamError("Unsupported thinkingLevel for this model")).toBe("thinking-config");
    expect(classifyGoogleWireUpstreamError("quota exceeded")).toBe("other");
  });

  test("classification is bounded and never returns upstream text", () => {
    expect(classifyGoogleWireUpstreamError(undefined)).toBe("other");
    expect(classifyGoogleWireUpstreamError("")).toBe("other");
    // Past the scan limit the marker is not read, so a huge payload cannot be walked in full.
    expect(classifyGoogleWireUpstreamError(`${"x".repeat(4096)} function call turn`)).toBe("other");
  });
});

// The session boundary is the other half of #5008: the reporter's hypothesis is that the
// upstream session diverged from what the proxy replays. The anchor class says which stability
// regime a request is in without naming the conversation.
describe("antigravity session anchor classification", () => {
  test("the four anchor classes are distinguished", () => {
    expect(antigravitySessionAnchor(parsedWithThreads({ parent: "p1", own: "c1" }))).toBe("parent-and-own");
    expect(antigravitySessionAnchor(parsedWithThreads({ parent: "p1" }))).toBe("parent-only");
    expect(antigravitySessionAnchor(parsedWithThreads({}))).toBe("text");
    expect(antigravitySessionAnchor(parsedWithThreads({}, ""))).toBe("none");
  });

  test("a direct HTTP client with no Codex headers lands on the text anchor", () => {
    const direct = parsedToolSession(2);
    expect(antigravitySessionAnchor(direct)).toBe("text");
  });

  test("an own-thread anchor keeps its class and its id when the first message is compacted", () => {
    const before = parsedWithThreads({ parent: "p1", own: "c1" }, "the original first user message");
    const after = parsedWithThreads({ parent: "p1", own: "c1" }, "a compaction summary that replaced it");
    expect(antigravitySessionAnchor(before)).toBe(antigravitySessionAnchor(after));
    expect(antigravitySessionId(before)).toBe(antigravitySessionId(after));
  });

  test("the text anchor keeps its class while its id moves under compaction", () => {
    const before = parsedWithThreads({}, "the original first user message");
    const after = parsedWithThreads({}, "a compaction summary that replaced it");
    expect(antigravitySessionAnchor(before)).toBe("text");
    expect(antigravitySessionAnchor(after)).toBe("text");
    // The instability the anchor class exists to make visible.
    expect(antigravitySessionId(before)).not.toBe(antigravitySessionId(after));
  });

  test("the same own id under two parents stays one class and two sessions", () => {
    const underP1 = parsedWithThreads({ parent: "p1", own: "shared-child" });
    const underP2 = parsedWithThreads({ parent: "p2", own: "shared-child" });
    expect(antigravitySessionAnchor(underP1)).toBe("parent-and-own");
    expect(antigravitySessionAnchor(underP2)).toBe("parent-and-own");
    expect(antigravitySessionId(underP1)).not.toBe(antigravitySessionId(underP2));
  });

  test("two overlapping children of one parent are one class and two sessions", () => {
    const childA = parsedWithThreads({ parent: "p1", own: "c1" });
    const childB = parsedWithThreads({ parent: "p1", own: "c2" });
    expect(antigravitySessionAnchor(childA)).toBe(antigravitySessionAnchor(childB));
    expect(antigravitySessionId(childA)).not.toBe(antigravitySessionId(childB));
  });

  test("a restarted proxy re-derives the same class and the same id", () => {
    // Both values come from Codex ids and message text alone; nothing process-random enters,
    // which is what lets durable replay state survive a restart.
    for (const threads of [{ parent: "p1", own: "c1" }, { parent: "p1" }, {}]) {
      const first = parsedWithThreads(threads);
      const second = parsedWithThreads(threads);
      expect(antigravitySessionAnchor(first)).toBe(antigravitySessionAnchor(second));
      expect(antigravitySessionId(first)).toBe(antigravitySessionId(second));
    }
  });

  test("the anchorless request is the one whose id does not survive a second look", () => {
    const first = parsedWithThreads({}, "");
    expect(antigravitySessionAnchor(first)).toBe("none");
    expect(antigravitySessionId(first)).not.toBe(antigravitySessionId(parsedWithThreads({}, "")));
  });

  test("the adapter reports the anchor class it actually used", async () => {
    const adapter = createGoogleAdapter(provider);
    const realError = console.error;
    console.error = () => {};
    try {
      setDebugSettings({ debug: true });
      for (const [threads, expected] of [
        [{ parent: "p1", own: "c1" }, "parent-and-own"],
        [{ parent: "p1" }, "parent-only"],
        [{}, "text"],
      ] as const) {
        resetDebugLogBufferForTests();
        await adapter.buildRequest(parsedToolSession(1, threads));
        const line = getDebugLogEntries().map(entry => entry.line).find(l => l.includes("antigravity-wire-shape"));
        expect(line).toContain(`"sessionAnchor":"${expected}"`);
      }
    } finally {
      console.error = realError;
    }
  });
});
