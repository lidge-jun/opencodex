/**
 * Multi-agent compatibility shims (follow-up to devlog/260709_v2_gated_ultra):
 * models are no longer v1-pinned by ocx, but legacy/v1-surface requests still need
 * the Proactive delegation prompt when they arrive with the synthetic top tier.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectDeveloperMessage, multiAgentGuidanceText, sanitizeEncryptedContentInPlace } from "../src/server/responses";
import { parseRequest } from "../src/responses/parser";
import type { OcxParsedRequest } from "../src/types";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND, effectiveSubagentRoster } from "../src/codex/catalog";
import { collectCodexAppServerCatalogState, resetCodexAppServerCatalogStateCache } from "../src/codex/app-server-processes";
import { setTrustedWindowsElevationExecutablesForTests } from "../src/lib/windows-elevation";
import { clearDebugSettings, setDebugSettings } from "../src/lib/debug-settings";
import {
  getInjectionDebugLogEntries,
  resetInjectionDebugLogBufferForTests,
} from "../src/lib/injection-debug-log";

const savedCodexHome = process.env.CODEX_HOME;
const savedCatalogStateOverride = process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;

// Hermetic default: the host machine may run a real Codex app-server whose
// process state must not leak into these tests (#857).
process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = "fresh";

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = "fresh";
  clearDebugSettings();
  resetInjectionDebugLogBufferForTests();
});

afterAll(() => {
  if (savedCatalogStateOverride === undefined) delete process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;
  else process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = savedCatalogStateOverride;
});

function codexHomeFixture(configToml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-v1pin-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), configToml);
  process.env.CODEX_HOME = dir;
  return dir;
}

type CatalogFixtureModel = {
  slug: string;
  efforts?: string[];
  visibility?: "list" | "hide";
  priority?: number;
  multiAgentVersion?: "v1" | "v2" | null;
  accountBound?: boolean;
};

/** Write an injected-catalog fixture into the active CODEX_HOME. */
function catalogFixture(dir: string, models: CatalogFixtureModel[]): void {
  writeFileSync(join(dir, "opencodex-catalog.json"), JSON.stringify({
    models: models.map((model, index) => ({
      slug: model.slug,
      display_name: model.slug,
      visibility: model.visibility ?? "list",
      priority: model.priority ?? index,
      // undefined means the key is ABSENT, matching how routed entries are really
      // written (normalizeRoutedCatalogEntry deletes it). The production absent-key
      // path cannot be tested if the fixture rewrites it to "v2".
      ...(model.multiAgentVersion === undefined ? {} : { multi_agent_version: model.multiAgentVersion }),
      ...(model.accountBound ? { opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND } : {}),
      supported_reasoning_levels: (model.efforts ?? [])
        .map(effort => ({ effort, description: effort })),
    })),
  }));
}

const V2_ON = "[features.multi_agent_v2]\nenabled = true\n";
const V2_OFF = "[features]\nmulti_agent = true\n";

function parsedFixture(over: {
  reasoning?: string;
  tools?: Array<{ name: string; namespace?: string }>;
  rawInput?: unknown;
}): OcxParsedRequest {
  return {
    modelId: "gpt-5.5",
    context: {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: (over.tools ?? [{ name: "spawn_agent" }]) as never,
    },
    stream: true,
    options: over.reasoning ? { reasoning: over.reasoning as never } : {},
    _rawBody: { model: "gpt-5.5", input: over.rawInput ?? [] },
  };
}

