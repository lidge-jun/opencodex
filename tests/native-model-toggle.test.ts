import { describe, expect, test } from "bun:test";
import {
  accountBoundNativeDisplayName,
  appendDefaultCodexAccountNamespace,
  codexAccountPickerHasVisibleRows,
  codexAccountPickerIsEnabled,
  defaultCodexAccountNamespaces,
  visibleCodexAccountNamespaces,
} from "../src/codex/account-namespaces";
import {
  applyNativeVisibility,
  buildCatalogEntries,
  disabledNativeSlugs,
  mergeCatalogEntriesForSync,
  NATIVE_OPENAI_MODELS,
  nativeModelRows,
  visibleNativeSlugs,
} from "../src/codex/catalog";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...overrides } as OcxConfig;
}

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "high", description: "native high" },
    ],
  };
}

describe("native GPT model toggles (bare slugs in disabledModels)", () => {
  test("account replacement labels title-case synthesized slug words", () => {
    expect(accountBoundNativeDisplayName("side-account", { slug: "gpt-5.3-codex-spark" }))
      .toBe("Side-Account / 5.3 Codex Spark");
  });

  test("account replacement labels preserve separators that distinguish local ids", () => {
    expect([
      accountBoundNativeDisplayName("team-prod", { slug: "gpt-5.5" }),
      accountBoundNativeDisplayName("team_prod", { slug: "gpt-5.5" }),
      accountBoundNativeDisplayName("team.prod", { slug: "gpt-5.5" }),
    ]).toEqual([
      "Team-Prod / 5.5",
      "Team_Prod / 5.5",
      "Team.Prod / 5.5",
    ]);
  });

  test("UI defaults use stable local account ids without exposing aliases or email labels", () => {
    const namespaces = defaultCodexAccountNamespaces({
      providers: {
        "side-id": { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      codexAccounts: [
        { id: "side-id", email: "private@example.test", alias: "Side", isMain: false },
        { id: "team-id", email: "other@example.test", alias: "Product Team", isMain: false },
      ],
    });
    expect(namespaces).toEqual({ main: "main", "side-id-2": "side-id", "team-id": "team-id" });
    expect(JSON.stringify(namespaces)).not.toContain("example.test");
    expect(JSON.stringify(namespaces)).not.toContain("Product Team");
  });

  test("UI defaults avoid prefixes already owned by combo aliases", () => {
    const namespaces = defaultCodexAccountNamespaces({
      providers: {},
      combos: {
        primary: { alias: "main/gpt-5.5", targets: [{ provider: "openai", model: "gpt-5.5" }] },
        secondary: { alias: "side-id/gpt-5.6-sol", targets: [{ provider: "openai", model: "gpt-5.6-sol" }] },
      },
      codexAccounts: [
        { id: "side-id", email: "side@example.test", isMain: false },
      ],
    });
    expect(namespaces).toEqual({ "main-2": "main", "side-id-2": "side-id" });
  });

  test("new accounts append to an enabled map without renaming existing prefixes", () => {
    const config = {
      providers: { "side-id": { adapter: "openai-chat" as const, baseUrl: "https://example.test/v1" } },
      codexAccountNamespaces: { main: "main", legacy: "legacy-id" },
    };
    expect(appendDefaultCodexAccountNamespace(config, {
      id: "side-id",
      isMain: false,
    })).toBe(true);
    expect(config.codexAccountNamespaces).toEqual({
      main: "main",
      legacy: "legacy-id",
      "side-id-2": "side-id",
    });
    expect(appendDefaultCodexAccountNamespace(config, {
      id: "side-id",
      isMain: false,
    })).toBe(false);
  });

  test("empty maps stay disabled and reserved main ids never become added-account selectors", () => {
    const empty = { providers: {}, codexAccountNamespaces: {} as Record<string, string> };
    expect(appendDefaultCodexAccountNamespace(empty, { id: "side", isMain: false })).toBe(false);
    expect(empty.codexAccountNamespaces).toEqual({});

    const namespaces = defaultCodexAccountNamespaces({
      providers: {},
      codexAccounts: [
        { id: "main", email: "reserved-one@example.test", isMain: false },
        { id: "__main__", email: "reserved-two@example.test", isMain: false },
        { id: "side", email: "side@example.test", isMain: false },
      ],
    });
    expect(namespaces).toEqual({ main: "main", side: "side" });
  });

  test("picker visibility defaults on for legacy maps and preserves dormant mappings", () => {
    const legacy = { codexAccountNamespaces: { main: "main" } };
    expect(codexAccountPickerIsEnabled(legacy)).toBe(true);
    expect(visibleCodexAccountNamespaces(legacy)).toEqual({ main: "main" });

    const dormant = {
      providers: {},
      codexAccountNamespaces: { main: "main" },
      codexAccountPickerEnabled: false,
    };
    expect(codexAccountPickerIsEnabled(dormant)).toBe(false);
    expect(visibleCodexAccountNamespaces(dormant)).toEqual({});
    expect(appendDefaultCodexAccountNamespace(dormant, { id: "side", isMain: false })).toBe(true);
    expect(dormant.codexAccountNamespaces).toEqual({ main: "main", side: "side" });
    expect(codexAccountPickerIsEnabled(dormant)).toBe(false);
  });

  test("stale-only picker bindings preserve intent without hiding bare native rows", () => {
    const stale = {
      codexAccounts: [],
      codexAccountNamespaces: { removed: "removed-account" },
      codexAccountPickerEnabled: true,
    };
    expect(codexAccountPickerIsEnabled(stale)).toBe(true);
    expect(visibleCodexAccountNamespaces(stale)).toEqual({});
    expect(codexAccountPickerHasVisibleRows(stale)).toBe(false);

    const entries = [nativeTemplate()];
    applyNativeVisibility(entries, new Set(), codexAccountPickerHasVisibleRows(stale));
    expect(entries[0]?.visibility).toBe("list");
  });

  test("disabledNativeSlugs picks bare ids only; routed namespaced ids are ignored", () => {
    const set = disabledNativeSlugs({ disabledModels: ["gpt-5.4", "kiro/claude-opus-4.6", "gpt-5.6-luna"] });
    expect([...set].sort()).toEqual(["gpt-5.4", "gpt-5.6-luna"]);
  });

  test("visibleNativeSlugs omits disabled natives from the bare availability list", () => {
    const all = visibleNativeSlugs({ disabledModels: [] });
    // Use gpt-5.6-sol: guaranteed present (documented native addition, always in the list
    // regardless of whether a live catalog exists — CI has no catalog file).
    const filtered = visibleNativeSlugs({ disabledModels: ["gpt-5.6-sol", "cursor/gpt-5.4"] });
    expect(all).toContain("gpt-5.6-sol");
    expect(filtered).not.toContain("gpt-5.6-sol");
    // Routed blocklist entries never affect the native list.
    expect(filtered.length).toBe(all.length - 1);
  });

  test("nativeModelRows lists the full static supported set regardless of disabled state", () => {
    const rows = nativeModelRows({ disabledModels: ["gpt-5.6-sol"] });
    expect(rows.map(r => r.slug)).toEqual([...NATIVE_OPENAI_MODELS]);
    expect(rows.find(r => r.slug === "gpt-5.6-sol")?.disabled).toBe(true);
    expect(rows.find(r => r.slug === "gpt-5.5")?.disabled).toBe(false);
    // Known context metadata rides along for the dashboard.
    expect(rows.find(r => r.slug === "gpt-5.6-sol")?.contextWindow).toBe(372_000);
  });

  test("catalog sync flips supported natives to visibility hide and restores list on re-enable", () => {
    const native = nativeTemplate();
    const disabledOnce = mergeCatalogEntriesForSync(
      [native], [], new Map(), [], false, new Set(), null, new Set(["gpt-5.5"]),
    );
    expect(disabledOnce.find(e => e.slug === "gpt-5.5")?.visibility).toBe("hide");

    // Re-enable: the SAME preserved (hidden) entry flips back to list on the next sync.
    const reEnabled = mergeCatalogEntriesForSync(
      disabledOnce, [], new Map(), [], false, new Set(), null, new Set(),
    );
    expect(reEnabled.find(e => e.slug === "gpt-5.5")?.visibility).toBe("list");
  });

  test("visibility hide survives the upstream-upgrade branch for synthesized 5.6 entries", () => {
    // Fallback-quality luna (display_name === slug) gets upgraded to the snapshot entry AND
    // must still come out hidden when disabled — the flip runs as the last pass.
    const synthesizedLuna = {
      ...nativeTemplate(),
      slug: "gpt-5.6-luna",
      display_name: "gpt-5.6-luna",
    };
    const merged = mergeCatalogEntriesForSync(
      [synthesizedLuna], [], new Map(), [], false, new Set(), null, new Set(["gpt-5.6-luna"]),
    );
    const luna = merged.find(e => e.slug === "gpt-5.6-luna");
    expect(luna?.display_name).toBe("GPT-5.6-Luna"); // upgrade branch fired
    expect(luna?.visibility).toBe("hide"); // ...and could not clobber the hide flag
  });

  test("backfilled missing natives are synthesized hidden while disabled", () => {
    // Catalog has ONE native (the template source); every other supported slug is backfilled.
    const merged = mergeCatalogEntriesForSync(
      [nativeTemplate()], [], new Map(), [], false, new Set(), nativeTemplate() as never, new Set(["gpt-5.6-terra"]),
    );
    const terra = merged.find(e => e.slug === "gpt-5.6-terra");
    expect(terra).toBeDefined();
    expect(terra?.visibility).toBe("hide");
    // A non-disabled backfilled sibling stays picker-visible.
    expect(merged.find(e => e.slug === "gpt-5.6-sol")?.visibility).toBe("list");
  });

  test("applyNativeVisibility never touches routed or unsupported entries", () => {
    const entries = [
      { slug: "kiro/claude-opus-4.6", visibility: "list" },
      { slug: "gpt-legacy-unsupported", visibility: "list" },
    ];
    applyNativeVisibility(entries, new Set(["kiro/claude-opus-4.6", "gpt-legacy-unsupported"]));
    expect(entries[0].visibility).toBe("list");
    expect(entries[1].visibility).toBe("list");
  });

  test("applyNativeVisibility mirrors disabled native state onto account-qualified clones", () => {
    const entries = [
      {
        slug: "side/gpt-5.6-sol",
        description: "OpenAI native model bound to a Codex account namespace.",
        visibility: "list",
      },
    ];
    applyNativeVisibility(entries, new Set(["gpt-5.6-sol"]));
    expect(entries[0].visibility).toBe("hide");
  });

  test("account namespaces hide bare rows and substitute friendly account-qualified pairs", () => {
    const entries = buildCatalogEntries(
      nativeTemplate(),
      ["gpt-5.5"],
      [{ provider: "litellm-local", id: "qwen3.6" }],
      ["gpt-5.5"],
      false,
      "default",
      new Set(),
      { main: "main", side: "side-account-id" },
    );
    applyNativeVisibility(entries, new Set(), true);

    const bare = entries.find(entry => entry.slug === "gpt-5.5");
    const main = entries.find(entry => entry.slug === "main/gpt-5.5");
    const side = entries.find(entry => entry.slug === "side/gpt-5.5");
    const routed = entries.find(entry => entry.slug === "litellm-local/qwen3.6");
    expect(bare?.visibility).toBe("hide");
    expect(main).toMatchObject({
      display_name: "Main / 5.5",
      visibility: "list",
      priority: 0,
    });
    expect(side?.display_name).toBe("Side / 5.5");
    expect(side?.visibility).toBe("list");
    expect(side?.priority).toBeGreaterThan(main?.priority as number);
    expect(side?.priority).toBe(1);
    expect(routed?.priority).toBeGreaterThan(side?.priority as number);
    expect(entries.every(entry => Number.isInteger(entry.priority))).toBe(true);
  });

  test("catalog sync removes stale account-qualified rows when routed discovery is empty", () => {
    const merged = mergeCatalogEntriesForSync(
      [
        nativeTemplate(),
        {
          ...nativeTemplate(),
          slug: "side/gpt-5.5",
          description: "OpenAI native model bound to a Codex account namespace.",
        },
      ],
      [],
      new Map(),
      [],
      false,
    );

    expect(merged.some(entry => entry.slug === "side/gpt-5.5")).toBe(false);
    expect(merged.some(entry => entry.slug === "gpt-5.5")).toBe(true);
  });

  test("management API surfaces: /api/models leads with native rows; subagent available drops disabled bare slugs", async () => {
    const config = makeConfig({ disabledModels: ["gpt-5.6-sol"] });

    const modelsRes = await handleManagementAPI(
      new Request("http://localhost/api/models"), new URL("http://localhost/api/models"), config,
    );
    const rows = await modelsRes!.json() as Array<{ namespaced: string; native?: boolean; disabled: boolean }>;
    const nativeRows = rows.filter(r => r.native);
    expect(nativeRows.map(r => r.namespaced)).toEqual([...NATIVE_OPENAI_MODELS]);
    expect(nativeRows.find(r => r.namespaced === "gpt-5.6-sol")?.disabled).toBe(true);
    // Native rows lead the response so the GUI pins the group first.
    expect(rows[0]?.native).toBe(true);

    const subRes = await handleManagementAPI(
      new Request("http://localhost/api/subagent-models"), new URL("http://localhost/api/subagent-models"), config,
    );
    const sub = await subRes!.json() as { available: string[] };
    // Bare disabled slugs flow through the existing namespaced-string filter automatically.
    expect(sub.available).not.toContain("gpt-5.6-sol");
    expect(sub.available).toContain("gpt-5.6-terra");
  });
});
