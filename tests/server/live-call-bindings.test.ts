import { describe, expect, test } from "bun:test";
import { EXTERNAL_CALL_PREFIX, LIVE_CALL_TTL_MS, LiveCallBindings, upstreamLiveCallId, type LiveCallBinding } from "../../src/server/live-call-bindings";

const binding: LiveCallBinding = { owner: "key-one", upstreamCallId: "rtc_upstream", joinStyle: "frameless-path", providerName: "openai", accountId: "account-a", chatgptAccountId: "workspace-a", callerOwned: false };

describe("external live call ownership", () => {
  test("opaque aliases isolate owners and do not expose upstream call IDs", () => {
    const registry = new LiveCallBindings();
    const id = registry.create(binding)!;
    expect(id.startsWith(EXTERNAL_CALL_PREFIX)).toBe(true);
    expect(id).not.toContain("upstream");
    expect(registry.get(id, "key-one")).toEqual(binding);
    expect(registry.get(id, "key-two")).toBeUndefined();
    const copy = registry.get(id, "key-one")!;
    copy.accountId = "other";
    expect(registry.get(id, "key-one")!.accountId).toBe("account-a");
  });
  test("expiry and clear retire aliases independently of socket reconnection", () => {
    let now = 0;
    const registry = new LiveCallBindings(() => now);
    const id = registry.create(binding)!;
    now = LIVE_CALL_TTL_MS - 1;
    expect(registry.get(id, "key-one")).toBeDefined();
    now += 1;
    expect(registry.get(id, "key-one")).toBeUndefined();
    const next = registry.create(binding)!;
    registry.clear();
    expect(registry.get(next, "key-one")).toBeUndefined();
  });
  test("capacity is bounded and expired entries reclaim capacity", () => {
    let now = 0;
    const registry = new LiveCallBindings(() => now);
    for (let i = 0; i < 1024; i++) expect(registry.create(binding)).not.toBeNull();
    expect(registry.create(binding)).toBeNull();
    now += LIVE_CALL_TTL_MS;
    expect(registry.create(binding)).not.toBeNull();
  });
  test("Location parsing extracts only a bounded rtc or UUID identifier", () => {
    expect(upstreamLiveCallId("https://api.openai.com/v1/live/rtc_upstream?private=context")).toBe("rtc_upstream");
    expect(upstreamLiveCallId("/v1/live/01234567-89ab-cdef-0123-456789abcdef")).toBe("01234567-89ab-cdef-0123-456789abcdef");
    for (const location of [null, "javascript:rtc_upstream", "/v1/live/%2fsecret", "/v1/live/%ZZ", "/v1/live/unknown", "/v1/live/rtc_" + "x".repeat(128)]) {
      expect(upstreamLiveCallId(location)).toBeNull();
    }
  });
});
