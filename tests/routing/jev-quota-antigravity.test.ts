import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { activateJevQuotaEvidence, deactivateJevQuotaEvidence } from "../helpers/jev-quota-activation";
import { jevQuotaSignalForTarget, JEV_QUOTA_SIGNAL_MAX_AGE_MS } from "../../src/combos/jev-quota";
import { keyReport, publishCollectedDecisionQuota, type ProviderQuotaReport } from "../../src/providers/quota/report-cache";
import { fetchAntigravityQuota, setAntigravityAccountQuotaTransportForTests } from "../../src/providers/quota/antigravity";
import { fetchProviderQuotaReports, clearProviderQuotaCache } from "../../src/providers/quota";
import { antigravityDecisionWindows } from "../../src/providers/quota-decision-publication";
import { invalidateDecisionKeyQuotas, publishDecisionKeyQuota } from "../../src/providers/quota-decision-snapshot";
import { getAuthStorePath, loadAuthStore, type AuthStore } from "../../src/oauth/store";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { OcxConfig } from "../../src/types";

const now = 2_000_000_000_000;
const reset = now + 3_600_000;
const quota = { updatedAt: now, customWindows: [
  { label: "Gem", percent: 36, resetAt: reset }, { label: "Gem (Weekly)", percent: 22, resetAt: reset },
  { label: "Cla", percent: 0, resetAt: reset }, { label: "Cla (Weekly)", percent: 100, resetAt: reset },
  { label: "gemini-3.8-flash · tier", modelId: "gemini-3.8-flash", percent: 99 }, { label: "Argon", modelId: "argon", percent: 95 },
] };
const summary = { groups: [
  { displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.64, resetTime: reset }, { window: "weekly", remainingFraction: 0.78, resetTime: reset }] },
  { displayName: "Claude", buckets: [{ window: "5h", remainingFraction: 1, resetTime: reset }, { window: "weekly", remainingFraction: 0, resetTime: reset }] },
] };
const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
let proxyEnv: Record<string, string | undefined>;
let home: TempHome;
let config: OcxConfig;
let store: AuthStore;
let clock: number;
let restoreClock: () => void;
let displayOnly: boolean;

/** Persist through the actual store owner so its normal loaded notification fences old probes. */
function persistStore(): void { writeFileSync(getAuthStorePath(), JSON.stringify(store)); loadAuthStore(); }

beforeEach(() => {
  home = createTempHome("ocx-jq-ag-"); clock = now;
  const dateSpy = spyOn(Date, "now").mockImplementation(() => clock); restoreClock = () => dateSpy.mockRestore();
  proxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  config = { port: 0, defaultProvider: "google-antigravity", providers: { "google-antigravity": { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" } } };
  store = { "google-antigravity": { activeAccountId: "fixture-a", accounts: [{ id: "fixture-a", loginId: "00000000-0000-4000-8000-000000000001", credential: { access: "fixture-access", refresh: "fixture-refresh", expires: reset + 86_400_000, projectId: "fixture-project" } }] } };
  persistStore(); activateJevQuotaEvidence(); invalidateDecisionKeyQuotas(); displayOnly = false;
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async url => Response.json(displayOnly ? (url.endsWith("retrieveUserQuotaSummary") ? {} : { models: { autocomplete: { quotaInfo: { remainingFraction: 0 } } } }) : summary),
  });
});
afterEach(() => {
  setAntigravityAccountQuotaTransportForTests(null); clearProviderQuotaCache(); deactivateJevQuotaEvidence(); invalidateDecisionKeyQuotas(); restoreClock();
  for (const key of proxyKeys) { if (proxyEnv[key] === undefined) delete process.env[key]; else process.env[key] = proxyEnv[key]; }
  home.remove();
});

/** Observe a real authenticated probe and the accepted collector publication, not a fixture receipt. */
async function collect(name = "google-antigravity"): Promise<ProviderQuotaReport> {
  const value = await fetchAntigravityQuota(name, config.providers[name]!);
  expect(value).not.toBeNull(); publishCollectedDecisionQuota([value!], config); return value!;
}

function signal(model: string, name = "google-antigravity") { return jevQuotaSignalForTarget(config, name, model, clock); }

test("only family buckets become decision windows; per-model and Argon rows stay display-only", () => {
  expect(antigravityDecisionWindows(quota).map(row => [row.family, row.window, row.percent])).toEqual([
    ["gem", "5h", 36], ["gem", "weekly", 22], ["cla", "5h", 0], ["cla", "weekly", 100],
  ]);
});

test("actual OAuth producer separates strict native families, even conflicting words and lookalikes", async () => {
  await collect();
  expect(signal("gemini-3.8-flash")).toMatchObject({ tier: "healthy", usedPercent: 36, window: "5h" });
  for (const model of ["claude-sonnet-5-5", "claude-gemini-preview"]) expect(signal(model)).toMatchObject({ tier: "nearly_exhausted", usedPercent: 100, window: "weekly" });
  expect(signal("gemini-claude-preview").usedPercent).toBe(36);
  for (const model of ["not-a-gemini-model", "unclassified-model", "geminilike", "gpt-oss-120b", "gemma-4", "vendor/claude-sonnet-5"]) expect(signal(model).tier).toBe("unknown");
});

test("arbitrary display reports and direct OAuth key publication never create decision evidence", () => {
  const row = config.providers["google-antigravity"]!;
  const value = keyReport("google-antigravity", "google-antigravity:retrieveUserQuotaSummary", quota, row, "")!;
  publishCollectedDecisionQuota([value], config);
  expect(signal("gemini-3.8-flash").tier).toBe("unknown");
  publishDecisionKeyQuota("google-antigravity", row, antigravityDecisionWindows(quota));
  expect(signal("claude-sonnet-5").tier).toBe("unknown");
});

/** A second OAuth store entry with its own account and quota; returns the bearer of every probe. */
function renamedTwoStores(renamedStore: boolean, explicitMode: boolean): string[] {
  const probed: string[] = [];
  config.providers.renamed = { ...config.providers["google-antigravity"]!, ...(explicitMode ? { googleMode: "cloud-code-assist" as const } : {}) };
  if (renamedStore) store.renamed = { activeAccountId: "fixture-b", accounts: [{ id: "fixture-b", loginId: "00000000-0000-4000-8000-000000000002", credential: { access: "renamed-access", refresh: "renamed-refresh", expires: reset + 86_400_000, projectId: "renamed-project" } }] };
  persistStore();
  const renamedSummary = { groups: [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.1, resetTime: reset }] }] };
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async (_url, _pinned, _body, _signal, options) => {
      const bearer = new Headers(options?.headers as HeadersInit).get("authorization") ?? "";
      probed.push(bearer);
      return Response.json(bearer.endsWith("renamed-access") ? renamedSummary : summary);
    },
  });
  return probed;
}

