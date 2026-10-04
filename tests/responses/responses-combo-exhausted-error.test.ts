import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget, snapshotComboQuotaCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleComboResponses, handleResponses } from "../../src/server/responses/core";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { jsonUtf8Bytes } from "../../src/lib/json-byte-size";
import { createProtocolEnvelope } from "../../src/protocols/envelope";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { inspectResponseLogJson } from "../../src/server/request-log";
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

// Inspect each child's error as the native response logging path does, so the fixture carries
// distinct diagnostics even for adapters whose early HTTP refusal has no terminal callback.
async function loggedCombo(cfg: OcxConfig, logCtx: RequestLogContext, sendBudget?: ReturnType<typeof createRequestExecutionBudget>): Promise<Response> {
  const req = request();
  return executeComboResponses(req, await req.clone().json(), "fan", cfg, logCtx, {
    translatorBudget: createTranslatorBudget(), sendBudget,
  }, {
    handleComboResponses,
    handleResponses: async (...args) => {
      const response = await handleResponses(...args);
      inspectResponseLogJson(args[2], await response.clone().text());
      return response;
    },
  });
}

function upstream(fallbackStatus: number, fallbackMessage: string, primaryStatus = 429): string[] {
  const hosts: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    hosts.push(host);
    return host.startsWith("primary")
      ? Response.json({ error: { message: "weekly usage limit reached", type: "rate_limit_error" } }, { status: primaryStatus })
      : Response.json({ error: { message: fallbackMessage, type: "invalid_request_error" } }, { status: fallbackStatus });
  }) as typeof fetch;
  return hosts;
}

// Exercise the real reject-policy eligibility path and native dispatch seam with a budget
// for one selected target: its eligibility copy and dispatch copy, never an unused target.
async function nativeCombo(cfg = config, status = 200) {
  const nativeConfig: OcxConfig = {
    ...cfg,
    protocols: { unrepresentable: "reject", rollout: { nativeChatCombos: true } },
  };
  const chatBody = { model: "combo/fan", stream: false, n: 2, messages: [{ role: "user", content: "hello" }] };
  const budget = createTranslatorBudget({ maxTurnBytes: 2 * jsonUtf8Bytes(chatBody) });
  const envelope = createProtocolEnvelope({ inbound: "chat", body: chatBody, translatorBudget: budget });
  const copies: Record<string, unknown>[] = [];
  const dispatched: string[] = [];
  const req = request();
  try {
    const response = await executeComboResponses(req, await req.clone().json(), "fan", nativeConfig,
      { model: "", provider: "" }, {
        translatorBudget: budget,
        sendBudget: createRequestExecutionBudget(),
        protocolSource: {
          inbound: "chat",
          envelope: {
            ...envelope,
            freshBody: () => {
              const copy = envelope.freshBody();
              copies.push(copy);
              return copy;
            },
          },
          dispatchNativeChild: async ({ route, finishLog }) => {
            dispatched.push(route.providerName);
            finishLog(status);
            return status === 200
              ? Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })
              : Response.json({ error: { message: "invalid api key", type: "authentication_error" } }, { status });
          },
        },
      }, { handleResponses, handleComboResponses });
    return { response, dispatched, copies, overflows: budget.snapshot().overflows };
  } finally {
    budget.dispose();
  }
}

