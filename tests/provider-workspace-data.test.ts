import { describe, expect, test } from "bun:test";
import {
  binProviderStatus,
  buildProviderWorkspace,
  hideRedundantChatGptForwardProviders,
  isAccountProvider,
  isFreeProvider,
  isPaidProvider,
  pickCanonicalForwardProvider,
  providerTier,
  sortWorkspaceItems,
  type WorkspaceItem,
  type WorkspaceProvider,
} from "../gui/src/provider-workspace/catalog";
import {
  buildAttentionItems,
  buildMostUsedProviders,
  countAvailableModels,
  formatRelativeTime,
  formatRequestCount,
  formatTokenCount,
  parseAvailableModels,
  parseSelectedModels,
  relativeTimeLabelsFromT,
} from "../gui/src/provider-workspace/usage";
import {
  formatProviderDisplayName,
  isCatalogProviderId,
  providerBrandColor,
} from "../gui/src/provider-icons";
import {
  bucketPresets,
  filterPresets,
  presetTier,
  sortPresets,
  type CatalogPreset,
} from "../gui/src/components/provider-catalog/provider-presets";
import { isLocalProvider, providerKind } from "../gui/src/provider-workspace/kind";

/** Base defaults matching a minimal, unconfigured provider value. */
function prov(overrides: Partial<WorkspaceProvider> = {}): WorkspaceProvider {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    hasApiKey: false,
    ...overrides,
  };
}

/** The canonical single-provider Codex passthrough shape. */
function forwardProv(overrides: Partial<WorkspaceProvider> = {}): WorkspaceProvider {
  return prov({
    adapter: "openai-responses",
    authMode: "forward",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    ...overrides,
  });
}

describe("catalog: section membership", () => {
  test("disabled providers always land in disabled", () => {
    const sections = buildProviderWorkspace({
      a: prov({ authMode: "key", hasApiKey: true, disabled: true }),
      b: prov({ authMode: "oauth", disabled: true }),
    });
    expect(sections.disabled.map(p => p.name)).toEqual(["a", "b"]);
    expect(sections.ready).toEqual([]);
  });

  test("readiness rules: keyOptional/oauth/forward/local/loopback/hasApiKey are ready; bare key is needsSetup", () => {
    const sections = buildProviderWorkspace({
      keyless: prov({ keyOptional: true }),
      oauth: prov({ authMode: "oauth" }),
      forward: forwardProv(),
      // Defensive-only: dev wire never emits authMode "local"; pair with loopback.
      local: prov({ authMode: "local", baseUrl: "http://localhost:11434/v1" }),
      loopback: prov({ baseUrl: "http://127.0.0.1:8000/v1" }),
      keyed: prov({ authMode: "key", hasApiKey: true }),
      missing: prov({ authMode: "key", hasApiKey: false }),
    });
    expect(sections.ready.map(p => p.name)).toEqual(["keyless", "oauth", "forward", "local", "loopback", "keyed"]);
    expect(sections.needsSetup.map(p => p.name)).toEqual(["missing"]);
  });

  test("binProviderStatus matches buildProviderWorkspace binning", () => {
    expect(binProviderStatus(prov({ disabled: true }))).toBe("disabled");
    expect(binProviderStatus(prov({ authMode: "oauth" }))).toBe("ready");
    expect(binProviderStatus(prov({ authMode: "key" }))).toBe("needs-setup");
  });

  test("loopback readiness is unconfounded: localhost/IPv4/IPv6 hosts alone make ready; malformed URLs never throw", () => {
    expect(binProviderStatus(prov({ baseUrl: "http://localhost:11434/v1" }))).toBe("ready");
    expect(binProviderStatus(prov({ baseUrl: "http://127.0.0.1:8000/v1" }))).toBe("ready");
    expect(binProviderStatus(prov({ baseUrl: "http://[::1]:1234/v1" }))).toBe("ready");
    // Non-loopback hosts and malformed URLs stay needs-setup without throwing.
    expect(binProviderStatus(prov({ baseUrl: "http://192.168.1.10:8000/v1" }))).toBe("needs-setup");
    expect(binProviderStatus(prov({ baseUrl: "not a url at all" }))).toBe("needs-setup");
    expect(binProviderStatus(prov({ baseUrl: "" }))).toBe("needs-setup");
  });

  test("NVIDIA duality: freeTier alone is needs-setup (key still required); with a key it is ready and free", () => {
    const keyless = prov({ authMode: "key", freeTier: true });
    expect(binProviderStatus(keyless)).toBe("needs-setup");
    const keyed = prov({ authMode: "key", freeTier: true, hasApiKey: true });
    expect(binProviderStatus(keyed)).toBe("ready");
    expect(providerTier("nvidia", keyed)).toBe("free");
  });
});

