import { afterEach, describe, expect, test } from "bun:test";
import { refreshChatGPTToken } from "../src/oauth/chatgpt";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const FALLBACK_MS = 3600 * 1000;
const TOLERANCE_MS = 30_000;

describe("ChatGPT OAuth token response parsing", () => {
  test("refresh with a non-finite expires_in falls back to the 3600s default", async () => {
    globalThis.fetch = (async () => new Response(
      // JSON.stringify would turn Infinity into null; hand-write 1e999 so JSON.parse
      // yields Infinity, which ?? 3600 alone would let through (NaN expiry, never refreshing).
      '{"access_token":"at","refresh_token":"rt","expires_in":1e999}',
      { status: 200 },
    )) as typeof fetch;

    const before = Date.now();
    const cred = await refreshChatGPTToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(cred.expires).toBeGreaterThan(before);
    expect(Math.abs(cred.expires - (before + FALLBACK_MS))).toBeLessThan(TOLERANCE_MS);
  });

  test("refresh with a string expires_in falls back to the 3600s default", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: "garbage" }),
      { status: 200 },
    )) as typeof fetch;

    const before = Date.now();
    const cred = await refreshChatGPTToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(cred.expires).toBeGreaterThan(before);
    expect(Math.abs(cred.expires - (before + FALLBACK_MS))).toBeLessThan(TOLERANCE_MS);
  });

  test("refresh with an overflowing expires_in falls back to the 3600s default", async () => {
    globalThis.fetch = (async () => new Response(
      // Number.MAX_VALUE passes Number.isFinite but overflows to Infinity when
      // multiplied by 1000 — the computed expiry must still be guarded.
      '{"access_token":"at","refresh_token":"rt","expires_in":1.7976931348623157e308}',
      { status: 200 },
    )) as typeof fetch;

    const before = Date.now();
    const cred = await refreshChatGPTToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(cred.expires).toBeGreaterThan(before);
    expect(Math.abs(cred.expires - (before + FALLBACK_MS))).toBeLessThan(TOLERANCE_MS);
  });

  test("refresh with a negative expires_in falls back to the 3600s default", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: -1 }),
      { status: 200 },
    )) as typeof fetch;

    const before = Date.now();
    const cred = await refreshChatGPTToken("secret");
    expect(Number.isFinite(cred.expires)).toBe(true);
    expect(cred.expires).toBeGreaterThan(before);
    expect(Math.abs(cred.expires - (before + FALLBACK_MS))).toBeLessThan(TOLERANCE_MS);
  });
});
