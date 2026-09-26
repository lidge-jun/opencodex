import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { parseKiroEvent } from "../../../src/adapters/kiro-events";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../../../src/lib/debug-log-buffer";
import { clearDebugSetting, getDebugSettings, setDebugSettings } from "../../../src/lib/debug-settings";

const enc = new TextEncoder();

describe("parseKiroEvent - meteringEvent", () => {
  test("parses real precise sample metering event with unit and usage", () => {
    const raw = enc.encode(JSON.stringify({ unit: "credit", usage: 0.04582331509121062 }));
    expect(parseKiroEvent("meteringEvent", raw)).toEqual({
      type: "metering",
      unit: "credit",
      usage: 0.04582331509121062,
    });

    const withPlural = enc.encode(
      JSON.stringify({ unit: "credit", unitPlural: "credits", usage: 0.04582331509121062 }),
    );
    expect(parseKiroEvent("meteringEvent", withPlural)).toEqual({
      type: "metering",
      unit: "credit",
      usage: 0.04582331509121062,
      unitPlural: "credits",
    });
  });

  test("parses zero usage", () => {
    const raw = enc.encode(JSON.stringify({ unit: "credit", usage: 0 }));
    expect(parseKiroEvent("meteringEvent", raw)).toEqual({
      type: "metering",
      unit: "credit",
      usage: 0,
    });
  });

  test("parses amount alias and prefers usage over amount when both present", () => {
    const aliasOnly = enc.encode(JSON.stringify({ unit: "credit", amount: 0.01 }));
    expect(parseKiroEvent("meteringEvent", aliasOnly)).toEqual({
      type: "metering",
      unit: "credit",
      usage: 0.01,
    });

    const both = enc.encode(JSON.stringify({ unit: "credit", usage: 0.05, amount: 0.01 }));
    expect(parseKiroEvent("meteringEvent", both)).toEqual({
      type: "metering",
      unit: "credit",
      usage: 0.05,
    });
  });

  test("rejects invalid values", () => {
    const invalidCases = [
      { payload: { unit: "credit", usage: -1 }, desc: "negative usage" },
      { payload: { unit: "credit", amount: -0.01 }, desc: "negative amount" },
      { payload: { unit: "credit", usage: "0.5" }, desc: "string usage" },
      { payload: { unit: "credit", amount: "0.5" }, desc: "string amount" },
      { payload: { unit: "credit", usage: null }, desc: "null usage" },
      { payload: { unit: "credit" }, desc: "missing usage and amount" },
      { payload: { usage: 1 }, desc: "missing unit" },
      { payload: { unit: 123, usage: 1 }, desc: "non-string unit" },
      { payload: { unit: null, usage: 1 }, desc: "null unit" },
      { payload: { unit: "credit", unitPlural: 123, usage: 1 }, desc: "non-string unitPlural" },
    ];

    for (const { payload, desc } of invalidCases) {
      const raw = enc.encode(JSON.stringify(payload));
      expect(() => parseKiroEvent("meteringEvent", raw), desc).toThrow(
        /invalid Kiro meteringEvent payload/,
      );
    }

    // Non-finite number
    expect(() =>
      parseKiroEvent("meteringEvent", enc.encode('{"unit":"credit","usage":Infinity}')),
    ).toThrow(/invalid Kiro meteringEvent payload/);

    // Malformed JSON / non-object
    expect(() => parseKiroEvent("meteringEvent", enc.encode("not-json"))).toThrow(
      /invalid Kiro meteringEvent payload/,
    );
    expect(() => parseKiroEvent("meteringEvent", enc.encode("123"))).toThrow(
      /invalid Kiro meteringEvent payload/,
    );
  });
});

describe("parseKiroEvent - initial-response", () => {
  test("aliases message_metadata conversationId parsing", () => {
    const withConv = enc.encode(JSON.stringify({ conversationId: "conv-12345" }));
    expect(parseKiroEvent("initial-response", withConv)).toEqual({
      type: "message_metadata",
      conversationId: "conv-12345",
    });

    const withUtt = enc.encode(JSON.stringify({ utteranceId: "utt-67890" }));
    expect(parseKiroEvent("initial-response", withUtt)).toEqual({
      type: "message_metadata",
      conversationId: "utt-67890",
    });

    const empty = enc.encode(JSON.stringify({}));
    expect(parseKiroEvent("initial-response", empty)).toEqual({
      type: "message_metadata",
      conversationId: undefined,
    });
  });
});

describe("parseKiroEvent - unknown event diagnostics", () => {
  let origDebug: string | undefined;
  let origDebugFrames: string | undefined;
  let origDebugOverride: boolean | undefined;

  beforeEach(() => {
    origDebug = process.env.OCX_DEBUG;
    origDebugFrames = process.env.OCX_DEBUG_FRAMES;
    origDebugOverride = getDebugSettings().runtimeOverride.debug;
    delete process.env.OCX_DEBUG;
    delete process.env.OCX_DEBUG_FRAMES;
    clearDebugSetting("debug");
    resetDebugLogBufferForTests();
  });

  afterEach(() => {
    if (origDebug === undefined) delete process.env.OCX_DEBUG; else process.env.OCX_DEBUG = origDebug;
    if (origDebugFrames === undefined) delete process.env.OCX_DEBUG_FRAMES; else process.env.OCX_DEBUG_FRAMES = origDebugFrames;
    if (origDebugOverride === undefined) clearDebugSetting("debug");
    else setDebugSettings({ debug: origDebugOverride });
    resetDebugLogBufferForTests();
  });

  test("unknown event diagnostics omit upstream-controlled header and payload bytes", () => {
    setDebugSettings({ debug: true });
    const error = spyOn(console, "error").mockImplementation(() => {});

    try {
      const payload = enc.encode("sensitive-payload-that-must-not-be-parsed-or-logged");
      const result = parseKiroEvent("someUnknownFutureEvent", payload);

      expect(result).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);

      const line = String(error.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("[ocx:kiro:unknown_event]");
      expect(line).toContain('"eventTypeLength":22');
      expect(line).not.toContain("someUnknownFutureEvent");
      expect(line).not.toContain("sensitive-payload");

      const logEntries = getDebugLogEntries();
      expect(logEntries.some((entry) => entry.line.includes("[ocx:kiro:unknown_event]"))).toBe(true);
      expect(logEntries.some((entry) => entry.line.includes("sensitive-payload"))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  test("unknown event stays quiet when debug is disabled and does not log or parse payload", () => {
    setDebugSettings({ debug: false });
    const error = spyOn(console, "error").mockImplementation(() => {});

    try {
      const payload = enc.encode("sensitive-payload-that-must-not-be-parsed-or-logged");
      const result = parseKiroEvent("someUnknownFutureEvent", payload);

      expect(result).toBeNull();
      expect(error).not.toHaveBeenCalled();
      expect(getDebugLogEntries()).toHaveLength(0);
    } finally {
      error.mockRestore();
    }
  });
});
