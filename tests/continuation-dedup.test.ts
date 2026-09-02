/**
 * Replay-overlap detection (#1412): when the client already carries the stored history,
 * prepending the stored copy doubles it, and the doubled turn is stored again.
 *
 * The dangerous failure here is the FALSE SKIP -- dropping history the client did not
 * actually send -- so most of these cases assert that a plausible-looking overlap still
 * expands.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  expandPreviousResponseInput,
  previousResponseReplayPrefixLength,
  rememberResponseState,
  replayOverlapSkipsForTests,
  responseStateMetrics,
  setResponseStateByteCapForTests,
} from "../src/responses/state";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let home: string;
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env["OPENCODEX_HOME"];
  home = mkdtempSync(join(tmpdir(), "ocx-dedup-"));
  process.env["OPENCODEX_HOME"] = home;
  clearResponseStateForTests();
});

afterEach(() => {
  clearResponseStateForTests();
  removeTreeWithRetry(home);
  if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
  else process.env["OPENCODEX_HOME"] = priorHome;
});

/** A completed response whose output carries a provider-issued id. */
function identifiedResponse(id: string, text: string) {
  return {
    id,
    status: "completed",
    output: [{ type: "message", id: `msg_${id}`, role: "assistant", content: text }],
  };
}

/** A completed response whose output carries NO stable identity. */
function anonymousResponse(id: string, text: string) {
  return {
    id,
    status: "completed",
    output: [{ type: "message", role: "assistant", content: text }],
  };
}

describe("replay overlap: skips a verbatim client-carried history", () => {
  test("does not double when the client replays the whole stored conversation", () => {
    const first = identifiedResponse("resp_1", "answer one");
    rememberResponseState({ model: "m", input: "question one", store: true }, first);

    const clientInput = [
      { role: "user", content: "question one" },
      first.output[0],
      { role: "user", content: "question two" },
    ];
    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: clientInput,
    }) as { previous_response_id?: string; input: unknown[] };

    expect(result.input).toEqual(clientInput);
    expect(replayOverlapSkipsForTests()).toBe(1);
  });

  test("stays 1x across repeated identical turns", () => {
    const first = identifiedResponse("resp_rep", "answer");
    rememberResponseState({ model: "m", input: "ask", store: true }, first);
    const clientInput = [{ role: "user", content: "ask" }, first.output[0]];

    for (let turn = 0; turn < 3; turn += 1) {
      const result = expandPreviousResponseInput({
        model: "m",
        previous_response_id: first.id,
        input: clientInput,
      }) as { input: unknown[] };
      expect(result.input).toHaveLength(clientInput.length);
    }
    expect(replayOverlapSkipsForTests()).toBe(3);
  });

  test("keeps previous_response_id so provider continuity survives", () => {
    // Kiro and Cursor recover their conversation ids from this field; stripping it would
    // silently start a new upstream conversation.
    const first = identifiedResponse("resp_keep", "answer");
    rememberResponseState({ model: "m", input: "ask", store: true }, first);

    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: [{ role: "user", content: "ask" }, first.output[0]],
    }) as { previous_response_id?: string };

    expect(result.previous_response_id).toBe("resp_keep");
  });

  test("records the replay prefix boundary so historical markers stay acknowledged", () => {
    // The parser uses this boundary to avoid re-acknowledging an old compaction marker,
    // and guidance de-duplication scans the same prefix.
    const first = identifiedResponse("resp_prefix", "answer");
    rememberResponseState({ model: "m", input: "ask", store: true }, first);

    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: [{ role: "user", content: "ask" }, first.output[0], { role: "user", content: "next" }],
    });

    expect(previousResponseReplayPrefixLength(result)).toBe(2);
  });
});

describe("replay overlap: refuses to skip without provider-authored evidence", () => {
  test("a client repeating its own message does not authorize a skip", () => {
    // The decisive case. Stored history is one client message with empty output; the client
    // legitimately sends that same message again as a NEW occurrence. Content equality alone
    // would skip here and silently delete the earlier occurrence.
    const first = { id: "resp_repeat", status: "completed", output: [] as unknown[] };
    rememberResponseState({ model: "m", input: "repeat", store: true }, first);

    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: "resp_repeat",
      input: [{ role: "user", content: "repeat" }, { role: "user", content: "new" }],
    }) as { input: unknown[] };

    expect(result.input).toHaveLength(3);
    expect(replayOverlapSkipsForTests()).toBe(0);
  });

  test("id-less provider output does not authorize a skip", () => {
    // Position inside response.output proves only where an item sits, not who authored it.
    const first = anonymousResponse("resp_anon", "answer");
    rememberResponseState({ model: "m", input: "ask", store: true }, first);

    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: [{ role: "user", content: "ask" }, first.output[0]],
    }) as { input: unknown[] };

    expect(result.input).toHaveLength(4);
    expect(replayOverlapSkipsForTests()).toBe(0);
  });

  test("a partial prefix match expands rather than truncating history", () => {
    const first = identifiedResponse("resp_partial", "answer");
    rememberResponseState({ model: "m", input: "ask", store: true }, first);

    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: [{ role: "user", content: "ask" }, { role: "user", content: "different" }],
    }) as { input: unknown[] };

    expect(result.input).toHaveLength(4);
    expect(replayOverlapSkipsForTests()).toBe(0);
  });

  test("the same items in a different order expand", () => {
    const first = identifiedResponse("resp_order", "answer");
    rememberResponseState({ model: "m", input: "ask", store: true }, first);

    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: [first.output[0], { role: "user", content: "ask" }],
    }) as { input: unknown[] };

    expect(replayOverlapSkipsForTests()).toBe(0);
    expect(result.input).toHaveLength(4);
  });

  test("a delta continuation expands exactly as before", () => {
    const first = identifiedResponse("resp_delta", "answer");
    rememberResponseState({ model: "m", input: "ask", store: true }, first);

    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: [{ role: "user", content: "only the new part" }],
    }) as { input: unknown[] };

    expect(result.input).toEqual([
      { role: "user", content: "ask" },
      first.output[0],
      { role: "user", content: "only the new part" },
    ]);
    expect(replayOverlapSkipsForTests()).toBe(0);
  });

  test("empty client input expands", () => {
    const first = identifiedResponse("resp_empty", "answer");
    rememberResponseState({ model: "m", input: "ask", store: true }, first);

    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: [],
    }) as { input: unknown[] };

    expect(result.input).toHaveLength(2);
    expect(replayOverlapSkipsForTests()).toBe(0);
  });
});

