// Carried from PR #6185 by yxr1995-maker and PR #6275 by codingbooo.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  JEV_API_URL,
  JEV_MODEL,
  resolveJevDecision,
  type JevCandidate,
  type ResolveJevDecisionOptions,
} from "../../src/combos/jev";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

type JevPost = NonNullable<ResolveJevDecisionOptions["post"]>;
const CUSTOM_URL = "https://decider.example/v1/decisions";
const ENV_SECRETS = {
  TYPESAFE_API_KEY: "typesafe-environment-secret",
  JEV_API_KEY: "jev-environment-secret",
};
const ENV_KEYS = ["TYPESAFE_API_KEY", "JEV_API_KEY"] as const;
let savedEnv: Partial<Record<typeof ENV_KEYS[number], string>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    process.env[key] = ENV_SECRETS[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const candidates: JevCandidate[] = [
  { key: "openai/gpt-6-astra", provider: "openai", model: "gpt-6-astra", reasoningEfforts: ["high"] },
  { key: "openai/gpt-5.6-sol", provider: "openai", model: "gpt-5.6-sol", reasoningEfforts: ["low"] },
];
const fallback = { targetKey: candidates[0]!.key, effort: "high" as const };
const validPayload = {
  answers: { route: { choice: "openai/gpt-5.6-sol:low", confidence: 0.9 } },
};
const customRow: OcxProviderConfig = {
  adapter: "jev-decision",
  baseUrl: CUSTOM_URL,
  defaultModel: "tev1:4b",
  apiKey: "custom-secret",
};

function configWith(providerId: string, row: OcxProviderConfig): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
      [providerId]: row,
    },
  };
}

function recordingPost() {
  const calls: Array<{
    name: string;
    url: string;
    init: Parameters<JevPost>[3];
  }> = [];
  const post: JevPost = async (name, _provider, url, init) => {
    calls.push({ name, url, init });
    return Response.json(validPayload);
  };
  return { calls, post };
}

function expectNoTypeSafeSecrets(init: Parameters<JevPost>[3]) {
  const transmitted = JSON.stringify({
    headers: Array.from(new Headers(init.headers).entries()),
    body: String(init.body),
  });
  for (const secret of Object.values(ENV_SECRETS)) expect(transmitted).not.toContain(secret);
}

