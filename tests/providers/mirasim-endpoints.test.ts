import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMirasimDeviceIdentity } from "../../src/adapters/mirasim/crypto";
import { resetMirasimTransportStateForTests } from "../../src/adapters/mirasim/transport";
import { saveCredential } from "../../src/oauth/store";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { handleClaudeCountTokens } from "../../src/server/claude-messages";
import { handleSearch } from "../../src/server/search";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "opencodex-mirasim-endpoints-"));
  mkdirSync(home, { recursive: true });
  process.env.OPENCODEX_HOME = home;
  globalThis.fetch = originalFetch;
  resetMirasimTransportStateForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetMirasimTransportStateForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function syntheticCredential() {
  const identity = createMirasimDeviceIdentity();
  return {
    access: "mirasim-endpoint-access",
    refresh: "mirasim-endpoint-refresh",
    expires: Date.now() + 3_600_000,
    source: "oauth" as const,
    accountId: "mirasim-endpoint-account",
    mirasim: {
      devicePrivateKey: identity.privateKeyPem,
      relayUrl: "https://relay.mirasim.ai",
      adminUrl: "https://auth.mirasim.ai",
      clientVersion: "0.0.336",
    },
  };
}

type Captured = { path: string; method: string; headers: Headers; body?: Record<string, unknown> };

function mirasimConfig(fakeFetch: typeof fetch): OcxConfig {
  const entry = getProviderRegistryEntry("mirasim");
  if (!entry) throw new Error("missing Mirasim registry entry");
  const provider = {
    ...providerConfigSeed(entry),
    fetch: fakeFetch,
  } as OcxProviderConfig & { fetch: typeof fetch };
  return {
    port: 0,
    defaultProvider: "mirasim",
    providers: { mirasim: provider },
  } as OcxConfig;
}

