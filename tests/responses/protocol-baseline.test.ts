/**
 * The 18-cell protocol baseline (src/protocols/baseline.ts).
 *
 * `current` describes what src/server/chat-completions.ts, src/server/claude-messages.ts and the
 * Responses pipeline do today for an eligible single-provider route; `target` is the end state of
 * devlog/_plan/260924_protocol_first_class. A change to either side is a contract change and has
 * to be made here on purpose.
 */
import { describe, expect, test } from "bun:test";
import { BASELINE_MATRIX, baselineCell } from "../../src/protocols/baseline";
import { PROTOCOLS } from "../../src/protocols/contract";

describe("baseline matrix shape", () => {
  test("has exactly one cell per inbound × upstream × stream", () => {
    expect(BASELINE_MATRIX).toHaveLength(18);
    const keys = new Set(BASELINE_MATRIX.map(cell => `${cell.inbound}>${cell.upstream}/${cell.stream}`));
    expect(keys.size).toBe(18);
    for (const inbound of PROTOCOLS) {
      for (const upstream of PROTOCOLS) {
        for (const stream of [false, true]) expect(baselineCell(inbound, upstream, stream)).toBeDefined();
      }
    }
  });

  test("the target never contains the internal Responses bridge", () => {
    for (const cell of BASELINE_MATRIX) {
      expect(cell.target.requestPath).not.toContain("responses-internal");
      expect(cell.target.mode).not.toBe("legacy-bridge");
    }
  });

  test("every same-wire target is native", () => {
    for (const cell of BASELINE_MATRIX.filter(row => row.inbound === row.upstream)) {
      expect(cell.target.mode).toBe("native");
    }
  });
});

describe("current behaviour claims", () => {
  test("Chat to Chat is native and honours the caller's stream bit", () => {
    expect(baselineCell("chat", "chat", false).current).toMatchObject({ mode: "native", responseShape: "json" });
    expect(baselineCell("chat", "chat", true).current).toMatchObject({ mode: "native", responseShape: "sse" });
  });

  test("managed Messages to Messages still replays through internal Responses", () => {
    const cell = baselineCell("messages", "messages", false);
    expect(cell.current.mode).toBe("legacy-bridge");
    expect(cell.current.requestPath).toEqual(["messages", "responses-internal", "ir", "messages"]);
    expect(cell.current.responseShape).toBe("sse-folded");
    expect(cell.target.mode).toBe("native");
  });

  test("Chat and Messages reach a Responses upstream through their codec, with no detour", () => {
    expect(baselineCell("chat", "responses", true).current).toMatchObject({ mode: "translated", requestPath: ["chat", "responses"] });
    expect(baselineCell("messages", "responses", true).current).toMatchObject({ mode: "translated", requestPath: ["messages", "responses"] });
  });

  test("cross-wire Chat and Messages paths are the legacy bridge today and IR translations in the target", () => {
    for (const [inbound, upstream] of [["chat", "messages"], ["messages", "chat"]] as const) {
      const cell = baselineCell(inbound, upstream, true);
      expect(cell.current.mode).toBe("legacy-bridge");
      expect(cell.target.requestPath).toEqual([inbound, "ir", upstream]);
    }
  });

  test("the response path runs from upstream to client", () => {
    expect(baselineCell("chat", "messages", true).current.responsePath).toEqual(["messages", "ir", "responses-internal", "chat"]);
  });
});
