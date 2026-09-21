import { describe, expect, test } from "bun:test";
import {
  attemptDeliveryRecorder,
  bindAttemptDeliveryRecorder,
  classifyRelayedResponseEvent,
  createAttemptDeliverySummary,
  normalizeAttemptDeliverySummary,
  type AttemptDeliveryTarget,
} from "../../src/usage/attempt-delivery";
import { normalizeUsageEntryForTest, type PersistedUsageEntry } from "../../src/usage/log";

const COUNTERS = Object.keys(createAttemptDeliverySummary());

describe("attempt delivery summary", () => {
  test("the recorder credits the attempt that is live when the event arrives", () => {
    let active: AttemptDeliveryTarget | undefined = {};
    const first = active;
    const scope = {};
    const recorder = bindAttemptDeliveryRecorder(scope, () => active);
    recorder.noteAdapterEvent();
    recorder.noteRelayedEvent({ semanticBytes: 4, terminal: true });

    // A key-account change seals the attempt and starts a fresh one mid-request. A recorder
    // holding a reference would keep crediting the sealed row.
    const second: AttemptDeliveryTarget = {};
    active = second;
    recorder.noteAdapterEvent();

    expect(first.deliverySummary).toEqual({
      adapterEvents: 1, relayedEvents: 1, semanticBytes: 4, sideEffectEvents: 0, terminalEvents: 1,
    });
    expect(second.deliverySummary).toEqual({
      adapterEvents: 1, relayedEvents: 0, semanticBytes: 0, sideEffectEvents: 0, terminalEvents: 0,
    });
  });

  test("a scope with no attempt records nothing and does not throw", () => {
    const scope = {};
    const recorder = bindAttemptDeliveryRecorder(scope, () => undefined);
    expect(() => { recorder.noteAdapterEvent(); recorder.noteRelayedEvent(); }).not.toThrow();
    expect(attemptDeliveryRecorder(scope)).toBe(recorder);
    expect(attemptDeliveryRecorder(undefined)).toBeUndefined();
    expect(attemptDeliveryRecorder({})).toBeUndefined();
  });

  test("semantic bytes count delivered UTF-8, never the text itself", () => {
    const observation = classifyRelayedResponseEvent("response.output_text.delta", { delta: "한글" });
    expect(observation.semanticBytes).toBe(6);
    expect(JSON.stringify(observation)).not.toContain("한글");
  });

  test("one tool call is one side effect, whatever carried its arguments", () => {
    const target: AttemptDeliveryTarget = {};
    const recorder = bindAttemptDeliveryRecorder({}, () => target);
    recorder.noteRelayedEvent(classifyRelayedResponseEvent("response.output_item.added", {
      item: { type: "function_call", name: "lookup" },
    }));
    recorder.noteRelayedEvent(classifyRelayedResponseEvent("response.function_call_arguments.delta", { delta: "{}" }));
    recorder.noteRelayedEvent(classifyRelayedResponseEvent("response.output_item.done", {
      item: { type: "function_call", name: "lookup" },
    }));
    expect(target.deliverySummary!.sideEffectEvents).toBe(1);
    expect(target.deliverySummary!.relayedEvents).toBe(3);
  });

  test("framing and control frames are relayed events but not semantic or terminal ones", () => {
    for (const name of ["response.created", "response.heartbeat", "response.output_item.done"]) {
      const observation = classifyRelayedResponseEvent(name, {});
      expect(observation.semanticBytes).toBeUndefined();
      expect(observation.terminal).toBeUndefined();
      expect(observation.sideEffect).toBeUndefined();
    }
    for (const name of ["response.completed", "response.incomplete", "response.failed"]) {
      expect(classifyRelayedResponseEvent(name, {}).terminal).toBe(true);
    }
  });

  test("a summary survives the ledger round trip and an invalid one is dropped whole", () => {
    const row = (deliverySummary: unknown): PersistedUsageEntry => ({
      requestId: "req", timestamp: 1, provider: "openai", model: "m", status: 200,
      durationMs: 1, usageStatus: "unreported",
      attempts: [{
        ordinal: 1, provider: "openai", model: "m", adapter: "openai", status: 200,
        durationMs: 1, sendCount: 1, recoveryKinds: [], usageStatus: "unreported",
        deliverySummary,
      } as never],
    });
    const good = { adapterEvents: 5, relayedEvents: 4, semanticBytes: 12, sideEffectEvents: 1, terminalEvents: 1 };
    expect(normalizeUsageEntryForTest(row(good)).attempts![0]!.deliverySummary).toEqual(good);

    // Half a summary is how a loss signal becomes a false one, so a bad count drops all five.
    for (const broken of [
      { ...good, relayedEvents: -1 },
      { ...good, semanticBytes: 1.5 },
      { ...good, terminalEvents: "1" },
      { adapterEvents: 1 },
      null,
      [],
    ]) {
      expect(normalizeUsageEntryForTest(row(broken)).attempts![0]!.deliverySummary).toBeUndefined();
    }
    // An attempt written before the field existed still reads back.
    const legacy = normalizeUsageEntryForTest(row(undefined));
    expect(legacy.attempts![0]!.deliverySummary).toBeUndefined();
    expect(legacy.attempts![0]!.ordinal).toBe(1);
  });

  test("the normalizer requires every declared counter, so a new one cannot be forgotten", () => {
    const complete = createAttemptDeliverySummary();
    expect(normalizeAttemptDeliverySummary(complete)).toEqual(complete);
    for (const key of COUNTERS) {
      const missing: Record<string, number> = { ...complete };
      delete missing[key];
      expect(normalizeAttemptDeliverySummary(missing)).toBeUndefined();
    }
  });

  test("the summary carries counts only, so no content can ride it", () => {
    const target: AttemptDeliveryTarget = {};
    const recorder = bindAttemptDeliveryRecorder({}, () => target);
    recorder.noteRelayedEvent(classifyRelayedResponseEvent("response.output_text.delta", {
      delta: "the user's private prompt",
    }));
    const serialized = JSON.stringify(target.deliverySummary);
    expect(serialized).not.toContain("private");
    expect(Object.values(target.deliverySummary!).every(value => typeof value === "number")).toBe(true);
  });

  test("a buffered response does not read as total relay loss", () => {
    const target: AttemptDeliveryTarget = {};
    const recorder = bindAttemptDeliveryRecorder({}, () => target);
    for (let index = 0; index < 4; index += 1) recorder.noteAdapterEvent();
    // Nothing calls the per-frame recorder on a non-streaming turn: the whole answer arrives as
    // one body. Left at zero, every buffered request would raise the adapter-to-client loss
    // signal these counters exist for.
    recorder.noteBufferedDelivery({
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello" }] },
        { type: "function_call", name: "lookup", arguments: "{}" },
      ],
    });
    expect(target.deliverySummary).toEqual({
      adapterEvents: 4,
      relayedEvents: 4,
      semanticBytes: 7,
      sideEffectEvents: 1,
      terminalEvents: 1,
    });
  });

  test("a buffered body contributes counts and never its text", () => {
    const target: AttemptDeliveryTarget = {};
    const recorder = bindAttemptDeliveryRecorder({}, () => target);
    recorder.noteAdapterEvent();
    recorder.noteBufferedDelivery({
      output: [{ type: "message", content: [{ type: "output_text", text: "a private answer" }] }],
    });
    expect(JSON.stringify(target.deliverySummary)).not.toContain("private");
    expect(target.deliverySummary!.semanticBytes).toBe(16);
  });
});