for (const renamedStore of [true, false]) for (const explicitMode of [true, false]) {
  test(`a renamed Google CCA row never borrows the canonical account (own store: ${renamedStore}, explicit mode: ${explicitMode})`, async () => {
    const probed = renamedTwoStores(renamedStore, explicitMode);
    const canonical = await collect();
    const canonicalProbes = probed.length;
    expect(probed.every(bearer => bearer.endsWith("fixture-access"))).toBe(true);
    // A direct probe reads only the renamed row's own store entry. Like inference, it cannot resolve a
    // token there (no OAuth definition under that name), so it sends nothing and mints no evidence.
    const direct = await fetchAntigravityQuota("renamed", config.providers.renamed!);
    expect(direct).toBeNull();
    expect(probed.length).toBe(canonicalProbes);
    publishCollectedDecisionQuota([canonical], config);
    expect(signal("gemini-3.8-flash", "renamed").tier).toBe("unknown");
    expect(signal("claude-sonnet-5", "renamed").tier).toBe("unknown");
    expect(signal("gemini-3.8-flash")).toMatchObject({ tier: "healthy", usedPercent: 36 });
    // The collector probes the canonical credential once, never again on behalf of the renamed row.
    probed.length = 0;
    const reports = await fetchProviderQuotaReports(config, true);
    expect(reports.reports.map(row => row.provider)).not.toContain("renamed");
    expect(probed).toEqual(Array.from({ length: canonicalProbes }, () => probed[0]!));
    expect(probed[0]!.endsWith("fixture-access")).toBe(true);
    expect(signal("gemini-3.8-flash", "renamed").tier).toBe("unknown");
    expect(signal("claude-sonnet-5")).toMatchObject({ tier: "nearly_exhausted", usedPercent: 100 });
  });
}

for (const patch of [
  { adapter: "openai-chat" as const }, { googleMode: "ai-studio" as const }, { googleMode: "vertex" as const },
  { baseUrl: "https://other.example.test" }, { baseUrl: "https://daily-cloudcode-pa.googleapis.com/other" }, { disabled: true },
]) test(`adapter/mode/destination/disabled replacement withdraws and cannot rebind held reports: ${JSON.stringify(patch)}`, async () => {
  const held = await collect(); const original = config.providers["google-antigravity"]!;
  config.providers["google-antigravity"] = { ...original, ...patch };
  publishCollectedDecisionQuota([held], config); expect(signal("gemini-3.8-flash").tier).toBe("unknown");
  config.providers["google-antigravity"] = original;
  publishCollectedDecisionQuota([held], config); expect(signal("gemini-3.8-flash").tier).toBe("unknown");
});

