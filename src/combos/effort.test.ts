import { describe, expect, test } from "bun:test";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { applyComboDefaultEffort } from "./effort";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.com",
    authMode: "key",
    apiKeyEnv: "K",
    ...overrides,
  } as OcxProviderConfig;
}

function cfg(combo: Record<string, unknown>, providers: OcxProviderConfig[] = [provider()]): OcxConfig {
  return {
    port: 1455,
    host: "127.0.0.1",
    providers,
    routing: {},
    aliases: {},
    multiAgentMode: "v2",
    combos: {
      team: {
        id: "team",
        strategy: "failover",
        targets: [{ provider: "p", model: "m" }],
        ...combo,
      },
    },
  } as unknown as OcxConfig;
}

function parsed(effort?: string): OcxParsedRequest {
  return {
    modelId: "combo/team",
    input: [],
    context: [],
    stream: false,
    options: { reasoning: effort },
    _rawBody: effort ? { model: "combo/team", reasoning: { effort } } : { model: "combo/team" },
  } as unknown as OcxParsedRequest;
}

describe("applyComboDefaultEffort", () => {
  test("skips when model has no reasoning ladder (empty / noReasoning)", () => {
    const p = provider({ noReasoningModels: ["m"] });
    const c = cfg({}, [p]);
    const req = parsed();
    expect(applyComboDefaultEffort(req, c, "team", { provider: p, modelId: "m" })).toBeNull();
    expect(req.options.reasoning).toBeUndefined();
  });

  test("skips when ladder is unknown (no reasoningEfforts configured)", () => {
    const p = provider();
    const c = cfg({}, [p]);
    const req = parsed();
    expect(applyComboDefaultEffort(req, c, "team", { provider: p, modelId: "m" })).toBeNull();
    expect(req.options.reasoning).toBeUndefined();
  });

  test("applies default medium when ladder supports it", () => {
    const p = provider({ reasoningEfforts: ["low", "medium", "high"] });
    const c = cfg({}, [p]);
    const req = parsed();
    expect(applyComboDefaultEffort(req, c, "team", { provider: p, modelId: "m" })).toBe("medium");
    expect(req.options.reasoning).toBe("medium");
  });

  test("clamps default down to highest supported rung", () => {
    const p = provider({ reasoningEfforts: ["minimal", "low"] });
    const c = cfg({ defaultEffort: "high" }, [p]);
    const req = parsed();
    expect(applyComboDefaultEffort(req, c, "team", { provider: p, modelId: "m" })).toBe("low");
    expect(req.options.reasoning).toBe("low");
  });

  test("does not override client-sent effort", () => {
    const p = provider({ reasoningEfforts: ["low", "medium", "high"] });
    const c = cfg({ defaultEffort: "high" }, [p]);
    const req = parsed("low");
    expect(applyComboDefaultEffort(req, c, "team", { provider: p, modelId: "m" })).toBeNull();
    expect(req.options.reasoning).toBe("low");
  });

  test("skips when every supported rung sits above the default (cannot lower)", () => {
    // Cap resolution strips when no rung ≤ desired — treat as cannot apply default.
    const p = provider({ reasoningEfforts: ["high", "xhigh"] });
    const c = cfg({ defaultEffort: "low" }, [p]);
    const req = parsed();
    expect(applyComboDefaultEffort(req, c, "team", { provider: p, modelId: "m" })).toBeNull();
    expect(req.options.reasoning).toBeUndefined();
  });
});
