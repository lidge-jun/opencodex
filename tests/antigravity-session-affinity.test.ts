import { afterEach, describe, expect, test } from "bun:test";
import {
  antigravitySessionAffinitySizeForTests,
  clearAntigravityRoutingState,
  recordAntigravitySyntheticFailure,
} from "../src/oauth/antigravity-routing";

afterEach(() => clearAntigravityRoutingState());

describe("google antigravity failure health", () => {
  test("HTTP-200 SSE quota and geoblock errors record account cooldowns", () => {
    expect(recordAntigravitySyntheticFailure("account-a", { code: "RESOURCE_EXHAUSTED", status: 429, message: "quota exceeded" }, 1000)).toBe("quota");
    expect(recordAntigravitySyntheticFailure("account-b", { code: "PERMISSION_DENIED", status: 403, message: "location is not supported" }, 2000)).toBe("geoblock");
    expect(recordAntigravitySyntheticFailure("account-c", { code: "RESOURCE_EXHAUSTED", status: 429, message: "rate limit exceeded" }, 3000)).toBe("rate-limit");
  });

  test("ordinary text mentioning failure words does not create routing state", () => {
    for (const message of ["location", "country", "region", "quota", "rate limit"]) {
      expect(recordAntigravitySyntheticFailure("account-a", { type: "text", message }, 1000)).toBeNull();
    }
    expect(antigravitySessionAffinitySizeForTests()).toBe(0);
  });

  test("unstructured error text is ignored without an allowlisted code or status", () => {
    expect(recordAntigravitySyntheticFailure("account-a", { message: "location is not supported" }, 1000)).toBeNull();
    expect(recordAntigravitySyntheticFailure("account-a", { code: "SOME_NEW_CODE", status: 499, message: "quota exceeded" }, 1000)).toBeNull();
  });
});
