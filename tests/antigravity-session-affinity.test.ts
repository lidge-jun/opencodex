import { afterEach, describe, expect, test } from "bun:test";
import {
  antigravitySessionAffinitySizeForTests,
  clearAntigravityRoutingState,
  recordAntigravitySyntheticFailure,
} from "../src/oauth/antigravity-routing";

afterEach(() => clearAntigravityRoutingState());

describe("google antigravity failure health", () => {
  test("HTTP-200 SSE quota and geoblock errors record account cooldowns", () => {
    expect(recordAntigravitySyntheticFailure("account-a", { error: { code: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }, 1000)).toBe("quota");
    expect(recordAntigravitySyntheticFailure("account-b", { error: { code: "PERMISSION_DENIED", message: "location is not supported" } }, 2000)).toBe("geoblock");
    expect(recordAntigravitySyntheticFailure("account-c", { error: { code: "RESOURCE_EXHAUSTED", message: "rate limit exceeded" } }, 3000)).toBe("rate-limit");
  });

  test("unrelated SSE payloads do not create routing state", () => {
    expect(recordAntigravitySyntheticFailure("account-a", { type: "response.output_text.delta", delta: "ok" }, 1000)).toBeNull();
    expect(antigravitySessionAffinitySizeForTests()).toBe(0);
  });
});
