import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget, snapshotComboQuotaCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCachedProviderQuotas, setCachedProviderQuotaForTests } from "../../src/providers/quota-routing-cache";
import type { ProviderQuota } from "../../src/providers/quota-types";
import { handleComboResponses, handleResponses } from "../../src/server/responses/core";
import { comboExecutionBudgetPolicy, executeComboResponses } from "../../src/server/responses/core-combo";
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
  for (const exit of ["disabled", "cooling", "metered", "send-budget", "fallback-off"] as const) {
    test(`context refusal with no later send: ${exit}`, async () => {
      const cfg: OcxConfig = {
        ...config,
        providers: { ...config.providers, fallback: { ...config.providers.fallback!, disabled: exit === "disabled" } },
        combos: { fan: { strategy: "failover", targets: [
          { provider: "primary", model: "model-primary" },
          { provider: "fallback", model: "model-fallback", metered: exit === "metered" },
        ] } },
        ...(exit === "fallback-off" ? { fallback: { provider: false } } : {}),
      };
      if (exit === "cooling") coolComboTarget("fan", { provider: "fallback", model: "model-fallback" }, { retryAfter: "120", status: 429 });
      const budget = createRequestExecutionBudget();
      const hosts: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        hosts.push(new URL(input instanceof Request ? input.url : String(input)).host);
        if (exit === "send-budget") budget.used = comboExecutionBudgetPolicy(2).maxTotalModelSends;
        return Response.json({ error: { message: "Please reduce the length of the messages or completion." } }, { status: 400 });
      }) as typeof fetch;
      const logCtx = { model: "", provider: "" } as RequestLogContext;
      const response = await loggedCombo(cfg, logCtx, budget);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: {
        code: exit === "fallback-off" ? "fallback_refused" : "context_length_exceeded",
      } });
      expect(hosts).toEqual(["primary.example"]);
      expect(logCtx.upstreamError).toContain("Please reduce the length");
      expect(logCtx.attempts).toMatchObject([{ provider: "primary", status: 400, sendCount: 1 }]);
      expect(logCtx.attempts).toHaveLength(1);
    });
  }

  test("a later fatal validation refusal overrides a retained context refusal", async () => {
    const hosts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const host = new URL(input instanceof Request ? input.url : String(input)).host;
      hosts.push(host);
      return Response.json({ error: { message: host.startsWith("primary")
        ? "Please reduce the length of the messages or completion." : "Invalid JSON" } }, { status: 400 });
    }) as typeof fetch;
    const logCtx = { model: "", provider: "" } as RequestLogContext;
    const response = await loggedCombo(config, logCtx);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("Invalid JSON");
    expect(text).not.toContain("context_length_exceeded");
    expect(logCtx.upstreamError).toContain("Invalid JSON");
    expect(hosts).toEqual(["primary.example", "fallback.example"]);
  });

  test("context exhaustion retains diagnostics and charges each failed attempt once", async () => {
    const hosts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const host = new URL(input instanceof Request ? input.url : String(input)).host;
      hosts.push(host);
      return host.startsWith("primary")
        ? Response.json({ error: { message: "Please reduce the length of the messages or completion." } }, { status: 400 })
        : Response.json({ error: { message: "backup unavailable" } }, { status: 404 });
    }) as typeof fetch;
    const logCtx = { model: "", provider: "" } as RequestLogContext;
    const response = await loggedCombo(config, logCtx, createRequestExecutionBudget());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "context_length_exceeded" } });
    expect(hosts).toEqual(["primary.example", "fallback.example"]);
    expect(logCtx.upstreamError).toContain("Please reduce the length");
    expect(logCtx.attempts).toMatchObject([
      { provider: "primary", status: 400, sendCount: 1 },
      { provider: "fallback", status: 404, sendCount: 1 },
    ]);
    expect(logCtx.attempts).toHaveLength(2);
  });

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

  test("the hop warning names the upstream refusal on one redacted line", async () => {
    const key = "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
    globalThis.fetch = (async () => Response.json(
      { error: { code: "invalid_api_key", message: `Incorrect API key provided: ${key}.\nRotate it.` } },
      { status: 401 },
    )) as unknown as typeof fetch;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loggedCombo(config, { model: "", provider: "" });
      const line = warn.mock.calls.map(call => String(call[0])).find(text => text.includes("primary/model-primary failed with"));
      expect(line).toMatch(/failed with 401 after \d+ms: invalid_api_key: Incorrect API key provided: .* Rotate it\.$/);
      expect(line).not.toContain(key);
    } finally {
      warn.mockRestore();
    }
  });

  test("the hop warning redacts credential framing before flattening parsed codes", async () => {
    const credential = "synthetic-multipart-credential";
    globalThis.fetch = (async () => Response.json({ error: {
      code: `name="authorization"\r\n\r\n${credential}`,
      message: "upstream refused",
    } }, { status: 502 })) as unknown as typeof fetch;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loggedCombo(config, { model: "", provider: "" });
      const line = warn.mock.calls.map(call => String(call[0])).find(text => text.includes("primary/model-primary failed with"));
      expect(line).toBeDefined();
      expect(line!.includes(credential)).toBe(false);
      expect(line).toContain("[REDACTED]");
      expect(line).not.toMatch(/[\r\n]/);
    } finally { warn.mockRestore(); }
  });

  test("the hop warning never logs an unparsed upstream body", async () => {
    globalThis.fetch = (async () => new Response("upstream said: session=abc123 private detail", { status: 502 })) as unknown as typeof fetch;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loggedCombo(config, { model: "", provider: "" });
      const line = warn.mock.calls.map(call => String(call[0])).find(text => text.includes("primary/model-primary failed with"));
      expect(line).toMatch(/failed with 502 after \d+ms$/);
    } finally {
      warn.mockRestore();
    }
  });

  test("a fallback 5xx is still the answer", async () => {
    upstream(502, "bad gateway");
    const response = await handleResponses(request(), config, { model: "", provider: "" } as RequestLogContext);
    expect(response.status).toBe(502);
  });
});

describe("zero-attempt combo refusal names why each target was excluded", () => {
  afterEach(() => clearCachedProviderQuotas());

  test("missing, disabled, quota-spent, cooling and request-ineligible targets each carry a reason", async () => {
    setCachedProviderQuotaForTests("spent", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
    coolComboTarget("all", { provider: "cooling", model: "model-cooling" }, { retryAfter: "42", status: 429 });
    const cfg = {
      defaultProvider: "spent",
      providers: {
        off: { ...provider("off"), disabled: true },
        spent: provider("spent"),
        cooling: provider("cooling"),
        metered: provider("metered"),
      },
      combos: {
        all: {
          strategy: "failover",
          targets: [
            { provider: "gone", model: "model-gone" },
            { provider: "off", model: "model-off" },
            { provider: "spent", model: "model-spent" },
            { provider: "cooling", model: "model-cooling" },
            { provider: "metered", model: "model-metered", metered: true },
          ],
        },
      },
    } as unknown as OcxConfig;
    globalThis.fetch = (async () => { throw new Error("no target may be dispatched"); }) as unknown as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/all", stream: false, input: "hello" }),
    }), cfg, { model: "", provider: "" } as RequestLogContext);
    expect(response.status).toBe(503);
    const { error } = await response.json() as { error: { code: string; message: string } };
    expect(error.code).toBe("combo_unavailable");
    expect(error.message).toMatch(/^No available targets for combo: all \(gone\/model-gone: provider missing; off\/model-off: provider disabled; spent\/model-spent: quota exhausted; cooling\/model-cooling: cooldown 4[12]s; metered\/model-metered: ineligible for this request\)$/);
  });
});