describe("JEV decision destination credential ownership", () => {
  test("an incompatible selected adapter never sends or falls back to TypeSafe", async () => {
    const row: OcxProviderConfig = { ...customRow, adapter: "openai-chat" };
    const { calls, post } = recordingPost();
    expect(await resolveJevDecision({
      body: { input: "Choose a target." }, candidates, fallback,
      config: configWith("custom-decider", row), decisionProvider: "custom-decider", post,
    })).toMatchObject({ ...fallback, gate: "missing_key" });
    expect(calls).toHaveLength(0);
  });

  test.each(["oauth", "local", "forward"] as const)("authMode %s sends only the row's own key to its own endpoint", async (authMode) => {
    const { calls, post } = recordingPost();
    expect((await resolveJevDecision({
      body: { input: "Choose a target." }, candidates, fallback,
      config: configWith("custom-decider", { ...customRow, authMode }), decisionProvider: "custom-decider", post,
    })).gate).toBe("apply");
    expect(calls.map(call => call.url)).toEqual([CUSTOM_URL]);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer custom-secret");
    expectNoTypeSafeSecrets(calls[0]!.init);
  });

  test.each([
    [`${CUSTOM_URL}/`, `${CUSTOM_URL}/`],
    ["https://decider.example/v1/systemone/", "https://decider.example/v1/systemone"],
  ])("baseUrl %s is sent to %s", async (baseUrl, expected) => {
    const { calls, post } = recordingPost();
    await resolveJevDecision({
      body: { input: "Choose a target." }, candidates, fallback,
      config: configWith("custom-decider", { ...customRow, baseUrl }), decisionProvider: "custom-decider", post,
    });
    expect(calls.map(call => call.url)).toEqual([expected]);
  });

  test.each(["https:\t//@decider.example/v1/decisions", "https://decider.example/v1/decisions?", "https://:@decider.example/v1/decisions"])(
    "baseUrl %j with a stripped delimiter never sends",
    async (baseUrl) => {
      const { calls, post } = recordingPost();
      expect(await resolveJevDecision({
        body: { input: "Choose a target." }, candidates, fallback,
        config: configWith("custom-decider", { ...customRow, baseUrl }), decisionProvider: "custom-decider", post,
      })).toMatchObject({ ...fallback, gate: "missing_key" });
      expect(calls).toHaveLength(0);
    },
  );

  test("a custom HTTPS path preserves caller cancellation by identity", async () => {
    const controller = new AbortController();
    const reason = new DOMException("caller stopped", "AbortError");
    const post: JevPost = async (_name, _provider, url, init) => {
      expect(url).toBe(CUSTOM_URL);
      controller.abort(reason);
      throw init.signal?.reason;
    };
    await expect(resolveJevDecision({
      body: { input: "Choose a target." }, candidates, fallback,
      config: configWith("custom-decider", customRow), decisionProvider: "custom-decider", post, signal: controller.signal,
    })).rejects.toBe(reason);
  });

  for (const apiKey of ["custom-secret", undefined]) {
    test(`self-hosted row with ${apiKey ? "its own key" : "no key"} never borrows TypeSafe environment secrets`, async () => {
      const { calls, post } = recordingPost();
      const decision = await resolveJevDecision({
        body: { input: "Choose a target." },
        candidates,
        fallback,
        config: configWith("custom-decider", { ...customRow, apiKey }),
        decisionProvider: "custom-decider",
        post,
      });

      expect(decision.gate).toBe("apply");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(CUSTOM_URL);
      expect(new Headers(calls[0]!.init.headers).get("authorization"))
        .toBe(apiKey ? `Bearer ${apiKey}` : null);
      expectNoTypeSafeSecrets(calls[0]!.init);
    });
  }

  for (const apiKey of ["${TYPESAFE_API_KEY}", "$JEV_API_KEY"]) {
    test(`self-hosted row refuses the reserved credential reference ${apiKey}`, async () => {
      const { calls, post } = recordingPost();
      const decision = await resolveJevDecision({
        body: { input: "Choose a target." },
        candidates,
        fallback,
        config: configWith("custom-decider", { ...customRow, apiKey }),
        decisionProvider: "custom-decider",
        post,
      });

      expect(decision.gate).toBe("missing_key");
      expect(decision.targetKey).toBe(fallback.targetKey);
      expect(calls).toHaveLength(0);
    });
  }

  test("a jev row with a foreign baseUrl still posts to TypeSafe", async () => {
    const { calls, post } = recordingPost();
    const decision = await resolveJevDecision({
      body: { input: "Choose a target." },
      candidates,
      fallback,
      config: configWith("jev", customRow),
      post,
    });

    expect(decision.gate).toBe("apply");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("jev");
    expect(calls[0]!.url).toBe(JEV_API_URL);
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe(JEV_MODEL);
    expect(new Headers(calls[0]!.init.headers).get("authorization"))
      .toBe(`Bearer ${ENV_SECRETS.TYPESAFE_API_KEY}`);
  });

  test("#6275: an explicitly selected custom decider uses its own URL, model and bearer", async () => {
    const { calls, post } = recordingPost();
    const decision = await resolveJevDecision({
      body: { input: "Choose a target." },
      candidates,
      fallback,
      config: configWith("custom-decider", customRow),
      decisionProvider: "custom-decider",
      post,
    });

    expect(decision.gate).toBe("apply");
    expect(decision.targetKey).toBe("openai/gpt-5.6-sol");
    expect(decision.effort).toBe("low");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("custom-decider");
    expect(calls[0]!.url).toBe(CUSTOM_URL);
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe("tev1:4b");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer custom-secret");
    expectNoTypeSafeSecrets(calls[0]!.init);
  });
});