describe("catalog: three-way tiers", () => {
  test("forward passthrough is NOT free — it is an account provider", () => {
    expect(isFreeProvider(forwardProv())).toBe(false);
    expect(isAccountProvider("openai", forwardProv())).toBe(true);
    expect(isAccountProvider("openai-multi", forwardProv())).toBe(false);
    expect(isAccountProvider("chatgpt", forwardProv())).toBe(false);
    expect(providerTier("openai", forwardProv())).toBe("accounts");
  });

  test("non-canonical names or shapes are not account providers", () => {
    expect(isAccountProvider("someproxy", forwardProv())).toBe(false);
    expect(isAccountProvider("openai", forwardProv({ baseUrl: "https://evil.example.com/backend-api/codex" }))).toBe(false);
    expect(isAccountProvider("openai", forwardProv({ adapter: "openai-chat" }))).toBe(false);
    expect(isAccountProvider("openai", forwardProv({ authMode: "key" }))).toBe(false);
    // Literal id matching: case variants are user-defined providers, not built-ins.
    expect(isAccountProvider("OpenAI", forwardProv())).toBe(false);
    expect(isAccountProvider("OPENAI-MULTI", forwardProv())).toBe(false);
    // Strict shape casing: uppercase adapter/authMode must NOT match (dev mirrors === compare).
    expect(isAccountProvider("openai", forwardProv({ adapter: "OPENAI-RESPONSES" }))).toBe(false);
    expect(isAccountProvider("openai", forwardProv({ authMode: "FORWARD" }))).toBe(false);
  });

  test("canonical base URL matching is strict: trailing slashes ok, userinfo/query/hash rejected", () => {
    expect(isAccountProvider("openai", forwardProv({ baseUrl: "https://chatgpt.com/backend-api/codex/" }))).toBe(true);
    expect(isAccountProvider("openai", forwardProv({ baseUrl: "https://chatgpt.com/backend-api/codex?x=1" }))).toBe(false);
    expect(isAccountProvider("openai", forwardProv({ baseUrl: "https://user:pw@chatgpt.com/backend-api/codex" }))).toBe(false);
    expect(isAccountProvider("openai", forwardProv({ baseUrl: "https://chatgpt.com/backend-api/codex#frag" }))).toBe(false);
    expect(isAccountProvider("openai", forwardProv({ baseUrl: "not a url" }))).toBe(false);
  });

  test("free classification: freeTier, keyOptional, loopback; accounts wins over free", () => {
    expect(isFreeProvider(prov({ freeTier: true }))).toBe(true);
    expect(isFreeProvider(prov({ keyOptional: true }))).toBe(true);
    expect(isFreeProvider(prov({ baseUrl: "http://[::1]:8080/v1" }))).toBe(true);
    expect(isFreeProvider(prov())).toBe(false);
    expect(providerTier("nvidia", prov({ freeTier: true }))).toBe("free");
    expect(providerTier("venice", prov({ authMode: "key", hasApiKey: true }))).toBe("paid");
    expect(isPaidProvider("venice", prov({ authMode: "key", hasApiKey: true }))).toBe(true);
    expect(isPaidProvider("nvidia", prov({ freeTier: true }))).toBe(false);
    // Accounts precedence pinned: a canonical provider that ALSO carries freeTier is accounts.
    expect(providerTier("openai", forwardProv({ freeTier: true }))).toBe("accounts");
  });

  test("ready items carry their tier; needsSetup/disabled do not", () => {
    const sections = buildProviderWorkspace({
      openai: forwardProv(),
      nvidia: prov({ freeTier: true, authMode: "key", hasApiKey: true }),
      venice: prov({ authMode: "key", hasApiKey: true }),
      missing: prov({ authMode: "key" }),
      off: prov({ disabled: true }),
    });
    const tiers = Object.fromEntries(sections.ready.map(item => [item.name, item.tier]));
    expect(tiers).toEqual({ openai: "accounts", nvidia: "free", venice: "paid" });
    expect(sections.needsSetup[0]?.tier).toBeUndefined();
    expect(sections.disabled[0]?.tier).toBeUndefined();
  });
});

