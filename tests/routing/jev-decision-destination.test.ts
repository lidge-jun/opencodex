import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

const fallback = { targetKey: candidates[0]!.key, effort: null };
const validPayload = {
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
};

/*
 * The ambient environment decides whether an environment-key path exists at all — a developer
 * shell with TYPESAFE_API_KEY exported would otherwise turn a missing-credential assertion into a
 * passing outbound call — so every case runs with both variables removed and restores them after.
 */
const ENV_KEYS = ["TYPESAFE_API_KEY", "JEV_API_KEY"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const setEnvironmentKey = (key: "TYPESAFE_API_KEY" | "JEV_API_KEY", value: string) => {
  for (const name of ENV_KEYS) delete process.env[name];
  process.env[key] = value;
};

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

  test("skips a decision row that cannot resolve a credential in favour of one that can", () => {
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

  test("uses the environment credential for the official TypeSafe destination when no jev row exists", () => {
    setEnvironmentKey("TYPESAFE_API_KEY", "environment-secret");
    expect(resolveJevDecisionDestination(configWith({}))).toEqual({
      providerId: "jev",
      baseUrl: JEV_API_URL,
      model: "jev-latest",
      apiKey: "environment-secret",
    });
  });

  test("never sends an environment credential to a destination other than TypeSafe", async () => {
    setEnvironmentKey("TYPESAFE_API_KEY", "environment-secret");
    // A keyless reseller row must not borrow the TypeSafe credential. The environment-only shape
    // still resolves, but to the official destination the credential belongs to.
    const keylessReseller = configWith({
      "jev-opencode": { adapter: "jev-decision", baseUrl: OPENCODE_JEV_URL, authMode: "key" },
    });
    expect(resolveJevDecisionDestination(keylessReseller)?.baseUrl).toBe(JEV_API_URL);
    // A retargeted `jev` row has no legacy shape to fall back to: its own address is not official.
    expect(resolveJevDecisionDestination(configWith({
      jev: { adapter: "jev-decision", baseUrl: OPENCODE_JEV_URL, authMode: "key" },
    }))).toBeNull();

    const posted: Array<{ url: string; auth: string | null }> = [];
    const post = (async (_name: string, _provider: unknown, url: string, init: { headers: Record<string, string> }) => {
      posted.push({ url, auth: new Headers(init.headers).get("authorization") });
      return Response.json(validPayload);
    }) as never;
    await resolveJevDecision({ body: { input: "choose a target" }, candidates, fallback, config: keylessReseller, post });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(JEV_API_URL);
    expect(posted[0]!.auth).toBe("Bearer environment-secret");
  });

  test("keeps a configured jev row's own key at a retargeted destination", () => {
    setEnvironmentKey("TYPESAFE_API_KEY", "environment-secret");
    const destination = resolveJevDecisionDestination(configWith({
      jev: { adapter: "jev-decision", baseUrl: OPENCODE_JEV_URL, authMode: "key", apiKey: "row-secret" },
    }));
    expect(destination).toEqual({
      providerId: "jev",
      baseUrl: OPENCODE_JEV_URL,
      model: "jev-latest",
      apiKey: "row-secret",
    });
  });

  test("does not resurrect a disabled jev row through the environment", () => {
    setEnvironmentKey("JEV_API_KEY", "environment-secret");
    expect(resolveJevDecisionDestination(configWith({ jev: { ...typesafeRow, disabled: true } }))).toBeNull();
    // A keyless enabled `jev` row at the official destination keeps the pre-existing meaning of the
    // environment credential, so the disabled case above must not be read as "keyless rows are out".
    expect(resolveJevDecisionDestination(configWith({
      jev: { adapter: "jev-decision", baseUrl: JEV_API_URL, authMode: "key" },
    }))?.apiKey).toBe("environment-secret");
  });

  test("sends the decision to the selected destination and applies its answer", async () => {
    const posted: Array<{ name: string; url: string; provider: { baseUrl?: string }; body: { model?: string } }> = [];
    const post = (async (name: string, provider: { baseUrl?: string }, url: string, init: { body: string }) => {
      posted.push({ name, url, provider, body: JSON.parse(init.body) as { model?: string } });
      return Response.json(validPayload);
    }) as never;

    const decision = await resolveJevDecision({
      body: { input: "choose a target" },
      candidates,
      fallback,
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

  test("posts the environment-only legacy path to TypeSafe", async () => {
    setEnvironmentKey("TYPESAFE_API_KEY", "environment-secret");
    const posted: Array<{ url: string; auth: string | null }> = [];
    const post = (async (_name: string, _provider: unknown, url: string, init: { headers: Record<string, string> }) => {
      posted.push({ url, auth: new Headers(init.headers).get("authorization") });
      return Response.json(validPayload);
    }) as never;

    const decision = await resolveJevDecision({
      body: { input: "choose a target" },
      candidates,
      fallback,
      config: configWith({}),
      post,
    });

    expect(decision.gate).toBe("apply");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(JEV_API_URL);
    expect(posted[0]!.auth).toBe("Bearer environment-secret");
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
      fallback,
      config: configWith({
        "jev-opencode": { adapter: "jev-decision", baseUrl: OPENCODE_JEV_URL, authMode: "key" },
      }),
      post,
    });

    expect(decision.gate).toBe("missing_key");
    expect(calls).toBe(0);
  });

  test("fails closed for a disabled jev row even with an environment credential present", async () => {
    setEnvironmentKey("JEV_API_KEY", "environment-secret");
    let calls = 0;
    const post = (async () => {
      calls += 1;
      return Response.json(validPayload);
    }) as never;

    const decision = await resolveJevDecision({
      body: { input: "choose a target" },
      candidates,
      fallback,
      config: configWith({ jev: { ...typesafeRow, disabled: true } }),
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
