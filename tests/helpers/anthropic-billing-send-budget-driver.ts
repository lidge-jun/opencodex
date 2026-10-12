// Imported only by the isolated billing dispatch child to contain module fixtures.
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { describe, expect, mock, test } from "bun:test";
import * as keys from "../../src/providers/key-failover";
import { routedProviderConfig } from "../../src/router";
import { anthropicBillingPhysicalFetch } from "../../src/providers/anthropic-billing-ownership";
import { markEgressTransparentExecutor } from "../../src/lib/provider-egress";
import {
  createRequestExecutionBudget,
  CODEX_TEXT_GUARDED_BUDGET_POLICY,
} from "../../src/lib/request-execution-budget";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { budgetOwner } from "./send-budget-owner";

// Retain real retry policies and billing evidence/ownership. Replace only key selection's
// persistent side effect; each fixture advances its own roster synchronously in memory.
const rotate = (config: OcxConfig, name: string, prior: OcxProviderConfig) => {
  const pool = config.providers[name]!.apiKeyPool!;
  const index = pool.findIndex(entry => entry.key === prior.apiKey);
  if (index + 1 >= pool.length) return null;
  config.providers[name] = {
    ...config.providers[name]!,
    apiKey: pool[index + 1]!.key,
    apiKeySelectionRevision: String(index + 1),
  };
  return {
    ...routedProviderConfig(name, config.providers[name]),
    fetch: prior.fetch,
  };
};
mock.module("../../src/providers/key-failover", () => ({
  ...keys,
  rotateProviderTransportOn401: rotate,
  rotateProviderTransportOn429: rotate,
  rotateProviderTransportOnAnthropicBilling: rotate,
}));
const { prepareAdapterExchange } = await import("../../src/server/responses/adapter-dispatch");

const creditMessage = "Your credit balance is too low to access the Anthropic API.";
const terminalImageMessage = "fixture terminal image 413 from B";
const refusal = (status: number, message: string) => Response.json({
  type: "error",
  error: {
    type: status === 401 ? "authentication_error"
      : status === 429 ? "rate_limit_error"
      : status === 413 ? "request_too_large"
      : "invalid_request_error",
    message,
  },
}, { status });

