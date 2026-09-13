import { describe, expect, test } from "bun:test";
import {
  buildGetChatMessageRequestForTests,
  devinCacheIdentity,
  invalidateSessionIdentity,
} from "../../src/adapters/devin/cloud-direct/chat";

function buildRequest(overrides: Record<string, unknown> = {}): Buffer {
  return buildGetChatMessageRequestForTests({
    apiKey: "k",
    modelUid: "swe-2-high",
    messages: [{ role: "user", content: "hi" }],
    cascadeId: "cascade-1",
    sessionId: "session-1",
    requestId: 1n,
    triggerId: "trigger-1",
    ...overrides,
  } as never);
}

describe("prompt cache options on the wire", () => {
  // Reusing a session id is only half of prompt caching. Without this field the
  // server creates no cache entry and every turn re-reads the whole prefix.
  // Bytes: tag (13<<3)|2 = 0x6a, length 0x02, inner field 1 varint 1 = 08 01.
  const EXPECTED = Buffer.from([0x6a, 0x02, 0x08, 0x01]);

  test("the request carries PromptCacheOptions{EPHEMERAL}", () => {
    expect(buildRequest().includes(EXPECTED)).toBe(true);
  });

  test("it is sent even when the turn has no tools", () => {
    // CLIProxyAPIPlus appends it outside its tools gate, and the native client
    // caches the system prefix regardless of whether tools were declared.
    expect(buildRequest({ tools: [] }).includes(EXPECTED)).toBe(true);
    expect(buildRequest({ tools: undefined }).includes(EXPECTED)).toBe(true);
  });

  test("exactly one cache-options field is emitted", () => {
    const buf = buildRequest();
    let count = 0;
    for (let i = 0; i + EXPECTED.length <= buf.length; i += 1) {
      if (buf.subarray(i, i + EXPECTED.length).equals(EXPECTED)) count += 1;
    }
    expect(count).toBe(1);
  });
});

describe("devin cache identity", () => {
  test("the raw credential never becomes the cache key", () => {
    const apiKey = "devin-secret-token-value";
    const identity = devinCacheIdentity(apiKey, "https://server.example");
    expect(identity).not.toContain(apiKey);
    expect(identity).toMatch(/^[0-9a-f]{16}$/);
  });

  test("identity separates accounts and hosts", () => {
    const a = devinCacheIdentity("key-a", "https://h1");
    const b = devinCacheIdentity("key-b", "https://h1");
    const c = devinCacheIdentity("key-a", "https://h2");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("the same credential and host is stable across calls", () => {
    expect(devinCacheIdentity("key", "https://h")).toBe(devinCacheIdentity("key", "https://h"));
  });

  test("the host boundary cannot be forged by a crafted credential", () => {
    // The parts are joined with a separator that cannot appear in either half,
    // so "h" + key and host + "\x1fh" must not collide.
    expect(devinCacheIdentity("b", "a")).not.toBe(devinCacheIdentity("", "a\x1fb"));
  });
});

describe("session invalidation is scoped to one account", () => {
  test("invalidating an unknown identity is harmless", () => {
    expect(() => invalidateSessionIdentity(devinCacheIdentity("nobody", "https://h"))).not.toThrow();
  });

  test("the unsafe global clear is gone from the module surface", async () => {
    // A per-provider logout calling a global clear() would strip the session and
    // cascade of every other account mid-turn, which is why nothing ever called it.
    const mod = await import("../../src/adapters/devin/cloud-direct/chat");
    expect("clearSessionIds" in mod).toBe(false);
    expect(typeof mod.invalidateSessionIdentity).toBe("function");
  });
});
