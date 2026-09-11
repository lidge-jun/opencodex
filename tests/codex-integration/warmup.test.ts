import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  CodexWarmupError,
  codexWarmupFailureReason,
  isCodexWarmupProvisioningFailure,
  warmCodexAccount,
} from "../../src/codex/warmup";

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
  test("codexWarmupFailureReason preserves the public status-only format", () => {
    const err = new CodexWarmupError("http_status", "Codex warmup was rejected", {
      status: 400,
    });

    expect(codexWarmupFailureReason(err)).toBe("http_status:400");
  });

  test("warmCodexAccount never exposes token-like JSON error details", async () => {
    // Keep the privacy scanner meaningful while still exercising a token-shaped
    // runtime value that an upstream JSON error could echo.
    const secret = ["Bearer", ["sk", "proj", "secret", "warmup", "token"].join("-")].join(" ");
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ error: { message: secret }, detail: secret }), {
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
      expect(codexWarmupFailureReason(err)).toBe("http_status:401");
      expect(JSON.stringify(err)).not.toContain(secret);
      expect((err as Error).message).not.toContain(secret);
    }
  });

  test("warmCodexAccount discards oversized error details and cancels without waiting", async () => {
    const encoder = new TextEncoder();
    const detail = JSON.stringify({ detail: "must not surface" });
    const firstChunk = encoder.encode(`${detail}${" ".repeat(1024 - detail.length)}`);
    const paddingChunk = encoder.encode(" ".repeat(1024));
    let cancelled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const errorBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstChunk);
        controller.enqueue(paddingChunk);
        controller.enqueue(paddingChunk);
        closeTimer = setTimeout(() => controller.close(), 50);
      },
      cancel() {
        cancelled = true;
        if (closeTimer !== undefined) clearTimeout(closeTimer);
        return new Promise<void>(() => {});
      },
    });
    globalThis.fetch = mock(async () => new Response(errorBody, { status: 401 })) as unknown as typeof fetch;

    try {
      await warmCodexAccount({ accessToken: "access-test", chatgptAccountId: "acct-test" });
      throw new Error("expected warmup to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexWarmupError);
      expect((err as CodexWarmupError).code).toBe("http_status");
      expect(codexWarmupFailureReason(err)).toBe("http_status:401");
    }
    expect(cancelled).toBe(true);
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
  test("warmCodexAccount retries FALLBACK_MODELS on HTTP 404 and falls through to gpt-5.6-luna", async () => {
    const parsedBodies: Record<string, unknown>[] = [];
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      parsedBodies.push(body);

      if (body.model === "gpt-5.4-mini") {
        return new Response(JSON.stringify({ detail: "model not found" }), { status: 404 });
      }
      if (body.model === "gpt-5.5") {
        return new Response(JSON.stringify({ detail: "model not supported for free tier" }), { status: 400 });
      }
      if (body.model === "gpt-5.6-luna") {
        return sseResponse();
      }
      return new Response("unexpected model", { status: 500 });
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    try {
      await warmCodexAccount({ accessToken: "access-test", chatgptAccountId: "acct-test" });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(parsedBodies.map(body => body.model)).toEqual(["gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna"]);
  });

  test("warmCodexAccount does not retry on 401 and immediately fails", async () => {
    const parsedBodies: Record<string, unknown>[] = [];
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      parsedBodies.push(body);
      return new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401 });
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    try {
      await warmCodexAccount({ accessToken: "access-test", chatgptAccountId: "acct-test" });
      expect.unreachable("expected warmCodexAccount to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexWarmupError);
      expect((err as CodexWarmupError).status).toBe(401);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("codex warmup failure classification", () => {
  test("an exhausted retryable status classifies as provisioning, not as a bad credential", () => {
    for (const status of [400, 404]) {
      expect(isCodexWarmupProvisioningFailure(
        new CodexWarmupError("http_status", "Codex warmup was rejected", { status }),
      )).toBe(true);
    }
  });

  test("an authentication status still asks the operator to reauthenticate", () => {
    for (const status of [401, 403, 429, 500]) {
      expect(isCodexWarmupProvisioningFailure(
        new CodexWarmupError("http_status", "Codex warmup was rejected", { status }),
      )).toBe(false);
    }
  });

  test("a stream or transport failure is never reported as a provisioning problem", () => {
    expect(isCodexWarmupProvisioningFailure(new CodexWarmupError("transport"))).toBe(false);
    expect(isCodexWarmupProvisioningFailure(new CodexWarmupError("no_terminal"))).toBe(false);
    expect(isCodexWarmupProvisioningFailure(new CodexWarmupError("http_status"))).toBe(false);
    expect(isCodexWarmupProvisioningFailure(new Error("boom"))).toBe(false);
    expect(isCodexWarmupProvisioningFailure(undefined)).toBe(false);
  });
});
