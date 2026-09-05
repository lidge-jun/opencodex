import { describe, expect, test } from "bun:test";
import {
  isGoogleQuotaExhaustedText,
  isQuotaExhaustedBody,
  safeAntigravityHttpErrorMessage,
  safeGoogleHttpErrorMessage,
  safeVertexHttpErrorMessage,
} from "../../../src/adapters/google-errors";

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

describe("google location denial classification (#3467)", () => {
  const locationBody = JSON.stringify({
    error: {
      code: 400,
      status: "FAILED_PRECONDITION",
      message: "User location is not supported for the API use.",
    },
  });

  test("HTTP 400 FAILED_PRECONDITION location denial is not an invalid request", () => {
    expect(safeAntigravityHttpErrorMessage(400, locationBody))
      .toBe("Antigravity location not supported: User location is not supported for the API use.");
    expect(safeVertexHttpErrorMessage(400, locationBody)).toContain("Vertex AI location not supported");
    expect(safeGoogleHttpErrorMessage("Gemini", 400, locationBody)).toContain("Gemini location not supported");
  });

  test("alternate location / region / country phrasings classify the same way", () => {
    for (const message of [
      "unsupported location for this API",
      "The region is not supported",
      "This model is not supported in your country",
    ]) {
      const body = JSON.stringify({ error: { code: 400, status: "FAILED_PRECONDITION", message } });
      expect(safeAntigravityHttpErrorMessage(400, body)).toContain("Antigravity location not supported");
    }
  });

  test("a generic FAILED_PRECONDITION without location wording stays an invalid request", () => {
    const body = JSON.stringify({
      error: { code: 400, status: "FAILED_PRECONDITION", message: "Precondition check failed." },
    });
    expect(safeAntigravityHttpErrorMessage(400, body)).toContain("Antigravity invalid request");
  });

  test("auth, quota and permission enums keep precedence over location wording", () => {
    const unauth = JSON.stringify({
      error: { code: 401, status: "UNAUTHENTICATED", message: "location is not supported (token expired)" },
    });
    expect(safeAntigravityHttpErrorMessage(401, unauth)).toContain("Antigravity authentication failed");

    const exhausted = JSON.stringify({
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Rate limit hit; location not supported" },
    });
    expect(safeAntigravityHttpErrorMessage(429, exhausted)).toContain("Antigravity rate limit exceeded");

    const denied = JSON.stringify({
      error: { code: 403, status: "PERMISSION_DENIED", message: "location is not supported for this project" },
    });
    expect(safeAntigravityHttpErrorMessage(403, denied)).toContain("Antigravity access denied");
  });

  test("server statuses and explicit non-location enums do not infer a location reason", () => {
    const message = "User location is not supported for the API use.";
    expect(safeAntigravityHttpErrorMessage(400, `PERMISSION_DENIED: ${message}`))
      .toBe(`Antigravity access denied: PERMISSION_DENIED: ${message}`);
    for (const status of [500, 502, 503, 504]) {
      const body = JSON.stringify({ error: { code: status, status: "FAILED_PRECONDITION", message } });
      expect(safeAntigravityHttpErrorMessage(status, body)).toBe(
        `Antigravity ${status === 503 ? "server overloaded" : "upstream error"}: ${message}`,
      );
    }
    for (const [status, prefix] of [
      ["PERMISSION_DENIED", "access denied"],
      ["INVALID_ARGUMENT", "invalid request"],
      ["UNAVAILABLE", "server overloaded"],
    ]) {
      const body = JSON.stringify({ error: { code: 400, status, message } });
      expect(safeAntigravityHttpErrorMessage(400, body)).toBe(`Antigravity ${prefix}: ${message}`);
    }
  });
});