describe("multiAgentGuidanceText", () => {
  test("v1 tool surface + max injects the tagged Proactive text", async () => {
    codexHomeFixture(V2_OFF); // guidance fires regardless of v2 flag
    const text = await multiAgentGuidanceText(parsedFixture({
      reasoning: "max",
      tools: [{ name: "spawn_agent", namespace: "agents" }, { name: "send_input", namespace: "agents" }],
    }));
    expect(text).toContain("<multi_agent_mode>");
    expect(text).toContain("Proactive multi-agent delegation is active");
  });

  test("v1 tool surface below the top tier stays silent", async () => {
    codexHomeFixture(V2_OFF);
    const v1Tools = [{ name: "spawn_agent", namespace: "agents" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "high", tools: v1Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ tools: v1Tools }))).toBeNull();
  });

  test("v2 or non-agent tool surfaces stay silent even at max", async () => {
    codexHomeFixture(V2_OFF);
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: [{ name: "spawn_agent" }] }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: [{ name: "shell" }] }))).toBeNull();
  });

  // Every catalog-state test in this file injects `collectCatalogState`, which means none
  // of them observes which collector the DEFAULT path picks. Rewiring the v2 boundary back
  // to the synchronous collector left this whole suite green — the regression #1852 exists
  // to prevent would have shipped unnoticed. This pins the default wiring itself.
  test("the v2 default catalog path uses the request collector, not the synchronous one (#1852)", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{
      slug: "anthropic/claude-sonnet-5",
      efforts: ["low", "medium", "high", "xhigh"],
    }]);
    const parsed = parsedFixture({ reasoning: "medium", tools: [{ name: "spawn_agent" }] });

    // Force the default dependency by passing NO collectCatalogState, and make the
    // underlying process enumeration observable through the trusted-executable seam:
    // a stalling fake stands in for a slow CIM walk. The async request collector leaves
    // the loop free; the synchronous collector parks it.
    const fakeDir = mkdtempSync(join(tmpdir(), "ocx-collab-ps-"));
    // Platform-shaped: execFile takes no shell, so a POSIX script is not executable on
    // Windows — the platform this fix targets, whose CI shard runs this suite.
    const fake = join(fakeDir, process.platform === "win32" ? "fake-powershell.cmd" : "fake-powershell.sh");
    if (process.platform === "win32") {
      writeFileSync(fake, ["@echo off", "ping -n 1 -w 200 192.0.2.1 >nul 2>&1"].join("\r\n"));
    } else {
      writeFileSync(fake, ["#!/bin/sh", "sleep 0.2", "printf ''"].join("\n"));
      chmodSync(fake, 0o755);
    }
    setTrustedWindowsElevationExecutablesForTests({ powershell: fake });
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    resetCodexAppServerCatalogStateCache();
    // This suite sets a hermetic state override at module load so the host's real
    // app-server cannot leak in. That override short-circuits before any collector runs,
    // so it has to come off for exactly this test — which is the one test that needs the
    // real default path.
    delete process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;

    // Phase signal rather than a tick count: a threshold between "sync" and "async"
    // observations has to guess how many timer callbacks a loaded runner will deliver,
    // and setInterval promises no catch-up. This asks the binary question instead — did
    // any event-loop work run WHILE the child was alive? A synchronous exec parks the
    // loop, so the flag cannot flip regardless of machine speed.
    let loopRanDuringExec = false;
    const beat = setInterval(() => { loopRanDuringExec = true; }, 5);
    try {
      await multiAgentGuidanceText(parsed, { injectionModel: "anthropic/claude-sonnet-5" });
    } finally {
      clearInterval(beat);
      Object.defineProperty(process, "platform", realPlatform);
      setTrustedWindowsElevationExecutablesForTests(null);
      rmSync(fakeDir, { recursive: true, force: true });
      resetCodexAppServerCatalogStateCache();
      process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = "fresh";
    }

    expect(loopRanDuringExec).toBe(true);
  });

  test("v2 guidance suppresses positive model claims while the app-server catalog is stale or unknown (#857)", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{
      slug: "anthropic/claude-sonnet-5",
      efforts: ["low", "medium", "high", "xhigh"],
    }]);
    const parsed = parsedFixture({ reasoning: "medium", tools: [{ name: "spawn_agent" }] });
    const options = { injectionModel: "anthropic/claude-sonnet-5" };

    for (const state of ["stale", "unknown"] as const) {
      const text = await multiAgentGuidanceText(parsed, options, {
        collectCatalogState: async () => ({ state }),
      });
      // #1395: withhold OpenCodex's disk-derived claims, but do not prohibit
      // options the active spawn_agent tool advertises — the global catalog
      // observation cannot be attributed to the request that triggered it.
      expect(text).toBeNull();
    }

    for (const state of ["fresh", "not_running"] as const) {
      const text = await multiAgentGuidanceText(parsed, options, {
        collectCatalogState: () => ({ state }),
      });
      expect(text).toContain("Preferred sub-agent");
    }
  });

  test("a mixed stale/fresh process set does not produce a blanket no-override instruction (#1395)", async () => {
    // The scoping bug this guards: `collectCodexAppServerCatalogState()` folds
    // every current-user app-server into ONE global observation. Process 42
    // predates the catalog and process 43 does not, so the global state is
    // `stale` — but the inbound request carries no sender PID, so we cannot tell
    // whether it came from the stale server or the fresh one.
    const appServerCmd = "/usr/local/bin/codex app-server";
    const global = collectCodexAppServerCatalogState({
      listSnapshots: () => [
        { pid: 42, commandLine: appServerCmd },
        { pid: 43, commandLine: appServerCmd },
      ],
      readStartMs: pid => (pid === 42 ? 500 : 3_000),
      catalogMtimeMs: () => 1_000,
    });
    expect(global.state).toBe("stale");

    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{
      slug: "anthropic/claude-sonnet-5",
      efforts: ["low", "medium", "high", "xhigh"],
    }]);
    const parsed = parsedFixture({ reasoning: "medium", tools: [{ name: "spawn_agent" }] });
    const options = { injectionModel: "anthropic/claude-sonnet-5" };

    const text = await multiAgentGuidanceText(parsed, options, {
      collectCatalogState: () => ({ state: global.state }),
    });

    // A request we cannot attribute to the stale process must not be told to
    // stop setting model or reasoning_effort — that prohibits options the active
    // spawn_agent tool legitimately advertises, for a session that may be fresh.
    expect(text).toBeNull();
  });

  test("stale and unknown withhold OpenCodex's own catalog claims (#1354, #1395)", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{
      slug: "anthropic/claude-sonnet-5",
      efforts: ["low", "medium", "high", "xhigh"],
    }]);
    const parsed = parsedFixture({ reasoning: "medium", tools: [{ name: "spawn_agent" }] });
    const options = { injectionModel: "anthropic/claude-sonnet-5" };

    for (const state of ["stale", "unknown"] as const) {
      const text = await multiAgentGuidanceText(parsed, options, {
        collectCatalogState: () => ({ state }),
      });
      // No preferred model, no roster, no fallback, and no override prohibition.
      // The active tool schema stays authoritative.
      expect(text).toBeNull();
    }

    // `fresh` and `not_running` are unchanged: there the catalog can be
    // positively described, so the designation guidance still applies.
    for (const state of ["fresh", "not_running"] as const) {
      const text = await multiAgentGuidanceText(parsed, options, {
        collectCatalogState: () => ({ state }),
      });
      expect(text).toContain("Preferred sub-agent");
    }
  });

  test("v2 built-in guidance is schema-agnostic and keeps fork rules", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{
      slug: "anthropic/claude-sonnet-5",
      efforts: ["low", "medium", "high", "xhigh"],
    }]);

    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "medium", tools: [{ name: "spawn_agent" }] }),
      { injectionModel: "anthropic/claude-sonnet-5" },
    );

    expect(text).toContain("When the active spawn_agent tool supports optional");
    expect(text).toContain("use only models listed for this collaboration surface");
    expect(text).toContain("fork_turns");
    expect(text).toContain('"none"');
    expect(text).not.toMatch(/hidden/i);
    expect(text).not.toMatch(/not in the schema/i);
    expect(text).not.toMatch(/never claim/i);
    expect(text).not.toContain("Proactive multi-agent delegation is active");
  });

  test("v2 roster is the configured intersection of the active spawn_agent candidates", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [
      { slug: "gpt-5.6-sol", efforts: ["high", "max", "ultra"], priority: 0, multiAgentVersion: "v2" },
      { slug: "gpt-5.5", efforts: ["low", "medium", "high"], priority: 1, multiAgentVersion: null },
      { slug: "gpt-5.6-terra", efforts: ["high", "max", "ultra"], priority: 2, multiAgentVersion: "v2" },
      { slug: "gpt-5.6-luna", efforts: ["high", "max"], priority: 3, multiAgentVersion: "v1" },
    ]);
    const configured = ["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"];

    const effective = effectiveSubagentRoster(configured, "v2");
    // Upstream 6d4d9442c: a "v1" pin means eligible LEAF worker, not "ineligible".
    // gpt-5.6-luna carries upstream's own "v1" pin, so it belongs in the roster.
    expect(effective.candidates.map(model => model.model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(effective.advertised.map(model => model.model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);

    const text = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      { subagentModels: configured },
    );
    expect(text).toContain('"gpt-5.6-sol"');
    // Since upstream 6d4d9442c only an explicit "disabled" pin excludes a model.
    // Unpinned (null) rows and "v1"-pinned rows are both eligible leaf workers.
    expect(text).toContain('"gpt-5.5"');
    expect(text).toContain('"gpt-5.6-terra"');
    expect(text).toContain('"gpt-5.6-luna"');
    for (const advertised of effective.advertised) {
      expect(effective.candidates.map(model => model.model)).toContain(advertised.model);
    }
  });

  test("bare native roles project onto account rows without matching arbitrary provider rows", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [
      { slug: "gpt-5.6-sol", visibility: "hide", priority: 0 },
      {
        slug: "vendor/gpt-5.6-sol",
        priority: 1,
      },
      {
        slug: "desktop/gpt-5.6-sol",
        efforts: ["high", "max"],
        priority: 2,
        accountBound: true,
      },
      {
        slug: "team/gpt-5.6-sol",
        efforts: ["high", "max"],
        priority: 3,
        accountBound: true,
      },
      { slug: "local-fast", efforts: ["high"], priority: 4 },
    ]);

    const projected = effectiveSubagentRoster(["gpt-5.6-sol"], "v2");
    expect(projected.advertised.map(model => model.model)).toEqual([
      "desktop/gpt-5.6-sol",
      "team/gpt-5.6-sol",
    ]);
    expect(effectiveSubagentRoster(["team/gpt-5.6-sol"], "v2").advertised.map(m => m.model))
      .toEqual(["team/gpt-5.6-sol"]);

    const text = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      {
        injectionModel: "gpt-5.6-sol",
        codexAccountNamespace: "team",
        subagentModels: ["gpt-5.6-sol"],
        subagentModelFallback: ["kimi/k3"],
      },
    );
    expect(text).toContain('Preferred sub-agent: model "team/gpt-5.6-sol"');
    expect(text).toContain('"team/gpt-5.6-sol"');
    expect(text).not.toContain('"desktop/gpt-5.6-sol"');
    expect(text).not.toContain('"vendor/gpt-5.6-sol"');
    expect(text).toContain("kimi/k3");

    const custom = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      {
        injectionModel: "gpt-5.6-sol",
        codexAccountNamespace: "team",
        injectionPrompt: "Use {{model}}.",
      },
    );
    expect(custom).toBe('<multi_agent_mode>Use team/gpt-5.6-sol.</multi_agent_mode>');

    const exactBare = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      {
        injectionModel: "local-fast",
        codexAccountNamespace: "team",
      },
    );
    expect(exactBare).toContain('Preferred sub-agent: model "local-fast"');

    const exactBareCustom = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      {
        injectionModel: "local-fast",
        codexAccountNamespace: "team",
        injectionPrompt: "Use {{model}}.",
      },
    );
    expect(exactBareCustom).toBe("<multi_agent_mode>Use local-fast.</multi_agent_mode>");

    const bareParent = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      { subagentModels: ["gpt-5.6-sol"] },
    );
    expect(bareParent).toBeNull();

    const emptyNamespace = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      {
        codexAccountNamespace: "",
        subagentModels: ["gpt-5.6-sol"],
      },
      {
        resolveEffectiveSubagentRoster: () => ({
          candidates: [{ model: "/gpt-5.6-sol", efforts: ["high"] }],
          advertised: [{ model: "/gpt-5.6-sol", efforts: ["high"] }],
          excluded: [],
        }),
      },
    );
    expect(emptyNamespace).toBeNull();

    const explicitCrossAccount = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      {
        codexAccountNamespace: "team",
        subagentModels: ["desktop/gpt-5.6-sol"],
      },
    );
    expect(explicitCrossAccount).toContain('"desktop/gpt-5.6-sol"');

    const ambiguous = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      { injectionModel: "gpt-5.6-sol" },
    );
    expect(ambiguous).toBeNull();

    const ambiguousCustom = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      {
        injectionModel: "gpt-5.6-sol",
        injectionPrompt: "Use {{model}}.",
      },
    );
    expect(ambiguousCustom).toBe("<multi_agent_mode>Use .</multi_agent_mode>");
    expect(ambiguousCustom).not.toContain("gpt-5.6-sol");
  });

  test("account projection never widens the five-model spawn candidate window", () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [
      ...Array.from({ length: 5 }, (_, index) => ({
        slug: `filler-${index}`,
        priority: index,
      })),
      { slug: "gpt-5.6-sol", visibility: "hide", priority: 5 },
      {
        slug: "desktop/gpt-5.6-sol",
        priority: 6,
        accountBound: true,
      },
    ]);

    const effective = effectiveSubagentRoster(["gpt-5.6-sol"], "v2");
    expect(effective.advertised).toEqual([]);
    expect(effective.excluded).toEqual([{
      configured: "gpt-5.6-sol",
      catalogModel: "desktop/gpt-5.6-sol",
      reason: "outside_display_limit",
    }]);
  });

  test("bare preference never chooses an exact account from a truncated projection", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [
      ...Array.from({ length: 4 }, (_, index) => ({
        slug: `filler-${index}`,
        priority: index,
      })),
      {
        slug: "desktop/gpt-5.6-sol",
        priority: 4,
        accountBound: true,
      },
      {
        slug: "team/gpt-5.6-sol",
        priority: 5,
        accountBound: true,
      },
    ]);

    expect(effectiveSubagentRoster(["gpt-5.6-sol"], "v2").advertised.map(m => m.model))
      .toEqual(["desktop/gpt-5.6-sol"]);
    expect(await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      { injectionModel: "gpt-5.6-sol" },
    )).toBeNull();
    expect(await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      {
        injectionModel: "gpt-5.6-sol",
        injectionPrompt: "Use {{model}}.",
      },
    )).toBe("<multi_agent_mode>Use .</multi_agent_mode>");
  });

  test("effective roster applies alias, visibility, v2 compatibility, stable priority, cap, and diagnostics", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [
      { slug: "provider/vendor-model", efforts: ["high"], priority: 0 },
      { slug: "eligible-a", efforts: ["high"], priority: 1 },
      { slug: "eligible-b", efforts: ["high"], priority: 1 },
      { slug: "hidden-model", efforts: ["high"], visibility: "hide", priority: 2 },
      // "v1" is an eligible LEAF worker since upstream 6d4d9442c; only "disabled"
      // is a capability-based exclusion, so the disabled row carries that role now.
      { slug: "disabled-model", efforts: ["high"], priority: 3, multiAgentVersion: "disabled" },
      { slug: "v1-model", efforts: ["high"], priority: 4, multiAgentVersion: "v1" },
      { slug: "filler-a", efforts: ["high"], priority: 5 },
      { slug: "displaced-model", efforts: ["high"], priority: 6 },
    ]);
    const configured = [
      "provider/vendor/model",
      "hidden-model",
      "disabled-model",
      "missing-model",
      "displaced-model",
    ];

    const effective = effectiveSubagentRoster(configured, "v2");
    expect(effective.candidates.map(model => model.model)).toEqual([
      "provider/vendor-model",
      "eligible-a",
      "eligible-b",
      "v1-model",
      "filler-a",
    ]);
    expect(effective.advertised.map(model => model.model)).toEqual(["provider/vendor-model"]);
    expect(effective.excluded).toEqual([
      { configured: "hidden-model", catalogModel: "hidden-model", reason: "picker_hidden" },
      { configured: "disabled-model", catalogModel: "disabled-model", reason: "surface_incompatible" },
      { configured: "missing-model", reason: "missing_catalog_entry" },
      { configured: "displaced-model", catalogModel: "displaced-model", reason: "outside_display_limit" },
    ]);

    setDebugSettings({ injection: false });
    await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      { subagentModels: configured },
    );
    expect(getInjectionDebugLogEntries()).toEqual([]);

    resetInjectionDebugLogBufferForTests();
    setDebugSettings({ injection: true });
    await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      { subagentModels: configured },
    );
    const lines = getInjectionDebugLogEntries().map(entry => entry.line).join("\n");
    expect(lines).toContain("hidden-model:picker_hidden");
    expect(lines).toContain("disabled-model:surface_incompatible");
    expect(lines).toContain("missing-model:missing_catalog_entry");
    expect(lines).toContain("displaced-model:outside_display_limit");
  });

  test("built-in preferred model is canonical and limited to active candidates", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [
      { slug: "provider/vendor-model", efforts: ["high"], priority: 0, multiAgentVersion: "v2" },
      { slug: "gpt-5.5", efforts: ["high"], priority: 1, multiAgentVersion: null },
    ]);

    // Option B: the null-pinned model is now an active candidate, so it is a valid
    // preferred model rather than producing no guidance.
    const nullPinned = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      { injectionModel: "gpt-5.5" },
    );
    expect(nullPinned).toContain('Preferred sub-agent: model "gpt-5.5"');

    const eligible = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      { injectionModel: "provider/vendor/model", injectionEffort: "high" },
    );
    expect(eligible).toContain('Preferred sub-agent: model "provider/vendor-model", reasoning_effort "high"');
    expect(eligible).not.toContain('model "provider/vendor/model"');
  });

  test("NATIVE v2 wire shape (collaboration namespace + v2 companions) is classified v2", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{
      slug: "anthropic/claude-sonnet-5",
      efforts: ["low", "medium", "high", "xhigh"],
    }]);
    // The ChatGPT backend registers reserved namespaced collab tools:
    // collaboration.spawn_agent + send_message/followup_task/wait_agent/... (spec_plan.rs)
    const nativeV2 = [
      { name: "spawn_agent", namespace: "collaboration" },
      { name: "send_message", namespace: "collaboration" },
      { name: "followup_task", namespace: "collaboration" },
      { name: "wait_agent", namespace: "collaboration" },
      { name: "list_agents", namespace: "collaboration" },
    ];
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "medium", tools: nativeV2 }),
      { injectionModel: "anthropic/claude-sonnet-5" },
    );
    expect(text).toContain('"anthropic/claude-sonnet-5"');
    expect(text).toContain("fork_turns");
    expect(text).not.toContain("Proactive multi-agent delegation is active");
    // and WITHOUT an injectionModel it stays silent (codex-rs owns the v2 Proactive text)
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "ultra", tools: nativeV2 }))).toBeNull();
  });

  test("responses_lite WS shape: tools inside input additional_tools are seen (real Codex Desktop capture)", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{ slug: "gpt-5.6-terra", efforts: ["high", "max", "ultra"] }]);
    // Shape captured live from Codex Desktop 0.143.0 (responses_websockets lite): NO body.tools;
    // an input item {type:"additional_tools", role, tools:[...]} carries the tool specs.
    const parsed = parseRequest({
      model: "gpt-5.6-sol",
      stream: true,
      reasoning: { effort: "high" },
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            { type: "custom", name: "exec", description: "..." },
            { type: "function", name: "wait", description: "...", parameters: {} },
            { type: "namespace", name: "collaboration", description: "...", tools: [
              { type: "function", name: "followup_task", description: "...", parameters: {} },
              { type: "function", name: "interrupt_agent", description: "...", parameters: {} },
              { type: "function", name: "list_agents", description: "...", parameters: {} },
              { type: "function", name: "send_message", description: "...", parameters: {} },
              { type: "function", name: "spawn_agent", description: "...", parameters: {} },
              { type: "function", name: "wait_agent", description: "...", parameters: {} },
            ] },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "gpt-5.6-terra 호출해봐" }] },
      ],
    });
    const names = (parsed.context.tools ?? []).map(t => (t.namespace ? `${t.namespace}.${t.name}` : t.name));
    expect(names).toContain("collaboration.spawn_agent");
    const text = await multiAgentGuidanceText(parsed, {
      injectionModel: "gpt-5.6-sol",
      injectionEffort: "xhigh",
      subagentModels: ["gpt-5.6-terra"],
    });
    expect(text).toContain("When the active spawn_agent tool supports optional");
    expect(text).not.toMatch(/hidden|not in the schema|never claim/i);
    expect(text).toContain('(reasoning_effort high/max/ultra): "gpt-5.6-terra"');
  });

  test("v1 wire shape (multi_agent_v1 namespace + send_input) still classifies v1", async () => {
    codexHomeFixture(V2_OFF);
    const v1Tools = [
      { name: "spawn_agent", namespace: "multi_agent_v1" },
      { name: "send_input", namespace: "multi_agent_v1" },
      { name: "wait_agent", namespace: "multi_agent_v1" },
      { name: "close_agent", namespace: "multi_agent_v1" },
    ];
    const text = await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: v1Tools }));
    expect(text).toContain("Proactive multi-agent delegation is active");
  });

  test("subagentModels roster: per-model ladders on v2; v1 carries NO roster", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [
      { slug: "gpt-5.6-sol", efforts: ["high", "max", "ultra"] },
      { slug: "anthropic/claude-sonnet-5", efforts: ["low", "medium", "high", "xhigh"] },
    ]);
    const roster = ["gpt-5.6-sol", "anthropic/claude-sonnet-5", "missing/model"];
    const v2 = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      { injectionModel: "anthropic/claude-sonnet-5", subagentModels: roster },
    );
    // differing ladders -> per-model annotation
    expect(v2).toContain('"gpt-5.6-sol" (high/max/ultra)');
    expect(v2).toContain('"anthropic/claude-sonnet-5" (low/medium/high/xhigh)');
    expect(v2).not.toContain("missing/model"); // not in the catalog -> omitted

    const v1 = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "max", tools: [{ name: "spawn_agent", namespace: "multi_agent_v1" }, { name: "send_input", namespace: "multi_agent_v1" }] }),
      { subagentModels: roster },
    );
    expect(v1).toContain("Proactive multi-agent delegation is active");
    expect(v1).not.toContain("Available models"); // v1 stays lean: Proactive text only
  });

  test("roster is silent when unset or nothing resolves in the catalog", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{ slug: "gpt-5.5", efforts: ["low", "medium"] }]);
    const v1Tools = [{ name: "spawn_agent", namespace: "multi_agent_v1" }, { name: "send_input", namespace: "multi_agent_v1" }];
    const unset = await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: v1Tools }));
    expect(unset).not.toContain("Available models");
    // an UNRESOLVED roster does not fire guidance on v2 either
    expect(await multiAgentGuidanceText(parsedFixture({ tools: [{ name: "spawn_agent" }] }), { subagentModels: ["nope/none"] })).toBeNull();
  });

  test("v2 surface + eligible injectionModel + injectionEffort names both", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{
      slug: "opencode-go/glm-5.2",
      efforts: ["low", "medium", "high", "xhigh"],
    }]);
    const text = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      { injectionModel: "opencode-go/glm-5.2", injectionEffort: "xhigh" },
    );
    expect(text).toContain('Preferred sub-agent: model "opencode-go/glm-5.2", reasoning_effort "xhigh"');
  });

  test("injectionPrompt preserves an unresolved explicit model and substitutes only the effective roster", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [
      { slug: "gpt-5.6-terra", efforts: ["high", "max"], priority: 0, multiAgentVersion: "v2" },
      { slug: "gpt-5.6-luna", efforts: ["high", "max"], priority: 1, multiAgentVersion: "v1" },
    ]);
    const custom = "CUSTOM model={{model}} effort={{effort}}{{roster}}";
    const text = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      {
        injectionModel: "raw/preferred-model",
        injectionEffort: "max",
        subagentModels: ["gpt-5.6-terra", "gpt-5.6-luna"],
        injectionPrompt: custom,
      },
    );

    // gpt-5.6-luna carries upstream's "v1" pin, which is now an eligible LEAF worker
    // (codex-rs 6d4d9442c), so it joins the substituted roster.
    expect(text).toBe(
      '<multi_agent_mode>CUSTOM model=raw/preferred-model effort=max'
        + ' Available models (reasoning_effort high/max): "gpt-5.6-terra", "gpt-5.6-luna".</multi_agent_mode>',
    );
  });

  test("injectionPrompt substitutes fallback guidance via {{fallback}}", async () => {
    const text = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      {
        injectionPrompt: "FALLBACK={{fallback}}",
        subagentModelFallback: ["alibaba-token-plan/qwen3.8-max", "kimi/k3"],
      },
    );
    expect(text).toContain("FALLBACK=");
    expect(text).toContain("alibaba-token-plan/qwen3.8-max");
    expect(text).toContain("kimi/k3");
  });

  test("v1 ignores injectionPrompt and custom prompt does not fire a bare v2 surface", async () => {
    codexHomeFixture(V2_ON);
    const custom = "CUSTOM RULES model={{model}} effort={{effort}}{{roster}}";
    const v1 = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "max", tools: [{ name: "spawn_agent", namespace: "multi_agent_v1" }, { name: "send_input", namespace: "multi_agent_v1" }] }),
      { injectionPrompt: "V1 BODY {{model}}|{{effort}}|{{roster}}" },
    );
    // v1 ignores injectionPrompt entirely — it only mirrors the upstream Proactive text
    expect(v1).toContain("Proactive multi-agent delegation is active");
    expect(v1).not.toContain("V1 BODY");
    // gates unchanged: custom prompt does NOT make a bare v2 surface fire
    expect(await multiAgentGuidanceText(parsedFixture({ tools: [{ name: "spawn_agent" }] }), { injectionPrompt: custom })).toBeNull();
  });

  test("v2 surface without injectionModel AND without roster stays silent at every effort", async () => {
    codexHomeFixture(V2_ON);
    const v2Tools = [{ name: "spawn_agent" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "ultra", tools: v2Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: v2Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "medium", tools: v2Tools }))).toBeNull();
  });

  test("v2 surface + roster alone (no injectionModel) fires with the argument-acceptance preamble", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{ slug: "gpt-5.6-terra", efforts: ["high", "max", "ultra"] }]);
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "medium", tools: [{ name: "spawn_agent" }] }),
      { subagentModels: ["gpt-5.6-terra"] },
    );
    expect(text).toContain("When the active spawn_agent tool supports optional");
    expect(text).not.toMatch(/hidden|not in the schema|never claim/i);
    expect(text).toContain('(reasoning_effort high/max/ultra): "gpt-5.6-terra"');
    expect(text).not.toContain("Preferred sub-agent");
  });

  test("ambiguous mixed surface (both spawn shapes) stays silent even with injectionModel", async () => {
    codexHomeFixture(V2_ON);
    const mixed = [{ name: "spawn_agent" }, { name: "spawn_agent", namespace: "agents" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: mixed }), { injectionModel: "anthropic/claude-sonnet-5" })).toBeNull();
    // contradictory companions (v1 send_input + v2 send_message) also veto
    const contradictory = [
      { name: "spawn_agent", namespace: "collaboration" },
      { name: "send_input", namespace: "collaboration" },
      { name: "send_message", namespace: "collaboration" },
    ];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: contradictory }), { injectionModel: "anthropic/claude-sonnet-5" })).toBeNull();
  });

  test("v2 flag off still fires guidance (ultra is always-on)", async () => {
    codexHomeFixture(V2_OFF);
    const text = await multiAgentGuidanceText(parsedFixture({
      reasoning: "max",
      tools: [{ name: "spawn_agent", namespace: "agents" }],
    }));
    expect(text).toContain("<multi_agent_mode>");
  });

  test("v1 at max carries ONLY the Proactive text — no designation payload", async () => {
    codexHomeFixture(V2_OFF);
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "max", tools: [{ name: "spawn_agent", namespace: "agents" }] }),
      {
        injectionModel: "anthropic/claude-sonnet-5",
        injectionEffort: "xhigh",
        subagentModels: ["anthropic/claude-sonnet-5"],
      },
    );
    expect(text).toContain("Proactive multi-agent delegation is active");
    expect(text).not.toContain("anthropic/claude-sonnet-5");
    expect(text).not.toContain("Preferred sub-agent");
    expect(text).not.toContain("Available models");
  });

  test("v1 injectionModel does NOT relax the top-tier gate", async () => {
    codexHomeFixture(V2_OFF);
    const v1Tools = [{ name: "spawn_agent", namespace: "agents" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "high", tools: v1Tools }), { injectionModel: "opencode-go/glm-5.2" })).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ tools: v1Tools }), { injectionModel: "anthropic/claude-opus-4-6" })).toBeNull();
  });

  test("without injectionModel, low effort stays silent", async () => {
    codexHomeFixture(V2_OFF);
    const v1Tools = [{ name: "spawn_agent", namespace: "agents" }];
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "high", tools: v1Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "medium", tools: v1Tools }))).toBeNull();
    expect(await multiAgentGuidanceText(parsedFixture({ reasoning: "max", tools: v1Tools }))).not.toBeNull();
  });

  test("v2 body stays within the 700-char budget with a full 5-model roster", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [
      { slug: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "opencode-go/glm-5.2", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "anthropic/claude-opus-4-6", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "gpt-5.6-sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { slug: "gpt-5.6-terra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    ]);
    const text = await multiAgentGuidanceText(
      parsedFixture({ reasoning: "high", tools: [{ name: "spawn_agent" }] }),
      {
        injectionModel: "gpt-5.6-sol",
        injectionEffort: "xhigh",
        subagentModels: ["gpt-5.5", "opencode-go/glm-5.2", "anthropic/claude-opus-4-6", "gpt-5.6-sol", "gpt-5.6-terra"],
      },
    );
    const body = text!.replace(/^<multi_agent_mode>/, "").replace(/<\/multi_agent_mode>$/, "");
    expect(body.length).toBeLessThanOrEqual(700);
    expect(body).toContain("Available models"); // roster fits inside the budget
  });

  test("false suppresses v1 top-tier guidance", async () => {
    const text = await multiAgentGuidanceText(
      parsedFixture({
        reasoning: "max",
        tools: [
          { name: "spawn_agent", namespace: "agents" },
          { name: "send_input", namespace: "agents" },
        ],
      }),
      { multiAgentGuidanceEnabled: false },
    );
    expect(text).toBeNull();
  });

  test("false suppresses v2 before catalog resolution", async () => {
    let rosterCalls = 0;
    const text = await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      {
        multiAgentGuidanceEnabled: false,
        injectionModel: "gpt-5.6-terra",
        injectionEffort: "max",
        subagentModels: ["gpt-5.6-terra"],
        injectionPrompt: "CUSTOM {{roster}}",
      },
      {
        resolveEffectiveSubagentRoster: () => {
          rosterCalls += 1;
          throw new Error("catalog resolver must not run while guidance is disabled");
        },
      },
    );
    expect(text).toBeNull();
    expect(rosterCalls).toBe(0);
  });

  test("unset and true preserve identical v1 and v2 guidance", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{
      slug: "gpt-5.6-terra",
      efforts: ["high", "max"],
      priority: 0,
      multiAgentVersion: "v2",
    }]);
    const v1 = parsedFixture({
      reasoning: "max",
      tools: [
        { name: "spawn_agent", namespace: "agents" },
        { name: "send_input", namespace: "agents" },
      ],
    });
    expect(await multiAgentGuidanceText(v1)).toBe(
      await multiAgentGuidanceText(v1, { multiAgentGuidanceEnabled: true }),
    );

    const v2Options = {
      injectionModel: "gpt-5.6-terra",
      subagentModels: ["gpt-5.6-terra"],
    };
    expect(await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      v2Options,
    )).toBe(await multiAgentGuidanceText(
      parsedFixture({ tools: [{ name: "spawn_agent" }] }),
      { ...v2Options, multiAgentGuidanceEnabled: true },
    ));
  });
});