describe("combo exhaustion reports the primary's quota refusal", () => {
  for (const cooled of [false, true]) {
    test(`a successful native Chat combo skips unused quota eligibility (cooldown: ${cooled})`, async () => {
      if (cooled) coolComboTarget("fan", { provider: "fallback", model: "model-fallback" }, { retryAfter: "120", status: 429 });
      const { response, dispatched, copies, overflows } = await nativeCombo();
      expect(response.status).toBe(200);
      expect(dispatched).toEqual(["primary"]);
      expect(copies.map(copy => copy.model)).toEqual(["primary/model-primary", "primary/model-primary"]);
      expect(overflows).toBe(0);
    });
  }

  test("a request-ineligible quota snapshot cannot replace the fallback's 401", async () => {
    coolComboTarget("fan", { provider: "primary", model: "model-primary" }, { retryAfter: "120", status: 429 });
    const bridged = { ...config, providers: { ...config.providers, primary: { ...config.providers.primary!, adapter: "openai-responses" } } };
    // n: 2 cannot traverse this primary's Responses bridge under the reject policy.
    const { response, dispatched, overflows } = await nativeCombo(bridged, 401);
    expect(dispatched).toEqual(["fallback"]);
    expect(response.status).toBe(401);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(overflows).toBe(0);
  });

  test("a throwing snapshot eligibility check preserves the fallback's 401", async () => {
    coolComboTarget("fan", { provider: "primary", model: "model-primary" }, { retryAfter: "120", status: 429 });
    const { response, dispatched, overflows } = await nativeCombo(config, 401);
    expect(dispatched).toEqual(["fallback"]);
    expect(response.status).toBe(401);
    expect(response.headers.get("retry-after")).toBeNull();
    // Only lazy eligibility for the cooled primary attempts a third charged body copy.
    expect(overflows).toBe(1);
  });

  test("quota cooldown snapshots retain usable targets and expiry for 429 and 402", () => {
    for (const status of [429, 402]) {
      coolComboTarget("fan", { provider: "primary", model: "model-primary" }, { retryAfter: "120", status, now: 1_000 });
      expect(snapshotComboQuotaCooldowns(config, "fan", 1_000)).toMatchObject([
        { target: { provider: "primary", model: "model-primary" }, cooldownUntil: 121_000 },
      ]);
      const disabled = { ...config, providers: { ...config.providers, primary: { ...config.providers.primary!, disabled: true } } };
      expect(snapshotComboQuotaCooldowns(disabled, "fan", 1_000)).toEqual([]);
      expect(snapshotComboQuotaCooldowns(config, "fan", 121_000)).toEqual([]);
    }
    coolComboTarget("fan", { provider: "primary", model: "model-primary" }, { retryAfter: "120", now: 1_000 });
    expect(snapshotComboQuotaCooldowns(config, "fan", 1_000)).toEqual([]);
  });

  for (const [primary, status, message] of [
    [429, 401, "OpenAI account pool has no usable account credential"],
    [429, 400, "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account."],
    [429, 403, "forbidden"],
    [402, 401, "invalid api key"],
  ] as const) {
    test(`a primary ${primary} over a fallback ${status}`, async () => {
      const hosts = upstream(status, message, primary);
      const logCtx = { model: "", provider: "" } as RequestLogContext;
      const response = await loggedCombo(config, logCtx);
      expect(hosts).toEqual(["primary.example", "fallback.example"]);
      expect(response.status).toBe(primary);
      expect(await response.text()).toContain("weekly usage limit reached");
      expect(logCtx.upstreamError).toContain("weekly usage limit reached");
      expect(logCtx.attempts).toMatchObject([
        { provider: "primary", status: primary, sendCount: 1 },
        { provider: "fallback", status, sendCount: 1 },
      ]);
      expect(logCtx.attempts).toHaveLength(2);
    });
  }

  test("a primary already cooled before the request answers with the cooldown, not the fallback", async () => {
    coolComboTarget("fan", { provider: "primary", model: "model-primary" }, { retryAfter: "120", status: 429 });
    coolComboTarget("fan", { provider: "removed", model: "unused" }, { retryAfter: "1", status: 502 });
    const hosts = upstream(401, "OpenAI account pool has no usable account credential");
    const response = await handleResponses(request(), config, { model: "", provider: "" } as RequestLogContext);
    expect(hosts).toEqual(["fallback.example"]);
    expect(response.status).toBe(503);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(119);
    expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(120);
    expect(await response.text()).toContain("No available targets for combo: fan");
  });

  test("a target cooled earlier by a 502 does not replace the fallback's 401", async () => {
    coolComboTarget("fan", { provider: "primary", model: "model-primary" }, { retryAfter: "120", status: 502 });
    const hosts = upstream(401, "invalid api key");
    const response = await handleResponses(request(), config, { model: "", provider: "" } as RequestLogContext);
    expect(hosts).toEqual(["fallback.example"]);
    expect(response.status).toBe(401);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.text()).toContain("invalid api key");
  });

  test("a disabled target's quota cooldown does not replace the eligible target's 401", async () => {
    coolComboTarget("fan", { provider: "primary", model: "model-primary" }, { retryAfter: "120", status: 429 });
    const disabled = {
      ...config,
      providers: { ...config.providers, primary: { ...config.providers.primary!, disabled: true } },
    } as OcxConfig;
    const hosts = upstream(401, "invalid api key");
    const response = await handleResponses(request(), disabled, { model: "", provider: "" } as RequestLogContext);
    expect(hosts).toEqual(["fallback.example"]);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("invalid api key");
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

  test("a send budget refused before the third target still reports the primary's 429", async () => {
    const budget = createRequestExecutionBudget();
    const three = {
      ...config,
      providers: { ...config.providers, third: provider("third") },
      combos: {
        fan: {
          strategy: "failover",
          targets: [...config.combos!.fan!.targets, { provider: "third", model: "model-third" }],
        },
      },
    } as unknown as OcxConfig;
    const hosts = upstream(401, "OpenAI account pool has no usable account credential");
    const fetchUpstream = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetchUpstream(input, init);
      if (hosts.length === 2) budget.used = 1_000;
      return response;
    }) as typeof fetch;
    const logCtx = { model: "", provider: "" } as RequestLogContext;
    const response = await loggedCombo(three, logCtx, budget);
    expect(hosts).toEqual(["primary.example", "fallback.example"]);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("weekly usage limit reached");
    expect(logCtx.upstreamError).toContain("weekly usage limit reached");
    expect(logCtx.attempts).toMatchObject([
      { provider: "primary", status: 429, sendCount: 1 },
      { provider: "fallback", status: 401, sendCount: 1 },
    ]);
    expect(logCtx.attempts).toHaveLength(2);
  });

  test("a fallback 5xx is still the answer", async () => {
    upstream(502, "bad gateway");
    const response = await handleResponses(request(), config, { model: "", provider: "" } as RequestLogContext);
    expect(response.status).toBe(502);
  });
});
