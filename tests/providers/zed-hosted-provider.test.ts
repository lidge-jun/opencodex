import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, createHash, createPublicKey, publicEncrypt } from "node:crypto";
import { createZedAdapter, zedEventStream, type ZedProvider } from "../../src/adapters/zed";
import { setIcaclsRunnerForTests, resetHardenedStateForTests } from "../../src/lib/windows-secret-acl";
import { getValidAccessTokenSnapshot } from "../../src/oauth";
import { saveCredential } from "../../src/oauth/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import {
  buildZedUserAuthHeader,
  clearZedCaches,
  createZedNativeAuthData,
  decryptZedAccessToken,
  normalizeZedProvider,
  parseZedCallbackPayload,
  resolveZedOrganizationId,
  scrubZedCredentials,
  zedLlmFetch,
} from "../../src/providers/zed";
import { parseRequest } from "../../src/responses/parser";
import type { OcxProviderConfig } from "../../src/types";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY } from "../../src/lib/spend-reservation-ledger";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearZedCaches();
});

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("Zed Hosted AI provider", () => {
  test("builds and decrypts the native RSA callback credential", () => {
    const auth = createZedNativeAuthData(43_123, "system-test");
    const publicKey = createPublicKey({
      key: Buffer.from(auth.publicKey, "base64url"),
      format: "der",
      type: "pkcs1",
    });
    const encrypted = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from("zed-access-token", "utf8"),
    ).toString("base64url");

    expect(parseZedCallbackPayload(`http://127.0.0.1/?user_id=user-1&access_token=${encrypted}`)).toEqual({
      userId: "user-1",
      encryptedAccessToken: encrypted,
    });
    expect(decryptZedAccessToken(encrypted, auth.privateKeyVerifier)).toBe("zed-access-token");
    expect(buildZedUserAuthHeader({ userId: "user-1", accessToken: "zed-access-token" }))
      .toBe("user-1 zed-access-token");
    expect(resolveZedOrganizationId({ organizations: [{ id: "personal", is_personal: true }] }))
      .toBe("personal");
  });

  test("normalizes Zed provider families without restricting arbitrary model ids", () => {
    expect(normalizeZedProvider("Anthropic", "any-model-id")).toBe("anthropic");
    expect(normalizeZedProvider(undefined, "claude-custom")).toBe("anthropic");
    expect(normalizeZedProvider("gemini", "any-model-id")).toBe("google");
    expect(normalizeZedProvider("x-ai", "any-model-id")).toBe("x_ai");
    expect(normalizeZedProvider(undefined, "vendor-router-model")).toBe("open_ai");
  });

  test("keeps the account token and user id out of upstream error messages", async () => {
    globalThis.fetch = (async () => jsonResponse(
      { message: "invalid credential user-secret-42 zed-account-token-xyz" },
      401,
    )) as typeof globalThis.fetch;

    let message = "";
    try {
      await zedLlmFetch({ userId: "user-secret-42", accessToken: "zed-account-token-xyz" }, "/completions");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Zed account lookup");
    expect(message).not.toContain("user-secret-42");
    expect(message).not.toContain("zed-account-token-xyz");
  });
  describe("credential-bearing rejections", () => {
    const credentials = { userId: "user-secret-42", accessToken: "zed-account-token-xyz" };
    const leaked = "connect failed for user-secret-42 with zed-account-token-xyz";

    async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
      try {
        await promise;
      } catch (error) {
        return error;
      }
      throw new Error("expected the Zed call to reject");
    }

    function expectScrubbed(error: unknown): void {
      const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
      expect(text).not.toContain("user-secret-42");
      expect(text).not.toContain("zed-account-token-xyz");
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    }

    test("scrubs a fetch rejection that echoes the account credential", async () => {
      globalThis.fetch = (async () => { throw new Error(leaked); }) as unknown as typeof globalThis.fetch;
      const error = await rejectionOf(zedLlmFetch(credentials, "/completions"));
      expect(error).toBeInstanceOf(Error);
      expectScrubbed(error);
    });

    test("scrubs a body-read rejection that echoes the account credential", async () => {
      globalThis.fetch = (async () => new Response(new ReadableStream({
        pull(controller) { controller.error(new Error(leaked)); },
      }), { status: 200 })) as typeof globalThis.fetch;
      const error = await rejectionOf(zedLlmFetch(credentials, "/completions"));
      expectScrubbed(error);
    });

    test("keeps a numeric status on the scrubbed replacement", async () => {
      globalThis.fetch = (async () => { throw Object.assign(new Error(leaked), { status: 503 }); }) as unknown as typeof globalThis.fetch;
      const error = await rejectionOf(zedLlmFetch(credentials, "/completions"));
      expectScrubbed(error);
      expect((error as { status?: unknown }).status).toBe(503);
    });

    test("keeps a credential-bearing abort an AbortError without the credential", async () => {
      globalThis.fetch = (async () => { throw new DOMException(leaked, "AbortError"); }) as unknown as typeof globalThis.fetch;
      const error = await rejectionOf(zedLlmFetch(credentials, "/completions"));
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
      expectScrubbed(error);
    });

    test("rethrows a clean abort by identity", async () => {
      const abort = new DOMException("The operation was aborted.", "AbortError");
      globalThis.fetch = (async () => { throw abort; }) as unknown as typeof globalThis.fetch;
      const error = await rejectionOf(zedLlmFetch(credentials, "/completions"));
      expect(error).toBe(abort);
    });
  });

  test("refreshes the short-lived LLM token on Zed expiry signals", async () => {
    const calls: Array<{ request: Request; body: string }> = [];
    const responses = [
      jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }),
      new Response(JSON.stringify({ error: "expired" }), {
        status: 401,
        headers: { "x-zed-expired-token": "true" },
      }),
      jsonResponse({ token: "llm-token-2" }),
      new Response("ok", { status: 200 }),
    ];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      calls.push({ request, body: await request.clone().text() });
      const response = responses.shift();
      if (!response) throw new Error("unexpected Zed fetch");
      return response;
    }) as typeof globalThis.fetch;

    const response = await zedLlmFetch(
      { userId: "user-1", accessToken: "access-token" },
      "/completions",
      { fetchInit: { method: "POST", body: "{}" } },
    );

    expect(await response.text()).toBe("ok");
    expect(calls.map(call => new URL(call.request.url).pathname)).toEqual([
      "/client/users/me",
      "/client/llm_tokens",
      "/completions",
      "/client/llm_tokens",
      "/completions",
    ]);
    expect(calls[0]?.request.headers.get("authorization")).toBe("user-1 access-token");
    expect(calls[2]?.request.headers.get("authorization")).toBe("Bearer llm-token-1");
    expect(calls[4]?.request.headers.get("authorization")).toBe("Bearer llm-token-2");
  });

  test("wraps the existing provider builders in Zed's completions envelope", async () => {
    const responses = [
      jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }),
      jsonResponse({ models: [{ id: "gpt-5.6", provider: "open_ai", supports_tools: true }] }),
    ];
    globalThis.fetch = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected Zed catalog fetch");
      return response;
    }) as typeof globalThis.fetch;

    const provider: OcxProviderConfig = {
      adapter: "zed",
      baseUrl: "https://cloud.zed.dev",
      authMode: "oauth",
      apiKey: "access-token",
    };
    const parsed = parseRequest({ model: "gpt-5.6", input: "hello", stream: true });
    parsed._zedAuthContext = { userId: "user-1" };
    const adapter = withTestTranslatorBudget(createZedAdapter(provider));
    const request = await adapter.buildRequest(parsed);
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(request.url).toBe("https://cloud.zed.dev/completions");
    expect(body).toMatchObject({
      provider: "open_ai",
      model: "gpt-5.6",
      thread_id: expect.any(String),
      prompt_id: expect.any(String),
    });
    expect(body.provider_request).toMatchObject({ model: "gpt-5.6", stream: true });

    let completionRequest: Request | undefined;
    const response = await adapter.fetchResponse!(request, {
      executor: (async (input, init) => {
        completionRequest = new Request(input, init);
        return new Response([
          `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}`,
          "data: [DONE]",
          "",
        ].join("\n"), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as typeof globalThis.fetch,
    });
    expect(response.ok).toBe(true);
    expect(completionRequest?.url).toBe("https://cloud.zed.dev/completions");
    expect(completionRequest?.headers.get("authorization")).toBe("Bearer llm-token-1");
    expect(await completionRequest?.clone().text()).toBe(request.body);
  });

  test("normalizes Anthropic string message content to sequence blocks for Zed backend", async () => {
    const responses = [
      jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }),
      jsonResponse({ models: [{ id: "claude-haiku-4-5", provider: "anthropic" }] }),
    ];
    globalThis.fetch = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected Zed catalog fetch");
      return response;
    }) as typeof globalThis.fetch;

    const provider: OcxProviderConfig = {
      adapter: "zed",
      baseUrl: "https://cloud.zed.dev",
      authMode: "oauth",
      apiKey: "access-token",
    };
    const parsed = parseRequest({ model: "claude-haiku-4-5", input: "hello zed", stream: true });
    parsed._zedAuthContext = { userId: "user-1" };
    const adapter = withTestTranslatorBudget(createZedAdapter(provider));
    const request = await adapter.buildRequest(parsed);
    const body = JSON.parse(request.body) as { provider: string; provider_request: { messages: Array<{ role: string; content: unknown }> } };

    expect(body.provider).toBe("anthropic");
    expect(body.provider_request.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello zed" }],
    });
  });
  test("normalizes OpenAI string input to sequence blocks with input_text for Zed backend", async () => {
    const responses = [
      jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }),
      jsonResponse({ models: [{ id: "gpt-6.1-sol", provider: "open_ai" }] }),
    ];
    globalThis.fetch = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected Zed catalog fetch");
      return response;
    }) as typeof globalThis.fetch;

    const provider: OcxProviderConfig = {
      adapter: "zed",
      baseUrl: "https://cloud.zed.dev",
      authMode: "oauth",
      apiKey: "access-token",
    };
    const parsed = parseRequest({ model: "gpt-6.1-sol", input: "hello zed openai", stream: true });
    parsed._zedAuthContext = { userId: "user-1" };
    const adapter = withTestTranslatorBudget(createZedAdapter(provider));
    const request = await adapter.buildRequest(parsed);
    const body = JSON.parse(request.body) as { provider: string; provider_request: { input: Array<{ type: string; role: string; content: unknown }> } };

    expect(body.provider).toBe("open_ai");
    expect(body.provider_request.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello zed openai" }],
    });
  });
});

