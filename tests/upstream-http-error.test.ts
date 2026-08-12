import { describe, expect, test } from "bun:test";
import {
  normalizeUpstreamHttpErrorResponse,
  sanitizeUpstreamErrorText,
} from "../src/adapters/upstream-http-error";

describe("sanitizeUpstreamErrorText", () => {
  test("redacts secrets and absolute paths", () => {
    const text = sanitizeUpstreamErrorText(
      "Authorization: Bearer secret-token at /Users/example/private.json and C:\\Users\\user\\secret.txt",
    );
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("/Users/example/private.json");
    expect(text).not.toContain("C:\\Users\\user\\secret.txt");
  });
});

describe("normalizeUpstreamHttpErrorResponse", () => {
  test("strips encoded-length headers and keeps safe headers", async () => {
    const res = new Response("provider-private-detail", {
      status: 503,
      statusText: "Service Unavailable",
      headers: {
        "content-encoding": "gzip",
        "content-length": "999",
        "retry-after": "0",
        "x-provider-error": "kept",
      },
    });

    const normalized = await normalizeUpstreamHttpErrorResponse(res, {
      formatMessage: payloadText => `formatted: ${payloadText}`,
    });

    expect(normalized.status).toBe(503);
    expect(normalized.statusText).toBe("Service Unavailable");
    expect(normalized.headers.get("content-encoding")).toBeNull();
    expect(normalized.headers.get("content-length")).toBeNull();
    expect(normalized.headers.get("retry-after")).toBe("0");
    expect(normalized.headers.get("x-provider-error")).toBe("kept");
    expect(await normalized.text()).toBe("formatted: provider-private-detail");
  });
});
