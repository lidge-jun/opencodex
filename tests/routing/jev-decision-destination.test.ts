import { describe, expect, test } from "bun:test";
import {
  JEV_API_URL,
  resolveJevDecision,
  resolveJevDecisionDestination,
  type JevCandidate,
} from "../../src/combos/jev";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { OcxConfig } from "../../src/types";

const OPENCODE_JEV_URL = "https://opencode.ai/zen/v1/systemone";

const candidates: JevCandidate[] = [
  { key: "openai/gpt-6-astra", provider: "openai", model: "gpt-6-astra", reasoningEfforts: ["high"] },
  {
    key: "opencode-go/mimo-v2.6-pro",
    provider: "opencode-go",
    model: "mimo-v2.6-pro",
    reasoningEfforts: ["high"],
  },
];

const openaiRow = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
};
const typesafeRow = {
  adapter: "jev-decision",
  baseUrl: JEV_API_URL,
  authMode: "key",
  apiKey: "typesafe-secret",
};
const opencodeRow = {
  adapter: "jev-decision",
  baseUrl: OPENCODE_JEV_URL,
  authMode: "key",
  apiKey: "opencode-secret",
};

const configWith = (providers: Record<string, unknown>): OcxConfig =>
  ({ providers: { openai: openaiRow, ...providers } }) as unknown as OcxConfig;

describe("JEV decision destination", () => {
  test("keeps the TypeSafe row in front when both decision providers are configured", () => {
    const destination = resolveJevDecisionDestination(configWith({ jev: typesafeRow, "jev-opencode": opencodeRow }));
    expect(destination).toEqual({
      providerId: "jev",
      baseUrl: JEV_API_URL,
      model: "jev-latest",
      apiKey: "typesafe-secret",
    });
  });

  test("routes to a reseller row when it is the only configured decision provider", () => {
    const destination = resolveJevDecisionDestination(configWith({ "jev-opencode": opencodeRow }));
    expect(destination).toEqual({
      providerId: "jev-opencode",
      baseUrl: OPENCODE_JEV_URL,
      model: "jev-1.13-free",
      apiKey: "opencode-secret",
    });
  });

  test("skips a decision row that cannot resolve a credential", () => {
    const destination = resolveJevDecisionDestination(configWith({
      jev: { adapter: "jev-decision", baseUrl: JEV_API_URL, authMode: "key" },
      "jev-opencode": opencodeRow,
    }));
    expect(destination?.providerId).toBe("jev-opencode");
  });

  test("skips a disabled decision row", () => {
    const destination = resolveJevDecisionDestination(configWith({
      jev: { ...typesafeRow, disabled: true },
      "jev-opencode": opencodeRow,
    }));
    expect(destination?.providerId).toBe("jev-opencode");
  });

  test("reports no destination when only non-decision providers are configured", () => {
    expect(resolveJevDecisionDestination(configWith({}))).toBeNull();
  });

  test("sends the decision to the selected destination and applies its answer", async () => {
    const posted: Array<{ name: string; url: string; provider: { baseUrl?: string }; body: { model?: string } }> = [];
    const post = (async (name: string, provider: { baseUrl?: string }, url: string, init: { body: string }) => {
      posted.push({ name, url, provider, body: JSON.parse(init.body) as { model?: string } });
      return Response.json({
        model: "jev-1.13-free",
        answers: {
          route: {
            type: "choice",
            choice: "openai/gpt-6-astra:high",
            confidence: 0.9,
            probabilities: {
              "openai/gpt-6-astra:high": 0.9,
              "opencode-go/mimo-v2.6-pro:high": 0.1,
            },
          },
        },
        usage: { input_tokens: 12, output_tokens: 4 },
      });
    }) as never;

    const decision = await resolveJevDecision({
      body: { input: "choose a target" },
      candidates,
      fallback: { targetKey: candidates[0]!.key, effort: null },
      config: configWith({ "jev-opencode": opencodeRow }),
      post,
    });

    expect(decision.gate).toBe("apply");
    expect(decision.targetKey).toBe("openai/gpt-6-astra");
    expect(decision.effort).toBe("high");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.name).toBe("jev-opencode");
    expect(posted[0]!.url).toBe(OPENCODE_JEV_URL);
    // The transport row must point at the destination actually used.
    expect(posted[0]!.provider.baseUrl).toBe(OPENCODE_JEV_URL);
    // The registry owns the reseller's model id; the TypeSafe alias is not servable there.
    expect(posted[0]!.body.model).toBe("jev-1.13-free");
  });

  test("fails closed without a decision credential and never goes outbound", async () => {
    let calls = 0;
    const post = (async () => {
      calls += 1;
      return Response.json({});
    }) as never;

    const decision = await resolveJevDecision({
      body: { input: "choose a target" },
      candidates,
      fallback: { targetKey: candidates[0]!.key, effort: null },
      config: configWith({
        "jev-opencode": { adapter: "jev-decision", baseUrl: OPENCODE_JEV_URL, authMode: "key" },
      }),
      post,
    });

    expect(decision.gate).toBe("missing_key");
    expect(calls).toBe(0);
  });
});

describe("OpenCode JEV provider preset", () => {
  test("is a credential-only decision destination that publishes no routable model", () => {
    const entry = getProviderRegistryEntry("jev-opencode");
    expect(entry).toMatchObject({
      id: "jev-opencode",
      label: "OpenCode JEV",
      adapter: "jev-decision",
      authKind: "key",
      credentialOnly: true,
      baseUrl: OPENCODE_JEV_URL,
      dashboardUrl: "https://opencode.ai/auth",
      liveModels: false,
      preserveCustomDestination: true,
      apiKeyValidation: "unknown",
      defaultModel: "jev-1.13-free",
    });
    expect(entry?.models).toBeUndefined();
    expect(entry?.freeTier).not.toBe(true);
  });
});
