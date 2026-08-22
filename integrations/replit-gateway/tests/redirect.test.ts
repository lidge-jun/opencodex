import { describe, expect, test } from "bun:test";
import { assertNoRedirect, upstreamFetchPolicy } from "../src/redirect";

describe("redirect policy", () => {
  test("uses manual redirect handling for upstream fetch", () => {
    expect(upstreamFetchPolicy().redirect).toBe("manual");
  });

  test("rejects redirect responses", () => {
    const res = new Response(null, {
      status: 302,
      headers: { Location: "https://evil.test" },
    });
    expect(() => assertNoRedirect(res)).toThrow(/redirect_rejected/);
  });

  test("allows non-redirect responses", () => {
    const res = new Response("ok", { status: 200 });
    expect(assertNoRedirect(res)).toBe(res);
  });
});
