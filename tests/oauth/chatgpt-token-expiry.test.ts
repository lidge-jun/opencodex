import { afterEach, describe, expect, test } from "bun:test";
import { CHATGPT_FETCH_TIMEOUT_MS, ChatGPTOAuthFlow, ChatGptTokenError, ChatGptTokenRequestError, refreshChatGPTToken } from "../../src/oauth/chatgpt";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

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

async function refreshError(status: number, body: unknown): Promise<ChatGptTokenError> {
  globalThis.fetch = (async () => new Response(
    typeof body === "string" ? body : JSON.stringify(body), { status },
  )) as typeof fetch;
  const error = await refreshChatGPTToken("synthetic-refresh").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ChatGptTokenError);
  return error as ChatGptTokenError;
}

// No real fetch: reject when the supplied signal fires, including pre-aborted signals.
function stallFetch(): void {
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

async function browserFlow(signal?: AbortSignal): Promise<ChatGPTOAuthFlow> {
  const flow = new ChatGPTOAuthFlow({ signal });
  // Initialize PKCE locally; never invoke login(), a browser, or the callback listener.
  await flow.generateAuthUrl("synthetic-state", "http://localhost:1455/auth/callback");
  return flow;
}

describe("ChatGPT OAuth refresh failure classification", () => {
  const deadCodes = ["invalid_grant", "refresh_token_reused", "refresh_token_invalidated",
    "token_invalidated", "refresh_token_expired"];

  for (const status of [400, 401, 403]) {
    for (const code of deadCodes) {
      test(`${status} ${code} is terminal in flat and nested responses`, async () => {
        for (const error of [code, { code, message: "synthetic private description" }]) {
          const err = await refreshError(status, { error });
          expect(err.httpStatus).toBe(status);
          expect(err.oauthError).toBe(code);
          expect(err.terminal).toBe(true);
        }
      });
    }
  }

  test("availability failures stay retryable even with a named dead grant or revoked prose", async () => {
    for (const status of [429, 500, 502, 503]) {
      for (const code of [...deadCodes, "server_error", "temporarily_unavailable"]) {
        const err = await refreshError(status, { error: code, error_description: "session revoked or expired" });
        expect(err.terminal).toBe(false);
        expect(err.oauthError).toBe(code);
      }
    }
  });

  test("named transient or unknown codes override misleading descriptions", async () => {
    for (const code of ["temporarily_unavailable", "server_error", "invalid_client", "synthetic-unknown"]) {
      const err = await refreshError(400, { error: code, error_description: "session revoked or expired" });
      expect(err.terminal).toBe(false);
      expect(err.oauthError).toBe(code === "synthetic-unknown" ? undefined : code);
    }
  });

  test("description-only or blank-code OAuth failures never establish terminality", async () => {
    for (const body of [
      { error_description: "refresh token expired" },
      { error: "  ", error_description: "refresh token revoked" },
      { error: { code: " ", message: "refresh token invalidated" } },
      { error: { message: "upstream route revoked temporarily" } },
    ]) {
      for (const status of [400, 401, 403]) {
        const error = await refreshError(status, body);
        expect(error.terminal).toBe(false);
        expect(error.oauthError).toBeUndefined();
      }
    }
  });

  test("malformed and oversized classifier input remains retryable", async () => {
    for (const body of ["upstream exploded", "null", "[]", { error: { code: 42 } },
      { error: "invalid_grant", padding: "x".repeat(16_384) }]) {
      const err = await refreshError(400, body);
      expect(err.terminal).toBe(false);
      expect(err.oauthError).toBeUndefined();
      expect(err.message).toBe("ChatGPT refresh failed: 400 code=none");
    }
  });

  test("only status and allowlisted code escape in messages, properties, and stacks", async () => {
    const privateText = "synthetic-oauth-material-must-stay-private";
    for (const error of ["invalid_grant", privateText,
      { code: "refresh_token_invalidated", message: privateText }, { code: privateText, message: privateText }]) {
      const err = await refreshError(401, { error, error_description: privateText });
      expect(err.message).toBe(`ChatGPT refresh failed: 401 code=${err.oauthError ?? "none"}`);
      expect(JSON.stringify(err)).not.toContain(privateText);
      expect(String(err)).not.toContain(privateText);
      expect(err.stack).not.toContain(privateText);
    }
  });
});

describe("ChatGPT token fetch cancellation and deadlines", () => {
  test("refresh keeps the form grant and composes the caller with a fresh 30s deadline", async () => {
    const observed: AbortSignal[] = [];
    const deadlines: number[] = [];
    globalThis.setTimeout = ((fn, ms, ...args) => {
      deadlines.push(ms!); return originalSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("https://auth.openai.com/oauth/token");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("synthetic-refresh");
      observed.push(init!.signal!);
      return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    }) as typeof fetch;

    const caller = new AbortController();
    await refreshChatGPTToken("synthetic-refresh", { signal: caller.signal });
    await refreshChatGPTToken("synthetic-refresh", { signal: caller.signal });
    expect(deadlines).toEqual([30_000, 30_000]);
    expect(CHATGPT_FETCH_TIMEOUT_MS).toBe(30_000);
    expect(observed[0]).not.toBe(observed[1]);
    expect(observed.every(signal => !signal.aborted)).toBe(true);
    const reason = new DOMException("invalid_grant synthetic-private-token", "AbortError");
    caller.abort(reason);
    expect(observed.every(signal => !signal.aborted)).toBe(true);
  });

  test("a pre-aborted refresh sanitizes the caller's reason", async () => {
    stallFetch();
    const reason = new DOMException("invalid_grant synthetic-private-token", "AbortError");
    const err = await refreshChatGPTToken("synthetic-refresh", { signal: AbortSignal.abort(reason) })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ChatGptTokenRequestError);
    expect(err).toMatchObject({ name: "AbortError", message: "ChatGPT token request cancelled" });
    expect(err).not.toBe(reason);
    expect(err).not.toHaveProperty("cause");
    expect(JSON.stringify(err) + String(err) + (err as Error).stack).not.toContain(reason.message);
  });

  test("the fetch deadline aborts a stalled refresh with TimeoutError", async () => {
    stallFetch();
    const start = Date.now();
    await expect(refreshChatGPTToken("synthetic-refresh", { timeoutMs: 20 }))
      .rejects.toHaveProperty("name", "TimeoutError");
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("browser exchange sanitizes login cancellation during a stalled fetch", async () => {
    const caller = new AbortController();
    const flow = await browserFlow(caller.signal);
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    stallFetch();
    const stalled = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      started();
      return stalled(...args);
    }) as typeof fetch;
    const pending = flow.exchangeToken("synthetic-code", "synthetic-state", "http://localhost:1455/auth/callback");
    const reason = new DOMException("invalid_grant synthetic-private-token", "AbortError");
    const rejected = pending.catch((error: unknown) => error);
    await began;
    caller.abort(reason);
    const err = await rejected;
    expect(err).toBeInstanceOf(ChatGptTokenRequestError);
    expect(err).toMatchObject({ name: "AbortError", message: "ChatGPT token request cancelled" });
    expect(err).not.toBe(reason);
    expect(err).not.toHaveProperty("cause");
    expect(JSON.stringify(err) + String(err) + (err as Error).stack).not.toContain(reason.message);
  });

  test("browser exchange uses the 30s deadline and redacts endpoint failures", async () => {
    const deadlines: number[] = [];
    globalThis.setTimeout = ((fn, ms, ...args) => {
      deadlines.push(ms!); return originalSetTimeout(fn, 20, ...args);
    }) as typeof setTimeout;
    const flow = await browserFlow();
    const privateText = "synthetic-code-verifier-must-stay-private";
    globalThis.fetch = (async () => Response.json({
      error: "invalid_grant", error_description: privateText,
    }, { status: 400 })) as typeof fetch;
    const err = await flow.exchangeToken("synthetic-code", "synthetic-state", "http://localhost:1455/auth/callback")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatGptTokenError);
    expect((err as Error).message).toBe("ChatGPT token exchange failed: 400 code=invalid_grant");
    expect(String(err)).not.toContain(privateText);
    stallFetch();
    await expect(flow.exchangeToken("synthetic-code", "synthetic-state", "http://localhost:1455/auth/callback"))
      .rejects.toHaveProperty("name", "TimeoutError");
    expect(deadlines).toEqual([30_000, 30_000]);
  });
});
