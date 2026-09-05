import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveAutoReviewModel } from "../src/providers/derive";
import { applyAutoReviewModelOverride, deriveEntry, finalizeAutoReviewModelOverride, resetCatalogRuntimeStateForTests, validateAutoReviewOverridesAgainstCatalog } from "../src/codex/catalog/sync";
import { applyProviderConfigHints } from "../src/codex/catalog/provider-fetch";
import {
  autoReviewModelConfigError,
  normalizeAutoReviewModelFields,
  sanitizeAutoReviewOverridesForLoad,
} from "../src/config/provider-validation";
import { loadConfig } from "../src/config";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { routedProviderConfig } from "../src/router";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "../src/codex/catalog/parsing";
import type { OcxProviderConfig } from "../src/types";

describe("resolveAutoReviewModel", () => {
  test("per-model override wins over provider-wide", () => {
    const provider = {
      autoReviewModel: "deepseek-v4-pro",
      autoReviewModelOverrides: { "deepseek-v4-flash-vision-exp": "deepseek-v4-flash" },
    } as OcxProviderConfig;
    expect(resolveAutoReviewModel(provider, "deepseek-v4-flash-vision-exp")).toBe("deepseek-v4-flash");
    expect(resolveAutoReviewModel(provider, "deepseek-v4-flash")).toBe("deepseek-v4-pro");
  });

  test("provider-wide default applies when no per-model entry exists", () => {
    const provider = { autoReviewModel: "  deepseek-v4-flash  " } as OcxProviderConfig;
    expect(resolveAutoReviewModel(provider, "anything")).toBe("deepseek-v4-flash");
  });

  test("per-model lookup falls back to the :family prefix", () => {
    const provider = {
      autoReviewModelOverrides: {
        "deepseek-v4-flash-vision-exp": "deepseek-v4-flash",
      },
    } as OcxProviderConfig;
    expect(resolveAutoReviewModel(provider, "deepseek-v4-flash-vision-exp:beta")).toBe("deepseek-v4-flash");
  });

  test("per-model lookup case-folds override keys", () => {
    const provider = {
      autoReviewModelOverrides: {
        "DEEPSEEK-V4-FLASH": "deepseek-v4-pro",
      },
    } as OcxProviderConfig;
    expect(resolveAutoReviewModel(provider, "deepseek-v4-flash")).toBe("deepseek-v4-pro");
  });

  test("per-model lookup case-folds the :family prefix", () => {
    const provider = {
      autoReviewModelOverrides: {
        "DEEPSEEK-V4-FLASH": "deepseek-v4-pro",
      },
    } as OcxProviderConfig;
    expect(resolveAutoReviewModel(provider, "deepseek-v4-flash:beta")).toBe("deepseek-v4-pro");
  });

  test("a case-differing full-model override wins over the case-folded family", () => {
    const provider = {
      autoReviewModelOverrides: {
        "DEEPSEEK-V4-FLASH:beta": "deepseek-v4-flash-specific",
        "DEEPSEEK-V4-FLASH": "deepseek-v4-pro",
      },
    } as OcxProviderConfig;
    expect(resolveAutoReviewModel(provider, "deepseek-v4-flash:beta")).toBe("deepseek-v4-flash-specific");
  });

  test("returns null when nothing is configured", () => {
    expect(resolveAutoReviewModel({} as OcxProviderConfig, "m")).toBeNull();
    expect(resolveAutoReviewModel(undefined, "m")).toBeNull();
  });
});

describe("catalog stamping", () => {
  const template = { auto_review_model_override: null, context_window: 272000 } as Record<string, unknown>;

  test("stamps a pre-normalized provider/model slug verbatim", () => {
    const model: CatalogModel = {
      id: "deepseek-v4-flash-vision-exp",
      provider: "deepseek",
      autoReviewModelOverride: "deepseek/deepseek-v4-flash",
    };
    const entry = deriveEntry(template, "deepseek/deepseek-v4-flash-vision-exp", "desc", 5, model);
    expect(entry.auto_review_model_override).toBe("deepseek/deepseek-v4-flash");
  });

  test("stamps the override in the no-template fallback branch", () => {
    const model: CatalogModel = {
      id: "m",
      provider: "blsc",
      autoReviewModelOverride: "deepseek/deepseek-v4-flash",
    };
    const entry = deriveEntry(null, "blsc/m", "desc", 5, model);
    expect(entry.auto_review_model_override).toBe("deepseek/deepseek-v4-flash");
  });

  test("no override keeps the template value", () => {
    const model: CatalogModel = { id: "m", provider: "blsc" };
    const entry = deriveEntry(template, "blsc/m", "desc", 5, model);
    expect(entry.auto_review_model_override).toBeNull();
  });
});

