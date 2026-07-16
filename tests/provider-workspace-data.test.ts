import { describe, expect, test } from "bun:test";
import * as workspaceData from "../gui/src/provider-workspace-data";
import {
  buildProviderWorkspace,
  type WorkspaceProvider,
  type WorkspaceSections,
} from "../gui/src/provider-workspace-data";
import {
  binProviderStatus,
  formatRequestCount,
  formatTokenCount,
  buildAttentionItems,
  sortWorkspaceItems,
  isFreeProvider,
  type ProviderModelCounts,
  type ProviderUsageTotals,
  type AttentionItem,
  type WorkspaceItem,
} from "../gui/src/provider-workspace-data";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base defaults matching a minimal, unconfigured provider value. */
function prov(overrides: Partial<WorkspaceProvider> = {}): WorkspaceProvider {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    hasApiKey: false,
    hasHeaders: false,
    defaultModel: undefined,
    authMode: undefined,
    keyOptional: false,
    disabled: false,
    note: undefined,
    ...overrides,
  };
}

/** Thin wrapper to build a single-entry Record. */
function single(name: string, overrides: Partial<WorkspaceProvider> = {}): Record<string, WorkspaceProvider> {
  return { [name]: prov(overrides) };
}

// ---------------------------------------------------------------------------
// Section membership
// ---------------------------------------------------------------------------

