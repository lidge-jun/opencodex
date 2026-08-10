import { afterEach, describe, expect, test } from "bun:test";
import { loadApiKeyCount } from "../src/pages/integrations/integration-api";

/**
 * `loadApiKeyCount` used to swallow every failure into `null` via
 * `readOptional`. The overview then saw a SUCCESSFUL empty result, with no
 * polling to correct it, and rendered "No keys issued" — a claim about the
 * account of the user that a failed request cannot support.
 *
 * It now throws, which is what produces `failed-cold` / `failed-with-stale` and
 * lets the row say "Key status unavailable" instead. These cases pin that
 * contract, because the mounted overview test only exercises one of the five
 * ways it can now fail.
 */

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function respondWith(body: string, init: ResponseInit = {}) {
  globalThis.fetch = (async () => new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })) as typeof fetch;
}

describe("loadApiKeyCount distinguishes empty from failed", () => {
  test("an empty key list resolves 0 — zero is data, not a failure", async () => {
    respondWith(JSON.stringify({ keys: [] }));
    expect(await loadApiKeyCount("http://x")).toBe(0);
  });

  test("a populated list resolves its length", async () => {
    respondWith(JSON.stringify({ keys: [{ key: "a" }, { key: "b" }] }));
    expect(await loadApiKeyCount("http://x")).toBe(2);
  });

  test("a non-ok status rejects instead of reading as no keys", async () => {
    respondWith("{}", { status: 500 });
    expect(loadApiKeyCount("http://x")).rejects.toThrow(/500/);
  });

  test("a malformed body rejects", async () => {
    respondWith("not json at all");
    expect(loadApiKeyCount("http://x")).rejects.toThrow(/unexpected body/);
  });

  test("a non-array `keys` rejects — the case readOptional turned into 'no keys issued'", async () => {
    respondWith(JSON.stringify({ keys: "nope" }));
    expect(loadApiKeyCount("http://x")).rejects.toThrow(/unexpected body/);
  });

  test("a network rejection propagates rather than being swallowed", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    expect(loadApiKeyCount("http://x")).rejects.toThrow(/offline/);
  });
});