describe("provider-fetch hints", () => {
  test("attaches the override for a known bare target", () => {
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      models: ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
      autoReviewModel: "deepseek-v4-flash",
    } as unknown as OcxProviderConfig;
    const hinted = applyProviderConfigHints("deepseek", prov, {
      id: "deepseek-v4-flash-vision-exp",
      provider: "deepseek",
    });
    expect(hinted.autoReviewModelOverride).toBe("deepseek/deepseek-v4-flash");
  });

  test("case-differing target matches and encodes the canonical provider id", () => {
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      models: ["deepseek-v4-flash"],
      autoReviewModel: "DeepSeek-V4-Flash",
    } as unknown as OcxProviderConfig;
    const hinted = applyProviderConfigHints("deepseek", prov, {
      id: "deepseek-v4-flash-vision-exp",
      provider: "deepseek",
    });
    expect(hinted.autoReviewModelOverride).toBe("deepseek/deepseek-v4-flash");
  });

  test("current row id wins case-folded canonicalization so the slug matches the emitted row", () => {
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      models: ["DeepSeek-V4-Flash"],
      autoReviewModel: "DeepSeek-V4-Flash",
    } as unknown as OcxProviderConfig;
    const hinted = applyProviderConfigHints("deepseek", prov, {
      id: "deepseek-v4-flash",
      provider: "deepseek",
    });
    expect(hinted.autoReviewModelOverride).toBe("deepseek/deepseek-v4-flash");
    const entries: Array<Record<string, unknown>> = [
      { slug: "deepseek/deepseek-v4-flash", auto_review_model_override: hinted.autoReviewModelOverride },
    ];
    validateAutoReviewOverridesAgainstCatalog(entries);
    expect(entries[0].auto_review_model_override).toBe("deepseek/deepseek-v4-flash");
  });

  test("captured known-model ids back membership without a registry read", () => {
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://custom-openai.example/v1",
      autoReviewModel: "DeepSeek-V4-Flash",
    } as unknown as OcxProviderConfig;
    const hinted = applyProviderConfigHints(
      "deepseek",
      prov,
      { id: "deepseek-v4-flash", provider: "deepseek" },
      undefined,
      undefined,
      ["DeepSeek-V4-Flash"],
    );
    expect(hinted.autoReviewModelOverride).toBe("deepseek/deepseek-v4-flash");
  });

  test("encodes a slashed native id into the provider slug", () => {
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://zenmux.example/v1",
      models: ["moonshotai/kimi-k3-free"],
      autoReviewModel: "moonshotai/kimi-k3-free",
    } as unknown as OcxProviderConfig;
    const hinted = applyProviderConfigHints("zenmux", prov, {
      id: "moonshotai/kimi-k3-free",
      provider: "zenmux",
    });
    expect(hinted.autoReviewModelOverride).toBe("zenmux/moonshotai-kimi-k3-free");
  });

  test("keeps a namespaced cross-provider target verbatim", () => {
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://blsc.example/v1",
      models: ["glm-5.2"],
      autoReviewModel: "deepseek/deepseek-v4-flash",
    } as unknown as OcxProviderConfig;
    const hinted = applyProviderConfigHints("blsc", prov, { id: "glm-5.2", provider: "blsc" });
    expect(hinted.autoReviewModelOverride).toBe("deepseek/deepseek-v4-flash");
  });

  test("skips an unknown bare target without stamping", () => {
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      models: ["deepseek-v4-flash"],
      autoReviewModel: "does-not-exist",
    } as unknown as OcxProviderConfig;
    const hinted = applyProviderConfigHints("deepseek", prov, {
      id: "deepseek-v4-flash-vision-exp",
      provider: "deepseek",
    });
    expect(hinted.autoReviewModelOverride).toBeUndefined();
  });

  test("clears a stale override when the config is removed", () => {
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://blsc.example/v1",
      models: ["glm-5.2"],
    } as unknown as OcxProviderConfig;
    const hinted = applyProviderConfigHints("blsc", prov, {
      id: "glm-5.2",
      provider: "blsc",
      autoReviewModelOverride: "stale/deepseek-v4-pro",
    });
    expect(hinted.autoReviewModelOverride).toBeUndefined();
  });
});