describe("injectDeveloperMessage", () => {
  const guidance = "guidance text";
  const generatedItem = (text = guidance) => ({
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text }],
  });
  const countExact = (input: unknown[], text = guidance): number => input.filter(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    if (record.type !== "message" || record.role !== "developer" || !Array.isArray(record.content)) return false;
    if (record.content.length !== 1) return false;
    const part = record.content[0];
    return !!part && typeof part === "object" && !Array.isArray(part)
      && (part as Record<string, unknown>).type === "input_text"
      && (part as Record<string, unknown>).text === text;
  }).length;

  test("inserts after leading developer metadata and before conversation", () => {
    const parsed = parseRequest({
      model: "gpt-5.5",
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "system" }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "native mode" }] },
        { type: "additional_tools", role: "developer", tools: [] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "work" }] },
      ],
    });
    injectDeveloperMessage(parsed, "hello there");

    expect(parsed.context.systemPrompt).toEqual(["system"]);
    expect(parsed.context.messages.map(message => message.role)).toEqual(["developer", "developer", "user"]);
    expect(parsed.context.messages[1]!.content).toBe("hello there");
    const rawInput = (parsed._rawBody as { input: unknown[] }).input;
    expect(rawInput[2]).toMatchObject({ type: "additional_tools", role: "developer" });
    expect(rawInput[3]).toEqual(generatedItem("hello there"));
    expect(rawInput[4]).toMatchObject({ type: "message", role: "user" });
  });

  test("string raw input is left alone", () => {
    const parsed = parsedFixture({ reasoning: "max", rawInput: "plain" });
    injectDeveloperMessage(parsed, "note");
    expect((parsed._rawBody as { input: unknown }).input).toBe("plain");
    expect(parsed.context.messages[0]!.content).toBe("note");
  });

  test("inserts before conversation while compaction_trigger stays final", () => {
    const parsed = parsedFixture({ reasoning: "max" });
    const rawBody = parsed._rawBody as { input: unknown[] };
    rawBody.input = [
      { type: "message", role: "user", content: "long conversation" },
      { type: "compaction_trigger" },
    ];
    injectDeveloperMessage(parsed, "guidance text");
    const input = rawBody.input;
    expect(input).toHaveLength(3);
    expect((input[0] as { type: string }).type).toBe("message");
    expect((input[0] as { role: string }).role).toBe("developer");
    expect((input[1] as { role: string }).role).toBe("user");
    expect((input[2] as { type: string }).type).toBe("compaction_trigger");
  });

  test("consecutive stateless requests keep one fresh guidance item before conversation", async () => {
    const dir = codexHomeFixture(V2_ON);
    catalogFixture(dir, [{
      slug: "anthropic/claude-sonnet-5",
      efforts: ["low", "medium", "high", "xhigh"],
      multiAgentVersion: "v2",
    }]);
    const fixture = parsedFixture({ reasoning: "medium" });
    const text = await multiAgentGuidanceText(
      fixture,
      {
        injectionModel: "anthropic/claude-sonnet-5",
      },
      { collectCatalogState: () => ({ state: "fresh" }) },
    );

    expect(text).toContain("Preferred sub-agent");
    for (const content of ["first", "second"]) {
      const parsed = parsedFixture({
        reasoning: "medium",
        rawInput: [{ type: "message", role: "user", content }],
      });
      injectDeveloperMessage(parsed, text!);
      const rawInput = (parsed._rawBody as { input: unknown[] }).input;
      expect(countExact(rawInput, text!)).toBe(1);
      expect(rawInput).toEqual([generatedItem(text!), { type: "message", role: "user", content }]);
    }
  });

  test("keeps an unexpanded previous_response_id tool delta first", () => {
    const parsed = parsedFixture({
      reasoning: "max",
      rawInput: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    });
    parsed.previousResponseId = "resp_remote";
    injectDeveloperMessage(parsed, guidance);

    const rawInput = (parsed._rawBody as { input: unknown[] }).input;
    expect(rawInput[0]).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    expect(rawInput[1]).toEqual(generatedItem());
    expect(parsed.context.messages.at(-1)).toMatchObject({ role: "developer", content: guidance });
  });

  test("inserts changed stateful guidance before an ordinary new user delta", () => {
    const guidanceA = "<multi_agent_mode>A</multi_agent_mode>";
    const guidanceB = "<multi_agent_mode>B</multi_agent_mode>";
    const rawInput = [
      generatedItem(guidanceA),
      { type: "message", role: "user", content: "previous turn" },
      { type: "message", role: "assistant", content: "done" },
      { type: "message", role: "user", content: "current turn" },
    ];
    const parsed = parseRequest({ model: "gpt-5.5", input: rawInput });
    parsed.previousResponseId = "resp_1";
    parsed._replayPrefixLen = 3;
    parsed._continuationConversationMessageIndex = 3;

    injectDeveloperMessage(parsed, guidanceB);

    expect(rawInput).toEqual([
      generatedItem(guidanceA),
      { type: "message", role: "user", content: "previous turn" },
      { type: "message", role: "assistant", content: "done" },
      generatedItem(guidanceB),
      { type: "message", role: "user", content: "current turn" },
    ]);
    expect(parsed.context.messages.map(message => message.role)).toEqual([
      "developer",
      "user",
      "assistant",
      "developer",
      "user",
    ]);
  });

  test("keeps leading stateful protocol items before changed guidance and conversation", () => {
    const rawInput = [
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      { type: "message", role: "user", content: "current turn" },
    ];
    const parsed = parseRequest({ model: "gpt-5.5", input: rawInput, previous_response_id: "resp_remote" });

    injectDeveloperMessage(parsed, guidance);

    expect(rawInput).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      generatedItem(),
      { type: "message", role: "user", content: "current turn" },
    ]);
    expect(parsed.context.messages.map(message => message.role)).toEqual(["toolResult", "developer", "user"]);
  });

  test("keeps raw and parsed stateful placement aligned across reconstructed compaction history", () => {
    const rawInput = [
      { type: "message", role: "user", content: "current turn" },
      { type: "compaction", encrypted_content: "ocx1:c3VtbWFyeQ==" },
    ];
    const parsed = parseRequest({ model: "gpt-5.5", input: rawInput, previous_response_id: "resp_remote" });

    injectDeveloperMessage(parsed, guidance);

    expect(rawInput[0]).toEqual(generatedItem());
    expect(parsed.context.messages.map(message => message.role)).toEqual(["developer", "user", "user"]);
  });

  test("stateful guidance dedup uses the latest tagged item across A-B-A transitions", () => {
    const guidanceA = "<multi_agent_mode>A</multi_agent_mode>";
    const guidanceB = "<multi_agent_mode>B</multi_agent_mode>";
    const parsed = parsedFixture({ rawInput: [generatedItem(guidanceA), { role: "user", content: "work" }] });
    parsed.previousResponseId = "resp_1";
    parsed._replayPrefixLen = 2;
    injectDeveloperMessage(parsed, guidanceB);

    const replay = parsedFixture({ rawInput: [
      ...(parsed._rawBody as { input: unknown[] }).input,
      { role: "assistant", content: "done" },
    ] });
    replay.previousResponseId = "resp_2";
    replay._replayPrefixLen = 4;
    injectDeveloperMessage(replay, guidanceB);
    expect((replay._rawBody as { input: unknown[] }).input).toHaveLength(4);
    injectDeveloperMessage(replay, guidanceA);
    expect((replay._rawBody as { input: unknown[] }).input.at(-1)).toEqual(generatedItem(guidanceA));
  });

  test("exact-guidance predicate rejects every near-match replay-prefix shape (#326)", () => {
    const nearMatches: Array<[string, unknown]> = [
      ["non-record item", null],
      ["wrong type", { ...generatedItem(), type: "other" }],
      ["wrong role", { ...generatedItem(), role: "user" }],
      ["non-array content", { type: "message", role: "developer", content: "guidance text" }],
      ["wrong content length", { type: "message", role: "developer", content: [] }],
      ["non-record part", { type: "message", role: "developer", content: [null] }],
      ["wrong part type", { type: "message", role: "developer", content: [{ type: "output_text", text: guidance }] }],
      ["different text", generatedItem("different guidance")],
      ["extra content part", {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: guidance }, { type: "input_text", text: "extra" }],
      }],
    ];

    for (const [label, nearMatch] of nearMatches) {
      const parsed = parsedFixture({ reasoning: "max", rawInput: [nearMatch] });
      parsed._replayPrefixLen = 1;
      injectDeveloperMessage(parsed, guidance);
      const rawInput = (parsed._rawBody as { input: unknown[] }).input;
      expect(countExact(rawInput), label).toBe(1);
      expect(parsed.context.messages.filter(message => message.role === "developer" && message.content === guidance), label)
        .toHaveLength(1);
    }
  });

  test("matching guidance in the current suffix does not suppress replay-prefix injection (#326)", () => {
    const parsed = parsedFixture({
      reasoning: "max",
      rawInput: [
        { type: "message", role: "user", content: "replayed" },
        generatedItem(),
      ],
    });
    parsed._replayPrefixLen = 1;
    injectDeveloperMessage(parsed, guidance);

    const rawInput = (parsed._rawBody as { input: unknown[] }).input;
    expect(countExact(rawInput)).toBe(2);
    expect(parsed.context.messages.filter(message => message.role === "developer" && message.content === guidance))
      .toHaveLength(1);
  });
});

