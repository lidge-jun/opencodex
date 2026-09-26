import { afterEach, describe, expect, test } from "bun:test";
import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { createZedAdapter } from "../../src/adapters/zed";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import {
  buildZedUserAuthHeader,
  clearZedCaches,
  createZedNativeAuthData,
  decryptZedAccessToken,
  normalizeZedProvider,
  parseZedCallbackPayload,
  resolveZedOrganizationId,
  zedLlmFetch,
} from "../../src/providers/zed";
import { parseRequest } from "../../src/responses/parser";
import type { OcxProviderConfig } from "../../src/types";

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
});
