/**
 * Hard effort caps (devlog/260710_subagent_effort_intercept): sub-agent request
 * classification from codex-rs spawn markers, cap resolution, dual-shape rewrite,
 * and the /api/effort-caps management roundtrip.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEffortCap, effortCapAppliesTo, effortCapFor, isThreadSpawnRequest, resolveCappedEffort, supportedLadderFor } from "../src/server/effort-policy";
import { collabSurface } from "../src/server/responses";
import { handleManagementAPI } from "../src/server/management-api";
import { NoEnabledOpenAiProviderError, routeModel } from "../src/router";
import { mapReasoningEffort } from "../src/reasoning-effort";
import { nativeEffortClamp } from "../src/codex/catalog";
import type { OcxConfig, OcxParsedRequest } from "../src/types";

const savedHome = process.env.OPENCODEX_HOME;
const savedCodexHome = process.env.CODEX_HOME;
let tempHome: string | null = null;
let tempCodexHome: string | null = null;

afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedHome;
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  if (tempHome) { rmSync(tempHome, { recursive: true, force: true }); tempHome = null; }
  if (tempCodexHome) { rmSync(tempCodexHome, { recursive: true, force: true }); tempCodexHome = null; }
});

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...overrides } as OcxConfig;
}

function makeParsed(reasoning?: string): OcxParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    stream: true,
    options: reasoning ? { reasoning: reasoning as never } : {},
    _rawBody: { model: "gpt-5.6-sol", reasoning: reasoning ? { effort: reasoning, summary: "auto" } : undefined },
  };
}

const SUBAGENT_HEADERS = new Headers({ "x-openai-subagent": "collab_spawn" });
const TURN_META_HEADERS = new Headers({
  "x-codex-turn-metadata": JSON.stringify({ turn_id: "t1", subagent_kind: "thread_spawn" }),
});
const MAIN_HEADERS = new Headers({
  "x-codex-turn-metadata": JSON.stringify({ turn_id: "t1" }),
});

describe("isThreadSpawnRequest", () => {
  test("x-openai-subagent: collab_spawn classifies as spawned child", () => {
    expect(isThreadSpawnRequest(SUBAGENT_HEADERS)).toBe(true);
  });

  test("subagent_kind: thread_spawn inside x-codex-turn-metadata classifies as spawned child", () => {
    expect(isThreadSpawnRequest(TURN_META_HEADERS)).toBe(true);
  });

  test("main-agent turn metadata and bare headers stay main", () => {
    expect(isThreadSpawnRequest(MAIN_HEADERS)).toBe(false);
    expect(isThreadSpawnRequest(new Headers())).toBe(false);
  });

  test("non-spawn subagent categories never classify as spawned children", () => {
    // Upstream emits x-openai-subagent for review/compact/memory-consolidation/"other"
    // maintenance turns too (responses_metadata.rs) — only collab_spawn is a child.
    for (const kind of ["review", "compact", "memory_consolidation", "other", "anything"]) {
      expect(isThreadSpawnRequest(new Headers({ "x-openai-subagent": kind }))).toBe(false);
      const meta = new Headers({ "x-codex-turn-metadata": JSON.stringify({ subagent_kind: kind }) });
      expect(isThreadSpawnRequest(meta)).toBe(false);
    }
  });

  test("malformed turn metadata never classifies as spawned child", () => {
    expect(isThreadSpawnRequest(new Headers({ "x-codex-turn-metadata": "{not json" }))).toBe(false);
    expect(isThreadSpawnRequest(new Headers({ "x-codex-turn-metadata": JSON.stringify({ subagent_kind: 42 }) }))).toBe(false);
  });
});

describe("effortCapFor", () => {
  test("subagent cap applies only to sub-agents; lower of both caps wins", () => {
    const config = makeConfig({ effortCap: "high", subagentEffortCap: "medium" });
    expect(effortCapFor(config, false)).toBe("high");
    expect(effortCapFor(config, true)).toBe("medium");
  });

  test("global cap lower than subagent cap wins for sub-agents too", () => {
    const config = makeConfig({ effortCap: "low", subagentEffortCap: "high" });
    expect(effortCapFor(config, true)).toBe("low");
  });

  test("no caps or invalid ladder values -> undefined", () => {
    expect(effortCapFor(makeConfig(), true)).toBeUndefined();
    expect(effortCapFor(makeConfig({ effortCap: "banana" }), false)).toBeUndefined();
  });
});

describe("applyEffortCap", () => {
  test("caps a sub-agent max turn to the subagent ceiling in BOTH shapes", () => {
    const config = makeConfig({ subagentEffortCap: "high" });
    const parsed = makeParsed("max");
    const applied = applyEffortCap(parsed, SUBAGENT_HEADERS, config);
    expect(applied).toEqual({ from: "max", to: "high", subagent: true });
    expect(parsed.options.reasoning).toBe("high");
    expect((parsed._rawBody as { reasoning: { effort: string } }).reasoning.effort).toBe("high");
  });

  test("main-agent turn passes a subagent-only cap untouched", () => {
    const config = makeConfig({ subagentEffortCap: "high" });
    const parsed = makeParsed("max");
    expect(applyEffortCap(parsed, MAIN_HEADERS, config)).toBeNull();
    expect(parsed.options.reasoning).toBe("max");
  });

  test("global cap lowers main-agent turns (ultra arrives as max)", () => {
    const config = makeConfig({ effortCap: "high" });
    const parsed = makeParsed("max");
    expect(applyEffortCap(parsed, new Headers(), config)).toEqual({ from: "max", to: "high", subagent: false });
    expect(parsed.options.reasoning).toBe("high");
  });

  test("efforts at or below the cap and absent efforts pass through", () => {
    const config = makeConfig({ effortCap: "high", subagentEffortCap: "high" });
    const low = makeParsed("medium");
    expect(applyEffortCap(low, SUBAGENT_HEADERS, config)).toBeNull();
    expect(low.options.reasoning).toBe("medium");
    const none = makeParsed(undefined);
    expect(applyEffortCap(none, SUBAGENT_HEADERS, config)).toBeNull();
    expect(none.options.reasoning).toBeUndefined();
  });

  test("raw body without a reasoning object is tolerated", () => {
    const config = makeConfig({ effortCap: "medium" });
    const parsed = makeParsed("max");
    (parsed._rawBody as { reasoning?: unknown }).reasoning = undefined;
    expect(applyEffortCap(parsed, new Headers(), config)).toEqual({ from: "max", to: "medium", subagent: false });
    expect(parsed.options.reasoning).toBe("medium");
  });
});

describe("resolveCappedEffort (ladder-aware resolution)", () => {
  test("undefined ladder -> cap as-is", () => {
    expect(resolveCappedEffort("high", undefined)).toBe("high");
  });

  test("cap already in the ladder -> cap", () => {
    expect(resolveCappedEffort("high", ["low", "medium", "high"])).toBe("high");
  });

  test("cap absent -> snap DOWN to highest rung at or below (high -> medium)", () => {
    expect(resolveCappedEffort("high", ["low", "medium", "xhigh"])).toBe("medium");
  });

  test("cap unfulfillable (all rankable rungs above cap) -> strip, never raise", () => {
    expect(resolveCappedEffort("medium", ["xhigh"])).toBeNull();
    expect(resolveCappedEffort("low", ["medium", "high", "max"])).toBeNull();
  });

  test("empty ladder (no effort control) -> strip", () => {
    expect(resolveCappedEffort("high", [])).toBeNull();
  });

  test("non-rankable-only ladder (e.g. thinking toggle) -> unknown, cap as-is", () => {
    expect(resolveCappedEffort("high", ["enabled"])).toBe("high");
  });

  test("mixed rankable/non-rankable ladder ranks only Codex rungs", () => {
    expect(resolveCappedEffort("high", ["enabled", "medium", "default"])).toBe("medium");
  });
});

describe("applyEffortCap strip paths", () => {
  test("no-effort model strips even a below-cap effort from BOTH shapes, keeping summary", () => {
    const config = makeConfig({ effortCap: "high" });
    const parsed = makeParsed("low");
    const applied = applyEffortCap(parsed, new Headers(), config, []);
    expect(applied).toEqual({ from: "low", to: "none", subagent: false });
    expect(parsed.options.reasoning).toBeUndefined();
    const raw = parsed._rawBody as { reasoning: { effort?: string; summary?: string } };
    expect(raw.reasoning.effort).toBeUndefined();
    expect(raw.reasoning.summary).toBe("auto");
  });

  test("cap-unfulfillable ladder strips instead of raising (cap medium, ladder [xhigh])", () => {
    const config = makeConfig({ subagentEffortCap: "medium" });
    const parsed = makeParsed("max");
    const applied = applyEffortCap(parsed, SUBAGENT_HEADERS, config, ["xhigh"]);
    expect(applied).toEqual({ from: "max", to: "none", subagent: true });
    expect(parsed.options.reasoning).toBeUndefined();
  });

  test("strip with no incoming effort is a silent no-op", () => {
    const config = makeConfig({ effortCap: "high" });
    const parsed = makeParsed(undefined);
    expect(applyEffortCap(parsed, new Headers(), config, [])).toBeNull();
  });

  test("snap-down applies through applyEffortCap and stays only-lowering", () => {
    const config = makeConfig({ effortCap: "high" });
    const ladder = ["low", "medium", "xhigh"];
    const capped = makeParsed("max");
    expect(applyEffortCap(capped, new Headers(), config, ladder)).toEqual({ from: "max", to: "medium", subagent: false });
    const below = makeParsed("low");
    expect(applyEffortCap(below, new Headers(), config, ladder)).toBeNull();
    expect(below.options.reasoning).toBe("low");
  });
});

describe("supportedLadderFor (real routeModel routes)", () => {
  test("registry-merged provider ladder is visible from a minimal persisted config", () => {
    // Persisted config carries NO ladder metadata; the registry seeds xai's
    // modelReasoningEfforts for grok-4.5 and noReasoningModels for the fast models.
    const config = makeConfig({
      providers: { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" } },
    } as Partial<OcxConfig>);
    const route = routeModel(config, "xai/grok-4.5");
    expect(supportedLadderFor(route)).toEqual(["low", "medium", "high"]);
    const noReasoning = routeModel(config, "xai/grok-composer-2.5-fast");
    expect(supportedLadderFor(noReasoning)).toEqual([]);
  });

  test("bare id routed via defaultModel resolves the ROUTED provider ladder", () => {
    const config = makeConfig({
      providers: {
        custom: {
          adapter: "openai-chat", baseUrl: "https://example.com/v1", apiKey: "k",
          defaultModel: "my-model", modelReasoningEfforts: { "my-model": ["low", "medium"] },
        },
      },
      defaultProvider: "custom",
    } as Partial<OcxConfig>);
    const route = routeModel(config, "my-model");
    expect(route.providerName).toBe("custom");
    expect(supportedLadderFor(route)).toEqual(["low", "medium"]);
  });

  test("raw non-rankable ladder (['enabled']) stays UNKNOWN, never strip", () => {
    const config = makeConfig({
      providers: {
        toggle: {
          adapter: "openai-chat", baseUrl: "https://example.com/v1", apiKey: "k",
          defaultModel: "t-model", modelReasoningEfforts: { "t-model": ["enabled"] },
        },
      },
      defaultProvider: "toggle",
    } as Partial<OcxConfig>);
    expect(supportedLadderFor(routeModel(config, "toggle/t-model"))).toBeUndefined();
  });

  test("custom key-mode providers cannot capture a bare native-looking OpenAI id", () => {
    tempCodexHome = mkdtempSync(join(tmpdir(), "ocx-effort-catalog-"));
    process.env.CODEX_HOME = tempCodexHome;
    writeFileSync(join(tempCodexHome, "opencodex-catalog.json"), JSON.stringify({
      models: [{ slug: "gpt-5.4", display_name: "gpt-5.4", supported_reasoning_levels: [
        { effort: "low", description: "low" }, { effort: "medium", description: "medium" },
      ] }],
    }));
    const config = makeConfig({
      providers: {
        selfhosted: {
          adapter: "openai-responses", baseUrl: "https://example.com/v1", authMode: "key",
          apiKey: "k", models: ["gpt-5.4"],
        },
      },
      defaultProvider: "selfhosted",
    } as Partial<OcxConfig>);
    expect(() => routeModel(config, "gpt-5.4")).toThrow(NoEnabledOpenAiProviderError);
    const namespaced = routeModel(config, "selfhosted/gpt-5.4");
    expect(namespaced.providerName).toBe("selfhosted");
    expect(supportedLadderFor(namespaced)).toBeUndefined();
  });

  test("native forward-mode passthrough reads the injected catalog ladder", () => {
    tempCodexHome = mkdtempSync(join(tmpdir(), "ocx-effort-catalog-"));
    process.env.CODEX_HOME = tempCodexHome;
    writeFileSync(join(tempCodexHome, "opencodex-catalog.json"), JSON.stringify({
      models: [{ slug: "gpt-5.4", display_name: "gpt-5.4", supported_reasoning_levels: [
        { effort: "low", description: "low" }, { effort: "medium", description: "medium" },
        { effort: "high", description: "high" }, { effort: "xhigh", description: "xhigh" },
      ] }],
    }));
    const config = makeConfig({
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
      },
      defaultProvider: "openai",
    } as Partial<OcxConfig>);
    const route = routeModel(config, "gpt-5.4");
    expect(supportedLadderFor(route)).toEqual(["low", "medium", "high", "xhigh"]);
  });
});

describe("effortCapAppliesTo (caps are a v2-feature gate)", () => {
  function parsedWithTools(tools: Array<{ name: string; namespace?: string }>, reasoning?: string): OcxParsedRequest {
    return {
      modelId: "gpt-5.6-sol",
      context: {
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools: tools as never,
      },
      stream: true,
      options: reasoning ? { reasoning: reasoning as never } : {},
      _rawBody: { model: "gpt-5.6-sol", reasoning: reasoning ? { effort: reasoning } : undefined },
    };
  }

  test("v2 flat spawn_agent surface is classified v2 — caps apply", () => {
    const parsed = parsedWithTools([{ name: "spawn_agent" }], "max");
    expect(collabSurface(parsed)).toBe("v2");
    const config = makeConfig({ effortCap: "high" });
    expect(effortCapAppliesTo("v2", new Headers(), config)).toBe(true);
    expect(applyEffortCap(parsed, new Headers(), config)).toEqual({ from: "max", to: "high", subagent: false });
  });

  test("v1 namespaced spawn + send_input is classified v1 — gate refuses", () => {
    const parsed = parsedWithTools([
      { name: "spawn_agent", namespace: "agents" },
      { name: "send_input", namespace: "agents" },
    ], "max");
    expect(collabSurface(parsed)).toBe("v1");
    // applyEffortCap itself is surface-unaware; handleResponses consults the gate.
    expect(effortCapAppliesTo("v1", new Headers(), makeConfig({ effortCap: "high" }))).toBe(false);
  });

  test("plain main turn (no collab tools, no child headers) — gate refuses", () => {
    const parsed = parsedWithTools([{ name: "shell" }], "max");
    expect(collabSurface(parsed)).toBeNull();
    expect(effortCapAppliesTo(null, new Headers(), makeConfig({ effortCap: "high", subagentEffortCap: "medium" }))).toBe(false);
  });

  test("depth-limited child turn carries no collab tools — the spawned-child header still admits the cap", () => {
    // Regression guard: depth-limited leaf children carry no collab tools (surface
    // null), so a surface-only gate would skip exactly the turns subagentEffortCap
    // exists for.
    const parsed = parsedWithTools([{ name: "shell" }], "max");
    expect(collabSurface(parsed)).toBeNull();
    const config = makeConfig({ subagentEffortCap: "medium" });
    const childHeaders = new Headers({ "x-openai-subagent": "collab_spawn" });
    expect(effortCapAppliesTo(null, childHeaders, config)).toBe(true);
    expect(applyEffortCap(parsed, childHeaders, config)).toEqual({ from: "max", to: "medium", subagent: true });
  });

  test("header-marked child with a v1 tool surface is still admitted (surface-agnostic child gate)", () => {
    // Children below the spawn-depth limit retain collab tools (spec_plan.rs leaf
    // guard) — two siblings must not get different cap treatment based on depth.
    const childHeaders = new Headers({ "x-openai-subagent": "collab_spawn" });
    const config = makeConfig({ subagentEffortCap: "medium" });
    expect(effortCapAppliesTo("v1", childHeaders, config)).toBe(true);
    expect(effortCapAppliesTo("v2", childHeaders, config)).toBe(true);
  });

  test("non-spawn subagent markers do not admit the cap", () => {
    const config = makeConfig({ effortCap: "high", subagentEffortCap: "medium" });
    expect(effortCapAppliesTo(null, new Headers({ "x-openai-subagent": "review" }), config)).toBe(false);
    expect(effortCapAppliesTo(null, new Headers({ "x-openai-subagent": "compact" }), config)).toBe(false);
    expect(effortCapAppliesTo(null, new Headers({ "x-openai-subagent": "memory_consolidation" }), config)).toBe(false);
    const otherMeta = new Headers({ "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "other" }) });
    expect(effortCapAppliesTo(null, otherMeta, config)).toBe(false);
  });

  test("malformed turn metadata never admits the cap", () => {
    const config = makeConfig({ effortCap: "high", subagentEffortCap: "medium" });
    expect(effortCapAppliesTo(null, new Headers({ "x-codex-turn-metadata": "{not json" }), config)).toBe(false);
  });

  test("turn-metadata subagent_kind alone admits the cap for a child turn", () => {
    const headers = new Headers({ "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }) });
    expect(effortCapAppliesTo(null, headers, makeConfig({ subagentEffortCap: "medium" }))).toBe(true);
  });

  test("multiAgentMode v1 disables the gate entirely, even for v2 surfaces and child headers", () => {
    const config = makeConfig({ effortCap: "high", subagentEffortCap: "medium", multiAgentMode: "v1" });
    expect(effortCapAppliesTo("v2", new Headers(), config)).toBe(false);
    expect(effortCapAppliesTo(null, new Headers({ "x-openai-subagent": "collab_spawn" }), config)).toBe(false);
  });

  test("explicit default and forced-v2 modes keep the gate open for v2 surfaces and marked children", () => {
    for (const mode of ["default", "v2"] as const) {
      const config = makeConfig({ effortCap: "high", multiAgentMode: mode });
      expect(effortCapAppliesTo("v2", new Headers(), config)).toBe(true);
      expect(effortCapAppliesTo(null, new Headers({ "x-openai-subagent": "collab_spawn" }), config)).toBe(true);
      // A plain main turn stays out even under forced v2 — no collab tools, no markers.
      expect(effortCapAppliesTo(null, new Headers(), config)).toBe(false);
    }
  });

  test("compaction turns bypass the cap regardless of surface or markers", () => {
    // Native /v1/responses/compact never enters handleResponses; routed compaction
    // must not diverge from it, so the gate refuses when the compaction flag is set.
    const config = makeConfig({ effortCap: "high", subagentEffortCap: "medium" });
    expect(effortCapAppliesTo("v2", new Headers(), config, true)).toBe(false);
    expect(effortCapAppliesTo(null, new Headers({ "x-openai-subagent": "collab_spawn" }), config, true)).toBe(false);
  });
});

describe("cap composition with downstream clamps", () => {
  test("snapped ordinary rung passes mapReasoningEffort unchanged for a supporting provider", () => {
    const provider = {
      adapter: "openai-chat", baseUrl: "https://example.com/v1", apiKey: "k",
      modelReasoningEfforts: { "m": ["low", "medium", "xhigh"] },
    } as never;
    // Cap high snaps to medium; the adapter-level map keeps medium as-is.
    expect(resolveCappedEffort("high", ["low", "medium", "xhigh"])).toBe("medium");
    expect(mapReasoningEffort(provider, "m", "medium")).toBe("medium");
  });

  test("synthetic native top rung is still lowered by nativeEffortClamp after the cap block", () => {
    // gpt-5.4's real ladder stops at xhigh: an uncapped (or xhigh-capped) max/ultra
    // arrival is repaired by the native clamp that runs AFTER applyEffortCap.
    expect(nativeEffortClamp("gpt-5.4", "max")).toBe("xhigh");
    expect(nativeEffortClamp("gpt-5.4", "ultra")).toBe("xhigh");
    expect(nativeEffortClamp("gpt-5.4", "medium")).toBeNull();
  });
});

describe("/api/effort-caps", () => {
  function isolatedHome(): void {
    tempHome = mkdtempSync(join(tmpdir(), "ocx-effort-caps-"));
    process.env.OPENCODEX_HOME = tempHome;
  }

  async function put(config: OcxConfig, body: unknown): Promise<Response> {
    const req = new Request("http://localhost/api/effort-caps", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await handleManagementAPI(req, new URL(req.url), config);
    expect(res).not.toBeNull();
    return res!;
  }

  test("PUT sets both caps; GET surfaces them with the ladder", async () => {
    isolatedHome();
    const config = makeConfig();
    const putRes = await put(config, { effortCap: "high", subagentEffortCap: "medium" });
    expect(await putRes.json()).toEqual({ ok: true, effortCap: "high", subagentEffortCap: "medium" });
    expect(config.effortCap).toBe("high");
    expect(config.subagentEffortCap).toBe("medium");

    const getRes = await handleManagementAPI(
      new Request("http://localhost/api/effort-caps"), new URL("http://localhost/api/effort-caps"), config,
    );
    const data = await getRes!.json() as { effortCap: string; subagentEffortCap: string; efforts: string[] };
    expect(data.effortCap).toBe("high");
    expect(data.subagentEffortCap).toBe("medium");
    expect(data.efforts).toContain("ultra");
  });

  test("absent key unchanged; null clears; invalid ladder value -> 400", async () => {
    isolatedHome();
    const config = makeConfig({ effortCap: "high", subagentEffortCap: "medium" });
    const keep = await put(config, { subagentEffortCap: "low" });
    expect(keep.status).toBe(200);
    expect(config.effortCap).toBe("high");
    expect(config.subagentEffortCap).toBe("low");

    await put(config, { effortCap: null });
    expect(config.effortCap).toBeUndefined();

    const bad = await put(config, { subagentEffortCap: "hyper" });
    expect(bad.status).toBe(400);
    expect(config.subagentEffortCap).toBe("low");
  });
});
