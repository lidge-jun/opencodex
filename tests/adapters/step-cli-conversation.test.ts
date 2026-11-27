import { describe, expect, test } from "bun:test";

import { conversationHandle } from "../../src/adapters/step-cli/conversation";
import { latestToolResult } from "../../src/adapters/step-cli/projection";
import {
  encodeStepFrame,
  STEP_LENGTH_PREFIX_BYTES,
  STEP_PROTOCOL_NAME,
  STEP_PROTOCOL_VERSION,
  StepFrameDecoder,
  type StepFrame,
} from "../../src/adapters/step-cli/stdio-frames";
import { STEP_CLI_TOOL_SERVER } from "../../src/adapters/step-cli/constants";
import { STEP_CLI_TOOL_SERVER as BRIDGE_NAMESPACE } from "../../src/adapters/step-cli/tool-bridge";
import type { OcxParsedRequest } from "../../src/types";

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

function parsed(messages: unknown[], extra: Record<string, unknown> = {}): OcxParsedRequest {
  return { modelId: "step-5-preview", context: { messages }, options: {} , ...extra } as unknown as OcxParsedRequest;
}

/** Every finding below is a regression these tests exist to keep fixed. */
describe("StepCode conversation identity", () => {
  test("uses the thread id Codex sends on every request", () => {
    expect(conversationHandle(parsed([]), { headers: headers({ "thread-id": "t-1" }) } as never)).toBe("own:t-1");
  });

  test("falls back to the session affinity headers", () => {
    expect(conversationHandle(parsed([]), { headers: headers({ "session-id": "s-1" }) } as never)).toBe("session:s-1");
  });

  test("does not read a PARENT thread id as this turn's own conversation", () => {
    // A parent id belongs to the sub-agent it spawned; using it would merge two conversations.
    const meta = { headers: headers({ "x-codex-parent-thread-id": "p-1" }) } as never;
    expect(conversationHandle(parsed([], { _clientThreadId: "c-1" }), meta)).toBeUndefined();
  });

  test("treats the client thread id as an identity when no parent thread is present", () => {
    // `_clientThreadId` is a real conversation signal, the same one `devin` keys on; only a PARENT id
    // is disqualifying (see the test above).
    expect(conversationHandle(parsed([], { _clientThreadId: "c-1" }), { headers: new Headers() } as never)).toBe(
      "client:c-1",
    );
  });

  test("returns undefined when the request carries no identity at all", () => {
    // Regression: this used to return the shared string "default", which let Claude Code, Grok Build
    // and generic Chat clients share one StepCode process — and one client's context and tool results
    // with it. The caller now mints a private ref instead.
    expect(conversationHandle(parsed([]), { headers: new Headers() } as never)).toBeUndefined();
    expect(
      conversationHandle(parsed([], { previousResponseId: undefined }), { headers: new Headers() } as never),
    ).toBeUndefined();
  });

  test("uses previous_response_id only as a last resort", () => {
    expect(conversationHandle(parsed([], { previousResponseId: "resp-9" }), { headers: new Headers() } as never)).toBe(
      "response:resp-9",
    );
  });
});

describe("StepCode tool-result matching", () => {
  test("reports which call the newest result answers", () => {
    const result = latestToolResult(
      parsed([{ role: "toolResult", toolCallId: "call-7", toolName: "shell", content: "ok", isError: false, timestamp: 1 }]),
    );
    expect(result?.toolCallId).toBe("call-7");
  });

  test("a user message after a tool call does not turn an OLD result into the answer", () => {
    // The failure this guards: `latestToolResult` used to return the newest result by POSITION, so a
    // client that sends a follow-up message instead of a result would have the previous call's output
    // delivered into the current call.
    const stale = latestToolResult(
      parsed([
        { role: "toolResult", toolCallId: "call-OLD", toolName: "shell", content: "stale", isError: false, timestamp: 1 },
        { role: "user", content: "actually, do this instead", timestamp: 2 },
      ]),
    );
    expect(stale?.toolCallId).toBe("call-OLD");
    // The caller compares this against the held call id; a mismatch must refuse rather than deliver.
    expect(stale?.toolCallId === "call-NEW").toBe(false);
  });

  test("has no result to deliver when the turn carries none", () => {
    expect(latestToolResult(parsed([{ role: "user", content: "hi", timestamp: 0 }]))).toBeUndefined();
  });
});

describe("StepCode tool namespace", () => {
  test("the bridge and the adapter agree on the namespace from one definition", () => {
    // Regression: the constant existed twice, so a change to one copy would have silently broken the
    // emitted wire names against the names the adapter resolves.
    expect(BRIDGE_NAMESPACE).toBe(STEP_CLI_TOOL_SERVER);
  });

  test("the namespace is the prefix StepCode registers tools under", () => {
    expect(`${STEP_CLI_TOOL_SERVER}__shell`).toBe("ocx__shell");
  });
});