describe("catalog: sorting", () => {
  const items: WorkspaceItem[] = [
    { ...prov({ authMode: "key", hasApiKey: true }), name: "zeta", tier: "paid" },
    { ...prov({ freeTier: true }), name: "alpha", tier: "free" },
    { ...forwardProv(), name: "openai", tier: "accounts" },
  ];

  test("az / za are name sorts", () => {
    expect(sortWorkspaceItems(items, "az").map(i => i.name)).toEqual(["alpha", "openai", "zeta"]);
    expect(sortWorkspaceItems(items, "za").map(i => i.name)).toEqual(["zeta", "openai", "alpha"]);
  });

  test("free-paid puts free first; paid-free inverts; accounts sort with paid in free-paid mode", () => {
    expect(sortWorkspaceItems(items, "free-paid")[0]?.name).toBe("alpha");
    expect(sortWorkspaceItems(items, "paid-free").map(i => i.name).at(-1)).toBe("alpha");
  });

  test("accounts-first ranks accounts, then free, then paid", () => {
    expect(sortWorkspaceItems(items, "accounts-first").map(i => i.name)).toEqual(["openai", "alpha", "zeta"]);
  });

  test("does not mutate the input array", () => {
    const before = items.map(i => i.name);
    sortWorkspaceItems(items, "az");
    expect(items.map(i => i.name)).toEqual(before);
  });

  test("case-equal names sort stably and paid-free breaks ties alphabetically", () => {
    const caseItems: WorkspaceItem[] = [
      { ...prov(), name: "Alpha", tier: "paid" },
      { ...prov(), name: "alpha", tier: "paid" },
      { ...prov({ freeTier: true }), name: "beta", tier: "free" },
      { ...prov(), name: "aardvark", tier: "paid" },
    ];
    // sensitivity "base" treats Alpha/alpha as equal — original order preserved (stable sort).
    expect(sortWorkspaceItems(caseItems, "az").map(i => i.name)).toEqual(["aardvark", "Alpha", "alpha", "beta"]);
    expect(sortWorkspaceItems(caseItems, "za").map(i => i.name)).toEqual(["beta", "Alpha", "alpha", "aardvark"]);
    // paid-free: paid block first, alphabetical within the block, free last.
    expect(sortWorkspaceItems(caseItems, "paid-free").map(i => i.name)).toEqual(["aardvark", "Alpha", "alpha", "beta"]);
  });
});