describe("assembled-catalog validation", () => {
  test("drops overrides that do not name an emitted model", () => {
    const entries: Array<Record<string, unknown>> = [
      { slug: "blsc/glm-5.2", auto_review_model_override: "deepseek/deepseek-v4-flash" },
      { slug: "deepseek/deepseek-v4-flash" },
    ];
    validateAutoReviewOverridesAgainstCatalog(entries);
    expect(entries[0].auto_review_model_override).toBe("deepseek/deepseek-v4-flash");
    entries[0].auto_review_model_override = "blsc/does-not-exist";
    validateAutoReviewOverridesAgainstCatalog(entries);
    expect(entries[0].auto_review_model_override).toBeNull();
  });

  test("native rows keep upstream-retained overrides even when the target is not emitted", () => {
    const entries: Array<Record<string, unknown>> = [
      { slug: "gpt-5.4", auto_review_model_override: "native-upstream" },
      { slug: "static/deepseek-v4-flash", auto_review_model_override: "static/deepseek-v4-flash" },
    ];
    validateAutoReviewOverridesAgainstCatalog(entries);
    expect(entries[0].auto_review_model_override).toBe("native-upstream");
    expect(entries[1].auto_review_model_override).toBe("static/deepseek-v4-flash");
  });

  test("missing or malformed slugs never become matchable override targets", () => {
    const entries: Array<Record<string, unknown>> = [
      { slug: undefined, auto_review_model_override: "undefined" },
      { slug: null, auto_review_model_override: "null" },
      { slug: "", auto_review_model_override: "blsc/m" },
      { slug: "other/m" },
    ];
    validateAutoReviewOverridesAgainstCatalog(entries);
    expect(entries[0].auto_review_model_override).toBeNull();
    expect(entries[1].auto_review_model_override).toBeNull();
    expect(entries[2].auto_review_model_override).toBeNull();
  });

  test("normalizes wrong-shaped routed overrides to null before serialization", () => {
    const entries: Array<Record<string, unknown>> = [
      { slug: "blsc/glm-5.2", auto_review_model_override: 42 },
      { slug: "deepseek/deepseek-v4-flash", auto_review_model_override: { nested: true } },
      { slug: "static/null", auto_review_model_override: null },
      { slug: "static/undefined", auto_review_model_override: undefined },
      { slug: "deepseek/deepseek-v4-pro" },
    ];
    validateAutoReviewOverridesAgainstCatalog(entries);
    expect(entries[0].auto_review_model_override).toBeNull();
    expect(entries[1].auto_review_model_override).toBeNull();
    expect(entries[2].auto_review_model_override).toBeNull();
    expect(entries[3].auto_review_model_override).toBeUndefined();
  });

  test("native rows normalize wrong-shaped overrides but keep valid nonblank strings", () => {
    const entries: Array<Record<string, unknown>> = [
      { slug: "gpt-5.4", auto_review_model_override: 42 },
      { slug: "gpt-5.4-mini", auto_review_model_override: { nested: true } },
      { slug: "gpt-5.4-nano", auto_review_model_override: "" },
      { slug: "gpt-5.4-plus", auto_review_model_override: "native-upstream" },
      { slug: "gpt-5.4-ultra", auto_review_model_override: null },
    ];
    validateAutoReviewOverridesAgainstCatalog(entries);
    expect(entries[0].auto_review_model_override).toBeNull();
    expect(entries[1].auto_review_model_override).toBeNull();
    expect(entries[2].auto_review_model_override).toBeNull();
    expect(entries[3].auto_review_model_override).toBe("native-upstream");
    expect(entries[4].auto_review_model_override).toBeNull();
  });
});