describe("sanitizeEncryptedContentInPlace", () => {
  const fernetFixture = (): string => {
    const raw = Buffer.alloc(73, 0x5a);
    raw[0] = 0x80;
    raw.writeBigUInt64BE(1_720_000_000n, 1);
    const unpadded = raw.toString("base64url");
    return `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
  };

  test("plaintext parked in encrypted slots becomes input_text; real blobs survive", () => {
    const blob = "gAAAAAB".padEnd(120, "Qw1_-=");
    const input = [
      { type: "message", role: "user", content: [
        { type: "encrypted_content", encrypted_content: "[CXC-LEAF-GUARD] plain text with spaces" },
        { type: "input_text", text: "untouched" },
      ] },
      { type: "function_call_output", call_id: "c1", output: { content: [
        { type: "encrypted_content", encrypted_content: blob },
        { type: "encrypted_content", encrypted_content: "short" },
      ] } },
    ];
    const rewritten = sanitizeEncryptedContentInPlace(input);
    expect(rewritten).toBe(2);
    const msgParts = (input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(msgParts[0]).toEqual({ type: "input_text", text: "[CXC-LEAF-GUARD] plain text with spaces" });
    expect(msgParts[1]).toEqual({ type: "input_text", text: "untouched" });
    const outParts = ((input[1] as { output: { content: Array<Record<string, unknown>> } }).output).content;
    expect(outParts[0]).toEqual({ type: "encrypted_content", encrypted_content: blob });
    expect(outParts[1]).toEqual({ type: "input_text", text: "short" });
  });

  test("non-array input is a no-op", () => {
    expect(sanitizeEncryptedContentInPlace("plain")).toBe(0);
    expect(sanitizeEncryptedContentInPlace(undefined)).toBe(0);
  });

  test("deep unknown input does not overflow the call stack", () => {
    const root: Array<Record<string, unknown>> = [{ type: "unknown" }];
    let cursor = root[0]!;
    for (let depth = 0; depth < 30_000; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    cursor.content = [{ type: "encrypted_content", encrypted_content: "deep plaintext" }];

    expect(sanitizeEncryptedContentInPlace(root)).toBe(1);
    expect(cursor.content).toEqual([{ type: "input_text", text: "deep plaintext" }]);
  });

  test("nested agent messages normalize after child rewrites without changing the rewrite count", () => {
    const input = [{
      type: "agent_message",
      id: "outer",
      author: "/root",
      recipient: "/root/outer",
      content: [{
        type: "agent_message",
        id: "inner",
        author: "/root/outer",
        recipient: "/root/outer/inner",
        content: [
          { type: "encrypted_content", encrypted_content: "first plaintext" },
          { type: "encrypted_content", encrypted_content: "second plaintext" },
        ],
      }],
    }];

    expect(sanitizeEncryptedContentInPlace(input)).toBe(2);
    const outer = input[0] as Record<string, unknown>;
    const inner = (outer.content as Array<Record<string, unknown>>)[0]!;
    expect(outer).toMatchObject({ type: "message", role: "user" });
    expect(inner).toMatchObject({ type: "message", role: "user" });
    for (const message of [outer, inner]) {
      expect(message).not.toHaveProperty("id");
      expect(message).not.toHaveProperty("author");
      expect(message).not.toHaveProperty("recipient");
    }
  });

  test("mixed slot (hook preamble + embedded Fernet task) splits into text + encrypted parts", () => {
    const fernet = fernetFixture();
    const input = [
      { type: "agent_message", id: "mixed", author: "/root", recipient: "/root/worker", content: [
        { type: "encrypted_content", encrypted_content: `[CXC-LEAF-GUARD] follow the rules.\n\n${fernet}` },
      ] },
    ];
    expect(sanitizeEncryptedContentInPlace(input)).toBe(1);
    expect(input[0]).toMatchObject({
      type: "agent_message",
      id: "mixed",
      author: "/root",
      recipient: "/root/worker",
    });
    const parts = (input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "input_text", text: "[CXC-LEAF-GUARD] follow the rules.\n\n" });
    expect(parts[1]).toEqual({ type: "encrypted_content", encrypted_content: fernet });
  });

  test("pure Fernet slot stays byte-identical", () => {
    const fernet = fernetFixture();
    const input = [
      { type: "message", role: "user", content: [
        { type: "encrypted_content", encrypted_content: fernet },
      ] },
    ];
    expect(sanitizeEncryptedContentInPlace(input)).toBe(0);
    const parts = (input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(parts[0]).toEqual({ type: "encrypted_content", encrypted_content: fernet });
  });
});

describe("spawn-message delivery (agent_message + encrypted slot)", () => {
  test("sanitize-then-parse delivers the spawn task payload as a user message on routed paths", () => {
    // Mirrors handleResponses order: sanitize and normalize the RAW input, then parseRequest.
    // Regression for spawned sub-agents receiving empty task payloads when the routed parser
    // does not understand agent_message and its task rides in a plaintext encrypted slot.
    const body = {
      model: "anthropic/claude-fable-5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "env context" }] },
        { type: "agent_message", author: "/root", recipient: "/root/worker", content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: "TASK: build the thing exactly as specified." },
        ] },
      ],
    };
    expect(sanitizeEncryptedContentInPlace(body.input)).toBe(1);
    expect(body.input[1]).toMatchObject({ type: "message", role: "user" });
    const parsed = parseRequest(body);
    const users = parsed.context.messages.filter(m => m.role === "user");
    expect(users).toHaveLength(2);
    const content = users[1].content;
    const flat = typeof content === "string"
      ? content
      : (content as Array<{ type: string; text?: string }>).map(p => p.text ?? "").join("");
    expect(flat).toContain("Message Type: NEW_TASK");
    expect(flat).toContain("TASK: build the thing exactly as specified.");
  });
});
