import { describe, expect, test } from "bun:test";
import {
  adapterFailureFromMessage,
  parseRetryAfterFromMessage,
} from "../src/lib/errors";

describe("adapterFailureFromMessage", () => {
  test("maps resource_exhausted to 429 rate_limit_error", () => {
    const message = "Cursor rate limit exceeded: Cursor Connect error resource_exhausted: too many requests";
    expect(adapterFailureFromMessage(message)).toMatchObject({
      httpStatus: 429,
      error: { type: "rate_limit_error", code: "rate_limit_exceeded" },
    });
  });

  test("parses retry-after hints from upstream text", () => {
    const message = "rate limit exceeded: try again in 12.5 seconds";
    expect(parseRetryAfterFromMessage(message)).toBe(13);
    expect(adapterFailureFromMessage(message).error.message).toContain("Please try again in 13s.");
  });

  test("maps authentication failures to 401", () => {
    expect(adapterFailureFromMessage("Cursor authentication failed: unauthorized")).toMatchObject({
      httpStatus: 401,
      error: { type: "authentication_error" },
    });
  });

  test("maps forbidden / subscription gates to 403 permission_error", () => {
    expect(adapterFailureFromMessage("Provider stream error: forbidden")).toMatchObject({
      httpStatus: 403,
      error: { type: "permission_error", code: "permission_denied" },
    });
    expect(adapterFailureFromMessage("this model requires a subscription, upgrade for access: https://ollama.com/upgrade")).toMatchObject({
      httpStatus: 403,
      error: { type: "permission_error", code: "subscription_required" },
    });
  });
});