describe("catalog: chatgpt hiding + canonical picker", () => {
  test("hides legacy chatgpt only when canonical openai covers the same passthrough", () => {
    const both = { openai: forwardProv(), chatgpt: forwardProv() };
    expect(Object.keys(hideRedundantChatGptForwardProviders(both))).toEqual(["openai"]);

    const chatgptOnly = { chatgpt: forwardProv() };
    expect(Object.keys(hideRedundantChatGptForwardProviders(chatgptOnly))).toEqual(["chatgpt"]);

    const nonCanonical = { openai: prov({ authMode: "key" }), chatgpt: forwardProv() };
    expect(Object.keys(hideRedundantChatGptForwardProviders(nonCanonical)).sort()).toEqual(["chatgpt", "openai"]);
  });

  test("hiding keeps a repointed chatgpt and never mutates the input map", () => {
    // chatgpt repointed to a different base URL is NOT redundant — both rows stay.
    const repointed = { openai: forwardProv(), chatgpt: forwardProv({ baseUrl: "https://proxy.example.com/backend-api/codex" }) };
    expect(Object.keys(hideRedundantChatGptForwardProviders(repointed)).sort()).toEqual(["chatgpt", "openai"]);

    // The input map is never mutated even when hiding applies.
    const both = { openai: forwardProv(), chatgpt: forwardProv() };
    const out = hideRedundantChatGptForwardProviders(both);
    expect(Object.keys(both).sort()).toEqual(["chatgpt", "openai"]);
    expect(out).not.toBe(both);
  });

  test("pickCanonicalForwardProvider prefers canonical openai", () => {
    expect(pickCanonicalForwardProvider({ "openai-multi": forwardProv(), openai: forwardProv() })).toBe("openai");
    expect(pickCanonicalForwardProvider({ openai: forwardProv() })).toBe("openai");
    expect(pickCanonicalForwardProvider({ chatgpt: forwardProv() })).toBeNull();
    expect(pickCanonicalForwardProvider({ venice: prov({ authMode: "key", hasApiKey: true }) })).toBeNull();
    // Legacy Multi never wins, regardless of shape.
    expect(pickCanonicalForwardProvider({ "openai-multi": prov({ authMode: "key" }), openai: forwardProv() })).toBe("openai");
    expect(pickCanonicalForwardProvider({ "my-forward": forwardProv() })).toBeNull();
    expect(pickCanonicalForwardProvider({ "my-forward": forwardProv(), openai: forwardProv() })).toBe("openai");
  });
});

describe("usage: model parsing", () => {
  test("parseAvailableModels/parseSelectedModels filter non-strings and malformed shapes", () => {
    const data = { available: { a: ["m1", "m2", 3], b: "nope" }, selected: { a: ["m1"] } };
    expect(parseAvailableModels(data)).toEqual({ a: ["m1", "m2"] });
    expect(parseSelectedModels(data)).toEqual({ a: ["m1"] });
    expect(parseAvailableModels(null)).toEqual({});
    expect(parseSelectedModels([])).toEqual({});
    expect(countAvailableModels(data)).toEqual({ a: 2 });
  });
});

describe("usage: most-used and attention", () => {
  test("buildMostUsedProviders sorts by requests desc, name asc, and drops zero rows", () => {
    const out = buildMostUsedProviders({
      b: { requests: 5, totalTokens: 100 },
      a: { requests: 5 },
      z: { requests: 9 },
      idle: { requests: 0 },
      unknown: {},
    });
    expect(out.map(p => p.name)).toEqual(["z", "a", "b"]);
  });

  test("buildMostUsedProviders drops negative and non-number request values", () => {
    const out = buildMostUsedProviders({
      good: { requests: 3 },
      negative: { requests: -5 },
      weird: { requests: "many" as unknown as number },
    });
    expect(out.map(p => p.name)).toEqual(["good"]);
  });

  test("buildAttentionItems: needsSetup always listed, disabled only with an override reason", () => {
    const sections = buildProviderWorkspace({
      missing: prov({ authMode: "key" }),
      off: prov({ disabled: true }),
      silent: prov({ disabled: true }),
    });
    const items = buildAttentionItems(sections, { off: "Quota exhausted" });
    expect(items).toEqual([
      { name: "missing", reason: "Missing credentials" },
      { name: "off", reason: "Quota exhausted" },
    ]);
  });

  test("buildAttentionItems: override wins for needsSetup, ready never listed, needsSetup precedes disabled", () => {
    const sections = buildProviderWorkspace({
      healthy: prov({ authMode: "oauth" }),
      missing: prov({ authMode: "key" }),
      off: prov({ disabled: true }),
      silent: prov({ disabled: true }),
    });
    const items = buildAttentionItems(sections, { missing: "Key was revoked", off: "Quota exhausted", healthy: "should never appear" });
    expect(items).toEqual([
      { name: "missing", reason: "Key was revoked" },
      { name: "off", reason: "Quota exhausted" },
    ]);
    expect(items.some(i => i.name === "healthy")).toBe(false);
    expect(items.some(i => i.name === "silent")).toBe(false);
  });
});

