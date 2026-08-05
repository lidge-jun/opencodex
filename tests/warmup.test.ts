import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CodexWarmupError, codexWarmupFailureReason, warmCodexAccount } from "../src/codex/warmup";

const originalFetch = globalThis.fetch;

function sseResponse(frame = 'data: {"type":"response.completed"}\n\n'): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("codex warmup improvements", () => {
  test("CodexWarmupError exposes upstreamDetail", () => {
    const err = new CodexWarmupError("http_status", "Codex warmup was rejected", {
      status: 400,
      upstreamDetail: "model is not enabled",
    });

    expect(err.upstreamDetail).toBe("model is not enabled");
  });

  test("codexWarmupFailureReason includes upstream detail when present", () => {
    const err = new CodexWarmupError("http_status", "Codex warmup was rejected", {
      status: 400,
      upstreamDetail: "model is not enabled",
    });

    expect(codexWarmupFailureReason(err)).toBe("http_status:400 — model is not enabled");
  });

  test("codexWarmupFailureReason preserves the old format without upstream detail", () => {
    const err = new CodexWarmupError("http_status", "Codex warmup was rejected", {
      status: 400,
    });

    expect(codexWarmupFailureReason(err)).toBe("http_status:400");
  });

  test("warmCodexAccount reports detail parsed from JSON error bodies", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ error: { message: "model gpt-5.4-mini is unavailable" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await warmCodexAccount({ accessToken: "access-test", chatgptAccountId: "acct-test" });
      throw new Error("expected warmup to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexWarmupError);
      expect((err as CodexWarmupError).code).toBe("http_status");
      expect((err as CodexWarmupError).status).toBe(401);
      expect((err as CodexWarmupError).upstreamDetail).toBe("model gpt-5.4-mini is unavailable");
      expect(codexWarmupFailureReason(err)).toBe("http_status:401 — model gpt-5.4-mini is unavailable");
    }
  });

  test("warmCodexAccount sanitizes injected credentials in structured upstream detail", async () => {
    const accessToken = "warmup-private-access-123456";
    const accountId = "acct-warmup-private-123456";
    const encodedAccessToken = "warmup%2Dprivate%2Daccess%2D123456";
    const encodedAccountId = "acct%2Dwarmup%2Dprivate%2D123456";
    const unrelatedCredential = "independent-private-value-123456";
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({
        detail: `account ${encodedAccountId}; credential ${encodedAccessToken}; path /v1%2Fmodels; x-api-key: ${unrelatedCredential}`,
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await warmCodexAccount({ accessToken, chatgptAccountId: accountId });
      throw new Error("expected warmup to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexWarmupError);
      const detail = (err as CodexWarmupError).upstreamDetail ?? "";
      const reason = codexWarmupFailureReason(err);
      for (const privateValue of [accessToken, accountId, unrelatedCredential]) {
        expect(detail).not.toContain(privateValue);
        expect(reason).not.toContain(privateValue);
      }
      for (const encodedPrivateValue of [encodedAccessToken, encodedAccountId]) {
        expect(detail).not.toContain(encodedPrivateValue);
        expect(reason).not.toContain(encodedPrivateValue);
      }
      expect(detail).toContain("[REDACTED]");
      expect(detail).toContain("path /v1%2Fmodels");
      expect(reason).toContain("[REDACTED]");
    }
  });

  test("warmCodexAccount retries FALLBACK_MODELS when the default model returns 400", async () => {
    const parsedBodies: Record<string, unknown>[] = [];
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      parsedBodies.push(body);

      if (body.model === "gpt-5.4-mini") {
        return new Response(JSON.stringify({ detail: "unknown model" }), { status: 400 });
      }

      if (body.model === "gpt-5.5") return sseResponse();
      return new Response("unexpected model", { status: 500 });
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    try {
      await warmCodexAccount({ accessToken: "access-test", chatgptAccountId: "acct-test" });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parsedBodies.map(body => body.model)).toEqual(["gpt-5.4-mini", "gpt-5.5"]);
  });
});
