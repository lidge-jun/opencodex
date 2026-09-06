import { describe, expect, test, beforeEach } from "bun:test";
import { captureTerminalHttpStatus } from "../../src/server/request-log";
import { codexForwardTerminalOutcomeRecorder } from "../../src/server/responses/core";
import {
  clearCodexUpstreamHealth,
  getCodexAccountCooldownUntil,
} from "../../src/codex/routing";
import type { CodexAuthContext } from "../../src/codex/auth-context";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

describe("forward incomplete quota failover handling", () => {
  beforeEach(() => {
    clearCodexUpstreamHealth();
  });

  test("captureTerminalHttpStatus records 429 when response.incomplete has quota error message", () => {
    const logCtx: Record<string, unknown> = {};
    captureTerminalHttpStatus(logCtx as any, {
      type: "response.incomplete",
      response: {
        incomplete_details: {
          reason: "usage_limit_reached",
          message: "The usage limit has been reached",
        },
      },
    });
    expect(logCtx.terminalHttpStatus).toBe(429);
  });

  test("codexForwardTerminalOutcomeRecorder trips cooldown on incomplete quota terminal", () => {
    const config = {
      codexAccounts: [
        { id: "pool-a", email: "pool-a@example.com", isMain: false },
        { id: "pool-b", email: "pool-b@example.com", isMain: false },
      ],
      activeCodexAccountId: "pool-a",
    } as unknown as OcxConfig;

    const authCtx: CodexAuthContext = {
      kind: "pool",
      accountId: "pool-a",
      generation: 1,
      affinityKey: "thread_123",
      fixedAccount: false,
    } as unknown as CodexAuthContext;

    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    };

    const logCtx = {
      upstreamError: "The usage limit has been reached",
    };

    const recorder = codexForwardTerminalOutcomeRecorder(
      config,
      authCtx,
      provider,
      "gpt-5.6",
      logCtx as any,
    );
    expect(recorder).toBeDefined();

    recorder!("incomplete");

    // The account should now be on cooldown due to 429
    const cooldownUntil = getCodexAccountCooldownUntil("pool-a");
    expect(cooldownUntil).toBeGreaterThan(Date.now());
  });

  test("codexForwardTerminalOutcomeRecorder records 200 on standard incomplete (e.g. max tokens)", () => {
    const config = {
      codexAccounts: [
        { id: "pool-a", email: "pool-a@example.com", isMain: false },
      ],
      activeCodexAccountId: "pool-a",
    } as unknown as OcxConfig;

    const authCtx: CodexAuthContext = {
      kind: "pool",
      accountId: "pool-a",
      generation: 1,
      affinityKey: "thread_123",
      fixedAccount: false,
    } as unknown as CodexAuthContext;

    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    };

    const logCtx = {
      terminalIncompleteReason: "max_output_tokens",
    };

    const recorder = codexForwardTerminalOutcomeRecorder(
      config,
      authCtx,
      provider,
      "gpt-5.6",
      logCtx as any,
    );
    expect(recorder).toBeDefined();

    recorder!("incomplete");

    // Normal incomplete terminal does not penalize account health
    const cooldownUntil = getCodexAccountCooldownUntil("pool-a");
    expect(cooldownUntil).toBeNull();
  });

  test("handleResponsesCompact falls through to routed synthetic compaction when upstream returns 404 on /responses/compact", async () => {
    const { handleResponsesCompact } = await import("../../src/server/responses/compact");
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      requestedUrls.push(urlStr);
      if (urlStr.includes("/responses/compact")) {
        return new Response(JSON.stringify({ detail: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      const payload = {
        id: "resp_1",
        status: "completed",
        output: [{ type: "compaction", encrypted_content: "opaque_blob_xyz" }],
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const config = {
        defaultProvider: "openai-apikey",
        providers: {
          "openai-apikey": {
            adapter: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            authMode: "key",
            apiKey: "test-key",
          },
        },
      } as unknown as OcxConfig;

      const req = new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai-apikey/gpt-5.6",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        }),
      });

      const res = await handleResponsesCompact(req, config, {} as any);
      expect(res.status).toBe(200);
      expect(requestedUrls.some(u => u.includes("/responses/compact"))).toBe(true);
      expect(requestedUrls.some(u => u.endsWith("/responses") || u.includes("/v1/responses"))).toBe(true);
      const json = await res.json() as any;
      expect(json.output).toBeDefined();
      expect(json.output[0].type).toBe("compaction");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