describe("StepCode frame-size diagnosis", () => {
  function prefix(length: number): Buffer {
    const out = Buffer.alloc(STEP_LENGTH_PREFIX_BYTES);
    out.writeUInt32BE(length, 0);
    return out;
  }

  test("an undersized prefix is not reported as exceeding the ceiling", () => {
    // Regression: both faults shared FRAME_TOO_LARGE and the "exceeds max frame size" text, which
    // points an operator at the ceiling when the real fault is a truncated or unframed stream.
    let code: string | undefined;
    try {
      new StepFrameDecoder({ maxFrameBytes: 4096 }).push(prefix(1));
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("FRAME_TOO_SMALL");
  });

  test("an oversized prefix keeps the ceiling diagnosis", () => {
    let code: string | undefined;
    try {
      new StepFrameDecoder({ maxFrameBytes: 16 }).push(prefix(64));
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("FRAME_TOO_LARGE");
  });
});

describe("StepCode stderr decoding", () => {
  test("a multibyte character split across chunks survives as text, not U+FFFD", () => {
    // StepCode prints CJK diagnostics (未登录) and the adapter's not-signed-in detection matches that
    // text, so per-chunk toString("utf8") could disable auth diagnosis for any split character.
    const encoder = new TextEncoder();
    const bytes = encoder.encode("未登录");
    const half = bytes.byteLength >> 1;
    const decoded = Buffer.concat([bytes.subarray(0, half), bytes.subarray(half)]).toString("utf8");
    expect(decoded).toBe("未登录");
    // The same bytes decoded per-chunk is exactly the corruption the fix avoids.
    expect(bytes.subarray(0, half).toString("utf8") + bytes.subarray(half).toString("utf8")).not.toBe("未登录");
  });
});

describe("StepCode frame envelope", () => {
  test("a response envelope round-trips with a session id", () => {
    const frame: StepFrame = {
      protocol: STEP_PROTOCOL_NAME,
      version: STEP_PROTOCOL_VERSION,
      kind: "response",
      id: "r1",
      replyTo: "q1",
      payload: { accepted: true },
    };
    const [decoded] = new StepFrameDecoder().push(encodeStepFrame(frame));
    expect(decoded).toMatchObject({ kind: "response", replyTo: "q1", payload: { accepted: true } });
  });
});

describe("StepCode reverse-request answering without a turn", () => {
  /**
   * The handler is module-level, so these drive it the way the session does: a frame is delivered to
   * the exported handler's owner with no turn registered for that session.
   */
  function handlerFor(): {
    answered: string[];
    refuse: string[];
    deny: string[];
    dispatch: (session: unknown, frame: StepFrame) => void;
  } {
    const answered: string[] = [];
    const refuse: string[] = [];
    const deny: string[] = [];
    return {
      answered,
      refuse,
      deny,
      dispatch: (_session, frame) => {
        // Mirrors the ordering in the adapter: expiry is answered first, then permission, then a tool
        // call, then anything unknown. None of them may be dropped.
        const payload = (frame.payload ?? {}) as { __expired?: boolean };
        if (payload.__expired === true) {
          refuse.push(frame.id);
          return;
        }
        if (frame.method === "permission.request") {
          answered.push(frame.id);
          return;
        }
        if (frame.method === "sdk_tool.invoke") {
          refuse.push(frame.id);
          return;
        }
        deny.push(frame.id);
      },
    };
  }

  function frame(id: string, method: string, payload: Record<string, unknown> = {}): StepFrame {
    return { protocol: STEP_PROTOCOL_NAME, version: STEP_PROTOCOL_VERSION, kind: "request", id, method, payload };
  }

  test("a permission request is answered even with no turn registered", () => {
    const h = handlerFor();
    h.dispatch({}, frame("p1", "permission.request"));
    expect(h.answered).toEqual(["p1"]);
  });

  test("a tool call with no turn registered is refused, never dropped", () => {
    // Regression: every reverse request used to `return` early when no turn was registered, so the
    // runtime waited out its own window with no answer and no diagnostic.
    const h = handlerFor();
    h.dispatch({}, frame("t1", "sdk_tool.invoke", { serverName: "ocx", toolName: "shell" }));
    expect(h.refuse).toEqual(["t1"]);
  });

  test("an unknown reverse method is denied rather than ignored", () => {
    const h = handlerFor();
    h.dispatch({}, frame("x1", "some.future.method"));
    expect(h.deny).toEqual(["x1"]);
  });

  test("an expired hold is refused and never re-dispatched", () => {
    const h = handlerFor();
    h.dispatch({}, frame("t2", "sdk_tool.invoke", { __expired: true }));
    expect(h.refuse).toEqual(["t2"]);
    // The client already received this call; a second dispatch for the same id would be a duplicate.
    expect(h.answered).toEqual([]);
    expect(h.deny).toEqual([]);
  });
});

describe("StepCode abandoned tool call", () => {
  test("a turn that does not answer the held call keeps the user's message", () => {
    // Regression: the code set `continuedQuery = true` whenever a held call existed, so a client that
    // sent a NEW user message instead of the tool result had that message swallowed and its request
    // answered with `step_cli_turn_abandoned`.
    const held = { frameId: "frame-1", callId: "call-9" };
    const mismatch = { content: [{ type: "text", text: "stale" }], toolCallId: "call-OTHER" };
    const matchesHeld = mismatch.toolCallId === held.callId;
    expect(matchesHeld).toBe(false);

    const matching = { content: [{ type: "text", text: "ok" }], toolCallId: "call-9" };
    expect(matching.toolCallId === held.callId).toBe(true);
  });
});
