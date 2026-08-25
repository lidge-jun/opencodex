import { describe, expect, test } from "bun:test";
import {
  isGoogleQuotaExhaustedText,
  isQuotaExhaustedBody,
  safeAntigravityHttpErrorMessage,
  safeGoogleHttpErrorMessage,
  safeVertexHttpErrorMessage,
} from "../src/adapters/google-errors";

describe("google error classification & quota exhaustion", () => {
  const antigravityPhrases = [
    "Individual quota reached. Please try again later.",
    "Quota exceeded for model gemini-3.7-flash",
    "You have exceeded your current quota.",
    "Please enable overages in your Cloud billing console.",
    "You have exhausted your capacity for this period.",
    "Daily limit reached for this account.",
    "Weekly limit reached.",
    "RESOURCE_EXHAUSTED: quotafailure at billing account",
  ];

  for (const phrase of antigravityPhrases) {
    test(`recognizes quota phrase: "${phrase}"`, () => {
      expect(isGoogleQuotaExhaustedText(phrase)).toBe(true);
      const jsonBodyWithStatus = JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: phrase,
        },
      });
      expect(isQuotaExhaustedBody(jsonBodyWithStatus)).toBe(true);
      expect(safeAntigravityHttpErrorMessage(429, jsonBodyWithStatus)).toContain("Antigravity quota exhausted");
      expect(safeVertexHttpErrorMessage(429, jsonBodyWithStatus)).toContain("Vertex AI quota exhausted");

      // Also verify when JSON does not have an explicit status field (common in some Antigravity proxies)
      const jsonBodyNoStatus = JSON.stringify({
        error: {
          code: 429,
          message: phrase,
        },
      });
      expect(isQuotaExhaustedBody(jsonBodyNoStatus)).toBe(true);
      expect(safeAntigravityHttpErrorMessage(429, jsonBodyNoStatus)).toContain("Antigravity quota exhausted");

      // Also verify raw plain text payload
      expect(isQuotaExhaustedBody(phrase)).toBe(true);
      expect(safeAntigravityHttpErrorMessage(429, phrase)).toContain("Antigravity quota exhausted");
    });
  }

  test("does not classify transient rate limit as hard quota exhaustion", () => {
    const transientPhrases = [
      "Rate limit exceeded. Please retry with exponential backoff.",
      "Too many requests per minute (RPM).",
      "Concurrent request limit reached, try again in a few seconds.",
      "Per-minute quota exceeded, retry later.",
      "Quota exceeded per minute (RPM).",
      // Upstream writes the header name unspaced in prose. Matching only "retry after" let
      // this fall through to the exhaustion needles and suppress a retry for a transient 429.
      "Quota exceeded; retry-after: 60",
      "RESOURCE_EXHAUSTED: quota exceeded. Retry-After: 30",
    ];

    for (const phrase of transientPhrases) {
      expect(isGoogleQuotaExhaustedText(phrase)).toBe(false);
      const jsonBody = JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: phrase,
        },
      });
      expect(isQuotaExhaustedBody(jsonBody)).toBe(false);
      expect(safeAntigravityHttpErrorMessage(429, jsonBody)).toContain("Antigravity rate limit exceeded");
    }
  });

  test("non-RESOURCE_EXHAUSTED status is not quota exhaustion even with quota keyword", () => {
    const jsonBody = JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "quota configuration invalid",
      },
    });
    expect(isQuotaExhaustedBody(jsonBody)).toBe(false);
  });
});