describe("Zed inference send accounting", () => {
  async function fixture(limit: number, full = false) {
    const catalog = [jsonResponse({ default_organization_id: "org-1" }),
      jsonResponse({ token: "llm-token-1" }), jsonResponse({ models: [{ id: "gpt-5.6", provider: "open_ai" }] })];
    globalThis.fetch = (async () => {
      const response = catalog.shift();
      if (!response) throw new Error("unexpected Zed catalog fetch");
      return response;
    }) as typeof globalThis.fetch;
    const adapter = withTestTranslatorBudget(createZedAdapter({ adapter: "zed", authMode: "oauth",
      baseUrl: "https://zed-proxy.example.test/v1/", apiKey: "access-token" }));
    const parsed = parseRequest({ model: "gpt-5.6", input: "hello", stream: true });
    parsed._zedAuthContext = { userId: "user-1" };
    const request = await adapter.buildRequest(parsed);
    const salt = "5".repeat(64);
    const poolAlias = createHash("sha256").update(`${salt}\0pool\0zed-canonical`).digest("hex").slice(0, 32);
    const ledger = createSpendReservationLedger({ salt, policy: {
      ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: 100 }, maxTrackedSends: full ? 1 : 10,
      canonicalProviderIds: ["zed-canonical"], poolAliases: { [poolAlias]: "zed-canonical" },
    } });
    if (full) expect(ledger.reserveSeed({ sendId: "occupied", scopes: { poolId: "zed-canonical" },
      inputTokens: 1, outputCeilingTokens: 0 }).reserved).toBe(true);
    const tracker = createRequestSpendTracker({ provider: "Zed display label", spendPoolId: "zed-canonical",
      spendInputEstimateTokens: 10 }, undefined, ledger);
    const budget = createRequestExecutionBudget({ maxTotalModelSends: limit, baseSendAllowance: limit,
      finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, undefined, tracker);
    return { adapter, request, ledger, tracker, budget };
  }

  test("NORMAL seed refusal makes zero completion executor calls", async () => {
    const { adapter, request, budget } = await fixture(2, true);
    let calls = 0;
    await expect(adapter.fetchResponse!(request, { sendBudget: budget,
      executor: (async () => { calls++; return new Response("unexpected"); }) as typeof globalThis.fetch,
    })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(calls).toBe(0);
    expect(budget.physicalStarted).toBe(0);
  });

  for (const limit of [1, 2]) test(`401 replay respects physical L=${limit} and canonical pool accounting`, async () => {
    const { adapter, request, ledger, tracker, budget } = await fixture(limit);
    const calls: string[] = [];
    const physical: Array<{ ordinal: number; recovery?: string }> = [];
    let completions = 0;
    const result = adapter.fetchResponse!(request, { sendBudget: budget, onPhysicalSend: send => physical.push(send),
      executor: (async (input) => {
        const url = String(input);
        calls.push(url);
        if (new URL(url).pathname === "/client/llm_tokens") return jsonResponse({ token: "llm-token-2" });
        expect(url).toBe("https://zed-proxy.example.test/v1/completions");
        return ++completions === 1 ? new Response("expired", { status: 401 }) : new Response("ok");
      }) as typeof globalThis.fetch,
    });
    if (limit === 1) await expect(result).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    else expect(await (await result).text()).toBe("ok");
    expect(completions).toBe(limit);
    expect(calls.filter(url => new URL(url).pathname === "/client/llm_tokens")).toHaveLength(1);
    expect(physical).toEqual(limit === 1 ? [{ ordinal: 1 }] : [{ ordinal: 1 }, { ordinal: 2, recovery: "oauth-401" }]);
    expect(budget.used).toBe(limit);
    expect(budget.physicalStarted).toBe(limit);
    tracker.requestFinalSettlement(limit === 2 ? { inputTokens: 7, outputTokens: 0 } : undefined);
    expect(ledger.snapshot("pool", "zed-canonical")).toMatchObject({ settled: limit === 2 ? 7 : 0, unresolved: 10 });
    expect(ledger.snapshot("pool", "Zed display label")?.settled ?? 0).toBe(0);
  });
});

describe("Zed stream framing", () => {
  async function translate(chunks: string[], provider: ZedProvider = "anthropic"): Promise<Array<Record<string, unknown>>> {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const text = await new Response(zedEventStream(body, provider)).text();
    return text.split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, "")) as Record<string, unknown>);
  }

  test("forwards events and stops at the explicit stream-ended status", async () => {
    const frames = await translate([
      `${JSON.stringify({ event: { type: "content_block_delta", delta: { text: "hi" } } })}\n`,
      `${JSON.stringify({ status: "stream_ended" })}\n${JSON.stringify({ event: { type: "content_block_delta", delta: { text: "late" } } })}\n`,
    ]);
    expect(frames).toEqual([
      { type: "content_block_delta", delta: { text: "hi" } },
      { type: "message_stop" },
    ]);
  });

  test("a malformed frame fails the stream instead of being skipped", async () => {
    const frames = await translate([`${JSON.stringify({ event: { type: "ping" } })}\n{not json\n${JSON.stringify({ status: "stream_ended" })}\n`]);
    expect(frames).toEqual([
      { type: "ping" },
      { type: "error", error: { type: "api_error", message: "Zed stream sent a malformed frame" } },
    ]);
  });

  test("an EOF without a terminal or inside a partial frame is an error, not a success", async () => {
    expect((await translate([`${JSON.stringify({ event: { type: "ping" } })}\n`])).at(-1))
      .toEqual({ type: "error", error: { type: "api_error", message: "Zed stream ended before completion" } });
    expect((await translate([`${JSON.stringify({ event: { type: "ping" } })}\n{"event":{"type":`])).at(-1))
      .toEqual({ type: "error", error: { type: "api_error", message: "Zed stream ended inside a partial frame" } });
  });

  test("a failed status never echoes the account token or user id", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ status: { type: "failed", message: "quota for zed-user-9 with tok-abc exhausted" } })}\n`));
        controller.close();
      },
    });
    const credentials = { userId: "zed-user-9", accessToken: "tok-abc" };
    const text = await new Response(zedEventStream(body, "anthropic", value => scrubZedCredentials(value, credentials))).text();
    expect(text).not.toContain("zed-user-9");
    expect(text).not.toContain("tok-abc");
    expect(text).toContain("[redacted]");
  });

  test("a native terminal event still completes at a clean EOF", async () => {
    const frames = await translate([`${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n`], "open_ai");
    expect(frames.at(-1)).toEqual({ type: "response.completed", response: { output: [] } });
    expect(frames.some(frame => "error" in frame)).toBe(false);
  });

  test("an unterminated frame over the size limit fails instead of growing the buffer", async () => {
    const frames = await translate(["x".repeat(1024 * 1024 + 1)]);
    expect(frames).toEqual([{ type: "error", error: { type: "api_error", message: "Zed stream frame exceeded the size limit" } }]);
  });
});

describe("Zed OAuth identity", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-zed-identity-"));
  let previousHome: string | undefined;
  beforeAll(() => {
    previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  });
  afterAll(() => {
    setIcaclsRunnerForTests(null);
    resetHardenedStateForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  test("the access snapshot carries Zed's user id apart from the hashed account slot", async () => {
    await saveCredential("zed", {
      access: "zed-access-token",
      refresh: "zed-access-token",
      expires: Number.MAX_SAFE_INTEGER,
      accountId: "zed-user-7",
      source: "oauth",
    });
    const snapshot = await getValidAccessTokenSnapshot("zed");
    expect(snapshot.providerUserId).toBe("zed-user-7");
    expect(snapshot.accountId).not.toBe("zed-user-7");
    expect(buildZedUserAuthHeader({ userId: snapshot.providerUserId!, accessToken: snapshot.accessToken }))
      .toBe("zed-user-7 zed-access-token");
  });
});