describe("load sanitization", () => {
  let testRoot = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    testRoot = mkdtempSync(join(import.meta.dir, ".tmp-auto-review-load-"));
    process.env.OPENCODEX_HOME = testRoot;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(testRoot, { recursive: true, force: true });
  });

  test("malformed auto-review fields are sanitized instead of retiring the config", () => {
    writeFileSync(join(testRoot, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "test",
      providers: {
        test: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          apiKey: "sk-test",
          autoReviewModel: "  ",
          autoReviewModelOverrides: { " bad key ": "deepseek-v4-flash", "glm-5.2": "  " },
        },
      },
    }));
    const loaded = loadConfig();
    expect(loaded.providers.test?.autoReviewModel).toBeUndefined();
    expect(loaded.providers.test?.autoReviewModelOverrides).toBeUndefined();
  });

  test("load sanitization removes override maps with canonical collisions and keeps unrelated providers", () => {
    writeFileSync(join(testRoot, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "caseCollider",
      providers: {
        caseCollider: {
          adapter: "openai-chat",
          baseUrl: "https://case.example.test/v1",
          apiKey: "sk-test",
          autoReviewModelOverrides: {
            "DEEPSEEK-V4-FLASH": "deepseek-v4-pro",
            "deepseek-v4-flash": "deepseek-v4-flash",
          },
        },
        trimCollider: {
          adapter: "openai-chat",
          baseUrl: "https://trim.example.test/v1",
          apiKey: "sk-test",
          autoReviewModelOverrides: {
            " model-a ": "deepseek-v4-pro",
            "model-a": "deepseek-v4-flash",
          },
        },
        unrelated: {
          adapter: "openai-chat",
          baseUrl: "https://unrelated.example.test/v1",
          apiKey: "sk-test",
          autoReviewModel: "deepseek-v4-flash",
        },
      },
    }));
    const loaded = loadConfig();
    expect(loaded.providers.caseCollider?.autoReviewModelOverrides).toBeUndefined();
    expect(loaded.providers.trimCollider?.autoReviewModelOverrides).toBeUndefined();
    expect(loaded.providers.unrelated?.autoReviewModel).toBe("deepseek-v4-flash");
    expect(loaded.providers.caseCollider).toBeDefined();
    expect(loaded.providers.trimCollider).toBeDefined();
  });

  test("load sanitizer strips prohibited auto-review fields from the openai provider", () => {
    const parsed = {
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          autoReviewModel: "deepseek-v4-flash",
          autoReviewModelOverrides: { "gpt-5.4": "gpt-5.4-nano" },
        },
        unrelated: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          autoReviewModel: "deepseek-v4-flash",
        },
      },
    };
    sanitizeAutoReviewOverridesForLoad(parsed);
    expect(parsed.providers.openai.autoReviewModel).toBeUndefined();
    expect(parsed.providers.openai.autoReviewModelOverrides).toBeUndefined();
    expect(parsed.providers.unrelated.autoReviewModel).toBe("deepseek-v4-flash");
  });
});