describe("usage: relative time", () => {
  const now = Date.parse("2026-07-17T12:00:00Z");

  test("thresholds: just now, minutes, hours, days, not checked", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("Just now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 49 * 3_600_000, now)).toBe("2d ago");
    expect(formatRelativeTime(undefined, now)).toBe("Not checked");
    expect(formatRelativeTime(Number.NaN, now)).toBe("Not checked");
    // Exact boundaries: 59m59s is minutes; 60m is hours; 23h59m is hours; 24h is days.
    expect(formatRelativeTime(now - (60 * 60_000 - 1_000), now)).toBe("59m ago");
    expect(formatRelativeTime(now - 60 * 60_000, now)).toBe("1h ago");
    expect(formatRelativeTime(now - (24 * 3_600_000 - 1_000), now)).toBe("23h ago");
    expect(formatRelativeTime(now - 24 * 3_600_000, now)).toBe("1d ago");
    // Future timestamps clamp to "Just now".
    expect(formatRelativeTime(now + 60_000, now)).toBe("Just now");
    // Exact millisecond edges at each unit boundary.
    expect(formatRelativeTime(now - 59_999, now)).toBe("Just now");
    expect(formatRelativeTime(now - 60_000, now)).toBe("1m ago");
    expect(formatRelativeTime(now - 3_599_999, now)).toBe("59m ago");
    expect(formatRelativeTime(now - 3_600_000, now)).toBe("1h ago");
    expect(formatRelativeTime(now - 86_399_999, now)).toBe("23h ago");
    expect(formatRelativeTime(now - 86_400_000, now)).toBe("1d ago");
  });

  test("all three overload shapes: now-only, labels+now, bare", () => {
    const labels = relativeTimeLabelsFromT((key, vars) => `${key}:${vars?.n ?? ""}`);
    expect(formatRelativeTime(now - 2 * 60_000, now)).toBe("2m ago");
    expect(formatRelativeTime(now - 2 * 60_000, labels, now)).toBe("time.minutesAgo:2");
    expect(formatRelativeTime(Date.now())).toBe("Just now");
  });

  test("relativeTimeLabelsFromT wires the translator keys", () => {
    const labels = relativeTimeLabelsFromT((key, vars) => `${key}:${vars?.n ?? ""}`);
    expect(labels.justNow).toBe("time.justNow:");
    expect(labels.minutesAgo(4)).toBe("time.minutesAgo:4");
    expect(formatRelativeTime(now - 5 * 60_000, labels, now)).toBe("time.minutesAgo:5");
  });
});