async function probe(firstStatus: 401 | 429 | 400) {
  const physicalSends: string[] = [];
  const physicalBodies: string[] = [];
  const transportFetch = markEgressTransparentExecutor((async (_url, init) => {
    // This transparent fixture is the final executor and must deliver its physical receipt.
    (init as Record<symbol, (() => void) | undefined> | undefined)?.[Symbol.for("opencodex.physical-dispatch")]?.();
    physicalSends.push(new Headers(init?.headers).get("x-api-key") ?? "");
    physicalBodies.push(String(init?.body));
    const index = physicalSends.length - 1;
    if (firstStatus === 400) {
      if (index === 0) return refusal(400, creditMessage);
      if (index === 1) return refusal(413, terminalImageMessage);
    } else {
      if (index === 0) return refusal(firstStatus, "fixture initial credential/rate refusal");
      if (index === 1) return refusal(400, creditMessage);
    }
    // A third send is an observable bug, even if its response also happens to be 400.
    return refusal(400, "fixture forbidden third send to C");
  }) as typeof fetch);
  const config = {
    providers: {
      anth: {
        adapter: "anthropic", authMode: "key", baseUrl: "https://example.test",
        apiKey: "probe-A",
        apiKeyPool: ["A", "B", "C"].map(id => ({ id, key: `probe-${id}` })),
      },
    },
  } as OcxConfig;
  const route = {
    providerName: "anth", modelId: "claude-x",
    provider: { ...routedProviderConfig("anth", config.providers.anth!), fetch: transportFetch },
  };
  const budget = createRequestExecutionBudget({
    ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
    maxTotalModelSends: 2, baseSendAllowance: 2, finalRecoveryAllowance: 0,
  });
  const productionOwner = budgetOwner(budget);
  const translatorBudget = createTranslatorBudget();
  const adapter = {
    name: "anthropic",
    buildRequest: async () => ({
      url: "https://example.test/v1/messages", method: "POST",
      headers: { "x-api-key": route.provider.apiKey },
      body: '{"hello":true}',
    }),
    parseStream: async function* () {},
  };
  type Transport = Parameters<typeof prepareAdapterExchange>[3];
  const transport: Partial<Transport> = {
    adapter, activeAdapter: adapter, transportToken: 0,
    invalidateSameTargetRequest: () => {
      transport.transportToken = (transport.transportToken ?? 0) + 1;
      transport.sameTargetRequest = undefined;
    },
    resolveSelectionAdapter: () => adapter,
    resolveCopilotSelection: async () => {},
    noteRoutedAttemptSend: () => {},
    // Preserve the real response-ownership fence at the executor, while avoiding HTTP
    // and endpoint admission that could conceal an observe-only accounting defect.
    oauthDispatch: () => async (input, init) =>
      anthropicBillingPhysicalFetch(transportFetch, "anth", route.provider)(input, init),
  };
  try {
    expect(budget.spendEnforced).not.toBe(true);
    const response = await prepareAdapterExchange({
      config,
      req: new Request("http://localhost/v1/responses"),
      logCtx: { model: "claude-x", provider: "anth" },
      options: {},
    } as Parameters<typeof prepareAdapterExchange>[0], { authCtx: {} } as Parameters<typeof prepareAdapterExchange>[1], {
      parsed: {
        stream: false, modelId: "claude-x", options: {},
        // This activates the existing real image-413 recovery gate in the third case.
        context: { messages: [{ role: "user", content: [{ imageUrl: "data:image/png;base64,AA==" }] }] },
      },
      toolBridgeMaps: {}, translatorBudget, route,
      inboundWire: "responses", clientRequestedStream: false,
    } as unknown as Parameters<typeof prepareAdapterExchange>[2], transport as Transport, {
      refreshRequestToolAliases: () => {},
      cancelResponseCompletion: () => {},
      notifyResponseComplete: () => {},
    }, productionOwner.owner);
    const body = await response.text();
    const result = {
      firstStatus, physicalSends, physicalBodies, used: budget.used,
      maxSends: budget.policy.maxTotalModelSends,
      status: response.status, body,
      pendingHopPermit: productionOwner.owner.pendingHopPermit,
    };
    return result;
  } finally {
    translatorBudget.dispose();
    productionOwner.dispose();
  }
}

describe("actual dispatch: observe-only Anthropic billing budget", () => {
  for (const status of [429, 401] as const) {
    test(`${status} -> billing 400 retains B at an exact two-send ceiling`, async () => {
      const result = await probe(status);
      expect(result.physicalSends).toEqual(["probe-A", "probe-B"]);
      expect(result.used).toBe(2);
      expect(result.used).toBe(result.physicalSends.length);
      expect(result.physicalBodies).toEqual(['{"hello":true}', '{"hello":true}']);
      expect(result.status).toBe(400);
      expect(result.body).toContain(creditMessage);
      expect(result.body).not.toContain("forbidden third send");
      expect(result.pendingHopPermit).toBeUndefined();
    });
  }

  test("billing 400 -> image 413 retains normal terminal 413 formatting at two sends", async () => {
    const result = await probe(400);
    expect(result.physicalSends).toEqual(["probe-A", "probe-B"]);
    expect(result.used).toBe(2);
    expect(result.used).toBe(result.physicalSends.length);
    expect(result.pendingHopPermit).toBeUndefined();
    // Direct non-streaming Responses normally formats upstream 413 as context overflow.
    // It must reach that terminal formatting, rather than cancel B and synthesize 429.
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body).error.code).toBe("context_length_exceeded");
    expect(result.body).not.toContain("send_budget_exhausted");
  });
});