for (const mutation of ["access", "refresh", "project", "replacement", "multi", "paused", "reauth", "removed"] as const) {
  test(`OAuth store ${mutation} retires existing evidence and held producer receipts`, async () => {
    const held = await collect(); const set = store["google-antigravity"]!; const account = set.accounts[0]!;
    if (mutation === "access") account.credential.access = "rotated-access";
    if (mutation === "refresh") account.credential.refresh = "rotated-refresh";
    if (mutation === "project") account.credential.projectId = "replacement-project";
    if (mutation === "replacement") account.loginId = "00000000-0000-4000-8000-000000000002";
    if (mutation === "multi") set.accounts.push({ ...account, id: "fixture-b" });
    if (mutation === "paused") account.paused = true;
    if (mutation === "reauth") account.needsReauth = true;
    if (mutation === "removed") delete store["google-antigravity"];
    persistStore(); expect(signal("claude-sonnet-5").tier).toBe("unknown");
    publishCollectedDecisionQuota([held], config); expect(signal("gemini-3.8-flash").tier).toBe("unknown");
    displayOnly = true;
    const fresh = await fetchAntigravityQuota("google-antigravity", config.providers["google-antigravity"]!);
    publishCollectedDecisionQuota(fresh ? [fresh] : [], config); expect(signal("gemini-3.8-flash").tier).toBe("unknown");
  });
}

test("display-only refresh retains same live producer's original windows, resets and expiry only", async () => {
  await collect(); clock += 60_000; displayOnly = true; await collect();
  expect(signal("claude-sonnet-5")).toMatchObject({ tier: "nearly_exhausted", resetsInSeconds: 3540 });
  clock = now + JEV_QUOTA_SIGNAL_MAX_AGE_MS + 1;
  expect(signal("claude-sonnet-5").tier).toBe("unknown");
  await collect(); expect(signal("claude-sonnet-5").tier).toBe("unknown");
});

test("a first display-only observation stays unknown and opt-out observations never become receipts", async () => {
  displayOnly = true; await collect(); expect(signal("gemini-3.8-flash").tier).toBe("unknown");
  displayOnly = false; deactivateJevQuotaEvidence();
  const held = await collect(); activateJevQuotaEvidence(); publishCollectedDecisionQuota([held], config);
  expect(signal("claude-sonnet-5").tier).toBe("unknown");
  await collect(); expect(signal("claude-sonnet-5").tier).toBe("nearly_exhausted");
});

test("explicit invalidation withdraws evidence and prevents an old held report from publishing again", async () => {
  const held = await collect(); invalidateDecisionKeyQuotas(); publishCollectedDecisionQuota([held], config);
  expect(signal("gemini-3.8-flash").tier).toBe("unknown");
});

test("a credential rotated while the actual probe awaits cannot publish its late family observation", async () => {
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async () => {
      store["google-antigravity"]!.accounts[0]!.credential.access = "rotated-during-probe"; persistStore();
      return Response.json(summary);
    },
  });
  await collect(); expect(signal("claude-sonnet-5").tier).toBe("unknown");
});

test("a models-endpoint fallback naming a family never becomes or restamps family evidence", async () => {
  // The summary endpoint fails and fetchAvailableModels labels one exhausted model's counter "Gem".
  const fallback = { models: { "gemini-3.8-flash": { quotaInfo: { remainingFraction: 0, resetTime: reset + 60_000 } } } };
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async url => Response.json(displayOnly ? (url.endsWith("retrieveUserQuotaSummary") ? {} : fallback) : summary),
  });
  displayOnly = true;
  const first = await collect();
  expect(first.quota.customWindows?.some(row => row.label === "Gem" && row.percent === 100)).toBe(true);
  expect(signal("gemini-3.8-flash").tier).toBe("unknown");
  displayOnly = false; await collect(); clock += 60_000; displayOnly = true; await collect();
  expect(signal("gemini-3.8-flash")).toMatchObject({ tier: "healthy", usedPercent: 36, window: "5h", resetsInSeconds: 3540 });
});

test("a root change withdraws evidence and old receipts cannot be rebound to the new root", async () => {
  const held = await collect(); const other = createTempHome("ocx-jq-ag-root-");
  try {
    activateJevQuotaEvidence(); publishCollectedDecisionQuota([held], config);
    expect(signal("claude-sonnet-5").tier).toBe("unknown");
  } finally { other.remove(); activateJevQuotaEvidence(); }
  publishCollectedDecisionQuota([held], config); expect(signal("gemini-3.8-flash").tier).toBe("unknown");
});

test("mutating a held display report cannot rewrite the producer's immutable family observation", async () => {
  const held = await collect();
  held.quota.customWindows![0]!.percent = 100;
  held.quota.updatedAt = now + 60_000;
  publishCollectedDecisionQuota([held], config);
  expect(signal("gemini-3.8-flash")).toMatchObject({ tier: "healthy", usedPercent: 36 });
});

for (const argonObserved of [false, true]) test(`independent Argon pool stays unknown when Gem is exhausted (Argon observed: ${argonObserved})`, async () => {
  const groups = [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0, resetTime: reset }] }];
  if (argonObserved) groups.push({ displayName: "Gemini 4 Argon", buckets: [{ window: "5h", remainingFraction: 1, resetTime: reset }] });
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async () => Response.json({ groups }),
  });
  await collect();
  expect(signal("gemini-3.8-flash")).toMatchObject({ tier: "nearly_exhausted", usedPercent: 100 });
  for (const model of ["gemini-4-argon", "gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"]) expect(signal(model).tier).toBe("unknown");
});
