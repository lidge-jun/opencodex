import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectGrokConfig, type GrokInjectModel } from "../src/grok/inject";
import { syncGrokConfig } from "../src/grok/sync";
import { nativeOpenAiContextWindow, nativeOpenAiSlugs, visibleNativeSlugs } from "../src/codex/catalog";
import type { CatalogModel } from "../src/codex/catalog";
import {
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../src/codex/model-entitlements";
import type { OcxConfig } from "../src/types";

const baseConfig = { port: 10100, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;

afterEach(() => resetCodexModelEntitlementCacheForTests());

function tempGrokHome(): { root: string; grokHome: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-grok-sync-"));
  const grokHome = join(root, ".grok");
  mkdirSync(grokHome);
  return { root, grokHome };
}

describe("syncGrokConfig", () => {
  test("injects natives plus routed models with catalog context windows", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const routed: CatalogModel[] = [
        { id: "grok-4.5", provider: "cursor", contextWindow: 500_000 } as CatalogModel,
      ];
      const result = await syncGrokConfig(10190, baseConfig, { grokHome }, {
        fetchAllModels: async () => routed,
        injectGrokConfig,
      });
      expect(result).toMatchObject({ ok: true, changed: true });
      const content = readFileSync(join(grokHome, "config.toml"), "utf8");
      // Native slugs come from visibleNativeSlugs(config) — at least one gpt native present.
      expect(content).toContain("[model.ocx-gpt-");
      expect(content).toContain("[model.ocx-cursor-grok-4-5]");
      expect(content).toContain("context_window = 500000");
      expect(content).toContain('base_url = "http://127.0.0.1:10190/v1"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies provider-hidden models from the unfiltered catalog without emitting them", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const config = {
        ...baseConfig,
        providers: { stub: { selectedModels: ["visible"] } },
      } as unknown as OcxConfig;
      const catalog = [
        { id: "visible", provider: "stub" } as CatalogModel,
        { id: "hidden", provider: "stub" } as CatalogModel,
      ];
      writeFileSync(join(grokHome, "config.toml"), [
        "[model.ocx-stub-hidden]",
        'model = "stub/hidden"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_backend = "responses"',
        'api_key = "opencodex-loopback"',
        'extra_headers = { "x-opencodex-grok" = "1" }',
        "",
      ].join("\n"));

      const result = await syncGrokConfig(10190, config, { grokHome }, {
        fetchAllModels: async () => catalog,
        injectGrokConfig,
      });
      expect(result).toMatchObject({ ok: true, changed: true });
      const content = readFileSync(join(grokHome, "config.toml"), "utf8");
      expect(content).toContain('model = "stub/visible"');
      expect(content).not.toContain("[model.ocx-stub-hidden]");
      expect(content).not.toContain('model = "stub/hidden"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes owned orphans from a disabled provider even without fetched ids", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const config = {
        ...baseConfig,
        providers: {
          "disabled-provider": {
            adapter: "openai-responses",
            baseUrl: "https://example.invalid/v1",
            disabled: true,
          },
        },
      } as unknown as OcxConfig;
      writeFileSync(join(grokHome, "config.toml"), [
        "[model.ocx-disabled-provider-legacy]",
        'model = "disabled-provider/legacy"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_backend = "responses"',
        'api_key = "opencodex-loopback"',
        'extra_headers = { "x-opencodex-grok" = "1" }',
        "",
      ].join("\n"));

      const result = await syncGrokConfig(10190, config, { grokHome }, {
        fetchAllModels: async () => [],
        injectGrokConfig,
      });
      expect(result).toMatchObject({ ok: true, changed: true });
      const content = readFileSync(join(grokHome, "config.toml"), "utf8");
      expect(content).not.toContain("[model.ocx-disabled-provider-legacy]");
      expect(content).not.toContain('model = "disabled-provider/legacy"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not reinterpret a slash-shaped combo alias as a disabled provider model", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const config = {
        ...baseConfig,
        providers: {
          "disabled-provider": {
            adapter: "openai-responses",
            baseUrl: "https://example.invalid/v1",
            disabled: true,
          },
        },
        combos: {
          fallback: {
            alias: "disabled-provider/legacy",
            targets: [{ provider: "other", model: "m1" }],
          },
        },
      } as unknown as OcxConfig;
      const manual = [
        "[model.ocx-disabled-provider-legacy]",
        'model = "disabled-provider/legacy"',
        'base_url = "http://127.0.0.1:10100/v1"',
        'api_backend = "responses"',
        'api_key = "opencodex-loopback"',
        'extra_headers = { "x-opencodex-grok" = "1" }',
        "",
      ].join("\n");
      writeFileSync(join(grokHome, "config.toml"), manual);

      const result = await syncGrokConfig(10190, config, { grokHome }, {
        fetchAllModels: async () => [],
        injectGrokConfig,
      });
      expect(result).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(join(grokHome, "config.toml"), "utf8")).toContain(manual);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps disabled native ids in the orphan-classification catalog", async () => {
    const hiddenNative = nativeOpenAiSlugs()[0]!;
    let emitted: GrokInjectModel[] | undefined;
    let catalogModelIds: ReadonlySet<string> | undefined;
    const result = await syncGrokConfig(
      10190,
      { ...baseConfig, disabledModels: [hiddenNative] } as OcxConfig,
      {},
      {
        fetchAllModels: async () => [],
        injectGrokConfig: ((port: number, models: GrokInjectModel[], opts: Parameters<typeof injectGrokConfig>[2]) => {
          void port;
          emitted = models;
          catalogModelIds = opts.catalogModelIds;
          return { ok: true, changed: false, message: "captured" };
        }) as typeof injectGrokConfig,
      },
    );
    expect(result.ok).toBe(true);
    expect(emitted?.some(model => model.id === hiddenNative)).toBe(false);
    expect(catalogModelIds?.has(hiddenNative)).toBe(true);
  });

  // Native slugs used to be injected as a bare { id }, so no `context_window` line was written
  // and Grok fell back to its own 200k default — understating gpt-5.6-sol, which is 372k. The
  // window comes from the same accessor the dashboard uses, so the two surfaces agree.
  test("native slugs carry their real context window, not Grok's 200k default", async () => {
    seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    const { root, grokHome } = tempGrokHome();
    try {
      const result = await syncGrokConfig(10190, baseConfig, { grokHome }, {
        fetchAllModels: async () => [],
        injectGrokConfig,
      });
      expect(result).toMatchObject({ ok: true, changed: true });
      const content = readFileSync(join(grokHome, "config.toml"), "utf8");

      const solBlock = content.slice(content.indexOf("[model.ocx-gpt-5-6-sol]"));
      expect(solBlock).toContain(`context_window = ${nativeOpenAiContextWindow("gpt-5.6-sol")}`);
      expect(nativeOpenAiContextWindow("gpt-5.6-sol")).toBe(272_000);

      // Each native block carries a window exactly when the catalog knows one. gpt-5.4-mini has
      // none recorded, and inject.ts deliberately omits the line rather than writing a
      // placeholder — asserting "every block has one" would encode a bug as a requirement.
      const windowBySlug = visibleNativeSlugs(baseConfig).map(slug => {
        const header = `[model.ocx-${slug.replace(/\./g, "-")}]`;
        const start = content.indexOf(header);
        if (start < 0) return `${slug}: MISSING BLOCK`;
        const rest = content.slice(start + header.length);
        const next = rest.indexOf("[model.");
        const block = next >= 0 ? rest.slice(0, next) : rest;
        const line = /context_window = (\d+)/.exec(block);
        return `${slug}: ${line ? line[1] : "none"}`;
      });
      const expectedBySlug = visibleNativeSlugs(baseConfig).map(slug => {
        const window = nativeOpenAiContextWindow(slug);
        return `${slug}: ${window ?? "none"}`;
      });
      expect(windowBySlug).toEqual(expectedBySlug);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the observed bind hostname reaches injection (ensure live branch)", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      // ensure's live branch passes live.hostname — the host the proxy ACTUALLY bound, which
      // can differ from a drifted config.hostname. A wildcard bind exposes every interface, so
      // injection must refuse rather than write a block that cannot authenticate.
      const wildcard = await syncGrokConfig(10100, baseConfig, { grokHome, hostname: "0.0.0.0" }, {
        fetchAllModels: async () => [],
        injectGrokConfig,
      });
      expect(wildcard).toMatchObject({ ok: true, changed: false, skippedReason: "non-loopback" });
      expect(existsSync(join(grokHome, "config.toml"))).toBe(false);

      const loopback = await syncGrokConfig(10100, baseConfig, { grokHome, hostname: "::1" }, {
        fetchAllModels: async () => [],
        injectGrokConfig,
      });
      expect(loopback).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(join(grokHome, "config.toml"), "utf8"))
        .toContain('base_url = "http://[::1]:10100/v1"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("catalog failure surfaces ok:false without touching the config", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const result = await syncGrokConfig(10100, baseConfig, { grokHome }, {
        fetchAllModels: async () => { throw new Error("proxy down"); },
        injectGrokConfig,
      });
      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(result.message).toContain("proxy down");
      expect(() => readFileSync(join(grokHome, "config.toml"), "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-sync is idempotent: one fence, latest catalog wins", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const deps = { fetchAllModels: async () => [], injectGrokConfig };
      await syncGrokConfig(10190, baseConfig, { grokHome }, {
        ...deps,
        fetchAllModels: async () => [{ id: "old", provider: "p" } as CatalogModel],
      });
      await syncGrokConfig(10190, baseConfig, { grokHome }, {
        ...deps,
        fetchAllModels: async () => [{ id: "new", provider: "p" } as CatalogModel],
      });
      const content = readFileSync(join(grokHome, "config.toml"), "utf8");
      expect(content.match(/>>> opencodex managed block/g) ?? []).toHaveLength(1);
      expect(content).not.toContain("[model.ocx-p-old]");
      expect(content).toContain("[model.ocx-p-new]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