describe("management validation and normalization", () => {
  test("management rejects malformed overrides", () => {
    expect(autoReviewModelConfigError("custom", "  ", undefined)).toContain("autoReviewModel");
    expect(autoReviewModelConfigError("custom", undefined, { m: 42 })).toContain("autoReviewModelOverrides");
    expect(autoReviewModelConfigError("custom", "deepseek-v4-flash", { "deepseek-v4-flash-vision-exp": "deepseek-v4-pro" })).toBeNull();
    expect(autoReviewModelConfigError("openai", "deepseek-v4-flash", undefined))
      .toContain("provider openai must not include autoReviewModel");
  });

  test("POST normalization trims auto-review fields before persistence", () => {
    const provider = {
      autoReviewModel: "  deepseek-v4-flash  ",
      autoReviewModelOverrides: {
        " deepseek-v4-flash-vision-exp ": "  deepseek-v4-pro  ",
      },
    };
    expect(normalizeAutoReviewModelFields("custom", provider)).toBeNull();
    expect(provider.autoReviewModel).toBe("deepseek-v4-flash");
    expect(provider.autoReviewModelOverrides).toEqual({
      "deepseek-v4-flash-vision-exp": "deepseek-v4-pro",
    });
  });

  test("POST normalization rejects whitespace inside ids", () => {
    const provider = { autoReviewModel: "deep seek-v4-flash" };
    expect(normalizeAutoReviewModelFields("custom", provider)).toContain("autoReviewModel");
  });

  test("POST normalization rejects case-folded duplicate override keys", () => {
    const provider = {
      autoReviewModelOverrides: {
        "DEEPSEEK-V4-FLASH": "deepseek-v4-pro",
        "deepseek-v4-flash": "deepseek-v4-flash",
      },
    };
    expect(normalizeAutoReviewModelFields("custom", provider)).toContain("unique after trimming and case folding");
  });

  test("POST normalization rejects whitespace-colliding duplicate override keys", () => {
    const provider = {
      autoReviewModelOverrides: {
        " model-a ": "deepseek-v4-pro",
        "model-a": "deepseek-v4-flash",
      },
    };
    expect(normalizeAutoReviewModelFields("custom", provider)).toContain("unique after trimming and case folding");
  });
});

describe("routed provider merge", () => {
  test("autoReviewModelOverrides merge per key with provider winning on overlap", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "deepseek");
    expect(entry).toBeDefined();
    const saved = entry!.autoReviewModelOverrides;
    entry!.autoReviewModelOverrides = {
      "deepseek-v4-flash": "deepseek-v4-pro",
      shared: "registry-default",
    };
    try {
      const provider = providerConfigSeed(entry!);
      provider.autoReviewModelOverrides = {
        "deepseek-v4-flash-vision-exp": "deepseek-v4-flash",
        shared: "provider-override",
      };
      const routed = routedProviderConfig("deepseek", provider);
      expect(routed.autoReviewModelOverrides).toEqual({
        "deepseek-v4-flash": "deepseek-v4-pro",
        "deepseek-v4-flash-vision-exp": "deepseek-v4-flash",
        shared: "provider-override",
      });
    } finally {
      if (saved === undefined) delete entry!.autoReviewModelOverrides;
      else entry!.autoReviewModelOverrides = saved;
    }
  });

  test("registry autoReviewModel fallback applies when the provider leaves it undefined", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "deepseek");
    expect(entry).toBeDefined();
    const saved = entry!.autoReviewModel;
    entry!.autoReviewModel = "deepseek/deepseek-v4-flash";
    try {
      const provider = providerConfigSeed(entry!);
      delete provider.autoReviewModel;
      const routed = routedProviderConfig("deepseek", provider);
      expect(routed.autoReviewModel).toBe("deepseek/deepseek-v4-flash");
    } finally {
      if (saved === undefined) delete entry!.autoReviewModel;
      else entry!.autoReviewModel = saved;
    }
  });

  test("enrichment merges registry and provider override maps per key with provider winning", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "deepseek");
    expect(entry).toBeDefined();
    const saved = entry!.autoReviewModelOverrides;
    entry!.autoReviewModelOverrides = {
      registryOnly: "deepseek/deepseek-v4-pro",
      shared: "registry-default",
    };
    try {
      const provider = providerConfigSeed(entry!);
      // Simulate a hand-edited map that replaced the seeded defaults wholesale
      // before enrichment, which previously hid the disjoint registry entries.
      provider.autoReviewModelOverrides = {
        providerOnly: "deepseek/deepseek-v4-flash",
        shared: "provider-override",
      };
      enrichProviderFromRegistry("deepseek", provider);
      expect(provider.autoReviewModelOverrides).toEqual({
        registryOnly: "deepseek/deepseek-v4-pro",
        providerOnly: "deepseek/deepseek-v4-flash",
        shared: "provider-override",
      });
    } finally {
      if (saved === undefined) delete entry!.autoReviewModelOverrides;
      else entry!.autoReviewModelOverrides = saved;
    }
  });

  test("routed merge replaces a case-variant registry override with the provider value", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "deepseek");
    expect(entry).toBeDefined();
    const saved = entry!.autoReviewModelOverrides;
    entry!.autoReviewModelOverrides = {
      "DEEPSEEK-V4-FLASH": "deepseek/deepseek-v4-pro",
      "vision-exp": "deepseek/deepseek-v4-flash",
    };
    try {
      const provider = providerConfigSeed(entry!);
      provider.autoReviewModelOverrides = {
        "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
      };
      const routed = routedProviderConfig("deepseek", provider);
      expect(routed.autoReviewModelOverrides).toEqual({
        "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
        "vision-exp": "deepseek/deepseek-v4-flash",
      });
    } finally {
      if (saved === undefined) delete entry!.autoReviewModelOverrides;
      else entry!.autoReviewModelOverrides = saved;
    }
  });

  test("enrichment replaces a case-variant registry override with the provider value", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "deepseek");
    expect(entry).toBeDefined();
    const saved = entry!.autoReviewModelOverrides;
    entry!.autoReviewModelOverrides = {
      "DEEPSEEK-V4-FLASH": "deepseek/deepseek-v4-pro",
      "vision-exp": "deepseek/deepseek-v4-flash",
    };
    try {
      const provider = providerConfigSeed(entry!);
      provider.autoReviewModelOverrides = {
        "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
      };
      enrichProviderFromRegistry("deepseek", provider);
      expect(provider.autoReviewModelOverrides).toEqual({
        "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
        "vision-exp": "deepseek/deepseek-v4-flash",
      });
    } finally {
      if (saved === undefined) delete entry!.autoReviewModelOverrides;
      else entry!.autoReviewModelOverrides = saved;
    }
  });
});

