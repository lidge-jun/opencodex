import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { callXaiImages } from "../../src/images/xai-client";

const PREV_HOME = process.env.OPENCODEX_HOME;
beforeAll(() => { process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-test-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; });

const AUTH = { baseUrl: "https://api.x.ai", token: "test-token" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Replace globalThis.fetch with a stub that captures the request and returns a canned response. */
function stubFetch(status: number, body: unknown): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input.toString(), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("callXaiImages", () => {
  test("no imageUrl → POST /images/generations", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "a cat" }, AUTH);
    expect(calls[0]!.url).toContain("/images/generations");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  test("with imageUrl → POST /images/edits", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "edit this", imageUrl: "https://example.com/img.png" }, AUTH);
    expect(calls[0]!.url).toContain("/images/edits");
  });

  test("request body has correct model, prompt, n", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    await callXaiImages({ prompt: "a dog", model: "grok-imagine-fast", n: 3 }, AUTH);
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}");
    expect(body.model).toBe("grok-imagine-fast");
    expect(body.prompt).toBe("a dog");
    expect(body.n).toBe(3);
  });

  test("non-2xx → throws Error containing status code", async () => {
    stubFetch(429, { error: "rate limited" });
    await expect(callXaiImages({ prompt: "x" }, AUTH)).rejects.toThrow("429");
  });

  test("2xx with b64_json → returns normalized XaiImageResult", async () => {
    stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    const result = await callXaiImages({ prompt: "x" }, AUTH);
    expect(result.images.length).toBe(1);
    expect(result.images[0]!.b64_json).toBe("dGVzdA==");
  });

  test("2xx with url → returns images[0].url", async () => {
    stubFetch(200, { data: [{ url: "https://cdn.example.com/img.png" }] });
    const result = await callXaiImages({ prompt: "x" }, AUTH);
    expect(result.images[0]!.url).toBe("https://cdn.example.com/img.png");
  });

  test("abort signal → fetch called with signal", async () => {
    const calls = stubFetch(200, { data: [{ b64_json: "dGVzdA==" }] });
    const controller = new AbortController();
    await callXaiImages({ prompt: "x" }, AUTH, controller.signal);
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
