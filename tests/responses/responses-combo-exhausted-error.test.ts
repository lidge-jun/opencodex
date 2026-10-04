import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

/**
 * A spent primary followed by a fallback that refuses its own credential or plan must surface
 * the primary's quota answer. Production returned "OpenAI account pool has no usable account
 * credential" while every Claude account was out of quota.
 */
const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;

const reset = (): void => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
};
beforeEach(() => {
  reset();
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  reset();
});

const provider = (name: string) => ({
  adapter: "openai-chat",
  baseUrl: `https://${name}.example/v1`,
  authMode: "key",
  apiKey: `sk-${name}`,
  models: [`model-${name}`],
});
const config = {
  defaultProvider: "primary",
  providers: { primary: provider("primary"), fallback: provider("fallback") },
  combos: {
    fan: {
      strategy: "failover",
      targets: [
        { provider: "primary", model: "model-primary" },
        { provider: "fallback", model: "model-fallback" },
      ],
    },
  },
} as unknown as OcxConfig;

const request = (): Request => new Request("http://localhost/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "combo/fan", stream: false, input: "hello" }),
});

function upstream(fallbackStatus: number, fallbackMessage: string): string[] {
  const hosts: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    hosts.push(host);
    return host.startsWith("primary")
      ? Response.json({ error: { message: "weekly usage limit reached", type: "rate_limit_error" } }, { status: 429 })
      : Response.json({ error: { message: fallbackMessage, type: "invalid_request_error" } }, { status: fallbackStatus });
  }) as typeof fetch;
  return hosts;
}

describe("combo exhaustion reports the primary's quota refusal", () => {
  for (const [status, message] of [
    [401, "OpenAI account pool has no usable account credential"],
    [400, "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account."],
  ] as const) {
    test(`over a fallback ${status}`, async () => {
      const hosts = upstream(status, message);
      const response = await handleResponses(request(), config, { model: "", provider: "" } as RequestLogContext);
      expect(hosts).toEqual(["primary.example", "fallback.example"]);
      expect(response.status).toBe(429);
      expect(await response.text()).toContain("weekly usage limit reached");
    });
  }

  test("a primary already cooled before the request answers with the cooldown, not the fallback", async () => {
    coolComboTarget("fan", { provider: "primary", model: "model-primary" }, { retryAfter: "120", status: 429 });
    const hosts = upstream(401, "OpenAI account pool has no usable account credential");
    const response = await handleResponses(request(), config, { model: "", provider: "" } as RequestLogContext);
    expect(hosts).toEqual(["fallback.example"]);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(await response.text()).toContain("No available targets for combo: fan");
  });

  test("a cooldown this request created does not replace the fallback's own refusal", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const host = new URL(input instanceof Request ? input.url : String(input)).host;
      return host.startsWith("primary")
        ? Response.json({ error: { message: "bad gateway", type: "server_error" } }, { status: 502 })
        : Response.json({ error: { message: "invalid api key", type: "authentication_error" } }, { status: 401 });
    }) as typeof fetch;
    const response = await handleResponses(request(), config, { model: "", provider: "" } as RequestLogContext);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("invalid api key");
  });

  test("a fallback 5xx is still the answer", async () => {
    upstream(502, "bad gateway");
    const response = await handleResponses(request(), config, { model: "", provider: "" } as RequestLogContext);
    expect(response.status).toBe(502);
  });
});