describe("global auto_review_model precedence (provider stamp vs root selector)", () => {
  test("absent root selector keeps provider-stamped routed rows after apply", () => {
    const entries: Array<Record<string, unknown>> = [
      { slug: "deepseek/deepseek-v4-flash", auto_review_model_override: "deepseek/deepseek-v4-flash" },
      { slug: "deepseek/deepseek-v4-pro", auto_review_model_override: null },
    ];

    const result = applyAutoReviewModelOverride(entries, null, [], { retainRoutedOverrides: true });

    expect(result).toBe("absent");
    expect(entries[0].auto_review_model_override).toBe("deepseek/deepseek-v4-flash");
    expect(entries[1].auto_review_model_override).toBeNull();
  });

  test("present root selector fills native and unstamped routed rows but keeps provider stamps", () => {
    const entries: Array<Record<string, unknown>> = [
      { slug: "gpt-5.5", auto_review_model_override: "native-upstream" },
      { slug: "deepseek/deepseek-v4-flash", auto_review_model_override: "deepseek/deepseek-v4-flash" },
      { slug: "deepseek/deepseek-v4-pro", auto_review_model_override: null },
      { slug: "blsc/glm-5.2", auto_review_model_override: undefined },
    ];

    const result = applyAutoReviewModelOverride(
      entries,
      "  deepseek/deepseek-v4-pro  ",
      [],
      { retainRoutedOverrides: true },
    );

    expect(result).toBe("applied");
    // Provider-scoped stamp outranks the root fallback on its own routed row.
    expect(entries[1].auto_review_model_override).toBe("deepseek/deepseek-v4-flash");
    // Native and unstamped routed rows receive the root selector.
    expect(entries[0].auto_review_model_override).toBe("deepseek/deepseek-v4-pro");
    expect(entries[2].auto_review_model_override).toBe("deepseek/deepseek-v4-pro");
    expect(entries[3].auto_review_model_override).toBe("deepseek/deepseek-v4-pro");
  });

  test("legacy apply behavior is unchanged when retainRoutedOverrides is not set", () => {
    const entries: Array<Record<string, unknown>> = [
      { slug: "gpt-5.5", auto_review_model_override: "native-upstream" },
      { slug: "deepseek/deepseek-v4-flash", auto_review_model_override: "deepseek/deepseek-v4-flash" },
    ];

    applyAutoReviewModelOverride(entries, null);

    expect(entries[0].auto_review_model_override).toBe("native-upstream");
    expect(entries[1].auto_review_model_override).toBeNull();
  });

  test("removing a previously applied root selector clears stale native copies but keeps differing provider stamps", () => {
    resetCatalogRuntimeStateForTests();
    try {
      const entries: Array<Record<string, unknown>> = [
        { slug: "gpt-5.5", auto_review_model_override: "opencode-go/deepseek-v4-pro" },
        { slug: "opencode-go/deepseek-v4-pro", auto_review_model_override: null },
        { slug: "deepseek/deepseek-v4-flash", auto_review_model_override: "deepseek/deepseek-v4-flash" },
        { slug: "blsc/glm-5.2", auto_review_model_override: "blsc/glm-5.2" },
      ];

      const applied = applyAutoReviewModelOverride(
        entries,
        "opencode-go/deepseek-v4-pro",
        [],
        { retainRoutedOverrides: true },
      );
      expect(applied).toBe("applied");
      expect(entries[0].auto_review_model_override).toBe("opencode-go/deepseek-v4-pro");
      expect(entries[2].auto_review_model_override).toBe("deepseek/deepseek-v4-flash");
      expect(entries[3].auto_review_model_override).toBe("blsc/glm-5.2");

      const removed = applyAutoReviewModelOverride(
        entries,
        null,
        [],
        { retainRoutedOverrides: true },
      );
      expect(removed).toBe("absent");
      expect(entries[0].auto_review_model_override).toBeNull();
      expect(entries[2].auto_review_model_override).toBe("deepseek/deepseek-v4-flash");
      expect(entries[3].auto_review_model_override).toBe("blsc/glm-5.2");
    } finally {
      resetCatalogRuntimeStateForTests();
    }
  });

  test("durable root marker clears stale native copies after a restart-like regenerate", () => {
    resetCatalogRuntimeStateForTests();
    try {
      // Rows as they would exist on disk after a previous root stamp and a process restart:
      // only the per-row marker (not the module variable) identifies the stale native copy.
      const entries: Array<Record<string, unknown>> = [
        {
          slug: "gpt-5.5",
          auto_review_model_override: "opencode-go/deepseek-v4-pro",
          opencodex_auto_review_root: "opencode-go/deepseek-v4-pro",
        },
        { slug: "opencode-go/deepseek-v4-pro", auto_review_model_override: null },
        { slug: "deepseek/deepseek-v4-flash", auto_review_model_override: "deepseek/deepseek-v4-flash" },
        { slug: "blsc/glm-5.2", auto_review_model_override: "blsc/glm-5.2" },
      ];
      const removed = applyAutoReviewModelOverride(entries, null, [], { retainRoutedOverrides: true });
      expect(removed).toBe("absent");
      expect(entries[0].auto_review_model_override).toBeNull();
      expect(entries[0].opencodex_auto_review_root).toBeUndefined();
      expect(entries[2].auto_review_model_override).toBe("deepseek/deepseek-v4-flash");
      expect(entries[3].auto_review_model_override).toBe("blsc/glm-5.2");
    } finally {
      resetCatalogRuntimeStateForTests();
    }
  });

  test("durable root marker survives apply -> serialize -> regenerate -> remove through the finalize path", () => {
    resetCatalogRuntimeStateForTests();
    const originalCodexHome = process.env.CODEX_HOME;
    const tempHome = mkdtempSync(join(tmpdir(), "ocx-auto-review-home-"));
    try {
      const configPath = join(tempHome, "config.toml");
      writeFileSync(configPath, 'auto_review_model = "opencode-go/deepseek-v4-pro"\n');
      process.env.CODEX_HOME = tempHome;

      // Phase 1: a regenerate runs while the root selector is configured. The routed row
      // carries its provider-derived stamp; native and unstamped routed rows receive the
      // root selector with the durable per-row marker.
      const onDiskBeforeRoot: Array<Record<string, unknown>> = [
        { slug: "gpt-5.5", auto_review_model_override: null },
        { slug: "opencode-go/deepseek-v4-pro", auto_review_model_override: null },
        { slug: "deepseek/deepseek-v4-flash", auto_review_model_override: "deepseek/deepseek-v4-flash" },
      ];
      const freshWithRoot: Array<Record<string, unknown>> = [
        { slug: "gpt-5.5", auto_review_model_override: null },
        { slug: "opencode-go/deepseek-v4-pro", auto_review_model_override: null },
        { slug: "deepseek/deepseek-v4-flash", auto_review_model_override: "deepseek/deepseek-v4-flash" },
      ];
      expect(finalizeAutoReviewModelOverride(freshWithRoot, onDiskBeforeRoot)).toBe("applied");
      expect(freshWithRoot[0]!.auto_review_model_override).toBe("opencode-go/deepseek-v4-pro");
      expect(freshWithRoot[0]!.opencodex_auto_review_root).toBe("opencode-go/deepseek-v4-pro");
      expect(freshWithRoot[1]!.auto_review_model_override).toBe("opencode-go/deepseek-v4-pro");
      expect(freshWithRoot[1]!.opencodex_auto_review_root).toBe("opencode-go/deepseek-v4-pro");
      expect(freshWithRoot[2]!.auto_review_model_override).toBe("deepseek/deepseek-v4-flash");
      expect(freshWithRoot[2]!.opencodex_auto_review_root).toBeUndefined();

      // The stamped rows are what a retained sync would serialize to disk before restart.
      const onDiskAfterRoot = structuredClone(freshWithRoot) as Array<Record<string, unknown>>;

      // Phase 2: the operator removes the root selector and the process restarts, so the
      // module-level selector memory is gone; only the durable marker identifies stale
      // native copies when rows are preserved through the next regenerate.
      writeFileSync(configPath, "# no auto_review_model configured\n");
      resetCatalogRuntimeStateForTests();
      const freshAfterRemoval: Array<Record<string, unknown>> = [
        { slug: "gpt-5.5", auto_review_model_override: null },
        { slug: "opencode-go/deepseek-v4-pro", auto_review_model_override: null },
        { slug: "deepseek/deepseek-v4-flash", auto_review_model_override: "deepseek/deepseek-v4-flash" },
      ];
      expect(finalizeAutoReviewModelOverride(freshAfterRemoval, onDiskAfterRoot)).toBe("absent");
      expect(freshAfterRemoval[0]!.auto_review_model_override).toBeNull();
      expect(freshAfterRemoval[0]!.opencodex_auto_review_root).toBeUndefined();
      expect(freshAfterRemoval[1]!.auto_review_model_override).toBeNull();
      expect(freshAfterRemoval[1]!.opencodex_auto_review_root).toBeUndefined();
      expect(freshAfterRemoval[2]!.auto_review_model_override).toBe("deepseek/deepseek-v4-flash");
      expect(freshAfterRemoval[2]!.opencodex_auto_review_root).toBeUndefined();
      validateAutoReviewOverridesAgainstCatalog(freshAfterRemoval);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      rmSync(tempHome, { recursive: true, force: true });
      resetCatalogRuntimeStateForTests();
    }
  });

  test("raw-vs-encoded equivalent root selector is stamped with the matched catalog slug and survives final validation", () => {
    resetCatalogRuntimeStateForTests();
    try {
      const entries: Array<Record<string, unknown>> = [
        { slug: "gpt-5.5", auto_review_model_override: null },
        { slug: "opencode-go/deepseek-v4-pro", auto_review_model_override: null },
      ];
      const applied = applyAutoReviewModelOverride(entries, "opencode-go/deepseek/v4-pro", [], { retainRoutedOverrides: true });
      expect(applied).toBe("applied");
      expect(entries[0].auto_review_model_override).toBe("opencode-go/deepseek-v4-pro");
      validateAutoReviewOverridesAgainstCatalog(entries);
      expect(entries[0].auto_review_model_override).toBe("opencode-go/deepseek-v4-pro");
    } finally {
      resetCatalogRuntimeStateForTests();
    }
  });
});