function captureFetch(calls: Captured[], responder: (call: Captured) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    let body: Record<string, unknown> | undefined;
    if (rawBody) {
      try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* not JSON */ }
    }
    const call: Captured = {
      path: new URL(url).pathname,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(body ? { body } : {}),
    };
    calls.push(call);
    if (call.path === "/v1/device/session") {
      return new Response(JSON.stringify({ ticket: "mirasim-endpoint-ticket", expiresIn: 600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return responder(call);
  }) as typeof fetch;
}

describe("Mirasim auxiliary inference endpoints", () => {
  test("GPT-6 code-mode exec stays native custom from Codex request through relay response", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: Captured[] = [];
    const config = mirasimConfig(captureFetch(calls, call => {
      if (call.path !== "/v1/responses") return new Response("not found", { status: 404 });
      const tool = Array.isArray(call.body?.tools)
        ? call.body.tools[0] as Record<string, unknown> | undefined
        : undefined;
      const native = tool?.type === "custom";
      const item = native
        ? {
            id: "ctc_mirasim_exec",
            type: "custom_tool_call",
            call_id: "call_mirasim_exec",
            name: "exec",
            input: "text(\"ok\")",
            status: "completed",
          }
        : {
            id: "fc_mirasim_exec",
            type: "function_call",
            call_id: "call_mirasim_exec",
            name: "exec",
            arguments: JSON.stringify({ input: "text(\"ok\")" }),
            status: "completed",
          };
      const added = {
        type: "response.output_item.added",
        output_index: 0,
        item: native ? { ...item, input: "", status: "in_progress" } : { ...item, arguments: "", status: "in_progress" },
      };
      const done = { type: "response.output_item.done", output_index: 0, item };
      const terminal = {
        type: "response.completed",
        response: {
          id: "resp_mirasim_exec",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-6-astra",
          output: [item],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        },
      };
      return new Response([
        `data: ${JSON.stringify(added)}\n\n`,
        `data: ${JSON.stringify(done)}\n\n`,
        `data: ${JSON.stringify(terminal)}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const releaseSpendHome = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mirasim/gpt-6-astra",
          stream: true,
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Run pwd." }],
          }],
          tools: [{
            type: "namespace",
            name: "functions",
            tools: [{
              type: "custom",
              name: "exec",
              description: "Run JavaScript",
              format: { type: "grammar", syntax: "lark" },
            }],
          }],
          tool_choice: "auto",
        }),
      }), config, { model: "", provider: "" }, { abortSignal: AbortSignal.timeout(5_000) });

      expect(response.status).toBe(200);
      const inference = calls.find(call => call.path === "/v1/responses");
      const tools = inference?.body?.tools as Array<Record<string, unknown>> | undefined;
      expect(tools?.[0]).toMatchObject({ type: "custom", name: "exec" });
      const sse = await response.text();
      expect(sse).toContain('"type":"custom_tool_call"');
      expect(sse).toContain('"name":"exec"');
      expect(sse).not.toContain('"type":"function_call","name":"exec"');
    } finally {
      releaseSpendHome();
    }
  });

  test("non-stream GPT caller receives bounded JSON even though Mirasim forces upstream Responses SSE", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: Captured[] = [];
    const config = mirasimConfig(captureFetch(calls, call => {
      if (call.path !== "/v1/responses") return new Response("not found", { status: 404 });
      expect(call.body).toMatchObject({
        model: "gpt-5.6-luna",
        stream: true,
        store: false,
        parallel_tool_calls: true,
        include: ["reasoning.encrypted_content"],
      });
      const terminal = {
        type: "response.completed",
        response: {
          id: "resp_mirasim_fixture",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.6-luna",
          // The live relay can leave the terminal snapshot empty even after emitting authoritative
          // output_item.done frames. The non-stream collector must reconstruct output from them.
          output: [],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        },
      };
      const functionDone = {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "fc_mirasim_fixture",
          type: "function_call",
          call_id: "call_mirasim_fixture",
          name: "lookup",
          arguments: "{}",
          status: "completed",
        },
      };
      const messageDone = {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_mirasim_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "OK", annotations: [] }],
        },
      };
      return new Response([
        `data: ${JSON.stringify(functionDone)}\n\n`,
        `data: ${JSON.stringify(messageDone)}\n\n`,
        `data: ${JSON.stringify(terminal)}\n\n`,
      ].join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const releaseSpendHome = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mirasim/gpt-5.6-luna",
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Reply with OK only." }],
          }],
          stream: false,
        }),
      }), config, { model: "", provider: "" }, { abortSignal: AbortSignal.timeout(5_000) });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const json = await response.json() as {
        id?: string;
        status?: string;
        model?: string;
        output?: Array<{
          type?: string;
          content?: Array<{ text?: string }>;
          call_id?: string;
          name?: string;
          arguments?: string;
        }>;
      };
      expect(json.id).toBe("resp_mirasim_fixture");
      expect(json.status).toBe("completed");
      expect(json.model).toBe("gpt-5.6-luna");
      expect(json.output?.[0]?.content?.[0]?.text).toBe("OK");
      expect(json.output?.[1]).toMatchObject({
        type: "function_call",
        call_id: "call_mirasim_fixture",
        name: "lookup",
        arguments: "{}",
      });
      expect(calls.map(call => call.path)).toEqual([
        "/v1/device/session",
        "/v1/responses",
      ]);
    } finally {
      releaseSpendHome();
    }
  });

  test("Claude count_tokens uses the signed relay, bare model id, and long-context beta", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: Captured[] = [];
    const config = mirasimConfig(captureFetch(calls, call => {
      if (call.path === "/v1/messages/count_tokens") {
        return new Response(JSON.stringify({ input_tokens: 321 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    const response = await handleClaudeCountTokens(new Request("http://127.0.0.1/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "other-beta",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5[1m]",
        messages: [{ role: "user", content: "count this" }],
      }),
    }), config);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 321 });
    expect(calls.map(call => call.path)).toEqual([
      "/v1/device/session",
      "/v1/messages/count_tokens",
    ]);
    const count = calls[1]!;
    expect(count.body?.model).toBe("claude-sonnet-5");
    expect(count.headers.get("authorization")).toBe("Bearer mirasim-endpoint-ticket");
    expect(count.headers.get("anthropic-beta")).toBe("other-beta,context-1m-2025-08-07");
    expect(count.headers.get("x-mirasim-enc")).toBeTruthy();
    expect(count.headers.get("x-mirasim-agent")).toBeNull();
  });

  test("Claude count_tokens applies the configured response-header deadline", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/device/session") {
        return new Response(JSON.stringify({ ticket: "mirasim-timeout-ticket", expiresIn: 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path !== "/v1/messages/count_tokens") return new Response("not found", { status: 404 });
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const config = mirasimConfig(fakeFetch);
    config.connectTimeoutMs = 20;

    const started = performance.now();
    const response = await handleClaudeCountTokens(new Request("http://127.0.0.1/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "count this" }],
      }),
    }), config);

    expect(response.status).toBe(502);
    expect(performance.now() - started).toBeLessThan(250);
    expect(await response.text()).toContain("Mirasim count_tokens request timed out");
  });

  test("alpha/search force-refreshes OAuth after the signed transport returns an authenticated 401", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const refreshedAccess = "mirasim-search-new-access";
    let refreshCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      expect(new URL(url).pathname).toBe("/auth/refresh");
      refreshCalls += 1;
      return new Response(JSON.stringify({
        access_token: refreshedAccess,
        refresh_token: "mirasim-search-new-refresh",
        expires_in: 1800,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let sessionCalls = 0;
    let searchCalls = 0;
    const relayFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      const bearer = new Headers(init?.headers).get("authorization");
      if (path === "/v1/device/session") {
        sessionCalls += 1;
        if (bearer === "Bearer mirasim-endpoint-access") {
          return new Response(JSON.stringify({ ticket: `old-search-ticket-${sessionCalls}`, expiresIn: 600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        expect(bearer).toBe(`Bearer ${refreshedAccess}`);
        return new Response(JSON.stringify({ ticket: "fresh-search-ticket", expiresIn: 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/alpha/search") {
        searchCalls += 1;
        if (bearer?.startsWith("Bearer old-search-ticket-")) {
          return new Response(JSON.stringify({ error: "expired access token" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        expect(bearer).toBe("Bearer fresh-search-ticket");
        return new Response(JSON.stringify({ output: "recovered search" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const response = await handleSearch(new Request("http://127.0.0.1/v1/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mirasim/gpt-5.6-sol",
        commands: { search_query: [{ q: "recover" }] },
      }),
    }), mirasimConfig(relayFetch), {} as RequestLogContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: "recovered search" });
    expect(refreshCalls).toBe(1);
    expect(sessionCalls).toBe(2);
    expect(searchCalls).toBe(2);
  });

  test("alpha/search preserves the original authenticated 401 body when refreshed replay cannot be built", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const refreshedAccess = "mirasim-search-new-access";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: refreshedAccess,
      refresh_token: "mirasim-search-new-refresh",
      expires_in: 1800,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    let oldSessionCalls = 0;
    const relayFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      const bearer = new Headers(init?.headers).get("authorization");
      if (path === "/v1/device/session") {
        if (bearer === `Bearer ${refreshedAccess}`) throw new Error("replacement relay unavailable");
        oldSessionCalls += 1;
        return new Response(JSON.stringify({ ticket: `old-search-ticket-${oldSessionCalls}`, expiresIn: 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/alpha/search") {
        return new Response(JSON.stringify({ error: "original authenticated rejection" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const response = await handleSearch(new Request("http://127.0.0.1/v1/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mirasim/gpt-5.6-sol",
        commands: { search_query: [{ q: "preserve rejection" }] },
      }),
    }), mirasimConfig(relayFetch), {} as RequestLogContext);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "original authenticated rejection" });
  });

  test("alpha/search routes a Mirasim GPT model through the signed inference transport", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: Captured[] = [];
    const config = mirasimConfig(captureFetch(calls, call => {
      if (call.path === "/v1/alpha/search") {
        return new Response(JSON.stringify({ output: "mirasim search" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));
    const logCtx = {} as RequestLogContext;
    const response = await handleSearch(new Request("http://127.0.0.1/v1/alpha/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mirasim/gpt-5.6-sol",
        commands: { search_query: [{ q: "Mirasim" }] },
      }),
    }), config, logCtx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ output: "mirasim search" });
    expect(calls.map(call => call.path)).toEqual([
      "/v1/device/session",
      "/v1/alpha/search",
    ]);
    const search = calls[1]!;
    expect(search.body?.model).toBe("gpt-5.6-sol");
    expect(search.headers.get("authorization")).toBe("Bearer mirasim-endpoint-ticket");
    expect(search.headers.get("x-mirasim-enc")).toBeTruthy();
    expect(search.headers.get("x-mirasim-agent")).toBeNull();
    expect(logCtx.provider).toBe("mirasim");
    expect(logCtx.model).toBe("gpt-5.6-sol");
  });
});