describe("usage: count formatting", () => {
  test("en formatting tiers", () => {
    expect(formatRequestCount(undefined)).toBe("\u2014");
    expect(formatRequestCount(999)).toBe("999");
    expect(formatRequestCount(1_500)).toBe("1.5k");
    expect(formatRequestCount(2_500_000)).toBe("2.5M");
    expect(formatRequestCount(3_000_000_000)).toBe("3B");
    expect(formatTokenCount(1_500)).toBe("1.5k");
  });

  test("characterization: threshold edges and trailing-zero behavior", () => {
    // k/M tiers keep one decimal even when .0 (en); B tier trims trailing zeros.
    expect(formatRequestCount(1_000)).toBe("1.0k");
    expect(formatRequestCount(999_999)).toBe("1000.0k");
    expect(formatRequestCount(1_000_000)).toBe("1.0M");
    expect(formatRequestCount(1_200_000_000)).toBe("1.2B");
    expect(formatRequestCount(1_000_000_000)).toBe("1B");
  });

  test("de characterization: comma decimals, unit labels, locale prefix normalization", () => {
    // de trims a trailing ,0 (trimDe) — unlike en, which keeps 1.0k.
    expect(formatRequestCount(1_000, "de")).toBe("1 Tsd.");
    // Mrd. uses toFixed(2) and trimDe only strips a FULL ,00 — 1,20 stays.
    expect(formatRequestCount(1_200_000_000, "de")).toBe("1,20 Mrd.");
    expect(formatRequestCount(1_500, "DE")).toBe("1,5 Tsd.");
    expect(formatRequestCount(1_500, "de-AT")).toBe("1,5 Tsd.");
    // Non-de locales fall back to en rules.
    expect(formatRequestCount(1_500, "fr")).toBe("1.5k");
  });

  test("de formatting uses comma decimals and German unit labels", () => {
    expect(formatRequestCount(1_500, "de")).toBe("1,5 Tsd.");
    expect(formatRequestCount(2_500_000, "de-DE")).toBe("2,5 Mio.");
    expect(formatRequestCount(3_000_000_000, "de")).toBe("3 Mrd.");
  });

  test("characterization: de keeps the untrimmed 1,20 Mrd. while en trims to 1.2B", () => {
    // Deliberate asymmetry: de trimDe only strips ".0+" endings so "1.20" keeps its
    // trailing zero after comma-swap; en's /\.?0+$/ trims it. Pin so neither side is
    // silently "fixed" during a port.
    expect(formatRequestCount(1_200_000_000)).toBe("1.2B");
    expect(formatRequestCount(1_200_000_000, "de")).toBe("1,20 Mrd.");
    expect(formatRequestCount(1_230_000_000)).toBe("1.23B");
    expect(formatRequestCount(1_230_000_000, "de")).toBe("1,23 Mrd.");
  });
});

describe("provider-icons", () => {
  test("single OpenAI provider display names match the registry", () => {
    expect(formatProviderDisplayName("openai")).toBe("OpenAI (Codex login)");
    expect(formatProviderDisplayName("openai-apikey")).toBe("OpenAI API");
    expect(formatProviderDisplayName("chatgpt")).toBe("ChatGPT");
  });

  test("unknown simple ids are title-cased; mixedCase custom names pass through", () => {
    expect(formatProviderDisplayName("my-proxy")).toBe("My Proxy");
    expect(formatProviderDisplayName("MyProxy")).toBe("MyProxy");
  });

  test("brand colors and catalog membership", () => {
    expect(providerBrandColor("nvidia")).toBe("#76B900");
    expect(providerBrandColor("openai-multi")).toBeUndefined();
    expect(providerBrandColor("unknown")).toBeUndefined();
    expect(isCatalogProviderId("openai-multi")).toBe(false);
    expect(isCatalogProviderId("my-proxy")).toBe(false);
  });
});

