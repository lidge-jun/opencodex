import { describe, expect, test } from "bun:test";
import {
  accountBoundNativeDisplayName,
  accountBoundNativeModelSlugs,
  applyNativeVisibility,
  buildCatalogEntries,
  CODEX_ACCOUNT_BOUND_CATALOG_KIND,
  desktopAllowlistSuppressedNativeSlugs,
  disabledNativeSlugs,
  mergeCatalogEntriesForSync,
  NATIVE_OPENAI_MODELS,
  nativeModelRows,
  shouldIncludeAccountBoundNativeOpenAi,
  shouldIncludeNativeOpenAi,
  trustedAccountBoundNativeCatalogSlug,
  visibleCodexAccountSelectors,
  visibleNativeSlugs,
} from "../src/codex/catalog";
import { handleManagementAPI } from "../src/server/management-api";
import { applyMultiAgentMode, applyNativeOpenAiContextOverride } from "../src/codex/catalog/parsing";
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

  test("native aliases suppress their native dashboard row and activate Desktop allowlist pruning", () => {
    const config = makeConfig({
      disabledModels: ["gpt-5.6-sol", "gpt-5.5"],
      combos: {
        nova: {
          alias: "gpt-5.6-sol",
          nativeAlias: true,
          displayName: "Nova1 - Sol",
          targets: [{ provider: "nova", model: "codex/gpt-5.6-sol" }],
        },
      },
    });
    const rows = nativeModelRows(config);
    expect(rows.some(row => row.slug === "gpt-5.6-sol")).toBe(false);
    expect(rows.find(row => row.slug === "gpt-5.5")?.disabled).toBe(true);
    expect(desktopAllowlistSuppressedNativeSlugs(config))
      .toEqual(new Set(["gpt-5.6-sol", "gpt-5.5"]));
    expect(desktopAllowlistSuppressedNativeSlugs(makeConfig({
      disabledModels: ["gpt-5.5"],
    }))).toEqual(new Set());
  });

  test("configured public selectors replace bare picker rows with account-qualified native clones", () => {
    const template = nativeTemplate();
    template.comp_hash = "native-compaction-hash";
    const entries = buildCatalogEntries(
      template,
      ["gpt-5.5"],
      [{ provider: "litellm-local", id: "qwen3.6" }],
      ["gpt-5.5"],
      false,
      "default",
      new Set(),
      ["main-account", "side.account"],
    );
    applyNativeVisibility(entries, new Set(), true);

    const bare = entries.find(entry => entry.slug === "gpt-5.5");
    const main = entries.find(entry => entry.slug === "main-account/gpt-5.5");
    const side = entries.find(entry => entry.slug === "side.account/gpt-5.5");
    const routed = entries.find(entry => entry.slug === "litellm-local/qwen3.6");
    expect(bare?.visibility).toBe("hide");
    expect(main).toMatchObject({
      display_name: "main-account / 5.5",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      comp_hash: "native-compaction-hash",
      visibility: "list",
      priority: 0,
    });
    expect(main?.description).toBe(bare?.description);
    expect(side?.display_name).toBe("side.account / 5.5");
    expect(side?.priority).toBe(1);
    expect(side?.model_messages).toEqual(bare?.model_messages);
    expect(routed?.priority).toBeGreaterThan(side?.priority as number);
    expect(entries.every(entry => Number.isInteger(entry.priority))).toBe(true);
  });

  test("exact account disables hide only the matching generated picker row", () => {
    const entries = buildCatalogEntries(
      nativeTemplate(),
      ["gpt-5.5"],
      [],
      [],
      false,
      "default",
      new Set(),
      ["desktop", "team"],
    );
    applyNativeVisibility(entries, new Set(["team/gpt-5.5"]), true);

    expect(entries.find(entry => entry.slug === "gpt-5.5")?.visibility).toBe("hide");
    expect(entries.find(entry => entry.slug === "desktop/gpt-5.5")?.visibility).toBe("list");
    expect(entries.find(entry => entry.slug === "team/gpt-5.5")?.visibility).toBe("hide");

    const untrusted = [{ slug: "team/gpt-5.5", visibility: "list" }];
    applyNativeVisibility(untrusted, new Set(["team/gpt-5.5"]), true);
    expect(untrusted[0]?.visibility).toBe("list");
  });

  test("featured routed rows follow complete account-qualified priority groups", () => {
    const entries = buildCatalogEntries(
      nativeTemplate(),
      ["gpt-5.5"],
      [{ provider: "vendor", id: "model" }],
      ["gpt-5.5", "vendor/model"],
      false,
      "default",
      new Set(),
      ["one", "two", "three"],
    );
    applyNativeVisibility(entries, new Set(), true);

    const visible = entries
      .filter(entry => entry.visibility === "list")
      .sort((left, right) => Number(left.priority) - Number(right.priority));
    expect(visible.slice(0, 4).map(entry => entry.slug)).toEqual([
      "one/gpt-5.5",
      "two/gpt-5.5",
      "three/gpt-5.5",
      "vendor/model",
    ]);
    expect(visible.slice(0, 4).map(entry => entry.priority)).toEqual([0, 1, 2, 3]);
  });

  test("generated-row ownership uses only the nonsemantic marker and qualified slug shape", () => {
    expect(trustedAccountBoundNativeCatalogSlug({
      slug: "side/gpt-5.6-sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    })).toBe("gpt-5.6-sol");
    expect(trustedAccountBoundNativeCatalogSlug({ slug: "side/gpt-5.6-sol" })).toBeUndefined();
    expect(trustedAccountBoundNativeCatalogSlug({
      slug: "/gpt-5.6-sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    })).toBeUndefined();
    expect(trustedAccountBoundNativeCatalogSlug({
      slug: "side/",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    })).toBeUndefined();
    expect(trustedAccountBoundNativeCatalogSlug({
      slug: "gpt-5.6-sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    })).toBeUndefined();
    expect(trustedAccountBoundNativeCatalogSlug({
      slug: "side/nested/gpt-5.6-sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    })).toBeUndefined();
  });

  test("native metadata helpers trust only marked, well-shaped account rows", () => {
    const trusted = {
      slug: "side/gpt-5.6-luna",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      context_window: 128_000,
      max_context_window: 128_000,
      auto_compact_token_limit: 115_200,
      multi_agent_version: "v2",
    };
    const malformed = {
      ...trusted,
      slug: "side/nested/gpt-5.6-luna",
    };
    const unmarked = {
      ...trusted,
      slug: "provider/gpt-5.6-luna",
      opencodex_catalog_kind: undefined,
    };

    applyNativeOpenAiContextOverride(trusted);
    applyNativeOpenAiContextOverride(malformed);
    applyNativeOpenAiContextOverride(unmarked);
    expect(trusted).toMatchObject({
      context_window: 372_000,
      max_context_window: 372_000,
      auto_compact_token_limit: 334_800,
    });
    expect(malformed).toMatchObject({
      context_window: 128_000,
      max_context_window: 128_000,
      auto_compact_token_limit: 115_200,
    });
    expect(unmarked).toMatchObject({
      context_window: 128_000,
      max_context_window: 128_000,
      auto_compact_token_limit: 115_200,
    });

    applyMultiAgentMode([trusted, malformed, unmarked], "default");
    expect(trusted.multi_agent_version).toBe("v1");
    expect(malformed.multi_agent_version).toBeUndefined();
    expect(unmarked.multi_agent_version).toBeUndefined();
  });

  test("native availability mirrors the built-in OpenAI auth-mode default", () => {
    const canonical = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    } as const;
    expect(shouldIncludeNativeOpenAi({ providers: {} })).toBe(true);
    expect(shouldIncludeNativeOpenAi({ providers: { openai: canonical } })).toBe(true);
    expect(shouldIncludeNativeOpenAi({
      providers: { openai: { ...canonical, authMode: "forward" } },
    })).toBe(true);
    expect(shouldIncludeNativeOpenAi({
      providers: { openai: { ...canonical, authMode: "key" } },
    })).toBe(false);
    expect(shouldIncludeNativeOpenAi({
      providers: { openai: { ...canonical, baseUrl: "https://api.example.test/v1" } },
    })).toBe(false);
    expect(shouldIncludeNativeOpenAi({
      providers: { openai: { ...canonical, disabled: true } },
    })).toBe(true);
    expect(shouldIncludeAccountBoundNativeOpenAi({ providers: {} })).toBe(false);
    expect(shouldIncludeAccountBoundNativeOpenAi({ providers: { openai: canonical } })).toBe(true);
    expect(shouldIncludeAccountBoundNativeOpenAi({
      providers: { openai: { ...canonical, disabled: true } },
    })).toBe(false);
    expect(shouldIncludeAccountBoundNativeOpenAi({
      providers: { openai: { ...canonical, authMode: "key" } },
    })).toBe(false);
  });

  test("case-distinct routing selectors remain distinguishable in picker labels", () => {
    expect(accountBoundNativeDisplayName("work", nativeTemplate())).toBe("work / 5.5");
    expect(accountBoundNativeDisplayName("Work", nativeTemplate())).toBe("Work / 5.5");
  });

  test("catalog discovery uses public selectors only and drops mappings to missing accounts", () => {
    const config = {
      codexAccounts: [{
        id: "stored-side-account",
        email: "private@example.test",
        alias: "Private Display Name",
        isMain: false,
      }],
      codexAccountNamespaces: {
        desktop: "@main",
        team: "stored-side-account",
        removed: "missing-account",
      },
    };
    expect(visibleCodexAccountSelectors(config)).toEqual(["desktop", "team"]);
    expect(accountBoundNativeModelSlugs(config, ["gpt-5.5"])).toEqual([
      "desktop/gpt-5.5",
      "team/gpt-5.5",
    ]);
    expect(JSON.stringify(accountBoundNativeModelSlugs(config, ["gpt-5.5"])))
      .not.toContain("stored-side-account");
  });

  test("picker visibility hides generated catalog rows without deleting routing bindings", () => {
    const codexAccountNamespaces = { desktop: "@main", team: "stored-side-account" };
    const config = {
      codexAccounts: [{ id: "stored-side-account", isMain: false }],
      codexAccountNamespaces,
      codexAccountPickerEnabled: false,
    };

    expect(visibleCodexAccountSelectors(config)).toEqual([]);
    expect(accountBoundNativeModelSlugs(config, ["gpt-5.5"])).toEqual([]);
    expect(config.codexAccountNamespaces).toBe(codexAccountNamespaces);

    config.codexAccountPickerEnabled = true;
    expect(visibleCodexAccountSelectors(config)).toEqual(["desktop", "team"]);

    expect(visibleCodexAccountSelectors({
      codexAccounts: config.codexAccounts,
      codexAccountNamespaces: {},
      codexAccountPickerEnabled: true,
    })).toEqual([]);
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

  test("disabled native state is mirrored onto its account-qualified clones", () => {
    const entries = [{
      slug: "side/gpt-5.6-sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      visibility: "list",
    }];
    applyNativeVisibility(entries, new Set(["gpt-5.6-sol"]), true);
    expect(entries[0].visibility).toBe("hide");
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
import { ManagementRequest as Request } from "./helpers/management-auth";
