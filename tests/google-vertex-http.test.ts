import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterRequest } from "../src/adapters/base";
import { fetchVertexWithRetry } from "../src/adapters/google-http";
import { safeVertexHttpErrorMessage, retryableGoogleStatus } from "../src/adapters/google-errors";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const request: AdapterRequest = {
  url: "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse",
  method: "POST",
  headers: { authorization: "Bearer tok", "content-type": "application/json" },
  body: "{}",
};

function mockFetch(responses: Array<Response | Error>): { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const next = responses[i++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls };
}

function vertexError(code: number, status: string, message: string): string {
  return JSON.stringify({ error: { code, status, message } });
}

describe("vertex retry fetch", () => {
  test("retries 503 then returns the successful response", async () => {
    const mock = mockFetch([
      new Response(vertexError(503, "UNAVAILABLE", "overloaded"), { status: 503, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(mock.calls).toHaveLength(2);
  });

  test("retries a thrown network error then succeeds", async () => {
    const mock = mockFetch([new Error("ECONNRESET"), new Response("ok", { status: 200 })]);
    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });

  test("does NOT retry a quota-exhausted 429 (single attempt), but DOES retry a plain rate-limit 429", async () => {
    const quota = mockFetch([
      new Response(vertexError(429, "RESOURCE_EXHAUSTED", "Quota exceeded for your current billing plan"), { status: 429, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);
    const qres = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(qres.status).toBe(429);
    expect(await qres.text()).toContain("Vertex AI quota exhausted");
    expect(quota.calls).toHaveLength(1);

    const rate = mockFetch([
      new Response(vertexError(429, "RESOURCE_EXHAUSTED", "rate limit, try again"), { status: 429, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);
    const rres = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(rres.status).toBe(200);
    expect(rate.calls).toHaveLength(2);
  });

  test("does not retry a non-retryable 400 and classifies the body", async () => {
    const mock = mockFetch([new Response(vertexError(400, "INVALID_ARGUMENT", "bad model"), { status: 400 })]);
    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Vertex AI invalid request");
    expect(mock.calls).toHaveLength(1);
  });

  test("does not retry 401/403 (single attempt)", async () => {
    const mock401 = mockFetch([new Response(vertexError(401, "UNAUTHENTICATED", "bad token"), { status: 401 })]);
    const res401 = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(res401.status).toBe(401);
    expect(await res401.text()).toContain("Vertex AI authentication failed");
    expect(mock401.calls).toHaveLength(1);

    const mock403 = mockFetch([new Response(vertexError(403, "PERMISSION_DENIED", "no access"), { status: 403 })]);
    const res403 = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(res403.status).toBe(403);
    expect(await res403.text()).toContain("Vertex AI access denied");
  });

  test("aborts promptly when the caller signal fires", async () => {
    mockFetch([new Response(vertexError(503, "UNAVAILABLE", "x"), { status: 503, headers: { "Retry-After": "30" } }), new Response("ok", { status: 200 })]);
    const controller = new AbortController();
    const p = fetchVertexWithRetry(request, { timeoutMs: 5_000, abortSignal: controller.signal });
    controller.abort();
    await expect(p).rejects.toBeDefined();
  });
});

describe("safeVertexHttpErrorMessage classification + redaction", () => {
  test("classifies each Google enum row", () => {
    expect(safeVertexHttpErrorMessage(429, vertexError(429, "RESOURCE_EXHAUSTED", "rate"))).toContain("Vertex AI rate limit exceeded");
    expect(safeVertexHttpErrorMessage(429, vertexError(429, "RESOURCE_EXHAUSTED", "quota exceeded for billing"))).toContain("Vertex AI quota exhausted");
    expect(safeVertexHttpErrorMessage(401, vertexError(401, "UNAUTHENTICATED", "x"))).toContain("Vertex AI authentication failed");
    expect(safeVertexHttpErrorMessage(403, vertexError(403, "PERMISSION_DENIED", "x"))).toContain("Vertex AI access denied");
    expect(safeVertexHttpErrorMessage(400, vertexError(400, "INVALID_ARGUMENT", "x"))).toContain("Vertex AI invalid request");
    expect(safeVertexHttpErrorMessage(503, vertexError(503, "UNAVAILABLE", "x"))).toContain("Vertex AI server overloaded");
    expect(safeVertexHttpErrorMessage(500, vertexError(500, "INTERNAL", "x"))).toContain("Vertex AI upstream error");
  });

  test("redacts a bearer token and an absolute path in the detail", () => {
    const msg = safeVertexHttpErrorMessage(400, vertexError(400, "INVALID_ARGUMENT", "failed with Authorization: Bearer secret-abc123 at /Users/example/secret.json"));
    expect(msg).not.toContain("secret-abc123");
    expect(msg).not.toContain("/Users/example/secret.json");
    expect(msg).toContain("[REDACTED_PATH]");
  });

  test("retryableGoogleStatus matches the Kiro set", () => {
    for (const s of [429, 500, 502, 503, 504]) expect(retryableGoogleStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 403, 404]) expect(retryableGoogleStatus(s)).toBe(false);
  });
});

describe("adapter fetchResponse wiring", () => {
  test("vertex adapter exposes fetchResponse; ai-studio does not", async () => {
    const { createGoogleAdapter } = await import("../src/adapters/google");
    const vertex = createGoogleAdapter({ adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex" } as never);
    const aistudio = createGoogleAdapter({ adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k" } as never);
    expect(typeof vertex.fetchResponse).toBe("function");
    expect(aistudio.fetchResponse).toBeUndefined();
  });
});
