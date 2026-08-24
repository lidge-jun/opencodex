import { describe, expect, test } from "bun:test";
import { createRelayHandoffRequest } from "../src/body";

describe("createRelayHandoffRequest", () => {
  test("strips gateway authorization before relay handoff", () => {
    const original = new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer gw-test-key",
        "Content-Type": "application/json",
        "X-Custom": "keep-me",
      },
      body: '{"model":"gpt-4o"}',
    });
    const body = new TextEncoder().encode('{"model":"gpt-4o"}');
    const handoff = createRelayHandoffRequest(original, body);
    expect(handoff.headers.get("Authorization")).toBeNull();
    expect(handoff.headers.get("authorization")).toBeNull();
    expect(handoff.headers.get("X-Custom")).toBe("keep-me");
    expect(handoff.headers.get("content-length")).toBe(String(body.byteLength));
  });

  test("strips hop-by-hop and client-routing headers", () => {
    const original = new Request("https://gateway.test/v1/messages", {
      method: "POST",
      headers: {
        Host: "gateway.test",
        Connection: "keep-alive",
        "Transfer-Encoding": "chunked",
        "X-Forwarded-For": "203.0.113.1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const body = new TextEncoder().encode("{}");
    const handoff = createRelayHandoffRequest(original, body);
    expect(handoff.headers.get("Host")).toBeNull();
    expect(handoff.headers.get("Connection")).toBeNull();
    expect(handoff.headers.get("Transfer-Encoding")).toBeNull();
    expect(handoff.headers.get("X-Forwarded-For")).toBeNull();
    expect(handoff.headers.get("Content-Type")).toBe("application/json");
  });
});