describe("replay overlap: comparison is bounded", () => {
  test("items sharing a long prefix but differing in the tail are not equal", () => {
    // A sampled hash would collide here and skip, silently replacing history.
    const shared = "x".repeat(2_000);
    const first = {
      id: "resp_tail",
      status: "completed",
      output: [{ type: "message", id: "msg_tail", role: "assistant", content: `${shared}A` }],
    };
    rememberResponseState({ model: "m", input: "ask", store: true }, first);

    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: [
        { role: "user", content: "ask" },
        { type: "message", id: "msg_tail", role: "assistant", content: `${shared}B` },
      ],
    }) as { input: unknown[] };

    expect(replayOverlapSkipsForTests()).toBe(0);
    expect(result.input).toHaveLength(4);
  });

  test("an over-cap item is not comparable even with an id, so the turn expands", () => {
    const huge = "y".repeat(64 * 1024);
    const first = {
      id: "resp_huge",
      status: "completed",
      output: [{ type: "message", id: "msg_huge", role: "assistant", content: huge }],
    };
    rememberResponseState({ model: "m", input: "ask", store: true }, first);

    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: [{ role: "user", content: "ask" }, first.output[0]],
    }) as { input: unknown[] };

    expect(replayOverlapSkipsForTests()).toBe(0);
    expect(result.input).toHaveLength(4);
  });

  test("a deeply nested item is not comparable and does not overflow the stack", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 500; depth += 1) nested = { nested };
    const first = {
      id: "resp_deep",
      status: "completed",
      output: [{ type: "message", id: "msg_deep", role: "assistant", content: nested }],
    };
    rememberResponseState({ model: "m", input: "ask", store: true }, first);

    const result = expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: [{ role: "user", content: "ask" }, first.output[0]],
    }) as { input: unknown[] };

    expect(replayOverlapSkipsForTests()).toBe(0);
    expect(result.input).toHaveLength(4);
  });
});

describe("replay overlap: contracts held elsewhere", () => {
  test("the anchor survives a spill round-trip", () => {
    // Regression: writeResponseSpillDurably rebuilds the payload field by field, so an
    // anchor threaded everywhere else was still dropped on the way to disk — and a spilled
    // entry silently stopped being deduplicable.
    setResponseStateByteCapForTests(1024);
    try {
      const big = "e".repeat(4096);
      const first = {
        id: "resp_spilled",
        status: "completed",
        output: [{ type: "message", id: "msg_spilled", role: "assistant", content: big }],
      };
      rememberResponseState({ model: "m", input: "ask", store: true }, first);

      const result = expandPreviousResponseInput({
        model: "m",
        previous_response_id: first.id,
        input: [{ role: "user", content: "ask" }, first.output[0], { role: "user", content: "next" }],
      }) as { input: unknown[] };

      expect(result.input).toHaveLength(3);
      expect(replayOverlapSkipsForTests()).toBe(1);
    } finally {
      setResponseStateByteCapForTests(null);
    }
  });

  test("the skip counter is not published on the memory surface", () => {
    // /api/system/memory pins exactly 12 privacy-reviewed scalar fields.
    expect(Object.keys(responseStateMetrics())).toHaveLength(12);
  });

  test("clearing state for tests resets the skip counter", () => {
    const first = identifiedResponse("resp_reset", "answer");
    rememberResponseState({ model: "m", input: "ask", store: true }, first);
    expandPreviousResponseInput({
      model: "m",
      previous_response_id: first.id,
      input: [{ role: "user", content: "ask" }, first.output[0]],
    });
    expect(replayOverlapSkipsForTests()).toBe(1);

    clearResponseStateForTests();
    expect(replayOverlapSkipsForTests()).toBe(0);
  });
});