describe("add-provider catalog presets (WP050a)", () => {
  const preset = (overrides: Partial<CatalogPreset> & { id: string }): CatalogPreset => ({
    label: overrides.id,
    adapter: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    auth: "key",
    ...overrides,
  });

  test("NVIDIA classifies Free while its auth remains key-required", () => {
    const nvidia = preset({ id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", freeTier: true });
    expect(presetTier(nvidia)).toBe("free");
    // The WP010 distinction: free pricing does NOT imply keyless.
    expect(nvidia.auth).toBe("key");
    expect(nvidia.keyOptional).toBeUndefined();
  });

  test("the canonical openai forward preset classifies Accounts; custom rows default Paid; local classifies Free", () => {
    const openai = preset({
      id: "openai",
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      auth: "forward",
      codexAccountMode: "pool",
    });
    expect(presetTier(openai)).toBe("accounts");

    expect(presetTier(preset({ id: "my-custom" }))).toBe("paid");
    expect(presetTier(preset({ id: "ollama", auth: "local", baseUrl: "http://localhost:11434/v1" }))).toBe("free");
    expect(presetTier(preset({ id: "litellm", keyOptional: true }))).toBe("free");
    expect(presetTier(preset({ id: "xai", auth: "oauth" }))).toBe("paid");
  });

  test("bucketPresets partitions all three tiers preserving input order", () => {
    const rows = [
      preset({ id: "venice" }),
      preset({ id: "openai", adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", auth: "forward" }),
      preset({ id: "nvidia", freeTier: true }),
      preset({ id: "groq" }),
    ];
    const buckets = bucketPresets(rows);
    expect(buckets.accounts.map(p => p.id)).toEqual(["openai"]);
    expect(buckets.free.map(p => p.id)).toEqual(["nvidia"]);
    expect(buckets.paid.map(p => p.id)).toEqual(["venice", "groq"]);
  });

  test("search matches label and id only, never adapter or baseUrl", () => {
    const rows = [
      preset({ id: "nvidia", label: "NVIDIA NIM" }),
      preset({ id: "groq", label: "Groq", adapter: "nvidia-like-adapter", baseUrl: "https://nvidia.example.com" }),
    ];
    expect(filterPresets(rows, "nvidia").map(p => p.id)).toEqual(["nvidia"]);
    expect(filterPresets(rows, "NIM").map(p => p.id)).toEqual(["nvidia"]);
    expect(filterPresets(rows, "").map(p => p.id)).toEqual(["nvidia", "groq"]);
  });

  test("sortPresets is deterministic: label case-insensitive, id tiebreak, input not mutated", () => {
    const rows = [
      preset({ id: "b-provider", label: "zeta" }),
      preset({ id: "a-provider", label: "Zeta" }),
      preset({ id: "c-provider", label: "alpha" }),
    ];
    const sorted = sortPresets(rows);
    expect(sorted.map(p => p.id)).toEqual(["c-provider", "a-provider", "b-provider"]);
    expect(rows.map(p => p.id)).toEqual(["b-provider", "a-provider", "c-provider"]);
  });
});

describe("provider kind classification (WP080a)", () => {
  test("login kind covers oauth AND forward — deliberately wider than the accounts tier", () => {
    expect(providerKind({ ...prov({ authMode: "oauth" }), name: "xai" })).toBe("login");
    expect(providerKind({ ...forwardProv(), name: "openai" })).toBe("login");
    // A non-canonical forward provider is login-kind yet paid-tier: two taxonomies.
    const customForward = { ...forwardProv(), baseUrl: "https://example.com/v1" };
    expect(providerKind({ ...customForward, name: "myproxy" })).toBe("login");
    expect(providerTier("myproxy", customForward)).toBe("paid");
  });

  test("local: explicit authMode local or loopback base URL", () => {
    expect(isLocalProvider(prov({ authMode: "local" }))).toBe(true);
    expect(isLocalProvider(prov({ baseUrl: "http://localhost:11434/v1" }))).toBe(true);
    expect(isLocalProvider(prov({ baseUrl: "http://[::1]:8000/v1" }))).toBe(true);
    expect(isLocalProvider(prov())).toBe(false);
    expect(providerKind({ ...prov({ baseUrl: "http://127.0.0.1:1234/v1" }), name: "lm" })).toBe("local");
  });

  test("self-hosted hints match name/adapter/baseUrl; everything else is cloud", () => {
    expect(providerKind({ ...prov(), name: "litellm" })).toBe("selfHosted");
    expect(providerKind({ ...prov({ baseUrl: "https://vllm.mycorp.dev/v1" }), name: "corp" })).toBe("selfHosted");
    expect(providerKind({ ...prov(), name: "venice" })).toBe("cloud");
    // Local wins over self-hosted hints (an ollama on loopback is local, not selfHosted).
    expect(providerKind({ ...prov({ baseUrl: "http://localhost:11434/v1" }), name: "ollama" })).toBe("local");
  });
});
