import { describe, expect, test } from "bun:test";
import { FORWARD_HEADERS, createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { headersForCodexAuthContext } from "../../src/codex/auth-context";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const accountA = {
  accountId: "pool-a",
  accessToken: "pool_a_token",
  chatgptAccountId: "acct_pool_a",
};

const poolAuthContext = {
  kind: "pool" as const,
  accountId: accountA.accountId,
  generation: 1,
  accessToken: accountA.accessToken,
  chatgptAccountId: accountA.chatgptAccountId,
};

function minimalParsed(): OcxParsedRequest {
  return {
    modelId: "gpt-5.4",
    context: { messages: [] },
    stream: false,
    options: {},
    _rawBody: { model: "gpt-5.4", input: [] },
  };
}

describe("Codex metadata integrity", () => {
  test("FORWARD_HEADERS includes client metadata allowlist entries", () => {
    for (const name of [
      "originator",
      "session_id",
      "session-id",
      "thread-id",
      "chatgpt-account-id",
      "x-codex-parent-thread-id",
    ]) {
      expect(FORWARD_HEADERS).toContain(name);
    }
  });

  test("does not fabricate originator when absent", () => {
    const incoming = new Headers({
      "x-codex-parent-thread-id": "thread-1",
    });
    const headers = headersForCodexAuthContext(incoming, poolAuthContext);
    expect(headers.get("originator")).toBeNull();
    expect(headers.get("chatgpt-account-id")).toBe(accountA.chatgptAccountId);
  });

  test("preserves genuine originator", () => {
    const incoming = new Headers({
      originator: "codex_cli_rs",
      "x-codex-parent-thread-id": "thread-1",
    });
    const headers = headersForCodexAuthContext(incoming, poolAuthContext);
    expect(headers.get("originator")).toBe("codex_cli_rs");
  });

  test("preserves genuine session_id and thread-id", () => {
    const incoming = new Headers({
      session_id: "sess-real-1",
      "thread-id": "thread-real-1",
      "x-codex-parent-thread-id": "thread-1",
    });
    const headers = headersForCodexAuthContext(incoming, poolAuthContext);
    expect(headers.get("session_id")).toBe("sess-real-1");
    expect(headers.get("thread-id")).toBe("thread-real-1");
    expect(headers.get("x-codex-parent-thread-id")).toBe("thread-1");
  });

  test("does not fabricate session_id or thread-id when absent", () => {
    const headers = headersForCodexAuthContext(new Headers(), poolAuthContext);
    expect(headers.get("session_id")).toBeNull();
    expect(headers.get("session-id")).toBeNull();
    expect(headers.get("thread-id")).toBeNull();
    expect(headers.get("originator")).toBeNull();
  });

  test("outgoing chatgpt-account-id matches selected pool credential", () => {
    const incoming = new Headers({
      authorization: "Bearer caller_token",
      "chatgpt-account-id": "caller_acct_should_be_replaced",
      originator: "codex_cli_rs",
    });
    const headers = headersForCodexAuthContext(incoming, poolAuthContext);
    expect(headers.get("authorization")).toBe(`Bearer ${accountA.accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe(accountA.chatgptAccountId);
    expect(headers.get("originator")).toBe("codex_cli_rs");
  });

  test("main-pool auth context also overwrites chatgpt-account-id without fabricating originator", () => {
    const incoming = new Headers({
      "chatgpt-account-id": "stale_caller_acct",
      "x-codex-parent-thread-id": "thread-1",
    });
    const headers = headersForCodexAuthContext(incoming, {
      kind: "main-pool",
      accountId: "__main__",
      accessToken: "main_access",
      chatgptAccountId: "main_acct",
    });
    expect(headers.get("chatgpt-account-id")).toBe("main_acct");
    expect(headers.get("authorization")).toBe("Bearer main_access");
    expect(headers.get("originator")).toBeNull();
  });

  test("adapter forward mode does not fabricate originator and applies pool override", () => {
    const provider: OcxProviderConfig & {
      _codexAccountOverride: { accessToken: string; chatgptAccountId: string };
      _codexAccountRequired: boolean;
    } = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      _codexAccountRequired: true,
      _codexAccountOverride: {
        accessToken: accountA.accessToken,
        chatgptAccountId: accountA.chatgptAccountId,
      },
    };
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest(minimalParsed(), {
      headers: new Headers({
        "x-codex-parent-thread-id": "thread-1",
        "chatgpt-account-id": "caller_stale",
      }),
    });
    expect(request).not.toBeInstanceOf(Promise);
    const sync = request as { headers: Record<string, string> };
    expect(sync.headers.originator).toBeUndefined();
    expect(sync.headers["chatgpt-account-id"]).toBe(accountA.chatgptAccountId);
    expect(sync.headers.authorization).toBe(`Bearer ${accountA.accessToken}`);
  });

  test("adapter forward mode preserves genuine client metadata", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    };
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest(minimalParsed(), {
      headers: new Headers({
        authorization: "Bearer caller-token",
        originator: "codex_cli_rs",
        session_id: "sess-real-2",
        "thread-id": "thread-real-2",
      }),
    });
    const sync = request as { headers: Record<string, string> };
    expect(sync.headers.authorization).toBe("Bearer caller-token");
    expect(sync.headers.originator).toBe("codex_cli_rs");
    expect(sync.headers.session_id).toBe("sess-real-2");
    expect(sync.headers["thread-id"]).toBe("thread-real-2");
  });
});

describe("Codex request transport metadata", () => {
  const url = "https://chatgpt.com/backend-api/codex/responses";
  const liteHeader = "x-openai-internal-codex-responses-lite";
  const liteKey = "ws_request_header_x_openai_internal_codex_responses_lite";
  const hintHeader = "x-codex-routing-hint";

  test("caller Lite false replaces a mixed-case configured true header", async () => {
    const { prepareCodexWsRequest } = await import("../../src/server/responses/codex-ws-request");
    const parsed = minimalParsed();
    parsed._rawBody = { model: "gpt-5.6-sol", stream: true, input: [], client_metadata: { [liteKey]: "true" } };
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
      headers: { "X-OpenAI-Internal-Codex-Responses-Lite": "true" },
    });
    const request = await adapter.buildRequest(parsed, { headers: new Headers({ [liteHeader]: "false" }) });
    expect(new Headers(request.headers).get(liteHeader)).toBe("false");
    const prepared = prepareCodexWsRequest(url, { body: request.body, headers: request.headers })!;
    expect(JSON.parse(prepared.frameText).client_metadata[liteKey]).toBe("false");
  });

  test("canonical adapter forwards Lite through selected auth and derives the final wire tier/model", async () => {
    const parsed = minimalParsed();
    parsed.modelId = "gpt-5.4";
    parsed._rawBody = { model: "gpt-5.6-sol", input: [], service_tier: "flex" };
    parsed.options.tierDecision = { kind: "set", value: "priority" };
    const before = JSON.stringify(parsed._rawBody);
    const incoming = headersForCodexAuthContext(new Headers({
      [liteHeader]: "false", [hintHeader]: "model=stale;service_tier=default", originator: "codex_desktop",
    }), poolAuthContext);
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
      headers: { "X-Codex-Routing-Hint": "model=configured;service_tier=default" },
    });
    const request = await adapter.buildRequest(parsed, { headers: incoming });
    const headers = new Headers(request.headers);
    expect(headers.get(liteHeader)).toBe("false");
    expect(headers.get(hintHeader)).toBe("model=gpt-5.6-sol;tier=priority");
    expect(headers.get("authorization")).toBe("Bearer pool_a_token");
    expect(headers.get("originator")).toBe("codex_desktop");
    expect(JSON.parse(request.body).service_tier).toBe("priority");
    expect(JSON.stringify(parsed._rawBody)).toBe(before);
    parsed.options.tierDecision = { kind: "drop" };
    const dropped = await adapter.buildRequest(parsed, { headers: incoming });
    expect(new Headers(dropped.headers).get(hintHeader)).toBe("model=gpt-5.6-sol");
  });

  test("noncanonical adapters neither forward caller Lite nor synthesize a routing hint", async () => {
    for (const authMode of ["forward", "key"] as const) {
      const adapter = createResponsesPassthroughAdapter({
        adapter: "openai-responses", authMode, baseUrl: "https://gateway.example/v1",
        headers: { [hintHeader]: "operator-owned" },
      });
      const request = await adapter.buildRequest(minimalParsed(), {
        headers: new Headers({ [liteHeader]: "true", [hintHeader]: "caller-owned" }),
      });
      expect(new Headers(request.headers).has(liteHeader)).toBe(false);
      expect(new Headers(request.headers).get(hintHeader)).toBe("operator-owned");
    }
  });

  test("canonical preparation copies metadata, lets explicit Lite true/false win, and preserves HTTP init", async () => {
    const { prepareCodexWsRequest } = await import("../../src/server/responses/codex-ws-request");
    for (const lite of ["true", "false"]) {
      const body = JSON.stringify({ model: "gpt-5.6-sol", service_tier: "priority", stream: true, type: "old",
        input: [], reasoning: { effort: "high" },
        client_metadata: { [liteKey]: lite === "true" ? "false" : "true", other: "한글; untouched" },
      });
      const headers = new Headers({
        [liteHeader]: lite, [hintHeader]: "model=stale;service_tier=flex", originator: "codex_desktop",
        authorization: "Bearer selected-fixture", "chatgpt-account-id": "selected-fixture",
        "content-type": "application/json", "content-length": "123", accept: "text/event-stream",
        "accept-encoding": "gzip", "openai-beta": "other=fixture",
      });
      const beforeHeaders = [...headers];
      const init = { method: "POST", body, headers, signal: new AbortController().signal,
        redirect: "error" as const, httpVersion: "1.1" as const };
      const prepared = prepareCodexWsRequest(url, init)!;
      expect(prepared.canonical).toBe(true);
      expect(JSON.parse(prepared.frameText)).toEqual({ model: "gpt-5.6-sol", service_tier: "priority",
        type: "response.create", input: [], reasoning: { effort: "high" },
        client_metadata: { [liteKey]: lite, other: "한글; untouched" },
      });
      const wsHeaders = new Headers(prepared.headers);
      expect(wsHeaders.get(hintHeader)).toBe("model=gpt-5.6-sol;tier=priority");
      expect(wsHeaders.get("openai-beta")).toBe("other=fixture, responses_websockets=2026-02-06");
      for (const name of ["content-type", "content-length", "accept", "accept-encoding"]) {
        expect(wsHeaders.has(name)).toBe(false);
      }
      for (const name of [liteHeader, "originator", "authorization", "chatgpt-account-id"]) {
        expect(wsHeaders.get(name)).toBe(headers.get(name));
      }
      expect(prepared.httpInit).not.toBe(init);
      expect(prepared.httpInit).toEqual({ ...init, headers: new Headers({
        ...Object.fromEntries(headers), [hintHeader]: "model=gpt-5.6-sol;tier=priority",
      }) });
      expect(prepared.httpInit.body).toBe(body);
      expect(prepared.httpInit.signal).toBe(init.signal);
      expect([...headers]).toEqual(beforeHeaders);
      expect(init.body).toBe(body);
    }
  });

  test("absent Lite preserves native metadata, invalid HTTP Lite does not coerce it, and no identity is invented", async () => {
    const { prepareCodexWsRequest } = await import("../../src/server/responses/codex-ws-request");
    for (const lite of [undefined, "yes", "1", "TRUE", "true, false"]) {
      const headers = new Headers({ "openai-beta": "responses_websockets=existing" });
      if (lite !== undefined) headers.set(liteHeader, lite);
      const prepared = prepareCodexWsRequest(url, { headers, body: JSON.stringify({ model: "gpt-5.4",
        client_metadata: { [liteKey]: "false", thread_id: "thread-fixture" }, stream: true,
      }) })!;
      expect(JSON.parse(prepared.frameText).client_metadata).toEqual({ [liteKey]: "false", thread_id: "thread-fixture" });
      expect(new Headers(prepared.headers).get("openai-beta")).toBe("responses_websockets=existing");
      expect(new Headers(prepared.headers).has("originator")).toBe(false);
      expect(new Headers(prepared.headers).has("user-agent")).toBe(false);
    }
    const absent = prepareCodexWsRequest(url, { body: '{"model":"gpt-5.4","stream":true}' })!;
    expect(JSON.parse(absent.frameText).client_metadata).toBeUndefined();
    const explicit = prepareCodexWsRequest(url, {
      headers: { [liteHeader]: "true" }, body: '{"model":"gpt-5.4","stream":true}',
    })!;
    expect(JSON.parse(explicit.frameText).client_metadata).toEqual({ [liteKey]: "true" });
  });

  test("noncanonical WS preparation retains its prior wire serialization and operator headers", async () => {
    const { prepareCodexWsRequest } = await import("../../src/server/responses/codex-ws-request");
    for (const target of ["https://gateway.example/v1/responses", `${url}?mode=other`, `${url}/`]) {
      const body = { model: "gpt-5.6-sol", stream: true, client_metadata: ["gateway-specific"], input: [] };
      const prepared = prepareCodexWsRequest(target, { body: JSON.stringify(body),
        headers: { [liteHeader]: "true", [hintHeader]: "operator-owned" },
      })!;
      expect(prepared.canonical).toBe(false);
      expect(prepared.frameText).toBe(JSON.stringify({ model: "gpt-5.6-sol", client_metadata: ["gateway-specific"], input: [], type: "response.create" }));
      expect(new Headers(prepared.headers).get(hintHeader)).toBe("operator-owned");
      expect(new Headers(prepared.httpInit.headers).get(hintHeader)).toBe("operator-owned");
      const noHint = prepareCodexWsRequest(target, { body: JSON.stringify(body) })!;
      expect(new Headers(noHint.headers).has(hintHeader)).toBe(false);
    }
  });

  test("malformed JSON records or native metadata retain HTTP fallback eligibility", async () => {
    const { prepareCodexWsRequest } = await import("../../src/server/responses/codex-ws-request");
    for (const body of [undefined, "{", "null", "[]", "true", "1", '"text"']) {
      expect(prepareCodexWsRequest(url, { body })).toBeNull();
    }
    for (const client_metadata of [null, [], true, 1, "text", { unrelated: false }, { [liteKey]: true }]) {
      const init = { body: JSON.stringify({ model: "gpt-5.4", client_metadata }), headers: { [liteHeader]: "true" } };
      const before = JSON.stringify(init);
      expect(prepareCodexWsRequest(url, init)).toBeNull();
      expect(JSON.stringify(init)).toBe(before);
    }
  });

  test("routing hint removes stale values and rejects invalid model or tier components without changing the body", async () => {
    const { applyCodexRoutingHint } = await import("../../src/codex/forward-transport-headers");
    const invalid = ["", " ", "model;service_tier=priority", "model=tier", "a b", "a\t", "a\n", "a\r", "a\0", "a\x7f", "é", null, 42];
    for (const body of [null, [], "text", {}, ...invalid.map(model => ({ model })),
      ...invalid.map(service_tier => ({ model: "gpt-5.4", service_tier })),
      { model: "m".repeat(257) }, { model: "gpt-5.4", service_tier: "t".repeat(65) }]) {
      const headers = new Headers({ [hintHeader]: "model=stale;service_tier=priority", originator: "unchanged" });
      const before = JSON.stringify(body);
      applyCodexRoutingHint(headers, body);
      expect(headers.has(hintHeader)).toBe(false);
      expect(headers.get("originator")).toBe("unchanged");
      expect(JSON.stringify(body)).toBe(before);
    }
    const headers = new Headers();
    applyCodexRoutingHint(headers, { model: "m".repeat(256), service_tier: "t".repeat(64) });
    expect(headers.get(hintHeader)).toBe(`model=${"m".repeat(256)};tier=${"t".repeat(64)}`);
    applyCodexRoutingHint(headers, { model: "gpt-5.4" });
    expect(headers.get(hintHeader)).toBe("model=gpt-5.4");
  });
});