describe("buildProviderWorkspace", () => {
  test("disabled provider always goes into the disabled section", () => {
    const sections = buildProviderWorkspace({
      "disabled-keyed":   prov({ authMode: "key",     hasApiKey: true,  disabled: true }),
      "disabled-oauth":   prov({ authMode: "oauth",                     disabled: true }),
      "disabled-forward": prov({ authMode: "forward",                   disabled: true }),
    });
    expect(sections.disabled.map(p => p.name)).toEqual([
      "disabled-keyed",
      "disabled-oauth",
      "disabled-forward",
    ]);
    expect(sections.ready).toHaveLength(0);
    expect(sections.needsSetup).toHaveLength(0);
  });

  test("keyOptional provider without an API key is ready (keyless free)", () => {
    const sections = buildProviderWorkspace(single("opencode-go", { keyOptional: true, hasApiKey: false }));
    expect(sections.ready.map(p => p.name)).toContain("opencode-go");
    expect(sections.needsSetup).toHaveLength(0);
  });

  test("keyOptional provider with an API key is also ready", () => {
    const sections = buildProviderWorkspace(single("opencode-pro", { keyOptional: true, hasApiKey: true }));
    expect(sections.ready.map(p => p.name)).toContain("opencode-pro");
  });

  test("freeTier without key is Free pricing but still needsSetup", () => {
    const item = { freeTier: true, hasApiKey: false, adapter: "openai-chat", baseUrl: "https://example.test" };
    expect(isFreeProvider({ ...item })).toBe(true);
    const sections = buildProviderWorkspace(single("nvidia", item));
    expect(sections.needsSetup.map(p => p.name)).toContain("nvidia");
    expect(sections.ready).toHaveLength(0);
  });

  test("freeTier with key is Free and ready", () => {
    const item = { freeTier: true, hasApiKey: true, adapter: "openai-chat", baseUrl: "https://example.test" };
    expect(isFreeProvider({ ...item })).toBe(true);
    const sections = buildProviderWorkspace(single("nvidia", item));
    expect(sections.ready.map(p => p.name)).toContain("nvidia");
  });

  test("OAuth provider with no key required is ready", () => {
    const sections = buildProviderWorkspace(single("xai", { authMode: "oauth" }));
    expect(sections.ready.map(p => p.name)).toContain("xai");
    expect(sections.needsSetup).toHaveLength(0);
  });

  test("forward/passthrough provider is ready without credentials", () => {
    const sections = buildProviderWorkspace(single("cursor-proxy", { authMode: "forward" }));
    expect(sections.ready.map(p => p.name)).toContain("cursor-proxy");
  });

  test("key-auth provider WITH a key is ready", () => {
    const sections = buildProviderWorkspace(single("openai", { authMode: "key", hasApiKey: true }));
    expect(sections.ready.map(p => p.name)).toContain("openai");
    expect(sections.needsSetup).toHaveLength(0);
  });

  test("key-auth provider WITHOUT a key goes to needsSetup", () => {
    const sections = buildProviderWorkspace(single("anthropic", { authMode: "key", hasApiKey: false }));
    expect(sections.needsSetup.map(p => p.name)).toContain("anthropic");
    expect(sections.ready).toHaveLength(0);
  });

  test("plain enabled provider (no authMode) without a key goes to needsSetup", () => {
    const sections = buildProviderWorkspace(single("custom-no-auth", { hasApiKey: false }));
    expect(sections.needsSetup.map(p => p.name)).toContain("custom-no-auth");
  });

  test("plain enabled provider (no authMode) with a key is ready", () => {
    const sections = buildProviderWorkspace(single("custom-keyed", { hasApiKey: true }));
    expect(sections.ready.map(p => p.name)).toContain("custom-keyed");
  });

  test("local auth provider is ready without credentials", () => {
    const sections = buildProviderWorkspace(single("ollama", {
      authMode: "local",
      baseUrl: "http://ollama:11434/v1",
    }));
    expect(sections.ready.map(p => p.name)).toEqual(["ollama"]);
    expect(sections.needsSetup).toHaveLength(0);
  });

  test("loopback providers remain ready when authMode is absent", () => {
    const sections = buildProviderWorkspace({
      localhost: prov({ baseUrl: "http://localhost:11434/v1" }),
      ipv4: prov({ baseUrl: "http://127.0.0.1:1234/v1" }),
      ipv6: prov({ baseUrl: "http://[::1]:8080/v1" }),
    });
    expect(sections.ready.map(p => p.name)).toEqual(["localhost", "ipv4", "ipv6"]);
    expect(sections.needsSetup).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Name injection
  // ---------------------------------------------------------------------------

  test("injects name from the Record key into each output item", () => {
    const sections = buildProviderWorkspace({
      "my-provider": prov({ authMode: "key", hasApiKey: true }),
    });
    expect(sections.ready[0]!.name).toBe("my-provider");
  });

  // ---------------------------------------------------------------------------
  // Metadata preservation
  // ---------------------------------------------------------------------------

  test("preserves adapter, baseUrl, defaultModel, authMode on output items", () => {
    const sections = buildProviderWorkspace({
      "my-provider": prov({
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o",
        authMode: "key",
        hasApiKey: true,
      }),
    });
    const item = sections.ready[0]!;
    expect(item.adapter).toBe("openai-responses");
    expect(item.baseUrl).toBe("https://api.openai.com/v1");
    expect(item.defaultModel).toBe("gpt-4o");
    expect(item.authMode).toBe("key");
  });

  test("preserves keyOptional and note on output items", () => {
    const sections = buildProviderWorkspace(
      single("free-prov", { keyOptional: true, note: "Free tier, no key needed." }),
    );
    const item = sections.ready[0]!;
    expect(item.keyOptional).toBe(true);
    expect(item.note).toBe("Free tier, no key needed.");
  });

  // ---------------------------------------------------------------------------
  // Mixed scenario
  // ---------------------------------------------------------------------------

  test("correctly bins a mixed set of providers", () => {
    const sections = buildProviderWorkspace({
      "openai":      prov({ authMode: "key",     hasApiKey: true  }),
      "anthropic":   prov({ authMode: "key",     hasApiKey: false }),
      "xai-oauth":   prov({ authMode: "oauth"                     }),
      "cursor-fwd":  prov({ authMode: "forward"                   }),
      "free-svc":    prov({ keyOptional: true                     }),
      "legacy-off":  prov({ hasApiKey: true, disabled: true       }),
    });
    expect(sections.ready.map(p => p.name).sort()).toEqual(
      ["openai", "xai-oauth", "cursor-fwd", "free-svc"].sort(),
    );
    expect(sections.needsSetup.map(p => p.name)).toEqual(["anthropic"]);
    expect(sections.disabled.map(p => p.name)).toEqual(["legacy-off"]);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test("empty input produces empty sections", () => {
    const sections = buildProviderWorkspace({});
    expect(sections.ready).toHaveLength(0);
    expect(sections.needsSetup).toHaveLength(0);
    expect(sections.disabled).toHaveLength(0);
  });

  test("returns a stable WorkspaceSections shape", () => {
    const sections: WorkspaceSections = buildProviderWorkspace({});
    expect(sections).toHaveProperty("ready");
    expect(sections).toHaveProperty("needsSetup");
    expect(sections).toHaveProperty("disabled");
  });
});

// ---------------------------------------------------------------------------
// binProviderStatus — pure status derivation (no network)
// ---------------------------------------------------------------------------

describe("sortWorkspaceItems + isFreeProvider", () => {
  function item(name: string, overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
    return { name, adapter: "openai-chat", baseUrl: "https://x", ...overrides };
  }

  test("A-Z / Z-A by name", () => {
    const items = [item("zeta"), item("alpha"), item("mid")];
    expect(sortWorkspaceItems(items, "az").map(i => i.name)).toEqual(["alpha", "mid", "zeta"]);
    expect(sortWorkspaceItems(items, "za").map(i => i.name)).toEqual(["zeta", "mid", "alpha"]);
  });

  test("free-paid groups free first", () => {
    const items = [
      item("paid-a", { hasApiKey: true }),
      item("free-b", { keyOptional: true }),
      item("paid-c", { hasApiKey: true }),
    ];
    expect(sortWorkspaceItems(items, "free-paid").map(i => i.name)).toEqual(["free-b", "paid-a", "paid-c"]);
    expect(sortWorkspaceItems(items, "paid-free").map(i => i.name)).toEqual(["paid-a", "paid-c", "free-b"]);
  });

  test("isFreeProvider detects local and keyOptional", () => {
    expect(isFreeProvider(prov({ keyOptional: true }))).toBe(true);
    expect(isFreeProvider(prov({ authMode: "local" }))).toBe(true);
    expect(isFreeProvider(prov({ baseUrl: "http://127.0.0.1:11434/v1" }))).toBe(true);
    expect(isFreeProvider(prov({ hasApiKey: true }))).toBe(false);
  });
});

describe("binProviderStatus", () => {
  test("disabled provider returns 'disabled'", () => {
    expect(binProviderStatus(prov({ disabled: true, hasApiKey: true }))).toBe("disabled");
  });

  test("keyOptional provider returns 'ready'", () => {
    expect(binProviderStatus(prov({ keyOptional: true }))).toBe("ready");
  });

  test("oauth provider returns 'ready'", () => {
    expect(binProviderStatus(prov({ authMode: "oauth" }))).toBe("ready");
  });

  test("forward provider returns 'ready'", () => {
    expect(binProviderStatus(prov({ authMode: "forward" }))).toBe("ready");
  });

  test("key-auth with key returns 'ready'", () => {
    expect(binProviderStatus(prov({ authMode: "key", hasApiKey: true }))).toBe("ready");
  });

  test("key-auth without key returns 'needs-setup'", () => {
    expect(binProviderStatus(prov({ authMode: "key", hasApiKey: false }))).toBe("needs-setup");
  });

  test("no authMode, no key returns 'needs-setup'", () => {
    expect(binProviderStatus(prov({ hasApiKey: false }))).toBe("needs-setup");
  });

  test("local auth mode returns 'ready'", () => {
    expect(binProviderStatus(prov({ authMode: "local" }))).toBe("ready");
  });

  test("loopback base URLs return 'ready' without authMode", () => {
    expect(binProviderStatus(prov({ baseUrl: "http://localhost:11434/v1" }))).toBe("ready");
    expect(binProviderStatus(prov({ baseUrl: "http://127.0.0.1:1234/v1" }))).toBe("ready");
    expect(binProviderStatus(prov({ baseUrl: "http://[::1]:8080/v1" }))).toBe("ready");
  });
});

describe("countAvailableModels", () => {
  test("counts each provider array from the selected-models available map", () => {
    expect(workspaceData.countAvailableModels({
      available: {
        openai: ["gpt-4o", "gpt-4.1"],
        ollama: [{ id: "llama3" }],
        empty: [],
      },
      selected: { openai: ["gpt-4o"] },
    })).toEqual({ openai: 2, ollama: 0, empty: 0 });
  });

  test("returns no counts for unsupported endpoint shapes", () => {
    expect(workspaceData.countAvailableModels({ models: [{ provider: "openai" }] })).toEqual({});
    expect(workspaceData.countAvailableModels(null)).toEqual({});
  });
});

describe("parseAvailableModels", () => {
  test("returns string model ids per provider", () => {
    expect(workspaceData.parseAvailableModels({
      available: {
        openai: ["gpt-4o", "gpt-4.1"],
        ollama: [{ id: "llama3" }],
        mixed: ["valid", 42, null],
      },
    })).toEqual({
      openai: ["gpt-4o", "gpt-4.1"],
      ollama: [],
      mixed: ["valid"],
    });
  });

  test("returns empty map for invalid payloads", () => {
    expect(workspaceData.parseAvailableModels(null)).toEqual({});
    expect(workspaceData.parseAvailableModels({ selected: {} })).toEqual({});
  });
});

describe("parseSelectedModels", () => {
  test("returns string model ids from selected allowlist", () => {
    expect(workspaceData.parseSelectedModels({
      selected: {
        openai: ["gpt-4o"],
        anthropic: ["claude-3", 99],
      },
    })).toEqual({
      openai: ["gpt-4o"],
      anthropic: ["claude-3"],
    });
  });
});

describe("buildMostUsedProviders", () => {
  test("sorts real 30-day usage totals by requests descending", () => {
    expect(workspaceData.buildMostUsedProviders({
      anthropic: { requests: 12, totalTokens: 900 },
      openai: { requests: 40, totalTokens: 4_000 },
      ollama: { requests: 20, totalTokens: 2_000 },
    }).map(item => item.name)).toEqual(["openai", "ollama", "anthropic"]);
  });

  test("omits providers without recorded requests", () => {
    expect(workspaceData.buildMostUsedProviders({
      unavailable: {},
      zero: { requests: 0, totalTokens: 0 },
    })).toEqual([]);
  });
});

describe("formatRelativeTime", () => {
  test("shows Not checked when no real update time exists", () => {
    expect(workspaceData.formatRelativeTime(undefined, 10_000)).toBe("Not checked");
  });

  test("formats a real update time relative to now", () => {
    expect(workspaceData.formatRelativeTime(880_000, 1_000_000)).toBe("2m ago");
  });
});

// ---------------------------------------------------------------------------
// formatRequestCount — display formatting (pure)
// ---------------------------------------------------------------------------

describe("formatRequestCount", () => {
  test("undefined returns unavailable marker", () => {
    expect(formatRequestCount(undefined)).toBe("—");
  });

  test("small numbers render as-is", () => {
    expect(formatRequestCount(0)).toBe("0");
    expect(formatRequestCount(999)).toBe("999");
  });

  test("thousands render with k suffix", () => {
    expect(formatRequestCount(1000)).toBe("1.0k");
    expect(formatRequestCount(12548)).toBe("12.5k");
  });

  test("millions render with M suffix", () => {
    expect(formatRequestCount(1_000_000)).toBe("1.0M");
  });
});

// ---------------------------------------------------------------------------
// formatTokenCount — token display formatting (pure)
// ---------------------------------------------------------------------------

describe("formatTokenCount", () => {
  test("undefined returns unavailable marker", () => {
    expect(formatTokenCount(undefined)).toBe("—");
  });

  test("sub-thousand renders as integer", () => {
    expect(formatTokenCount(500)).toBe("500");
  });

  test("284600 renders as 284.6k", () => {
    expect(formatTokenCount(284_600)).toBe("284.6k");
  });

  test("millions render with M suffix (one decimal)", () => {
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });
});

// ---------------------------------------------------------------------------
// buildAttentionItems — derive attention-required list from sections
// ---------------------------------------------------------------------------

describe("buildAttentionItems", () => {
  function makeItem(name: string, overrides: Partial<WorkspaceProvider> = {}): import("../gui/src/provider-workspace-data").WorkspaceItem {
    return { name, adapter: "openai-chat", baseUrl: "https://x", ...overrides };
  }

  test("empty sections produce no attention items", () => {
    const items: AttentionItem[] = buildAttentionItems(
      { ready: [], needsSetup: [], disabled: [] },
      {},
    );
    expect(items).toHaveLength(0);
  });

  test("needsSetup provider without a reason produces a 'Missing credentials' item", () => {
    const sections = {
      ready: [],
      needsSetup: [makeItem("aws-bedrock", { authMode: "key", hasApiKey: false })],
      disabled: [],
    };
    const items = buildAttentionItems(sections, {});
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("aws-bedrock");
    expect(items[0]!.reason).toContain("credential");
  });

  test("disabled provider with no key produces a 'Connection test failed' item when overrideReason given", () => {
    const sections = {
      ready: [],
      needsSetup: [],
      disabled: [makeItem("replicate", { disabled: true })],
    };
    const items = buildAttentionItems(sections, { replicate: "Connection test failed" });
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("replicate");
    expect(items[0]!.reason).toBe("Connection test failed");
  });

  test("ready providers do not appear in attention items", () => {
    const sections = {
      ready: [makeItem("openai", { hasApiKey: true })],
      needsSetup: [],
      disabled: [],
    };
    const items = buildAttentionItems(sections, {});
    expect(items).toHaveLength(0);
  });

  test("disabled providers without override reason are excluded from attention items", () => {
    const sections = {
      ready: [],
      needsSetup: [],
      disabled: [makeItem("replicate", { disabled: true })],
    };
    const items = buildAttentionItems(sections, {});
    expect(items).toHaveLength(0);
  });
});
