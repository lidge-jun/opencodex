import { describe, expect, test } from "bun:test";
import {
  GO_WS_BRIDGE_FORWARD_HEADERS_FIELD,
  forwardHeadersFromGoWsBridgeFrame,
  withGoWsBridgeForwardHeaders,
} from "../src/server/ws-bridge";

describe("Go Responses WebSocket bridge header handoff", () => {
  test("preserves only selected upgrade headers and overwrites client bridge metadata", () => {
    const source = new Headers({
      authorization: "Bearer caller-token",
      "chatgpt-account-id": "account-1",
      "x-codex-turn-state": "turn-state",
      cookie: "must-not-forward",
    });
    const frame = withGoWsBridgeForwardHeaders({
      type: "response.create",
      [GO_WS_BRIDGE_FORWARD_HEADERS_FIELD]: { authorization: "Bearer attacker-token" },
    }, source);

    const restored = forwardHeadersFromGoWsBridgeFrame(frame);
    expect(restored.get("authorization")).toBe("Bearer caller-token");
    expect(restored.get("chatgpt-account-id")).toBe("account-1");
    expect(restored.get("x-codex-turn-state")).toBe("turn-state");
    expect(restored.get("cookie")).toBeNull();
    expect(restored.get("content-type")).toBe("application/json");
  });

  test("ignores bridge metadata keys outside the forward allowlist", () => {
    const restored = forwardHeadersFromGoWsBridgeFrame({
      [GO_WS_BRIDGE_FORWARD_HEADERS_FIELD]: { authorization: "Bearer caller-token", cookie: "no" },
    });
    expect(restored.get("authorization")).toBe("Bearer caller-token");
    expect(restored.get("cookie")).toBeNull();
  });
});
