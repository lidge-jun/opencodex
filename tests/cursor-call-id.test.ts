import { describe, expect, test } from "bun:test";
import { decodeCursorCallId, encodeCursorCallId } from "../src/adapters/cursor/call-id";
import { mapCursorServerMessage } from "../src/adapters/cursor/message-mapper";
import type { CursorMessageMapperState } from "../src/adapters/cursor/message-mapper";
import type { CursorKvStore } from "../src/adapters/cursor/kv-store";

const COMPOSITE = "call-9aee6d07-edc0-442f-8466-9d3924e16e03-0\nfc_5a1a53c6-32ce-9602-bc56-459030165589_0";

function mapperState(): CursorMessageMapperState {
  const kv: CursorKvStore = { get: () => undefined, set: () => {} };
  return { kv, writeClient: () => {} };
}

describe("cursor call-id codec", () => {
  test("plain ids pass through unchanged", () => {
    expect(encodeCursorCallId("call_abc123")).toBe("call_abc123");
    expect(decodeCursorCallId("call_abc123")).toBe("call_abc123");
  });

  test("reserved-prefix ids are escaped and round-trip", () => {
    for (const id of ["ocxc1_", "ocxc1_Y2FsbF8x", "ocxc1_!!not-base64url!!", "ocxc1_raw\nwire"]) {
      const encoded = encodeCursorCallId(id);
      expect(encoded).not.toBe(id);
      expect(encoded.startsWith("ocxc1_")).toBe(true);
      expect(encoded).not.toContain("\n");
      expect(encoded).not.toContain("\r");
      expect(decodeCursorCallId(encoded)).toBe(id);
    }
  });

  test("reserved-prefix ids resembling legacy newline encodings stay opaque", () => {
    const id = "ocxc1_YQpi";
    const encoded = encodeCursorCallId(id);
    expect(encoded).not.toBe(id);
    expect(decodeCursorCallId(encoded)).toBe(id);
  });

  test("legacy encoded line breaks remain decodable", () => {
    expect(decodeCursorCallId("ocxc1_YQpi")).toBe("a\nb");
    expect(decodeCursorCallId("ocxc1_DQ")).toBe("\r");
    expect(decodeCursorCallId("ocxc1_DQo")).toBe("\r\n");
  });

  test("newline composite id round-trips through a single-line form", () => {
    const encoded = encodeCursorCallId(COMPOSITE);
    expect(encoded).not.toContain("\n");
    expect(encoded).not.toContain("\r");
    expect(encoded.startsWith("ocxc1_")).toBe(true);
    expect(decodeCursorCallId(encoded)).toBe(COMPOSITE);
  });

  test("legacy raw newline id decodes to itself (backward compat)", () => {
    expect(decodeCursorCallId(COMPOSITE)).toBe(COMPOSITE);
  });

  test("malformed encoded payloads are not corrupted", () => {
    expect(decodeCursorCallId("ocxc1_")).toBe("ocxc1_");
    expect(decodeCursorCallId("ocxc1_!!not-base64url!!")).toBe("ocxc1_!!not-base64url!!");
  });

  test("tool_call_start ids are reversible and single-line at the adapter boundary", () => {
    for (const id of [COMPOSITE, "ocxc1_YQpi"]) {
      const events = mapCursorServerMessage(
        { type: "tool_call_start", id, name: "get_weather" },
        mapperState(),
      );
      expect(events).toHaveLength(1);
      const event = events[0]!;
      if (event.type !== "tool_call_start") throw new Error("expected tool_call_start");
      expect(event.id).not.toContain("\n");
      expect(event.id).not.toContain("\r");
      expect(decodeCursorCallId(event.id)).toBe(id);
    }
  });
});
